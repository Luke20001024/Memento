import assert from 'node:assert/strict';

await import('../chrome-newtab/dashboard-operations-library.js');
const operations = globalThis.MementoDashboardOperations;

const LEGACY_TIMEOUT_MS = 20;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

assert.equal(operations.CORE_READ_CONCURRENCY, 4);
assert.equal(operations.CORE_REFRESH_LOCK_NAME, 'memento.dashboard.core-refresh.v1');

const concurrentNamesToEnumerate = [
  '2026-07-12.md',
  '2026-07-17.md',
  '2026-07-16.md',
  '2026-07-10.md',
  '2026-07-15.md',
  '2026-07-09.md',
  '2026-07-14.md',
  '2026-07-08.md',
  '2026-07-13.md',
];
const concurrentGates = new Map(concurrentNamesToEnumerate.map(name => [name, deferred()]));
const firstWaveStarted = deferred();
const fifthReadStarted = deferred();
const startedConcurrentReads = [];
const deliveredFiles = [];
let activeConcurrentReads = 0;
let maxConcurrentReads = 0;

const concurrentScanPromise = operations.readMarkdownFiles({
  async *entries() {
    for (const name of concurrentNamesToEnumerate) {
      yield [name, {
        kind: 'file',
        async getFile() {
          return {
            lastModified: Number(name.slice(8, 10)),
            async arrayBuffer() {
              startedConcurrentReads.push(name);
              activeConcurrentReads++;
              maxConcurrentReads = Math.max(maxConcurrentReads, activeConcurrentReads);
              if (startedConcurrentReads.length === 4) firstWaveStarted.resolve();
              if (startedConcurrentReads.length === 5) fifthReadStarted.resolve();
              await concurrentGates.get(name).promise;
              activeConcurrentReads--;
              return new TextEncoder().encode(`# ${name}`).buffer;
            },
          };
        },
      }];
    }
  },
}, {
  todayDate: '2026-07-17',
  onFile: detail => deliveredFiles.push(detail),
});

await firstWaveStarted.promise;
assert.equal(startedConcurrentReads[0], '2026-07-17.md', 'today is the first dequeued read');
assert.deepEqual(
  startedConcurrentReads,
  ['2026-07-17.md', '2026-07-16.md', '2026-07-15.md', '2026-07-14.md'],
  'remaining daily files are dequeued newest first'
);
assert.equal(activeConcurrentReads, 4);
assert.equal(maxConcurrentReads, 4);
assert.equal(startedConcurrentReads.length, 4, 'the fifth read waits for a real worker slot');

concurrentGates.get('2026-07-17.md').resolve();
await fifthReadStarted.promise;
assert.equal(startedConcurrentReads.length, 5, 'settling one read starts exactly one replacement');
assert.equal(activeConcurrentReads, 4);
for (const gate of concurrentGates.values()) gate.resolve();
const concurrentScan = await concurrentScanPromise;
assert.equal(maxConcurrentReads, 4, 'the physical read pool never exceeds four');
assert.equal(concurrentScan.files.length, concurrentNamesToEnumerate.length);
assert.deepEqual(concurrentScan.coverage, {
  enumerationDone: true,
  discoveredCount: concurrentNamesToEnumerate.length,
  completedCount: concurrentNamesToEnumerate.length,
  complete: true,
});
assert.equal(deliveredFiles.length, concurrentNamesToEnumerate.length);
assert.equal(deliveredFiles.find(detail => detail.isToday).file.name, '2026-07-17.md');

const staleNames = Array.from({ length: 6 }, (_, index) => `2026-06-${String(index + 1).padStart(2, '0')}.md`);
const staleGates = new Map(staleNames.map(name => [name, deferred()]));
const staleFirstWave = deferred();
const staleStarted = [];
let staleGenerationCurrent = true;
const staleScanPromise = operations.readMarkdownFiles({
  async *entries() {
    for (const name of staleNames) {
      yield [name, {
        kind: 'file',
        async getFile() {
          return {
            lastModified: 1,
            async arrayBuffer() {
              staleStarted.push(name);
              if (staleStarted.length === 4) staleFirstWave.resolve();
              await staleGates.get(name).promise;
              return new TextEncoder().encode(name).buffer;
            },
          };
        },
      }];
    }
  },
}, {
  isCurrent: () => staleGenerationCurrent,
});
await staleFirstWave.promise;
staleGenerationCurrent = false;
for (const gate of staleGates.values()) gate.resolve();
const staleScan = await staleScanPromise;
assert.equal(staleStarted.length, 4, 'a stale generation never dequeues replacement reads');
assert.equal(staleScan.files.length, 0, 'settled stale reads are not delivered to the retired page');
assert.equal(staleScan.coverage.complete, false);

