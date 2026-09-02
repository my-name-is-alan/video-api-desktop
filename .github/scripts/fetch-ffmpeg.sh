#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="$root/src-tauri/binaries"
mkdir -p "$bin"

triple="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$triple" ]]; then
  echo "could not detect rustc host triple" >&2
  exit 1
fi

tmp="${RUNNER_TEMP:-${TEMP:-/tmp}}"
os="$(uname -s)"

case "$os" in
  MINGW*|MSYS*|CYGWIN*)
    zip="$tmp/ffmpeg-essentials.zip"
    curl -L --fail -o "$zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    rm -rf "$tmp/ffmpeg-essentials"
    unzip -qo "$zip" -d "$tmp/ffmpeg-essentials"
    ffmpeg="$(find "$tmp/ffmpeg-essentials" -name ffmpeg.exe -type f | head -n 1)"
    ffprobe="$(find "$tmp/ffmpeg-essentials" -name ffprobe.exe -type f | head -n 1)"
    if [[ -z "$ffmpeg" || -z "$ffprobe" ]]; then
      echo "ffmpeg.exe / ffprobe.exe missing from zip" >&2
      exit 1
    fi
    cp "$ffmpeg" "$bin/ffmpeg-${triple}.exe"
    cp "$ffprobe" "$bin/ffprobe-${triple}.exe"
    ;;
  Darwin)
    brew install ffmpeg
    prefix="$(brew --prefix ffmpeg)"
    cp "$prefix/bin/ffmpeg" "$bin/ffmpeg-${triple}"
    cp "$prefix/bin/ffprobe" "$bin/ffprobe-${triple}"
    chmod +x "$bin/ffmpeg-${triple}" "$bin/ffprobe-${triple}"
    ;;
  *)
    echo "unsupported OS for ffmpeg sidecar: $os" >&2
    exit 1
    ;;
esac

ls -lh "$bin"
