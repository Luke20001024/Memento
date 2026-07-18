import assert from 'node:assert/strict';

await import('../chrome-newtab/photo-library.js');
const photos = globalThis.MementoPhotos;

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

async function settleWithin(promise, label, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`${label} did not become true`);
}

function record(name) {
  return { assetName: `${name}.jpg` };
}

const urlsCreated = [];
const urlsRevoked = [];
const loader = photos.createAssetLoader({
  concurrency: 3,
  maxEntries: 8,
  createObjectURL(file) {
    const url = `blob:${file.name}`;
    urlsCreated.push(url);
    return url;
  },
  revokeObjectURL(url) {
    urlsRevoked.push(url);
  },
});

const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const gates = Object.fromEntries(names.map(name => [name, deferred()]));
const fileReads = Object.fromEntries(names.map(name => [name, 0]));
const started = [];
const rendered = [];
let activeReads = 0;
let maxActiveReads = 0;

async function loadFile(item) {
  const name = item.assetName.replace(/\.jpg$/, '');
  fileReads[name]++;
  started.push(name);
  activeReads++;
  maxActiveReads = Math.max(maxActiveReads, activeReads);
  try {
    await gates[name].promise;
    return { name: `${name}.jpg`, size: 100, lastModified: 1 };
  } finally {
    activeReads--;
  }
}

const firstBatch = loader.loadBatch(names.slice(0, 6).map(record), {
  loadFile,
  async onReady(asset, item) {
    rendered.push(item.assetName.replace(/\.jpg$/, ''));
    return { ok: true, url: asset.url };
  },
});
await flush();
assert.deepEqual(started, ['a', 'b', 'c'], 'the shared photo loader starts exactly three tasks');

const overlappingBatch = loader.loadBatch([record('a'), record('b'), record('g')], {
  loadFile,
  async onReady(asset, item) {
    rendered.push(`overlap:${item.assetName.replace(/\.jpg$/, '')}`);
    return { ok: true, url: asset.url };
  },
});

gates.b.resolve();
await waitUntil(() => started.includes('d'), 'the fourth photo starting');
assert.deepEqual(rendered, ['b'], 'one completed photo renders before the batch finishes');
assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'a completed photo immediately opens the next slot');

for (const name of ['a', 'c', 'd', 'e', 'f']) gates[name].resolve();
await flush();
gates.g.resolve();
await settleWithin(Promise.all([firstBatch, overlappingBatch]), 'overlapping photo batches');
assert.equal(maxActiveReads, 3, 'overlapping drawer renders share one global three-slot pool');
for (const name of names) assert.equal(fileReads[name], 1, `${name} is physically read once`);
assert.equal(new Set(urlsCreated).size, 7, 'each unique photo owns one object URL');

await loader.loadBatch([record('a'), record('g')], {
  loadFile,
  onReady: async () => ({ ok: true }),
});
assert.equal(fileReads.a, 1, 'a warm same-tab reopen reuses the resolved cache');
assert.equal(fileReads.g, 1, 'the warm cache also covers later photos');
assert.equal(urlsCreated.length, 7);

loader.clear();
assert.equal(loader.cacheSize(), 0);
assert.deepEqual(new Set(urlsRevoked), new Set(urlsCreated), 'clear revokes every cached URL');
const revokeCount = urlsRevoked.length;
loader.clear();
assert.equal(urlsRevoked.length, revokeCount, 'repeated clear never revokes a URL twice');

const immediateClearLoader = photos.createAssetLoader({
  concurrency: 1,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: () => {},
});
let immediateClearReads = 0;
const immediatelyCleared = immediateClearLoader.loadBatch([record('cleared-before-start')], {
  loadFile: async item => {
    immediateClearReads++;
    return { name: item.assetName, size: 1, lastModified: 1 };
  },
  onReady: async () => ({ ok: true }),
});
immediateClearLoader.clear();
const immediateClearResults = await settleWithin(immediatelyCleared, 'immediate directory clear');
assert.equal(immediateClearReads, 0, 'clear before the task microtask prevents the old directory read');
assert.equal(immediateClearResults[0].stale, true);

