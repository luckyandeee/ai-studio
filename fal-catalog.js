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
const { buildExampleSnippet, detectSchema, classifyModelCapabilities } = require("./fal-schema-utils");
const db = require("./db");
const { falTextRequest } = require("./fal-client");

// modelId -> { status, displayName, description, category, exampleCode, checkedAt }
const liveStatusCache = new Map();
let lastRefreshAttempt = null;
let lastRefreshError = null;
let isVerifying = false; // true while refreshModelLiveStatus is actively running — lets the UI show a real "this is happening right now" state instead of silence, especially now that a single rate-limited call can take 57+ seconds to resolve
// Real, lightweight rate-limit visibility — genuinely missing before:
// this app could tell you a check failed, but never specifically that
// it was a 429, or what Fal actually asked for. Updated directly
// inside fetchFalApi below whenever a 429 is seen, regardless of which
// call path triggered it.
let last429At = null;
let last429RetryAfterSeconds = null;
// REAL GAP FOUND AND FIXED HERE: retries were already correctly removed
// from WITHIN a single call (registry checks use retries:1, meaning
// zero wait/retry happens inside fetchFalApi at all for that path) —
// but nothing stopped a genuinely NEW call, from a DIFFERENT trigger
// entirely (a fresh "Check now" click, the next scheduled interval),
// from firing again seconds later, straight back into a window Fal
// explicitly just told us to wait out. This is the real fix: honor
// that told wait BEFORE attempting anything new at all, regardless of
// which trigger is asking — not another retry, a genuine "not yet" gate
// checked once, up front, by every entry point below.
function isWithinFalCooldown() {
  if (!last429At || !last429RetryAfterSeconds) return { onCooldown: false };
  const cooldownEndsAt = new Date(last429At).getTime() + last429RetryAfterSeconds * 1000;
  const remainingMs = cooldownEndsAt - Date.now();
  return remainingMs > 0 ? { onCooldown: true, remainingMs, cooldownEndsAt: new Date(cooldownEndsAt).toISOString() } : { onCooldown: false };
}

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
    const retryAfterHeader = res.headers.get("retry-after");
    last429At = new Date().toISOString();
    last429RetryAfterSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
    if (attempt === retries) return res; // out of attempts — let the caller handle the final failure
    const rawWaitMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : 2000 * Math.pow(2, attempt - 1);
    const waitMs = Math.min(rawWaitMs, maxWaitMs);
    console.log(`[Model Catalog] Rate limited (429) — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${retries}${rawWaitMs > maxWaitMs ? ` (Fal asked for ${Math.round(rawWaitMs / 1000)}s, capped here)` : ""}...`);
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
//
// ============================================================
// REAL REDESIGN, replacing the previous fix that made things WORSE under
// real pressure — confirmed directly against real production output: a
// batch 404 triggered recursive splitting, which triggered a real 429,
// which triggered MULTIPLE independent 8-34-58s retry waits stacking up
// back to back, on BOTH the automatic startup check AND a manual
// "Check now" click. That's a genuine risk of Fal rate-limiting or
// blocking this app's key, not just a slow refresh — worth fixing
// properly, not patching again.
//
// New strategy, in priority order:
// 1. Cross-reference every model ID against the browse cache FIRST —
//    genuinely zero extra API calls, since that data is already sitting
//    in memory. The browse cache queries by category/search text
//    (status=active), never by a specific endpoint_id list, so it's
//    structurally immune to the "one bad ID 404s the whole batch"
//    problem — it just returns whatever's really out there. For any
//    curated model that shows up there, that alone is real confirmation
//    it's active, at zero cost.
// 2. Only the (usually much smaller) remainder — IDs the browse cache
//    doesn't happen to cover — gets a SINGLE live batch attempt. No
//    recursive splitting, no isolating exactly which ID is bad anymore
//    — that precision isn't worth the retry-storm risk it created.
// 3. On ANY failure from that single attempt — 404, 429, anything —
//    stop immediately and mark the rest "unverified" for this pass.
//    Never retry through a rate limit for a non-critical background
//    check; the next scheduled attempt (or an explicit "Check now"
//    later) tries again on its own, once real breathing room has
//    passed.
// ============================================================
let verifyProgressDetail = null;
async function refreshModelLiveStatus(modelIds, { thorough = false } = {}) {
  // REAL GAP FOUND AND FIXED HERE: isVerifying was already tracked and
  // exposed for UI display, but never actually CHECKED — it recorded
  // that a check was in progress without ever preventing a second,
  // overlapping one from starting. refreshBrowseCatalog already had
  // this exact guard (browseCache.fetching, checked synchronously
  // before any await — safe in Node's single-threaded model); this
  // mirrors that same proven pattern here. Matters most when the
  // 6-hour periodic interval happens to land while a "Check now" click
  // is still mid-flight — without this, both would run concurrently,
  // doubling live-check call volume at exactly the moment concurrent
  // pressure is already highest.
  if (isVerifying) {
    console.log(`[Model Catalog] A registry check is already in progress — skipping this overlapping request rather than running two at once.`);
    return { ok: true, checkedCount: 0, flaggedCount: 0, unindexedCount: 0, skippedAsAlreadyRunning: true };
  }
  lastRefreshAttempt = new Date().toISOString();
  isVerifying = true;
  verifyProgressDetail = thorough ? "Checking the registry against Fal's live catalog..." : null;
  try {
    const browseCacheMap = new Map(browseCache.models.map((m) => [m.id, m]));
    const resolvedViaBrowseCache = new Set();
    const needsLiveCheck = [];
    modelIds.forEach((id) => {
      if (browseCacheMap.has(id)) resolvedViaBrowseCache.add(id);
      else needsLiveCheck.push(id);
    });
    console.log(`[Model Catalog] Resolved ${resolvedViaBrowseCache.size}/${modelIds.length} model(s) directly from the already-fetched browse cache — zero extra Fal calls. ${needsLiveCheck.length} genuinely need a live check.`);

    const found = new Map(); // id -> Fal's raw shape (metadata + openapi), only for genuinely live-checked IDs
    let stoppedEarly = false;
    if (needsLiveCheck.length) {
      // Real fix, distinct from "no retries" (already true): even with
      // zero retries WITHIN one call, nothing previously stopped a
      // genuinely NEW call — from a fresh "Check now" click, or the
      // next scheduled interval — from firing straight back into a
      // window Fal just told us to wait out. Checked once, up front,
      // before attempting anything — not another retry, a real "not
      // yet" gate.
      const cooldown = isWithinFalCooldown();
      if (cooldown.onCooldown) {
        console.log(`[Model Catalog] Still inside Fal's own requested wait window from a recent rate limit (${Math.ceil(cooldown.remainingMs / 1000)}s remaining, until ${cooldown.cooldownEndsAt}) — skipping the live check entirely this pass rather than attempting straight back into it. These stay pending verification.`);
        stoppedEarly = true;
      }
    }
    if (needsLiveCheck.length && !stoppedEarly) {
      const chunks = [];
      for (let i = 0; i < needsLiveCheck.length; i += 50) chunks.push(needsLiveCheck.slice(i, i + 50));
      for (const chunk of chunks) {
        try {
          const { models } = await findModelsLive(chunk, { retries: 1, maxWaitMs: thorough ? 8000 : 3000 });
          models.forEach((m) => found.set(m.endpoint_id, m));
        } catch (err) {
          console.log(`[Model Catalog] Live check for ${chunk.length} remaining model(s) didn't complete this pass (${err.message}) — not retrying or splitting further to avoid repeated calls. They're marked pending verification, not broken; the next scheduled check tries again.`);
          stoppedEarly = true;
          break; // real backoff — do not attempt any further chunks this pass, respect whatever just happened (404 or 429 alike)
        }
      }
    }
    if (needsLiveCheck.length && !stoppedEarly) {
      const stillMissing = needsLiveCheck.filter((id) => !found.has(id));
      if (stillMissing.length) {
        console.log(`[Model Catalog] ${stillMissing.length} model(s) not independently confirmed this pass — pending verification (not removed, not treated as broken).`);
      }
    }
    const checkedAt = new Date().toISOString();
    modelIds.forEach((id) => {
      if (resolvedViaBrowseCache.has(id)) {
        // Browse-cache data is already the same extractGuideMetadata
        // shape liveStatusCache entries use — just missing openapi (the
        // browse fetch never requested expand=openapi-3.0), so this
        // preserves whatever example snippet a PRIOR live check already
        // cached for this ID rather than wiping it out.
        const browseEntry = browseCacheMap.get(id);
        const priorEntry = liveStatusCache.get(id);
        liveStatusCache.set(id, {
          status: "active", // the browse query itself filters status=active — showing up here IS the confirmation
          exampleCode: priorEntry?.exampleCode || null,
          checkedAt,
          displayName: browseEntry.displayName,
          description: browseEntry.description,
          category: browseEntry.category,
          tags: browseEntry.tags,
          licenseType: browseEntry.licenseType,
          thumbnailUrl: browseEntry.thumbnailUrl,
          thumbnailAnimatedUrl: browseEntry.thumbnailAnimatedUrl,
          updatedAt: browseEntry.updatedAt,
          durationEstimate: browseEntry.durationEstimate,
          modelUrl: browseEntry.modelUrl,
          capabilities: browseEntry.capabilities,
        });
        return;
      }
      const live = found.get(id);
      if (!live) {
        // "missing" only after a THOROUGH check still couldn't find it —
        // "unverified" means the fast pass simply didn't dig deeper, not
        // that anything is actually wrong. Neither one removes a model
        // from the dropdowns; only an explicit "deprecated" does that.
        // A backoff-interrupted pass (stoppedEarly) is always
        // "unverified," even in thorough mode — a rate limit is not the
        // same signal as a real, completed, still-couldn't-find-it check.
        const status = thorough && !stoppedEarly ? "missing" : "unverified";
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
    // REAL GAP FOUND AND FIXED HERE: this used to report counts computed
    // over the ENTIRE accumulated liveStatusCache (every model ever
    // checked across every past session), while the "N model(s)
    // refreshed" figure in the same line was scoped to just THIS call's
    // modelIds — two different denominators in one sentence, exactly
    // the kind of count mismatch that's confusing to read. Also phrased
    // every non-100%-clean result as an implicit problem ("X not
    // confirmed...") rather than a normal status. Rescoped to just this
    // call's modelIds, and reworded into a calm summary line — a model
    // "pending verification" isn't broken, it just hasn't been
    // independently double-checked yet, and framing it as a warning
    // every single refresh was misleading about what's actually true.
    const thisCallStatuses = modelIds.map((id) => liveStatusCache.get(id)?.status);
    const deprecatedCount = thisCallStatuses.filter((s) => s === "deprecated").length;
    const verifiedCount = thisCallStatuses.filter((s) => s === "active").length;
    const pendingCount = modelIds.length - deprecatedCount - verifiedCount;
    console.log(
      `[Model Catalog] Catalog ready · ${modelIds.length} models · ${verifiedCount} verified · ${pendingCount} pending verification` +
        (deprecatedCount ? ` · ${deprecatedCount} deprecated (removed: ${thisCallStatuses.map((s, i) => (s === "deprecated" ? modelIds[i] : null)).filter(Boolean).join(", ")})` : ""),
    );
    // Kept for the return value below and any other consumer that reads
    // the full accumulated cache (e.g. Settings → Model Catalog) — just
    // no longer conflated with the per-call log line above.
    const removed = [...liveStatusCache.entries()].filter(([, v]) => v.status === "deprecated");
    const notInDiscoveryIndex = [...liveStatusCache.entries()].filter(([, v]) => v.status === "missing");
    const notYetVerified = [...liveStatusCache.entries()].filter(([, v]) => v.status === "unverified");
    const unindexed = [...liveStatusCache.entries()].filter(([, v]) => v.status === "unknown");
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
// Confirmed as real Fal category values by directly observing them as
// the self-reported category on real Fal model pages (ElevenLabs TTS,
// Chatterbox Speech-to-Speech, etc.) — not guessed. Image/video
// categories were already covered; audio was the real, confirmed gap.
// REAL GAP FOUND AND FIXED HERE: confirmed directly from Fal's own docs
// example values that "image-editing" is a real, valid category
// (fal.ai/docs/documentation/setting-up/mcp lists it explicitly
// alongside text-to-image, image-to-video, etc.) — this app's own
// upscale/outpaint/photo-restoration utility models fall under exactly
// this category and had zero category-level coverage before, only
// relying on the (fuzzier, less reliable) search-term safety net.
const BROWSE_CATEGORIES = ["image-to-image", "text-to-image", "image-to-video", "text-to-video", "text-to-speech", "text-to-audio", "speech-to-speech", "text-to-music", "image-editing"];
// Safety net for categories this app doesn't know the exact slug for —
// Fal's own /models search matches free text against name, description,
// AND category, so a plain-language term still finds relevant models
// even if this app's guessed category slug above is slightly wrong or
// Fal renames/adds one. Deliberately not relied on alone (category
// filtering above is more precise when it works) — this exists purely
// to catch what a wrong/missing category guess would otherwise lose.
// REAL GAP FOUND AND FIXED HERE: checked the exact model IDs that
// consistently failed to resolve in a real production log, and traced
// several of them (upscalers, outpainting, photo restoration) to having
// ZERO search-term coverage at all here, not just bad luck with Fal's
// per-term result limit — these categories were simply never searched
// for, so they could never be resolved for free from the browse cache
// and always needed a separate live check. Added the missing terms so
// they get picked up by this list's own already-well-paced (1.5s/term)
// refresh cycle going forward.
const DISCOVERY_SAFETY_NET_TERMS = ["voice clone", "sound effect generator", "talking avatar", "lip sync", "video background removal", "music generation", "image upscaler", "outpainting", "photo restoration"];
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
  // REAL REVERSAL, and a real lesson: the previous version of this
  // comment argued a real, honored wait "costs nothing a person
  // notices" for a background refresh — confirmed directly wrong in
  // production. A single rate-limited item retrying with a real
  // honored wait can cost up to 60 real seconds before even moving to
  // the next item; with several items hitting this in the same sweep
  // (confirmed: two separate 21s and 43s waits logged back to back
  // during one "Check now" click), the whole operation can silently
  // stretch to multiple minutes with zero visible progress — which is
  // its own real UX problem, arguably worse than the rate limit itself.
  // Matches the registry check's already-correct policy now: zero
  // retries within a single call. A 429 fails that ONE item
  // immediately, records the real Retry-After via last429At (see
  // isWithinFalCooldown), and the sweep's own adaptive backoff +
  // 2-consecutive-429s early stop + the cooldown gate on the NEXT
  // attempt do the actual work of respecting Fal's rate limit — none
  // of which require sitting still inside a single call to do it.
  const params = new URLSearchParams({ category, limit: "100", status: "active" });
  const res = await fetchFalApi(`${API_BASE}/models?${params.toString()}`, { retries: 1 });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`category=${category} returned ${res.status}: ${body.slice(0, 150)}`), { status: res.status });
  }
  const { models } = await res.json();
  return models.map((m) => ({ id: m.endpoint_id, ...extractGuideMetadata(m) }));
}
// Free-text pass — Fal's own /models search matches q against name,
// description, AND category, so this catches anything a wrong/missing
// category guess above would otherwise miss entirely.
async function fetchOneSearchTerm(term) {
  const params = new URLSearchParams({ q: term, limit: "40", status: "active" }); // same real reasoning as fetchOneCategory's limit increase above
  const res = await fetchFalApi(`${API_BASE}/models?${params.toString()}`, { retries: 1 }); // same real reversal as fetchOneCategory above — zero retries, not a long honored wait
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`q="${term}" returned ${res.status}: ${body.slice(0, 150)}`), { status: res.status });
  }
  const { models } = await res.json();
  return models.map((m) => ({ id: m.endpoint_id, ...extractGuideMetadata(m) }));
}

