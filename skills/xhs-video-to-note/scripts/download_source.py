#!/usr/bin/env python3
"""Acquire one authorized source. Local files use ffprobe; no ChatCut dependency."""
import argparse
from hashlib import sha256
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DETAIL = "https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_video_note_detail"
LONG_HOSTS = {"xiaohongshu.com", "www.xiaohongshu.com"}
SHORT_HOSTS = {"xhslink.com", "www.xhslink.com", "xhslink.cn", "www.xhslink.cn"}
NOTE_PATH = re.compile(r"/(?:explore|discovery/item|user/profile/[0-9a-f]{24})/([0-9a-f]{24})/?", re.I)
VIDEO_SUFFIX = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}
MAX_BYTES = 2 * 1024**3
MAX_JSON = 8 * 1024**2
LOCAL_FALLBACK = "可通过 --video 指定有权使用的本地原片继续。"


class SourceError(Exception):
    def __init__(self, status, reason):
        self.status = status
        super().__init__(reason)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validated_url(value, media=False):
    if not isinstance(value, str) or len(value) > 8192 or re.search(r"[\x00-\x20\x7f\\]", value):
        raise SourceError("invalid_url", "链接格式无效。")
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if url.username is not None or url.password is not None or url.port is not None:
            raise ValueError
    except ValueError:
        raise SourceError("invalid_url", "链接主机或端口无效。") from None
    if url.scheme not in {"https", "http"}:
        raise SourceError("invalid_url", "请提供小红书分享链接。")
    if media:
        if not re.fullmatch(r"sns-v\d{1,3}\.(?:rednotecdn\.com|xhscdn\.com)", host) or not url.path.lower().endswith(".mp4"):
            raise SourceError("needs_local_video", "未取得可验证的小红书视频 CDN 文件。" + LOCAL_FALLBACK)
    elif host not in LONG_HOSTS | SHORT_HOSTS:
        raise SourceError("invalid_url", "只接受小红书笔记长链或官方短链。")
    return urlunsplit(("https", host, url.path, url.query, ""))


def share_link(text):
    links = re.findall(r"https?://[^\s<>「」【】（）()，。；！？、\"']+", text, re.I)
    if len(links) != 1:
        raise SourceError("invalid_url", "请一次粘贴一条视频笔记链接或含一条链接的分享文字。")
    return validated_url(links[0])


def note_id_at(url):
    parsed = urlsplit(url)
    if parsed.hostname in LONG_HOSTS:
        match = NOTE_PATH.fullmatch(parsed.path)
        if match:
            return match[1].lower()
    return None


def resolve_note(link, opener):
    current = link
    for _ in range(6):
        note = note_id_at(current)
        if note:
            return note
        parsed = urlsplit(current)
        if parsed.hostname not in SHORT_HOSTS or not parsed.path.strip("/"):
            break
        # Only follow redirects from official short-link hosts. Never fetch the
        # note HTML and never forward credentials or signed queries to the API.
        try:
            with opener.open(Request(current, headers={"Accept": "text/html"}), timeout=15):
                break
        except HTTPError as exc:
            with exc:
                location = exc.headers.get("Location")
                if exc.code not in {301, 302, 303, 307, 308} or not location:
                    break
                current = validated_url(urljoin(current, location))
    raise SourceError("needs_full_link", "无法从这条分享链接确认目标笔记，请提供浏览器中展开的笔记长链。" + LOCAL_FALLBACK)


def video_probe(path):
    ffprobe = shutil.which(os.environ.get("FFPROBE") or "ffprobe")
    if not ffprobe:
        raise SourceError("needs_ffmpeg", "请安装带 ffprobe 的 FFmpeg，加入 PATH 或设置 FFPROBE 可执行文件路径。")
    if path is None:
        return
    proc = subprocess.run([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
                           "-format_whitelist", "mov,matroska,webm,avi", "-select_streams", "v:0",
                           "-count_packets", "-show_entries", "stream=codec_name,width,height,nb_read_packets:format=duration",
                           "-of", "json", str(path)], capture_output=True, timeout=180)
    try:
        info = json.loads(proc.stdout)
        stream = info["streams"][0]
        duration = float(info["format"]["duration"])
        width, height = int(stream["width"]), int(stream["height"])
        if proc.returncode or proc.stderr.strip() or not stream.get("codec_name") or int(stream["nb_read_packets"]) < 1:
            raise ValueError
        if not math.isfinite(duration) or duration <= 0 or min(width, height) <= 0:
            raise ValueError
    except (TypeError, ValueError, KeyError, IndexError):
        raise SourceError("invalid_video", "原片没有可核实的视频轨、时长和尺寸。" + LOCAL_FALLBACK) from None
    return {"duration": duration, "width": width, "height": height}


def file_hash(path):
    h = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            h.update(chunk)
    return h.hexdigest()


