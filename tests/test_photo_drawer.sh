#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

node --check chrome-newtab/dashboard.js
node --check chrome-newtab/photo-library.js
node --check chrome-newtab/daily-summary-library.js
node tests/test_photo_library.js
node tests/test_daily_summary_library.js
python3 -m json.tool chrome-newtab/manifest.json >/dev/null
python3 - <<'PY'
from html.parser import HTMLParser

class ContractParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.controls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.append(attrs["id"])
        if attrs.get("aria-controls"):
            self.controls.append(attrs["aria-controls"])

parser = ContractParser()
with open("chrome-newtab/dashboard.html", encoding="utf-8") as handle:
    parser.feed(handle.read())

assert len(parser.ids) == len(set(parser.ids)), "dashboard.html contains duplicate ids"
assert set(parser.controls).issubset(set(parser.ids)), "aria-controls points to a missing drawer"

with open("chrome-newtab/dashboard.css", encoding="utf-8") as handle:
    css = handle.read()
assert css.count("{") == css.count("}"), "dashboard.css has unbalanced blocks"
PY

rg -q 'id="daily-summary-tab"' chrome-newtab/dashboard.html
rg -q 'id="daily-summary-drawer"' chrome-newtab/dashboard.html
rg -q 'src="photo-library.js"' chrome-newtab/dashboard.html
rg -q 'src="daily-summary-library.js"' chrome-newtab/dashboard.html
rg -q 'function renderDailySummaryList' chrome-newtab/dashboard.js
rg -q '^\.day-card \{' chrome-newtab/dashboard.css
rg -q 'Reviews.*Daily' chrome-newtab/dashboard.js
rg -Fq "getDirectoryHandle('status')" chrome-newtab/dashboard.js
rg -q "text: '待总结'" chrome-newtab/dashboard.js
rg -q "text: '总结已更新'" chrome-newtab/dashboard.js
rg -q "text: '记录有更新'" chrome-newtab/dashboard.js
rg -q "text: '生成失败'" chrome-newtab/dashboard.js
rg -Fq '请在 ~/AISecretary 中为 Memento 补跑 ${dayKey} 的 Daily Review' chrome-newtab/dashboard.js
rg -q 'data-review-rerun' chrome-newtab/dashboard.js
rg -q '^\.day-review-rerun \{' chrome-newtab/dashboard.css
rg -q 'sourceHash' chrome-newtab/daily-summary-library.js
rg -q '"version": "0.8.1"' chrome-newtab/manifest.json

echo "✓ daily summary drawer: photo + review pairing, HTML, CSS and extension contract"
