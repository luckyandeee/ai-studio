// ============================================================
// VOICE CATALOG VERIFIER — extends the same "check it against the real
// API before trusting it" philosophy from fal-catalog.js to the specific
// voice IDs listed for each TTS model, not just the model endpoints
// themselves. This session hit real "Voice not found" failures for
// Josh, Alicia, Kellan, Baxter, Talia, and Wyatt — names that looked
// legitimate (sourced from real-seeming lists) but weren't actually
// live on the specific endpoint used. This is the fix: actually call
// each voice with a tiny, cheap test generation and record whether it
// really works, rather than trusting any list — including this app's
// own — at face value.
//
// Real cost awareness: each test is a genuine paid generation, so this
// only runs when the persisted cache is stale (default: 14 days — voice
// availability changes far less often than the broader model catalog),
// and uses the shortest realistic test string to keep the cost of a
// full sweep close to negligible.
// ============================================================
const db = require("./db");
const { falVoiceRequest } = require("./fal-client");
const { VOICE_MODELS } = require("./fal-models");

const CACHE_KEY = "voice_catalog_verification_cache";
const FRESHNESS_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — voices don't change as often as the broader model catalog
const TEST_TEXT = "Hi"; // shortest realistic string — keeps a full sweep's real cost close to negligible

// voiceKey ("modelId::voiceId") -> { working: boolean, checkedAt, error? }
let verifiedVoices = new Map();
let isVerifying = false;
let lastCheckedAt = null;

function loadPersistedCache() {
  const saved = db.getSettingJson(CACHE_KEY);
  if (!saved?.entries || !saved?.savedAt) return false;
  const age = Date.now() - new Date(saved.savedAt).getTime();
  verifiedVoices = new Map(saved.entries);
  lastCheckedAt = saved.savedAt;
  console.log(`[Voice Catalog] Loaded ${verifiedVoices.size} verified voice result(s) from a persisted cache saved ${Math.round(age / 3600000)} hour(s) ago.`);
  return age < FRESHNESS_MS;
}
function persistCache() {
  db.setSettingJson(CACHE_KEY, { entries: [...verifiedVoices.entries()], savedAt: new Date().toISOString() });
}

// Only checks named preset voices from confirmedVoiceIds — deliberately
// does NOT touch custom/cloned voices, which are already proven working
// the moment they're created, or freeform-entry models where there's no
// fixed list to check in the first place.
//
// Takes a real API key as an argument rather than only reading
// process.env.FAL_KEY — this app's actual auth pattern (used by every
// other route) is a key submitted from the browser and passed through
// per-request, not a server environment variable. A background task
// kicked off at cold server startup has no request context and
// therefore no key at all unless one is explicitly handed to it, which
// is why this now gets triggered from the frontend instead of blindly
// at startup.
//
// Runs with a concurrency limit (parallel batches) rather than fully
// sequential — checking ~47 voices one at a time, each a real network
// round trip, could take minutes, during which the dropdown would keep
// showing the full unverified list. Parallelizing brings this down to a
// small number of batches instead.
// Reduced from 6 — that concurrency level very likely triggered rate
// limiting on a real run, and (before this fix) EVERY error type was
// being wrongly recorded as "this voice doesn't exist," wiping out
// nearly an entire model's voice list from what was actually just
// temporary rate limiting, not real per-voice failures.
const CONCURRENCY = 3;
const BATCH_PAUSE_MS = 1500; // small gap between batches — real rate limiting insurance, not just a hopeful guess
async function verifyAllVoices(providedApiKey) {
  if (isVerifying) return;
  isVerifying = true;
  const apiKey = providedApiKey || process.env.FAL_KEY;
  if (!apiKey) {
    console.warn(`[Voice Catalog] No API key available — skipping voice verification entirely.`);
    isVerifying = false;
    return;
  }
  // REAL FIX for the actual reported bug: this used to skip the ENTIRE
  // sweep if ANY previous check had happened recently, using one global
  // timestamp — which meant a completely changed voice list (18 of 19
  // ElevenLabs names swapped) and two brand-new models (Inworld, xAI)
  // stayed permanently unverified, because the old guard never let the
  // function run again to even look at them. Freshness is now checked
  // PER VOICE: only a voice with its own recent, valid cached result
  // gets skipped — anything never seen before, or whose result predates
  // this exact model+voice pairing, always gets tested for real.
  const tasks = [];
  for (const model of VOICE_MODELS) {
    if (!model.confirmedVoiceIds?.length) continue;
    for (const voice of model.confirmedVoiceIds) {
      const voiceKey = `${model.id}::${voice.id}`;
      const existing = verifiedVoices.get(voiceKey);
      const isFresh = existing && Date.now() - new Date(existing.checkedAt).getTime() < FRESHNESS_MS;
      if (!isFresh) tasks.push({ model, voice });
    }
  }
  if (!tasks.length) {
    console.log(`[Voice Catalog] Every voice already has a fresh, real result — nothing new to check.`);
    isVerifying = false;
    return;
  }
  console.log(`[Voice Catalog] ${tasks.length} voice(s) need a real check (never tested, or their result is stale) — starting now.`);
  let checked = 0, failed = 0, inconclusive = 0;
  async function runOne({ model, voice }) {
    const voiceKey = `${model.id}::${voice.id}`;
    try {
      const input = model.buildInput(TEST_TEXT, { voiceId: voice.id });
      await falVoiceRequest(model.id, input, {
        apiKey,
        retries: 2, // give a transient issue a real chance to resolve itself before this voice is even considered inconclusive
        costMeta: { endpoint: "voice-catalog-verify", model: model.id },
        costPer1kChars: model.costPer1kChars || 0.1,
        textLength: TEST_TEXT.length,
        progressLabel: `[Voice Catalog] Verifying ${model.id} / ${voice.id}...`,
      });
      verifiedVoices.set(voiceKey, { working: true, checkedAt: new Date().toISOString() });
    } catch (err) {
      // CRITICAL: only a genuine "voice not found" message means this
      // voice actually doesn't exist. Everything else — rate limits,
      // timeouts, transient network errors, a safety block on the tiny
      // test string — is inconclusive, not proof of anything, and must
      // NOT be recorded as a confirmed failure. This is the real fix:
      // previously ANY error here was treated as "this voice is
      // broken," which is exactly what wiped out most of a model's real,
      // working voices after one rate-limited batch run.
      if (/voice not found/i.test(err.message)) {
        verifiedVoices.set(voiceKey, { working: false, checkedAt: new Date().toISOString(), error: err.message?.slice(0, 200) });
        failed++;
        console.warn(`[Voice Catalog] "${voice.id}" on ${model.id} genuinely NOT FOUND — will be hidden from the picker.`);
      } else {
        inconclusive++;
        console.warn(`[Voice Catalog] "${voice.id}" on ${model.id} had an inconclusive error (not a confirmed "voice not found") — left as-is, still visible: ${err.message?.slice(0, 150)}`);
      }
    }
    checked++;
  }
  // Simple concurrency-limited batching — chunks of CONCURRENCY run in
  // parallel, next chunk starts once the current one fully settles.
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY).map(runOne));
    if (i + CONCURRENCY < tasks.length) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    persistCache(); // save progress after each batch, not only at the very end — a mid-sweep restart or crash doesn't lose everything already confirmed
  }
  lastCheckedAt = new Date().toISOString();
  console.log(`[Voice Catalog] Checked ${checked} voice(s) — ${checked - failed - inconclusive} confirmed working, ${failed} genuinely not found (hidden), ${inconclusive} inconclusive (left visible, untouched). Cached for ${Math.round(FRESHNESS_MS / 86400000)} days.`);
  isVerifying = false;
}