async function refreshBrowseCatalog() {
  if (browseCache.fetching) return browseCache; // don't stack concurrent refreshes
  // Same real fix as refreshModelLiveStatus above — checked once, up
  // front, before this function does anything at all (including
  // setting fetching=true), so a "Check now" click or a periodic
  // interval landing inside Fal's own requested wait window is a
  // genuine no-op instead of walking straight back into the same limit.
  const cooldown = isWithinFalCooldown();
  if (cooldown.onCooldown) {
    console.log(`[Model Catalog] Still inside Fal's own requested wait window from a recent rate limit (${Math.ceil(cooldown.remainingMs / 1000)}s remaining, until ${cooldown.cooldownEndsAt}) — skipping the browse refresh entirely this pass.`);
    return browseCache;
  }
  browseCache.fetching = true;
  const failures = []; // { category, reason } — the actual error, not just a name
  const allModels = [];
  // REAL FIX FOR A REAL ROOT CAUSE: ... (see comment above)
  // IMPORTANT CORRECTNESS DETAIL: incremental saves below deliberately
  // do NOT touch lastFetched — only the very last save, after every
  // category and search term has actually finished, updates it. If
  // incremental saves stamped "now" on every partial step, an
  // interrupted refresh would look FULLY fresh to the next restart's
  // freshness check (age ≈ 0), permanently skipping the remaining
  // un-fetched categories until the next 72h cycle — quietly worse than
  // the original bug, since it would look done when it wasn't. Partial
  // model data is still genuinely worth keeping (better coverage than
  // nothing), it just can't be allowed to claim "fully refreshed."
  const priorLastFetched = browseCache.lastFetched;
  const persistProgress = () => {
    const seen = new Set();
    const deduped = allModels.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    browseCache = {
      models: deduped,
      lastFetched: priorLastFetched, // unchanged until the real completion below — see correctness note above
      fetching: true, // still mid-refresh — only the final call below sets this false
      error: failures.length ? failures.map((f) => `${f.category}: ${f.reason}`).join(" | ") : null,
    };
    persistBrowseCache();
  };
  // Real exponential backoff with jitter — see the loop below for full
  // reasoning. consecutive429s resets to 0 on any real success;
  // stoppedEarlyOnRateLimit short-circuits the rest of this sweep
  // (both loops) once rate limiting is clearly still active, rather
  // than grinding through the remaining items into the same wall.
  let consecutive429s = 0;
  let stoppedEarlyOnRateLimit = false;
  function backoffDelayMs(consecutiveFailures) {
    const base = 3000 * Math.pow(2, consecutiveFailures); // 3s, 6s, 12s, ... doubling per consecutive 429
    const capped = Math.min(base, 20000);
    const jitter = Math.random() * 1000; // real jitter — avoids this process (and anything else sharing the key) waiting the exact same round number every time
    return capped + jitter;
  }
  for (const category of BROWSE_CATEGORIES) {
    try {
      const models = await fetchOneCategory(category);
      allModels.push(...models);
      consecutive429s = 0; // a real success resets the backoff — no reason to stay cautious once Fal's clearly not rate-limiting us anymore
    } catch (err) {
      failures.push({ category, reason: err.message });
      if (err.status === 429) consecutive429s++;
    }
    persistProgress();
    // REAL GAP FOUND AND FIXED HERE: this used to pace every item at
    // the same fixed 3s regardless of what just happened — plowing
    // ahead at full speed immediately after a real 429 is exactly
    // backwards. Real exponential backoff now: each consecutive 429
    // doubles the gap before the next item (capped at 20s), with a
    // small random jitter so this process isn't waiting the exact same
    // round number every time. Two 429s in a row stops the WHOLE sweep
    // early rather than grinding through the remaining items at a
    // rate limit that's clearly still active — safe to do, since
    // whatever's already been fetched is already saved (see
    // persistProgress above), nothing is lost by stopping.
    if (consecutive429s >= 2) {
      console.log(`[Model Catalog] Hit rate limits ${consecutive429s} times in a row — stopping this sweep early rather than continuing to push against it. Whatever was already fetched is saved; the rest picks up on the next scheduled refresh.`);
      stoppedEarlyOnRateLimit = true;
      break;
    }
    await new Promise((r) => setTimeout(r, backoffDelayMs(consecutive429s)));
  }
  for (const term of stoppedEarlyOnRateLimit ? [] : DISCOVERY_SAFETY_NET_TERMS) {
    try {
      const models = await fetchOneSearchTerm(term);
      allModels.push(...models);
      consecutive429s = 0;
    } catch (err) {
      failures.push({ category: `q="${term}"`, reason: err.message });
      if (err.status === 429) consecutive429s++;
    }
    persistProgress();
    if (consecutive429s >= 2) {
      console.log(`[Model Catalog] Hit rate limits ${consecutive429s} times in a row — stopping this sweep early rather than continuing to push against it. Whatever was already fetched is saved; the rest picks up on the next scheduled refresh.`);
      stoppedEarlyOnRateLimit = true;
      break;
    }
    await new Promise((r) => setTimeout(r, backoffDelayMs(consecutive429s)));
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
    `[Model Catalog] Browse cache refreshed: ${deduped.length} model(s) across ${BROWSE_CATEGORIES.length} categories + ${DISCOVERY_SAFETY_NET_TERMS.length} safety-net search(es).` +
      (failures.length ? ` ${failures.length} category fetch(es) failed — ${failures.map((f) => `[${f.category}] ${f.reason}`).join("; ")}` : ""),
  );
  return browseCache;
}

