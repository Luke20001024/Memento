import assert from 'node:assert/strict';

await import('../chrome-newtab/dashboard-operations-library.js');
const operations = globalThis.MementoDashboardOperations;

const LEGACY_TIMEOUT_MS = 20;

const displayEntries = [
  { id: 'older-day', date: '2026-07-16', time: '23:59', sourceIndex: 9 },
  { id: 'same-minute-first', date: '2026-07-17', time: '11:02', sourceIndex: 0 },
  { id: 'latest', date: '2026-07-17', time: '17:08', sourceIndex: 5 },
  { id: 'same-minute-later', date: '2026-07-17', time: '11:02', sourceIndex: 1 },
  { id: 'missing-time', date: '2026-07-17', time: '', sourceIndex: 6 },
  { id: 'newer-day', date: '2026-07-18', time: '08:00', sourceIndex: 0 },
];
assert.deepEqual(
  [...displayEntries]
    .sort(operations.compareEntriesNewestFirst)
    .map(entry => entry.id),
  [
    'newer-day',
    'latest',
    'same-minute-later',
    'same-minute-first',
    'missing-time',
    'older-day',
  ],
  'records are displayed by date and time descending, with later same-minute blocks first'
);

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

let directEntriesCalls = 0;
let directLookupCalls = 0;
let directArrayBufferCalls = 0;
const directBytes = new TextEncoder().encode('# today direct');
const directToday = await operations.readTodayMarkdownFile({
  entries() {
    directEntriesCalls++;
    throw new Error('today direct read must not enumerate the directory');
  },
  async getFileHandle(name) {
    directLookupCalls++;
    assert.equal(name, '2026-07-18.md');
    return {
      async getFile() {
        return {
          lastModified: 18,
          async arrayBuffer() {
            directArrayBufferCalls++;
            return directBytes.buffer;
          },
        };
      },
    };
  },
}, '2026-07-18', { isCurrent: () => true });
assert.equal(directEntriesCalls, 0, 'today direct read bypasses root enumeration');
assert.equal(directLookupCalls, 1);
assert.equal(directArrayBufferCalls, 1);
assert.equal(directToday.missing, false);
assert.deepEqual(
  {
    name: directToday.file.name,
    date: directToday.file.date,
    mtime: directToday.file.mtime,
    text: directToday.file.text,
  },
  {
    name: '2026-07-18.md',
    date: '2026-07-18',
    mtime: 18,
    text: '# today direct',
  }
);

const directMissing = await operations.readTodayMarkdownFile({
  async getFileHandle() { throw missingError; },
}, '2026-07-18');
assert.deepEqual(directMissing, { file: null, missing: true });

for (const retryErrorName of ['NotReadableError', 'NotFoundError']) {
  const transientError = Object.assign(new Error(`transient ${retryErrorName}`), { name: retryErrorName });
  let lookups = 0;
  let firstSnapshotReads = 0;
  let replacementSnapshotReads = 0;
  const retryBytes = new TextEncoder().encode(`# recovered ${retryErrorName}`);
  const retried = await operations.readTodayMarkdownFile({
    async getFileHandle(name) {
      lookups++;
      assert.equal(name, '2026-07-18.md');
      if (lookups === 1) {
        return {
          async getFile() {
            return {
              lastModified: 1,
              async arrayBuffer() {
                firstSnapshotReads++;
                throw transientError;
              },
            };
          },
        };
      }
      return {
        async getFile() {
          return {
            lastModified: 2,
            async arrayBuffer() {
              replacementSnapshotReads++;
              return retryBytes.buffer;
            },
          };
        },
      };
    },
  }, '2026-07-18');
  assert.equal(lookups, 2, `${retryErrorName} reacquires the exact child once`);
  assert.equal(firstSnapshotReads, 1);
  assert.equal(replacementSnapshotReads, 1);
  assert.equal(retried.file.text, `# recovered ${retryErrorName}`);
  assert.equal(retried.file.mtime, 2);
}

const directPermissionError = Object.assign(new Error('today permission revoked'), { name: 'NotAllowedError' });
await assert.rejects(
  operations.readTodayMarkdownFile({
    async getFileHandle() { throw directPermissionError; },
  }, '2026-07-18'),
  error => error === directPermissionError,
  'today permission loss is escalated to the directory recovery boundary'
);

