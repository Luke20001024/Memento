import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../chrome-newtab/manifest.json', import.meta.url), 'utf8'));
const viewerHtml = await readFile(new URL('../chrome-newtab/viewer.html', import.meta.url), 'utf8');
const viewer = await readFile(new URL('../chrome-newtab/viewer.js', import.meta.url), 'utf8');
const sanitizer = await readFile(new URL('../chrome-newtab/archive-sanitizer-library.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../chrome-newtab/dashboard.js', import.meta.url), 'utf8');
const dashboardHtml = await readFile(new URL('../chrome-newtab/dashboard.html', import.meta.url), 'utf8');

assert.deepEqual(manifest.sandbox.pages, ['viewer.html']);
const policy = manifest.content_security_policy.sandbox;
for (const directive of [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
]) {
  assert.ok(policy.includes(directive), `missing sandbox CSP directive: ${directive}`);
}
for (const capability of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-downloads', 'allow-modals']) {
  assert.ok(!policy.includes(capability), `sandbox unexpectedly grants ${capability}`);
}
const scriptPolicy = policy.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1] || '';
assert.ok(!scriptPolicy.includes("'unsafe-inline'"), 'sandbox must not execute imported inline scripts');
assert.ok(!scriptPolicy.includes("'unsafe-eval'"), 'sandbox must not allow eval');

const sourceCheck = viewer.indexOf('event.source !== window.opener');
const sanitize = viewer.indexOf('sanitizeArchiveDocument(data.html)');
const importSafeDom = viewer.indexOf('document.importNode(safeDocument.documentElement, true)');
assert.ok(sourceCheck >= 0 && sanitize > sourceCheck && importSafeDom > sanitize, 'viewer validates its opener and imports only sanitized DOM');
assert.ok(!viewer.includes('document.write'), 'viewer must not reparse archive HTML with document.write');
assert.ok(!sanitizer.includes('serializeArchiveDocument'), 'sanitized DOM must not be serialized for reparsing');
assert.match(viewerHtml, /<script src="archive-sanitizer-library\.js"><\/script>/);
assert.match(viewerHtml, /<script src="viewer\.js"><\/script>/);
assert.ok(!/<script(?:\s|>)(?![^>]*\bsrc=)/i.test(viewerHtml), 'viewer shell must not contain inline script');

for (const blocked of ['script', 'base', 'iframe', 'object', 'embed', 'portal', 'animate', 'set']) {
  assert.match(sanitizer, new RegExp(`['"]${blocked}['"]`), `sanitizer must remove ${blocked}`);
}
assert.match(sanitizer, /meta\[http-equiv\]/);
assert.match(sanitizer, /name\.startsWith\('on'\)/);
assert.match(sanitizer, /normalized\.startsWith\('#'\)/);
assert.match(sanitizer, /SAFE_DATA_MEDIA_RE/);

assert.match(dashboard, /createSerialQueue\(\)/);
assert.match(dashboard, /generation !== archiveRenderGeneration/);
assert.match(dashboard, /type="button" class="archive-open"/);
assert.match(dashboardHtml, /id="archive-drop"[^>]*role="button"[^>]*tabindex="0"/s);
assert.match(dashboardHtml, /id="archive-status"[^>]*role="status"/s);

console.log('✓ archive security: validates opener, script-free imported DOM, restrictive sandbox CSP, and keyboard controls');