const stagedClearLoader = photos.createAssetLoader({
  concurrency: 1,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: () => {},
});
const stagedGate = deferred();
let stagedSecondRead = 0;
const stagedBatch = stagedClearLoader.loadBatch([record('staged-clear')], {
  async loadFile(item, isDirectoryCurrent) {
    await stagedGate.promise;
    if (!isDirectoryCurrent()) {
      const stale = new Error('directory changed');
      stale.name = 'AbortError';
      throw stale;
    }
    stagedSecondRead++;
    return { name: item.assetName, size: 1, lastModified: 1 };
  },
  onReady: async () => ({ ok: true }),
});
await flush();
stagedClearLoader.clear();
stagedGate.resolve();
const stagedResults = await settleWithin(stagedBatch, 'mid-read directory clear');
assert.equal(stagedSecondRead, 0, 'a directory epoch check prevents the next physical read stage');
assert.equal(stagedResults[0].stale, true);

const rerenderLoader = photos.createAssetLoader({
  concurrency: 3,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: () => {},
});
const rerenderGate = deferred();
let firstRenderCurrent = true;
let rerenderReads = 0;
const staleRender = [];
const currentRender = [];
const staleBatch = rerenderLoader.loadBatch([record('rerender')], {
  loadFile: async item => {
    rerenderReads++;
    await rerenderGate.promise;
    return { name: item.assetName, size: 1, lastModified: 1 };
  },
  isCurrent: () => firstRenderCurrent,
  onReady: async () => {
    staleRender.push('stale');
    return { ok: true };
  },
});
await flush();
firstRenderCurrent = false;
const freshBatch = rerenderLoader.loadBatch([record('rerender')], {
  loadFile: async item => {
    rerenderReads++;
    return { name: item.assetName, size: 1, lastModified: 1 };
  },
  onReady: async () => {
    currentRender.push('fresh');
    return { ok: true };
  },
});
rerenderGate.resolve();
await settleWithin(Promise.all([staleBatch, freshBatch]), 'hydration rerender reuse');
assert.equal(rerenderReads, 1, 'a hydration rerender reuses the active physical read');
assert.deepEqual(staleRender, []);
assert.deepEqual(currentRender, ['fresh']);

const switchCreated = [];
const switchRevoked = [];
const switchLoader = photos.createAssetLoader({
  concurrency: 1,
  createObjectURL(file) {
    const url = `blob:${file.scope}`;
    switchCreated.push(url);
    return url;
  },
  revokeObjectURL(url) {
    switchRevoked.push(url);
  },
});
const oldGate = deferred();
const oldRendered = [];
const oldBatch = switchLoader.loadBatch([record('same')], {
  loadFile: async () => {
    await oldGate.promise;
    return { scope: 'old', size: 1, lastModified: 1 };
  },
  onReady: async () => {
    oldRendered.push('old');
    return { ok: true };
  },
});
await flush();
switchLoader.clear();
const newRendered = [];
const newBatch = switchLoader.loadBatch([record('same')], {
  loadFile: async () => ({ scope: 'new', size: 1, lastModified: 2 }),
  onReady: async () => {
    newRendered.push('new');
    return { ok: true };
  },
});
oldGate.resolve();
await settleWithin(Promise.all([oldBatch, newBatch]), 'directory switch photo load');
assert.deepEqual(oldRendered, [], 'a late old-directory photo cannot render');
assert.deepEqual(newRendered, ['new']);
assert.deepEqual(switchCreated, ['blob:new'], 'the stale old file never creates a URL');
assert.deepEqual(switchRevoked, []);

const lruRevoked = [];
const lruLoader = photos.createAssetLoader({
  concurrency: 2,
  maxEntries: 2,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: url => lruRevoked.push(url),
});
const immediateFile = async item => ({ name: item.assetName, size: 1, lastModified: 1 });
await lruLoader.loadBatch([record('lru-a'), record('lru-b')], {
  loadFile: immediateFile,
  onReady: async () => ({ ok: true }),
});
await lruLoader.loadBatch([record('lru-a')], {
  loadFile: immediateFile,
  onReady: async () => ({ ok: true }),
});
await lruLoader.loadBatch([record('lru-c')], {
  loadFile: immediateFile,
  onReady: async () => ({ ok: true }),
});
assert.deepEqual(lruRevoked, ['blob:lru-b.jpg'], 'the least-recently-used URL is revoked at the cache bound');
assert.equal(lruLoader.cacheSize(), 2);

