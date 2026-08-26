// ============================================================
// FAL CLIENT WRAPPER
// ------------------------------------------------------------
// Replaces the old Gemini-specific helpers (geminiImageRequest,
// geminiTextRequest, resilientImageGeneration, generateVeoClip, the
// circuit breaker, etc.) with Fal.ai equivalents that preserve the same
// external shape — same retry/backoff behavior, same circuit-breaker
// behavior, same db.recordTransaction()/progress.updateProgress() calls
// — so server.js's surrounding business logic (safety principles,
// product-lock prompts, batching, resumability) barely has to change.
//
// Key differences from the Gemini SDK that shaped this file:
//   - fal.subscribe() already polls its internal job queue to
//     completion, so we don't need our own poll loop the way Veo did
//     under Google (see pollVeoOperation in the old code) — one
//     .subscribe() call blocks until done, like generateContent did.
//   - Fal image/video inputs are `image_url` / `image_urls` (URL or a
//     base64 data URI — Fal accepts data URIs directly), not Gemini's
//     `inlineData` parts.
//   - fal-ai/any-llm's response text is on `result.data.output`, not
//     `response.text`.
//   - Image results: `result.data.images[0].url`.
//   - Video results: `result.data.video.url`.
// ============================================================
const { fal } = require("@fal-ai/client");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const progress = require("./progress");
const { estimateImageCost, estimateVideoCost } = require("./fal-models");
const { getRealBalance } = require("./fal-billing");

function configureFal(apiKey) {
  if (apiKey) fal.config({ credentials: apiKey });
}

// Real, shared concurrency limiter — confirmed directly against Fal's
// own FAQ: new accounts start at just 2 concurrent requests, growing to
// a self-service max of 40 as credits are purchased; requests beyond
// the limit queue on Fal's side rather than failing outright. The real
// risk this app had: several independently-built features each fire
// several parallel Fal calls (face detection up to 6 at once, a
// 3-worker frame pool, product/identity rendering 2-3 at once) with
// zero awareness of each other OR of the account's actual limit —
// nothing stopped the combined total from exceeding it. Gating here,
// before fal.subscribe is even called, means the app itself never sends
// more than MAX_CONCURRENT_FAL_CALLS requests at once, so Fal's own
// queue rarely even gets involved (assuming this ceiling is at or below
// the real account limit) — and this wraps OUTSIDE each call's existing
// timeout, not inside it, so the timeout clock only starts once a slot
// is actually acquired and the request truly begins, rather than
// counting time spent waiting in this app's own queue against it.
const MAX_CONCURRENT_FAL_CALLS = parseInt(process.env.FAL_MAX_CONCURRENCY, 10) || 3;
let activeFalCalls = 0;
const falCallWaitQueue = [];

