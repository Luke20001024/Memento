#!/bin/bash

set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/memento-capture-lifecycle.XXXXXX")
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

VOICE_SOURCE="$ROOT/voice-capture/MementoVoiceCapture.swift"
SNAPSHOT_SOURCE="$ROOT/snapshot-capture/MementoDailySnapshot.swift"
VOICE_TEST="$TMP_ROOT/MementoVoiceCaptureSelfTest"
SNAPSHOT_TEST="$TMP_ROOT/MementoDailySnapshotSelfTest"

# 产品构建配置必须先通过 Swift 并发与框架类型检查。
swiftc -typecheck -swift-version 6 -warnings-as-errors -strict-concurrency=complete -parse-as-library \
  "$VOICE_SOURCE" \
  -framework AppKit -framework AVFoundation -framework Speech
swiftc -typecheck -swift-version 6 -warnings-as-errors -strict-concurrency=complete -parse-as-library \
  "$SNAPSHOT_SOURCE" \
  -framework AppKit -framework AVFoundation -framework CoreLocation

# 同源自测验证：不响应 cancellation 的任务也会按时返回；超时子进程会被终止；
# stderr 不会因 Pipe 回压死锁；语音失败恢复使用 700 目录与 600 文件并原子发布。
swiftc -O -swift-version 6 -warnings-as-errors -strict-concurrency=complete \
  -parse-as-library -D MEMENTO_VOICE_SELF_TEST \
  "$VOICE_SOURCE" -o "$VOICE_TEST" \
  -framework AppKit -framework AVFoundation -framework Speech
VOICE_OUTPUT=$("$VOICE_TEST")
grep -q 'voice capture timeout and process termination self-test' <<< "$VOICE_OUTPUT"
grep -q 'voice capture timeout kills descendant process group self-test' <<< "$VOICE_OUTPUT"
grep -q 'voice recovery permissions and atomic publication self-test' <<< "$VOICE_OUTPUT"

swiftc -O -swift-version 6 -warnings-as-errors -strict-concurrency=complete \
  -parse-as-library -D MEMENTO_SNAPSHOT_SELF_TEST \
  "$SNAPSHOT_SOURCE" -o "$SNAPSHOT_TEST" \
  -framework AppKit -framework AVFoundation -framework CoreLocation
SNAPSHOT_OUTPUT=$("$SNAPSHOT_TEST")
grep -q 'snapshot timeout and process termination self-test' <<< "$SNAPSHOT_OUTPUT"
grep -q 'snapshot timeout kills descendant process group self-test' <<< "$SNAPSHOT_OUTPUT"

# 静态合同防止以后绕回无界 waitUntilExit 或遗漏清理/重入提示。
if rg -q 'waitUntilExit\(' "$VOICE_SOURCE" "$SNAPSHOT_SOURCE"; then
  echo 'capture app reintroduced an unbounded Process.waitUntilExit()' >&2
  exit 1
fi
rg -q 'defer \{' "$VOICE_SOURCE"
rg -q 'applicationShouldHandleReopen' "$VOICE_SOURCE"
rg -q 'after: \.seconds\(90\)' "$VOICE_SOURCE"
rg -q 'timeout: \.seconds\(20\)' "$VOICE_SOURCE"
rg -q 'request.timeoutInterval = 6' "$SNAPSHOT_SOURCE"
rg -q 'Task.sleep\(for: \.seconds\(15\)\)' "$SNAPSHOT_SOURCE"
rg -q 'operationName: "启动摄像头"' "$SNAPSHOT_SOURCE"
rg -q 'timeout: \.seconds\(15\)' "$SNAPSHOT_SOURCE"
for source in "$VOICE_SOURCE" "$SNAPSHOT_SOURCE"; do
  rg -q 'POSIX_SPAWN_SETPGROUP' "$source"
  rg -q 'POSIX_SPAWN_CLOEXEC_DEFAULT' "$source"
  rg -q 'Darwin\.kill\(-pid, SIGTERM\)' "$source"
  rg -q 'Darwin\.kill\(-pid, SIGKILL\)' "$source"
  rg -q 'Darwin\.waitpid' "$source"
done

echo '✓ capture lifecycle: bounded native operations, terminated process groups, private voice recovery'