// ============================================================
// NORMALIZED MODEL STATUS — the exact 8-state model requested
// (DISCOVERED/VERIFIED/SUPPORTED/SELECTABLE/FAILED/DEPRECATED/
// UNAVAILABLE/UNKNOWN), computed from signals this app ALREADY tracks
// (live-status cache, discovered-models cache, learned corrections,
// real usage stats) — not a new tracking mechanism, a new lens on data
// already collected. Deliberately conservative, matching the
// already-learned "missing != broken" lesson elsewhere in this file: a
// model only ever moves to DEPRECATED or FAILED on strong, explicit
// evidence (provider's own deprecated flag, or enough real failed
// generation attempts), never on a missed search, rate limit, or
// timeout.
//
// UNAVAILABLE is defined but deliberately left effectively unreachable
// from current signals — this app has no reliable way to distinguish a
// genuine confirmed-404 from a temporary discovery-index miss (the
// "missing" status has shown real false positives even on repeated
// checks), so treating anything as UNAVAILABLE right now would
// reintroduce the exact bug already fixed once. DEPRECATED (provider's
// own explicit flag) and FAILED (real usage data) are the two
// legitimate removal/warning signals this app can actually back up
// today.
// ============================================================
const MODEL_STATUS = {
  DISCOVERED: "discovered",
  VERIFIED: "verified",
  SUPPORTED: "supported",
  SELECTABLE: "selectable",
  FAILED: "failed",
  DEPRECATED: "deprecated",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown",
};
function getNormalizedStatus(modelId, { isCurated = false } = {}) {
  const live = liveStatusCache.get(modelId);
  const discovered = discoveredModelsCache.get(modelId);
  const correction = db.getModelFieldCorrection(modelId);
  const usageStats = db.getModelSuccessStats(modelId);

  if (live?.status === "deprecated") {
    return { status: MODEL_STATUS.DEPRECATED, reason: "Provider explicitly marked this model deprecated.", detail: live };
  }
  // Real usage confirming a problem is a much stronger signal than a
  // single discovery-check miss — needs a real sample size (5+ attempts)
  // before it's trusted, not one unlucky call.
  if (usageStats.totalCount >= 5 && usageStats.successRate < 0.2) {
    return { status: MODEL_STATUS.FAILED, reason: `${usageStats.totalCount} real attempts, only ${Math.round(usageStats.successRate * 100)}% succeeded.`, detail: usageStats };
  }
  if (isCurated) {
    return { status: MODEL_STATUS.SELECTABLE, reason: "Curated entry with a confirmed, hand-verified request shape.", detail: live || null };
  }
  if (discovered?.classification?.classified && !discovered.excluded) {
    const hasKnownShape = !!(discovered.schemaInfo?.imageField || discovered.schemaInfo?.audioField || discovered.schemaInfo?.hasPrompt || correction);
    if (hasKnownShape) {
      return { status: MODEL_STATUS.SELECTABLE, reason: "Real schema confirms how to build a request for this model.", detail: discovered.classification };
    }
    return { status: MODEL_STATUS.VERIFIED, reason: "Schema read and classified, but not enough field detail to safely build a request yet.", detail: discovered.classification };
  }
  if (discovered) {
    return { status: MODEL_STATUS.DISCOVERED, reason: "Found in the browse catalog, not yet schema-classified.", detail: null };
  }
  return { status: MODEL_STATUS.UNKNOWN, reason: "No discovery or verification data available for this model yet.", detail: null };
}

