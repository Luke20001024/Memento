#!/bin/bash
# 把 docs/index.html + docs/Memento.png 打包成单文件 docs/index.standalone.html
# (海报以 base64 JPEG 嵌入,方便邮件 / IM 分发)
#
# 用法: cd docs && ./build-standalone.sh
# 依赖: macOS sips (系统自带) + python3

set -e
cd "$(dirname "$0")"

[ -f Memento.png ] || { echo "缺少 Memento.png"; exit 1; }
[ -f index.html ]  || { echo "缺少 index.html"; exit 1; }

# 1. PNG → JPEG q82 (1.6MB → ~330KB,肉眼无损)
TMP_JPG="${TMPDIR:-/tmp}/memento-build-$$.jpg"
trap 'rm -f "$TMP_JPG"' EXIT
sips -s format jpeg -s formatOptions 82 Memento.png --out "$TMP_JPG" >/dev/null

# 2. 嵌入 base64,生成单文件 HTML
python3 - "$TMP_JPG" <<'PY'
import base64, sys
jpg_path = sys.argv[1]
with open(jpg_path, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')
data_uri = f'data:image/jpeg;base64,{b64}'

with open('index.html') as f:
    html = f.read()
n = html.count('./Memento.png')
out = html.replace('./Memento.png', data_uri)
out = '<!-- standalone build: Memento.png embedded as base64 JPEG q82 -->\n' + out

with open('index.standalone.html', 'w') as f:
    f.write(out)

import os
size = os.path.getsize('index.standalone.html')
print(f'✓ index.standalone.html  {size/1024/1024:.2f} MB  ({n} 处替换)')
PY