def checked_rows(node, note_id):
    if isinstance(node, list):
        for child in node:
            yield from checked_rows(child, note_id)
    elif isinstance(node, dict):
        if node.get("type", node.get("note_type")) in ("video", "normal"):
            ids = [node[k] for k in ("id", "note_id", "noteId") if k in node]
            if ids and all(item == note_id for item in ids):
                yield node
            return
        for key in ("data", "items", "notes", "note", "note_list", "note_card", "note_list_new", "feed", "feeds"):
            if key in node:
                yield from checked_rows(node[key], note_id)


def stream_for(payload, note_id):
    rows = list(checked_rows(payload.get("data"), note_id)) if isinstance(payload, dict) and payload.get("code") == 200 else []
    if len(rows) != 1 or rows[0].get("type", rows[0].get("note_type")) != "video":
        raise SourceError("needs_local_video", "详情未返回唯一匹配该 ID 的视频笔记。" + LOCAL_FALLBACK)
    row = rows[0]
    options = []
    media = (row.get("video_info_v2") or {}).get("media") or {}
    # Accept explicit original media metadata; never turn a cover URL into a video.
    for entry in (media, row.get("video") or {}):
        if not isinstance(entry, dict):
            continue
        video_meta = entry.get("video") or {}
        if not isinstance(video_meta, dict) or video_meta.get("drm_type", entry.get("drm_type")) != 0:
            continue
        stream_map = entry.get("stream")
        if not isinstance(stream_map, dict):
            continue
        for codec in ("h264", "h265"):
            streams = stream_map.get(codec) or []
            for stream in streams if isinstance(streams, list) else ():
                if not isinstance(stream, dict) or stream.get("format") != "mp4" or stream.get("drm_type", 0) != 0:
                    continue
                width, height = stream.get("width"), stream.get("height")
                size, duration = stream.get("size"), stream.get("duration", stream.get("video_duration"))
                if not all(type(n) is int and n > 0 for n in (size, width, height, duration)) or size > MAX_BYTES:
                    continue
                alternates = stream.get("backup_urls")
                for value in [stream.get("master_url"), *(alternates if isinstance(alternates, list) else [])]:
                    try:
                        url = validated_url(value, media=True)
                    except SourceError:
                        continue
                    options.append((width * height, codec == "h264", size, width, height, duration, url))
                    break
    if not options:
        raise SourceError("needs_local_video", "详情缺少受支持的未加密 MP4 地址或完整媒体参数。" + LOCAL_FALLBACK)
    _, _, size, width, height, duration, url = max(options)
    return url, {"size": size, "width": width, "height": height, "duration": duration / 1000}


def write_receipt(path, data, exclusive=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode="w", encoding="utf-8") as tmp:
        staging = Path(tmp.name)
        try:
            json.dump(data, tmp, ensure_ascii=False, indent=2)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp.close()
            if exclusive:
                os.link(staging, path)
            else:
                os.replace(staging, path)
        finally:
            staging.unlink(missing_ok=True)


def read_detail(note, key, opener):
    url = DETAIL + "?" + urlencode({"note_id": note})
    req = Request(url, headers={"Accept": "application/json", "Authorization": "Bearer " + key})
    with opener.open(req, timeout=35) as response:
        if response.status != 200 or response.geturl() != url:
            raise SourceError("needs_local_video", "未能从原详情接口取得数据。" + LOCAL_FALLBACK)
        raw = response.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise SourceError("needs_local_video", "详情响应超过支持的大小。" + LOCAL_FALLBACK)
    return stream_for(json.loads(raw), note)