function getBrowseCache() {
  return browseCache;
}

// ============================================================
// AUTO-DISCOVERY — the actual mechanism that makes new Fal releases
// usable without a developer hand-writing an entry for them. Takes
// whatever the browse catalog found (real, live, all of Fal's active
// models in the categories/searches above) minus whatever's already in
// the hand-curated lists (fal-models.js — those stay as-is, this only
// ever ADDS to them), fetches each new one's real schema, classifies it
// via classifyModelCapabilities (objective facts only), and persists the
// result. Processes a bounded batch per call (not the whole backlog at
// once) — each new model needs its own schema-expand API call, so a
// first-ever run against a large backlog spreads itself across several
// scheduled sync passes rather than firing dozens of calls in one burst.
// ============================================================
const DISCOVERED_MODELS_KEY = "discovered_models_v1";
// Matches the registry's own proven-safe chunk size (50 IDs per call,
// see refreshModelLiveStatus above) — now that this is a single batched
// call regardless of size (see the fix below), there's no longer a
// reason to keep this artificially small.
const DISCOVERY_BATCH_SIZE = 40;
let discoveredModelsCache = new Map(); // id -> { id, guideMetadata, schemaInfo, classification, discoveredAt }
function loadPersistedDiscoveredModels() {
  const saved = db.getSettingJson(DISCOVERED_MODELS_KEY);
  if (Array.isArray(saved)) {
    discoveredModelsCache = new Map(saved.map((m) => [m.id, m]));
    console.log(`[Model Catalog] Loaded ${discoveredModelsCache.size} previously auto-discovered model(s) from disk.`);
  }
}
function persistDiscoveredModels() {
  db.setSettingJson(DISCOVERED_MODELS_KEY, [...discoveredModelsCache.values()]);
}

