#!/bin/bash

set -euo pipefail

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TODAY="${MEMENTO_CYCLE_TODAY:-$(TZ=Asia/Shanghai date +%F)}"
MODE="${1:-all}"

case "$MODE" in
  all|previous) ;;
  *)
    echo "用法: $0 [all|previous]" >&2
    exit 2
    ;;
esac

NORMALIZED_TODAY=$(date -j -f '%Y-%m-%d' "$TODAY" '+%Y-%m-%d' 2>/dev/null || true)
if [ "$NORMALIZED_TODAY" != "$TODAY" ]; then
  echo "无效日期: $TODAY" >&2
  exit 2
fi

PREVIOUS=$(date -j -f '%Y-%m-%d' -v-1d "$TODAY" '+%F')

value_for() {
  local key="$1"
  local body="$2"
  printf '%s\n' "$body" | sed -n "s/^${key}=//p" | head -1
}

emit_item() {
  local role="$1"
  local target_date="$2"
  local output exit_code status action source_file review_file prompt_file source_hash source_mock status_file message

  set +e
  output=$(MEMENTO_VAULT="$VAULT" "$SCRIPT_DIR/review_status.sh" "$target_date" 2>&1)
  exit_code=$?
  set -e

  status=$(value_for STATUS "$output")
  source_file=$(value_for SOURCE_FILE "$output")
  review_file=$(value_for REVIEW_FILE "$output")
  prompt_file=$(value_for PROMPT_FILE "$output")
  source_hash=$(value_for SOURCE_HASH "$output")
  source_mock=$(value_for SOURCE_MOCK "$output")
  status_file="$VAULT/.review/status/$target_date.json"
  message=''

  case "$status" in
    missing_source|up_to_date)
      action='skip'
      ;;
    needs_generation)
      action='generate'
      ;;
    missing_prompt)
      action='blocked'
      message='缺少 comprehensive Prompt，无法生成 Daily Review'
      ;;
    *)
      status='check_failed'
      action='blocked'
      message="$output"
      ;;
  esac

  /usr/bin/osascript -l JavaScript - \
    "$role" "$target_date" "$status" "$action" "$exit_code" \
    "$source_file" "$review_file" "$prompt_file" "$source_hash" \
    "$source_mock" "$status_file" "$message" <<'JXA'
function run(argv) {
  return JSON.stringify({
    kind: 'review_cycle_item',
    role: argv[0],
    date: argv[1],
    status: argv[2],
    action: argv[3],
    exit_code: Number(argv[4]),
    source_file: argv[5],
    review_file: argv[6],
    prompt_file: argv[7],
    source_hash: argv[8],
    source_mock: argv[9] === 'true',
    status_file: argv[10],
    message: argv[11]
  });
}
JXA

  case "$action" in
    generate) GENERATE_COUNT=$((GENERATE_COUNT + 1)) ;;
    blocked) BLOCKED_COUNT=$((BLOCKED_COUNT + 1)) ;;
  esac
}

GENERATE_COUNT=0
BLOCKED_COUNT=0
CHECKED_COUNT=0

# 晚间默认按“昨天 → 今天”输出；晨间 previous 模式只复核昨天，避免过早总结今天。
emit_item previous "$PREVIOUS"
CHECKED_COUNT=$((CHECKED_COUNT + 1))
if [ "$MODE" = "all" ]; then
  emit_item today "$TODAY"
  CHECKED_COUNT=$((CHECKED_COUNT + 1))
fi

/usr/bin/osascript -l JavaScript - \
  "$TODAY" "$CHECKED_COUNT" "$GENERATE_COUNT" "$BLOCKED_COUNT" <<'JXA'
function run(argv) {
  return JSON.stringify({
    kind: 'review_cycle_summary',
    today: argv[0],
    checked: Number(argv[1]),
    generation_needed: Number(argv[2]),
    blocked: Number(argv[3])
  });
}
JXA