const pinnedRevoked = [];
const pinnedLoader = photos.createAssetLoader({
  concurrency: 2,
  maxEntries: 1,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: url => pinnedRevoked.push(url),
});
const pinnedReadyGate = deferred();
const pinnedReady = [];
const pinnedBatch = pinnedLoader.loadBatch([record('pin-a'), record('pin-b')], {
  loadFile: immediateFile,
  async onReady(asset) {
    pinnedReady.push(asset.url);
    await pinnedReadyGate.promise;
    return { ok: true };
  },
});
await waitUntil(() => pinnedReady.length === 2, 'both pinned photos entering onReady');
assert.deepEqual(pinnedRevoked, [], 'LRU never revokes a URL while onReady/decode is using it');
pinnedReadyGate.resolve();
await settleWithin(pinnedBatch, 'pinned LRU batch');
assert.equal(pinnedRevoked.length, 1, 'LRU trims back to its configured bound after active use');
assert.equal(pinnedLoader.cacheSize(), 1);

const permissionLoader = photos.createAssetLoader({
  concurrency: 3,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: () => {},
});
const permissionGates = [deferred(), deferred(), deferred()];
const permissionStarted = [];
const permissionBatch = permissionLoader.loadBatch(
  ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(record),
  {
    async loadFile(item) {
      const index = Number(item.assetName.match(/\d+/)[0]) - 1;
      permissionStarted.push(item.assetName);
      await permissionGates[index].promise;
      return { name: item.assetName, size: 1, lastModified: 1 };
    },
    onReady: async () => ({ ok: true }),
  }
);
await flush();
const denied = Object.assign(new Error('permission removed'), { name: 'NotAllowedError' });
permissionGates[0].reject(denied);
await flush();
permissionGates[1].resolve();
permissionGates[2].resolve();
const permissionResults = await settleWithin(permissionBatch, 'permission failure batch');
assert.deepEqual(permissionStarted, ['p1.jpg', 'p2.jpg', 'p3.jpg']);
assert.equal(permissionResults[0].permissionLost, true);
assert.equal(permissionResults.slice(3).every(result => result.skipped), true);

const missingLoader = photos.createAssetLoader({
  concurrency: 2,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: () => {},
});
const missingStarted = [];
const missing = Object.assign(new Error('missing'), { name: 'NotFoundError' });
const missingResults = await missingLoader.loadBatch(['m1', 'm2', 'm3'].map(record), {
  async loadFile(item) {
    missingStarted.push(item.assetName);
    if (item.assetName === 'm1.jpg') throw missing;
    return { name: item.assetName, size: 1, lastModified: 1 };
  },
  onReady: async () => ({ ok: true }),
});
assert.deepEqual(missingStarted, ['m1.jpg', 'm2.jpg', 'm3.jpg']);
assert.equal(missingResults[0].permissionLost, false);
assert.equal(missingResults[1].ok, true);
assert.equal(missingResults[2].ok, true);