// ============================================================
// REAL GAP FOUND AND FIXED HERE: discovery sync and enrichment both
// already had their own sensible 30-minute setInterval for a
// long-running server — genuinely fine on its own. The actual problem
// was separate: the STARTUP path called both of these unconditionally,
// 5 seconds after every single boot, regardless of whether the last
// run was 30 minutes ago or 30 seconds ago. In an active nodemon dev
// environment restarting on every file save, that meant up to ~19
// real Fal calls (a discovery batch + up to 8 individual fallbacks +
// up to 10 enrichment LLM calls) firing again and again, seconds
// apart, every single restart — exactly the "feels like hammering
// Fal" pattern being asked about, and a real, additional one beyond
// the registry/browse cache fix from earlier. This tracks the last
// time each actually ran (persisted, survives restarts) so the
// startup path can skip re-triggering something that just ran
// recently, the same freshness-check principle already proven for
// the registry and browse caches above — just applied here too.
const DISCOVERY_SYNC_COOLDOWN_KEY = "discovery_sync_last_run";
const ENRICHMENT_COOLDOWN_KEY = "enrichment_last_run";
const SYNC_COOLDOWN_MS = 30 * 60 * 1000; // matches the periodic interval's own natural cadence
function isOnCooldown(key, cooldownMs) {
  const lastRun = db.getSettingJson(key);
  if (!lastRun?.at) return false;
  return Date.now() - new Date(lastRun.at).getTime() < cooldownMs;
}
function markRan(key) {
  db.setSettingJson(key, { at: new Date().toISOString() });
}

