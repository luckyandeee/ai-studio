const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const {
  estimateImageCost, estimateVideoCost,
  IMAGE_MODELS, VIDEO_MODELS, VOICE_MODELS, VOICE_CLONE_MODELS,
  MUSIC_MODELS, SFX_MODELS, TALKING_AVATAR_MODELS,
} = require("./fal-models");
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "studio.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    run_id TEXT,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    frame_index INTEGER,
    status TEXT NOT NULL,
    estimated_cost REAL NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS verification_stats (
    scenario_key TEXT PRIMARY KEY,
    total_checks INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    last_result TEXT
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    brand_name TEXT,
    product_description TEXT,
    creative_direction TEXT,
    environment TEXT,
    seed_identity TEXT,
    classification_json TEXT,
    image_prompts_json TEXT,
    prompt_types_json TEXT
  );
  CREATE TABLE IF NOT EXISTS run_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    item_type TEXT NOT NULL,
    item_key TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT,
    note TEXT,
    UNIQUE(run_id, item_type, item_key)
  );
  CREATE INDEX IF NOT EXISTS idx_run_items_run_id ON run_items(run_id);
  CREATE TABLE IF NOT EXISTS custom_voices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
    name TEXT NOT NULL,
    custom_voice_id TEXT NOT NULL,
    model_family TEXT NOT NULL,
    source_text TEXT,
    language_note TEXT
  );
  CREATE TABLE IF NOT EXISTS voice_previews (
    cache_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    audio_data_uri TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audio_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    audio_data_uri TEXT NOT NULL,
    model_used TEXT,
    voice_used TEXT,
    language TEXT,
    run_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT
  );
`);
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("campaigns", "mode", "TEXT DEFAULT 'single'");
ensureColumn("campaigns", "extra_json", "TEXT");

const USD_TO_INR_RATE = 95.3;

// Fallback-only cost estimator — in normal operation, fal-client.js
// already passes an explicit `cost` (from fal-models.js's
// estimateImageCost/estimateVideoCost) into recordTransaction(), so this
// only kicks in if a caller forgets to. Text/vision calls through
// fal-ai/any-llm don't have per-token pricing surfaced here yet, so they
// use a conservative flat placeholder — verify against your actual
// OpenRouter-routed model's pricing on the Fal dashboard.
function estimateCost(model, { imageCount = 0, durationSeconds = 0 } = {}) {
  if (typeof model === "string" && /any-llm/.test(model)) return 0.01;
  if (durationSeconds > 0) return estimateVideoCost(model, durationSeconds);
  return estimateImageCost(model, { megapixels: 1 });
}

// ============================================================
// SPEND-BY-FEATURE CATEGORIZATION — classifies each ledger row into
// Photography / Video / Audio / Text & Planning / Other so the Credits
// panel can show a real breakdown instead of one flat total. Built off
// real model IDs from fal-models.js's own catalogs (ground truth for
// what each model actually IS), not fuzzy endpoint-name string
// matching — a model ID can only mean one real thing, whereas an
// endpoint name like "flow-generate" is ambiguous on its own without
// knowing which model actually backed that specific call.
// ============================================================
const IMAGE_MODEL_IDS = new Set(IMAGE_MODELS.map((m) => m.id));
const VIDEO_MODEL_IDS = new Set([...VIDEO_MODELS.map((m) => m.id), ...TALKING_AVATAR_MODELS.map((m) => m.id)]);
const AUDIO_MODEL_IDS = new Set([
  ...VOICE_MODELS.map((m) => m.id),
  ...VOICE_CLONE_MODELS.map((m) => m.id),
  ...MUSIC_MODELS.map((m) => m.id),
  ...SFX_MODELS.map((m) => m.id),
]);
function categorizeTransaction(model, endpoint) {
  const m = model || "";
  // any-llm text/vision calls are recorded with a "any-llm:<realModel>"
  // or "any-llm-vision:<realModel>" prefix (see fal-client.js) — that
  // prefix itself is the reliable signal, since the real model name
  // after the colon is an OpenRouter-routed id, not one of our catalogs.
  if (m.startsWith("any-llm-vision:") || m.startsWith("any-llm:")) return "Text & Planning";
  if (/ffmpeg-api\/merge-audio-video/.test(m)) return "Video"; // combining audio+video is fundamentally a video-assembly step
  if (/ffmpeg-api\/merge-audios/.test(m)) return "Audio";
  if (/ffmpeg-api\/merge-videos/.test(m)) return "Video";
  if (IMAGE_MODEL_IDS.has(m)) return "Photography";
  if (VIDEO_MODEL_IDS.has(m)) return "Video";
  if (AUDIO_MODEL_IDS.has(m)) return "Audio";
  // Fallback for a genuinely custom/unrecognized model ID (someone typed
  // a raw Fal model ID outside our curated catalogs) — best-effort guess
  // from the endpoint name, since the model string alone can't tell us
  // anything at that point.
  const e = endpoint || "";
  if (/voice|music|sfx|audio/i.test(e)) return "Audio";
  if (/video|flow-(generate|plan|talking|scene|dialogue)/i.test(e)) return "Video";
  if (/image|frame|lock-set|wizard-generate|tools-/i.test(e)) return "Photography";
  return "Other";
}

// ============================================================
// MODEL SUCCESS STATS — real usage signal for auto-promoting a
// discovered model to a recommended default (see fal-catalog.js's
// checkPromotionEligibility). Sourced directly from the same
// transactions table the whole ledger already relies on — no new
// tracking mechanism, just a different read of data already being
// recorded on every single Fal call.
// ============================================================
function getModelSuccessStats(modelId) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) as totalCount,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount
       FROM transactions WHERE model = ?`
    )
    .get(modelId);
  const totalCount = row?.totalCount || 0;
  const successCount = row?.successCount || 0;
  return {
    totalCount,
    successCount,
    successRate: totalCount > 0 ? successCount / totalCount : 0,
  };
}