// Thumbnail generation is fully injectable, so resize/encoding contracts and
// resource cleanup can be proven in Node without decoding a real image.
const thumbnailSource = {
  name: 'portrait-original.jpg',
  size: 2_000_000,
  lastModified: 10,
  type: 'image/jpeg',
};
const thumbnailBlob = {
  name: 'portrait-thumbnail.webp',
  size: 48_000,
  type: 'image/webp',
};
let thumbnailBitmapCloseCalls = 0;
const thumbnailBitmap = {
  width: 480,
  height: 270,
  close() { thumbnailBitmapCloseCalls++; },
};
let thumbnailCanvasWidth = -1;
let thumbnailCanvasHeight = -1;
let thumbnailDrawArgs = null;
const thumbnailCanvas = {
  get width() { return thumbnailCanvasWidth; },
  set width(value) { thumbnailCanvasWidth = value; },
  get height() { return thumbnailCanvasHeight; },
  set height(value) { thumbnailCanvasHeight = value; },
  getContext(type) {
    assert.equal(type, '2d');
    return {
      drawImage(...args) { thumbnailDrawArgs = args; },
    };
  },
};
const thumbnailCalls = [];
const makeThumbnail = photos.createThumbnailer({
  maxWidth: 480,
  type: 'image/webp',
  quality: 0.72,
  async createImageBitmap(file, options) {
    thumbnailCalls.push({ stage: 'bitmap', file, options });
    return thumbnailBitmap;
  },
  createCanvas(width, height) {
    thumbnailCalls.push({ stage: 'canvas', width, height });
    thumbnailCanvasWidth = width;
    thumbnailCanvasHeight = height;
    return thumbnailCanvas;
  },
  async encodeCanvas(canvas, options) {
    thumbnailCalls.push({ stage: 'encode', canvas, options });
    return thumbnailBlob;
  },
});
const preparedThumbnail = await makeThumbnail(thumbnailSource, record('thumbnail-success'));
assert.equal(preparedThumbnail, thumbnailBlob, 'a successful thumbnail replaces the original display blob');
assert.deepEqual(thumbnailCalls[0], {
  stage: 'bitmap',
  file: thumbnailSource,
  options: {
    imageOrientation: 'from-image',
    resizeWidth: 480,
    resizeQuality: 'high',
  },
});
assert.deepEqual(thumbnailCalls[1], { stage: 'canvas', width: 480, height: 270 });
assert.equal(thumbnailCalls[2].stage, 'encode');
assert.equal(thumbnailCalls[2].canvas, thumbnailCanvas);
assert.deepEqual(thumbnailCalls[2].options, { type: 'image/webp', quality: 0.72 });
assert.deepEqual(thumbnailDrawArgs, [thumbnailBitmap, 0, 0, 480, 270]);
assert.equal(thumbnailBitmapCloseCalls, 1, 'the decoded bitmap is closed after successful encoding');
assert.equal(thumbnailCanvasWidth, 0, 'the temporary canvas backing store is released');
assert.equal(thumbnailCanvasHeight, 0);

const thumbnailFailure = new Error('WebP encoder failed');
let failedBitmapCloseCalls = 0;
let failedCanvasWidth = -1;
let failedCanvasHeight = -1;
const reportedThumbnailErrors = [];
const failedThumbnailer = photos.createThumbnailer({
  maxWidth: 480,
  type: 'image/webp',
  quality: 0.72,
  async createImageBitmap() {
    return {
      width: 480,
      height: 270,
      close() { failedBitmapCloseCalls++; },
    };
  },
  createCanvas(width, height) {
    failedCanvasWidth = width;
    failedCanvasHeight = height;
    return {
      get width() { return failedCanvasWidth; },
      set width(value) { failedCanvasWidth = value; },
      get height() { return failedCanvasHeight; },
      set height(value) { failedCanvasHeight = value; },
      getContext: () => ({ drawImage() {} }),
    };
  },
  async encodeCanvas() { throw thumbnailFailure; },
  onError(error, currentRecord) { reportedThumbnailErrors.push({ error, currentRecord }); },
});
const failedThumbnail = await failedThumbnailer(thumbnailSource, record('thumbnail-failure'));
assert.equal(failedThumbnail, thumbnailSource, 'thumbnail failure falls back to the original local File');
assert.equal(failedBitmapCloseCalls, 1, 'a failed encoder still closes its bitmap');
assert.equal(failedCanvasWidth, 0, 'a failed encoder still releases its canvas');
assert.equal(failedCanvasHeight, 0);
assert.equal(reportedThumbnailErrors.length, 1);
assert.equal(reportedThumbnailErrors[0].error, thumbnailFailure);

const unsupportedThumbnailer = photos.createThumbnailer({});
assert.equal(
  await unsupportedThumbnailer(thumbnailSource, record('thumbnail-unsupported')),
  thumbnailSource,
  'missing bitmap/canvas APIs degrade to the original image'
);

