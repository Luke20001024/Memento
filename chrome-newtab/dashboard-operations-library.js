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
  // Web Locks are scoped to the extension origin, so every Memento tab must
  // use this exact, stable name for archive mutations.
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

  async function readMarkdownFiles(dirHandle, options = {}) {
    const files = [];
    const issues = [];
    let issue = '';
    let iterator;

    try {
      iterator = dirHandle.entries()[Symbol.asyncIterator]();
    } catch (error) {
      const kind = errorKind(error);
      if (kind === 'permission' || kind === 'missing') throw error;
      return {
        files,
        issues,
        issue: 'Chrome 无法开始扫描每日记录目录。',
      };
    }

    while (true) {
      let next;
      try {
        next = await iterator.next();
      } catch (error) {
        const kind = errorKind(error);
        if (kind === 'permission' || kind === 'missing') throw error;
        issue = 'Chrome 无法继续扫描每日记录目录。';
        break;
      }

      if (next.done) break;
      const [name, entry] = next.value;
      if (entry.kind !== 'file' || !DAILY_MARKDOWN_RE.test(name)) continue;
      notifyProgress(options.onProgress, { phase: 'file', name, count: files.length });

      try {
        // File System Access promises cannot be cancelled.  Await the browser
        // directly instead of racing them against a wall-clock timer: a late
        // but healthy response must not turn the rest of the directory into a
        // false partial-load error.
        const file = await entry.getFile();
        const bytes = await file.arrayBuffer();
        const text = new TextDecoder().decode(bytes);
        files.push({
          name,
          date: name.replace(/\.md$/, ''),
          mtime: file.lastModified,
          text,
          bytes,
        });
      } catch (error) {
        const kind = errorKind(error);
        // File System Access 的 NotAllowed/Security 通常代表根目录授权已失效，
        // 不能伪装成若干个单文件警告。
        if (kind === 'permission') throw error;
        issues.push({ name, kind, error });
      }
    }

    files.sort((a, b) => b.date.localeCompare(a.date));
    issues.sort((a, b) => a.name.localeCompare(b.name));
    return { files, issues, issue };
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
    createSerialQueue,
    errorKind,
    isArchiveHtmlName,
    loadWhilePersisting,
    readMarkdownFiles,
    uniqueArchiveName,
    withArchiveMutationLock,
  };
});
