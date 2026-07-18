import assert from 'node:assert/strict';

await import('../chrome-newtab/dashboard-cache-library.js');
const cache = globalThis.MementoDashboardCache;

const {
  ARCHIVE_INDEX_KEY,
  BINDING_KEY,
  CACHE_SCHEMA,
  HANDLE_KEY,
  MAX_ARCHIVE_INDEX_ITEMS,
  MAX_ARCHIVE_NAME_LENGTH,
  MAX_ARCHIVE_TITLE_LENGTH,
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_KEY,
  createRepository,
  decodeAndValidateSnapshot,
  encodeCompleteSnapshot,
  isCompleteRecordResult,
} = cache;

function bytes(text) {
  return new TextEncoder().encode(text).buffer;
}

function recordResult(files, {
  issues = [],
  issue = '',
  complete = true,
  scanDate = '2026-07-17',
} = {}) {
  return { files, issues, issue, scanDate, coverage: { complete } };
}

function dailyFile(name, text, mtime = 1) {
  return { name, mtime, bytes: bytes(text), text };
}

function handle(id, options = {}) {
  return {
    kind: 'directory',
    name: id,
    cacheTestId: id,
    async isSameEntry(other) {
      if (options.identityError) throw options.identityError;
      if (options.identityPending) return new Promise(() => {});
      return Boolean(other && other.cacheTestId === id);
    },
  };
}

function binding(token, boundHandle, createdAt = 1) {
  return { schema: CACHE_SCHEMA, token, boundHandle, createdAt };
}

function validSnapshot(token, files, committedAt = 2) {
  const encoded = encodeCompleteSnapshot(token, recordResult(files), () => committedAt);
  assert.equal(encoded.ok, true);
  return encoded.snapshot;
}

function archiveItem(name, title, mtime = 1, extras = {}) {
  return { name, title, mtime, ...extras };
}

function archiveIndex(token, items, committedAt = 2) {
  return {
    schema: CACHE_SCHEMA,
    bindingToken: token,
    committedAt,
    itemCount: items.length,
    items,
  };
}

// Minimal asynchronous IndexedDB double. Each readwrite transaction stages a
// complete Map and publishes it only on transaction completion, so the tests
// can prove that a failed middle request does not leak a partial selection.
function createMemoryIndexedDB(initialEntries = []) {
  const data = new Map(initialEntries);
  const logs = [];
  let failRule = null;

  function failNext(predicate, error = Object.assign(new Error('injected IDB failure'), { name: 'UnknownError' })) {
    failRule = { predicate, error };
  }

  async function openDB() {
    return {
      close() {},
      transaction(storeName, mode) {
        assert.equal(storeName, 'handles');
        const staged = new Map(data);
        const log = { mode, operations: [], committed: false, aborted: false };
        logs.push(log);
        let pending = 0;
        let finished = false;
        let completionQueued = false;

        const transaction = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(name) {
            assert.equal(name, 'handles');
            return store;
          },
          abort() {
            if (finished) return;
            finished = true;
            log.aborted = true;
            queueMicrotask(() => transaction.onabort?.());
          },
        };

        function queueCompletion() {
          if (finished || pending !== 0 || completionQueued) return;
          completionQueued = true;
          queueMicrotask(() => {
            completionQueued = false;
            if (finished || pending !== 0) return;
            finished = true;
            if (mode === 'readwrite') {
              data.clear();
              for (const [key, value] of staged) data.set(key, value);
            }
            log.committed = true;
            transaction.oncomplete?.();
          });
        }

        function requestFor(operation, key, action) {
          const request = {
            readyState: 'pending',
            result: undefined,
            error: null,
            onsuccess: null,
            onerror: null,
          };
          log.operations.push(`${operation}:${key}`);
          pending++;
          queueMicrotask(() => {
            if (finished) return;
            try {
              if (failRule && failRule.predicate({ operation, key, mode })) {
                const { error } = failRule;
                failRule = null;
                throw error;
              }
              request.result = action();
              request.readyState = 'done';
              request.onsuccess?.();
              pending--;
              queueCompletion();
            } catch (error) {
              request.error = error;
              request.readyState = 'done';
              transaction.error = error;
              request.onerror?.();
              pending--;
              if (!finished) {
                finished = true;
                log.aborted = true;
                queueMicrotask(() => {
                  transaction.onerror?.();
                  transaction.onabort?.();
                });
              }
            }
          });
          return request;
        }

        const store = {
          get(key) {
            return requestFor('get', key, () => staged.get(key));
          },
          put(value, key) {
            assert.equal(mode, 'readwrite');
            return requestFor('put', key, () => {
              staged.set(key, value);
              return key;
            });
          },
          delete(key) {
            assert.equal(mode, 'readwrite');
            return requestFor('delete', key, () => staged.delete(key));
          },
        };

        return transaction;
      },
    };
  }

  return { data, failNext, logs, openDB };
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] || `token-${index}`;
}

