#!/usr/bin/env python3
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import download_source as ds

NOTE = "abcdef0123456789abcdef01"
OTHER = "222222222222222222222222"
LONG = "https://www.xiaohongshu.com/explore/" + NOTE
SHORT = "https://xhslink.cn/o/synthetic"
CDN = "https://sns-v42.rednotecdn.com/dummy.mp4?sign=ephemeral"
CONTENTS = b"synthetic media bytes"


class Response(io.BytesIO):
    status = 200

    def __init__(self, url, data):
        super().__init__(data)
        self.url = url
        self.headers = {"Content-Length": str(len(data))}

    def geturl(self):
        return self.url


def note_record(note):
    stream = {"master_url": CDN, "width": 60, "height": 80, "duration": 2000, "size": len(CONTENTS), "format": "mp4"}
    return {"note_id": note, "type": "video", "video_info_v2": {"media": {"video": {"drm_type": 0}, "stream": {"h264": [stream]}}}}


class FakeOpener:
    def __init__(self):
        self.calls = []
        self.redirect = LONG
        self.payload = {"code": 200, "data": {"data": [{"note_list": [note_record(OTHER), note_record(NOTE)]}]}}
        self.content = CONTENTS

    def open(self, request, timeout):
        url = request.full_url
        self.calls.append((url, request.get_header("Authorization")))
        if url == SHORT:
            raise HTTPError(url, 302, "redirect", {"Location": self.redirect}, io.BytesIO())
        if url == ds.DETAIL + "?note_id=" + NOTE:
            return Response(url, json.dumps(self.payload).encode())
        if url == CDN:
            return Response(url, self.content)
        raise AssertionError("unexpected HTTP destination")


def probe(file):
    if file is None:
        return
    if Path(file).read_bytes() != CONTENTS:
        raise ds.SourceError("invalid_video", "fixture file failed verification")
    return {"width": 60, "height": 80, "duration": 2.0}


class SourceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.work = self.root / "run"
        self.http = FakeOpener()
        env = patch.dict("os.environ", {"TIKHUB_API_KEY": "offline-test-key"})
        env.start()
        self.addCleanup(env.stop)
        blocker = patch("socket.socket.connect", side_effect=AssertionError("test must remain offline"))
        blocker.start()
        self.addCleanup(blocker.stop)

    def run_source(self, **kwargs):
        return ds.acquire(self.work, opener=self.http, probe=probe, **kwargs)

    def test_local_and_cache_without_key(self):
        local = self.root / "original.mov"
        local.write_bytes(CONTENTS)
        with patch.dict("os.environ", {"TIKHUB_API_KEY": ""}):
            first = self.run_source(video=local)
            self.assertEqual(self.run_source(video=local), first)
        self.assertEqual(Path(first["video"]).read_bytes(), CONTENTS)
        self.assertEqual(self.http.calls, [])
        Path(first["video"]).write_bytes(b"changed")
        with self.assertRaises(ds.SourceError) as caught:
            self.run_source(video=local)
        self.assertEqual(caught.exception.status, "invalid_receipt")

    def test_consent_and_key_before_requests(self):
        with self.assertRaises(ds.SourceError) as caught:
            self.run_source(url=SHORT)
        self.assertEqual(caught.exception.status, "needs_authorization")
        with patch.dict("os.environ", {"TIKHUB_API_KEY": ""}):
            with self.assertRaises(ds.SourceError) as caught:
                self.run_source(url=SHORT, allow_paid_lookup=True)
        self.assertEqual(caught.exception.status, "needs_credentials")
        self.assertFalse(self.http.calls)
        self.assertFalse(self.work.exists())

    def test_canonical_and_short_get_exact_note_strip_secrets_and_resume(self):
        same = "看这条笔记 " + SHORT.replace("https:", "http:") + " 复制打开"
        result = self.run_source(url=same, allow_paid_lookup=True)
        self.assertEqual(result["note_id"], NOTE)
        self.assertEqual(result["width"], 60)
        self.assertEqual(self.http.calls, [(SHORT, None), (ds.DETAIL + "?note_id=" + NOTE, "Bearer offline-test-key"), (CDN, None)])
        self.assertEqual(self.run_source(url=same), result)
        self.assertEqual(self.run_source(url=LONG + "?xsec_token=fake"), result)
        self.assertEqual(len(self.http.calls), 3)
        for path in self.work.glob("*.json"):
            saved = path.read_text()
            self.assertNotIn("ephemeral", saved)
            self.assertNotIn("offline-test-key", saved)
        self.assertNotIn(CDN, json.dumps(result))

    def test_refuses_wrong_duplicate_or_encrypted_item(self):
        encrypted = note_record(NOTE)
        encrypted["video_info_v2"]["media"]["video"]["drm_type"] = 1
        for rows in ([note_record(OTHER)], [note_record(NOTE), note_record(NOTE)], [encrypted],
                     [{"type": "normal", "note_id": NOTE, "cover": CDN}]):
            with self.subTest(rows=rows), self.assertRaises(ds.SourceError) as caught:
                ds.stream_for({"code": 200, "data": {"data": {"notes": rows}}}, NOTE)
            self.assertEqual(caught.exception.status, "needs_local_video")

    def test_duplicate_paid_request_blocked_on_failed_cdn_then_allow_local(self):
        self.http.content = b"truncated"
        with self.assertRaises(ds.SourceError):
            self.run_source(url=LONG, allow_paid_lookup=True)
        with self.assertRaises(ds.SourceError) as caught:
            self.run_source(url=LONG, allow_paid_lookup=True)
        self.assertEqual(caught.exception.status, "lookup_already_attempted")
        self.assertEqual(len(self.http.calls), 2)
        local = self.root / "original.mp4"
        local.write_bytes(CONTENTS)
        self.assertEqual(self.run_source(video=local)["status"], "ready")

    def test_short_redirect_to_other_host_never_followed(self):
        self.http.redirect = "https://localhost/test"
        with self.assertRaises(ds.SourceError):
            self.run_source(url=SHORT, allow_paid_lookup=True)
        self.assertEqual(self.http.calls, [(SHORT, None)])
        self.assertFalse((self.work / ".lookup-attempt.json").exists())

    def test_rejects_cross_domain_or_credentials_before_paid_lookup(self):
        for url in (LONG.replace("www.", "evil."), "https://user@xhslink.com/one", "https://xhslink.cn:123/one", LONG + " " + SHORT):
            with self.subTest(url=url), self.assertRaises(ds.SourceError):
                self.run_source(url=url, allow_paid_lookup=True)
        self.assertFalse(self.http.calls)
        self.assertIsNone(ds.NoRedirect().redirect_request(None, None, 302, "", {}, CDN))
        for url in ("https://sns-v42.rednotecdn.com.attacker.invalid/file.mp4", "https://other.invalid/file.mp4",
                    "https://user@sns-v42.rednotecdn.com/file.mp4", "file:///private/media.mp4"):
            with self.assertRaises(ds.SourceError):
                ds.validated_url(url, media=True)

    def test_ffprobe_is_required_before_charge(self):
        with patch.object(ds.shutil, "which", return_value=None):
            with self.assertRaises(ds.SourceError) as caught:
                ds.acquire(self.work, url=LONG, allow_paid_lookup=True, opener=self.http)
        self.assertEqual(caught.exception.status, "needs_ffmpeg")
        self.assertFalse(self.http.calls)


if __name__ == "__main__":
    unittest.main()
