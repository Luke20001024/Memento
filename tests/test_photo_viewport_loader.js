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
  await Promise.resolve();
}

function fakeObserverHarness() {
  let callback = null;
  const observed = [];
  const unobserved = [];
  let disconnects = 0;
  return {
    createObserver(nextCallback) {
      callback = nextCallback;
      return {
        observe(element) { observed.push(element); },
        unobserve(element) { unobserved.push(element); },
        disconnect() { disconnects++; },
      };
    },
    emit(entries) {
      assert.equal(typeof callback, 'function', 'observer callback is installed before entries arrive');
      callback(entries);
    },
    observed,
    unobserved,
    disconnectCount: () => disconnects,
  };
}

function item(id) {
  return { id, assetName: `${id}.jpg` };
}

// Registering a month is side-effect free. Only near-viewport entries enter
// the loader; later intersection events model scrolling without wall clocks.
const viewportObserver = fakeObserverHarness();
const viewportTargets = Array.from({ length: 6 }, (_, index) => ({ id: `target-${index}` }));
const viewportItems = viewportTargets.map((_, index) => item(`photo-${index}`));
const viewportGates = viewportItems.map(() => deferred());
const viewportStarted = [];
const viewportStates = [];
const viewport = photos.createViewportLoader({
  createObserver: callback => viewportObserver.createObserver(callback),
  load: async current => {
    const index = viewportItems.indexOf(current);
    viewportStarted.push(current.id);
    return viewportGates[index].promise;
  },
  onState(element, current, state) {
    viewportStates.push(`${current.id}:${state}`);
  },
});

viewportTargets.forEach((target, index) => {
  assert.equal(viewport.observe(target, viewportItems[index]), true);
});
assert.equal(
  viewport.observe(viewportTargets[0], viewportItems[0]),
  false,
  'observing the same element twice cannot overwrite its in-flight contract'
);
assert.deepEqual(viewportObserver.observed, viewportTargets);
assert.deepEqual(viewportStarted, [], 'observing a whole month performs no eager reads');

viewportObserver.emit([
  { target: viewportTargets[0], isIntersecting: true, intersectionRatio: 1 },
  { target: viewportTargets[1], isIntersecting: true, intersectionRatio: 0.2 },
  { target: viewportTargets[2], isIntersecting: false, intersectionRatio: 0 },
]);
await flush();
assert.deepEqual(viewportStarted, ['photo-0', 'photo-1']);
assert.equal(viewport.state(viewportTargets[2]), 'idle');
assert.deepEqual(viewportObserver.unobserved, [viewportTargets[0], viewportTargets[1]]);

// A second callback represents scrolling. Re-emitting an already admitted
// target must reuse its original promise instead of starting another read.
viewportObserver.emit([
  { target: viewportTargets[0], isIntersecting: true, intersectionRatio: 1 },
  { target: viewportTargets[2], isIntersecting: true, intersectionRatio: 1 },
  { target: viewportTargets[3], isIntersecting: false, intersectionRatio: 0 },
]);
await flush();
assert.deepEqual(viewportStarted, ['photo-0', 'photo-1', 'photo-2']);
assert.equal(viewportStarted.filter(id => id === 'photo-0').length, 1, 'duplicate intersection is deduplicated');
assert.equal(viewport.state(viewportTargets[3]), 'idle');

for (const index of [0, 1, 2]) viewportGates[index].resolve({ ok: true });
await Promise.all([0, 1, 2].map(index => viewport.request(viewportTargets[index])));
assert.deepEqual(
  [0, 1, 2].map(index => viewport.state(viewportTargets[index])),
  ['ready', 'ready', 'ready']
);
assert.equal(viewportStates.filter(value => value === 'photo-0:loading').length, 1);
assert.equal(viewportStates.filter(value => value === 'photo-0:ready').length, 1);

// Closing a drawer disconnects observation immediately. An unavoidable
// already-started promise may settle, but its late result cannot commit state.
const stopObserver = fakeObserverHarness();
const stopTarget = { id: 'stop-target' };
const stopGate = deferred();
const stopStates = [];
let stopLoads = 0;
const stoppedViewport = photos.createViewportLoader({
  createObserver: callback => stopObserver.createObserver(callback),
  load: async () => {
    stopLoads++;
    return stopGate.promise;
  },
  onState(element, current, state) { stopStates.push(state); },
});
stoppedViewport.observe(stopTarget, item('stop'));
stopObserver.emit([{ target: stopTarget, isIntersecting: true, intersectionRatio: 1 }]);
await flush();
assert.equal(stopLoads, 1);
const stoppedPending = stoppedViewport.request(stopTarget);
stoppedViewport.stop();
assert.equal(stopObserver.disconnectCount(), 1);
stopObserver.emit([{ target: stopTarget, isIntersecting: true, intersectionRatio: 1 }]);
stopGate.resolve({ ok: true });
const stoppedResult = await stoppedPending;
assert.equal(stoppedResult.stale, true);
assert.deepEqual(stopStates, ['loading'], 'a late active result does not commit ready/error after stop');
assert.equal(stopLoads, 1);
assert.equal(stoppedViewport.state(stopTarget), 'missing');

