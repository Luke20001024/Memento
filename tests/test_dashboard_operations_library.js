import assert from 'node:assert/strict';

await import('../chrome-newtab/dashboard-operations-library.js');
const operations = globalThis.MementoDashboardOperations;

const LEGACY_TIMEOUT_MS = 20;

async function settleWithin(promise, label, timeoutMs = 300) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const missingError = Object.assign(new Error('file disappeared'), { name: 'NotFoundError' });
const goodBytes = new TextEncoder().encode('# valid record');
const directory = {
  async *entries() {
    yield ['README.md', { kind: 'file' }];
    yield ['2026-07-16.md', {
      kind: 'file',
      async getFile() {
        return {
          lastModified: 16,
          async arrayBuffer() { return goodBytes.buffer; },
        };
      },
    }];
    yield ['2026-07-17.md', {
      kind: 'file',
      async getFile() { throw missingError; },
    }];
  },
};

const recordResult = await operations.readMarkdownFiles(directory);
assert.deepEqual(recordResult.files.map(file => file.name), ['2026-07-16.md']);
assert.equal(recordResult.files[0].text, '# valid record');
assert.deepEqual(recordResult.issues.map(issue => issue.name), ['2026-07-17.md']);
assert.equal(recordResult.issues[0].kind, 'missing');
assert.equal(recordResult.issues[0].error, missingError);

const enumerationNames = [
  '2026-07-13.md',
  '2026-05-23.md',
  '2026-05-17.md',
  '2026-07-07.md',
  '2026-05-13.md',
  '2026-07-16.md',
  '2026-07-06.md',
  '2026-05-12.md',
  '2026-05-11.md',
  '2026-05-10.md',
];
let readsAfterDelayedFile = 0;
const delayedEighthResult = await settleWithin(
  operations.readMarkdownFiles({
    async *entries() {
      for (const [index, name] of enumerationNames.entries()) {
        yield [name, {
          kind: 'file',
          async getFile() {
            return {
              lastModified: index,
              async arrayBuffer() {
                // The eighth file matches the field report. It exceeds the
                // retired watchdog but is healthy and eventually responds.
                if (index === 7) {
                  await new Promise(resolve => setTimeout(resolve, LEGACY_TIMEOUT_MS * 2));
                }
                if (index > 7) readsAfterDelayedFile++;
                return new TextEncoder().encode(`# ${name}`).buffer;
              },
            };
          },
        }];
      }
    },
  }, {
    // Keep the retired option in the regression fixture. The old production
    // implementation would truncate at file 8; ordinary reads now ignore it.
    timeoutMs: LEGACY_TIMEOUT_MS,
  }),
  'delayed eighth file scan',
  500
);
assert.equal(delayedEighthResult.files.length, enumerationNames.length, 'a slow eighth file cannot truncate the directory');
assert.deepEqual(
  delayedEighthResult.files.map(file => file.name).sort(),
  [...enumerationNames].sort()
);
assert.equal(
  delayedEighthResult.files.find(file => file.name === '2026-05-12.md').text,
  '# 2026-05-12.md'
);
assert.equal(readsAfterDelayedFile, 2, 'files after the delayed response are still read');
assert.deepEqual(delayedEighthResult.issues, []);
assert.equal(delayedEighthResult.issue, '');
assert.equal(Boolean(delayedEighthResult.timedOut), false);
assert.equal(delayedEighthResult.issues.some(issue => issue.kind === 'timeout'), false);
assert.doesNotMatch(delayedEighthResult.issue || '', /超时|未按时|停止本轮扫描/);

assert.equal(operations.errorKind(Object.assign(new Error('denied'), { name: 'NotAllowedError' })), 'permission');
assert.equal(operations.errorKind(Object.assign(new Error('security'), { name: 'SecurityError' })), 'permission');
const permissionError = Object.assign(new Error('directory permission expired'), { name: 'NotAllowedError' });
await assert.rejects(
  operations.readMarkdownFiles({
    async *entries() {
      yield ['2026-07-17.md', { kind: 'file', async getFile() { throw permissionError; } }];
    },
  }),
  error => error === permissionError,
  'a revoked root permission is escalated instead of being shown as a per-file warning'
);

const staleRootError = Object.assign(new Error('root directory moved'), { name: 'InvalidStateError' });
await assert.rejects(
  operations.readMarkdownFiles({
    entries() { throw staleRootError; },
  }),
  error => error === staleRootError,
  'a stale root handle is escalated so the directory recovery UI can replace it'
);

const missingRootError = Object.assign(new Error('root directory disappeared'), { name: 'NotFoundError' });
await assert.rejects(
  operations.readMarkdownFiles({
    entries() {
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() { throw missingRootError; },
      };
    },
  }),
  error => error === missingRootError,
  'a missing root during iteration is not rendered as an empty or partial dashboard'
);