// ============================================================
// SPEND GUARD (real balance, HARD BLOCK) — Fal has no API to pause
// spending after the fact, and letting a pay-as-you-go account go
// negative is worth avoiding rather than discovering after the fact, so
// the only real lever is refusing to place a call before it happens.
// Checked right here, in the single choke point every paid Fal call
// already passes through (withConcurrencyLimit) — applies everywhere in
// the app automatically, no need to touch the 59+ individual call sites.
//
// Real, deliberate scope limit: this uses process.env.FAL_ADMIN_KEY
// specifically, NOT whatever admin key a person may have typed into the
// Settings UI (that one only powers the Credits panel's manual
// balance/usage lookup, sent per-request from the browser — threading
// it down into this shared low-level module for every one of dozens of
// call sites would be a much bigger change for uncertain benefit on a
// single-tenant, self-hosted app like this one). For this guard to
// actually block anything, FAL_ADMIN_KEY needs to be set in the
// server's own .env — same key type, just configured server-side
// instead of typed into the browser each time.
//
// Balance is cached briefly rather than fetched on every single call —
// it doesn't change fast enough within a 60s window to justify hitting
// Fal's own billing API that often, and doing so on every one of
// potentially dozens of calls in a batch run would be wasteful.
// ============================================================
const REAL_BALANCE_CACHE_MS = 60 * 1000;
const REAL_BALANCE_SAFETY_MARGIN_USD = parseFloat(process.env.FAL_BALANCE_SAFETY_MARGIN) || 0.5;
let realBalanceCache = { value: null, checkedAt: 0 };
async function checkRealBalanceGuard() {
  const adminKey = process.env.FAL_ADMIN_KEY;
  if (!adminKey) return { blocked: false }; // can't check without one — see note above; not an error, just an unguarded state
  const now = Date.now();
  if (realBalanceCache.value == null || now - realBalanceCache.checkedAt > REAL_BALANCE_CACHE_MS) {
    try {
      const real = await getRealBalance(adminKey);
      if (real?.available && typeof real.balance === "number") {
        realBalanceCache = { value: real.balance, checkedAt: now };
      } else {
        return { blocked: false }; // key present but balance unavailable (wrong scope, Fal outage, etc.) — fail open rather than blocking everything on a lookup problem
      }
    } catch (err) {
      console.warn(`[Spend Guard] Couldn't check real Fal balance (${err.message}) — proceeding without this check this time.`);
      return { blocked: false };
    }
  }
  if (realBalanceCache.value <= REAL_BALANCE_SAFETY_MARGIN_USD) {
    return {
      blocked: true,
      reason: `Real Fal account balance is $${realBalanceCache.value.toFixed(2)}, at or below the $${REAL_BALANCE_SAFETY_MARGIN_USD.toFixed(2)} safety margin — refusing this call to avoid the account going negative. Add funds at https://fal.ai/dashboard/billing, then try again.`,
    };
  }
  return { blocked: false };
}
function withConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeFalCalls++;
      try {
        const guard = await checkRealBalanceGuard();
        if (guard.blocked) {
          const err = new Error(guard.reason);
          err.isSpendGuardBlock = true;
          err.status = 402;
          throw err;
        }
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        activeFalCalls--;
        const next = falCallWaitQueue.shift();
        if (next) next();
      }
    };
    if (activeFalCalls < MAX_CONCURRENT_FAL_CALLS) run();
    else falCallWaitQueue.push(run);
  });
}

// THE ACTUAL FIX for a real, serious gap: NONE of the fal.subscribe()
// calls in this file had any timeout — confirmed directly. If Fal's
// backend is slow or unresponsive for any reason, a single request could
// hang indefinitely with nothing watching the clock, and since the retry
// logic only triggers on an actual FAILURE, a hang that never fails means
// the retry logic never even gets a chance to run. This wraps any
// promise with a hard ceiling — after ms, it force-rejects with a
// timeout error (status 504, distinct from a genuine content/schema
// error) so the existing retry-with-backoff logic in each function below
// can actually do its job instead of waiting on a request that may never
// resolve at all.
function withTimeout(promise, ms, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(Object.assign(new Error(`${label} took longer than ${Math.round(ms / 1000)}s without responding — treating as a failure so it can retry instead of hanging indefinitely.`), { status: 504, isTimeout: true }));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
}

