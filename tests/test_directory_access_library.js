import assert from 'node:assert/strict';

await import('../chrome-newtab/directory-access-library.js');
const access = globalThis.MementoDirectoryAccess;

const handle = { name: 'AISecretary' };

let queried = false;
let loaded = false;
let result = await access.restore({
  loadHandle: async () => null,
  queryPermission: async () => { queried = true; },
  loadDirectory: async () => { loaded = true; },
});
assert.equal(result.kind, 'missing');
assert.equal(queried, false);
assert.equal(loaded, false);

const storageFailure = Object.assign(new Error('database unavailable'), { name: 'UnknownError' });
result = await access.restore({
  loadHandle: async () => { throw storageFailure; },
  queryPermission: async () => 'granted',
  loadDirectory: async () => {},
});
assert.equal(result.kind, 'storage-error');
assert.equal(result.error, storageFailure);

for (const permission of ['prompt', 'denied']) {
  result = await access.restore({
    loadHandle: async () => handle,
    queryPermission: async () => permission,
    loadDirectory: async () => { throw new Error('must not load without permission'); },
  });
  assert.equal(result.kind, 'permission-required');
  assert.equal(result.permission, permission);
  assert.equal(result.handle, handle);
}

const permissionCheckFailure = Object.assign(new Error('bad handle'), { name: 'TypeError' });
result = await access.restore({
  loadHandle: async () => handle,
  queryPermission: async () => { throw permissionCheckFailure; },
  loadDirectory: async () => {},
});
assert.equal(result.kind, 'permission-check-error');
assert.equal(result.error, permissionCheckFailure);

const stages = [];
result = await access.restore({
  loadHandle: async () => handle,
  queryPermission: async () => 'granted',
  loadDirectory: async () => {},
  onStage: stage => stages.push(stage),
});
assert.equal(result.kind, 'ready');
assert.equal(result.handle, handle);
assert.deepEqual(stages, ['load-handle', 'query-permission', 'load-directory']);

for (const name of ['NotAllowedError', 'SecurityError']) {
  const error = Object.assign(new Error('access lost while reading'), { name });
  result = await access.restore({
    loadHandle: async () => handle,
    queryPermission: async () => 'granted',
    loadDirectory: async () => { throw error; },
  });
  assert.equal(result.kind, 'permission-required');
  assert.equal(result.permission, 'prompt');
  assert.equal(result.error, error);
}

for (const name of ['NotFoundError', 'InvalidStateError']) {
  const error = Object.assign(new Error('directory moved'), { name });
  result = await access.restore({
    loadHandle: async () => handle,
    queryPermission: async () => 'granted',
    loadDirectory: async () => { throw error; },
  });
  assert.equal(result.kind, 'directory-missing');
  assert.equal(result.error, error);
}

const readFailure = new Error('broken markdown');
result = await access.restore({
  loadHandle: async () => handle,
  queryPermission: async () => 'granted',
  loadDirectory: async () => { throw readFailure; },
});
assert.equal(result.kind, 'read-error');
assert.equal(result.error, readFailure);

result = await access.restore({
  loadHandle: () => new Promise(() => {}),
  queryPermission: async () => 'granted',
  loadDirectory: async () => {},
  timeoutMs: 10,
});
assert.equal(result.kind, 'storage-error');
assert.equal(result.error.name, 'TimeoutError');
assert.equal(result.error.stage, '读取浏览器授权记录');

result = await access.restore({
  loadHandle: async () => handle,
  queryPermission: () => new Promise(resolve => setTimeout(() => resolve('granted'), 20)),
  loadDirectory: async () => {},
  timeoutMs: 5,
});
assert.equal(
  result.kind,
  'ready',
  'a delayed File System Access permission response is awaited instead of synthesized as a timeout'
);

result = await access.restore({
  loadHandle: async () => handle,
  queryPermission: async () => 'granted',
  loadDirectory: () => new Promise(resolve => setTimeout(resolve, 20)),
  timeoutMs: 5,
});
assert.equal(
  result.kind,
  'ready',
  'storage and permission checks stay bounded without timing out directory reads'
);

const gate = access.createGenerationGate();
const committed = [];
const oldGeneration = gate.begin();
const lateTask = new Promise(resolve => setTimeout(() => {
  gate.commit(oldGeneration, () => committed.push('old'));
  resolve();
}, 25));
await assert.rejects(
  access.withTimeout(() => lateTask, 5, '旧目录读取'),
  error => error.name === 'TimeoutError'
);
gate.invalidate(oldGeneration);
const currentGeneration = gate.begin();
assert.equal(gate.commit(currentGeneration, () => committed.push('new')), true);
await lateTask;
assert.deepEqual(committed, ['new'], 'a timed-out generation cannot commit state after a newer load');

console.log('✓ directory access: bounds IndexedDB recovery and directly awaits permission and directory reads');
