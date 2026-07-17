#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST="$ROOT/chrome-newtab/manifest.json"
OUTPUT=${1:-"$ROOT/dist/Memento-macOS.zip"}

if ! command -v python3 >/dev/null 2>&1; then
  echo '缺少 python3，无法读取发布版本。' >&2
  exit 1
fi
if ! command -v unzip >/dev/null 2>&1; then
  echo '缺少 unzip，无法校验发布包。' >&2
  exit 1
fi

cd "$ROOT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo '存在未提交的已跟踪改动；请先提交，再从确定的 HEAD 打包。' >&2
  exit 1
fi

VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$MANIFEST")
PREFIX="Memento-v${VERSION}/"
OUTPUT_DIR=$(dirname "$OUTPUT")
OUTPUT_NAME=$(basename "$OUTPUT")

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT" "$OUTPUT.sha256"

git archive \
  --format=zip \
  --prefix="$PREFIX" \
  --output="$OUTPUT" \
  HEAD -- \
  README.md \
  install_aisecretary.sh \
  uninstall_aisecretary.sh \
  chrome-newtab \
  daily-review \
  obsidian-vault \
  snapshot-capture \
  voice-capture

PACKAGED_VERSION=$(unzip -p "$OUTPUT" "${PREFIX}chrome-newtab/manifest.json" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
if [ "$PACKAGED_VERSION" != "$VERSION" ]; then
  echo "发布包版本校验失败：期望 ${VERSION}，实际 ${PACKAGED_VERSION}" >&2
  exit 1
fi

(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$OUTPUT_NAME" > "$OUTPUT_NAME.sha256"
)

echo "已生成 $OUTPUT"
echo "版本 v${VERSION}，目录前缀 ${PREFIX}"
cat "$OUTPUT.sha256"
