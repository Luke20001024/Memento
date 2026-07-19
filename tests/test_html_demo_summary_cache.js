import assert from 'node:assert/strict';
import fs from 'node:fs';

const projectRoot = new URL('../', import.meta.url);
const demoPaths = ['docs/Memento.html', 'docs/Memento-2.0.html'];

for (const path of demoPaths) {
  const html = fs.readFileSync(new URL(path, projectRoot), 'utf8');
  for (const contract of [
    'id="demo-summary-sync" role="status" aria-live="polite"',
    '已有总结已显示',
    '打开后只核对所选月份',
    'function reconcileVisibleSummaryMonth()',
    "if (drawerId === 'demo-daily-summary-drawer') reconcileVisibleSummaryMonth();",
    '其他月份没有被重新扫描',
  ]) {
    assert.ok(html.includes(contract), `${path} keeps summary-cache demo contract: ${contract}`);
  }
  assert.equal(html.includes('—'), false, `${path} contains no em dash`);
  assert.equal(html.includes('–'), false, `${path} contains no en dash`);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length > 0, `${path} includes executable demo code`);
  scripts.forEach((script, index) => {
    assert.doesNotThrow(
      () => new Function(script),
      `${path} inline script ${index + 1} parses`
    );
  });
}

const readme = fs.readFileSync(new URL('README.md', projectRoot), 'utf8');
assert.ok(
  readme.includes('[在线查看 Memento 2.0 产品故事与可操作演示](https://luke20001024.github.io/Memento/Memento-2.0.html)'),
  'README points directly to the latest GitHub Pages HTML'
);

console.log('✓ HTML demos: cached-summary story, selected-month reconciliation, valid scripts, and latest Pages link');