async function syncDiscoveredModels(curatedIds) {
  // See the cooldown mechanism's own comment above (DISCOVERY_SYNC_COOLDOWN_KEY)
  // — skips the whole operation, including its own real Fal calls,
  // if this already ran within the cooldown window, regardless of
  // whether this call came from the startup path or the periodic
  // interval.
  if (isOnCooldown(DISCOVERY_SYNC_COOLDOWN_KEY, SYNC_COOLDOWN_MS)) return { newlyDiscovered: 0, remaining: 0, skippedOnCooldown: true };
  const curatedSet = new Set(curatedIds);
  const candidates = browseCache.models.filter((m) => !curatedSet.has(m.id) && !discoveredModelsCache.has(m.id));
  if (!candidates.length) return { newlyDiscovered: 0, remaining: 0 };
  markRan(DISCOVERY_SYNC_COOLDOWN_KEY);
  const toProcess = candidates.slice(0, DISCOVERY_BATCH_SIZE);
  // Real, confirmed bug fixed here: this used to call getSingleModelDetail
  // once PER candidate — a separate API call for each of up to
  // DISCOVERY_BATCH_SIZE models, one right after another. That's exactly
  // the mistake the registry's OWN check already learned from and fixed
  // (see refreshModelLiveStatus above, and its "used to run automatically
  // on every server restart" comment) — confirmed in production here too:
  // a 15-candidate batch triggered repeated 429s, capped retry waits that
  // were too short to actually clear Fal's real rate window (which asked
  // for waits up to 57s), and the whole batch failed with 0 classified.
  // Fixed the same way the registry fixes it: ONE batched findModelsLive
  // call for the whole set (well under its own 50-per-chunk cap), not one
  // call per model.
  let found;
  try {
    const result = await findModelsLive(toProcess.map((c) => c.id), { retries: 2, maxWaitMs: 8000 });
    found = new Map(result.models.map((m) => [m.endpoint_id, m]));
  } catch (err) {
    console.warn(`[Model Discovery] Batch lookup failed (${err.message}) — will retry this whole batch on a later sync.`);
    return { newlyDiscovered: 0, remaining: candidates.length };
  }
  // Real, confirmed bug fixed here: Fal's batched endpoint_id lookup
  // misses most specific IDs when queried together (confirmed directly
  // in production — the registry's own thorough check saw a 34/44 miss
  // rate on the exact same kind of batched query), and this had no
  // fallback for that at all — anything missed was silently skipped
  // forever, which is why a 40-candidate batch classified exactly zero.
  // Reuses the registry's own proven individual-lookup fallback, but
  // capped to a SMALL number per sync (not all of them) — the registry
  // only runs its version in rare, manual "thorough" mode; this runs
  // automatically every 30 minutes, so re-checking dozens of missed IDs
  // individually every single cycle would just recreate the original
  // rate-limit storm on a recurring schedule instead of a one-time event.
  const missed = toProcess.filter((c) => !found.has(c.id));
  const INDIVIDUAL_FALLBACK_CAP = 8;
  if (missed.length) {
    console.log(`[Model Discovery] ${missed.length} model(s) missed the batch lookup — individually double-checking up to ${INDIVIDUAL_FALLBACK_CAP} of them this pass (the rest retry on a later sync).`);
    for (const candidate of missed.slice(0, INDIVIDUAL_FALLBACK_CAP)) {
      try {
        const { models } = await findModelsLive([candidate.id], { retries: 2, maxWaitMs: 8000 });
        if (models[0]) found.set(candidate.id, models[0]);
      } catch (err) {
        console.warn(`[Model Discovery] Individual lookup failed for ${candidate.id} (${err.message}) — will retry on a later sync.`);
      }
      await new Promise((r) => setTimeout(r, 2000)); // real pacing — see refreshBrowseCatalog's own tuning notes on why this can't be shorter
    }
  }
  let added = 0;
  for (const candidate of toProcess) {
    const live = found.get(candidate.id);
    if (!live) continue; // not found in this batch — left unprocessed, will be retried next sync rather than guessed at
    try {
      const detail = { id: candidate.id, ...extractGuideMetadata(live) };
      const classification = classifyModelCapabilities(detail.capabilities, {
        category: detail.category, tags: detail.tags, description: detail.description,
      });
      // Only keep what's actually relevant to this app — a real image/
      // video/audio model with an understandable schema. Everything
      // else (3D, training, understanding/analysis models, anything the
      // schema-read failed on) is deliberately left out rather than
      // cluttering the picker with things this app has no use for.
      if (classification.classified && classification.mediaType !== "unknown" && classification.workType !== "unknown") {
        discoveredModelsCache.set(candidate.id, {
          id: candidate.id,
          guideMetadata: { displayName: detail.displayName, description: detail.description, category: detail.category, tags: detail.tags, licenseType: detail.licenseType, thumbnailUrl: detail.thumbnailUrl },
          schemaInfo: detail.capabilities,
          classification,
          aiSummary: null, // filled in lazily by a separate, cached synthesis pass — see synthesizeModelSummary
          discoveredAt: new Date().toISOString(),
        });
        added++;
      } else {
        // Still recorded (with classified:false) so this candidate isn't
        // re-fetched forever on every sync — but excluded from anything
        // user-facing via getDiscoveredModels' classified filter below.
        discoveredModelsCache.set(candidate.id, { id: candidate.id, classification, discoveredAt: new Date().toISOString(), excluded: true });
      }
    } catch (err) {
      console.warn(`[Model Discovery] Couldn't classify ${candidate.id} (${err.message}) — will retry on a later sync.`);
    }
  }
  persistDiscoveredModels();
  console.log(`[Model Discovery] Classified ${added} newly-usable model(s) this pass (${toProcess.length - added} excluded/unresolved). ${candidates.length - toProcess.length} still queued for a later sync.`);
  return { newlyDiscovered: added, remaining: candidates.length - toProcess.length };
}

// Reader for the merge step in server.js's /api/models — filters out
// anything Fal has explicitly marked deprecated (cross-checked against
// the SAME live-status cache the curated registry uses), so a model Fal
// has dropped disappears from the picker immediately without deleting
// any of its stored data — fully reversible if it turns out to be a
// false alarm, exactly the same behavior as the curated registry.
//
// Deliberately mirrors the curated registry's own real, already-fixed
// bug: "missing" (not found via Fal's Find/discovery-index lookup) is
// NOT the same as "deprecated" — confirmed in production that several
// real, working, docs-confirmed endpoints come back "missing" from that
// index simply because Fal doesn't separately index every tier/variant.
// Only an EXPLICIT "deprecated" status is a trustworthy removal signal.
function getDiscoveredModels({ mediaType = null } = {}) {
  return [...discoveredModelsCache.values()]
    .filter((m) => m.classification?.classified && !m.excluded)
    .filter((m) => !mediaType || m.classification.mediaType === mediaType)
    .filter((m) => {
      const live = liveStatusCache.get(m.id);
      return !live || live.status !== "deprecated"; // never checked yet, or found active = fine; only an explicit "deprecated" hides it
    });
}