assert.equal(operations.uniqueArchiveName('report.html', []), 'report.html');
assert.equal(operations.uniqueArchiveName('report.html', ['report.html']), 'report (2).html');
assert.equal(
  operations.uniqueArchiveName('REPORT.HTML', ['report.html', 'report (2).html']),
  'REPORT (3).HTML',
  'archive conflicts are case-insensitive on the common macOS filesystem'
);
assert.equal(operations.uniqueArchiveName('not-html.txt', []), '');

const enqueue = operations.createSerialQueue();
const storedNames = new Set();
const saveWithDelay = requestedName => enqueue(async () => {
  const selectedName = operations.uniqueArchiveName(requestedName, storedNames);
  await new Promise(resolve => setTimeout(resolve, 5));
  storedNames.add(selectedName);
  return selectedName;
});
const concurrentNames = await Promise.all([
  saveWithDelay('same.html'),
  saveWithDelay('same.html'),
]);
assert.deepEqual(concurrentNames, ['same.html', 'same (2).html']);

assert.equal(operations.ARCHIVE_MUTATION_LOCK_NAME, 'memento.archive.mutation');

function createFakeLockManager() {
  const tails = new Map();
  const stats = { active: 0, maxActive: 0, names: [] };
  return {
    stats,
    request(name, options, callback) {
      assert.equal(options.mode, 'exclusive');
      assert.ok(
        Object.keys(options).every(key => key === 'mode' || key === 'signal'),
        'locks only use the exclusive mode and an optional acquisition AbortSignal'
      );
      stats.names.push(name);
      const previous = tails.get(name) || Promise.resolve();
      const result = previous.then(async () => {
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          stats.active--;
        }
      });
      tails.set(name, result.then(() => undefined, () => undefined));
      return result;
    },
  };
}

// Per-tab queues cannot protect two independent extension pages.  Both pages
// must converge on the same Web Lock before selecting and writing a name.
const sharedLockManager = createFakeLockManager();
const tabOneQueue = operations.createSerialQueue();
const tabTwoQueue = operations.createSerialQueue();
const crossTabStoredNames = new Set();
const saveFromTab = queue => requestedName => queue(() =>
  operations.withArchiveMutationLock(sharedLockManager, async () => {
    const selectedName = operations.uniqueArchiveName(requestedName, crossTabStoredNames);
    await new Promise(resolve => setTimeout(resolve, 5));
    crossTabStoredNames.add(selectedName);
    return selectedName;
  })
);
const crossTabNames = await Promise.all([
  saveFromTab(tabOneQueue)('cross-tab.html'),
  saveFromTab(tabTwoQueue)('cross-tab.html'),
]);
assert.deepEqual(crossTabNames, ['cross-tab.html', 'cross-tab (2).html']);
assert.equal(sharedLockManager.stats.maxActive, 1, 'the shared archive mutation never overlaps');
assert.deepEqual(
  sharedLockManager.stats.names,
  [operations.ARCHIVE_MUTATION_LOCK_NAME, operations.ARCHIVE_MUTATION_LOCK_NAME]
);

const lockFailure = new Error('simulated mutation failure');
await assert.rejects(
  operations.withArchiveMutationLock(sharedLockManager, async () => { throw lockFailure; }),
  error => error === lockFailure
);
assert.equal(
  await operations.withArchiveMutationLock(sharedLockManager, async () => 'released'),
  'released',
  'an exception releases the shared lock for the next mutation'
);

let unsupportedTaskRan = false;
await assert.rejects(
  operations.withArchiveMutationLock(undefined, async () => { unsupportedTaskRan = true; }),
  error => error && error.name === 'NotSupportedError'
);
assert.equal(unsupportedTaskRan, false, 'missing Web Locks support fails closed without running the mutation');

const persistenceError = Object.assign(new Error('IndexedDB unavailable'), { name: 'UnknownError' });
let rejectPersistence;
const order = [];
const selectionPromise = operations.loadWhilePersisting({ name: 'AISecretary' }, {
  load: async handle => {
    order.push(`load:${handle.name}`);
    return { ok: true };
  },
  persist: async () => {
    order.push('persist');
    await new Promise((resolve, reject) => { rejectPersistence = reject; });
  },
});
await Promise.resolve();
assert.equal(order[0], 'load:AISecretary', 'current directory loading starts without waiting for IndexedDB');
rejectPersistence(persistenceError);
const selection = await selectionPromise;
assert.equal(selection.loadResult.ok, true);
assert.equal(selection.persistence.ok, false);
assert.equal(selection.persistence.error, persistenceError);

console.log('✓ dashboard operations: waits for delayed reads, degrades real file errors, serializes archive mutations, and tolerates persistence failure');
