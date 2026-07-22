#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

VERSION=$(python3 -c 'import json; print(json.load(open("chrome-newtab/manifest.json", encoding="utf-8"))["version"])')

rg -qF "当前版本：**v${VERSION}**" README.md
rg -qF "cd Memento-v${VERSION}" README.md INSTALL_WITH_AI.md
rg -qF "v${VERSION} ·" chrome-newtab/dashboard.html
rg -qF 'INSTALL_WITH_AI.md \' scripts/package_release.sh
rg -qF 'releases/latest/download/Memento-macOS.zip' README.md INSTALL_WITH_AI.md
rg -qF 'Obsidian、Codex 都不是基础记录的前置条件' README.md
rg -qF 'Obsidian 与 Codex 缺失不阻塞基础安装' INSTALL_WITH_AI.md

echo "✓ release contract: README, AI guide, dashboard and package agree on v${VERSION}"
