import assert from 'node:assert/strict';

await import('../chrome-newtab/photo-cache-library.js');
const cache = globalThis.MementoPhotoCache;

const {
  CACHE_SCHEMA,
  DB_NAME,
  DB_VERSION,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  STORE_NAME,
  cacheKey,
  createRepository,
} = cache;

assert.equal(DB_NAME, 'memento-photo-thumbnails');
assert.equal(DB_VERSION, 1);
assert.equal(STORE_NAME, 'thumbnails');
assert.equal(MAX_ENTRY_BYTES, 512 * 1024);
assert.equal(MAX_TOTAL_BYTES, 32 * 1024 * 1024);
assert.equal(MAX_ENTRIES, 96);

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitUntil(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

// A small asynchronous IndexedDB double with transactional staging. Chained
// requests created by onsuccess keep the transaction alive, matching the API
// pattern used by the production repository.
function createMemoryIndexedDB(initialEntries = []) {
  const data = new Map(initialEntries);
  const logs = [];
  let openCount = 0;
  let closeCount = 0;
  let failRule = null;

  function failNext(predicate, error = Object.assign(new Error('injected IDB failure'), {
    name: 'UnknownError',
  })) {
    failRule = { predicate, error };
  }

  async function openDB() {
    openCount++;
    return {
      onversionchange: null,
      close() { closeCount++; },
      transaction(storeName, mode) {
        assert.equal(storeName, STORE_NAME);
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
            assert.equal(name, STORE_NAME);
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
          log.operations.push(`${operation}:${String(key)}`);
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
          getAll() {
            return requestFor('getAll', '*', () => [...staged.values()]);
          },
          put(value) {
            assert.equal(mode, 'readwrite');
            return requestFor('put', value && value.key, () => {
              staged.set(value.key, value);
              return value.key;
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

  return {
    data,
    failNext,
    get closeCount() { return closeCount; },
    get openCount() { return openCount; },
    logs,
    openDB,
  };
}

function clock(start = 1) {
  let value = start;
  return () => value++;
}

function thumbnail(size = 128, type = 'image/webp') {
  return new Blob([new Uint8Array(size)], { type });
}

function input(bindingToken, assetName, variant = 'w480-webp-q72-v1', options = {}) {
  return {
    bindingToken,
    assetName,
    variant,
    blob: options.blob || thumbnail(options.size || 128),
    sourceSize: options.sourceSize ?? 2_000_000,
    sourceLastModified: options.sourceLastModified ?? 100,
    ...(options.validatedAt === undefined ? {} : { validatedAt: options.validatedAt }),
  };
}

function storedRecord(bindingToken, assetName, variant, options = {}) {
  const blob = options.blob || thumbnail(options.size || 128);
  return {
    schema: options.schema ?? CACHE_SCHEMA,
    key: cacheKey(bindingToken, assetName, variant),
    bindingToken,
    assetName,
    variant,
    blob,
    blobSize: options.blobSize ?? blob.size,
    sourceSize: options.sourceSize ?? 2_000_000,
    sourceLastModified: options.sourceLastModified ?? 100,
    createdAt: options.createdAt ?? 1,
    lastAccessedAt: options.lastAccessedAt ?? 1,
    validatedAt: options.validatedAt ?? 1,
  };
}

// Basic put/get and the full directory + asset + variant identity boundary.
const basicDB = createMemoryIndexedDB();
const basicRepo = createRepository({ openDB: basicDB.openDB, now: clock(10) });
const basicBlob = thumbnail(256);
const stored = await basicRepo.put(input('directory-a', 'portrait.jpg', 'w480-webp-q72-v1', {
  blob: basicBlob,
  sourceSize: 1234,
  sourceLastModified: 5678,
}));
assert.equal(stored.stored, true);
assert.equal(stored.totalEntries, 1);
assert.equal(stored.totalBytes, basicBlob.size);
assert.equal(basicDB.openCount, 1, 'one repository reuses its database connection');

const hit = await basicRepo.get('directory-a', 'portrait.jpg', 'w480-webp-q72-v1');
assert.ok(hit);
assert.equal(hit.blob, basicBlob);
assert.equal(hit.sourceSize, 1234);
assert.equal(hit.sourceLastModified, 5678);
assert.equal(await basicRepo.get('directory-b', 'portrait.jpg', 'w480-webp-q72-v1'), null);
assert.equal(await basicRepo.get('directory-a', 'portrait.jpg', 'w320-webp-q72-v1'), null);
assert.equal(await basicRepo.get('directory-a', 'other.jpg', 'w480-webp-q72-v1'), null);
assert.equal(await basicRepo.get('', 'portrait.jpg', 'w480-webp-q72-v1'), null);
assert.equal(await basicRepo.get('directory-a', '../portrait.jpg', 'w480-webp-q72-v1'), null);

// A slow encoder holding an older File snapshot cannot overwrite a newer
// thumbnail already committed by another Tab.
const staleWrite = await basicRepo.put(input(
  'directory-a',
  'portrait.jpg',
  'w480-webp-q72-v1',
  {
    blob: thumbnail(64),
    sourceSize: 1200,
    sourceLastModified: 5000,
  }
));
assert.equal(staleWrite.stored, false);
assert.equal(staleWrite.reason, 'stale-source');
const newestHit = await basicRepo.get('directory-a', 'portrait.jpg', 'w480-webp-q72-v1');
assert.equal(newestHit.blob, basicBlob);
assert.equal(newestHit.sourceLastModified, 5678);

// Touch is not part of the hit promise and any touch failure is swallowed.
const touchKey = cacheKey('touch-token', 'touch.jpg', 'w480-webp-q72-v1');
const touchRecord = storedRecord('touch-token', 'touch.jpg', 'w480-webp-q72-v1');
const touchDB = createMemoryIndexedDB([[touchKey, touchRecord]]);
const touchRepo = createRepository({ openDB: touchDB.openDB, now: () => 99 });
const unhandled = [];
const onUnhandled = reason => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
touchDB.failNext(({ operation, mode }) => operation === 'put' && mode === 'readwrite');
const touchHit = await touchRepo.get('touch-token', 'touch.jpg', 'w480-webp-q72-v1');
assert.equal(touchHit.blob, touchRecord.blob, 'a hit resolves before best-effort touch succeeds');
await flush();
await flush();
process.off('unhandledRejection', onUnhandled);
assert.deepEqual(unhandled, [], 'a failed best-effort touch never leaks an unhandled rejection');

// Current-schema corruption is a miss and is cleaned asynchronously. A future
// schema is also a miss, but rollback data is preserved.
const corruptKey = cacheKey('corrupt-token', 'broken.jpg', 'w480-webp-q72-v1');
const futureKey = cacheKey('future-token', 'future.jpg', 'w480-webp-q72-v1');
const corruptDB = createMemoryIndexedDB([
  [corruptKey, storedRecord('corrupt-token', 'broken.jpg', 'w480-webp-q72-v1', { blobSize: 999 })],
  [futureKey, storedRecord('future-token', 'future.jpg', 'w480-webp-q72-v1', { schema: 2 })],
]);
const corruptRepo = createRepository({ openDB: corruptDB.openDB });
assert.equal(await corruptRepo.get('corrupt-token', 'broken.jpg', 'w480-webp-q72-v1'), null);
await waitUntil(() => !corruptDB.data.has(corruptKey), 'corrupt v1 cache cleanup');
assert.equal(await corruptRepo.get('future-token', 'future.jpg', 'w480-webp-q72-v1'), null);
await flush();
assert.equal(corruptDB.data.has(futureKey), true, 'a future-schema record is preserved');
const futurePut = await corruptRepo.put(input('future-token', 'future.jpg'));
assert.equal(futurePut.stored, false);
assert.equal(futurePut.reason, 'future-schema');
assert.equal(corruptDB.data.get(futureKey).schema, 2, 'v1 put cannot overwrite a future record');

// Oversized/invalid entries fail before a transaction and never consume quota.
const rejectedDB = createMemoryIndexedDB();
const rejectedRepo = createRepository({ openDB: rejectedDB.openDB });
const oversized = await rejectedRepo.put(input('token', 'large.jpg', 'w480-webp-q72-v1', {
  blob: thumbnail(MAX_ENTRY_BYTES + 1),
}));
assert.deepEqual(oversized, { stored: false, reason: 'entry-too-large' });
assert.equal(rejectedDB.openCount, 0);
assert.equal((await rejectedRepo.put(input('token', 'empty.jpg', 'w480-webp-q72-v1', {
  blob: new Blob([], { type: 'image/webp' }),
}))).stored, false);
assert.equal((await rejectedRepo.put(input('token', 'bad.jpg', 'w480-webp-q72-v1', {
  sourceSize: -1,
}))).stored, false);

// Count LRU: the 97th entry atomically evicts the oldest current-schema item.
const countDB = createMemoryIndexedDB();
const countRepo = createRepository({ openDB: countDB.openDB, now: clock(1) });
for (let index = 0; index <= MAX_ENTRIES; index++) {
  const result = await countRepo.put(input('count-token', `photo-${String(index).padStart(3, '0')}.jpg`));
  assert.equal(result.stored, true);
}
assert.equal(countDB.data.size, MAX_ENTRIES);
assert.equal(countDB.data.has(cacheKey('count-token', 'photo-000.jpg', 'w480-webp-q72-v1')), false);
assert.equal(countDB.data.has(cacheKey('count-token', 'photo-096.jpg', 'w480-webp-q72-v1')), true);

// Byte LRU: 65 maximum-sized entries exceed 32 MiB, leaving exactly 64.
const byteDB = createMemoryIndexedDB();
const byteRepo = createRepository({ openDB: byteDB.openDB, now: clock(1) });
const maximumBlob = thumbnail(MAX_ENTRY_BYTES);
for (let index = 0; index < 65; index++) {
  const result = await byteRepo.put(input('byte-token', `photo-${String(index).padStart(3, '0')}.jpg`, 'w480-webp-q72-v1', {
    blob: maximumBlob,
  }));
  assert.equal(result.stored, true);
}
assert.equal(byteDB.data.size, MAX_TOTAL_BYTES / MAX_ENTRY_BYTES);
assert.equal(byteDB.data.has(cacheKey('byte-token', 'photo-000.jpg', 'w480-webp-q72-v1')), false);
const byteTotal = [...byteDB.data.values()].reduce((sum, entry) => sum + entry.blobSize, 0);
assert.equal(byteTotal, MAX_TOTAL_BYTES);

// Future-schema records are never eviction candidates. Current v1 entries
// remain independently bounded even when rollback data is present.
const preservedFutureKey = cacheKey('future-budget', 'keep.jpg', 'w480-webp-q72-v1');
const futureBudgetDB = createMemoryIndexedDB([
  [preservedFutureKey, storedRecord('future-budget', 'keep.jpg', 'w480-webp-q72-v1', { schema: 2 })],
]);
const futureBudgetRepo = createRepository({ openDB: futureBudgetDB.openDB, now: clock(1) });
for (let index = 0; index <= MAX_ENTRIES; index++) {
  await futureBudgetRepo.put(input('current-budget', `photo-${String(index).padStart(3, '0')}.jpg`));
}
assert.equal(futureBudgetDB.data.has(preservedFutureKey), true);
assert.equal(
  [...futureBudgetDB.data.values()].filter(entry => entry.schema === CACHE_SCHEMA).length,
  MAX_ENTRIES
);

// Precise deletion respects both token and variant; binding cleanup removes
// only keys whose canonical key belongs to that directory token.
const deleteDB = createMemoryIndexedDB();
const deleteRepo = createRepository({ openDB: deleteDB.openDB, now: clock(1) });
await deleteRepo.put(input('delete-a', 'same.jpg', 'w480-webp-q72-v1'));
await deleteRepo.put(input('delete-a', 'same.jpg', 'w320-webp-q72-v1'));
await deleteRepo.put(input('delete-b', 'same.jpg', 'w480-webp-q72-v1'));
assert.equal((await deleteRepo.delete('delete-a', 'same.jpg', 'w480-webp-q72-v1')).deleted, true);
assert.equal(await deleteRepo.get('delete-a', 'same.jpg', 'w480-webp-q72-v1'), null);
assert.ok(await deleteRepo.get('delete-a', 'same.jpg', 'w320-webp-q72-v1'));
assert.ok(await deleteRepo.get('delete-b', 'same.jpg', 'w480-webp-q72-v1'));
assert.equal((await deleteRepo.delete('delete-a', 'same.jpg', 'missing-variant')).deleted, false);
const deletedBinding = await deleteRepo.deleteBinding('delete-a');
assert.equal(deletedBinding.deleted, 1);
assert.equal(await deleteRepo.get('delete-a', 'same.jpg', 'w320-webp-q72-v1'), null);
assert.ok(await deleteRepo.get('delete-b', 'same.jpg', 'w480-webp-q72-v1'));

// clearMemory closes only the connection and pending touch bookkeeping. The
// persistent Blob remains available through the next connection/new Tab.
const beforeClearOpenCount = deleteDB.openCount;
deleteRepo.clearMemory();
assert.equal(deleteDB.closeCount, 1);
const afterClearHit = await deleteRepo.get('delete-b', 'same.jpg', 'w480-webp-q72-v1');
assert.ok(afterClearHit);
assert.equal(deleteDB.openCount, beforeClearOpenCount + 1);

// Real IndexedDB failures reject so the dashboard can explicitly fail open.
const readFailureDB = createMemoryIndexedDB();
const readFailureRepo = createRepository({ openDB: readFailureDB.openDB });
readFailureDB.failNext(({ operation }) => operation === 'get');
await assert.rejects(
  readFailureRepo.get('read-failure', 'photo.jpg', 'w480-webp-q72-v1'),
  /injected IDB failure/
);

const quotaDB = createMemoryIndexedDB();
const quotaRepo = createRepository({ openDB: quotaDB.openDB });
const quotaError = Object.assign(new Error('quota full'), { name: 'QuotaExceededError' });
quotaDB.failNext(({ operation }) => operation === 'put', quotaError);
await assert.rejects(
  quotaRepo.put(input('quota-token', 'photo.jpg')),
  error => error && error.name === 'QuotaExceededError'
);
assert.equal(quotaDB.data.size, 0, 'a failed put transaction publishes no partial entry');

console.log('✓ persistent photo cache: isolated Blob hits, strict validation, non-blocking touch, atomic LRU, exact deletion, and fail-open errors');
