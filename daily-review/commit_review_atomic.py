#!/usr/bin/env python3
"""Crash-safe, fail-closed CAS commit for one Daily Review."""

from __future__ import annotations

import ctypes
import errno
import fcntl
import hashlib
import os
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path


ABSENT = "__MEMENTO_REVIEW_ABSENT__"
EXIT_USAGE = 2
EXIT_VERIFY = 8
EXIT_CONFLICT = 75
EXIT_IO = 74
RENAME_SWAP = 0x00000002
RENAME_EXCL = 0x00000004


def eprint(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def regular_identity(path: Path) -> tuple[int, int]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"不是普通文件: {path}")
    return info.st_dev, info.st_ino


def same_regular_file(first: Path, second: Path) -> bool:
    try:
        return regular_identity(first) == regular_identity(second)
    except (FileNotFoundError, ValueError):
        return False


def hash_regular(path: Path) -> tuple[str, tuple[int, int]]:
    before = regular_identity(path)
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        opened_identity = (opened.st_dev, opened.st_ino)
        if not stat.S_ISREG(opened.st_mode) or opened_identity != before:
            raise RuntimeError(f"文件在读取前发生变化: {path}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino) != opened_identity:
            raise RuntimeError(f"文件在读取时发生替换: {path}")
        return digest.hexdigest(), opened_identity
    finally:
        os.close(descriptor)


def fsync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def unique_recovery_path(recovery_dir: Path, date: str, label: str) -> Path:
    stamp = time.strftime("%Y%m%dT%H%M%S", time.localtime())
    return recovery_dir / f"{date}.{label}.{stamp}.{os.getpid()}.{uuid.uuid4().hex}.md"


def hardlink_recovery(source: Path, recovery_dir: Path, date: str, label: str) -> Path:
    destination = unique_recovery_path(recovery_dir, date, label)
    os.link(source, destination, follow_symlinks=False)
    os.chmod(destination, 0o600)
    fsync_directory(recovery_dir)
    return destination


def unlink_if_exists(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def renamex(source: Path, destination: Path, flags: int) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        function = libc.renamex_np
    except AttributeError as error:
        raise OSError(errno.ENOSYS, "系统不支持 renamex_np") from error
    function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(os.fsencode(source), os.fsencode(destination), flags)
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), str(source), str(destination))