let todayGenerationCurrent = true;
let staleTodayArrayBufferCalls = 0;
const staleToday = await operations.readTodayMarkdownFile({
  async getFileHandle() {
    return {
      async getFile() {
        todayGenerationCurrent = false;
        return {
          lastModified: 18,
          async arrayBuffer() {
            staleTodayArrayBufferCalls++;
            return directBytes.buffer;
          },
        };
      },
    };
  },
}, '2026-07-18', { isCurrent: () => todayGenerationCurrent });
assert.deepEqual(staleToday, { file: null, stale: true });
assert.equal(
  staleTodayArrayBufferCalls,
  0,
  'a generation retired after getFile does not start the separate arrayBuffer operation'
);

let seededTodayGetFileCalls = 0;
let seededHistoryGetFileCalls = 0;
const seededDeliveries = [];
const seededScan = await operations.readMarkdownFiles({
  async *entries() {
    yield ['2026-07-18.md', {
      kind: 'file',
      async getFile() {
        seededTodayGetFileCalls++;
        throw new Error('the preloaded today snapshot must not be reopened');
      },
    }];
    yield ['2026-07-17.md', {
      kind: 'file',
      async getFile() {
        seededHistoryGetFileCalls++;
        return {
          lastModified: 17,
          async arrayBuffer() { return goodBytes.buffer; },
        };
      },
    }];
  },
}, {
  todayDate: '2026-07-18',
  seedFiles: [directToday.file],
  onFile: detail => seededDeliveries.push(detail),
});
assert.equal(seededTodayGetFileCalls, 0, 'an enumerated seed is counted without a second physical read');
assert.equal(seededHistoryGetFileCalls, 1);
assert.deepEqual(seededScan.files.map(file => file.name), ['2026-07-18.md', '2026-07-17.md']);
assert.equal(seededScan.files[0], directToday.file, 'the complete scan reuses the exact direct snapshot');
assert.deepEqual(seededScan.coverage, {
  enumerationDone: true,
  discoveredCount: 2,
  completedCount: 2,
  complete: true,
});
assert.equal(seededDeliveries.length, 2);
assert.equal(seededDeliveries.find(detail => detail.isToday).file, directToday.file);

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

// Cache-first startup has an explicit paint boundary: a valid last-known-good
// view is allowed to reach the renderer before any live File System Access
// refresh starts. Deferred barriers make this an ordering assertion rather
// than a machine-speed assertion.
const cacheHitHydration = deferred();
const cacheHitPaint = deferred();
const cacheHitPaintEntered = deferred();
const cacheHitEvents = [];
let cacheHitWaitingRuns = 0;
let cacheHitRefreshRuns = 0;
const cacheHitStartupPromise = operations.startCacheFirstRefresh({
  cacheFirst: true,
  async hydrateCache() {
    cacheHitEvents.push('hydrate:start');
    const hit = await cacheHitHydration.promise;
    cacheHitEvents.push('cache:shown');
    return hit;
  },
  showWaiting() {
    cacheHitWaitingRuns++;
    cacheHitEvents.push('waiting');
  },
  afterFirstPaint() {
    cacheHitEvents.push('paint:pending');
    cacheHitPaintEntered.resolve();
    return cacheHitPaint.promise;
  },
  startRefresh() {
    assert.equal(cacheHitEvents.includes('cache:shown'), true, 'cache is committed before live refresh');
    cacheHitRefreshRuns++;
    cacheHitEvents.push('refresh');
    return 'background-started';
  },
  isCurrent: () => true,
});
assert.deepEqual(cacheHitEvents, ['hydrate:start']);
assert.equal(cacheHitWaitingRuns, 0);
assert.equal(cacheHitRefreshRuns, 0);
cacheHitHydration.resolve(true);
await cacheHitPaintEntered.promise;
assert.deepEqual(cacheHitEvents, ['hydrate:start', 'cache:shown', 'paint:pending']);
assert.equal(cacheHitWaitingRuns, 0, 'a cache hit never flashes an empty waiting view');
assert.equal(cacheHitRefreshRuns, 0, 'live refresh cannot start before the explicit paint barrier');
cacheHitPaint.resolve();
const cacheHitStartup = await cacheHitStartupPromise;
assert.deepEqual(cacheHitEvents, ['hydrate:start', 'cache:shown', 'paint:pending', 'refresh']);
assert.equal(cacheHitRefreshRuns, 1);
assert.deepEqual(cacheHitStartup, {
  started: true,
  stale: false,
  cacheHit: true,
  refreshResult: 'background-started',
});