function recordTransaction({ runId = null, endpoint, model, frameIndex = null, status, note = null, cost = null, imageCount = 0, durationSeconds = 0 }) {
  const estimated = cost ?? estimateCost(model, { imageCount, durationSeconds });
  db.prepare(
    `INSERT INTO transactions (run_id, endpoint, model, frame_index, status, estimated_cost, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, endpoint, model, frameIndex, status, estimated, note);
  return estimated;
}
function getSummary() {
  const totals = db
    .prepare(`SELECT COUNT(*) as callCount, COALESCE(SUM(estimated_cost),0) as totalSpent FROM transactions WHERE status IN ('success', 'blocked')`)
    .get();
  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) as callCount, COALESCE(SUM(estimated_cost),0) as spent
       FROM transactions WHERE status IN ('success', 'blocked') GROUP BY model`
    )
    .all();
  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) as callCount, COALESCE(SUM(estimated_cost),0) as spent
       FROM transactions GROUP BY status`
    )
    .all();
  // byFeature — same source rows as the totals above (success/blocked
  // only, since 'error' rows are always cost 0 and would just add noise
  // as zero-dollar entries), grouped by real feature area instead of
  // raw model ID so the Credits panel can answer "where is the money
  // actually going" at a glance.
  const featureRows = db
    .prepare(`SELECT model, endpoint, estimated_cost FROM transactions WHERE status IN ('success', 'blocked')`)
    .all();
  const featureMap = new Map();
  for (const row of featureRows) {
    const feature = categorizeTransaction(row.model, row.endpoint);
    const entry = featureMap.get(feature) || { feature, callCount: 0, spent: 0 };
    entry.callCount += 1;
    entry.spent += row.estimated_cost;
    featureMap.set(feature, entry);
  }
  const byFeature = [...featureMap.values()]
    .map((f) => ({ ...f, spent: Number(f.spent.toFixed(4)), spentInr: Number((f.spent * USD_TO_INR_RATE).toFixed(2)) }))
    .sort((a, b) => b.spent - a.spent);
  const failedCount = db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE status = 'error'`).get().c;
  const budgetRow = db.prepare(`SELECT value FROM settings WHERE key = 'budget'`).get();
  const budget = budgetRow ? parseFloat(budgetRow.value) : null;
  const totalSpent = Number(totals.totalSpent.toFixed(4));
  const remaining = budget != null ? Number((budget - totalSpent).toFixed(4)) : null;
  return {
    totalSpent,
    totalSpentInr: Number((totalSpent * USD_TO_INR_RATE).toFixed(2)),
    callCount: totals.callCount,
    failedCount,
    byModel,
    byStatus,
    byFeature,
    budget,
    remaining,
    remainingInr: remaining != null ? Number((remaining * USD_TO_INR_RATE).toFixed(2)) : null,
    exchangeRateUsdToInr: USD_TO_INR_RATE,
  };
}
function getTransactions(limit = 100, offset = 0) {
  const rows = db
    .prepare(`SELECT * FROM transactions ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset)
    .map((row) => ({
      ...row,
      estimated_cost_inr: Number((row.estimated_cost * USD_TO_INR_RATE).toFixed(2)),
      feature: categorizeTransaction(row.model, row.endpoint),
    }));
  const total = db.prepare(`SELECT COUNT(*) as c FROM transactions`).get().c;
  return { rows, total, limit, offset };
}
function setBudget(amount) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('budget', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(amount));
}
// Adaptive verification sampling — the actual cost optimization. A
// model+scenario combination that's been reliable earns fewer checks
// over time (spot-checks instead of every single generation); a new or
// recently-failing one gets checked every time until it re-earns trust.
// This is what makes "vision re-checks the output" affordable at scale
// instead of doubling the cost of every generation forever.
function getVerificationTrust(scenarioKey) {
  return db.prepare(`SELECT * FROM verification_stats WHERE scenario_key = ?`).get(scenarioKey) || null;
}
function shouldVerifyThisTime(scenarioKey) {
  const stats = getVerificationTrust(scenarioKey);
  if (!stats || stats.last_result === "fail") return { verify: true, reason: !stats ? "never checked before" : "most recent check failed — rebuilding trust" };
  // Trust tiers based on a real, consecutive streak — a single old
  // success doesn't buy long-term trust; sustained reliability does.
  if (stats.consecutive_successes >= 10) {
    const sample = Math.random() < 0.1; // high trust: spot-check ~10% of the time
    return { verify: sample, reason: `high trust (${stats.consecutive_successes} consecutive) — spot-check sampling` };
  }
  if (stats.consecutive_successes >= 5) {
    const sample = Math.random() < 0.34; // medium trust: check roughly 1-in-3
    return { verify: sample, reason: `medium trust (${stats.consecutive_successes} consecutive) — 1-in-3 sampling` };
  }
  return { verify: true, reason: `still building trust (${stats.consecutive_successes} consecutive) — checking every time` };
}
function recordVerificationResult(scenarioKey, passed) {
  const existing = getVerificationTrust(scenarioKey);
  const consecutive = passed ? (existing?.consecutive_successes || 0) + 1 : 0;
  db.prepare(
    `INSERT INTO verification_stats (scenario_key, total_checks, successes, consecutive_successes, last_checked_at, last_result)
     VALUES (?, 1, ?, ?, datetime('now'), ?)
     ON CONFLICT(scenario_key) DO UPDATE SET
       total_checks = total_checks + 1,
       successes = successes + ?,
       consecutive_successes = ?,
       last_checked_at = datetime('now'),
       last_result = ?`
  ).run(scenarioKey, passed ? 1 : 0, consecutive, passed ? "pass" : "fail", passed ? 1 : 0, consecutive, passed ? "pass" : "fail");
}
// Every model+requirement combination ever checked, most recent first —
// the data source for the frontend's trust-summary panel. Splits
// scenario_key back into modelId/requirementType for display, and
// includes the same trust-tier reasoning shouldVerifyThisTime uses, so
// what's shown matches the actual logic instead of being a separate
// re-derivation of it.
function listAllVerificationStats() {
  const rows = db.prepare(`SELECT * FROM verification_stats ORDER BY last_checked_at DESC`).all();
  return rows.map((r) => {
    const [modelId, requirementType] = r.scenario_key.split("::");
    const decision = shouldVerifyThisTime(r.scenario_key);
    return {
      modelId,
      requirementType,
      totalChecks: r.total_checks,
      successes: r.successes,
      consecutiveSuccesses: r.consecutive_successes,
      lastCheckedAt: r.last_checked_at,
      lastResult: r.last_result,
      currentTrustTier: decision.reason,
    };
  });
}
// Tracks which video models have ACTUALLY been observed hitting a
// likeness/privacy content block in real usage — not a static list, not
// a guess. Used to make the frontend's warning honest: a model with
// confirmed real evidence gets a strong warning; an unconfirmed one
// (never actually seen this fail) doesn't get tarred with the same
// wording just because it's in the same general category.
function recordImageContentBlockModel(modelId) {
  const existing = new Set(getSettingJson("confirmed_likeness_block_models") || []);
  existing.add(modelId);
  setSettingJson("confirmed_likeness_block_models", [...existing]);
}
function getConfirmedLikenessBlockModels() {
  return getSettingJson("confirmed_likeness_block_models") || [];
}

// Generic JSON key-value helpers on the same settings table — used to
// persist the model catalog cache (fal-catalog.js) across server
// restarts, so a nodemon restart (or any redeploy) doesn't need to
// re-hit Fal's API from scratch every single time.
function getSettingJson(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}
function setSettingJson(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value));
}
function saveCampaign({ runId, mode = "single", brandName, productDescription, creativeDirection, environment, seedIdentity, classification, imagePrompts, promptTypes, extra = null }) {
  const cols = {
    run_id: runId,
    mode,
    brand_name: brandName || null,
    product_description: productDescription || null,
    creative_direction: creativeDirection || null,
    environment: environment || null,
    seed_identity: seedIdentity || null,
    classification_json: JSON.stringify(classification || {}),
    image_prompts_json: JSON.stringify(imagePrompts || []),
    prompt_types_json: JSON.stringify(promptTypes || []),
    extra_json: extra ? JSON.stringify(extra) : null,
  };
  const names = Object.keys(cols);
  const placeholders = names.map(() => "?").join(", ");
  const updates = names
    .filter((n) => n !== "run_id")
    .map((n) => `${n} = excluded.${n}`)
    .join(", ");
  const values = names.map((n) => cols[n]);
  db.prepare(
    `INSERT INTO campaigns (${names.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT(run_id) DO UPDATE SET ${updates}`
  ).run(...values);
}
// ============================================================
// PER-RUN SPEND — real total cost for one run_id (or a batch of them),
// sourced from the exact same transactions rows the global ledger uses.
// This is what makes "how much did THIS shoot/video actually cost"
// answerable, rather than only ever seeing one grand total across
// everything the app has ever done.
// ============================================================
function getRunSpend(runId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) as callCount, COALESCE(SUM(estimated_cost),0) as spent
       FROM transactions WHERE run_id = ? AND status IN ('success', 'blocked')`
    )
    .get(runId);
  const spent = Number((row?.spent || 0).toFixed(4));
  return { spent, spentInr: Number((spent * USD_TO_INR_RATE).toFixed(2)), callCount: row?.callCount || 0 };
}
// Bulk version — one query for N run_ids instead of N round trips, for
// list views (campaigns list, videos list) rendering many rows at once.
function getRunSpendMap(runIds) {
  const map = new Map();
  if (!runIds || !runIds.length) return map;
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT run_id, COUNT(*) as callCount, COALESCE(SUM(estimated_cost),0) as spent
       FROM transactions WHERE run_id IN (${placeholders}) AND status IN ('success', 'blocked')
       GROUP BY run_id`
    )
    .all(...runIds);
  rows.forEach((r) => {
    const spent = Number(r.spent.toFixed(4));
    map.set(r.run_id, { spent, spentInr: Number((spent * USD_TO_INR_RATE).toFixed(2)), callCount: r.callCount });
  });
  return map;
}
function listCampaigns(limit = 50, offset = 0) {
  const rows = db
    .prepare(`SELECT run_id, created_at, mode, brand_name, product_description FROM campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
  const spendMap = getRunSpendMap(rows.map((r) => r.run_id));
  const rowsWithSpend = rows.map((r) => ({
    ...r,
    spend: spendMap.get(r.run_id) || { spent: 0, spentInr: 0, callCount: 0 },
  }));
  const total = db.prepare(`SELECT COUNT(*) as c FROM campaigns`).get().c;
  return { rows: rowsWithSpend, total, limit, offset };
}
function getCampaign(runId) {
  const row = db.prepare(`SELECT * FROM campaigns WHERE run_id = ?`).get(runId);
  if (!row) return null;
  const mode = row.mode || "single";
  // Real, confirmed gap fixed here: campaigns previously only restored
  // text fields (brand/description/etc.) — the actual generated images
  // already paid for and saved in run_items were never surfaced back,
  // so reloading a past campaign meant staring at an empty form with a
  // note to re-upload and re-run everything from scratch.
  const itemType = mode === "batch" ? "batch_item" : "frame";
  const completed = getCompletedRunItems(runId, itemType);
  const generatedItems = [...completed.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([key, payload]) => ({ key, ...payload }));
  return {
    runId: row.run_id,
    createdAt: row.created_at,
    mode,
    brandName: row.brand_name,
    productDescription: row.product_description,
    creativeDirection: row.creative_direction,
    environment: row.environment,
    seedIdentity: row.seed_identity,
    classification: JSON.parse(row.classification_json || "{}"),
    imagePrompts: JSON.parse(row.image_prompts_json || "[]"),
    promptTypes: JSON.parse(row.prompt_types_json || "[]"),
    extra: row.extra_json ? JSON.parse(row.extra_json) : null,
    spend: getRunSpend(runId),
    generatedItems,
  };
}
function saveRunItem({ runId, itemType, itemKey, status, payload = null, note = null }) {
  db.prepare(
    `INSERT INTO run_items (run_id, item_type, item_key, status, payload_json, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, item_type, item_key) DO UPDATE SET
       status = excluded.status, payload_json = excluded.payload_json, note = excluded.note, created_at = datetime('now')`
  ).run(runId, itemType, String(itemKey), status, payload ? JSON.stringify(payload) : null, note);
}
function getCompletedRunItems(runId, itemType) {
  const rows = db.prepare(`SELECT item_key, payload_json FROM run_items WHERE run_id = ? AND item_type = ? AND status = 'success'`).all(runId, itemType);
  const map = new Map();
  rows.forEach((r) => map.set(r.item_key, r.payload_json ? JSON.parse(r.payload_json) : null));
  return map;
}
function clearRunItems(runId) {
  db.prepare(`DELETE FROM run_items WHERE run_id = ?`).run(runId);
}
function listRunItems(itemType, limit = 50) {
  const rows = db
    .prepare(`SELECT run_id, item_key, created_at, payload_json FROM run_items WHERE item_type = ? AND status = 'success' ORDER BY created_at DESC LIMIT ?`)
    .all(itemType, limit);
  const spendMap = getRunSpendMap([...new Set(rows.map((r) => r.run_id))]);
  return rows.map((r) => ({
    runId: r.run_id,
    itemKey: r.item_key,
    createdAt: r.created_at,
    ...JSON.parse(r.payload_json || "{}"),
    // Spend across the WHOLE run this item belongs to (a run can have
    // multiple clips/frames) — not just this one item's own cost, since
    // that's what "how much did this run cost" actually means.
    runSpend: spendMap.get(r.run_id) || { spent: 0, spentInr: 0, callCount: 0 },
  }));
}

// ============================================================
// RELIABILITY HEALTH — same two-bucket idea as before (quota/rate-limit
// vs. provider-side overload), pattern-matched against error notes.
// Fal's error surface differs from Google's (no 429/RESOURCE_EXHAUSTED
// wording specifically), so the patterns below are broadened to also
// catch Fal's typical rate-limit/overload phrasing; tighten these once
// you've seen real error text from your account.
// ============================================================
const QUOTA_PATTERN = /429|quota|resource_exhausted|rate.?limit/i;
const OVERLOAD_PATTERN = /503|unavailable|high demand|overloaded|capacity/i;
// ============================================================
// LEARNED FIELD CORRECTIONS — the real replacement for hand-written
// per-model knowledge. When Fal's own validator rejects a request and
// says exactly what it expected (a real, structured error, not a
// guess), that correction is learned and persisted here — every future
// call to that model uses it automatically, for every model, without
// anyone writing per-model code for it. This is what makes "no
// hardcoded models" actually true rather than just moving the
// hardcoding into a different function.
// ============================================================
const FIELD_CORRECTIONS_KEY = "model_field_corrections_v1";
function getModelFieldCorrection(modelId) {
  const all = getSettingJson(FIELD_CORRECTIONS_KEY) || {};
  return all[modelId] || null;
}
function saveModelFieldCorrection(modelId, correction) {
  const all = getSettingJson(FIELD_CORRECTIONS_KEY) || {};
  all[modelId] = { ...correction, learnedAt: new Date().toISOString() };
  setSettingJson(FIELD_CORRECTIONS_KEY, all);
}

function getReliabilityHealth(windowHours = 1) {
  const rows = db
    .prepare(
      `SELECT model, note FROM transactions WHERE status = 'error' AND created_at >= datetime('now', '-' || ? || ' hours')`,
    )
    .all(windowHours);
  const quota = { count: 0, models: new Set() };
  const overload = { count: 0, models: new Set() };
  rows.forEach((r) => {
    const note = r.note || "";
    if (QUOTA_PATTERN.test(note)) {
      quota.count++;
      if (r.model) quota.models.add(r.model);
    } else if (OVERLOAD_PATTERN.test(note)) {
      overload.count++;
      if (r.model) overload.models.add(r.model);
    }
  });
  const THRESHOLD = 3;
  return {
    windowHours,
    quota: { count: quota.count, models: [...quota.models], warn: quota.count >= THRESHOLD },
    overload: { count: overload.count, models: [...overload.models], warn: overload.count >= THRESHOLD },
  };
}
function saveCustomVoice({ name, customVoiceId, modelFamily, sourceText, languageNote }) {
  const info = db
    .prepare(`INSERT INTO custom_voices (name, custom_voice_id, model_family, source_text, language_note) VALUES (?, ?, ?, ?, ?)`)
    .run(name, customVoiceId, modelFamily, sourceText || null, languageNote || null);
  return info.lastInsertRowid;
}
function listCustomVoices(modelFamily) {
  return db
    .prepare(`SELECT * FROM custom_voices WHERE model_family = ? ORDER BY created_at DESC`)
    .all(modelFamily);
}
// Called every time a custom voice is actually used for real speech
// generation — this is what genuinely keeps it alive past MiniMax's
// 7-day auto-deletion window, not just a cosmetic timestamp update.
function touchCustomVoiceLastUsed(customVoiceId) {
  db.prepare(`UPDATE custom_voices SET last_used_at = datetime('now') WHERE custom_voice_id = ?`).run(customVoiceId);
}
function deleteCustomVoice(customVoiceId) {
  db.prepare(`DELETE FROM custom_voices WHERE custom_voice_id = ?`).run(customVoiceId);
}
function getVoicePreview(cacheKey) {
  const row = db.prepare(`SELECT audio_data_uri FROM voice_previews WHERE cache_key = ?`).get(cacheKey);
  return row?.audio_data_uri || null;
}
function saveVoicePreview(cacheKey, audioDataUri) {
  db.prepare(`INSERT OR REPLACE INTO voice_previews (cache_key, audio_data_uri) VALUES (?, ?)`).run(cacheKey, audioDataUri);
}
// ============================================================
// AUDIO LIBRARY (Phase 11) — a real place to save a generated voice
// take, song, or SFX clip so it isn't lost when the modal closes.
// Reuses the exact same data-URI-in-SQLite pattern voice_previews
// already proved, not a new storage mechanism.
// ============================================================
function saveAudioLibraryItem({ type, name, audioDataUri, modelUsed, voiceUsed, language, runId, metadata }) {
  const info = db
    .prepare(`INSERT INTO audio_library (type, name, audio_data_uri, model_used, voice_used, language, run_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type, name, audioDataUri, modelUsed || null, voiceUsed || null, language || null, runId || null, metadata ? JSON.stringify(metadata) : null);
  return info.lastInsertRowid;
}
function listAudioLibraryItems({ type } = {}) {
  const rows = type
    ? db.prepare(`SELECT * FROM audio_library WHERE type = ? ORDER BY favorite DESC, created_at DESC`).all(type)
    : db.prepare(`SELECT * FROM audio_library ORDER BY favorite DESC, created_at DESC`).all();
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, type: r.type, name: r.name, audio: r.audio_data_uri,
    modelUsed: r.model_used, voiceUsed: r.voice_used, language: r.language, runId: r.run_id,
    favorite: !!r.favorite, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
  }));
}
function deleteAudioLibraryItem(id) {
  db.prepare(`DELETE FROM audio_library WHERE id = ?`).run(id);
}
function toggleAudioLibraryFavorite(id) {
  const row = db.prepare(`SELECT favorite FROM audio_library WHERE id = ?`).get(id);
  if (!row) return null;
  const newValue = row.favorite ? 0 : 1;
  db.prepare(`UPDATE audio_library SET favorite = ? WHERE id = ?`).run(newValue, id);
  return !!newValue;
}
module.exports = {
  recordTransaction, getSummary, getTransactions, setBudget, estimateCost,
  saveCampaign, listCampaigns, getCampaign, USD_TO_INR_RATE,
  saveRunItem, getCompletedRunItems, clearRunItems, listRunItems,
  getReliabilityHealth, getSettingJson, setSettingJson,
  recordImageContentBlockModel, getConfirmedLikenessBlockModels,
  shouldVerifyThisTime, recordVerificationResult, getVerificationTrust, listAllVerificationStats,
  saveCustomVoice, listCustomVoices, touchCustomVoiceLastUsed, deleteCustomVoice,
  getVoicePreview, saveVoicePreview,
  categorizeTransaction, getRunSpend, getRunSpendMap, getModelSuccessStats,
  getModelFieldCorrection, saveModelFieldCorrection,
  saveAudioLibraryItem, listAudioLibraryItems, deleteAudioLibraryItem, toggleAudioLibraryFavorite,
};