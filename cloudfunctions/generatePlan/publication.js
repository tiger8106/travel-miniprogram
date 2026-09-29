// 候选只留后台；整天复核完成（通过或明确标注待确认）后才进入公开时间线。
const { REVIEW_VERSION } = require('./execution-review');
const indexOf = (row) => Number(row.dayIndex || 0);

function finalizedDays(rows) {
  const days = [...new Set((rows || []).map(indexOf))];
  return new Set(days.filter((di) => {
    const group = rows.filter((row) => indexOf(row) === di);
    return group.length && group.every((row) => row.executionReview === REVIEW_VERSION);
  }));
}

function partitionRows(rows) {
  const ready = finalizedDays(rows || []);
  return {
    published: (rows || []).filter((row) => ready.has(indexOf(row))),
    pending: (rows || []).filter((row) => !ready.has(indexOf(row))),
    ready,
  };
}

function collectGenerationRows(stored, outline) {
  const rows = stored || [], ready = finalizedDays(rows);
  const out = rows.filter((row) => ready.has(indexOf(row)));
  ((outline || {}).days || []).forEach((day, di) => {
    if (ready.has(di)) return;
    const candidate = Array.isArray(day.executionCandidate) && day.executionCandidate.length
      ? day.executionCandidate : rows.filter((row) => indexOf(row) === di);
    out.push(...candidate.map((row) => Object.assign({}, row, { dayIndex: di })));
  });
  return out;
}

function publicationState(previous, plan, outline) {
  const fresh = partitionRows(plan.items || []);
  const replaced = fresh.ready;
  // 未通过的新候选不能覆盖先前已发布的整天内容。
  const previousRows = partitionRows((previous || {}).items || []);
  const old = previousRows.published;
  const published = old.filter((row) => !replaced.has(indexOf(row))).concat(fresh.published);
  const publicDays = finalizedDays(published);
  const changed = new Set((plan.items || []).map(indexOf));
  const drafts = ((previous || {}).genDraftItems || []).concat(previousRows.pending).filter((row) => !changed.has(indexOf(row)))
    .concat(fresh.pending).filter((row) => !publicDays.has(indexOf(row)));
  const pending = collectGenerationRows(drafts, outline).filter((row) => !publicDays.has(indexOf(row)));
  const warningDays = [...publicDays].filter((di) => published.some((row) => indexOf(row) === di
    && row.executionReviewStatus === 'needs_confirmation'));
  return { published, pending, progress: { done: publicDays.size,
    total: ((outline || {}).days || []).length || Number((plan.progress || {}).total) || 0,
    stage: plan.partial ? 'generation_review' : 'done', warningDays: warningDays.length }, warningDays };
}

module.exports = { finalizedDays, partitionRows, collectGenerationRows, publicationState };