const cacheMissEvents = [];
let cacheMissPaintRuns = 0;
const cacheMissStartup = await operations.startCacheFirstRefresh({
  cacheFirst: true,
  async hydrateCache() {
    cacheMissEvents.push('hydrate');
    return false;
  },
  showWaiting() { cacheMissEvents.push('waiting'); },
  afterFirstPaint() { cacheMissPaintRuns++; },
  startRefresh() {
    cacheMissEvents.push('refresh');
    return 'live-after-miss';
  },
  isCurrent: () => true,
});
assert.deepEqual(cacheMissEvents, ['hydrate', 'waiting', 'refresh']);
assert.equal(cacheMissPaintRuns, 0, 'a miss does not wait for a cache paint that never happened');
assert.deepEqual(cacheMissStartup, {
  started: true,
  stale: false,
  cacheHit: false,
  refreshResult: 'live-after-miss',
});

const cacheStartupFailure = new Error('cache database unavailable');
const cacheFailureEvents = [];
const cacheFailureStartup = await operations.startCacheFirstRefresh({
  cacheFirst: true,
  async hydrateCache() { throw cacheStartupFailure; },
  showWaiting() { cacheFailureEvents.push('waiting'); },
  afterFirstPaint() { throw new Error('a failed cache has nothing to paint'); },
  startRefresh() { cacheFailureEvents.push('refresh'); },
  isCurrent: () => true,
});
assert.deepEqual(cacheFailureEvents, ['waiting', 'refresh']);
assert.equal(cacheFailureStartup.started, true);
assert.equal(cacheFailureStartup.cacheHit, false);
assert.equal(cacheFailureStartup.cacheError, cacheStartupFailure);

let uncachedHydrationRuns = 0;
let uncachedPaintRuns = 0;
const uncachedNeverHydrates = deferred();
const uncachedEvents = [];
const uncachedStartup = await operations.startCacheFirstRefresh({
  cacheFirst: false,
  hydrateCache() {
    uncachedHydrationRuns++;
    return uncachedNeverHydrates.promise;
  },
  showWaiting() { uncachedEvents.push('waiting'); },
  afterFirstPaint() { uncachedPaintRuns++; },
  startRefresh() {
    uncachedEvents.push('refresh');
    return 'new-selection-live';
  },
  isCurrent: () => true,
});
assert.deepEqual(uncachedEvents, ['waiting', 'refresh']);
assert.equal(uncachedHydrationRuns, 0, 'a new selection never touches a potentially pending old cache');
assert.equal(uncachedPaintRuns, 0, 'an uncached start has no cache paint barrier');
assert.equal(uncachedStartup.refreshResult, 'new-selection-live');

const boundedHydration = deferred();
const cacheDecisionDeadline = deferred();
const boundedEvents = [];
let boundedRefreshRuns = 0;
const boundedStartupPromise = operations.startCacheFirstRefresh({
  cacheFirst: true,
  async hydrateCache() {
    boundedEvents.push('hydrate:start');
    const hit = await boundedHydration.promise;
    boundedEvents.push('cache:late');
    return hit;
  },
  waitForCache: hydrationPromise => Promise.race([
    hydrationPromise,
    cacheDecisionDeadline.promise.then(() => false),
  ]),
  showWaiting() { boundedEvents.push('waiting'); },
  afterFirstPaint() { throw new Error('a cache outside the decision window cannot block live refresh'); },
  startRefresh() {
    boundedRefreshRuns++;
    boundedEvents.push('refresh');
  },
  isCurrent: () => true,
});
await Promise.resolve();
assert.deepEqual(boundedEvents, ['hydrate:start']);
assert.equal(boundedRefreshRuns, 0);
cacheDecisionDeadline.resolve();
const boundedStartup = await boundedStartupPromise;
assert.equal(boundedStartup.started, true);
assert.equal(boundedStartup.cacheHit, false);
assert.deepEqual(boundedEvents, ['hydrate:start', 'waiting', 'refresh']);
boundedHydration.resolve(true);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(
  boundedEvents,
  ['hydrate:start', 'waiting', 'refresh', 'cache:late'],
  'the deadline does not cancel the underlying cache lookup'
);
assert.equal(boundedRefreshRuns, 1, 'a late cache settlement cannot start a second live refresh');

let sharedVisible = false;
let sharedWaitingRuns = 0;
let sharedRefreshRuns = 0;
let sharedPaintRuns = 0;
const sharedDuringHydration = deferred();
const sharedStartupPromise = operations.startCacheFirstRefresh({
  cacheFirst: true,
  hydrateCache: () => sharedDuringHydration.promise,
  hasVisibleContent: () => sharedVisible,
  shouldRefresh: () => !sharedVisible,
  showWaiting() { sharedWaitingRuns++; },
  async afterFirstPaint() { sharedPaintRuns++; },
  startRefresh() { sharedRefreshRuns++; },
  isCurrent: () => true,
});
sharedVisible = true;
sharedDuringHydration.resolve(false);
assert.deepEqual(await sharedStartupPromise, {
  started: false,
  stale: false,
  cacheHit: false,
  refreshSkipped: true,
});
assert.equal(sharedWaitingRuns, 0, 'a shared snapshot cannot be overwritten by an empty waiting view');
assert.equal(sharedPaintRuns, 1, 'the shared view receives the same first-paint opportunity');
assert.equal(sharedRefreshRuns, 0, 'a verified shared snapshot needs no duplicate local scan');

