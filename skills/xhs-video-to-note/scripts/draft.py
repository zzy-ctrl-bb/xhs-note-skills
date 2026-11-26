#!/usr/bin/env python3
"""Create a local evidence packet and render a reviewed video-to-note plan."""
import argparse
import bisect
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import wave
import unicodedata

from PIL import Image, ImageDraw, ImageFont


def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_tool(name, *args):
    binary = shutil.which(name)
    if not binary:
        raise ValueError(f"Install FFmpeg and ffprobe and add them to PATH (missing {name}).")
    result = subprocess.run([binary, *map(str, args)], capture_output=True)
    if result.returncode:
        error = result.stderr.decode("utf-8", "replace").strip()
        raise ValueError(f"{name} failed: {error[-600:]}")
    return result.stdout


@contextmanager
def new_folder(destination):
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"Choose a new output directory; this path already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".render-") as staging:
        directory = Path(staging) / "data"
        directory.mkdir(mode=0o700)
        yield directory
        directory.rename(destination)


def inspect(video):
    shared = ("-v", "error", "-protocol_whitelist", "file,pipe")
    desc = json.loads(run_tool("ffprobe", *shared, "-show_entries",
                               "stream=codec_type:stream_disposition=attached_pic:format=duration,start_time",
                               "-of", "json", video))
    if not any(s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
               for s in desc.get("streams", [])):
        raise ValueError("The file has no motion-video stream.")
    rows = json.loads(run_tool("ffprobe", *shared, "-select_streams", "V:0", "-show_frames",
                               "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", video))
    try:
        start = float(desc["format"].get("start_time", 0))
        duration = float(desc["format"]["duration"])
        times = [round(float(row["best_effort_timestamp_time"]) - start, 6) for row in rows["frames"]]
    except (KeyError, ValueError, TypeError) as error:
        raise ValueError("Unable to read frame timestamps or duration.") from error
    if (not math.isfinite(duration) or duration <= 0 or not times or
            any(not math.isfinite(t) for t in times) or times != sorted(times)):
        raise ValueError("Invalid video timing.")
    return duration, times, any(s["codec_type"] == "audio" for s in desc["streams"])


