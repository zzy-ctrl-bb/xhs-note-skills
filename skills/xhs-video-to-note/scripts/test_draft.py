import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image

import draft


class DraftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise RuntimeError("Put FFmpeg and ffprobe on PATH to run the integration tests.")
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name).resolve()
        cls.video = cls.root / "demo.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i",
                        "testsrc=size=180x100:rate=6", "-f", "lavfi", "-i", "sine=frequency=330",
                        "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(cls.video)],
                       check=True)
        cls.work = cls.root / "evidence"
        draft.prepare(cls.video, cls.work, [0, 0.55], True)
        cls.source = json.loads((cls.work / "source.json").read_text())
        cls.base_plan = json.loads((cls.work / "plan.template.json").read_text())
        cls.base_plan.update(title={"text": "A color study", "frames": ["f01"]},
                             paragraphs=[{"text": "A test pattern moves.", "frames": ["f01", "f02"]},
                                         {"text": "The soundtrack has a tone.", "audio_ranges": [[0.1, 0.7]]}],
                             pages=[{"frame": "f01", "caption": "Opening frame"}, {"frame": "f02", "caption": "Later frame"}])

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.tempdir.cleanup)
        self.directory = Path(self.tempdir.name)
        self.package = self.directory / "note"
        self.plan = copy.deepcopy(self.base_plan)

    def build(self, work=None):
        plan_path = self.directory / "plan.json"
        draft.write_json(plan_path, self.plan)
        return draft.build(work or self.work, plan_path, self.package)

    def test_default_short_video_evidence_includes_middle_frames(self):
        target = self.root / "default-sampling"
        draft.prepare(self.video, target)
        frames = json.loads((target/"source.json").read_text())["frames"]
        numbers = [entry["frame_number"] for entry in frames]
        self.assertGreaterEqual(len(set(numbers)), 4)
        self.assertLess(numbers[0], numbers[1])
        self.assertLess(numbers[1], numbers[-1])

    def test_actual_video_to_package_with_source_and_audio(self):
        frames = self.source["frames"]
        self.assertEqual([f["frame_number"] for f in frames], [0, 3])
        self.assertEqual(frames[1]["seconds"], 0.5)
        self.assertEqual(self.build()["status"], "rendered")
        self.assertEqual({f.name for f in self.package.iterdir()}, {"title.txt", "content.txt", "cover.jpg", "01.jpg"})
        self.assertEqual((self.package / "title.txt").read_text().strip(), "A color study")
        self.assertIn("moves.\n\nThe soundtrack", (self.package / "content.txt").read_text())
        for filename in ["cover.jpg", "01.jpg"]:
            with Image.open(self.package / filename) as im:
                self.assertEqual((im.format, im.size), ("JPEG", (1080, 1440)))
        before = draft.file_hash(self.package / "cover.jpg")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        self.assertEqual(draft.file_hash(self.package / "cover.jpg"), before)

    def test_frame_inventory_cannot_be_substituted(self):
        another = self.directory / "other"
        draft.prepare(self.video, another, [0.5, 0.75])
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.build(another)
        self.assertFalse(self.package.exists())

    def test_changed_frame_and_original_are_flagged(self):
        work = self.directory / "work"
        shutil.copytree(self.work, work)
        with (work / "frames/f01.jpg").open("ab") as f:
            f.write(b"changed")
        with self.assertRaisesRegex(ValueError, "frame changed"):
            self.build(work)
        metadata = json.loads((work / "source.json").read_text())
        wrong = self.directory / "different.mp4"
        wrong.write_bytes(b"other")
        metadata["source_path"] = str(wrong)
        draft.write_json(work / "source.json", metadata)
        with self.assertRaisesRegex(ValueError, "original video changed"):
            self.build(work)

    def test_unknown_missing_or_invalid_support(self):
        for invalid in [
            {"text": "Unverified", "frames": []},
            {"text": "Unverified", "frames": ["f99"]},
            {"text": "Unverified", "audio_ranges": [[0, 90]]},
            {"text": "Unverified", "audio_ranges": [[0.8, 0.2]]},
        ]:
            with self.subTest(invalid=invalid):
                self.plan["paragraphs"] = [invalid]
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse(self.package.exists())

    def test_one_page_and_empty_caption(self):
        self.plan["pages"] = [{"frame": "f01"}]
        self.assertEqual(self.build()["images"], 1)
        self.assertFalse((self.package / "01.jpg").exists())

    def test_blank_template_or_unknown_page_leaves_no_partial_output(self):
        self.plan["pages"].append({"frame": "../../other.jpg", "caption": ""})
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.package.exists())
        self.plan = json.loads((self.work / "plan.template.json").read_text())
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.package.exists())


if __name__ == "__main__":
    unittest.main()