// ---------------------------------------------------------------------------
// Snapshot codec: only complete, bounded raw daily Markdown is eligible.
// ---------------------------------------------------------------------------

const sourceFiles = [
  dailyFile('2026-07-16.md', '# older', 16),
  dailyFile('2026-07-17.md', '# today', 17),
];
const encoded = encodeCompleteSnapshot('binding-a', recordResult(sourceFiles), () => 100);
assert.equal(encoded.ok, true);
assert.equal(encoded.snapshot.complete, true);
assert.equal(encoded.snapshot.fileCount, 2);
assert.equal(encoded.snapshot.committedAt, 100);
assert.equal(encoded.snapshot.scanDate, '2026-07-17');
assert.deepEqual(encoded.snapshot.files.map(file => file.name), ['2026-07-17.md', '2026-07-16.md']);
assert.notEqual(encoded.snapshot.files[0].bytes, sourceFiles[1].bytes, 'snapshot owns a copy of live bytes');

const decoded = decodeAndValidateSnapshot(encoded.snapshot, 'binding-a');
assert.equal(decoded.ok, true);
assert.deepEqual(decoded.files.map(file => file.date), ['2026-07-17', '2026-07-16']);
assert.deepEqual(decoded.files.map(file => file.text), ['# today', '# older']);
assert.equal(decoded.scanDate, '2026-07-17');
assert.equal(decodeAndValidateSnapshot(encoded.snapshot, 'binding-b').reason, 'binding-mismatch');
const missingScanDate = { ...encoded.snapshot };
delete missingScanDate.scanDate;
assert.equal(
  decodeAndValidateSnapshot(missingScanDate, 'binding-a').reason,
  'invalid-scan-date',
  'a follower never treats a snapshot without fixed scanDate as current'
);
assert.equal(
  encodeCompleteSnapshot('binding-a', recordResult(sourceFiles, { scanDate: 'not-a-date' })).reason,
  'invalid-scan-date'
);

assert.equal(isCompleteRecordResult(recordResult([])), true, 'a fully enumerated empty directory is complete');
assert.equal(encodeCompleteSnapshot('empty', recordResult([]), () => 101).ok, true);
assert.equal(isCompleteRecordResult(recordResult([], { complete: false })), false);
assert.equal(isCompleteRecordResult(recordResult([], { issues: [{ name: 'bad' }] })), false);
assert.equal(isCompleteRecordResult(recordResult([], { issue: 'scan stopped' })), false);
assert.equal(
  encodeCompleteSnapshot('binding-a', recordResult(sourceFiles, { issues: [{ name: 'bad' }] })).reason,
  'incomplete'
);
assert.equal(
  encodeCompleteSnapshot('binding-a', recordResult(sourceFiles, { issue: 'scan stopped' })).reason,
  'incomplete'
);
assert.equal(
  encodeCompleteSnapshot('binding-a', recordResult([
    dailyFile('2026-07-17.md', 'one'),
    dailyFile('2026-07-17.md', 'two'),
  ])).reason,
  'duplicate-file'
);
assert.equal(
  encodeCompleteSnapshot('binding-a', recordResult([{ name: 'README.md', mtime: 1, bytes: bytes('x') }])).reason,
  'invalid-file-name'
);
assert.equal(
  encodeCompleteSnapshot('binding-a', recordResult([
    { name: '2026-07-17.md', mtime: 1, bytes: new ArrayBuffer(MAX_SNAPSHOT_BYTES + 1) },
  ])).reason,
  'too-large'
);