// prepareFile executes inside the existing keyed in-flight operation. Two
// overlapping renders of one asset share the physical read, thumbnail work,
// derived Blob URL, and cache entry.
const prepareGate = deferred();
const prepareEntered = deferred();
const derivedForLoader = {
  name: 'prepared.webp',
  size: 32_000,
  type: 'image/webp',
};
let preparedPhysicalReads = 0;
let prepareFileCalls = 0;
const preparedUrlInputs = [];
const preparedUrlsRevoked = [];
const preparedReadyAssets = [];
const preparedLoader = photos.createAssetLoader({
  concurrency: 3,
  async prepareFile(file, currentRecord, isCurrent) {
    prepareFileCalls++;
    assert.equal(file, thumbnailSource);
    assert.equal(currentRecord.assetName, 'prepared.jpg');
    assert.equal(isCurrent(), true);
    prepareEntered.resolve();
    await prepareGate.promise;
    assert.equal(isCurrent(), true);
    return derivedForLoader;
  },
  createObjectURL(file) {
    preparedUrlInputs.push(file);
    return 'blob:prepared-thumbnail';
  },
  revokeObjectURL(url) { preparedUrlsRevoked.push(url); },
});
const preparedLoadOptions = {
  async loadFile() {
    preparedPhysicalReads++;
    return thumbnailSource;
  },
  async onReady(asset) {
    preparedReadyAssets.push(asset);
    return { ok: true };
  },
};
const firstPreparedBatch = preparedLoader.loadBatch([record('prepared')], preparedLoadOptions);
await prepareEntered.promise;
const overlappingPreparedBatch = preparedLoader.loadBatch([record('prepared')], preparedLoadOptions);
await flush();
assert.equal(preparedPhysicalReads, 1);
assert.equal(prepareFileCalls, 1, 'overlap shares thumbnail generation as well as file I/O');
assert.deepEqual(preparedUrlInputs, [], 'the object URL waits for the derived Blob');
prepareGate.resolve();
const [firstPreparedResults, overlappingPreparedResults] = await settleWithin(
  Promise.all([firstPreparedBatch, overlappingPreparedBatch]),
  'overlapping prepared photo batches'
);
assert.equal(firstPreparedResults[0].ok, true);
assert.equal(overlappingPreparedResults[0].ok, true);
assert.deepEqual(preparedUrlInputs, [derivedForLoader], 'the cache URL is created from the thumbnail Blob');
assert.equal(preparedReadyAssets.length, 2, 'each current consumer renders the shared prepared asset');
assert.equal(preparedReadyAssets[0], preparedReadyAssets[1]);
assert.equal(preparedReadyAssets[0].size, derivedForLoader.size);
assert.equal(preparedReadyAssets[0].sourceSize, thumbnailSource.size);
preparedLoader.clear();
assert.deepEqual(preparedUrlsRevoked, ['blob:prepared-thumbnail']);

// A second loader models a brand-new Tab. Its persistent hit must happen
// before any File System Access or thumbnail work.
const crossTabSource = {
  name: 'cross-tab.jpg',
  size: 1_800_000,
  lastModified: 456,
  type: 'image/jpeg',
};
const crossTabThumbnail = new Blob([new Uint8Array(24_000)], { type: 'image/webp' });
let crossTabPersistent = null;
let crossTabReads = 0;
let crossTabPrepares = 0;
let crossTabStores = 0;
const crossTabUrlInputs = [];
const crossTabLoaderOptions = {
  async loadPersistent() {
    return crossTabPersistent && {
      blob: crossTabPersistent,
      sourceSize: crossTabSource.size,
      sourceLastModified: crossTabSource.lastModified,
    };
  },
  async storePersistent(blob) {
    crossTabStores++;
    crossTabPersistent = blob;
    return { stored: true };
  },
  async prepareFile() {
    crossTabPrepares++;
    return crossTabThumbnail;
  },
  createObjectURL(blob) {
    crossTabUrlInputs.push(blob);
    return `blob:cross-tab-${crossTabUrlInputs.length}`;
  },
  revokeObjectURL() {},
};
const crossTabBatchOptions = {
  async loadFile() {
    crossTabReads++;
    return crossTabSource;
  },
  onReady: async () => ({ ok: true }),
};
const coldTabLoader = photos.createAssetLoader(crossTabLoaderOptions);
await coldTabLoader.loadBatch([record('cross-tab')], crossTabBatchOptions);
await waitUntil(() => crossTabPersistent === crossTabThumbnail, 'background thumbnail persistence');
assert.equal(crossTabReads, 1);
assert.equal(crossTabPrepares, 1);
assert.equal(crossTabStores, 1);
coldTabLoader.clear();

