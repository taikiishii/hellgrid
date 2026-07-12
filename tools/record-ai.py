# AIのプレイを録画する。
#
#   python tools/record-ai.py                    … 全5ステージ、AI視点の可視化つき
#   python tools/record-ai.py --no-vision        … 可視化なし (ゲーム画面だけ)
#   python tools/record-ai.py --levels 0 2 --gif … 指定ステージだけ、GIFも作る
#
# 出力: media/ai-play.webm  (+ --gif なら media/ai-play.gif)
# GIF/MP4 への変換には ffmpeg が要る (なければ webm のまま。webm は GitHub の
# README にも貼れるし、ブラウザでそのまま再生できる)。
import argparse
import pathlib
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
MEDIA = ROOT / "media"

ap = argparse.ArgumentParser()
ap.add_argument("--levels", type=int, nargs="*", default=[0, 1, 2, 3, 4])
ap.add_argument("--no-vision", action="store_true", help="AI視点の可視化を切る")
ap.add_argument("--gif", action="store_true", help="ffmpeg で GIF にも変換する")
ap.add_argument("--mp4", action="store_true", help="ffmpeg で MP4 にも変換する")
ap.add_argument("--timeout", type=int, default=60, help="1ステージあたりの上限秒")
args = ap.parse_args()

MEDIA.mkdir(exist_ok=True)
tmp = MEDIA / "_raw"
if tmp.exists():
    shutil.rmtree(tmp)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 800},
        record_video_dir=str(tmp),
        record_video_size={"width": 1280, "height": 800},
    )
    page = ctx.new_page()
    page.goto((ROOT / "index.html").as_uri())
    page.wait_for_timeout(2500)          # policy.js (4.8MB) の読み込み待ち

    page.keyboard.press("KeyI")          # AI デモ開始
    page.wait_for_timeout(300)
    if args.no_vision:
        page.keyboard.press("KeyV")
    page.wait_for_timeout(500)

    for lv in args.levels:
        # 目的のステージから始める (AI は自動で次へ進むが、録画は指定順で回す)
        page.evaluate(f"HG.world.reset({lv}); HG.world.drainEvents(); ai.syncLevel();")
        t0 = time.time()
        while time.time() - t0 < args.timeout:
            page.wait_for_timeout(250)
            st = page.evaluate("HG.world.state")
            if st != "playing":
                break
        name = page.evaluate("HG.world.level.def.name")
        secs = page.evaluate("Math.round(HG.world.level.time * 10) / 10")
        print(f"  {'クリア' if st == 'levelEnd' else '死亡  '}  {name}  {secs}秒")
        page.wait_for_timeout(1800)      # クリア画面を少し見せる

    video = page.video.path()
    ctx.close()
    browser.close()

out = MEDIA / "ai-play.webm"
shutil.move(video, out)
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n録画: {out}  ({out.stat().st_size / 1e6:.1f} MB)")

if not (args.gif or args.mp4):
    sys.exit(0)

if not shutil.which("ffmpeg"):
    print("ffmpeg が見つからないので webm のままにした (webm は README にも貼れる)")
    sys.exit(0)

if args.mp4:
    mp4 = MEDIA / "ai-play.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out),
                    "-vf", "scale=960:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "23", str(mp4)], check=True)
    print(f"MP4:  {mp4}  ({mp4.stat().st_size / 1e6:.1f} MB)")

if args.gif:
    gif = MEDIA / "ai-play.gif"
    palette = MEDIA / "_palette.png"
    vf = "fps=15,scale=640:-1:flags=lanczos"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out),
                    "-vf", f"{vf},palettegen", str(palette)], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(out), "-i", str(palette),
                    "-lavfi", f"{vf}[x];[x][1:v]paletteuse", str(gif)], check=True)
    palette.unlink()
    print(f"GIF:  {gif}  ({gif.stat().st_size / 1e6:.1f} MB)")
