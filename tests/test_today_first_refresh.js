import assert from 'node:assert/strict';

await import('../chrome-newtab/dashboard-operations-library.js');
const operations = globalThis.MementoDashboardOperations;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const todayFile = {
  name: '2026-07-18.md',
  date: '2026-07-18',
  mtime: 180,
  text: 'fresh today',
  bytes: new TextEncoder().encode('fresh today').buffer,
};

// The visible today commit completes before the history promise settles.
const historyGate = deferred();
const order = [];
const refresh = operations.startTodayFirstRefresh({
  isCurrent: () => true,
  async readToday() {
    order.push('today:read');
    return { file: todayFile, missing: false };
  },
  async commitToday(result) {
    assert.equal(result.file, todayFile);
    order.push('today:commit');
  },
  async startHistory() {
    order.push('history:start');
    return historyGate.promise;
  },
});
await flush();
assert.deepEqual(order, ['today:read', 'today:commit', 'history:start']);
historyGate.resolve({ role: 'leader' });
const refreshResult = await refresh;
assert.equal(refreshResult.historyStarted, true);
assert.deepEqual(refreshResult.historyResult, { role: 'leader' });

// A follower still performs and commits the point read before discovering the
// full-history lock is unavailable; its producer must never run.
let followerTodayReads = 0;
let followerTodayCommits = 0;
let followerHistoryProducer = 0;
const unavailableLockManager = {
  request(name, options, callback) {
    assert.equal(name, operations.CORE_REFRESH_LOCK_NAME);
    assert.equal(options.ifAvailable, true);
    return callback(null);
  },
};
const followerResult = await operations.startTodayFirstRefresh({
  isCurrent: () => true,
  async readToday() {
    followerTodayReads++;
    return { file: todayFile, missing: false };
  },
  async commitToday() { followerTodayCommits++; },
  startHistory: () => operations.coordinateCoreRefresh(unavailableLockManager, async () => {
    followerHistoryProducer++;
  }),
});
assert.equal(followerTodayReads, 1);
assert.equal(followerTodayCommits, 1);
assert.equal(followerHistoryProducer, 0);
assert.equal(followerResult.historyResult.role, 'follower');

// Retiring a page while its direct read is pending fences both commit and the
// later history start.
const staleGate = deferred();
let staleCurrent = true;
let staleCommits = 0;
let staleHistoryStarts = 0;
const staleRefresh = operations.startTodayFirstRefresh({
  isCurrent: () => staleCurrent,
  readToday: () => staleGate.promise,
  async commitToday() { staleCommits++; },
  async startHistory() { staleHistoryStarts++; },
});
await flush();
staleCurrent = false;
staleGate.resolve({ file: todayFile, missing: false });
const staleResult = await staleRefresh;
assert.equal(staleResult.stale, true);
assert.equal(staleCommits, 0);
assert.equal(staleHistoryStarts, 0);

// Permission failures are not downgraded and cannot open a history scan.
const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
let deniedHistoryStarts = 0;
await assert.rejects(
  operations.startTodayFirstRefresh({
    isCurrent: () => true,
    async readToday() { throw denied; },
    async commitToday() {},
    async startHistory() { deniedHistoryStarts++; },
  }),
  error => error === denied
);
assert.equal(deniedHistoryStarts, 0);

const cachedHistory = {
  name: '2026-07-17.md',
  date: '2026-07-17',
  mtime: 100,
  text: 'history',
};
const cachedToday = { ...todayFile, mtime: 120, text: 'stale today' };
const base = [cachedToday, cachedHistory];

const unresolved = operations.mergeCachedFilesWithTodayProbe(base, {
  todayDate: '2026-07-18',
  resolved: false,
});
assert.deepEqual(unresolved, base, 'unresolved null never means today is absent');

const replaced = operations.mergeCachedFilesWithTodayProbe(base, {
  todayDate: '2026-07-18',
  resolved: true,
  probedAt: 200,
  file: todayFile,
});
assert.equal(replaced.filter(file => file.name === todayFile.name).length, 1);
assert.equal(replaced.find(file => file.name === todayFile.name), todayFile);

const removed = operations.mergeCachedFilesWithTodayProbe(base, {
  todayDate: '2026-07-18',
  resolved: true,
  probedAt: 200,
  file: null,
});
assert.deepEqual(removed, [cachedHistory], 'a confirmed NotFound removes stale cached today');

const createdAfterProbe = { ...cachedToday, mtime: 201, text: 'created later' };
const preservedNewer = operations.mergeCachedFilesWithTodayProbe([createdAfterProbe, cachedHistory], {
  todayDate: '2026-07-18',
  resolved: true,
  probedAt: 200,
  file: null,
});
assert.equal(preservedNewer[0], createdAfterProbe, 'a file created after the tombstone wins');

console.log('✓ today-first refresh: point-read commit precedes history, followers stay fresh, and stale work is fenced');
