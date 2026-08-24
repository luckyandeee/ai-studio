// In-memory progress tracker, keyed by runId. This is intentionally NOT
// persisted to SQLite — it's ephemeral UI feedback for "what's happening
// right now", not a record anyone needs after the request finishes.
// The frontend polls GET /api/progress/:runId every ~1s while a request is
// in flight, so the loading overlay can show the actual current stage
// (which model, which retry attempt, which frame) instead of one static
// message for the entire duration.
const store = new Map(); // runId -> { stage, detail, startedAt, updatedAt, done, error }
function startProgress(runId, stage, detail = null) {
  if (!runId) return;
  store.set(runId, { stage, detail, startedAt: Date.now(), updatedAt: Date.now(), done: false, error: null });
}
function updateProgress(runId, stage, detail = null) {
  if (!runId) return;
  const existing = store.get(runId);
  const startedAt = existing?.startedAt ?? Date.now();
  store.set(runId, { stage, detail, startedAt, updatedAt: Date.now(), done: false, error: null });
}
function finishProgress(runId) {
  if (!runId) return;
  const existing = store.get(runId);
  if (!existing) return;
  store.set(runId, { ...existing, stage: "done", updatedAt: Date.now(), done: true });
}
function failProgress(runId, error) {
  if (!runId) return;
  const existing = store.get(runId);
  if (!existing) return;
  store.set(runId, { ...existing, stage: "error", error, updatedAt: Date.now(), done: true });
}
function getProgress(runId) {
  return store.get(runId) || null;
}
// Prevent unbounded memory growth on a long-running local server — entries
// older than 30 minutes are almost certainly from an abandoned/finished run.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, p] of store.entries()) {
    if (p.updatedAt < cutoff) store.delete(id);
  }
}, 5 * 60 * 1000);
module.exports = { startProgress, updateProgress, finishProgress, failProgress, getProgress };