// Permission loss is terminal across separate viewport callbacks. Once one
// visible card reports it, future scroll events must not start more FSA work.
const deniedObserver = fakeObserverHarness();
const deniedTargets = [{ id: 'denied-1' }, { id: 'denied-2' }, { id: 'denied-3' }];
const deniedItems = [item('denied-1'), item('denied-2'), item('denied-3')];
const deniedGate = deferred();
const deniedStarted = [];
const deniedStates = [];
const deniedViewport = photos.createViewportLoader({
  createObserver: callback => deniedObserver.createObserver(callback),
  load: async current => {
    deniedStarted.push(current.id);
    if (current.id === 'denied-1') return deniedGate.promise;
    return { ok: true };
  },
  onState(element, current, state, result) {
    deniedStates.push({ id: current.id, state, result });
  },
});
deniedTargets.forEach((target, index) => deniedViewport.observe(target, deniedItems[index]));
deniedObserver.emit([{ target: deniedTargets[0], isIntersecting: true, intersectionRatio: 1 }]);
await flush();
assert.deepEqual(deniedStarted, ['denied-1']);
deniedGate.resolve({ ok: false, permissionLost: true, reason: '访问权限已失效' });
await deniedViewport.request(deniedTargets[0]);
assert.equal(deniedObserver.disconnectCount(), 1);
assert.equal(deniedViewport.state(deniedTargets[1]), 'error');
assert.equal(
  deniedStates.some(entry => entry.id === 'denied-2'
    && entry.state === 'error'
    && entry.result?.terminal
    && entry.result?.skipped),
  true,
  'unseen cards are marked paused by the terminal permission failure'
);
deniedObserver.emit([
  { target: deniedTargets[1], isIntersecting: true, intersectionRatio: 1 },
  { target: deniedTargets[2], isIntersecting: true, intersectionRatio: 1 },
]);
await flush();
assert.deepEqual(deniedStarted, ['denied-1'], 'permission loss remains fused across later scroll batches');
assert.equal(deniedViewport.observe({ id: 'after-denied' }, item('after-denied')), false);
deniedViewport.stop();
assert.equal(deniedViewport.state(deniedTargets[0]), 'missing', 'explicit cleanup releases terminal tracking');
assert.equal(deniedObserver.disconnectCount(), 1, 'terminal cleanup disconnects the observer exactly once');

// IntersectionObserver is an optimization, not a correctness dependency. If
// the API is absent (or construction fails), observation falls back to load.
const fallbackStarted = [];
const fallbackStates = [];
const fallbackViewport = photos.createViewportLoader({
  load: async current => {
    fallbackStarted.push(current.id);
    return { ok: true };
  },
  onState(element, current, state) { fallbackStates.push(`${current.id}:${state}`); },
});
fallbackViewport.observe({ id: 'fallback-a' }, item('fallback-a'));
fallbackViewport.observe({ id: 'fallback-b' }, item('fallback-b'));
await flush();
assert.deepEqual(fallbackStarted, ['fallback-a', 'fallback-b']);
assert.equal(fallbackStates.includes('fallback-a:ready'), true);
assert.equal(fallbackStates.includes('fallback-b:ready'), true);

let throwingObserverAttempts = 0;
const throwingFallbackStarted = [];
const throwingFallback = photos.createViewportLoader({
  createObserver() {
    throwingObserverAttempts++;
    throw new Error('IntersectionObserver unavailable');
  },
  load: async current => {
    throwingFallbackStarted.push(current.id);
    return { ok: true };
  },
});
throwingFallback.observe({ id: 'fallback-throw' }, item('fallback-throw'));
await flush();
assert.equal(throwingObserverAttempts, 1);
assert.deepEqual(throwingFallbackStarted, ['fallback-throw']);

console.log('✓ photo viewport loader: near-screen admission, scroll, dedupe, stop fencing, permission fuse, and observer fallback');