// Unified schema-capability lookup — checks the curated registry's own
// live-checked data first (getGuide, via liveStatusCache), then falls
// back to an auto-discovered model's own schema (captured once at
// discovery time, in discoveredModelsCache) if it's not in the curated
// set. This is what lets request-building code (buildFalImageInput and
// friends) work identically for a hand-curated model and a model this
// app has never seen a human look at — one lookup, same real schema
// facts either way.
function getModelSchemaInfo(modelId) {
  const curated = liveStatusCache.get(modelId);
  if (curated?.capabilities?.detected) return curated.capabilities;
  const discovered = discoveredModelsCache.get(modelId);
  if (discovered?.schemaInfo?.detected) return discovered.schemaInfo;
  return null;
}

// ============================================================
// AI-ASSISTED MODEL ENRICHMENT — pure schema/regex classification can
// tell WHAT a model technically accepts, but not what it's actually
// GOOD for, or which family/tier it belongs to — that needs either
// real accumulated usage data (which takes time) or reading its own
// description with real understanding, which an LLM can do and a
// regex can't. Uses fal-ai/any-llm (Claude, the same model already
// used throughout this app for creative-director work) — run ONCE per
// model and cached, never regenerated, and never allowed to override
// an OBJECTIVE schema fact (see the contradiction check below). This
// is enrichment, not a new source of truth: exactly the distinction
// the person asked for when flagging that the AI doing this can
// itself be wrong sometimes.
// ============================================================
async function synthesizeModelEnrichment(modelId, { guideMetadata, schemaInfo, apiKey }) {
  if (!apiKey) return null; // can't run without a key — caller decides whether that's fatal
  const objectiveFacts = {
    mediaType: guideMetadata?.category || "unknown",
    hasImageInput: !!schemaInfo?.imageField,
    maxReferenceImages: schemaInfo?.maxImages || null,
    hasAudioInput: !!schemaInfo?.audioField,
    hasDurationControl: !!schemaInfo?.durationField,
    voiceOptions: schemaInfo?.voiceOptions?.options || null,
    languageOptions: schemaInfo?.languageOptions?.options || null,
    allRealFields: schemaInfo?.allFields || [],
  };
  const prompt = `You are enriching an entry in an AI model registry with real, honest information — this will be shown directly to users choosing between models, so accuracy matters more than sounding impressive.

MODEL: ${modelId}
FAL'S OWN LISTING:
- Display name: ${guideMetadata?.displayName || "unknown"}
- Description: ${guideMetadata?.description || "none provided"}
- Category: ${guideMetadata?.category || "unknown"}
- Tags: ${(guideMetadata?.tags || []).join(", ") || "none"}

OBJECTIVE FACTS ALREADY CONFIRMED FROM ITS REAL SCHEMA — do not contradict these, you may only explain them:
${JSON.stringify(objectiveFacts, null, 2)}

Based ONLY on the information above (never invent a fact not supported by it), write:
1. "bestFor": one honest sentence on what this model is actually good for, grounded in its real description/category — not generic marketing language.
2. "familyGuess": your best guess at which model family/provider lineage this belongs to (e.g. "Google Gemini Image family", "ByteDance Seedream family") — say "unknown" if the name/description doesn't clearly indicate one.
3. "tierGuess": if the name/description suggests a tier (fast/lite/pro/turbo/hd/standard), name it — otherwise "unknown".
4. "cautionNotes": anything worth a human double-checking before fully trusting this entry, or an empty string if nothing stands out.

Return ONLY this JSON, no markdown fences: {"bestFor": "...", "familyGuess": "...", "tierGuess": "...", "cautionNotes": "..."}`;
  try {
    const response = await falTextRequest(prompt, { apiKey, temperature: 0.3, costMeta: { endpoint: "model-enrichment", model: modelId } });
    const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    // Real, deliberate guard, directly per the person's own caution:
    // checks the LLM's own output against the objective facts it was
    // JUST HANDED — not against the real world (no way to verify that
    // here), but this catches the specific, real failure mode of the
    // model contradicting information already given to it.
    const contradictsGivenFacts =
      objectiveFacts.hasImageInput === false && /\bedit(ing)?\b/i.test(parsed.bestFor || "") && !/\b(creat|generat)/i.test(parsed.bestFor || "");
    return {
      ...parsed,
      aiSynthesized: true,
      synthesizedAt: new Date().toISOString(),
      flaggedForReview: contradictsGivenFacts,
    };
  } catch (err) {
    console.warn(`[Model Enrichment] Couldn't synthesize enrichment for ${modelId} (${err.message}) — model stays fully usable with schema-only classification, this just doesn't add the extra writeup.`);
    return null;
  }
}
// Processes a bounded batch per call, same pacing philosophy as
// syncDiscoveredModels above — an LLM call costs real money and takes
// real time per model, more than a schema fetch does, so this runs a
// smaller batch and only for models already successfully classified
// (schema-confirmed usable) that don't have enrichment yet.
const ENRICHMENT_BATCH_SIZE = 10;
async function enrichDiscoveredModels(apiKey) {
  if (!apiKey) return { enriched: 0, remaining: 0 };
  // Same real cooldown fix as syncDiscoveredModels above — see
  // ENRICHMENT_COOLDOWN_KEY's comment there for the full reasoning.
  if (isOnCooldown(ENRICHMENT_COOLDOWN_KEY, SYNC_COOLDOWN_MS)) return { enriched: 0, remaining: 0, skippedOnCooldown: true };
  const candidates = [...discoveredModelsCache.values()].filter((m) => m.classification?.classified && !m.excluded && !m.aiEnrichment);
  if (!candidates.length) return { enriched: 0, remaining: 0 };
  markRan(ENRICHMENT_COOLDOWN_KEY);
  const toProcess = candidates.slice(0, ENRICHMENT_BATCH_SIZE);
  let enriched = 0;
  for (const model of toProcess) {
    const result = await synthesizeModelEnrichment(model.id, { guideMetadata: model.guideMetadata, schemaInfo: model.schemaInfo, apiKey });
    if (result) {
      model.aiEnrichment = result;
      discoveredModelsCache.set(model.id, model);
      enriched++;
    }
    await new Promise((r) => setTimeout(r, 500)); // gentler than the schema-fetch pacing — a text model call, not the same rate-limit-prone Models API
  }
  if (enriched) persistDiscoveredModels();
  console.log(`[Model Enrichment] Enriched ${enriched}/${toProcess.length} model(s) this pass. ${candidates.length - toProcess.length} still queued for a later sync.`);
  return { enriched, remaining: candidates.length - toProcess.length };
}

