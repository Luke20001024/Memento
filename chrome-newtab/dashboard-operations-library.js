// Memento · Dashboard 可测试操作层
// 把文件读取降级、归档命名和“加载与持久化并行”从 DOM 中拆出。

(function exposeDashboardOperations(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MementoDashboardOperations = api;
})(typeof window !== 'undefined' ? window : globalThis, function createDashboardOperations() {
  'use strict';

  const DAILY_MARKDOWN_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
  const ARCHIVE_HTML_RE = /\.html?$/i;
  const CORE_READ_CONCURRENCY = 4;
  // The initial probe is non-queued: one page owns the four-worker pool while
  // every other page immediately becomes a follower.
  const CORE_REFRESH_LOCK_NAME = 'memento.dashboard.core-refresh.v1';
  // Web Locks are scoped to the extension origin, so every Memento tab must
  // use this exact, stable historical name for directory-selection commits
  // and archive mutations. Keeping the value also protects mixed-version tabs.
  const ARCHIVE_MUTATION_LOCK_NAME = 'memento.archive.mutation';

  function errorKind(error) {
    if (!error) return 'unknown';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'permission';
    if (error.name === 'NotFoundError' || error.name === 'InvalidStateError') return 'missing';
    return 'other';
  }

  function notifyProgress(callback, detail) {
    if (typeof callback !== 'function') return;
    try {
      callback(detail);
    } catch (error) {
      console.warn('无法更新文件读取进度', error);
    }
  }

  function dailyEntryOrder(todayName) {
    return (left, right) => {
      if (left.name === todayName && right.name !== todayName) return -1;
      if (right.name === todayName && left.name !== todayName) return 1;
      return right.name.localeCompare(left.name);
    };
  }

  function shouldRetryFileSnapshot(error) {
    return Boolean(error && (error.name === 'NotReadableError' || error.name === 'NotFoundError'));
  }

  async function readMarkdownEntry(dirHandle, initialEntry, name) {
    // A File becomes unreadable if the underlying file changes after
    // getFile(). Resolve a fresh child handle from the parent directory, then
    // acquire one fresh snapshot inside the same worker slot. Never race a
    // pending request or retry a permission/unknown failure.
    let entry = initialEntry;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await entry.getFile();
        const bytes = await file.arrayBuffer();
        return {
          name,
          date: name.replace(/\.md$/, ''),
          mtime: file.lastModified,
          text: new TextDecoder().decode(bytes),
          bytes,
        };
      } catch (error) {
        if (attempt === 0 && shouldRetryFileSnapshot(error)) {
          // FileSystemDirectoryHandle always exposes getFileHandle. Keeping
          // the guard makes partial test/polyfill implementations fail with
          // the original useful file error rather than an unrelated TypeError.
          if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') throw error;
          entry = await dirHandle.getFileHandle(name);
          continue;
        }
        throw error;
      }
    }
    throw new Error('无法读取每日记录文件');
  }

  async function readMarkdownFiles(dirHandle, options = {}) {
    const files = [];
    const issues = [];
    let issue = '';
    let iterator;
    let enumerationDone = false;
    const isCurrent = typeof options.isCurrent === 'function'
      ? options.isCurrent
      : () => true;

    try {
      iterator = dirHandle.entries()[Symbol.asyncIterator]();
    } catch (error) {
      const kind = errorKind(error);
      if (kind === 'permission' || kind === 'missing') throw error;
      return {
        files,
        issues,
        issue: 'Chrome 无法开始扫描每日记录目录。',
        coverage: {
          enumerationDone: false,
          discoveredCount: 0,
          completedCount: 0,
          complete: false,
        },
      };
    }

    const entries = [];
    while (true) {
      if (!isCurrent()) break;
      let next;
      try {
        next = await iterator.next();
      } catch (error) {
        const kind = errorKind(error);
        if (kind === 'permission' || kind === 'missing') throw error;
        issue = 'Chrome 无法继续扫描每日记录目录。';
        break;
      }

      if (next.done) {
        enumerationDone = true;
        break;
      }
      if (!isCurrent()) break;
      const [name, entry] = next.value;
      if (entry.kind !== 'file' || !DAILY_MARKDOWN_RE.test(name)) continue;
      entries.push({ name, entry });
    }

    const todayName = options.todayDate ? `${options.todayDate}.md` : '';
    entries.sort(dailyEntryOrder(todayName));

    let cursor = 0;
    let completedCount = 0;
    let fatalError = null;

    async function worker() {
      while (true) {
        // Once a root permission failure is observed, no worker may dequeue a
        // replacement. Already-started File System Access promises still have
        // to settle because the browser offers no reliable cancellation.
        if (fatalError || !isCurrent()) return;
        const index = cursor++;
        if (index >= entries.length) return;

        const { name, entry } = entries[index];
        let fileRecord = null;
        try {
          const candidate = await readMarkdownEntry(dirHandle, entry, name);
          if (isCurrent()) {
            fileRecord = candidate;
            files.push(fileRecord);
          }
        } catch (error) {
          const kind = errorKind(error);
          if (kind === 'permission') {
            if (!fatalError) fatalError = error;
          } else {
            issues.push({ name, kind, error });
          }
        } finally {
          completedCount += 1;
          const detail = {
            phase: 'file',
            name,
            count: completedCount,
            completedCount,
            discoveredCount: entries.length,
            ok: Boolean(fileRecord),
          };
          notifyProgress(options.onProgress, detail);
          if (fileRecord) {
            notifyProgress(options.onFile, {
              file: fileRecord,
              isToday: name === todayName,
              completedCount,
              discoveredCount: entries.length,
            });
          }
        }
      }
    }

    const workerCount = Math.min(CORE_READ_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    // Do not reject early: Promise.all above proves every physical request
    // started by this pool has actually settled before the caller releases its
    // global scan lock.
    if (fatalError) throw fatalError;

    files.sort((a, b) => b.date.localeCompare(a.date));
    issues.sort((a, b) => a.name.localeCompare(b.name));
    const complete = enumerationDone && completedCount === entries.length && issues.length === 0;
    return {
      files,
      issues,
      issue,
      coverage: {
        enumerationDone,
        discoveredCount: entries.length,
        completedCount,
        complete,
      },
    };
  }

  async function coordinateCoreRefresh(lockManager, producer) {
    if (typeof producer !== 'function') throw new TypeError('核心刷新 producer 必须是函数');

    const runLocal = async lockError => {
      const value = await producer({ role: 'local', shared: false });
      return {
        role: 'local',
        shared: false,
        value,
        ...(lockError ? { lockError } : {}),
      };
    };

    if (!lockManager || typeof lockManager.request !== 'function') return runLocal();

    let callbackEntered = false;
    try {
      return await lockManager.request(
        CORE_REFRESH_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true },
        async lock => {
          callbackEntered = true;
          if (!lock) return { role: 'follower', shared: true };
          const value = await producer({ role: 'leader', shared: true });
          return { role: 'leader', shared: true, value };
        }
      );
    } catch (error) {
      // A failure before the callback proves that no producer was started, so
      // one local attempt is safe. Once entered, retrying would duplicate a
      // potentially still-running File System Access operation.
      if (!callbackEntered) return runLocal(error);
      throw error;
    }
  }

  function isArchiveHtmlName(name) {
    return ARCHIVE_HTML_RE.test(String(name || ''));
  }

  function uniqueArchiveName(requestedName, existingNames) {
    const name = String(requestedName || '');
    if (!isArchiveHtmlName(name)) return '';

    const occupied = new Set([...existingNames || []].map(value => String(value).toLocaleLowerCase()));
    if (!occupied.has(name.toLocaleLowerCase())) return name;

    const match = name.match(/^(.*?)(\.html?)$/i);
    const stem = match[1];
    const extension = match[2];
    let copy = 2;
    let candidate = '';
    do {
      candidate = `${stem} (${copy})${extension}`;
      copy++;
    } while (occupied.has(candidate.toLocaleLowerCase()));
    return candidate;
  }

  function createSerialQueue() {
    let tail = Promise.resolve();
    return task => {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
  }

  function notSupportedError(message) {
    // DOMException is not available in every test/runtime environment.  The
    // name is the interoperable part callers use to distinguish fail-closed
    // behavior from a file-system failure.
    const error = new Error(message);
    error.name = 'NotSupportedError';
    return error;
  }

  async function withArchiveMutationLock(lockManager, task) {
    if (!lockManager || typeof lockManager.request !== 'function') {
      throw notSupportedError('此浏览器不支持安全的跨标签页归档锁');
    }
    if (typeof task !== 'function') throw new TypeError('归档锁任务必须是函数');

    return lockManager.request(
      ARCHIVE_MUTATION_LOCK_NAME,
      { mode: 'exclusive' },
      () => task()
    );
  }

  async function loadWhilePersisting(handle, { load, persist }) {
    const persistencePromise = Promise.resolve()
      .then(() => persist(handle))
      .then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error })
      );

    // 先调用 load，不让 IndexedDB 的写入状态阻塞当前已授权目录。
    const loadResult = await load(handle);
    return { loadResult, persistence: await persistencePromise };
  }

  return {
    ARCHIVE_MUTATION_LOCK_NAME,
    CORE_READ_CONCURRENCY,
    CORE_REFRESH_LOCK_NAME,
    coordinateCoreRefresh,
    createSerialQueue,
    errorKind,
    isArchiveHtmlName,
    loadWhilePersisting,
    readMarkdownFiles,
    uniqueArchiveName,
    withArchiveMutationLock,
  };
});