const corruptCount = { ...encoded.snapshot, fileCount: 3 };
assert.equal(decodeAndValidateSnapshot(corruptCount, 'binding-a').reason, 'file-count-mismatch');
const corruptSize = { ...encoded.snapshot, totalBytes: encoded.snapshot.totalBytes + 1 };
assert.equal(decodeAndValidateSnapshot(corruptSize, 'binding-a').reason, 'total-bytes-mismatch');
const oversizedMetadata = { ...encoded.snapshot, totalBytes: MAX_SNAPSHOT_BYTES + 1 };
assert.equal(decodeAndValidateSnapshot(oversizedMetadata, 'binding-a').reason, 'invalid-total-bytes');
assert.equal(decodeAndValidateSnapshot({ schema: 2 }, 'binding-a').reason, 'future-schema');

// ---------------------------------------------------------------------------
// Explicit selection: dir + binding + snapshot deletion are one transaction.
// ---------------------------------------------------------------------------

const dirA = handle('A');
const dirB = handle('B');
const snapshotA = validSnapshot('old-a', [dailyFile('2026-07-15.md', 'A')]);
const archiveIndexA = archiveIndex('old-a', [archiveItem('a.html', 'Private A')]);
const selectionDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('old-a', dirA)],
  [SNAPSHOT_KEY, snapshotA],
  [ARCHIVE_INDEX_KEY, archiveIndexA],
]);
const selectionRepo = createRepository({
  openDB: selectionDB.openDB,
  randomUUID: uuidSequence('new-b'),
  now: () => 200,
});
const prepared = selectionRepo.prepareSelection(dirB);
assert.equal(prepared.binding.token, 'new-b', 'binding exists before IndexedDB settles');
await new Promise(resolve => setImmediate(resolve));
assert.equal(selectionDB.logs.length, 0, 'preparing a selection does not open a transaction');
assert.equal(selectionDB.data.get(HANDLE_KEY), dirA, 'the old selection remains until persistence starts');
const selectionPersistence = prepared.startPersistence();
assert.equal(
  prepared.startPersistence(),
  selectionPersistence,
  'repeated starts reuse the same persistence promise'
);
await selectionPersistence;
assert.equal(
  prepared.startPersistence(),
  selectionPersistence,
  'a settled selection still reuses the original persistence promise'
);
assert.equal(selectionDB.logs.length, 1, 'the selection is persisted exactly once');
assert.equal(selectionDB.data.get(HANDLE_KEY), dirB);
assert.equal(selectionDB.data.get(BINDING_KEY).token, 'new-b');
assert.equal(selectionDB.data.get(BINDING_KEY).boundHandle, dirB);
assert.equal(selectionDB.data.has(SNAPSHOT_KEY), false);
assert.equal(selectionDB.data.has(ARCHIVE_INDEX_KEY), false);
assert.deepEqual(
  selectionDB.logs.at(-1).operations,
  [
    `put:${HANDLE_KEY}`,
    `put:${BINDING_KEY}`,
    `delete:${SNAPSHOT_KEY}`,
    `delete:${ARCHIVE_INDEX_KEY}`,
  ]
);
const selectionContext = await prepared.contextPromise;
assert.equal(selectionContext.writable, true);
assert.equal(selectionContext.reason, 'new-selection');
assert.equal(selectionContext.binding, prepared.binding);

const atomicDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('old-a', dirA)],
  [SNAPSHOT_KEY, snapshotA],
  [ARCHIVE_INDEX_KEY, archiveIndexA],
]);
atomicDB.failNext(({ operation, key }) => operation === 'put' && key === BINDING_KEY);
const atomicRepo = createRepository({
  openDB: atomicDB.openDB,
  randomUUID: () => 'failed-b',
  now: () => 201,
});
const failedSelection = atomicRepo.prepareSelection(dirB);
const failedPersistence = failedSelection.startPersistence();
assert.equal(
  failedSelection.startPersistence(),
  failedPersistence,
  'a failing selection also starts only once'
);
await assert.rejects(failedPersistence, /injected IDB failure/);
assert.equal(
  failedSelection.startPersistence(),
  failedPersistence,
  'a rejected selection still reuses the original persistence promise'
);
assert.equal(atomicDB.logs.length, 1, 'a failed persistence attempt is not retried implicitly');
const failedContext = await failedSelection.contextPromise;
assert.equal(failedContext.writable, false);
assert.equal(failedContext.reason, 'persistence-error');
assert.match(failedContext.error.message, /injected IDB failure/);
assert.equal(atomicDB.data.get(HANDLE_KEY), dirA, 'failed selection keeps the old handle');
assert.equal(atomicDB.data.get(BINDING_KEY).token, 'old-a', 'failed selection keeps the old binding');
assert.equal(atomicDB.data.get(SNAPSHOT_KEY), snapshotA, 'failed selection keeps the old snapshot');
assert.equal(atomicDB.data.get(ARCHIVE_INDEX_KEY), archiveIndexA, 'failed selection keeps the old archive index');

