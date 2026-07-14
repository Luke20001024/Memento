// Memento · 每日第一帧纯数据解析层
// 不读文件、不创建 blob URL，便于在 Chrome 和 Node 测试中共用。

(function exposePhotoLibrary(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MementoPhotos = api;
})(typeof window !== 'undefined' ? window : globalThis, function createPhotoLibrary() {
  'use strict';

  const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;
  const ENTRY_SPLIT_RE = /\n---\s*\n/;
  const SNAPSHOT_LABEL = '每日第一帧';

  function normalizeNewlines(text) {
    return String(text || '').replace(/\r\n?/g, '\n');
  }

  function splitEntryBlocks(text) {
    return normalizeNewlines(text)
      .replace(FRONTMATTER_RE, '')
      .split(ENTRY_SPLIT_RE)
      .map(block => block.trim())
      .filter(Boolean);
  }

  function fieldValue(block, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = block.match(new RegExp(`^>\\s*${escaped}\\s*[:：]\\s*(.*)$`, 'm'));
    return match ? match[1].trim() : '';
  }

  function parseHeading(block) {
    const match = block.match(/^##\s+(.+)$/m);
    if (!match) return null;
    const parts = match[1].split(' · ').map(part => part.trim()).filter(Boolean);
    if (!parts.includes(SNAPSHOT_LABEL)) return null;
    return {
      time: parts[0] || '',
      weekday: parts.find(part => /^周[一二三四五六日]$/.test(part)) || '',
    };
  }

  function normalizeAssetReference(reference) {
    if (!reference) return { assetPath: '', assetName: '', issue: '照片引用缺失' };
    const cleaned = reference.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
    const match = cleaned.match(/^(?:\.\/)?assets\/([^/\\]+)$/);
    if (!match || !match[1] || match[1] === '.' || match[1] === '..' || match[1].includes('..')) {
      return { assetPath: cleaned, assetName: '', issue: '照片路径无效' };
    }
    return {
      assetPath: `assets/${match[1]}`,
      assetName: match[1],
      issue: '',
    };
  }

  function extractAssetReference(block) {
    const exact = block.match(/!\[\s*每日第一帧\s*\]\(([^)]+)\)/);
    if (exact) return exact[1];

    const images = [...block.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)];
    const fallback = images.find(match => /daily-portrait/i.test(match[1]));
    return fallback ? fallback[1] : '';
  }

  function parseObserved(value) {
    if (!value) return { observedAt: '', weatherProvider: '' };
    const parts = value.split(/\s+·\s+/).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return { observedAt: value, weatherProvider: '' };
    return {
      observedAt: parts.slice(0, -1).join(' · '),
      weatherProvider: parts[parts.length - 1],
    };
  }

  function parseSnapshotBlock(block, fileDate, index) {
    const heading = parseHeading(block);
    if (!heading) return null;

    const issues = [];
    const explicitTime = fieldValue(block, '时间');
    const timeMatch = explicitTime.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?:\s*·\s*(.+))?$/);
    const date = timeMatch ? timeMatch[1] : fileDate;
    const time = timeMatch ? timeMatch[2] : heading.time;
    const timezone = timeMatch && timeMatch[3] ? timeMatch[3].trim() : '';
    if (timeMatch && date !== fileDate) issues.push('记录日期与文件日期不一致');

    const weather = fieldValue(block, '天气') || '暂不可用';
    const observed = parseObserved(fieldValue(block, '天气观测'));
    const source = fieldValue(block, '首条记录来源');
    const asset = normalizeAssetReference(extractAssetReference(block));
    if (asset.issue) issues.push(asset.issue);

    return {
      id: `${fileDate}#snapshot-${index}`,
      fileDate,
      date,
      time,
      timezone,
      weekday: heading.weekday,
      weather,
      weatherStatus: weather === '暂不可用' ? 'unavailable' : 'available',
      observedAt: observed.observedAt,
      weatherProvider: observed.weatherProvider,
      source,
      assetPath: asset.assetPath,
      assetName: asset.assetName,
      issues,
      sortKey: `${date}T${time || '00:00'}`,
    };
  }

  function collectSnapshotRecords(files) {
    const records = [];
    for (const file of files || []) {
      const fileDate = file && file.date ? file.date : '';
      splitEntryBlocks(file && file.text).forEach((block, index) => {
        const record = parseSnapshotBlock(block, fileDate, index);
        if (record) records.push(record);
      });
    }
    return records.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }

  function monthKey(record) {
    return /^\d{4}-\d{2}/.test(record.date || '') ? record.date.slice(0, 7) : '';
  }

  return {
    collectSnapshotRecords,
    monthKey,
    normalizeAssetReference,
    parseSnapshotBlock,
    splitEntryBlocks,
  };
});
