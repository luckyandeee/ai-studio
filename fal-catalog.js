// ============================================================
// FAL CATALOG VERIFIER — the live-wiring layer on top of verify-models.js's
// same idea. Checks the curated registry (fal-models.js) against Fal's own
// documented Platform Models API (https://api.fal.ai/v1/models) in the
// background, and caches the result in memory for GET /api/models to
// merge in.
//
// Deliberately does NOT auto-add newly-discovered models to the
// selectable registry — knowing a model exists and is "active" doesn't
// mean this app's code sends it the right field names (that's exactly
// the class of bug this whole verification effort exists to catch, not
// repeat by auto-trusting raw discovery data). What this DOES do safely,
// with no judgment call required: automatically stop offering a
// registered model once Fal itself reports it deprecated or gone, so a
// stale dropdown option can't silently fail a real paid generation.
// ============================================================

const API_BASE = "https://api.fal.ai/v1";
const { buildExampleSnippet, detectSchema } = require("./fal-schema-utils");
const db = require("./db");

// modelId -> { status, displayName, description, category, exampleCode, checkedAt }
const liveStatusCache = new Map();
let lastRefreshAttempt = null;
let lastRefreshError = null;
let isVerifying = false; // true while refreshModelLiveStatus is actively running — lets the UI show a real "this is happening right now" state instead of silence, especially now that a single rate-limited call can take 57+ seconds to resolve

// ============================================================
// PERSISTENCE — the cache survives server restarts now, stored in the
// same SQLite settings table as everything else (see db.js). Without
// this, EVERY restart — including every nodemon auto-restart while
// actively developing, which can happen dozens of times an hour — re-hit
// Fal's live API from a completely empty cache. That repeated churn was
// a real contributor to the rate-limiting seen in production, not just
// an efficiency nicety. On startup, a persisted cache newer than its
// freshness window is used as-is with ZERO live calls; only a stale or
// missing cache triggers a real check.
// ============================================================
const REGISTRY_CACHE_KEY = "model_catalog_registry_cache";
const BROWSE_CACHE_KEY = "model_catalog_browse_cache";
const REGISTRY_FRESHNESS_MS = 6 * 60 * 60 * 1000; // matches the periodic re-check interval
const BROWSE_FRESHNESS_MS = 72 * 60 * 60 * 1000; // matches the periodic re-check interval

function loadPersistedRegistryCache() {
  const saved = db.getSettingJson(REGISTRY_CACHE_KEY);
  if (!saved?.entries || !saved?.savedAt) return false;
  const age = Date.now() - new Date(saved.savedAt).getTime();
  liveStatusCache.clear();
  saved.entries.forEach(([id, value]) => liveStatusCache.set(id, value));
  lastRefreshAttempt = saved.savedAt;
  console.log(`[Model Catalog] Loaded ${liveStatusCache.size} model(s) from a persisted cache saved ${Math.round(age / 60000)} minute(s) ago.`);
  return age < REGISTRY_FRESHNESS_MS;
}
function persistRegistryCache() {
  db.setSettingJson(REGISTRY_CACHE_KEY, { entries: [...liveStatusCache.entries()], savedAt: new Date().toISOString() });
}

function authHeaders() {
  return process.env.FAL_KEY ? { Authorization: `Key ${process.env.FAL_KEY}` } : {};
}

