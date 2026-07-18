import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../chrome-newtab/dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('const archiveReadQueue = []');
const end = source.indexOf('function extractTitle', start);
assert.ok(start >= 0 && end > start, 'archive reader is present');

const archive = new Function('errorKind', `
  const ARCHIVE_READ_CONCURRENCY = 3;
  const ARCHIVE_TITLE_SCAN_BYTES = 256 * 1024;
  const window = { MementoDashboardOperations: { errorKind } };
  function extractTitle(html, fallback) {
    const match = String(html).match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
    return match && match[1].trim() || fallback;
  }
  ${source.slice(start, end)}
  return { readArchiveItems };
`)(error => {
  if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return 'permission';
  if (error && error.name === 'NotFoundError') return 'missing';
  return 'other';
});

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
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`${label} did not become true`);
}

function makeEntries(count, tracker, failure = null) {
  return Array.from({ length: count }, (_, index) => {
    const name = `archive-${index + 1}.html`;
    return {
      name,
      handle: {
        async getFile() {
          tracker.fileReads[name] = (tracker.fileReads[name] || 0) + 1;
          tracker.started.push(name);
          if (failure && failure.name === name) throw failure.error;
          const readText = async () => {
            tracker.textReads[name] = (tracker.textReads[name] || 0) + 1;
            tracker.active++;
            tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
            try {
              await tracker.gates[name].promise;
              return `<title>Title ${index + 1}</title>`;
            } finally {
              tracker.active--;
            }
          };
          return {
            lastModified: index + 1,
            text: readText,
            slice(startOffset, endOffset) {
              tracker.sliceEnds.push(endOffset);
              return { text: readText };
            },
          };
        },
      },
    };
  });
}

function makeTracker(count) {
  const names = Array.from({ length: count }, (_, index) => `archive-${index + 1}.html`);
  return {
    active: 0,
    maxActive: 0,
    started: [],
    fileReads: {},
    textReads: {},
    sliceEnds: [],
    gates: Object.fromEntries(names.map(name => [name, deferred()])),
  };
}

// A completed title must be published immediately; the list must not wait for
// the slowest file or Promise.all before its first useful row appears.
const progressiveTracker = makeTracker(7);
const progressiveItems = [];
let progressiveSettled = false;
const progressivePromise = archive.readArchiveItems(makeEntries(7, progressiveTracker), {
  onItem: item => progressiveItems.push(item),
});
progressivePromise.finally(() => { progressiveSettled = true; });
await waitUntil(() => progressiveTracker.started.length === 3, 'three archive reads starting');
assert.equal(progressiveTracker.maxActive, 3);
progressiveTracker.gates['archive-1.html'].resolve();
await waitUntil(() => progressiveItems.length === 1, 'first archive row publishing progressively');
assert.equal(progressiveSettled, false, 'first visible archive row does not wait for the full batch');
assert.equal(progressiveItems[0].name, 'archive-1.html');
Object.values(progressiveTracker.gates).forEach(gate => gate.resolve());
const progressiveResult = await progressivePromise;
assert.equal(progressiveResult.length, 7);
assert.equal(progressiveTracker.maxActive, 3, 'archive title reads stay within three slots');
for (const reads of Object.values(progressiveTracker.fileReads)) {
  assert.equal(reads, 1, 'each archive file is opened once');
}
assert.equal(
  progressiveTracker.sliceEnds.every(endOffset => endOffset === 256 * 1024),
  true,
  'title parsing only reads the bounded file prefix'
);
assert.equal(progressiveResult[0].title, 'Title 7', 'final items retain newest-first mtime ordering');

// An unchanged file only needs getFile() for lastModified. Re-reading its HTML
// title would turn every drawer open into an avoidable full-content scan.
const cachedTracker = makeTracker(3);
const cachedItems = [1, 2, 3].map(index => ({
  name: `archive-${index}.html`,
  title: `Cached ${index}`,
  mtime: index,
}));
const cachedPublished = [];
const cachedResult = await archive.readArchiveItems(makeEntries(3, cachedTracker), {
  cachedItems,
  onItem: item => cachedPublished.push(item),
});
assert.deepEqual(cachedResult.map(item => item.title), ['Cached 3', 'Cached 2', 'Cached 1']);
assert.equal(cachedPublished.length, 3, 'unchanged cached rows are still progressively confirmed');
assert.equal(Object.keys(cachedTracker.textReads).length, 0, 'unchanged cached titles skip file.text()');
assert.equal(cachedTracker.sliceEnds.length, 0, 'unchanged cached titles skip prefix blobs too');

// One File System Access call can remain pending indefinitely in Chrome. It may
// occupy one slot, but the other two slots must keep publishing every other row.
const pendingTracker = makeTracker(5);
const pendingItems = [];
let pendingSettled = false;
const pendingPromise = archive.readArchiveItems(makeEntries(5, pendingTracker), {
  onItem: item => pendingItems.push(item),
});
pendingPromise.finally(() => { pendingSettled = true; });
await waitUntil(() => pendingTracker.started.length === 3, 'pending scenario starting three reads');
pendingTracker.gates['archive-2.html'].resolve();
pendingTracker.gates['archive-3.html'].resolve();
await waitUntil(() => pendingTracker.started.length >= 5, 'other reads advancing around the pending file');
pendingTracker.gates['archive-4.html'].resolve();
pendingTracker.gates['archive-5.html'].resolve();
await waitUntil(() => pendingItems.length === 4, 'all non-pending archive rows publishing');
assert.equal(pendingSettled, false, 'one pending file does not falsely complete the batch');
assert.deepEqual(
  new Set(pendingItems.map(item => item.name)),
  new Set(['archive-2.html', 'archive-3.html', 'archive-4.html', 'archive-5.html']),
  'one pending archive does not prevent other rows from appearing'
);
pendingTracker.gates['archive-1.html'].resolve();
assert.equal((await pendingPromise).length, 5);

const denied = Object.assign(new Error('permission removed'), { name: 'NotAllowedError' });
const deniedTracker = makeTracker(6);
const deniedPromise = archive.readArchiveItems(
  makeEntries(6, deniedTracker, { name: 'archive-1.html', error: denied })
);
Object.values(deniedTracker.gates).forEach(gate => gate.resolve());
await assert.rejects(deniedPromise, error => error === denied);
assert.ok(deniedTracker.started.length <= 3, 'permission failure stops queued archive reads');

// Closing/switching a directory invalidates future queued reads, while an
// already-started broker call is allowed to settle without spawning more work.
const staleTracker = makeTracker(6);
let current = true;
const stalePublished = [];
const stalePromise = archive.readArchiveItems(makeEntries(6, staleTracker), {
  isCurrent: () => current,
  onItem: item => stalePublished.push(item),
});
await waitUntil(() => staleTracker.started.length === 3, 'stale archive reads starting');
current = false;
Object.values(staleTracker.gates).forEach(gate => gate.resolve());
assert.equal(await stalePromise, null);
assert.equal(staleTracker.started.length, 3, 'invalidated archive reads do not start queued work');
assert.equal(stalePublished.length, 0, 'invalidated archive reads do not repaint old rows');

console.log('✓ archive reads: progressive rows, cached-title reuse, pending isolation, and shared 3-way pool');