def fetch_mp4(url, declared, staging, opener):
    request = Request(url, headers={"Accept": "video/mp4,application/octet-stream", "Accept-Encoding": "identity"})
    with opener.open(request, timeout=35) as response:
        size = declared["size"]
        length = response.headers.get("Content-Length")
        if (response.status != 200 or response.geturl() != url or response.headers.get("Content-Encoding", "identity") != "identity"
                or length is not None and (not length.isascii() or not length.isdecimal() or int(length) != size)):
            raise SourceError("invalid_video", "下载响应与目标原片不符。" + LOCAL_FALLBACK)
        deadline = time.monotonic() + 600
        total = 0
        while total <= size:
            chunk = response.read(min(256 * 1024, size + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > size or time.monotonic() > deadline:
                raise SourceError("invalid_video", "原片下载超出声明大小或已超时。" + LOCAL_FALLBACK)
            staging.write(chunk)
        if total != size:
            raise SourceError("invalid_video", "下载的原片不完整。" + LOCAL_FALLBACK)


def acquire(out, *, video=None, url=None, allow_paid_lookup=False, opener=None, probe=video_probe):
    if bool(video) == bool(url):
        raise SourceError("invalid_source", "请选择本地原片或一条小红书视频链接。")
    out = Path(out).resolve()
    link = share_link(url) if url else None
    note = note_id_at(link) if link else None
    source_id = sha256(link.encode()).hexdigest() if link else None
    local = Path(video).expanduser().resolve() if video else None
    if local and (not local.is_file() or local.suffix.lower() not in VIDEO_SUFFIX or local.stat().st_size == 0):
        raise SourceError("invalid_video", "本地原片不存在、为空或容器不受支持。")
    local_hash = file_hash(local) if local else None
    receipt = out / "source.json"
    if receipt.exists():
        prior = json.loads(receipt.read_text(encoding="utf-8"))
        matches = (local_hash is not None and local_hash == prior.get("sha256") or
                   source_id is not None and (source_id == prior.get("input_digest") or bool(note and note == prior.get("note_id"))))
        name = prior.get("file")
        if not matches or not isinstance(name, str) or name != Path(name).name or not re.fullmatch(r"source-[0-9a-f]{64}\.(mp4|mov|m4v|mkv|webm|avi)", name):
            raise SourceError("workdir_in_use", "此工作目录已绑定其他来源或回执无效，请另选目录。")
        saved = out / name
        if saved.is_symlink() or not saved.is_file() or file_hash(saved) != prior.get("sha256"):
            raise SourceError("invalid_receipt", "缓存的原片与回执不符，请核对本地文件。")
        info = probe(saved)
        return {"status": "ready", "video": str(saved), "note_id": prior.get("note_id"), "sha256": prior["sha256"], **info}
    if link and not allow_paid_lookup:
        raise SourceError("needs_authorization", "详情解析最多调用 TikHub 一次，可能计费。负责人同意后加 --allow-paid-lookup，或提供本地视频。")
    key = os.environ.get("TIKHUB_API_KEY", "").strip() if link else None
    if link and not key:
        raise SourceError("needs_credentials", "请在执行机器的私有环境设置 TIKHUB_API_KEY，或提供本地视频。")
    probe(None)  # Fail before requesting the paid service.
    out.mkdir(parents=True, exist_ok=True)
    declared = None
    if link:
        opener = opener or build_opener(NoRedirect())
        note = resolve_note(link, opener)
        try:
            write_receipt(out / ".lookup-attempt.json", {"note_id": note}, exclusive=True)
        except FileExistsError:
            raise SourceError("lookup_already_attempted", "该任务已发起过一次详情查询，已有记录可供核对。" + LOCAL_FALLBACK) from None
        stream_url, declared = read_detail(note, key, opener)
    suffix = local.suffix.lower() if local else ".mp4"
    with tempfile.NamedTemporaryFile(dir=out, suffix=suffix, delete=False) as tmp:
        staging = Path(tmp.name)
    try:
        with staging.open("wb") as target:
            if local:
                with local.open("rb") as source:
                    shutil.copyfileobj(source, target, 1024**2)
            else:
                fetch_mp4(stream_url, declared, target, opener)
        info = probe(staging)
        fingerprint = file_hash(staging)
        if (local_hash and fingerprint != local_hash or declared and
                (info["width"] != declared["width"] or info["height"] != declared["height"] or
                 abs(info["duration"] - declared["duration"]) > 0.5)):
            raise SourceError("invalid_video", "原片与输入文件或详情声明不一致。" + LOCAL_FALLBACK)
        saved = out / ("source-" + fingerprint + suffix)
        try:
            os.link(staging, saved)
        except FileExistsError:
            if saved.is_symlink() or file_hash(saved) != fingerprint:
                raise SourceError("invalid_receipt", "同名目标文件与原片不一致。") from None
        try:
            write_receipt(receipt, {"input_digest": source_id, "note_id": note, "file": saved.name, "sha256": fingerprint}, exclusive=True)
        except FileExistsError:
            raise SourceError("workdir_in_use", "另一个进程已完成此工作目录，请读取原任务回执。") from None
        return {"status": "ready", "video": str(saved), "note_id": note, "sha256": fingerprint, **info}
    finally:
        staging.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--video", type=Path)
    sources.add_argument("--url", help="一条小红书视频笔记链接或分享文字")
    parser.add_argument("--out", required=True, type=Path, help="该来源独享的工作目录")
    parser.add_argument("--allow-paid-lookup", action="store_true", help="同意该任务最多 1 次 TikHub 视频详情调用")
    args = parser.parse_args()
    try:
        result = acquire(**vars(args))
    except SourceError as error:
        result = {"status": error.status, "reason": str(error)}
    except (HTTPError, URLError, TimeoutError, HTTPException):
        result = {"status": "source_unavailable", "reason": "链接请求失败，详情查询可能已占用本次额度。" + LOCAL_FALLBACK}
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError, subprocess.SubprocessError):
        result = {"status": "invalid_source", "reason": "请核对媒体、元数据或工作目录后继续。" + LOCAL_FALLBACK}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