// ============================================================
// THE ACTUAL FIX (rate-limit handling) — every call to Fal's Models API
// used to treat a 429 exactly like a real failure and give up. This
// wraps calls with proper handling: on a 429, wait and retry instead of
// failing immediately. maxWaitMs caps how long any single wait can be —
// Fal's own Retry-After header returned 58s in production, which is
// honest but feels completely broken to someone watching it happen with
// no context. Automatic background checks use a short cap and few
// retries (fast, stays quiet); the manual "Check now" action uses a
// longer cap since a person explicitly asked and can see real progress
// on screen while it runs (see the app-wide loading overlay in app.js).
// ============================================================
async function fetchFalApi(url, { retries = 2, maxWaitMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status !== 429) return res;
    if (attempt === retries) return res; // out of attempts — let the caller handle the final failure
    const retryAfterHeader = res.headers.get("retry-after");
    const rawWaitMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : 2000 * Math.pow(2, attempt - 1);
    const waitMs = Math.min(rawWaitMs, maxWaitMs);
    console.warn(`[Model Catalog] Rate limited (429) — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${retries}${rawWaitMs > maxWaitMs ? ` (Fal asked for ${Math.round(rawWaitMs / 1000)}s, capped here)` : ""}...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function findModelsLive(endpointIds, fetchOpts = {}) {
  const params = new URLSearchParams();
  endpointIds.forEach((id) => params.append("endpoint_id", id));
  // expand=openapi-3.0 pulls the real schema so we can build an accurate
  // example code snippet from actual field names — same data source as
  // the deprecated/active status check, so this doesn't cost a separate
  // round of API calls.
  params.append("expand", "openapi-3.0");
  const res = await fetchFalApi(`${API_BASE}/models?${params.toString()}`, fetchOpts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fal Models API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Pulls every field actually useful to show a person, not just the bare
// minimum (description/category). thumbnail_url/thumbnail_animated_url
// are real example output images/previews from Fal — genuinely showing
// "what this model produces," which text alone can't. license_type
// matters specifically for a COMMERCIAL app: a model licensed "research"
// or "private" rather than "commercial" may not be legally usable for a
// paying client's product photos, and that's not something to bury.
function extractGuideMetadata(live) {
  const md = live.metadata || {};
  return {
    displayName: md.display_name || null,
    description: md.description || null,
    category: md.category || null,
    tags: md.tags || [],
    licenseType: md.license_type || null,
    thumbnailUrl: md.thumbnail_url || null,
    thumbnailAnimatedUrl: md.thumbnail_animated_url || null,
    updatedAt: md.updated_at || null,
    durationEstimate: md.duration_estimate || null,
    modelUrl: md.model_url || null,
    capabilities: detectSchema(live.openapi), // real, from the actual schema — not a guess or borrowed generic knowledge
  };
}

// Refreshes the live-status + guide cache for a given list of model IDs
// (the registry's own IDs, including hidden combine-target entries). Safe
// to call repeatedly — never throws, since a failed refresh should never
// take down anything that depends on the cache; it just leaves the
// previous (or empty) cache in place and records the error for
// diagnostics.
let verifyProgressDetail = null;
async function refreshModelLiveStatus(modelIds, { thorough = false } = {}) {
  lastRefreshAttempt = new Date().toISOString();
  isVerifying = true;
  verifyProgressDetail = thorough ? "Checking the registry against Fal's live catalog..." : null;
  try {
    const chunks = [];
    for (let i = 0; i < modelIds.length; i += 50) chunks.push(modelIds.slice(i, i + 50));
    const found = new Map();
    for (const chunk of chunks) {
      // Fast mode (the default — every automatic background check, at
      // startup and every 6h) makes ONE attempt with a short cap and
      // moves on quickly, so it can never turn into the kind of
      // multi-minute silent wait that made a normal server restart feel
      // broken. Thorough mode (only reachable via someone explicitly
      // clicking "Check now", with a real loading screen visible — see
      // app.js) gets more retry patience, since a person is actively
      // waiting and can see exactly why.
      const { models } = await findModelsLive(chunk, thorough ? { retries: 3, maxWaitMs: 15000 } : { retries: 1, maxWaitMs: 3000 });
      models.forEach((m) => found.set(m.endpoint_id, m));
    }
    const notInBatch = modelIds.filter((id) => !found.has(id));
    if (notInBatch.length && thorough) {
      // The exhaustive individual re-check ONLY runs in thorough mode
      // now. This is the slow-but-complete path someone explicitly asked
      // for — it used to run automatically on every single server
      // restart, which is exactly what turned a quick startup into a
      // multi-minute wait full of surprise 429 backoffs nobody asked to
      // sit through.
      console.log(`[Model Catalog] ${notInBatch.length} model(s) missed the batch lookup — double-checking individually (thorough check)...`);
      for (let i = 0; i < notInBatch.length; i++) {
        const id = notInBatch[i];
        verifyProgressDetail = `Double-checking ${i + 1} of ${notInBatch.length}: ${id}`;
        try {
          const { models } = await findModelsLive([id], { retries: 3, maxWaitMs: 15000 });
          if (models[0]) {
            found.set(id, models[0]);
            console.log(`[Model Catalog] "${id}" WAS found via individual lookup — batch query missed it.`);
          }
        } catch {
          // leave it unresolved — falls through to "missing" below
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else if (notInBatch.length) {
      console.log(`[Model Catalog] ${notInBatch.length} model(s) not confirmed by the quick automatic check — left as "unverified" (NOT removed from dropdowns). Settings → Model Catalog → "Check now" runs the full check if you want certainty.`);
    }
    const checkedAt = new Date().toISOString();
    modelIds.forEach((id) => {
      const live = found.get(id);
      if (!live) {
        // "missing" only after a THOROUGH check still couldn't find it —
        // "unverified" means the fast pass simply didn't dig deeper, not
        // that anything is actually wrong. Neither one removes a model
        // from the dropdowns; only an explicit "deprecated" does that.
        const status = thorough ? "missing" : "unverified";
        liveStatusCache.set(id, { status, displayName: null, description: null, category: null, exampleCode: null, checkedAt });
      } else {
        let exampleCode = null;
        try {
          exampleCode = buildExampleSnippet(id, live.openapi);
        } catch {
          exampleCode = null; // never let a snippet-building hiccup break the whole refresh
        }
        liveStatusCache.set(id, {
          status: live.metadata?.status || "unknown",
          exampleCode,
          checkedAt,
          ...extractGuideMetadata(live),
        });
      }
    });
    lastRefreshError = null;
    persistRegistryCache();
    // Only "deprecated" is a trustworthy removal signal (see the
    // corresponding filter in server.js's GET /api/models) — Fal
    // explicitly has that entry cataloged and marked it deprecated.
    // "missing" (thorough check still couldn't find it) and "unverified"
    // (fast check didn't confirm it, wasn't dug into further) both do
    // NOT mean broken — confirmed in production, every one of these
    // models is real and works. Neither ever removes a model from the
    // dropdowns.
    const removed = [...liveStatusCache.entries()].filter(([, v]) => v.status === "deprecated");
    const notInDiscoveryIndex = [...liveStatusCache.entries()].filter(([, v]) => v.status === "missing");
    const notYetVerified = [...liveStatusCache.entries()].filter(([, v]) => v.status === "unverified");
    const unindexed = [...liveStatusCache.entries()].filter(([, v]) => v.status === "unknown");
    console.log(
      `[Model Catalog] Refreshed ${modelIds.length} model(s) against Fal's live API (${thorough ? "thorough" : "fast"} check).` +
        (removed.length ? ` ${removed.length} confirmed deprecated and removed (${removed.map(([id]) => id).join(", ")}).` : "") +
        (notInDiscoveryIndex.length ? ` ${notInDiscoveryIndex.length} not found even after a thorough check but KEPT available (${notInDiscoveryIndex.map(([id]) => id).join(", ")}).` : "") +
        (notYetVerified.length ? ` ${notYetVerified.length} not confirmed by this quick check, kept available as usual (run "Check now" for certainty).` : "") +
        (unindexed.length ? ` ${unindexed.length} not yet fully indexed by Fal but still available (${unindexed.map(([id]) => id).join(", ")}).` : "") +
        (!removed.length && !notInDiscoveryIndex.length && !notYetVerified.length && !unindexed.length ? ` All confirmed active.` : ""),
    );
    return { ok: true, checkedCount: modelIds.length, flaggedCount: removed.length, unindexedCount: unindexed.length + notInDiscoveryIndex.length + notYetVerified.length };
  } catch (err) {
    lastRefreshError = err.message;
    console.warn(`[Model Catalog] Live verification failed (${err.message}) — keeping the existing registry as-is, nothing is disabled based on a failed check.`);
    return { ok: false, error: err.message };
  } finally {
    isVerifying = false;
    verifyProgressDetail = null;
  }
}