// ---------------------------------------------------------------------------
// Invalidation rotates the token and prevents a late scan from resurrecting.
// ---------------------------------------------------------------------------

const invalidateDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('before-clear', dirA)],
  [SNAPSHOT_KEY, validSnapshot('before-clear', [dailyFile('2026-07-17.md', 'old')])],
  [ARCHIVE_INDEX_KEY, archiveIndex('before-clear', [archiveItem('old.html', 'Old')])],
]);
const invalidateRepo = createRepository({
  openDB: invalidateDB.openDB,
  randomUUID: () => 'after-clear',
  now: () => 300,
});
const invalidated = await invalidateRepo.invalidateCurrent('before-clear');
assert.equal(invalidated.invalidated, true);
assert.equal(invalidated.binding.token, 'after-clear');
assert.equal(invalidateDB.data.get(HANDLE_KEY), dirA);
assert.equal(invalidateDB.data.has(SNAPSHOT_KEY), false);
assert.equal(invalidateDB.data.has(ARCHIVE_INDEX_KEY), false);
assert.deepEqual(
  invalidateDB.logs.at(-1).operations,
  [
    `get:${HANDLE_KEY}`,
    `get:${BINDING_KEY}`,
    `put:${BINDING_KEY}`,
    `delete:${SNAPSHOT_KEY}`,
    `delete:${ARCHIVE_INDEX_KEY}`,
  ]
);
const lateCommit = await invalidateRepo.commitComplete(
  'before-clear',
  recordResult([dailyFile('2026-07-17.md', 'late old scan')])
);
assert.equal(lateCommit.stored, false);
assert.equal(lateCommit.reason, 'binding-mismatch');
assert.equal(invalidateDB.data.has(SNAPSHOT_KEY), false);

const failedInvalidateSnapshot = validSnapshot('before-failed-clear', [dailyFile('2026-07-17.md', 'keep')]);
const failedInvalidateArchiveIndex = archiveIndex(
  'before-failed-clear',
  [archiveItem('keep.html', 'Keep')]
);
const failedInvalidateDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('before-failed-clear', dirA)],
  [SNAPSHOT_KEY, failedInvalidateSnapshot],
  [ARCHIVE_INDEX_KEY, failedInvalidateArchiveIndex],
]);
failedInvalidateDB.failNext(({ operation, key }) => operation === 'delete' && key === SNAPSHOT_KEY);
const failedInvalidateRepo = createRepository({
  openDB: failedInvalidateDB.openDB,
  randomUUID: () => 'must-not-leak',
  now: () => 301,
});
await assert.rejects(
  failedInvalidateRepo.invalidateCurrent('before-failed-clear'),
  /injected IDB failure/
);
assert.equal(failedInvalidateDB.data.get(BINDING_KEY).token, 'before-failed-clear');
assert.equal(failedInvalidateDB.data.get(SNAPSHOT_KEY), failedInvalidateSnapshot);
assert.equal(failedInvalidateDB.data.get(ARCHIVE_INDEX_KEY), failedInvalidateArchiveIndex);

await assert.rejects(
  failedInvalidateRepo.invalidateCurrent(),
  error => error instanceof TypeError && /binding token/.test(error.message),
  'a missing expected token fails closed before opening a transaction'
);
await assert.rejects(
  failedInvalidateRepo.invalidateCurrent(''),
  error => error instanceof TypeError && /binding token/.test(error.message),
  'an invalid expected token fails closed before opening a transaction'
);