const changedSnapshotError = Object.assign(new Error('file changed after getFile'), { name: 'NotReadableError' });
let originalChangedSnapshotCalls = 0;
let replacementChangedSnapshotCalls = 0;
let changedSnapshotHandleLookups = 0;
const changedSnapshotDirectory = {
  async *entries() {
    yield ['2026-07-17.md', {
      kind: 'file',
      async getFile() {
        originalChangedSnapshotCalls++;
        return {
          lastModified: 1,
          async arrayBuffer() { throw changedSnapshotError; },
        };
      },
    }];
  },
  async getFileHandle(name) {
    changedSnapshotHandleLookups++;
    assert.equal(name, '2026-07-17.md');
    return {
      kind: 'file',
      async getFile() {
        replacementChangedSnapshotCalls++;
        return {
          lastModified: 2,
          async arrayBuffer() { return new TextEncoder().encode('# fresh snapshot').buffer; },
        };
      },
    };
  },
};
const changedSnapshotResult = await operations.readMarkdownFiles(changedSnapshotDirectory);
assert.equal(originalChangedSnapshotCalls, 1);
assert.equal(changedSnapshotHandleLookups, 1, 'NotReadableError resolves one new handle from the parent');
assert.equal(replacementChangedSnapshotCalls, 1, 'the second getFile call uses the replacement handle');
assert.equal(changedSnapshotResult.files[0].text, '# fresh snapshot');
assert.equal(changedSnapshotResult.coverage.complete, true);

const disappearedOnceError = Object.assign(new Error('transiently missing'), { name: 'NotFoundError' });
let disappearedOriginalCalls = 0;
let disappearedReplacementCalls = 0;
let disappearedHandleLookups = 0;
const disappearedOnceDirectory = {
  async *entries() {
    yield ['2026-07-16.md', {
      kind: 'file',
      async getFile() {
        disappearedOriginalCalls++;
        throw disappearedOnceError;
      },
    }];
  },
  async getFileHandle(name) {
    disappearedHandleLookups++;
    assert.equal(name, '2026-07-16.md');
    return {
      kind: 'file',
      async getFile() {
        disappearedReplacementCalls++;
        return {
          lastModified: 2,
          async arrayBuffer() { return new TextEncoder().encode('# returned').buffer; },
        };
      },
    };
  },
};
const disappearedOnceResult = await operations.readMarkdownFiles(disappearedOnceDirectory);
assert.equal(disappearedOriginalCalls, 1);
assert.equal(disappearedHandleLookups, 1, 'NotFoundError resolves one new handle from the parent');
assert.equal(disappearedReplacementCalls, 1);
assert.equal(disappearedOnceResult.files[0].text, '# returned');

const repeatedSnapshotError = Object.assign(new Error('still changing'), { name: 'NotReadableError' });
let repeatedOriginalCalls = 0;
let repeatedReplacementCalls = 0;
let repeatedHandleLookups = 0;
const repeatedSnapshotDirectory = {
  async *entries() {
    yield ['2026-07-15.md', {
      kind: 'file',
      async getFile() {
        repeatedOriginalCalls++;
        return {
          lastModified: 1,
          async arrayBuffer() { throw repeatedSnapshotError; },
        };
      },
    }];
  },
  async getFileHandle(name) {
    repeatedHandleLookups++;
    assert.equal(name, '2026-07-15.md');
    return {
      kind: 'file',
      async getFile() {
        repeatedReplacementCalls++;
        return {
          lastModified: 2,
          async arrayBuffer() { throw repeatedSnapshotError; },
        };
      },
    };
  },
};
const repeatedSnapshotResult = await operations.readMarkdownFiles(repeatedSnapshotDirectory);
assert.equal(repeatedOriginalCalls, 1);
assert.equal(repeatedHandleLookups, 1);
assert.equal(repeatedReplacementCalls, 1, 'a transient snapshot failure has at most two total attempts');
assert.equal(repeatedSnapshotResult.files.length, 0);
assert.equal(repeatedSnapshotResult.issues[0].error, repeatedSnapshotError);
assert.equal(repeatedSnapshotResult.coverage.complete, false);