function getLiveStatus(modelId) {
  return liveStatusCache.get(modelId) || null;
}

// ============================================================
// BROWSE CATALOG CACHE — a much broader, pre-loaded set of Fal's catalog
// (not just this app's ~19 curated models), fetched WITHOUT schema
// expansion so it can pull many more results per call. This is what
// fixed the earlier "Requested limit 25 exceeds maximum of 10" error:
// that limit only applies when expand=openapi-3.0 is requested (fetching
// full schemas for many models at once is expensive) — a plain listing
// call has much more headroom. So: browse broadly and cheaply up front,
// and only fetch one model's full schema/code lazily, on demand, when
// someone actually wants to see it.
//
// Refreshed on startup and every 72 hours automatically, plus a manual
// hard-refresh trigger — per the actual ask: load everything up front so
// people can browse without needing to know exactly what to search for,
// not re-fetch narrowly on every keystroke.
// ============================================================
const BROWSE_CATEGORIES = ["image-to-image", "text-to-image", "image-to-video", "text-to-video"];
let browseCache = { models: [], lastFetched: null, fetching: false, error: null };

function loadPersistedBrowseCache() {
  const saved = db.getSettingJson(BROWSE_CACHE_KEY);
  if (!saved?.models || !saved?.lastFetched) return false;
  const age = Date.now() - new Date(saved.lastFetched).getTime();
  browseCache = { models: saved.models, lastFetched: saved.lastFetched, fetching: false, error: null };
  console.log(`[Model Catalog] Loaded ${browseCache.models.length} browse-cache model(s) from disk, saved ${Math.round(age / 60000)} minute(s) ago.`);
  return age < BROWSE_FRESHNESS_MS;
}
function persistBrowseCache() {
  db.setSettingJson(BROWSE_CACHE_KEY, { models: browseCache.models, lastFetched: browseCache.lastFetched });
}