// A stale page must not clear a newly selected directory. The token is
// compared inside the same transaction that would rotate the binding and
// delete the snapshot.
const newDirectorySnapshot = validSnapshot('new-directory', [dailyFile('2026-07-17.md', 'private B')]);
const newDirectoryArchiveIndex = archiveIndex(
  'new-directory',
  [archiveItem('private-b.html', 'Private B')]
);
const staleInvalidateDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirB],
  [BINDING_KEY, binding('new-directory', dirB)],
  [SNAPSHOT_KEY, newDirectorySnapshot],
  [ARCHIVE_INDEX_KEY, newDirectoryArchiveIndex],
]);
const staleInvalidateRepo = createRepository({
  openDB: staleInvalidateDB.openDB,
  randomUUID: () => 'must-not-replace-new-directory',
  now: () => 302,
});
const staleInvalidation = await staleInvalidateRepo.invalidateCurrent('stale-directory');
assert.deepEqual(staleInvalidation, { invalidated: false, reason: 'binding-mismatch' });
assert.equal(staleInvalidateDB.data.get(HANDLE_KEY), dirB);
assert.equal(staleInvalidateDB.data.get(BINDING_KEY).token, 'new-directory');
assert.equal(staleInvalidateDB.data.get(BINDING_KEY).boundHandle, dirB);
assert.equal(staleInvalidateDB.data.get(SNAPSHOT_KEY), newDirectorySnapshot);
assert.equal(staleInvalidateDB.data.get(ARCHIVE_INDEX_KEY), newDirectoryArchiveIndex);
assert.deepEqual(
  staleInvalidateDB.logs.at(-1).operations,
  [`get:${HANDLE_KEY}`, `get:${BINDING_KEY}`],
  'a stale token performs no put or delete'
);

// ---------------------------------------------------------------------------
// Complete snapshot commits use a binding-token CAS and preserve future data.
// ---------------------------------------------------------------------------

const commitDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('commit-a', dirA)],
]);
const commitRepo = createRepository({ openDB: commitDB.openDB, now: () => 400 });
const committed = await commitRepo.commitComplete(
  'commit-a',
  recordResult([dailyFile('2026-07-17.md', 'fresh')])
);
assert.equal(committed.stored, true);
assert.equal(commitDB.data.get(SNAPSHOT_KEY).bindingToken, 'commit-a');
assert.deepEqual(
  commitDB.logs.at(-1).operations,
  [`get:${BINDING_KEY}`, `get:${SNAPSHOT_KEY}`, `put:${SNAPSHOT_KEY}`]
);
const preserved = commitDB.data.get(SNAPSHOT_KEY);
const incompleteCommit = await commitRepo.commitComplete(
  'commit-a',
  recordResult([dailyFile('2026-07-17.md', 'partial')], { issues: [{ name: '2026-07-16.md' }] })
);
assert.equal(incompleteCommit.reason, 'incomplete');
assert.equal(commitDB.data.get(SNAPSHOT_KEY), preserved, 'partial live data cannot replace the complete snapshot');

const futureSnapshot = { schema: 2, opaque: 'future-cache' };
commitDB.data.set(SNAPSHOT_KEY, futureSnapshot);
const futureCommit = await commitRepo.commitComplete(
  'commit-a',
  recordResult([dailyFile('2026-07-17.md', 'v1 must not overwrite')])
);
assert.equal(futureCommit.reason, 'future-schema');
assert.equal(commitDB.data.get(SNAPSHOT_KEY), futureSnapshot);

const failedCommitSnapshot = validSnapshot('commit-failure', [dailyFile('2026-07-16.md', 'last known good')]);
const failedCommitDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('commit-failure', dirA)],
  [SNAPSHOT_KEY, failedCommitSnapshot],
]);
failedCommitDB.failNext(({ operation, key }) => operation === 'put' && key === SNAPSHOT_KEY);
const failedCommitRepo = createRepository({ openDB: failedCommitDB.openDB, now: () => 401 });
await assert.rejects(
  failedCommitRepo.commitComplete(
    'commit-failure',
    recordResult([dailyFile('2026-07-17.md', 'must not partially publish')])
  ),
  /injected IDB failure/
);
assert.equal(failedCommitDB.data.get(SNAPSHOT_KEY), failedCommitSnapshot);

// ---------------------------------------------------------------------------
// Archive index: persistent metadata only, bounded, and directory-token fenced.
// ---------------------------------------------------------------------------

const archiveDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('archive-a', dirA)],
]);
const archiveWriter = createRepository({ openDB: archiveDB.openDB, now: () => 800 });
const archiveSource = [
  archiveItem('new.html', 'New title', 20, {
    html: '<article>must not persist</article>',
    body: 'must not persist',
    handle: { kind: 'file' },
  }),
  archiveItem('old.htm', 'Old title', 10),
];
const archiveCommit = await archiveWriter.commitArchiveIndex('archive-a', archiveSource);
assert.equal(archiveCommit.stored, true);
assert.equal(archiveCommit.index.committedAt, 800);
assert.deepEqual(
  archiveDB.logs.at(-1).operations,
  [`get:${BINDING_KEY}`, `get:${ARCHIVE_INDEX_KEY}`, `put:${ARCHIVE_INDEX_KEY}`],
  'archive commit checks the current binding in its write transaction'
);
const storedArchiveIndex = archiveDB.data.get(ARCHIVE_INDEX_KEY);
assert.equal(storedArchiveIndex.bindingToken, 'archive-a');
assert.equal(storedArchiveIndex.itemCount, 2);
assert.deepEqual(
  Object.keys(storedArchiveIndex.items[0]).sort(),
  ['mtime', 'name', 'title'],
  'HTML, body text, handles, and other live fields never enter IndexedDB'
);
assert.deepEqual(storedArchiveIndex.items, [
  archiveItem('new.html', 'New title', 20),
  archiveItem('old.htm', 'Old title', 10),
]);

const archiveReader = createRepository({ openDB: archiveDB.openDB });
const archiveHit = await archiveReader.readArchiveIndex('archive-a');
assert.deepEqual(archiveHit, {
  ok: true,
  items: [
    archiveItem('new.html', 'New title', 20),
    archiveItem('old.htm', 'Old title', 10),
  ],
  committedAt: 800,
});
assert.equal(archiveDB.logs.at(-1).mode, 'readonly');
assert.deepEqual(
  archiveDB.logs.at(-1).operations,
  [`get:${BINDING_KEY}`, `get:${ARCHIVE_INDEX_KEY}`],
  'a second repository reads only persistent metadata and performs no file operation'
);
archiveHit.items[0].title = 'caller mutation';
assert.equal(
  (await archiveReader.readArchiveIndex('archive-a')).items[0].title,
  'New title',
  'readers receive detached metadata copies'
);
assert.equal(
  (await archiveReader.readArchiveIndex('another-directory')).reason,
  'binding-mismatch',
  'a caller cannot read an index using another directory token'
);

const archiveLogsBeforeInvalidInput = archiveDB.logs.length;
const tooManyArchiveItems = Array.from(
  { length: MAX_ARCHIVE_INDEX_ITEMS + 1 },
  (_, index) => archiveItem(`${index}.html`, `${index}`, index)
);
assert.equal(
  (await archiveWriter.commitArchiveIndex('archive-a', tooManyArchiveItems)).reason,
  'too-many-items'
);
assert.equal(
  (await archiveWriter.commitArchiveIndex('archive-a', [
    archiveItem(`${'n'.repeat(MAX_ARCHIVE_NAME_LENGTH)}x`, 'title'),
  ])).reason,
  'invalid-name'
);
assert.equal(
  (await archiveWriter.commitArchiveIndex('archive-a', [
    archiveItem('long-title.html', 't'.repeat(MAX_ARCHIVE_TITLE_LENGTH + 1)),
  ])).reason,
  'invalid-title'
);
assert.equal(
  archiveDB.logs.length,
  archiveLogsBeforeInvalidInput,
  'ineligible metadata is rejected before IndexedDB is opened'
);

const corruptArchiveDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('corrupt-archive', dirA)],
  [ARCHIVE_INDEX_KEY, archiveIndex('corrupt-archive', [
    archiveItem('leak.html', 'Leak', 1, { html: '<p>unexpected</p>' }),
  ])],
]);
const corruptArchiveRepo = createRepository({ openDB: corruptArchiveDB.openDB });
assert.equal(
  (await corruptArchiveRepo.readArchiveIndex('corrupt-archive')).reason,
  'invalid-item-shape',
  'a record containing more than the three metadata fields fails closed'
);
corruptArchiveDB.data.set(
  ARCHIVE_INDEX_KEY,
  { ...archiveIndex('corrupt-archive', [archiveItem('one.html', 'One')]), itemCount: 2 }
);
assert.equal(
  (await corruptArchiveRepo.readArchiveIndex('corrupt-archive')).reason,
  'item-count-mismatch'
);

