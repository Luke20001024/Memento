import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../chrome-newtab/dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('const OPTIONAL_FILE_READ_CONCURRENCY = 3;');
const end = source.indexOf('async function readOptionalDashboardData', start);
assert.ok(start >= 0 && end > start, 'optional read helpers are present');

const helpers = new Function(`
  function fileReadIssue(error, fallback) { return fallback; }
  ${source.slice(start, end)}
  return { createOptionalReadCoordinator, listOptionalTextFiles };
`)();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`${label} did not become true`);
}

function makeDirectory(prefix, count, tracker, behavior = {}) {
  const entries = Array.from({ length: count }, (_, index) => {
    const name = `2026-07-${String(index + 1).padStart(2, '0')}-${prefix}.md`;
    return [name, {
      kind: 'file',
      async getFile() {
        tracker.started.push(name);
        tracker.active++;
        tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
        return {
          lastModified: index + 1,
          async text() {
            try {
              if (behavior.failName === name) throw behavior.error;
              await tracker.gates[name].promise;
              return name;
            } finally {
              tracker.active--;
            }
          },
        };
      },
    }];
  });
  return {
    entries() {
      return (async function* iterate() {
        for (const entry of entries) yield entry;
      })();
    },
  };
}

function trackerFor(prefixes, count) {
  const names = prefixes.flatMap(prefix =>
    Array.from({ length: count }, (_, index) =>
      `2026-07-${String(index + 1).padStart(2, '0')}-${prefix}.md`
    )
  );
  return {
    active: 0,
    maxActive: 0,
    started: [],
    gates: Object.fromEntries(names.map(name => [name, deferred()])),
  };
}

function readOptions(coordinator, isCurrent = () => true) {
  return {
    coordinator,
    isCurrent,
    namePattern: /^\d{4}-\d{2}-\d{2}-.+\.md$/,
    extensionPattern: /\.md$/,
    fileIssue: 'file issue',
    scanIssue: 'scan issue',
  };
}

const sharedTracker = trackerFor(['review', 'status'], 4);
const sharedCoordinator = helpers.createOptionalReadCoordinator();
const sharedOptions = readOptions(sharedCoordinator);
const reviewPromise = helpers.listOptionalTextFiles(
  makeDirectory('review', 4, sharedTracker),
  sharedOptions
);
const statusPromise = helpers.listOptionalTextFiles(
  makeDirectory('status', 4, sharedTracker),
  sharedOptions
);
await waitUntil(() => sharedTracker.started.length === 3, 'three shared optional reads starting');
assert.equal(sharedTracker.maxActive, 3, 'Review and status share one global three-slot pool');
Object.values(sharedTracker.gates).forEach(gate => gate.resolve());
const [reviewResult, statusResult] = await Promise.all([reviewPromise, statusPromise]);
assert.equal(reviewResult.files.length, 4);
assert.equal(statusResult.files.length, 4);
assert.equal(sharedTracker.maxActive, 3);

const staleTracker = trackerFor(['stale'], 6);
const freshTracker = trackerFor(['fresh'], 6);
let current = true;
const staleCoordinator = helpers.createOptionalReadCoordinator({ isCurrent: () => current });
const stalePromise = helpers.listOptionalTextFiles(
  makeDirectory('stale', 6, staleTracker),
  readOptions(staleCoordinator, () => current)
);
await waitUntil(() => staleTracker.started.length === 3, 'stale optional reads starting');
current = false;
const freshCoordinator = helpers.createOptionalReadCoordinator();
const freshPromise = helpers.listOptionalTextFiles(
  makeDirectory('fresh', 6, freshTracker),
  readOptions(freshCoordinator)
);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(freshTracker.started.length, 0, 'a new directory cannot open a second optional three-slot pool');
Object.values(staleTracker.gates).forEach(gate => gate.resolve());
const staleResult = await stalePromise;
assert.equal(staleTracker.started.length, 3, 'directory generation change stops queued optional reads');
assert.equal(staleResult.stale, true);
await waitUntil(() => freshTracker.started.length === 3, 'fresh optional reads starting after stale reads settle');
Object.values(freshTracker.gates).forEach(gate => gate.resolve());
assert.equal((await freshPromise).files.length, 6);

const monthTracker = {
  started: [],
  gates: {
    '2026-07-17-review.md': deferred(),
    '2026-07-18-review.md': deferred(),
  },
};
const monthDirectory = {
  entries() {
    return (async function* iterate() {
      for (const name of [
        '2026-06-30-review.md',
        '2026-07-17-review.md',
        '2026-07-18-review.md',
      ]) {
        yield [name, {
          kind: 'file',
          async getFile() {
            monthTracker.started.push(name);
            return {
              lastModified: 1,
              async text() {
                await monthTracker.gates[name].promise;
                return name;
              },
            };
          },
        }];
      }
    })();
  },
};
const published = [];
let monthBatchSettled = false;
const monthPromise = helpers.listOptionalTextFiles(monthDirectory, {
  ...readOptions(helpers.createOptionalReadCoordinator()),
  datePrefix: '2026-07',
  onFile: file => published.push(file.name),
}).then(result => {
  monthBatchSettled = true;
  return result;
});
await waitUntil(() => monthTracker.started.length === 2, 'selected-month reads starting');
assert.equal(
  monthTracker.started.includes('2026-06-30-review.md'),
  false,
  'a selected month never opens Review files from another month'
);
monthTracker.gates['2026-07-17-review.md'].resolve();
await waitUntil(() => published.length === 1, 'first Review publishing incrementally');
assert.equal(monthBatchSettled, false, 'one Review becomes visible before a slower sibling settles');
monthTracker.gates['2026-07-18-review.md'].resolve();
assert.deepEqual((await monthPromise).files.map(file => file.name), [
  '2026-07-18-review.md',
  '2026-07-17-review.md',
]);

const denied = Object.assign(new Error('permission removed'), { name: 'NotAllowedError' });
const fatalTracker = trackerFor(['fatal', 'other'], 5);
const fatalName = '2026-07-01-fatal.md';
const fatalCoordinator = helpers.createOptionalReadCoordinator();
const fatalOptions = readOptions(fatalCoordinator);
const fatalReads = Promise.allSettled([
  helpers.listOptionalTextFiles(
    makeDirectory('fatal', 5, fatalTracker, { failName: fatalName, error: denied }),
    fatalOptions
  ),
  helpers.listOptionalTextFiles(makeDirectory('other', 5, fatalTracker), fatalOptions),
]);
Object.values(fatalTracker.gates).forEach(gate => gate.resolve());
const fatalResults = await fatalReads;
assert.ok(fatalResults.some(result => result.status === 'rejected' && result.reason === denied));
assert.ok(fatalTracker.started.length <= 3, 'permission loss prevents every queued optional read from starting');
assert.equal(fatalTracker.active, 0, 'already-started optional reads settle before the batch returns');

console.log('✓ optional reads: shared pool, selected-month scope, incremental publish, and permission convergence');