const replacementLookupError = Object.assign(new Error('replacement handle missing'), { name: 'NotFoundError' });
let failedLookupOriginalCalls = 0;
let failedReplacementLookups = 0;
const failedReplacementResult = await operations.readMarkdownFiles({
  async *entries() {
    yield ['2026-07-13.md', {
      kind: 'file',
      async getFile() {
        failedLookupOriginalCalls++;
        return {
          lastModified: 1,
          async arrayBuffer() { throw changedSnapshotError; },
        };
      },
    }];
  },
  async getFileHandle(name) {
    failedReplacementLookups++;
    assert.equal(name, '2026-07-13.md');
    throw replacementLookupError;
  },
});
assert.equal(failedLookupOriginalCalls, 1);
assert.equal(failedReplacementLookups, 1, 'a failed parent lookup is not retried');
assert.equal(failedReplacementResult.files.length, 0);
assert.equal(failedReplacementResult.issues.length, 1);
assert.equal(failedReplacementResult.issues[0].kind, 'missing');
assert.equal(failedReplacementResult.issues[0].error, replacementLookupError);
assert.equal(failedReplacementResult.coverage.complete, false);

const ordinaryFileError = new TypeError('malformed file implementation');
let ordinaryErrorGetFileCalls = 0;
let ordinaryErrorHandleLookups = 0;
const ordinaryErrorDirectory = {
  async *entries() {
    yield ['2026-07-14.md', {
      kind: 'file',
      async getFile() {
        ordinaryErrorGetFileCalls++;
        throw ordinaryFileError;
      },
    }];
  },
  async getFileHandle() {
    ordinaryErrorHandleLookups++;
    throw new Error('must not reacquire an unknown failure');
  },
};
const ordinaryErrorResult = await operations.readMarkdownFiles(ordinaryErrorDirectory);
assert.equal(ordinaryErrorGetFileCalls, 1, 'ordinary file failures are never retried');
assert.equal(ordinaryErrorHandleLookups, 0);
assert.equal(ordinaryErrorResult.issues[0].error, ordinaryFileError);

const partialEnumerationError = new Error('directory iterator failed');
const partialEnumerationResult = await operations.readMarkdownFiles({
  entries() {
    let index = 0;
    const names = ['2026-07-17.md', '2026-07-16.md', '2026-07-15.md'];
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (index === names.length) throw partialEnumerationError;
        const name = names[index++];
        return {
          done: false,
          value: [name, {
            kind: 'file',
            async getFile() {
              return {
                lastModified: index,
                async arrayBuffer() { return new TextEncoder().encode(name).buffer; },
              };
            },
          }],
        };
      },
    };
  },
}, { todayDate: '2026-07-17' });
assert.equal(partialEnumerationResult.files.length, 3, 'all handles discovered before an iterator failure converge');
assert.equal(partialEnumerationResult.issue, 'Chrome 无法继续扫描每日记录目录。');
assert.deepEqual(partialEnumerationResult.coverage, {
  enumerationDone: false,
  discoveredCount: 3,
  completedCount: 3,
  complete: false,
});