function getDiscoveryStatus() {
  const usableModels = [...discoveredModelsCache.values()].filter((m) => m.classification?.classified && !m.excluded);
  return {
    totalDiscovered: discoveredModelsCache.size,
    usable: usableModels.length,
    enriched: usableModels.filter((m) => m.aiEnrichment).length,
  };
}

// ============================================================
// AUTO-PROMOTION — once a discovered model has earned enough real,
// successful generations, it becomes a genuine recommended default, not
// just an available option buried in the dropdown. This is the concrete
// meaning of "the system gets smarter over time": trust here is built
// from actual real usage outcomes (the same transactions table the
// whole ledger already relies on), not a one-time schema check.
//
// Deliberately does NOT touch the hardcoded DEFAULT_IMAGE_MODEL_PRO-
// style constants used deep in the generation pipeline as a last-resort
// safety net when nothing else is specified anywhere — those stay
// stable, since they're a genuine fallback of last resort, not a UX
// choice. What promotion actually changes is what a FRESH session's
// dropdown pre-selects — see getRecommendedDefaults, consumed by
// server.js's /api/models.
// ============================================================
const PROMOTION_MIN_SUCCESSES = parseInt(process.env.MODEL_PROMOTION_MIN_SUCCESSES, 10) || 15;
const PROMOTION_MIN_SUCCESS_RATE = parseFloat(process.env.MODEL_PROMOTION_MIN_SUCCESS_RATE) || 0.8;
function checkPromotionEligibility(modelId) {
  const stats = db.getModelSuccessStats(modelId);
  const eligible = stats.successCount >= PROMOTION_MIN_SUCCESSES && stats.successRate >= PROMOTION_MIN_SUCCESS_RATE;
  return { eligible, ...stats };
}
// Returns { image: modelId|null, video: modelId|null, audio: modelId|null }
// — the best (highest real successCount) promoted discovered model per
// media type, or null if none has earned promotion yet for that type.
// The frontend uses this to decide what a fresh session's dropdown
// pre-selects; falls back to the existing curated default whenever this
// is null, which is the common case until something genuinely earns it.
function getRecommendedDefaults() {
  const byMediaType = {};
  for (const model of getDiscoveredModels()) {
    const mediaType = model.classification?.mediaType;
    if (!mediaType) continue;
    const promo = checkPromotionEligibility(model.id);
    if (!promo.eligible) continue;
    const current = byMediaType[mediaType];
    if (!current || promo.successCount > current.successCount) {
      byMediaType[mediaType] = { id: model.id, successCount: promo.successCount, successRate: promo.successRate };
    }
  }
  return {
    image: byMediaType.image?.id || null,
    video: byMediaType.video?.id || null,
    audio: byMediaType.audio?.id || null,
  };
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
  const guide = { id: modelId, exampleCode, ...extractGuideMetadata(m) };
  // REAL GAP FOUND AND FIXED HERE: this already did a genuine, targeted,
  // single-model live confirmation — exactly the "lazy verification on
  // selection/use" mechanism worth having — but the confirmation was
  // thrown away instead of updating the registry. A model sitting
  // "pending verification" that someone then actually clicks to view
  // stayed "pending" forever afterward, even though this call just
  // proved it's real and active. Now promotes it the same way a real
  // batch verification would.
  liveStatusCache.set(modelId, { status: m.metadata?.status || "active", exampleCode, checkedAt: new Date().toISOString(), ...extractGuideMetadata(m) });
  persistRegistryCache();
  return guide;
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
    last429At,
    last429RetryAfterSeconds,
    // Real, computed prediction — not a separately-tracked value that
    // could drift out of sync with the actual freshness windows
    // (REGISTRY_FRESHNESS_MS / BROWSE_FRESHNESS_MS) elsewhere in this
    // file. Whichever of the two caches is due to expire first is
    // genuinely when the next automatic background refresh happens.
    nextCatalogRefresh: (() => {
      const registryDue = lastRefreshAttempt ? new Date(lastRefreshAttempt).getTime() + REGISTRY_FRESHNESS_MS : null;
      const browseDue = browseCache.lastFetched ? new Date(browseCache.lastFetched).getTime() + BROWSE_FRESHNESS_MS : null;
      const candidates = [registryDue, browseDue].filter((t) => t != null);
      return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
    })(),
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
  loadPersistedDiscoveredModels();
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
  syncDiscoveredModels,
  getDiscoveredModels,
  getDiscoveryStatus,
  getModelSchemaInfo,
  checkPromotionEligibility,
  getRecommendedDefaults,
  enrichDiscoveredModels,
  getNormalizedStatus,
  MODEL_STATUS,
};