// ---- shared input/error helpers ----
function toFalImageUrl(base64OrDataUri, fallbackMime = "image/jpeg") {
  if (!base64OrDataUri) return null;
  if (base64OrDataUri.startsWith("data:")) return base64OrDataUri; // already a data URI — Fal accepts these directly
  if (/^https?:\/\//.test(base64OrDataUri)) return base64OrDataUri; // already a hosted URL
  return `data:${fallbackMime};base64,${base64OrDataUri}`;
}

function diagnoseFalError(err) {
  const status = err?.status || err?.response?.status || err?.httpStatus;
  const rawBody = err?.body ?? err?.response?.body ?? err?.message ?? "";
  const text = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  // A pure schema/format validation error (wrong duration value, wrong
  // aspect ratio, wrong field type) also returns HTTP 422 — the exact
  // same status a genuine content-safety block uses. Confirmed directly
  // in production: a duration-format mismatch was being treated as "the
  // model filtered this for content reasons" and triggering a paid
  // prompt-rewrite retry that could never fix it, since the problem was
  // never the prompt text — no amount of rewriting a sentence fixes a
  // wrong number in a different field. Detected via Fal's own error
  // shape ("literal_error"/"type_error" pointing at a non-content field
  // like duration/aspect_ratio/resolution, not at prompt or image_urls).
  const isSchemaValidationError =
    status === 422 &&
    /"type":\s*"(literal_error|type_error|value_error)"/i.test(text || "") &&
    /"loc":\s*\[\s*"body"\s*,\s*"(duration|aspect_ratio|resolution|fps|bitrate_mode)"/i.test(text || "") &&
    !/"loc":\s*\[\s*"body"\s*,\s*"(prompt|image_urls|image_url)"/i.test(text || "");
  const isSafetyBlock =
    !isSchemaValidationError &&
    (status === 422 ||
      /nsfw|safety|flagged|content[_ ]polic|moderation|blocked/i.test(text || ""));
  // Some providers (observed: Seedance's reference-to-video) reject a
  // request because of the REFERENCE IMAGES themselves — not the text
  // prompt — typically flagged as a real-person-likeness/privacy check on
  // multi-image identity-consistency endpoints. Rewriting and resubmitting
  // the prompt text does nothing to fix this: the same images go back in
  // and get blocked again identically, burning a second paid attempt for
  // nothing. Detected via the error mentioning image_urls specifically, or
  // fal's own "partner_validation_failed" / "likeness" wording.
  const isImageContentBlock =
    isSafetyBlock &&
    (/"loc":\s*\[\s*"body"\s*,\s*"image_urls"/i.test(text || "") ||
      /partner_validation_failed/i.test(text || "") ||
      /likeness/i.test(text || ""));
  // Extracts what field was wrong AND what Fal's own validator actually
  // expected, straight from its structured error body — this is the raw
  // material a self-correction can be learned from (see
  // parseSchemaCorrectionFromError in server.js), not a guess about what
  // the format should be.
  let schemaErrorField = null, schemaErrorExpected = null;
  if (isSchemaValidationError) {
    const locMatch = text.match(/"loc":\s*\[\s*"body"\s*,\s*"(duration|aspect_ratio|resolution|fps|bitrate_mode)"/i);
    schemaErrorField = locMatch?.[1] || null;
    // Pydantic's literal_error msg is typically "Input should be 'X'" or
    // "Input should be 'X', 'Y' or 'Z'" for an enum — pulls every quoted
    // value out of that, which works for both shapes.
    const msgMatch = text.match(/"msg":\s*"([^"]*)"/i);
    if (msgMatch) {
      const quoted = [...msgMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      schemaErrorExpected = quoted.length ? quoted : null;
    }
  }
  return { status, detail: text || `HTTP ${status || "unknown"}`, isSafetyBlock, isImageContentBlock, isSchemaValidationError, schemaErrorField, schemaErrorExpected };
}

// ============================================================
// CIRCUIT BREAKER — same behavior as the old code: after N consecutive
// failures for a given model this session, later calls make one fast
// probe instead of burning a full retry/backoff loop on it.
// ============================================================
const CIRCUIT_BREAKER_THRESHOLD = 3;
const modelFailureStreaks = new Map();
function isCircuitOpen(model) {
  return (modelFailureStreaks.get(model) || 0) >= CIRCUIT_BREAKER_THRESHOLD;
}
function recordModelFailure(model) {
  const next = (modelFailureStreaks.get(model) || 0) + 1;
  modelFailureStreaks.set(model, next);
  if (next === CIRCUIT_BREAKER_THRESHOLD) {
    console.warn(`[Circuit Breaker] ${model} has failed ${next} times in a row this session — future calls will probe it once instead of the full retry loop, until it succeeds again.`);
  }
}
function recordModelSuccess(model) {
  if (modelFailureStreaks.get(model)) modelFailureStreaks.set(model, 0);
}

// ============================================================
// IMAGE GENERATION
// ============================================================
function extractImageUrl(result) {
  const images = result?.data?.images || result?.images;
  if (Array.isArray(images) && images[0]?.url) return images[0].url;
  const single = result?.data?.image || result?.image;
  if (single?.url) return single.url;
  return null;
}

async function falImageRequest(modelId, input, { apiKey, retries = 2, costMeta = null } = {}) {
  configureFal(apiKey);
  const frameLabel = costMeta?.frameIndex != null ? ` (frame ${costMeta.frameIndex + 1})` : "";
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      if (i === 1) progress.updateProgress(costMeta?.runId, "generating-image", `Rendering with ${modelId}${frameLabel}...`);
      const result = await withConcurrencyLimit(() => withTimeout(fal.subscribe(modelId, { input, logs: false }), 90000, `Image generation (${modelId})`));
      const url = extractImageUrl(result);
      if (!url) {
        throw new Error(`Fal returned no image data from ${modelId}. Raw response: ${JSON.stringify(result?.data || result).slice(0, 400)}`);
      }
      if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "success", cost: estimateImageCost(modelId) });
      recordModelSuccess(modelId);
      return url;
    } catch (err) {
      lastErr = err;
      const diag = diagnoseFalError(err);
      if (diag.isSafetyBlock) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "blocked", note: diag.detail, cost: 0 });
        // Same reactive pattern-tracking as video: if this is specifically
        // an image-content/likeness block (not a general prompt-content
        // issue), record which model hit it — this is what lets the
        // model-fitness filtering in the frontend generalize across ANY
        // model that's actually been observed failing this way, not just
        // the ones documented ahead of time from known evidence.
        if (diag.isImageContentBlock) db.recordImageContentBlockModel(modelId);
        console.error(`[Fal Image] Request BLOCKED (not retrying): ${diag.detail}`);
        throw Object.assign(new Error(`Fal blocked this request (${modelId}): ${diag.detail}`), { isSafetyBlock: true, isImageContentBlock: diag.isImageContentBlock });
      }
      if ([400, 401, 403, 429].includes(diag.status)) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "error", note: diag.detail, cost: 0 });
        throw err;
      }
      if (i === retries) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "error", note: diag.detail, cost: 0 });
        recordModelFailure(modelId);
        throw err;
      }
      recordModelFailure(modelId);
      const waitMs = Math.min(2000 * Math.pow(2, i - 1), 20000) + Math.floor(Math.random() * 500);
      console.warn(`[Fal Image] Retry ${i}/${retries} after ${diag.status || err.message}. Waiting ${waitMs}ms...`);
      progress.updateProgress(costMeta?.runId, "retrying", `${modelId}${frameLabel} is under heavy demand — retry ${i}/${retries}, waiting ${Math.round(waitMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

// Voice/TTS generation — deliberately its own function, not a variant of
// falImageRequest, since the response shape is genuinely different
// (audio.url + duration_ms, not images[]) and cost is per-character, not
// per-image. Reuses the exact same retry/timeout/error-diagnosis pattern
// that's already proven reliable for image generation, rather than
// inventing a new one.
async function falVoiceRequest(modelId, input, { apiKey, retries = 2, costMeta = null, costPer1kChars = 0.1, textLength = 0, flatCost = null, progressLabel = null } = {}) {
  configureFal(apiKey);
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      if (i === 1) progress.updateProgress(costMeta?.runId, "generating-voice", progressLabel || `Generating speech with ${modelId}...`);
      // 60s was too tight — confirmed by a real production failure where
      // translation alone took 36s under normal Fal load, then voice
      // generation itself hit this timeout and failed twice in a row.
      // Same lesson as the earlier text-generation timeout fix: give
      // real margin above what's actually been observed, not a round
      // number picked without evidence.
      const result = await withConcurrencyLimit(() => withTimeout(fal.subscribe(modelId, { input, logs: false }), 240000, `Voice generation (${modelId})`));
      const audioUrl = result?.data?.audio?.url || result?.audio?.url;
      if (!audioUrl) {
        throw new Error(`Fal returned no audio data from ${modelId}. Raw response: ${JSON.stringify(result?.data || result).slice(0, 400)}`);
      }
      const cost = flatCost !== null ? flatCost : Number(((textLength / 1000) * costPer1kChars).toFixed(6));
      if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "success", cost });
      return {
        url: audioUrl,
        durationMs: result?.data?.duration_ms || result?.duration_ms || null,
        // Only present on the voice-clone endpoint's response — harmless
        // undefined for every regular TTS call.
        customVoiceId: result?.data?.custom_voice_id || result?.custom_voice_id || null,
      };
    } catch (err) {
      lastErr = err;
      const diag = diagnoseFalError(err);
      if (diag.isSafetyBlock) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "blocked", note: diag.detail, cost: 0 });
        throw Object.assign(new Error(`Fal blocked this request (${modelId}): ${diag.detail}`), { isSafetyBlock: true });
      }
      if ([400, 401, 403, 429].includes(diag.status)) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "error", note: diag.detail, cost: 0 });
        throw err;
      }
      if (i === retries) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "error", note: diag.detail, cost: 0 });
        throw err;
      }
      const waitMs = Math.min(2000 * Math.pow(2, i - 1), 20000) + Math.floor(Math.random() * 500);
      console.warn(`[Fal Voice] Retry ${i}/${retries} after ${diag.status || err.message}. Waiting ${waitMs}ms...`);
      progress.updateProgress(costMeta?.runId, "retrying", `${modelId} is under heavy demand — retry ${i}/${retries}, waiting ${Math.round(waitMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

// Mirrors the old resilientImageGeneration: try the preferred model, and
// on non-safety failure, fall back once to the alternate model.
async function resilientFalImageGeneration(inputBuilder, { preferredModel, alternateModel, apiKey, costMeta, retries = 2 }) {
  const circuitOpen = isCircuitOpen(preferredModel);
  const effectiveRetries = circuitOpen ? 1 : retries;
  const startedAt = Date.now();
  const label = `${costMeta?.endpoint || "image"}${costMeta?.frameIndex != null ? ` frame ${costMeta.frameIndex + 1}` : ""}`;
  if (circuitOpen) {
    console.warn(`[Circuit Breaker] ${label}: ${preferredModel} has been failing repeatedly this session — probing once instead of the full retry loop.`);
  }
  try {
    const url = await falImageRequest(preferredModel, inputBuilder(preferredModel), { apiKey, retries: effectiveRetries, costMeta: { ...costMeta, model: preferredModel } });
    console.log(`[Timing] ${label} (${preferredModel}) took ${Date.now() - startedAt}ms.`);
    return { image: url, modelUsed: preferredModel, usedFallback: false };
  } catch (err) {
    if (err.isSafetyBlock || !alternateModel || alternateModel === preferredModel) {
      console.log(`[Timing] ${label} (${preferredModel}) FAILED after ${Date.now() - startedAt}ms.`);
      throw err;
    }
    console.warn(`[Model Fallback] ${preferredModel} failed after ${effectiveRetries} attempt(s) (${err.message}) — retrying once via ${alternateModel}.`);
    progress.updateProgress(costMeta?.runId, "model-fallback", `${preferredModel} unavailable — switching to ${alternateModel}...`);
    try {
      const url = await falImageRequest(alternateModel, inputBuilder(alternateModel), {
        apiKey,
        retries: 3,
        costMeta: { ...costMeta, model: alternateModel, note: `fallback from ${preferredModel}: ${err.message}` },
      });
      console.log(`[Timing] ${label} (${preferredModel}\u2192${alternateModel} fallback) took ${Date.now() - startedAt}ms total.`);
      return { image: url, modelUsed: alternateModel, usedFallback: true, fallbackReason: `${preferredModel} was unavailable (${err.message}), used ${alternateModel} instead.` };
    } catch (fallbackErr) {
      console.log(`[Timing] ${label} (${preferredModel}\u2192${alternateModel} fallback) FAILED after ${Date.now() - startedAt}ms total.`);
      throw fallbackErr;
    }
  }
}

// ============================================================
// TEXT / JSON REASONING (fal-ai/any-llm) — replaces Gemini's
// generateContent text calls (creative director, moderation, video
// brief, prompt rewriting). Response text lives at result.data.output.
// any-llm doesn't have Gemini's responseMimeType:"application/json"
// config, so callers keep doing what they already did: instruct the
// model to return strict JSON, then strip ```json fences before parsing.
// ============================================================
// Flat per-call pricing was a poor approximation: a generate-text call
// (SAFETY_PRINCIPLES + full brief + JSON schema, often 2000+ characters)
// costs meaningfully more in real tokens than a short moderate-inputs
// check — confirmed against a real Fal invoice where our flat-rate ledger
// under-counted any-llm spend by a wide margin. This scales with actual
// prompt/output length instead, using a blended rate approximating
// Claude Sonnet / GPT-4o class pricing via OpenRouter (~$3/M input
// tokens, ~$15/M output tokens; ~4 characters per token is the standard
// rough heuristic for English text). Still an estimate, not exact —
// Fal's own dashboard remains the source of truth for real billing.
function estimateAnyLlmCost(promptText, hasImage) {
  const inputTokens = Math.ceil((promptText || "").length / 4);
  const outputTokens = Math.ceil(inputTokens * 0.3); // our JSON-generation outputs typically run 20-40% of input length
  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  const imageSurcharge = hasImage ? 0.01 : 0; // vision tokens are pricier; flat surcharge as a rough approximation
  return Number((Math.max(cost, 0.002) + imageSurcharge).toFixed(6));
}

async function falTextRequest(prompt, { model, apiKey, retries = 5, costMeta = null, temperature = 0.7, imageDataUri = null, imageDataUris = null } = {}) {
  configureFal(apiKey);
  const label = costMeta?.endpoint || "text";
  const startedAt = Date.now();
  const images = imageDataUris && imageDataUris.length ? imageDataUris : imageDataUri ? [imageDataUri] : null;
  const endpoint = images ? "fal-ai/any-llm/vision" : "fal-ai/any-llm";
  const input = images
    ? { model, prompt, temperature, image_urls: images.map((u) => toFalImageUrl(u)) }
    : { model, prompt, temperature };
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const result = await withConcurrencyLimit(() => withTimeout(fal.subscribe(endpoint, {
        input,
        logs: false,
      }), 100000, `Text generation (${label})`));
      const text = result?.data?.output;
      if (!text) throw new Error("Fal any-llm returned an empty text response.");
      if (costMeta) db.recordTransaction({ ...costMeta, model: `any-llm:${model}`, status: "success", cost: estimateAnyLlmCost(prompt, !!images) });
      console.log(`[Timing] ${label} took ${Date.now() - startedAt}ms.`);
      return { text };
    } catch (err) {
      lastErr = err;
      const diag = diagnoseFalError(err);
      // 429 (rate limited) is TEMPORARY, not the same as a genuine 400/401/403
      // failure — grouping it with permanent errors meant a rate-limit hit
      // gave up immediately instead of retrying with backoff, exactly like
      // the earlier fix for the Models Catalog API. Confirmed this was
      // hiding real failures: the log only ever said "FAILED after Xms"
      // with no reason, making this impossible to diagnose from the log
      // alone — now it prints the actual status/detail too.
      if ([400, 401, 403].includes(diag.status)) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: `any-llm:${model}`, status: "error", note: diag.detail, cost: 0 });
        console.log(`[Timing] ${label} FAILED after ${Date.now() - startedAt}ms — ${diag.status}: ${(diag.detail || "").slice(0, 200)}`);
        throw err;
      }
      if (i === retries) {
        if (costMeta) db.recordTransaction({ ...costMeta, model: `any-llm:${model}`, status: "error", note: diag.detail, cost: 0 });
        console.log(`[Timing] ${label} FAILED after ${Date.now() - startedAt}ms — ${diag.status || "no status"}: ${(diag.detail || err.message || "").slice(0, 200)}`);
        throw err;
      }
      const waitMs = Math.min(2000 * Math.pow(2, i - 1), 20000) + Math.floor(Math.random() * 500);
      console.warn(`[Fal Text] Retry ${i}/${retries} after ${diag.status || err.message}. Waiting ${waitMs}ms...`);
      progress.updateProgress(costMeta?.runId, "retrying", `Text model under heavy demand — retry ${i}/${retries}, waiting ${Math.round(waitMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

// Vision analysis (fal-ai/any-llm/vision) — replaces Gemini vision calls
// (analyze-reference: counting people, minimal-clothing detection).
async function falVisionRequest(prompt, imageDataUri, { model, apiKey, costMeta = null } = {}) {
  configureFal(apiKey);
  const result = await withConcurrencyLimit(() => withTimeout(fal.subscribe("fal-ai/any-llm/vision", {
    input: { model, prompt, image_url: imageDataUri },
    logs: false,
  }), 45000, "Vision analysis"));
  const text = result?.data?.output;
  if (!text) throw new Error("Fal any-llm/vision returned an empty response.");
  if (costMeta) db.recordTransaction({ ...costMeta, model: `any-llm-vision:${model}`, status: "success", cost: estimateAnyLlmCost(prompt, true) });
  return { text };
}

// ============================================================
// VIDEO GENERATION (Veo 3.1 / Kling / etc. via Fal)
// ------------------------------------------------------------
// fal.subscribe() already blocks until the render job completes, so
// there's no separate poll loop needed here (unlike the old
// pollVeoOperation, which existed because the Google SDK's
// generateVideos/operations API is fire-and-poll). We still download
// the result to local disk exactly as before, since Fal's hosted URLs
// are only guaranteed available for a handful of days and this app's
// video library expects a permanent local /generated-videos/ URL.
// ============================================================
const VIDEO_OUTPUT_DIR = path.join(__dirname, "public", "generated-videos");
function ensureVideoDir() {
  if (!fs.existsSync(VIDEO_OUTPUT_DIR)) fs.mkdirSync(VIDEO_OUTPUT_DIR, { recursive: true });
}
async function downloadFalVideo(url, destFilename) {
  ensureVideoDir();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download the generated video (HTTP ${resp.status}).`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(path.join(VIDEO_OUTPUT_DIR, destFilename), buffer);
  return `/generated-videos/${destFilename}`;
}

// Same real reasoning as video, confirmed as an actual gap: falImageRequest
// returns Fal's own CDN URL directly, and until now nothing ever downloaded
// it — that URL (and only that URL) is what got shown in the gallery AND
// saved into run_items/campaigns for later reload. Fal's own URLs are only
// guaranteed available for a handful of days, so every generated product
// photo was silently going dead after that — not just in the current
// session, but permanently in saved campaign history too, with no way to
// recover it. Mirrors downloadFalVideo exactly, serving from its own
// subfolder so it's clearly distinct from user-uploaded product images.
const IMAGE_OUTPUT_DIR = path.join(__dirname, "public", "generated-images");
function ensureImageDir() {
  if (!fs.existsSync(IMAGE_OUTPUT_DIR)) fs.mkdirSync(IMAGE_OUTPUT_DIR, { recursive: true });
}
async function downloadFalImage(url, destFilename) {
  ensureImageDir();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download the generated image (HTTP ${resp.status}).`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(path.join(IMAGE_OUTPUT_DIR, destFilename), buffer);
  return `/generated-images/${destFilename}`;
}
// Best-effort wrapper for call sites that display/persist a result but
// shouldn't fail the whole request if the download hiccups — falls back
// to Fal's own (eventually-expiring) URL rather than losing the image
// outright, and logs loudly so a real, systemic failure doesn't go quiet.
async function persistFalImage(url, destFilename) {
  try {
    return await downloadFalImage(url, destFilename);
  } catch (err) {
    console.warn(`[Image Persistence] Failed to download for permanent storage (${err.message}) — falling back to Fal's own URL, which will expire in a few days.`);
    return url;
  }
}

