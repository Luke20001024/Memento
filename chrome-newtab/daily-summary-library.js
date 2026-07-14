// Memento · 每日总结纯数据层
// 负责解析 Reviews/Daily/*.md，并按每日文件名把当天第一帧、总结和处理状态配成日卡。

(function exposeDailySummaryLibrary(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MementoDailySummaries = api;
})(typeof window !== 'undefined' ? window : globalThis, function createDailySummaryLibrary() {
  'use strict';

  const REVIEW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const REVIEW_STATE_VALUES = new Set(['pending', 'success', 'failed']);
  const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
  const SECTION_ALIASES = new Map([
    ['工作与生活现场', 'scene'],
    ['工作事项', 'scene'],
    ['行动线索', 'actionClues'],
    ['TODO 清单', 'actionClues'],
    ['灵感与想法', 'insights'],
    ['个人记录/情绪', 'personal'],
    ['已忽略', 'ignored'],
    ['来源索引', 'sources'],
    ['我的补充', 'supplement'],
  ]);

  function normalizeNewlines(text) {
    return String(text || '').replace(/\r\n?/g, '\n');
  }

  function unquote(value) {
    const text = String(value || '').trim();
    if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === "'" && text.at(-1) === "'"))) {
      return text.slice(1, -1);
    }
    return text;
  }

  function parseFrontmatter(text) {
    const normalized = normalizeNewlines(text);
    const match = normalized.match(FRONTMATTER_RE);
    if (!match) return { meta: {}, body: normalized, issue: '缺少总结元数据' };

    const meta = {};
    match[1].split('\n').forEach(line => {
      const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (field) meta[field[1]] = unquote(field[2]);
    });
    return { meta, body: normalized.slice(match[0].length), issue: '' };
  }

  function parseSections(body) {
    const sections = {
      scene: '',
      actionClues: '',
      insights: '',
      personal: '',
      ignored: '',
      sources: '',
      supplement: '',
    };
    const unknownSections = [];
    let currentKey = null;
    let currentTitle = '';
    let buffer = [];

    const flush = () => {
      if (!currentTitle) return;
      const content = buffer.join('\n').trim();
      if (currentKey) {
        sections[currentKey] = [sections[currentKey], content].filter(Boolean).join('\n\n');
      } else if (content) {
        unknownSections.push({ title: currentTitle, content });
      }
    };

    normalizeNewlines(body).split('\n').forEach(line => {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        flush();
        currentTitle = heading[1].trim();
        currentKey = SECTION_ALIASES.get(currentTitle) || null;
        buffer = [];
        return;
      }
      if (currentTitle) buffer.push(line);
    });
    flush();

    return { sections, unknownSections };
  }

  function sourceDateFrom(value) {
    const match = String(value || '').match(/\[\[(\d{4}-\d{2}-\d{2})\]\]/);
    return match ? match[1] : '';
  }

  function parseReviewFile(file) {
    const fileDate = file && REVIEW_DATE_RE.test(file.date || '') ? file.date : '';
    const issues = [];
    if (!fileDate) issues.push('总结文件名日期无效');
    if (file && file.readIssue) issues.push(file.readIssue);

    const parsed = parseFrontmatter(file && file.text);
    if (parsed.issue) issues.push(parsed.issue);
    const { meta } = parsed;
    const parsedSections = parseSections(parsed.body);
    const declaredDate = meta.date || '';
    const sourceDate = sourceDateFrom(meta.source);

    if (declaredDate && declaredDate !== fileDate) issues.push('总结日期与文件名不一致');
    if (sourceDate && sourceDate !== fileDate) issues.push('总结来源日期与文件名不一致');
    if (meta.type && meta.type !== 'memento-review') issues.push('总结类型不受支持');
    if (meta.period && meta.period !== 'daily') issues.push('总结周期不受支持');

    return {
      id: `${fileDate || 'unknown'}#review`,
      fileDate,
      date: declaredDate || fileDate,
      type: meta.type || '',
      period: meta.period || '',
      sourceDate,
      sourceHash: meta.source_hash || '',
      generatedAt: meta.generated_at || '',
      prompt: meta.prompt || '',
      sourceMock: meta.source_mock === 'true',
      sections: parsedSections.sections,
      unknownSections: parsedSections.unknownSections,
      issues,
      mtime: Number(file && file.mtime) || 0,
    };
  }

  function collectReviewRecords(files) {
    return (files || [])
      .map(parseReviewFile)
      .filter(record => record.fileDate)
      .sort((a, b) => b.fileDate.localeCompare(a.fileDate) || b.mtime - a.mtime);
  }

  function parseReviewStateFile(file) {
    const fileDate = file && REVIEW_DATE_RE.test(file.date || '') ? file.date : '';
    const issues = [];
    let payload = {};
    if (!fileDate) issues.push('总结状态文件名日期无效');
    if (file && file.readIssue) issues.push(file.readIssue);

    try {
      const parsed = JSON.parse(String(file && file.text || '{}'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      else issues.push('总结状态文件格式无效');
    } catch {
      issues.push('总结状态文件无法解析');
    }

    const declaredDate = REVIEW_DATE_RE.test(payload.date || '') ? payload.date : '';
    const status = REVIEW_STATE_VALUES.has(payload.status) ? payload.status : '';
    if (payload.date && !declaredDate) issues.push('总结状态日期无效');
    if (declaredDate && fileDate && declaredDate !== fileDate) issues.push('总结状态日期与文件名不一致');
    if (payload.status && !status) issues.push('总结状态不受支持');

    return {
      fileDate,
      date: declaredDate || fileDate,
      status,
      updatedAt: String(payload.updated_at || payload.updatedAt || ''),
      message: String(payload.message || ''),
      issues,
      mtime: Number(file && file.mtime) || 0,
    };
  }

  function collectReviewStates(files) {
    return Object.fromEntries((files || [])
      .map(parseReviewStateFile)
      .filter(record => record.fileDate)
      .sort((a, b) => a.fileDate.localeCompare(b.fileDate) || a.mtime - b.mtime)
      .map(record => [record.fileDate, record]));
  }

  function reviewFreshness(review, sourceHash) {
    if (!review) return 'missing';
    if (!review.sourceHash || !sourceHash) return 'unknown';
    return review.sourceHash === sourceHash ? 'current' : 'stale';
  }

  function summaryStatus(review, freshness, reviewState) {
    if (reviewState && reviewState.status === 'failed') return 'failed';
    if (reviewState && reviewState.status === 'pending') return 'pending';
    if (!review) return 'pending';
    if (freshness === 'stale') return 'stale';
    return 'current';
  }

  function buildDayCards(snapshotRecords, reviewRecords, sourceHashes = {}, reviewStates = {}) {
    sourceHashes = sourceHashes || {};
    reviewStates = reviewStates || {};
    const days = new Map();
    const ensureDay = dayKey => {
      if (!days.has(dayKey)) days.set(dayKey, { dayKey, photos: [], reviews: [] });
      return days.get(dayKey);
    };

    (snapshotRecords || []).forEach(photo => {
      const dayKey = photo && REVIEW_DATE_RE.test(photo.fileDate || '') ? photo.fileDate : '';
      if (dayKey) ensureDay(dayKey).photos.push(photo);
    });
    (reviewRecords || []).forEach(review => {
      const dayKey = review && REVIEW_DATE_RE.test(review.fileDate || '') ? review.fileDate : '';
      if (dayKey) ensureDay(dayKey).reviews.push(review);
    });
    Object.keys(sourceHashes || {}).forEach(dayKey => {
      if (REVIEW_DATE_RE.test(dayKey)) ensureDay(dayKey);
    });

    return [...days.values()].map(day => {
      day.photos.sort((a, b) => String(a.sortKey || '').localeCompare(String(b.sortKey || '')));
      day.reviews.sort((a, b) => b.mtime - a.mtime);
      const photo = day.photos.find(item => item.assetName) || day.photos[0] || null;
      const review = day.reviews[0] || null;
      const reviewState = reviewStates[day.dayKey] || null;
      const freshness = reviewFreshness(review, sourceHashes[day.dayKey]);
      const issues = [
        ...(photo ? photo.issues : []),
        ...(review ? review.issues : []),
        ...(reviewState && Array.isArray(reviewState.issues) ? reviewState.issues : []),
      ];
      if (day.photos.length > 1) issues.push(`同一天检测到 ${day.photos.length} 张开场照片`);
      if (day.reviews.length > 1) issues.push(`同一天检测到 ${day.reviews.length} 份总结`);

      return {
        id: `day:${day.dayKey}`,
        dayKey: day.dayKey,
        photo,
        photos: day.photos,
        additionalPhotoCount: Math.max(0, day.photos.length - 1),
        review,
        reviewState,
        freshness,
        summaryStatus: summaryStatus(review, freshness, reviewState),
        issues,
        sortKey: day.dayKey,
      };
    }).sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }

  function monthKey(dayCard) {
    return /^\d{4}-\d{2}/.test(dayCard && dayCard.dayKey || '') ? dayCard.dayKey.slice(0, 7) : '';
  }

  return {
    buildDayCards,
    collectReviewStates,
    collectReviewRecords,
    monthKey,
    parseFrontmatter,
    parseReviewFile,
    parseReviewStateFile,
    parseSections,
    reviewFreshness,
    summaryStatus,
  };
});
