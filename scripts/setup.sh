#!/usr/bin/env bash
# One-time setup: system tools, the AI upscaler, tracking models and npm deps.
# Safe to run again; it skips anything already in place.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Checking tools"
for t in ffmpeg yt-dlp go node; do
  if ! command -v "$t" >/dev/null 2>&1; then
    case "$t" in
      ffmpeg|yt-dlp) echo "Installing $t with Homebrew"; brew install "$t" ;;
      *) echo "Missing $t. Install it first (go: https://go.dev/dl, node: https://nodejs.org)"; exit 1 ;;
    esac
  fi
done
echo "ffmpeg, yt-dlp, go and node are installed"

say "AI upscaler (Real-ESRGAN, runs on the Mac's GPU)"
ESR="$ROOT/tools/realesrgan"
if [ ! -x "$ESR/realesrgan-ncnn-vulkan" ]; then
  tmp=$(mktemp -d)
  curl -fL --progress-bar -o "$tmp/esr.zip" \
    https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip
  mkdir -p "$ESR" && unzip -q -o "$tmp/esr.zip" -d "$ESR" && rm -rf "$tmp"
  chmod +x "$ESR/realesrgan-ncnn-vulkan"
fi
# realesr-general-x4v3 converted to ncnn by Upscayl: fast enough for video.
for ext in param bin; do
  f="$ESR/models/upscayl-lite-4x.$ext"
  [ -s "$f" ] || curl -fL --progress-bar -o "$f" "https://raw.githubusercontent.com/upscayl/upscayl/main/resources/models/upscayl-lite-4x.$ext"
done
echo "Real-ESRGAN ready"

say "Tracking models (MediaPipe, run in the browser)"
MODELS="$ROOT/frontend/public/models"
mkdir -p "$MODELS"
fetch() { [ -s "$MODELS/$2" ] || curl -fL --progress-bar -o "$MODELS/$2" "$1"; }
fetch https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite efficientdet_lite0.tflite
fetch https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite blaze_face_short_range.tflite

say "Frontend packages"
(cd frontend && npm install --no-fund --no-audit)
mkdir -p frontend/public/mediapipe
cp frontend/node_modules/@mediapipe/tasks-vision/wasm/* frontend/public/mediapipe/
echo "MediaPipe runtime copied"

say "Backend"
(cd backend && go build -o ../bin/reframe .)
echo "Built bin/reframe"

say "All set. Start the app with: make dev   (or: make run)"