// Downloads a remote image (e.g. Fal's own CDN URL) and returns it as a
// base64 data URI. Needed specifically because the BROWSER can't
// reliably do this itself — a cross-origin fetch() to read another
// site's raw image bytes requires that site to explicitly allow it via
// CORS headers, which Fal's media CDN doesn't guarantee. The browser CAN
// display the image fine (an <img> tag doesn't need CORS permission),
// but JS reading the bytes to build a File/Blob does — which is exactly
// what silently broke the wizard's hand-off into Single Mode. Server-side
// fetch has no such restriction at all, so downloading it here and
// handing the frontend real embedded data sidesteps the problem entirely
// instead of fighting the browser's security model.
async function downloadImageAsDataUri(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download the generated image (HTTP ${resp.status}).`);
  const contentType = resp.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await resp.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function extractVideoUrl(result) {
  return result?.data?.video?.url || result?.video?.url || null;
}

async function falVideoRequest(
  modelId,
  input,
  { apiKey, runId, costMeta, destFilename, detailPrefix, durationSeconds = 8 } = {},
) {
  configureFal(apiKey);
  progress.updateProgress(runId, "rendering-video", `${detailPrefix || "Starting video render"}...`);
  let result;
  // Real fix for a real, reported bug: this previously ignored
  // durationSeconds entirely and used a flat 180s cap regardless of
  // input — which meant a talking-avatar video lip-syncing genuinely
  // long audio (91+ seconds, confirmed from the actual error) would
  // still be legitimately processing when this app gave up and called
  // it a failure. Scales with real duration now: a base allowance for
  // model startup/overhead, plus real per-second processing time,
  // capped at a sane ceiling so a broken request doesn't hang forever.
  const scaledTimeoutMs = Math.min(600000, Math.max(180000, 60000 + durationSeconds * 4000));
  try {
    result = await withConcurrencyLimit(() => withTimeout(fal.subscribe(modelId, {
      input,
      logs: false,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          progress.updateProgress(runId, "rendering-video", `${detailPrefix || "Rendering video"} — still working...`);
        }
      },
    }), scaledTimeoutMs, `Video generation (${modelId})`));
  } catch (err) {
    const diag = diagnoseFalError(err);
    if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: diag.isSafetyBlock ? "blocked" : "error", note: diag.detail, cost: 0 });
    throw Object.assign(new Error(`Video generation failed (${modelId}): ${diag.detail}`), { isSafetyBlock: diag.isSafetyBlock, isImageContentBlock: diag.isImageContentBlock, isSchemaValidationError: diag.isSchemaValidationError, schemaErrorField: diag.schemaErrorField, schemaErrorExpected: diag.schemaErrorExpected, filterReasons: diag.isSafetyBlock ? [diag.detail] : [] });
  }
  const videoUrl = extractVideoUrl(result);
  if (!videoUrl) {
    const note = "No video returned — this can happen if the prompt was filtered; try adjusting the creative direction.";
    if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "blocked", note, cost: 0 });
    throw Object.assign(new Error(`Fal returned no video (${modelId}) — ${note}`), { isSafetyBlock: true, filterReasons: [note] });
  }
  const servedUrl = await downloadFalVideo(videoUrl, destFilename);
  if (costMeta) db.recordTransaction({ ...costMeta, model: modelId, status: "success", cost: estimateVideoCost(modelId, durationSeconds) });
  return { url: servedUrl, modelUsed: modelId };
}

// Generic helper for Fal's ffmpeg-api merge endpoints (merge-videos,
// merge-audios, merge-audio-video) — same timeout/error-handling
// discipline as every other real Fal call in this file, rather than a
// bare fal.subscribe() with no timeout (the exact gap already fixed
// once this session for video generation).
async function falMergeRequest(endpointId, input, { apiKey, costMeta } = {}) {
  configureFal(apiKey);
  let result;
  try {
    result = await withConcurrencyLimit(() => withTimeout(fal.subscribe(endpointId, { input, logs: false }), 120000, `Media merge (${endpointId})`));
  } catch (err) {
    const diag = diagnoseFalError(err);
    if (costMeta) db.recordTransaction({ ...costMeta, model: endpointId, status: "error", note: diag.detail, cost: 0 });
    throw new Error(`Merge failed (${endpointId}): ${diag.detail}`);
  }
  const file = result?.data?.video || result?.data?.audio;
  if (!file?.url) throw new Error(`${endpointId} returned no usable file.`);
  // Confirmed real price for these ffmpeg-api endpoints: $0.00017 per
  // compute second — genuinely negligible, but recorded honestly rather
  // than treated as free.
  if (costMeta) db.recordTransaction({ ...costMeta, model: endpointId, status: "success", cost: 0.01 });
  return { url: file.url, sizeBytes: file.file_size || null };
}

module.exports = {
  configureFal,
  toFalImageUrl,
  falImageRequest,
  resilientFalImageGeneration,
  falTextRequest,
  falVisionRequest,
  falVideoRequest,
  falVoiceRequest,
  falMergeRequest,
  withConcurrencyLimit,
  isCircuitOpen,
  downloadImageAsDataUri,
  persistFalImage,
};