#!/bin/bash

set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

VAULT="$TMP_ROOT/vault with spaces"
mkdir -p "$VAULT/.chrome-newtab" "$VAULT/Reviews/Daily"

printf "const MEMENTO_STYLES = [{ id: 'comprehensive', text: 'test' }];\n" \
  > "$VAULT/.chrome-newtab/prompts.js"
printf '# 2026-07-12\n\n## 20:00 · 记录\n\n昨天。\n' > "$VAULT/2026-07-12.md"
printf '# 2026-07-13\n\n## 20:00 · 记录\n\n今天。\n' > "$VAULT/2026-07-13.md"

PREVIOUS_HASH=$(shasum -a 256 "$VAULT/2026-07-12.md" | awk '{print $1}')
printf '%s\n' \
  '---' \
  'date: 2026-07-12' \
  'type: memento-review' \
  "source_hash: \"$PREVIOUS_HASH\"" \
  '---' \
  '# Daily Review · 2026-07-12' \
  > "$VAULT/Reviews/Daily/2026-07-12.md"

CYCLE_OUTPUT="$TMP_ROOT/cycle.ndjson"
MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" "$VAULT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [outputPath, vault] = process.argv.slice(2);
const rows = fs.readFileSync(outputPath, 'utf8').trim().split('\n').map(JSON.parse);

assert.equal(rows.length, 3);
assert.deepEqual(rows.slice(0, 2).map(row => row.role), ['previous', 'today']);

assert.equal(rows[0].date, '2026-07-12');
assert.equal(rows[0].status, 'up_to_date');
assert.equal(rows[0].action, 'skip');
assert.equal(rows[0].exit_code, 0);
assert.equal(rows[0].status_file, `${vault}/.review/status/2026-07-12.json`);

assert.equal(rows[1].date, '2026-07-13');
assert.equal(rows[1].status, 'needs_generation');
assert.equal(rows[1].action, 'generate');
assert.equal(rows[1].exit_code, 0);
assert.match(rows[1].source_hash, /^[a-f0-9]{64}$/);

assert.equal(rows[2].kind, 'review_cycle_summary');
assert.equal(rows[2].checked, 2);
assert.equal(rows[2].generation_needed, 1);
assert.equal(rows[2].blocked, 0);
NODE

MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" previous > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.length, 2);
assert.equal(rows[0].role, 'previous');
assert.equal(rows[1].kind, 'review_cycle_summary');
assert.equal(rows[1].checked, 1);
NODE

rm "$VAULT/2026-07-13.md"
MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows[1].status, 'missing_source');
assert.equal(rows[1].action, 'skip');
assert.equal(rows[1].exit_code, 3);
assert.equal(rows[2].generation_needed, 0);
NODE

rm "$VAULT/.chrome-newtab/prompts.js"
MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows[0].status, 'missing_prompt');
assert.equal(rows[0].action, 'blocked');
assert.equal(rows[0].exit_code, 4);
assert.match(rows[0].message, /Prompt/);
assert.equal(rows[2].blocked, 1);
NODE

MESSAGE=$'模型返回 "no"\n稍后重试\\一次'
STATE_OUTPUT=$(MEMENTO_VAULT="$VAULT" MEMENTO_STATUS_NOW=2026-07-13T21:01:02+0800 \
  bash "$ROOT/daily-review/review_state.sh" 2026-07-12 failed "$MESSAGE")

node - "$VAULT/.review/status/2026-07-12.json" "$STATE_OUTPUT" "$MESSAGE" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [statusPath, stdoutJson, expectedMessage] = process.argv.slice(2);
const fromFile = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
const fromStdout = JSON.parse(stdoutJson);

assert.deepEqual(fromFile, fromStdout);
assert.deepEqual(fromFile, {
  date: '2026-07-12',
  status: 'failed',
  updated_at: '2026-07-13T21:01:02+08:00',
  message: expectedMessage,
});
NODE

MEMENTO_VAULT="$VAULT" MEMENTO_STATUS_NOW=2026-07-13T21:02:00+08:00 \
  bash "$ROOT/daily-review/review_state.sh" 2026-07-12 success >/dev/null

node - "$VAULT/.review/status/2026-07-12.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(state.status, 'success');
assert.equal(state.message, 'Daily Review 校验通过');
NODE

if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/review_state.sh" \
  2026-07-12 waiting >/dev/null 2>&1; then
  echo 'review_state.sh accepted an unsupported status' >&2
  exit 1
fi

if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/review_state.sh" \
  2026-02-31 failed >/dev/null 2>&1; then
  echo 'review_state.sh accepted a normalized but invalid calendar date' >&2
  exit 1
fi

if find "$VAULT/.review/status" -name '*.tmp' -o -name '.*.json.*' | grep -q .; then
  echo 'review_state.sh left a temporary file behind' >&2
  exit 1
fi

echo '✓ daily review recovery: checks previous/today and writes atomic Dashboard states'
