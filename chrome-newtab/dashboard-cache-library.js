// Memento · Dashboard Lean v1 fast-start cache
//
// The cache deliberately lives in the existing `aisecretary` version-1
// IndexedDB and `handles` object store.  Older Memento versions only read the
// `dir` key and therefore ignore the two additional records.

(function exposeDashboardCache(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MementoDashboardCache = api;
})(typeof window !== 'undefined' ? window : globalThis, function createDashboardCacheLibrary() {
  'use strict';

  const DB_NAME = 'aisecretary';
  const DB_VERSION = 1;
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'dir';
  const BINDING_KEY = 'dir-binding';
  const SNAPSHOT_KEY = 'core-snapshot';
  const CACHE_SCHEMA = 1;
  const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
  // One root daily Markdown file per day, with roughly ten years of headroom.
  // This is a cache eligibility limit only; live directory reads remain
  // unrestricted.
  const MAX_SNAPSHOT_FILES = 3660;
  const DAILY_MARKDOWN_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
  const DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function defaultOpenDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('无法打开 Dashboard 本地存储'));
    });
  }

  function safeClose(db) {
    try {
      if (db && typeof db.close === 'function') db.close();
    } catch {
      // Closing a completed/aborted test or browser connection is best effort.
    }
  }

  async function runStoreTransaction(openDB, mode, start) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let requestError = null;
      let settled = false;

      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        safeClose(db);
        if (ok) resolve(value);
        else reject(value);
      };

      const rememberRequestError = request => {
        if (!request) return request;
        const previous = request.onerror;
        request.onerror = event => {
          requestError = request.error || requestError;
          if (typeof previous === 'function') previous.call(request, event);
        };
        return request;
      };

      try {
        transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        start(store, value => { result = value; }, rememberRequestError);
      } catch (error) {
        try {
          if (transaction && typeof transaction.abort === 'function') transaction.abort();
        } catch {
          // The original synchronous error is more useful to the caller.
        }
        finish(false, error);
        return;
      }

      transaction.oncomplete = () => finish(true, result);
      const fail = () => finish(
        false,
        requestError || transaction.error || new Error('Dashboard 本地存储事务失败')
      );
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  }

  function validToken(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128;
  }

  function validTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isDirectoryHandle(value) {
    return Boolean(value
      && typeof value === 'object'
      && value.kind === 'directory'
      && typeof value.isSameEntry === 'function');
  }

  function isFutureSchema(value) {
    return Boolean(value
      && typeof value === 'object'
      && Number.isInteger(value.schema)
      && value.schema > CACHE_SCHEMA);
  }

  function validateBinding(binding) {
    return Boolean(binding
      && typeof binding === 'object'
      && binding.schema === CACHE_SCHEMA
      && validToken(binding.token)
      && isDirectoryHandle(binding.boundHandle)
      && validTimestamp(binding.createdAt));
  }

  function createBinding(handle, randomUUID, now) {
    if (!isDirectoryHandle(handle)) throw new TypeError('目录 binding 需要有效的 FileSystemDirectoryHandle');
    const token = randomUUID();
    const createdAt = now();
    if (!validToken(token)) throw new TypeError('目录 binding token 无效');
    if (!validTimestamp(createdAt)) throw new TypeError('目录 binding 时间无效');
    return {
      schema: CACHE_SCHEMA,
      token,
      boundHandle: handle,
      createdAt,
    };
  }

  function isCompleteRecordResult(recordResult) {
    return Boolean(recordResult
      && Array.isArray(recordResult.files)
      && Array.isArray(recordResult.issues)
      && recordResult.issues.length === 0
      && !recordResult.issue
      && recordResult.coverage
      && recordResult.coverage.complete === true);
  }

  function snapshotFailure(reason) {
    return { ok: false, reason };
  }

  function encodeCompleteSnapshot(bindingToken, recordResult, now = Date.now) {
    if (!validToken(bindingToken)) return snapshotFailure('invalid-binding-token');
    if (!isCompleteRecordResult(recordResult)) return snapshotFailure('incomplete');
    if (typeof recordResult.scanDate !== 'string' || !DAILY_DATE_RE.test(recordResult.scanDate)) {
      return snapshotFailure('invalid-scan-date');
    }
    if (recordResult.files.length > MAX_SNAPSHOT_FILES) return snapshotFailure('too-many-files');

    const files = [];
    const names = new Set();
    let totalBytes = 0;

    for (const file of recordResult.files) {
      if (!file || typeof file !== 'object') return snapshotFailure('invalid-file');
      if (typeof file.name !== 'string' || !DAILY_MARKDOWN_RE.test(file.name)) {
        return snapshotFailure('invalid-file-name');
      }
      if (names.has(file.name)) return snapshotFailure('duplicate-file');
      if (!validTimestamp(file.mtime)) return snapshotFailure('invalid-mtime');
      if (!(file.bytes instanceof ArrayBuffer)) return snapshotFailure('invalid-bytes');

      totalBytes += file.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SNAPSHOT_BYTES) {
        return snapshotFailure('too-large');
      }

      names.add(file.name);
      files.push({
        name: file.name,
        mtime: file.mtime,
        // Do not retain a mutable reference owned by the live session model.
        bytes: file.bytes.slice(0),
      });
    }

    const committedAt = now();
    if (!validTimestamp(committedAt)) return snapshotFailure('invalid-commit-time');
    files.sort((a, b) => b.name.localeCompare(a.name));
    return {
      ok: true,
      snapshot: {
        schema: CACHE_SCHEMA,
        complete: true,
        bindingToken,
        committedAt,
        scanDate: recordResult.scanDate,
        fileCount: files.length,
        totalBytes,
        files,
      },
    };
  }

  function validateSnapshot(snapshot, expectedToken) {
    if (isFutureSchema(snapshot)) return snapshotFailure('future-schema');
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== CACHE_SCHEMA) {
      return snapshotFailure('invalid-schema');
    }
    if (snapshot.complete !== true) return snapshotFailure('incomplete');
    if (!validToken(snapshot.bindingToken)) return snapshotFailure('invalid-binding-token');
    if (expectedToken !== undefined && snapshot.bindingToken !== expectedToken) {
      return snapshotFailure('binding-mismatch');
    }
    if (!validTimestamp(snapshot.committedAt)) return snapshotFailure('invalid-commit-time');
    if (typeof snapshot.scanDate !== 'string' || !DAILY_DATE_RE.test(snapshot.scanDate)) {
      return snapshotFailure('invalid-scan-date');
    }
    if (!Number.isInteger(snapshot.fileCount)
        || snapshot.fileCount < 0
        || snapshot.fileCount > MAX_SNAPSHOT_FILES) {
      return snapshotFailure('invalid-file-count');
    }
    if (!Number.isSafeInteger(snapshot.totalBytes)
        || snapshot.totalBytes < 0
        || snapshot.totalBytes > MAX_SNAPSHOT_BYTES) {
      return snapshotFailure('invalid-total-bytes');
    }
    if (!Array.isArray(snapshot.files) || snapshot.files.length !== snapshot.fileCount) {
      return snapshotFailure('file-count-mismatch');
    }

    const names = new Set();
    let totalBytes = 0;
    for (const file of snapshot.files) {
      if (!file || typeof file !== 'object') return snapshotFailure('invalid-file');
      if (typeof file.name !== 'string' || !DAILY_MARKDOWN_RE.test(file.name)) {
        return snapshotFailure('invalid-file-name');
      }
      if (names.has(file.name)) return snapshotFailure('duplicate-file');
      if (!validTimestamp(file.mtime)) return snapshotFailure('invalid-mtime');
      if (!(file.bytes instanceof ArrayBuffer)) return snapshotFailure('invalid-bytes');
      totalBytes += file.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SNAPSHOT_BYTES) {
        return snapshotFailure('too-large');
      }
      names.add(file.name);
    }
    if (totalBytes !== snapshot.totalBytes) return snapshotFailure('total-bytes-mismatch');
    return { ok: true };
  }

  function decodeAndValidateSnapshot(snapshot, expectedToken) {
    const validation = validateSnapshot(snapshot, expectedToken);
    if (!validation.ok) return validation;

    const decoder = new TextDecoder();
    const files = snapshot.files.map(file => ({
      name: file.name,
      date: file.name.replace(/\.md$/, ''),
      mtime: file.mtime,
      bytes: file.bytes,
      text: decoder.decode(file.bytes),
    })).sort((a, b) => b.date.localeCompare(a.date));

    return {
      ok: true,
      files,
      committedAt: snapshot.committedAt,
      scanDate: snapshot.scanDate,
      totalBytes: snapshot.totalBytes,
    };
  }

  function createRepository(options = {}) {
    const openDB = options.openDB || defaultOpenDB;
    const randomUUID = options.randomUUID
      || (() => {
        if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
          throw new Error('crypto.randomUUID is unavailable');
        }
        return globalThis.crypto.randomUUID();
      });
    const now = options.now || Date.now;
    const sameEntry = options.sameEntry || ((left, right) => left.isSameEntry(right));

    function readBootstrap() {
      return runStoreTransaction(openDB, 'readonly', (store, setResult, rememberError) => {
        const bootstrap = { handle: null, binding: null, snapshot: null };
        setResult(bootstrap);

        const handleRequest = rememberError(store.get(HANDLE_KEY));
        const bindingRequest = rememberError(store.get(BINDING_KEY));
        const snapshotRequest = rememberError(store.get(SNAPSHOT_KEY));
        handleRequest.onsuccess = () => { bootstrap.handle = handleRequest.result || null; };
        bindingRequest.onsuccess = () => { bootstrap.binding = bindingRequest.result || null; };
        snapshotRequest.onsuccess = () => { bootstrap.snapshot = snapshotRequest.result || null; };
      });
    }

    function replaceSelection(handle, binding) {
      return runStoreTransaction(openDB, 'readwrite', (store, setResult, rememberError) => {
        rememberError(store.put(handle, HANDLE_KEY));
        rememberError(store.put(binding, BINDING_KEY));
        rememberError(store.delete(SNAPSHOT_KEY));
        setResult({ binding });
      });
    }

    function prepareSelection(handle) {
      const binding = createBinding(handle, randomUUID, now);
      let persistence = null;
      let resolveContext;
      const contextPromise = new Promise(resolve => { resolveContext = resolve; });

      function startPersistence() {
        if (persistence) return persistence;

        persistence = replaceSelection(handle, binding);
        // Keep the persistence promise rejecting for the existing UI warning,
        // while the optional cache context resolves fail-closed. Attaching the
        // rejection handler here also avoids a second unhandled rejection when
        // a caller only observes the persistence result.
        persistence.then(
          () => resolveContext({
            handle,
            binding,
            cache: null,
            writable: true,
            reason: 'new-selection',
          }),
          error => resolveContext({
            handle,
            binding: null,
            cache: null,
            writable: false,
            reason: 'persistence-error',
            error,
          })
        );
        return persistence;
      }

      return {
        binding,
        startPersistence,
        contextPromise,
      };
    }

    function invalidateCurrent(expectedToken) {
      if (!validToken(expectedToken)) {
        return Promise.reject(new TypeError('缓存失效需要有效的目录 binding token'));
      }
      const nextToken = randomUUID();
      const createdAt = now();
      if (!validToken(nextToken)) return Promise.reject(new TypeError('目录 binding token 无效'));
      if (!validTimestamp(createdAt)) return Promise.reject(new TypeError('目录 binding 时间无效'));

      return runStoreTransaction(openDB, 'readwrite', (store, setResult, rememberError) => {
        const handleRequest = rememberError(store.get(HANDLE_KEY));
        const bindingRequest = rememberError(store.get(BINDING_KEY));
        let handleReady = false;
        let bindingReady = false;

        const finish = () => {
          if (!handleReady || !bindingReady) return;
          const handle = handleRequest.result || null;
          const currentBinding = bindingRequest.result || null;
          if (!validateBinding(currentBinding) || currentBinding.token !== expectedToken) {
            setResult({ invalidated: false, reason: 'binding-mismatch' });
            return;
          }

          if (!isDirectoryHandle(handle)) {
            setResult({ invalidated: false, reason: 'invalid-handle' });
            return;
          }

          const binding = {
            schema: CACHE_SCHEMA,
            token: nextToken,
            boundHandle: handle,
            createdAt,
          };
          rememberError(store.put(binding, BINDING_KEY));
          rememberError(store.delete(SNAPSHOT_KEY));
          setResult({ invalidated: true, binding });
        };

        handleRequest.onsuccess = () => { handleReady = true; finish(); };
        bindingRequest.onsuccess = () => { bindingReady = true; finish(); };
      });
    }

    function bindingExpectation(binding) {
      if (binding == null) return { kind: 'missing' };
      if (validateBinding(binding)) return { kind: 'token', token: binding.token };
      if (isFutureSchema(binding)) return { kind: 'future' };
      return { kind: 'corrupt-v1' };
    }

    function replaceBindingIfUnchanged(handle, expected) {
      const binding = createBinding(handle, randomUUID, now);
      return runStoreTransaction(openDB, 'readwrite', (store, setResult, rememberError) => {
        const request = rememberError(store.get(BINDING_KEY));
        request.onsuccess = () => {
          const current = request.result || null;
          const unchanged = expected.kind === 'missing'
            ? current == null
            : expected.kind === 'token'
              ? validateBinding(current) && current.token === expected.token
              : expected.kind === 'corrupt-v1'
                ? current != null && !validateBinding(current) && !isFutureSchema(current)
                : false;
          if (!unchanged) {
            setResult({ stored: false, binding: null, reason: 'binding-changed' });
            return;
          }
          rememberError(store.put(binding, BINDING_KEY));
          rememberError(store.delete(SNAPSHOT_KEY));
          setResult({ stored: true, binding });
        };
      });
    }

    function discardSnapshotIfCurrent(expectedToken) {
      return runStoreTransaction(openDB, 'readwrite', (store, setResult, rememberError) => {
        const bindingRequest = rememberError(store.get(BINDING_KEY));
        const snapshotRequest = rememberError(store.get(SNAPSHOT_KEY));
        let bindingReady = false;
        let snapshotReady = false;

        const finish = () => {
          if (!bindingReady || !snapshotReady) return;
          const binding = bindingRequest.result || null;
          const snapshot = snapshotRequest.result || null;
          if (!validateBinding(binding) || binding.token !== expectedToken) {
            setResult({ deleted: false, reason: 'binding-mismatch' });
            return;
          }
          if (isFutureSchema(snapshot)) {
            setResult({ deleted: false, reason: 'future-schema' });
            return;
          }
          rememberError(store.delete(SNAPSHOT_KEY));
          setResult({ deleted: true });
        };

        bindingRequest.onsuccess = () => { bindingReady = true; finish(); };
        snapshotRequest.onsuccess = () => { snapshotReady = true; finish(); };
      });
    }

    async function resolveBootstrap(handle, bootstrap) {
      if (!isDirectoryHandle(handle)) {
        return { handle, binding: null, cache: null, writable: false, reason: 'invalid-handle' };
      }
      if (!bootstrap || !isDirectoryHandle(bootstrap.handle)) {
        return { handle, binding: null, cache: null, writable: false, reason: 'missing-stored-handle' };
      }

      let currentDirectory;
      try {
        currentDirectory = await sameEntry(handle, bootstrap.handle);
      } catch {
        return { handle, binding: null, cache: null, writable: false, reason: 'identity-error' };
      }
      if (!currentDirectory) {
        return { handle, binding: null, cache: null, writable: false, reason: 'directory-mismatch' };
      }

      const expected = bindingExpectation(bootstrap.binding);
      if (expected.kind === 'future') {
        return { handle, binding: null, cache: null, writable: false, reason: 'future-binding-schema' };
      }

      let binding = validateBinding(bootstrap.binding) ? bootstrap.binding : null;
      if (binding) {
        let boundDirectory;
        try {
          boundDirectory = await sameEntry(handle, binding.boundHandle);
        } catch {
          return { handle, binding: null, cache: null, writable: false, reason: 'identity-error' };
        }
        if (!boundDirectory) binding = null;
      }

      if (!binding) {
        const replacement = await replaceBindingIfUnchanged(handle, expected);
        if (!replacement.stored) {
          return { handle, binding: null, cache: null, writable: false, reason: replacement.reason };
        }
        return {
          handle,
          binding: replacement.binding,
          cache: null,
          writable: true,
          reason: expected.kind === 'missing' ? 'binding-created' : 'binding-replaced',
        };
      }

      if (!bootstrap.snapshot) {
        return { handle, binding, cache: null, writable: true, reason: 'cache-miss' };
      }
      if (isFutureSchema(bootstrap.snapshot)) {
        return { handle, binding, cache: null, writable: false, reason: 'future-snapshot-schema' };
      }

      const decoded = decodeAndValidateSnapshot(bootstrap.snapshot, binding.token);
      if (!decoded.ok) {
        // Cleanup is part of cache recovery only.  A caller should run this
        // resolver beside, never in front of, the live scan.
        try {
          await discardSnapshotIfCurrent(binding.token);
        } catch {
          // Cache cleanup failure must not turn a valid directory into an error.
        }
        return { handle, binding, cache: null, writable: true, reason: decoded.reason };
      }

      return {
        handle,
        binding,
        cache: decoded,
        writable: true,
        reason: 'cache-hit',
      };
    }

    async function commitComplete(expectedToken, recordResult) {
      const encoded = encodeCompleteSnapshot(expectedToken, recordResult, now);
      if (!encoded.ok) {
        if (encoded.reason !== 'incomplete' && validToken(expectedToken)) {
          try {
            await discardSnapshotIfCurrent(expectedToken);
          } catch {
            // An ineligible cache never affects the already-built live view.
          }
        }
        return { stored: false, reason: encoded.reason };
      }

      return runStoreTransaction(openDB, 'readwrite', (store, setResult, rememberError) => {
        const bindingRequest = rememberError(store.get(BINDING_KEY));
        const snapshotRequest = rememberError(store.get(SNAPSHOT_KEY));
        let bindingReady = false;
        let snapshotReady = false;

        const finish = () => {
          if (!bindingReady || !snapshotReady) return;
          const binding = bindingRequest.result || null;
          const currentSnapshot = snapshotRequest.result || null;
          if (!validateBinding(binding) || binding.token !== expectedToken) {
            setResult({ stored: false, reason: 'binding-mismatch' });
            return;
          }
          // A rolled-back v1 reader must not destroy a snapshot produced by a
          // future schema it does not understand.
          if (isFutureSchema(currentSnapshot)) {
            setResult({ stored: false, reason: 'future-schema' });
            return;
          }
          rememberError(store.put(encoded.snapshot, SNAPSHOT_KEY));
          setResult({ stored: true, snapshot: encoded.snapshot });
        };

        bindingRequest.onsuccess = () => { bindingReady = true; finish(); };
        snapshotRequest.onsuccess = () => { snapshotReady = true; finish(); };
      });
    }

    return {
      commitComplete,
      invalidateCurrent,
      prepareSelection,
      readBootstrap,
      resolveBootstrap,
    };
  }

  return {
    BINDING_KEY,
    CACHE_SCHEMA,
    HANDLE_KEY,
    MAX_SNAPSHOT_BYTES,
    MAX_SNAPSHOT_FILES,
    SNAPSHOT_KEY,
    createRepository,
    decodeAndValidateSnapshot,
    encodeCompleteSnapshot,
    isCompleteRecordResult,
  };
});