// Called immediately by the real generate/preview routes the moment a
// genuine "voice not found" style failure happens — this is the actual
// fix for the reported problem: a voice doesn't have to wait for the
// slow, separate batch sweep to reach it before it's known broken. The
// very first real failure marks it immediately, and it's excluded from
// every /api/models response from that point on, in the same running
// server process.
function recordVoiceFailure(modelId, voiceId, errorMessage) {
  const voiceKey = `${modelId}::${voiceId}`;
  verifiedVoices.set(voiceKey, { working: false, checkedAt: new Date().toISOString(), error: (errorMessage || "").slice(0, 200) });
  persistCache();
  console.warn(`[Voice Catalog] "${voiceId}" on ${modelId} failed a REAL generation attempt — marked broken immediately, hidden from now on.`);
}

// Used by GET /api/models — returns only the voices actually confirmed
// working (or not yet checked, shown as-is rather than hidden, since an
// unchecked voice hasn't been proven broken either — only a confirmed
// failure removes it).
function getVerifiedVoiceModels() {
  return VOICE_MODELS.map((model) => {
    if (!model.confirmedVoiceIds?.length) return model;
    const filtered = model.confirmedVoiceIds.filter((voice) => {
      const result = verifiedVoices.get(`${model.id}::${voice.id}`);
      return !result || result.working !== false; // keep if unchecked or working; drop only on confirmed failure
    });
    return { ...model, confirmedVoiceIds: filtered };
  });
}

// Real, specific entries — not just a count — for surfacing in the
// Model Trust panel. This is the actual data this whole verification
// system produces; it was built this session but was never shown
// anywhere, which was the real gap being pointed out.
function getVoiceVerificationDetails() {
  return [...verifiedVoices.entries()].map(([key, result]) => {
    const [modelId, voiceId] = key.split("::");
    return { modelId, voiceId, working: result.working, checkedAt: result.checkedAt, error: result.error || null };
  });
}

function getVoiceCatalogStatus() {
  const entries = [...verifiedVoices.values()];
  return {
    lastCheckedAt,
    isVerifying,
    totalChecked: verifiedVoices.size,
    workingCount: entries.filter((e) => e.working).length,
    failedCount: entries.filter((e) => !e.working).length,
  };
}

// Resets the persisted cache entirely — needed after the concurrency/
// classification bug above could have already written incorrect "failed"
// entries for voices that were only ever rate-limited, not actually
// broken. Without this, those wrong results would otherwise sit in the
// cache for the full 14-day freshness window.
function clearCache() {
  verifiedVoices = new Map();
  lastCheckedAt = null;
  db.setSettingJson(CACHE_KEY, null);
  console.log(`[Voice Catalog] Cache cleared — next check will re-verify every voice from scratch.`);
}

module.exports = { loadPersistedCache, verifyAllVoices, getVerifiedVoiceModels, getVoiceCatalogStatus, getVoiceVerificationDetails, recordVoiceFailure, clearCache };