let sharedDuringPaint = false;
let sharedPaintRefreshRuns = 0;
const cachePaintGate = deferred();
const cachePaintEntered = deferred();
const sharedDuringPaintPromise = operations.startCacheFirstRefresh({
  cacheFirst: true,
  hydrateCache: async () => true,
  hasVisibleContent: () => true,
  shouldRefresh: () => !sharedDuringPaint,
  showWaiting() { throw new Error('cache hit must remain visible'); },
  afterFirstPaint() {
    cachePaintEntered.resolve();
    return cachePaintGate.promise;
  },
  startRefresh() { sharedPaintRefreshRuns++; },
  isCurrent: () => true,
});
await cachePaintEntered.promise;
sharedDuringPaint = true;
cachePaintGate.resolve();
assert.deepEqual(await sharedDuringPaintPromise, {
  started: false,
  stale: false,
  cacheHit: true,
  refreshSkipped: true,
});
assert.equal(sharedPaintRefreshRuns, 0, 'shared publication during cache paint suppresses a redundant scan');

let paintGenerationCurrent = true;
let stalePaintRefreshRuns = 0;
const stalePaintGate = deferred();
const stalePaintEntered = deferred();
const staleDuringPaintPromise = operations.startCacheFirstRefresh({
  cacheFirst: true,
  hydrateCache: async () => true,
  showWaiting() { throw new Error('a cache hit must not show waiting'); },
  afterFirstPaint() {
    stalePaintEntered.resolve();
    return stalePaintGate.promise;
  },
  startRefresh() { stalePaintRefreshRuns++; },
  isCurrent: () => paintGenerationCurrent,
});
await stalePaintEntered.promise;
paintGenerationCurrent = false;
stalePaintGate.resolve();
assert.deepEqual(await staleDuringPaintPromise, {
  started: false,
  stale: true,
  cacheHit: true,
});
assert.equal(stalePaintRefreshRuns, 0, 'a generation retired during paint never starts live reads');

let hydrationGenerationCurrent = true;
let staleHydrationPaintRuns = 0;
let staleHydrationWaitingRuns = 0;
let staleHydrationRefreshRuns = 0;
const staleHydrationGate = deferred();
const staleDuringHydrationPromise = operations.startCacheFirstRefresh({
  cacheFirst: true,
  hydrateCache: () => staleHydrationGate.promise,
  showWaiting() { staleHydrationWaitingRuns++; },
  afterFirstPaint() { staleHydrationPaintRuns++; },
  startRefresh() { staleHydrationRefreshRuns++; },
  isCurrent: () => hydrationGenerationCurrent,
});
hydrationGenerationCurrent = false;
staleHydrationGate.resolve(true);
assert.deepEqual(await staleDuringHydrationPromise, {
  started: false,
  stale: true,
  cacheHit: true,
});
assert.equal(staleHydrationWaitingRuns, 0);
assert.equal(staleHydrationPaintRuns, 0);
assert.equal(staleHydrationRefreshRuns, 0, 'a generation retired during hydration performs no later work');

const cachedHistory = [
  { name: '2026-07-16.md', text: 'cached history' },
  { name: '2026-07-17.md', text: 'stale today' },
];
const liveToday = { name: '2026-07-17.md', text: 'live today' };
assert.deepEqual(
  operations.mergeCachedFilesWithToday(cachedHistory, liveToday),
  [cachedHistory[0], liveToday],
  'a late cache fills history without overwriting the already-read live today file'
);
assert.deepEqual(
  operations.mergeCachedFilesWithToday(cachedHistory, null),
  cachedHistory,
  'an ordinary cache hit preserves the complete last-known-good snapshot'
);
assert.notEqual(
  operations.mergeCachedFilesWithToday(cachedHistory, null),
  cachedHistory,
  'callers cannot mutate the repository-owned cache array through the rendered view'
);

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

console.log('✓ dashboard operations: orders newest records first, waits for delayed reads, degrades real file errors, serializes archive mutations, and tolerates persistence failure');