const warmTabLoader = photos.createAssetLoader(crossTabLoaderOptions);
const warmTabResult = await warmTabLoader.loadBatch([record('cross-tab')], crossTabBatchOptions);
assert.equal(warmTabResult[0].ok, true);
assert.equal(warmTabResult[0].asset.persistentHit, true);
assert.equal(crossTabReads, 1, 'a cross-Tab hit performs zero additional FSA reads');
assert.equal(crossTabPrepares, 1, 'a cross-Tab hit performs zero additional resize/encode work');
assert.equal(crossTabStores, 1);
assert.equal(crossTabUrlInputs.at(-1), crossTabThumbnail);

// Persistent storage is optional. Read or quota failures fail open, and an
// original-File fallback is never written as a thumbnail.
const persistentStages = [];
let fallbackReads = 0;
let fallbackStores = 0;
const failOpenLoader = photos.createAssetLoader({
  async loadPersistent() { throw new Error('IDB read failed'); },
  async storePersistent() {
    fallbackStores++;
    throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  },
  async prepareFile() { return crossTabThumbnail; },
  onPersistentError(error, currentRecord, stage) { persistentStages.push(stage); },
  createObjectURL: () => 'blob:fail-open',
  revokeObjectURL() {},
});
const failOpenResult = await failOpenLoader.loadBatch([record('fail-open')], {
  async loadFile() {
    fallbackReads++;
    return crossTabSource;
  },
  onReady: async () => ({ ok: true }),
});
assert.equal(failOpenResult[0].ok, true);
await waitUntil(() => persistentStages.includes('write'), 'caught quota failure');
assert.deepEqual(persistentStages, ['read', 'write']);
assert.equal(fallbackReads, 1);
assert.equal(fallbackStores, 1);

let originalFallbackStores = 0;
const originalFallbackLoader = photos.createAssetLoader({
  loadPersistent: async () => null,
  prepareFile: async file => file,
  async storePersistent() { originalFallbackStores++; },
  createObjectURL: () => 'blob:original-fallback',
  revokeObjectURL() {},
});
await originalFallbackLoader.loadBatch([record('original-fallback')], {
  loadFile: async () => crossTabSource,
  onReady: async () => ({ ok: true }),
});
await flush();
assert.equal(originalFallbackStores, 0, 'a multi-megabyte original fallback is never persisted');

// Deleting a bad cache entry during one consumer's decode must not revoke the
// shared URL while another consumer still has it pinned.
const pinnedDeleteGate = deferred();
const pinnedDeleteEntered = deferred();
const pinnedDeleteRevoked = [];
let pinnedDeleteReadyCount = 0;
const pinnedDeleteRecord = record('pinned-delete');
const pinnedDeleteLoader = photos.createAssetLoader({
  concurrency: 2,
  createObjectURL: file => `blob:${file.name}`,
  revokeObjectURL: url => pinnedDeleteRevoked.push(url),
});
const pinnedDeleteOptions = {
  loadFile: immediateFile,
  async onReady(asset) {
    pinnedDeleteReadyCount++;
    if (pinnedDeleteReadyCount === 2) pinnedDeleteEntered.resolve();
    await pinnedDeleteGate.promise;
    return { ok: true, asset };
  },
};
const pinnedDeleteFirst = pinnedDeleteLoader.loadBatch([pinnedDeleteRecord], pinnedDeleteOptions);
const pinnedDeleteSecond = pinnedDeleteLoader.loadBatch([pinnedDeleteRecord], pinnedDeleteOptions);
await pinnedDeleteEntered.promise;
assert.equal(
  pinnedDeleteLoader.deleteAsset(pinnedDeleteRecord, 'blob:pinned-delete.jpg'),
  true
);
assert.deepEqual(pinnedDeleteRevoked, [], 'a shared URL remains valid while either decode is active');
pinnedDeleteGate.resolve();
await settleWithin(Promise.all([pinnedDeleteFirst, pinnedDeleteSecond]), 'pinned delete');
assert.deepEqual(pinnedDeleteRevoked, ['blob:pinned-delete.jpg'], 'the retired URL is revoked after its last pin releases');

console.log('✓ photo asset loader: global 3-way progress, thumbnail preparation, in-flight reuse, warm cache, safe clearing, and permission convergence');
