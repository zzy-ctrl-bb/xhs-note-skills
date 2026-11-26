"""Rebuild the offline sample from its video and editorial decisions, then check the handoff."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="New folder for the finished note")
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists():
        parser.error("输出目录已存在，请指定一个新的目录。")
    here = Path(__file__).resolve().parent
    root = here.parents[1]
    draft = root / "skills/xhs-video-to-note/scripts/draft.py"
    with tempfile.TemporaryDirectory(prefix="xhs-cards-") as directory:
        work = Path(directory) / "frames"
        command = [sys.executable, "-B", str(draft)]
        subprocess.run([*command, "prepare", "--video", str(here / "source.mp4"), "--work", str(work),
                        "--at", "0.8", "--at", "2.7", "--at", "4.8"], check=True)
        plan = json.loads((work / "plan.template.json").read_text(encoding="utf-8"))
        plan.update(
            title={"text": "三张便签的配色顺序", "frames": ["f03"]},
            paragraphs=[
                {"text": "先看左边，一张黄色便签斜放在浅色背景上。", "frames": ["f01"]},
                {"text": "绿色便签出现在它右边。最后加上一张淡紫色，三张便签从左到右排成一行。", "frames": ["f02", "f03"]},
            ],
            pages=[
                {"frame": "f03", "caption": "黄、绿、紫，从左到右看全貌"},
                {"frame": "f01", "caption": "先放一张黄便签"},
                {"frame": "f02", "caption": "绿色出现在右边"},
            ],
        )
        plan_path = Path(directory) / "plan.json"
        plan_path.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        subprocess.run([*command, "build", "--work", str(work), "--plan", str(plan_path), "--out", str(out)], check=True)
    subprocess.run(["node", str(root / "skills/xhs-publish-note/cli.mjs"), "check", str(out), "--json"], check=True)


if __name__ == "__main__":
    main()