const futureArchiveIndex = { schema: CACHE_SCHEMA + 1, opaque: 'future archive index' };
corruptArchiveDB.data.set(ARCHIVE_INDEX_KEY, futureArchiveIndex);
assert.equal(
  (await corruptArchiveRepo.readArchiveIndex('corrupt-archive')).reason,
  'future-schema'
);
assert.equal(
  (await corruptArchiveRepo.commitArchiveIndex(
    'corrupt-archive',
    [archiveItem('v1.html', 'Must not overwrite')]
  )).reason,
  'future-schema'
);
assert.equal(
  (await corruptArchiveRepo.deleteArchiveIndex('corrupt-archive')).reason,
  'future-schema'
);
assert.equal(
  corruptArchiveDB.data.get(ARCHIVE_INDEX_KEY),
  futureArchiveIndex,
  'a rolled-back reader preserves an archive index produced by a future schema'
);

const lateArchiveDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('late-old', dirA)],
  [ARCHIVE_INDEX_KEY, archiveIndex('late-old', [archiveItem('old.html', 'Old')])],
]);
const lateArchiveWriter = createRepository({ openDB: lateArchiveDB.openDB, now: () => 810 });
const archiveRotator = createRepository({
  openDB: lateArchiveDB.openDB,
  randomUUID: () => 'late-new',
  now: () => 811,
});
assert.equal((await archiveRotator.invalidateCurrent('late-old')).invalidated, true);
assert.equal(lateArchiveDB.data.has(ARCHIVE_INDEX_KEY), false);
const staleArchiveCommit = await lateArchiveWriter.commitArchiveIndex(
  'late-old',
  [archiveItem('late.html', 'Late old directory')]
);
assert.deepEqual(staleArchiveCommit, { stored: false, reason: 'binding-mismatch' });
assert.equal(
  lateArchiveDB.data.has(ARCHIVE_INDEX_KEY),
  false,
  'a late old-token commit cannot resurrect retired directory metadata'
);

const deleteArchiveDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('delete-archive', dirA)],
  [ARCHIVE_INDEX_KEY, archiveIndex('delete-archive', [archiveItem('delete.html', 'Delete')])],
]);
const deleteArchiveRepo = createRepository({ openDB: deleteArchiveDB.openDB });
assert.deepEqual(
  await deleteArchiveRepo.deleteArchiveIndex('delete-archive'),
  { deleted: true, existed: true }
);
assert.equal(deleteArchiveDB.data.has(ARCHIVE_INDEX_KEY), false);
assert.deepEqual(
  deleteArchiveDB.logs.at(-1).operations,
  [`get:${BINDING_KEY}`, `get:${ARCHIVE_INDEX_KEY}`, `delete:${ARCHIVE_INDEX_KEY}`]
);
assert.deepEqual(
  await deleteArchiveRepo.readArchiveIndex('delete-archive'),
  { ok: false, reason: 'cache-miss' }
);

// ---------------------------------------------------------------------------
// Bootstrap resolution: permission is an integration concern; once called,
// both stored handles must identify the same selected directory.
// ---------------------------------------------------------------------------

const hitSnapshot = validSnapshot('hit-a', [dailyFile('2026-07-17.md', 'cache hit')], 500);
const hitDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('hit-a', dirA)],
  [SNAPSHOT_KEY, hitSnapshot],
]);
const hitRepo = createRepository({ openDB: hitDB.openDB });
const hitBootstrap = await hitRepo.readBootstrap();
assert.equal(hitBootstrap.handle, dirA);
assert.equal(hitBootstrap.binding.token, 'hit-a');
const hit = await hitRepo.resolveBootstrap(dirA, hitBootstrap);
assert.equal(hit.reason, 'cache-hit');
assert.equal(hit.writable, true);
assert.equal(hit.cache.files[0].text, 'cache hit');

const wrongDirectory = await hitRepo.resolveBootstrap(dirB, hitBootstrap);
assert.equal(wrongDirectory.reason, 'directory-mismatch');
assert.equal(wrongDirectory.cache, null);
assert.equal(wrongDirectory.writable, false);

const identityFailure = new Error('isSameEntry failed');
const identityResult = await hitRepo.resolveBootstrap(
  handle('A', { identityError: identityFailure }),
  hitBootstrap
);
assert.equal(identityResult.reason, 'identity-error');
assert.equal(identityResult.cache, null);