async function fetchOneCategory(category) {
  const params = new URLSearchParams({ category, limit: "40", status: "active" });
  const res = await fetchFalApi(`${API_BASE}/models?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`category=${category} returned ${res.status}: ${body.slice(0, 150)}`);
  }
  const { models } = await res.json();
  return models.map((m) => ({ id: m.endpoint_id, ...extractGuideMetadata(m) }));
}

async function refreshBrowseCatalog() {
  if (browseCache.fetching) return browseCache; // don't stack concurrent refreshes
  browseCache.fetching = true;
  const failures = []; // { category, reason } — the actual error, not just a name
  const allModels = [];
  for (const category of BROWSE_CATEGORIES) {
    try {
      const models = await fetchOneCategory(category);
      allModels.push(...models);
    } catch (err) {
      failures.push({ category, reason: err.message });
    }
    // Small gap between categories — sequential and gently paced, not a
    // burst of simultaneous requests. This runs shortly after the
    // registry check's own individual-lookup retries (see
    // refreshModelLiveStatus above), so back-to-back call volume at
    // startup is real and worth spacing out, not just here.
    await new Promise((r) => setTimeout(r, 1500)); // real gap — 400ms wasn't enough, confirmed by actual 429s
  }
  // De-dupe (some models can legitimately appear in more than one category)
  const seen = new Set();
  const deduped = allModels.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  browseCache = {
    models: deduped,
    lastFetched: new Date().toISOString(),
    fetching: false,
    error: failures.length ? failures.map((f) => `${f.category}: ${f.reason}`).join(" | ") : null,
  };
  persistBrowseCache();
  console.log(
    `[Model Catalog] Browse cache refreshed: ${deduped.length} model(s) across ${BROWSE_CATEGORIES.length} categories.` +
      (failures.length ? ` ${failures.length} category fetch(es) failed — ${failures.map((f) => `[${f.category}] ${f.reason}`).join("; ")}` : ""),
  );
  return browseCache;
}

function getBrowseCache() {
  return browseCache;
}

function searchBrowseCache({ q, category }) {
  let results = browseCache.models;
  if (category) results = results.filter((m) => m.category === category);
  if (q) {
    const needle = q.toLowerCase();
    results = results.filter(
      (m) =>
        (m.displayName || "").toLowerCase().includes(needle) ||
        (m.description || "").toLowerCase().includes(needle) ||
        m.id.toLowerCase().includes(needle) ||
        (m.tags || []).some((t) => t.toLowerCase().includes(needle)),
    );
  }
  return results;
}

// Lazy, single-model full-detail fetch (WITH schema expansion) — used
// only when someone clicks to view a specific browsed model's example
// code, never for the broad listing above. One model well under Fal's
// expand-mode limit, so this never hits the same wall the old bulk
// search did.
async function getSingleModelDetail(modelId) {
  const { models } = await findModelsLive([modelId]);
  const m = models[0];
  if (!m) return null;
  let exampleCode = null;
  try {
    exampleCode = buildExampleSnippet(modelId, m.openapi);
  } catch {
    exampleCode = null;
  }
  return { id: modelId, exampleCode, ...extractGuideMetadata(m) };
}

// Guide info for the frontend "Model Guide" panel — description,
// category, thumbnail image, license type, and a real example code
// snippet, all sourced from Fal's own live schema/catalog data rather
// than anything hand-written per model.
function getGuide(modelId) {
  const entry = liveStatusCache.get(modelId);
  if (!entry) return null;
  const { status, ...guide } = entry;
  return guide;
}

function getRefreshMeta() {
  return {
    lastRefreshAttempt,
    lastRefreshError,
    cachedCount: liveStatusCache.size,
    isVerifying,
    verifyProgressDetail,
    isBrowsing: browseCache.fetching,
    browseLastFetched: browseCache.lastFetched,
    browseCount: browseCache.models.length,
  };
}

// Called once at server startup, before deciding whether to do a live
// check at all. Returns whether each cache is still fresh — if both are
// fresh, the caller (server.js) can skip live API calls ENTIRELY on this
// boot, which is the actual point: a nodemon restart 30 seconds after the
// last real check should cost zero Fal API calls, not repeat the whole
// process from an empty cache.
function initFromPersistedCache() {
  const registryFresh = loadPersistedRegistryCache();
  const browseFresh = loadPersistedBrowseCache();
  return { registryFresh, browseFresh };
}

module.exports = {
  refreshModelLiveStatus,
  getLiveStatus,
  getGuide,
  getRefreshMeta,
  refreshBrowseCatalog,
  getBrowseCache,
  searchBrowseCache,
  getSingleModelDetail,
  initFromPersistedCache,
};