def evidence_digest(source):
    fields = {k: source[k] for k in ("source_sha256", "duration", "frames", "audio")}
    blob = json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def prepare(video, work, at=None, audio=False):
    video = video.resolve(strict=True)
    initial_hash = file_hash(video)
    duration, times, has_audio = inspect(video)
    if at:
        if any(not math.isfinite(t) or not 0 <= t < duration for t in at):
            raise ValueError("Sampling times must be seconds within the source duration.")
    else:
        count = min(len(times), 12, max(4, math.ceil(duration / 3) + 1))
        at = [max(times[0], 0) + (times[-1] - max(times[0], 0)) * i / max(1, count - 1)
              for i in range(count)]
    # Last frame displayed at/before the requested timestamp. Keep original frame numbers.
    indices = sorted({max(0, bisect.bisect_right(times, t) - 1) for t in at})
    common = ("-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", video)
    with new_folder(work) as directory:
        frames = directory / "frames"
        frames.mkdir()
        select = "+".join(f"eq(n\\,{n})" for n in indices)
        run_tool("ffmpeg", *common, "-map", "0:V:0", "-an", "-vf", "select=" + select, "-vsync", "0",
                 "-frames:v", len(indices), "-q:v", "2", "-threads", "1", frames / "f%02d.jpg")
        evidence = []
        for i, n in enumerate(indices, 1):
            frame_id = f"f{i:02d}"
            rel = f"frames/{frame_id}.jpg"
            evidence.append({"id": frame_id, "frame_number": n, "seconds": times[n], "path": rel,
                             "sha256": file_hash(directory / rel)})
        sound = None
        if audio and has_audio:
            path = directory / "audio.wav"
            # Align sample zero to the media timeline, including leading silence when present.
            run_tool("ffmpeg", *common, "-map", "0:a:0", "-vn", "-af", "aresample=async=1:first_pts=0",
                     "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path)
            with wave.open(str(path), "rb") as track:
                audio_seconds = track.getnframes() / track.getframerate()
            sound = {"path": path.name, "sha256": file_hash(path), "duration": audio_seconds}
        if initial_hash != file_hash(video):
            raise ValueError("The source changed during extraction. Start with a stable local video file.")
        source = {"source_path": str(video), "source_sha256": initial_hash, "duration": duration,
                  "frames": evidence, "has_audio": has_audio, "audio": sound}
        source["evidence_sha256"] = evidence_digest(source)
        write_json(directory / "source.json", source)
        first = evidence[0]["id"]
        template = {"source_sha256": initial_hash, "evidence_sha256": source["evidence_sha256"],
                    "title": {"text": "", "frames": [first]}, "paragraphs": [{"text": "", "frames": [first]}],
                    "pages": [{"frame": first, "caption": ""}]}
        write_json(directory / "plan.template.json", template)
    return {"status": "prepared", "work": str(work.resolve()), "frames": len(evidence),
            "audio": "audio.wav" if sound else None}


def single_line(text, field, allow_empty=False):
    if not isinstance(text, str) or text != text.strip() or (not allow_empty and not text):
        raise ValueError(f"{field} needs trimmed text.")
    if len(text.splitlines()) > 1 or any(ord(c) < 32 for c in text):
        raise ValueError(f"{field} must be a single line.")
    return text


def list_field(obj, name):
    value = obj.get(name)
    if not isinstance(value, list) or not value:
        raise ValueError(f"Provide a nonempty {name} array.")
    return value


def supported_text(item, field, refs, sound):
    if not isinstance(item, dict):
        raise ValueError(f"Provide {field} as an object with text and evidence.")
    text = single_line(item.get("text"), field)
    frame_ids, spans = item.get("frames", []), item.get("audio_ranges", [])
    if not isinstance(frame_ids, list) or not isinstance(spans, list) or not (frame_ids or spans):
        raise ValueError(f"{field} needs original frames or verified audio time ranges.")
    if any(not isinstance(ref, str) or ref not in refs for ref in frame_ids):
        raise ValueError(f"Unknown evidence frame in {field}.")
    for span in spans:
        if (not sound or not isinstance(span, list) or len(span) != 2
                or any(type(t) not in (int, float) or not math.isfinite(t) for t in span)
                or not 0 <= span[0] < span[1] <= sound["duration"]):
            raise ValueError(f"Invalid audio range in {field}; prepare with --audio and listen to the cited range.")
    return text


def face(size, override, text):
    candidates = [override] if override else [
        os.environ.get("XHS_NOTE_FONT"), "/System/Library/Fonts/STHeiti Medium.ttc",
        "C:/Windows/Fonts/msyh.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", "DejaVuSans.ttf"]
    for name in filter(None, candidates):
        try:
            font = ImageFont.truetype(str(name), size)
            missing = bytes(font.getmask("\u0378"))
            printable = {ch for ch in text if not ch.isspace() and unicodedata.category(ch)[0] in "LNPS"}
            if all(bytes(font.getmask(ch)) != missing for ch in printable):
                return font
        except OSError:
            continue
    raise ValueError("Select an installed font covering the note's script with --font FONT_FILE.")


def wrap(text, font, limit=936):
    lines, line = [], ""
    for c in text:
        if line and font.getlength(line + c) > limit:
            lines.append(line.rstrip())
            line = ""
        line += c
    if line.strip():
        lines.append(line.strip())
    return lines


def paint(frame, path, title, caption, font_path):
    width, height, margin = 1080, 1440, 56
    canvas = Image.new("RGB", (width, height), "#f8f6f0")
    draw = ImageDraw.Draw(canvas)
    blocks = []
    for text, size, color in ((title, 70, "#192e31"), (caption, 43, "#2b4144")):
        if not text:
            continue
        font = face(size, font_path, text)
        lines = wrap(text, font)
        blocks.append((font, lines, size + 15, color))
    text_height = sum(leading * len(lines) + 18 for font, lines, leading, color in blocks)
    if text_height > height // 2:
        raise ValueError("Shorten this page's caption or use another page; the original image needs room.")
    image_height = height - margin * 2 - text_height
    with Image.open(frame) as image:
        scale = min((width - 2 * margin) / image.width, image_height / image.height)
        fitted = image.convert("RGB").resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                                             Image.Resampling.LANCZOS)
    top = (height - text_height - fitted.height) // 2
    for font, lines, leading, color in blocks:
        for line in lines:
            draw.text((margin, top), line, font=font, fill=color, anchor="lt")
            top += leading
        top += 18
    canvas.paste(fitted, ((width - fitted.width) // 2, top))
    canvas.save(path, "JPEG", quality=94, optimize=True)


def build(work, plan_path, out, font_path=None):
    work = work.resolve(strict=True)
    source = json.loads((work / "source.json").read_text(encoding="utf-8"))
    plan = json.loads(plan_path.read_text(encoding="utf-8-sig"))
    if not isinstance(plan, dict) or plan.get("source_sha256") != source["source_sha256"]:
        raise ValueError("Plan and source do not match.")
    if (plan.get("evidence_sha256") != source.get("evidence_sha256")
            or source["evidence_sha256"] != evidence_digest(source)):
        raise ValueError("The plan uses another frame inventory. Review the current source and frames.")
    if file_hash(Path(source["source_path"])) != source["source_sha256"]:
        raise ValueError("The original video changed.")
    refs = {}
    for frame in list_field(source, "frames"):
        ident = frame["id"]
        if (not isinstance(ident, str) or not ident.startswith("f") or not ident[1:].isascii()
                or not ident[1:].isdigit() or ident in refs or frame["path"] != f"frames/{ident}.jpg"):
            raise ValueError("Unexpected frame entry.")
        path = work / frame["path"]
        if path.resolve() != path or file_hash(path) != frame["sha256"]:
            raise ValueError(f"Original frame changed: {ident}")
        refs[ident] = path
    sound = source.get("audio")
    if sound and (sound["path"] != "audio.wav" or file_hash(work / "audio.wav") != sound["sha256"]):
        raise ValueError("Evidence audio changed.")
    title = supported_text(plan.get("title"), "title", refs, sound)
    if len(title) > 20:
        raise ValueError("Use a title with at most 20 characters for this publishing workflow.")
    paragraphs = [supported_text(p, "paragraph", refs, sound) for p in list_field(plan, "paragraphs")]
    pages = list_field(plan, "pages")
    if len(pages) > 18:
        raise ValueError("Use at most 18 pages including the cover.")
    with new_folder(out) as directory:
        (directory / "title.txt").write_text(title + "\n", encoding="utf-8")
        (directory / "content.txt").write_text("\n\n".join(paragraphs) + "\n", encoding="utf-8")
        for i, page in enumerate(pages):
            if not isinstance(page, dict) or not isinstance(page.get("frame"), str) or page["frame"] not in refs:
                raise ValueError("Each page needs a frame ID from the current source.")
            caption = single_line(page.get("caption", ""), "caption", allow_empty=True)
            name = f"{i:02d}.jpg" if i else "cover.jpg"
            paint(refs[page["frame"]], directory / name, "" if i else title, caption, font_path)
    return {"status": "rendered", "package": str(out.resolve()), "images": len(pages), "review": "open-final-images"}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    group = p.add_subparsers(dest="command", required=True)
    prep = group.add_parser("prepare", help="extract original frames and optional audio")
    prep.add_argument("--video", required=True, type=Path)
    prep.add_argument("--work", required=True, type=Path)
    prep.add_argument("--at", type=float, action="append", help="time in seconds; repeat for multiple frames")
    prep.add_argument("--audio", action="store_true", help="extract the first audio track, if present")
    render = group.add_parser("build", help="render a grounded plan into a portable note folder")
    render.add_argument("--work", required=True, type=Path)
    render.add_argument("--plan", required=True, type=Path)
    render.add_argument("--out", required=True, type=Path)
    render.add_argument("--font", type=Path, help="font file covering the script on your pages")
    args = p.parse_args()
    try:
        if args.command == "prepare":
            result = prepare(args.video, args.work, args.at, args.audio)
        else:
            result = build(args.work, args.plan, args.out, args.font)
    except (OSError, KeyError, ValueError, TypeError) as exc:
        print(json.dumps({"status": "blocked", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