const fatalPermissionError = Object.assign(new Error('permission revoked'), { name: 'NotAllowedError' });
const fatalNames = [
  '2026-07-17.md',
  '2026-07-16.md',
  '2026-07-15.md',
  '2026-07-14.md',
  '2026-07-13.md',
  '2026-07-12.md',
];
const fatalGates = new Map(fatalNames.map(name => [name, deferred()]));
const fatalFirstWaveStarted = deferred();
const fatalWasObserved = deferred();
const fatalStartedNames = [];
let fatalScanSettled = false;
const fatalScanPromise = operations.readMarkdownFiles({
  async *entries() {
    for (const name of fatalNames) {
      yield [name, {
        kind: 'file',
        async getFile() {
          return {
            lastModified: 1,
            async arrayBuffer() {
              fatalStartedNames.push(name);
              if (fatalStartedNames.length === 4) fatalFirstWaveStarted.resolve();
              return fatalGates.get(name).promise;
            },
          };
        },
      }];
    }
  },
}, {
  todayDate: '2026-07-17',
  onProgress: detail => {
    if (detail.name === '2026-07-17.md') fatalWasObserved.resolve();
  },
});
fatalScanPromise.then(
  () => { fatalScanSettled = true; },
  () => { fatalScanSettled = true; }
);
await fatalFirstWaveStarted.promise;
fatalGates.get('2026-07-17.md').reject(fatalPermissionError);
await fatalWasObserved.promise;
assert.equal(fatalStartedNames.length, 4, 'fatal permission loss stops all replacement dequeues');
assert.equal(fatalScanSettled, false, 'fatal failure waits for every already-started read');
for (const name of fatalStartedNames.slice(1)) fatalGates.get(name).resolve(goodBytes.buffer);
await assert.rejects(fatalScanPromise, error => error === fatalPermissionError);
assert.equal(fatalStartedNames.length, 4, 'no queued file starts after a fatal permission failure');

function createNonBlockingCoreLockManager() {
  let held = false;
  const requests = [];
  return {
    requests,
    request(name, options, callback) {
      requests.push({ name, options });
      if (held) return Promise.resolve(callback(null));
      held = true;
      return Promise.resolve(callback({ name, mode: 'exclusive' }))
        .finally(() => { held = false; });
    },
  };
}

const coreLockManager = createNonBlockingCoreLockManager();
const leaderRelease = deferred();
const leaderStarted = deferred();
let leaderProducerRuns = 0;
let followerProducerRuns = 0;
const leaderResultPromise = operations.coordinateCoreRefresh(coreLockManager, async context => {
  leaderProducerRuns++;
  assert.deepEqual(context, { role: 'leader', shared: true });
  leaderStarted.resolve();
  await leaderRelease.promise;
  return 'fresh records';
});
await leaderStarted.promise;
const followerResult = await operations.coordinateCoreRefresh(coreLockManager, async () => {
  followerProducerRuns++;
  return 'must not run';
});
assert.deepEqual(followerResult, { role: 'follower', shared: true });
assert.equal(followerProducerRuns, 0, 'a follower never touches the directory producer');
assert.equal(coreLockManager.requests[0].name, operations.CORE_REFRESH_LOCK_NAME);
assert.deepEqual(coreLockManager.requests[0].options, { mode: 'exclusive', ifAvailable: true });
leaderRelease.resolve();
const leaderResult = await leaderResultPromise;
assert.deepEqual(leaderResult, { role: 'leader', shared: true, value: 'fresh records' });
assert.equal(leaderProducerRuns, 1);
await Promise.resolve();
assert.equal(followerProducerRuns, 0, 'an old follower does not take over after leader release');

let localProducerRuns = 0;
const localResult = await operations.coordinateCoreRefresh(undefined, async context => {
  localProducerRuns++;
  assert.deepEqual(context, { role: 'local', shared: false });
  return 'local records';
});
assert.deepEqual(localResult, { role: 'local', shared: false, value: 'local records' });
assert.equal(localProducerRuns, 1, 'missing Web Locks runs the local producer exactly once');

const lockAcquisitionError = new Error('lock manager unavailable');
let preCallbackFallbackRuns = 0;
const preCallbackFallback = await operations.coordinateCoreRefresh({
  request() { return Promise.reject(lockAcquisitionError); },
}, async context => {
  preCallbackFallbackRuns++;
  assert.deepEqual(context, { role: 'local', shared: false });
  return 'fallback records';
});
assert.equal(preCallbackFallback.role, 'local');
assert.equal(preCallbackFallback.value, 'fallback records');
assert.equal(preCallbackFallback.lockError, lockAcquisitionError);
assert.equal(preCallbackFallbackRuns, 1);

const producerFailure = new Error('leader scan failed');
let failedLeaderRuns = 0;
await assert.rejects(
  operations.coordinateCoreRefresh({
    request(name, options, callback) {
      return Promise.resolve(callback({ name, mode: options.mode }));
    },
  }, async () => {
    failedLeaderRuns++;
    throw producerFailure;
  }),
  error => error === producerFailure
);
assert.equal(failedLeaderRuns, 1, 'a callback-entered failure is never retried as a local scan');

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