// v0.8.6 stores only `dir`. The new reader establishes a binding without
// changing the handle or requiring a new directory picker interaction.
const legacyDB = createMemoryIndexedDB([[HANDLE_KEY, dirA]]);
const legacyRepo = createRepository({
  openDB: legacyDB.openDB,
  randomUUID: () => 'migrated-a',
  now: () => 600,
});
const legacy = await legacyRepo.resolveBootstrap(dirA, await legacyRepo.readBootstrap());
assert.equal(legacy.reason, 'binding-created');
assert.equal(legacy.writable, true);
assert.equal(legacy.binding.token, 'migrated-a');
assert.equal(legacyDB.data.get(HANDLE_KEY), dirA);
assert.equal(legacyDB.data.get(BINDING_KEY).boundHandle, dirA);

// If a rollback selected B, old v0.8.6 changed only `dir`; A's binding and
// snapshot must be retired before B becomes cache-writable.
const rollbackDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirB],
  [BINDING_KEY, binding('stale-a', dirA)],
  [SNAPSHOT_KEY, validSnapshot('stale-a', [dailyFile('2026-07-17.md', 'private A')])],
  [ARCHIVE_INDEX_KEY, archiveIndex('stale-a', [archiveItem('private-a.html', 'Private A')])],
]);
const rollbackRepo = createRepository({
  openDB: rollbackDB.openDB,
  randomUUID: () => 'rebound-b',
  now: () => 700,
});
const rebound = await rollbackRepo.resolveBootstrap(dirB, await rollbackRepo.readBootstrap());
assert.equal(rebound.reason, 'binding-replaced');
assert.equal(rebound.cache, null);
assert.equal(rebound.binding.token, 'rebound-b');
assert.equal(rebound.binding.boundHandle, dirB);
assert.equal(rollbackDB.data.has(SNAPSHOT_KEY), false);
assert.equal(rollbackDB.data.has(ARCHIVE_INDEX_KEY), false);

const futureBinding = { schema: 2, token: 'future', boundHandle: dirA, createdAt: 1 };
const futureBindingDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, futureBinding],
  [SNAPSHOT_KEY, { schema: 2, opaque: true }],
]);
const futureBindingRepo = createRepository({ openDB: futureBindingDB.openDB });
const futureBindingResult = await futureBindingRepo.resolveBootstrap(
  dirA,
  await futureBindingRepo.readBootstrap()
);
assert.equal(futureBindingResult.reason, 'future-binding-schema');
assert.equal(futureBindingResult.writable, false);
assert.equal(futureBindingDB.data.get(BINDING_KEY), futureBinding);
assert.equal(futureBindingDB.data.get(SNAPSHOT_KEY).schema, 2);

const futureSnapshotDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('current-a', dirA)],
  [SNAPSHOT_KEY, { schema: 2, opaque: 'future snapshot' }],
]);
const futureSnapshotRepo = createRepository({ openDB: futureSnapshotDB.openDB });
const futureSnapshotResult = await futureSnapshotRepo.resolveBootstrap(
  dirA,
  await futureSnapshotRepo.readBootstrap()
);
assert.equal(futureSnapshotResult.reason, 'future-snapshot-schema');
assert.equal(futureSnapshotResult.writable, false);
assert.equal(futureSnapshotDB.data.get(SNAPSHOT_KEY).opaque, 'future snapshot');

// A corrupt same-schema snapshot is a cache miss and is deleted, while the
// valid binding remains available for the next complete live scan.
const corruptDB = createMemoryIndexedDB([
  [HANDLE_KEY, dirA],
  [BINDING_KEY, binding('corrupt-a', dirA)],
  [SNAPSHOT_KEY, { ...validSnapshot('corrupt-a', sourceFiles), totalBytes: 999999 }],
]);
const corruptRepo = createRepository({ openDB: corruptDB.openDB });
const corrupt = await corruptRepo.resolveBootstrap(dirA, await corruptRepo.readBootstrap());
assert.equal(corrupt.cache, null);
assert.equal(corrupt.writable, true);
assert.equal(corrupt.reason, 'total-bytes-mismatch');
assert.equal(corruptDB.data.has(SNAPSHOT_KEY), false);

console.log('✓ dashboard cache: bounded snapshots/archive metadata, atomic invalidation, token CAS, identity, and rollback safety');