def run_verifier(verifier: Path, vault: Path, date: str, review: Path) -> bool:
    environment = os.environ.copy()
    environment["MEMENTO_VAULT"] = str(vault)
    result = subprocess.run(
        [str(verifier), date, str(review)],
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode == 0:
        return True
    detail = result.stderr.strip() or result.stdout.strip() or "未知校验错误"
    eprint(detail)
    return False


def supplement_payload(path: Path) -> bytes | None:
    marker = b"## \xe6\x88\x91\xe7\x9a\x84\xe8\xa1\xa5\xe5\x85\x85"
    lines = path.read_bytes().splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.rstrip(b"\r\n") == marker:
            return b"".join(lines[index + 1 :])
    return None


def meaningful(payload: bytes | None) -> bool:
    return payload is not None and bool(payload.strip())


def rollback_swap_if_owned(
    temporary: Path,
    target: Path,
    generated_guard: Path,
) -> bool:
    # 只在正式路径仍指向本次候选 inode 时回滚；若用户已再次替换正式路径，
    # 绝不覆盖该新版本，所有已知 inode 都由 recovery hard-link 兜底。
    if not same_regular_file(target, generated_guard) or not temporary.exists():
        return False
    try:
        renamex(temporary, target, RENAME_SWAP)
    except OSError:
        return False
    return same_regular_file(temporary, generated_guard)


def conflict(message: str, temporary: Path, recoveries: list[Path]) -> int:
    eprint(f"Daily Review 提交冲突: {message}")
    if temporary.exists():
        eprint(f"候选/恢复文件已保留: {temporary}")
    for recovery in recoveries:
        if recovery.exists():
            eprint(f"恢复副本已保留: {recovery}")
    eprint(f"退出码 {EXIT_CONFLICT}；请重新读取 review_status.sh 后再生成，当前正式 Review 未被静默覆盖。")
    return EXIT_CONFLICT


def commit_absent(
    vault: Path,
    date: str,
    temporary: Path,
    target: Path,
    verifier: Path,
    candidate_hash: str,
    generated_guard: Path,
) -> int:
    if target.exists() or target.is_symlink():
        unlink_if_exists(generated_guard)
        return conflict("生成起点不存在，但正式 Review 已出现", temporary, [])

    try:
        renamex(temporary, target, RENAME_EXCL)
    except OSError as error:
        unlink_if_exists(generated_guard)
        if error.errno == errno.EEXIST:
            return conflict("正式 Review 在生成期间被创建", temporary, [])
        eprint(f"Daily Review 原子创建失败: {error}")
        return EXIT_IO

    if not same_regular_file(target, generated_guard):
        return conflict("原子创建后正式路径又被替换", temporary, [generated_guard])

    final_hash, _ = hash_regular(target)
    if final_hash != candidate_hash or not run_verifier(verifier, vault, date, target):
        # 正式路径仍属于本次候选时，RENAME_EXCL 将它安全移回原临时路径；
        # 若用户已替换正式路径，则保留用户版本和 generated recovery，不作覆盖。
        if same_regular_file(target, generated_guard) and not temporary.exists():
            try:
                renamex(target, temporary, RENAME_EXCL)
            except OSError:
                pass
        return conflict("最终严格校验失败，候选已保留", temporary, [generated_guard])

    fsync_file(target)
    fsync_directory(target.parent)
    unlink_if_exists(generated_guard)
    print(f"Daily Review 原子提交成功: {target}")
    return 0


def commit_existing(
    vault: Path,
    date: str,
    temporary: Path,
    target: Path,
    verifier: Path,
    expected_hash: str,
    candidate_hash: str,
    generated_guard: Path,
    recovery_dir: Path,
) -> int:
    try:
        target_hash, target_identity = hash_regular(target)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        unlink_if_exists(generated_guard)
        return conflict(str(error), temporary, [])

    if target_hash != expected_hash:
        unlink_if_exists(generated_guard)
        return conflict("正式 Review 的内容已在生成期间变化", temporary, [])
    if same_regular_file(temporary, target):
        unlink_if_exists(generated_guard)
        eprint("候选文件不能与正式 Review 是同一个 inode")
        return EXIT_USAGE

    try:
        previous_guard = hardlink_recovery(target, recovery_dir, date, "previous")
    except OSError as error:
        unlink_if_exists(generated_guard)
        eprint(f"无法为当前 Review 建立恢复副本，已拒绝提交: {error}")
        return EXIT_IO

    # hard-link 建立后再次核对路径 inode 与内容。人工编辑若已经发生，正式文件不动。
    guard_hash, guard_identity = hash_regular(previous_guard)
    if (
        guard_hash != expected_hash
        or guard_identity != target_identity
        or not same_regular_file(target, previous_guard)
    ):
        unlink_if_exists(previous_guard)
        unlink_if_exists(generated_guard)
        return conflict("正式 Review 在建立提交快照时变化", temporary, [])

    old_supplement = supplement_payload(previous_guard)
    candidate_supplement = supplement_payload(temporary)
    if meaningful(old_supplement) and candidate_supplement != old_supplement:
        unlink_if_exists(previous_guard)
        unlink_if_exists(generated_guard)
        eprint("Daily Review 校验失败: 候选文件没有逐字保留现有『我的补充』")
        eprint(f"候选文件已保留: {temporary}")
        return EXIT_VERIFY

    try:
        renamex(temporary, target, RENAME_SWAP)
    except OSError as error:
        unlink_if_exists(previous_guard)
        unlink_if_exists(generated_guard)
        eprint(f"Daily Review 原子交换失败: {error}")
        return EXIT_IO

    swapped_as_expected = (
        same_regular_file(target, generated_guard)
        and same_regular_file(temporary, previous_guard)
    )
    swapped_old_hash = ""
    if swapped_as_expected:
        try:
            swapped_old_hash, _ = hash_regular(temporary)
        except (FileNotFoundError, ValueError, RuntimeError):
            swapped_as_expected = False

    if not swapped_as_expected or swapped_old_hash != expected_hash:
        rolled_back = rollback_swap_if_owned(temporary, target, generated_guard)
        if rolled_back:
            unlink_if_exists(generated_guard)
            return conflict(
                "交换点检测到人工更新，已原子回滚",
                temporary,
                [previous_guard],
            )
        return conflict(
            "交换点检测到并发路径替换；为避免覆盖用户版本未执行回滚",
            temporary,
            [previous_guard, generated_guard],
        )

    try:
        final_hash, _ = hash_regular(target)
    except (FileNotFoundError, ValueError, RuntimeError):
        final_hash = ""
    final_valid = (
        final_hash == candidate_hash
        and same_regular_file(target, generated_guard)
        and run_verifier(verifier, vault, date, target)
    )
    if final_valid:
        try:
            post_verify_hash, _ = hash_regular(target)
            final_valid = (
                post_verify_hash == candidate_hash
                and same_regular_file(target, generated_guard)
            )
        except (FileNotFoundError, ValueError, RuntimeError):
            final_valid = False
    if not final_valid:
        rolled_back = rollback_swap_if_owned(temporary, target, generated_guard)
        if rolled_back:
            unlink_if_exists(generated_guard)
            return conflict(
                "正式文件最终校验失败，已恢复提交前版本",
                temporary,
                [previous_guard],
            )
        return conflict(
            "正式文件最终校验期间又被替换；已保留全部恢复副本",
            temporary,
            [previous_guard, generated_guard],
        )

    # previous_guard 是提交点前正式文件的持久恢复链接；先留住它，再移除
    # 交换后占用原候选路径的旧链接。即使编辑器仍持有旧 inode，也不会丢数据。
    if same_regular_file(temporary, previous_guard):
        temporary.unlink()
    else:
        eprint(f"警告: 原候选路径已被其他进程替换，未删除该路径: {temporary}")
    unlink_if_exists(generated_guard)
    fsync_file(target)
    fsync_directory(target.parent)
    fsync_directory(recovery_dir)
    print(f"Daily Review 原子提交成功: {target}")
    print(f"提交前版本恢复副本: {previous_guard}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 6:
        eprint("内部用法错误: commit_review_atomic.py VAULT DATE TEMP EXPECTED_HASH VERIFY")
        return EXIT_USAGE

    vault = Path(argv[1]).expanduser().absolute()
    date = argv[2]
    temporary = Path(argv[3]).expanduser().absolute()
    expected_hash = argv[4]
    verifier = Path(argv[5]).expanduser().absolute()
    review_dir = vault / "Reviews" / "Daily"
    target = review_dir / f"{date}.md"
    # 锁不能放进安装器会整体替换的 .review 代码目录；恢复副本属于用户数据，
    # 放在默认卸载会保留的 Reviews 树中。
    lock_dir = vault / ".state" / "review-commit-locks"
    recovery_dir = vault / "Reviews" / ".recovery" / "Daily"

    try:
        review_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        recovery_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(lock_dir, 0o700)
        os.chmod(recovery_dir, 0o700)
    except OSError as error:
        eprint(f"无法创建 Review 提交目录: {error}")
        return EXIT_IO

    try:
        if temporary.parent.resolve() != review_dir.resolve():
            eprint("候选 Review 必须位于正式 Review 的同一目录")
            return EXIT_USAGE
        if temporary == target:
            eprint("候选 Review 不能使用正式文件路径")
            return EXIT_USAGE
        regular_identity(temporary)
        os.chmod(temporary, 0o600)
    except (FileNotFoundError, ValueError, OSError) as error:
        eprint(f"无效候选 Review: {error}")
        return EXIT_USAGE

    lock_path = lock_dir / f"{date}.lock"
    lock_flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        lock_flags |= os.O_NOFOLLOW
    try:
        lock_descriptor = os.open(lock_path, lock_flags, 0o600)
    except OSError as error:
        eprint(f"无法打开按日提交锁: {error}")
        return EXIT_IO

    try:
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
        try:
            candidate_hash_before, candidate_identity = hash_regular(temporary)
            fsync_file(temporary)
            if not run_verifier(verifier, vault, date, temporary):
                eprint(f"候选文件已保留: {temporary}")
                return EXIT_VERIFY
            candidate_hash, identity_after_verify = hash_regular(temporary)
            if candidate_hash != candidate_hash_before or identity_after_verify != candidate_identity:
                return conflict("候选 Review 在校验期间发生变化", temporary, [])

            generated_guard = hardlink_recovery(
                temporary, recovery_dir, date, "candidate"
            )
            if expected_hash == ABSENT:
                return commit_absent(
                    vault,
                    date,
                    temporary,
                    target,
                    verifier,
                    candidate_hash,
                    generated_guard,
                )
            return commit_existing(
                vault,
                date,
                temporary,
                target,
                verifier,
                expected_hash,
                candidate_hash,
                generated_guard,
                recovery_dir,
            )
        except (OSError, ValueError, RuntimeError) as error:
            eprint(f"Daily Review 提交失败且未宣告成功: {error}")
            return EXIT_IO
        finally:
            fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
    finally:
        os.close(lock_descriptor)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
