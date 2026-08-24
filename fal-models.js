// ============================================================
// FAL MODEL REGISTRY
// ------------------------------------------------------------
// Central list of curated Fal.ai models offered in the UI dropdowns,
// plus cost estimates for the credits ledger. The server does NOT
// validate incoming model IDs against this list — a user can always
// type a custom Fal endpoint ID in the frontend's "Custom model" field
// and it will be sent through as-is. This registry exists purely to:
//   1. populate the dropdowns via GET /api/models
//   2. give a sane default per role (pro/fast image, video)
//   3. give a cost-estimate lookup for the credits ledger
//
// IMPORTANT: verify these endpoint IDs and prices against
// https://fal.ai/models before relying on them in production — Fal
// renames/adds/deprecates model endpoints frequently, and the two
// entries marked "verify slug" below are best-effort based on naming
// conventions, not a confirmed live lookup.
// ============================================================

const IMAGE_MODELS = [
  {
    // Confirmed via fal.ai/models/fal-ai/nano-banana/api — a genuinely
    // SEPARATE endpoint from nano-banana-pro/edit and nano-banana-2/edit
    // below, not a variant of them. Those are edit-only and REQUIRE at
    // least one reference image (confirmed directly by a real production
    // failure: "image_urls Field required" when called with none) — this
    // one is the dedicated pure text-to-image endpoint, built to work
    // with zero reference images, for genuinely inventing something new
    // rather than editing something that already exists.
    id: "fal-ai/nano-banana",
    label: "Nano Banana — pure text-to-image, no reference needed",
    tier: "fast",
    costPerImage: 0.039, // confirmed directly from Fal's own pricing
    textToImageOnly: true,
  },
  {
    id: "fal-ai/nano-banana-pro/edit",
    label: "Nano Banana Pro (Gemini 3 Pro Image) — highest fidelity, up to 14 reference images",
    tier: "pro",
    maxReferenceImages: 14,
    costPerImage: 0.15,
    supportsResolutionParam: true, // confirmed: accepts resolution: "1K"/"2K"/"4K"
  },
  {
    // Confirmed via fal.ai/models/fal-ai/nano-banana-2/edit — the genuine
    // lite/fast sibling to Nano Banana Pro, same Google Gemini 3.1 Flash
    // Image family. Deliberately preferred as the default "lite" pairing
    // over a different vendor (like FLUX or GPT Image) because staying
    // within the same model family keeps results visually consistent
    // when the system automatically switches tiers mid-shoot — a
    // different vendor's rendering style can look like a jump cut
    // between frames even when everything else is locked.
    id: "fal-ai/nano-banana-2/edit",
    label: "Nano Banana 2 (Gemini 3.1 Flash Image) — fast/cheap, same family as Pro, up to 14 images",
    tier: "lite",
    maxReferenceImages: 14,
    costPerImage: 0.045, // placeholder — verify current price on your dashboard
    supportsResolutionParam: true, // same Google schema family as Pro — confirmed to support 1K/2K/4K
  },
  {
    id: "fal-ai/flux-2-pro/edit",
    label: "FLUX.2 [pro] Edit — fast, zero-config multi-reference (up to 9 images)",
    tier: "fast",
    maxReferenceImages: 9,
    costPerMegapixel: 0.03,
  },
  {
    id: "openai/gpt-image-2/edit",
    label: "GPT Image 2 Edit (OpenAI) — multi-reference edit",
    tier: "fast",
    maxReferenceImages: 8,
    costPerImage: 0.07, // placeholder — verify current price
  },
  {
    // Confirmed via fal.ai/models/fal-ai/bytedance/seedream/v4/edit
    // (previously flagged "verify slug" — now directly confirmed to exist).
    id: "fal-ai/bytedance/seedream/v4/edit",
    label: "Seedream 4.0 Edit (ByteDance) — up to 10 reference images, high resolution",
    tier: "fast",
    maxReferenceImages: 10,
    costPerImage: 0.05, // placeholder — verify current price
  },
  {
    // Confirmed via fal.ai/models/fal-ai/bytedance/seedream/v5/lite/edit —
    // ByteDance's newer, faster Lite tier (Feb 2026), notable for strong
    // face/identity preservation across edits, up to 10 reference images.
    id: "fal-ai/bytedance/seedream/v5/lite/edit",
    label: "Seedream 5.0 Lite Edit (ByteDance) — fast, strong face preservation, up to 10 images",
    tier: "lite",
    maxReferenceImages: 10,
    costPerImage: 0.04, // placeholder — verify current price
  },
  {
    // Confirmed via fal.ai/models/fal-ai/flux-2/klein/4b/distilled/edit/
    // playground — the real image-to-image edit endpoint (not the
    // LoRA-training variant, which is a different product for a
    // different job). Genuinely the cheapest option in this registry —
    // roughly 7-10x cheaper than everything else here. Exact confirmed
    // pricing: $0.014 for the first output megapixel, $0.001 per
    // additional megapixel; input images aren't billed on this endpoint.
    id: "fal-ai/flux-2/klein/4b/distilled/edit",
    label: "FLUX.2 [klein] 4B Edit — cheapest option here by far, good for drafts/bulk work",
    tier: "lite",
    maxReferenceImages: 1, // confirmed examples only show a single input image — verify if you need true multi-reference
    costPerImage: 0.014,
  },
  {
    // Confirmed via fal.ai/models/fal-ai/flux-2/klein/9b/edit — the base
    // (non-LoRA) 9B edit endpoint. Larger/stronger than the 4B version
    // above while still far cheaper than the rest of this registry.
    // Confirmed pricing: $0.011 per megapixel of INPUT and OUTPUT
    // combined (so a typical 1MP-in/1MP-out edit runs about $0.022).
    id: "fal-ai/flux-2/klein/9b/edit",
    label: "FLUX.2 [klein] 9B Edit — cheap, stronger than the 4B version",
    tier: "lite",
    maxReferenceImages: 1, // same caveat as the 4B version — verify for multi-reference use
    costPerImage: 0.022,
  },
];

const VIDEO_MODELS = [
  {
    id: "fal-ai/veo3.1/image-to-video",
    label: "Veo 3.1 — standard quality, native audio",
    tier: "quality",
    costPerSecond: 0.4,
    duration: { type: "enum", options: [4, 6, 8] }, // confirmed: Veo rejects anything else with a 422
    // Confirmed via fal.ai/models/fal-ai/veo3.1/reference-to-video: a
    // SEPARATE endpoint (not an extra field on image-to-video) accepting
    // up to 3 reference images via image_urls.
    combine: { endpoint: "fal-ai/veo3.1/reference-to-video", imageField: "image_urls", maxImages: 3 },
  },
  {
    id: "fal-ai/veo3.1/fast/image-to-video",
    label: "Veo 3.1 Fast — balanced speed/cost (default)",
    tier: "fast",
    costPerSecond: 0.1,
    duration: { type: "enum", options: [4, 6, 8] },
    // Only the standard-tier reference-to-video endpoint is confirmed to
    // exist — Fast/Lite don't have a confirmed sibling, so combining from
    // these tiers routes through the standard endpoint above (costs the
    // standard per-second rate for that one call).
    combine: { endpoint: "fal-ai/veo3.1/reference-to-video", imageField: "image_urls", maxImages: 3 },
  },
  {
    id: "fal-ai/veo3.1/lite/image-to-video",
    label: "Veo 3.1 Lite — cheapest, fastest",
    tier: "lite",
    costPerSecond: 0.05,
    duration: { type: "enum", options: [4, 6, 8] },
    combine: { endpoint: "fal-ai/veo3.1/reference-to-video", imageField: "image_urls", maxImages: 3 },
  },
  {
    // Corrected from an earlier unverified guess (fal-ai/kling-video/v3-pro/...,
    // which doesn't exist) — this slug and pricing are confirmed against
    // fal.ai's own docs. No confirmed multi-image "combine" endpoint exists
    // for Kling (its multi-reference feature is "Kling Elements", a
    // different mechanism requiring a separate element-creation step, not
    // a simple image_urls array) — so no `combine` field here, correctly
    // excluding it from the combine-capable model list.
    id: "fal-ai/kling-video/v3/pro/image-to-video",
    label: "Kling 3.0 Pro — real 3-15s range, strong motion coherence",
    tier: "alt",
    costPerSecond: 0.112, // audio off; 0.168/sec with audio on
    duration: { type: "range", min: 3, max: 15 }, // confirmed: genuine per-second range, not an enum
    // Confirmed via fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api
    // — a real, separate end_image_url field ("URL of the image to be
    // used for the end of the video"). Distinct from `combine` above:
    // this isn't blending multiple references into one scene, it's
    // literally animating FROM the start image TO this end image — a
    // better fit than reference-combine for "two different products,
    // one clip" than trying to force a blend.
    supportsEndFrame: true,
  },
  {
    // Confirmed via fal.ai/models/bytedance/seedance-2.0/reference-to-video
    // and the official fal-ai/seedance-2.0-api GitHub repo: genuinely
    // supports up to 9 reference images (more than Veo's 3) via image_urls,
    // plus native audio and @Image1-style prompt tagging.
    //
    // knownLikenessSensitive: true — NOT a guess or a theory. This
    // endpoint's reference/combine mode has hit a real
    // content_policy_violation ("likenesses of real people") on human-
    // inclusive multi-image requests repeatedly across real production
    // use — not a one-off. Documented here as an established fact about
    // this specific endpoint so a fresh deployment excludes it for
    // human+combine from the start, instead of every new session having
    // to independently rediscover the same failure before being
    // protected from it.
    id: "bytedance/seedance-2.0/image-to-video",
    label: "Seedance 2.0 (ByteDance) — up to 9 images combine, native audio",
    tier: "alt",
    costPerSecond: 0.2, // placeholder — not directly confirmed, verify on your Fal dashboard
    duration: { type: "range", min: 5, max: 15 }, // best-effort from observed examples ("10","15","auto") — verify
    combine: { endpoint: "bytedance/seedance-2.0/reference-to-video", imageField: "image_urls", maxImages: 9 },
    knownLikenessSensitive: true,
  },
  {
    // Same documented pattern as the base tier above — this is the
    // "fast" variant of the same underlying model/classifier, so the
    // same known sensitivity applies.
    id: "bytedance/seedance-2.0/fast/image-to-video",
    label: "Seedance 2.0 Fast — cheaper/faster, up to 9 images combine",
    tier: "fast",
    costPerSecond: 0.1, // placeholder — verify
    duration: { type: "range", min: 5, max: 15 },
    combine: { endpoint: "bytedance/seedance-2.0/fast/reference-to-video", imageField: "image_urls", maxImages: 9 },
    knownLikenessSensitive: true,
  },
  {
    // Confirmed endpoint + "up to 7 images" from fal.ai/models/fal-ai/vidu/
    // q1/reference-to-video/api. The exact input field name for this
    // specific endpoint wasn't directly confirmed (Vidu's Q3 Mix variant
    // uses reference_image_urls; assumed consistent here) — verify before
    // relying on it heavily.
    id: "fal-ai/vidu/q1/image-to-video", // verify base I2V slug
    label: "Vidu Q1 — up to 7 images combine (verify before heavy use)",
    tier: "alt",
    costPerSecond: 0.15, // placeholder — verify
    duration: { type: "range", min: 4, max: 8 }, // placeholder — verify
    combine: { endpoint: "fal-ai/vidu/q1/reference-to-video", imageField: "reference_image_urls", maxImages: 7 },
  },
  {
    // Confirmed via fal.ai/models/alibaba/happy-horse/reference-to-video —
    // launched April 27, 2026, currently #1 ranked on the Artificial
    // Analysis Video Arena benchmark (Text-to-Video AND Image-to-Video),
    // per fal's own official launch announcement. Genuinely worth trying,
    // not just another catalog entry. Real vendor prefix is "alibaba/",
    // NOT "fal-ai/" — a user-supplied model list had this wrong.
    // Prompt convention: reference each image as character1, character2,
    // etc. (NOT @Image1 like Seedance/Kling) — 1080p native audio output.
    id: "alibaba/happy-horse/image-to-video", // single-image base endpoint — verify exact slug before heavy use
    label: "Happy Horse 1.0 (Alibaba) — currently #1 ranked, up to 9 images combine",
    tier: "alt",
    costPerSecond: 0.15, // placeholder — verify current price
    duration: { type: "range", min: 3, max: 15 },
    combine: { endpoint: "alibaba/happy-horse/reference-to-video", imageField: "image_urls", maxImages: 9, promptTagFormat: "character" },
  },
  {
    // Confirmed via fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video
    // and /image-to-video — newer than v3 Pro, combines via @Element1/
    // @Image1 prompt tagging. Pricing directly confirmed from Fal's own
    // page: $0.112/sec with audio off, $0.14/sec with audio on. A
    // separately-pasted "options" list claimed a structured `elements`
    // array with frontal_image_url/reference_image_urls sub-fields —
    // that specific structure never appeared in any real usage example
    // checked, so it's not wired. UPDATE: camera_control genuinely IS a
    // real field on Kling (confirmed via v3 Standard's schema, type
    // "Enum") — just without confirmed valid values yet, so still not
    // wired as a UI control until those are verified (a dropdown with
    // guessed options would be worse than no dropdown).
    id: "fal-ai/kling-video/o3/pro/image-to-video",
    label: "Kling O3 Pro — newer than v3, reference-based multi-element combine",
    tier: "alt",
    costPerSecond: 0.112, // confirmed (audio off) — was a $0.15 placeholder
    duration: { type: "range", min: 3, max: 15 },
    combine: { endpoint: "fal-ai/kling-video/o3/pro/reference-to-video", imageField: "image_urls", maxImages: 7, promptTagFormat: "element" },
    supportsEndFrame: true, // confirmed: "URL of the end frame image (optional)" on this endpoint's real schema
  },
  {
    // Confirmed via fal.ai/models/fal-ai/sora-2/image-to-video/pro — a
    // pasted "verified" list claimed this endpoint was
    // "openai/sora-2-pro/image-to-video"; the real one is completely
    // different (fal-ai/ prefix, /pro as a suffix, not embedded).
    // Single-image only (no confirmed multi-image combine support) —
    // genuinely expensive relative to everything else here, so kept off
    // the lite-first default path entirely; a deliberate pick only.
    id: "fal-ai/sora-2/image-to-video/pro",
    label: "Sora 2 Pro (OpenAI) — expensive, single-image only, real audio",
    tier: "quality",
    costPerSecond: 0.5, // confirmed: $0.30/s at 720p, $0.50/s at 1080p — using the higher figure to avoid under-quoting
    duration: { type: "enum", options: [4, 8, 12] }, // per Fal's own workflow docs — verify before relying heavily
  },
  // ------------------------------------------------------------
  // NOT user-selectable (hidden: true) — these are the endpoints
  // resolveVideoEndpointForRefs() in server.js automatically switches to
  // when combining 2+ reference images (see the `combine` field on each
  // base model above). They need their own registry entries purely so
  // estimateVideoCost() can look up the right per-second rate for
  // whichever one actually gets called — without an entry here, cost
  // estimation silently falls back to a generic default rate. This exact
  // gap (fal-ai/veo3.1/reference-to-video missing from the registry)
  // previously caused a confirmed real billing mismatch: Fal charged
  // $3.20 for it, the ledger had recorded $0.80 using the wrong fallback.
  // ------------------------------------------------------------
  {
    // Duration corrected from direct production evidence: a real Fal
    // validation error rejected "6s" with "Input should be '8s'" on
    // this specific endpoint — the reference/combine variant apparently
    // has a NARROWER duration constraint than the base image-to-video
    // endpoint's full 4/6/8 range. Only one confirmed data point so far;
    // if 4s or 6s turns out valid under some other condition, this may
    // need loosening again, but "8s only" is the directly-evidenced
    // safe default rather than repeating the wrong assumption.
    id: "fal-ai/veo3.1/reference-to-video",
    label: "Veo 3.1 Reference-to-Video (auto)",
    tier: "quality",
    costPerSecond: 0.4, // confirmed: $0.40/sec with audio on (our default), $0.20/sec audio off
    duration: { type: "enum", options: [8] },
    hidden: true,
  },
  {
    id: "bytedance/seedance-2.0/reference-to-video",
    label: "Seedance 2.0 Reference-to-Video (auto)",
    tier: "alt",
    costPerSecond: 0.2, // placeholder, same as base tier — verify
    duration: { type: "range", min: 5, max: 15 },
    hidden: true,
  },
  {
    id: "bytedance/seedance-2.0/fast/reference-to-video",
    label: "Seedance 2.0 Fast Reference-to-Video (auto)",
    tier: "fast",
    costPerSecond: 0.1, // placeholder — verify
    duration: { type: "range", min: 5, max: 15 },
    hidden: true,
  },
  {
    id: "fal-ai/vidu/q1/reference-to-video",
    label: "Vidu Q1 Reference-to-Video (auto)",
    tier: "alt",
    costPerSecond: 0.15, // placeholder — verify
    duration: { type: "range", min: 4, max: 8 },
    hidden: true,
  },
  {
    id: "alibaba/happy-horse/reference-to-video",
    label: "Happy Horse Reference-to-Video (auto)",
    tier: "alt",
    costPerSecond: 0.15, // placeholder — verify current price
    duration: { type: "range", min: 3, max: 15 },
    hidden: true,
  },
  {
    id: "fal-ai/kling-video/o3/pro/reference-to-video",
    label: "Kling O3 Pro Reference-to-Video (auto)",
    tier: "alt",
    costPerSecond: 0.112, // confirmed (audio off) — was a $0.15 placeholder
    duration: { type: "range", min: 3, max: 15 },
    hidden: true,
  },
];

const DEFAULT_IMAGE_MODEL_PRO = "fal-ai/nano-banana-pro/edit";
const DEFAULT_IMAGE_MODEL_FAST = "fal-ai/nano-banana-2/edit";
const DEFAULT_VIDEO_MODEL = "fal-ai/veo3.1/fast/image-to-video";

// Image resolution — confirmed enum for the nano-banana-pro family
// ("1K"/"2K"/"4K", default "1K"). Other curated models (flux-2-pro,
// gpt-image-2, seedream) use different sizing conventions that weren't
// confirmed during this migration, so this selector is only wired up for
// nano-banana-pro/edit for now — see server.js's buildFalImageInput.
// 1K is the default deliberately: it's already well above what Instagram/
// social feeds display at, and both 2K and 4K cost meaningfully more
// (roughly 1.5x and 2x per-image) for no visible benefit in that context.
const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"];
const DEFAULT_IMAGE_RESOLUTION = "1K";

// Video duration is now a PER-MODEL constraint (see the `duration` field
// on each VIDEO_MODELS entry above) rather than one global enum — Veo only
// accepts 4/6/8s exactly, while Kling genuinely supports any integer 3-15s.
// DEFAULT_VIDEO_DURATION is the fallback used before a model is chosen /
// for an unrecognized custom model ID.
const DEFAULT_VIDEO_DURATION = 8;

// Text/JSON reasoning and vision analysis run through fal-ai/any-llm
// (and its /vision variant), which proxies OpenAI/Anthropic/Google/etc.
// via OpenRouter under one Fal API key. These defaults are overridable
// via env vars or a per-request field, since "best" text model changes
// faster than this file should need to.
const DEFAULT_TEXT_MODEL = process.env.FAL_TEXT_MODEL || "anthropic/claude-sonnet-4.5";
const DEFAULT_VISION_MODEL = process.env.FAL_VISION_MODEL || "openai/gpt-4o";

function getImageModel(id) {
  return IMAGE_MODELS.find((m) => m.id === id) || null;
}
// The resolution param ("1K"/"2K"/"4K") is only confirmed to be accepted
// by the Google Gemini-family models (Nano Banana Pro/2) — sending it to
// a model with a different/stricter schema (FLUX Klein, Seedream, GPT
// Image 2) risks a validation error rather than being silently ignored.
// Gate on this instead of sending it to every model unconditionally.
function modelSupportsResolutionParam(id) {
  return !!getImageModel(id)?.supportsResolutionParam;
}
function getVideoModel(id) {
  return VIDEO_MODELS.find((m) => m.id === id) || null;
}
function estimateImageCost(modelId, { megapixels = 1 } = {}) {
  let m = getImageModel(modelId);
  // Utility-tool models (upscale/extend/restore) live in a separate
  // registry with their own real pricing already defined — without this,
  // every one of them silently fell back to the generic $0.06 unknown-
  // model placeholder instead of its actual, confirmed price, making the
  // cost ledger wrong for every single Image Tools operation.
  if (!m) {
    for (const tool of Object.values(UTILITY_MODELS)) {
      const found = tool.find((t) => t.id === modelId);
      if (found) { m = found; break; }
    }
  }
  if (!m) return 0.06; // unknown/custom model — rough placeholder
  if (m.costPerMegapixel != null) return Number((m.costPerMegapixel * Math.max(1, megapixels)).toFixed(6));
  return m.costPerImage ?? 0.06;
}
function estimateVideoCost(modelId, durationSeconds) {
  const m = getVideoModel(modelId);
  const rate = m?.costPerSecond ?? 0.1;
  return Number((rate * (durationSeconds || 8)).toFixed(6));
}
// Resolves a requested duration (any number) down to a value the chosen
// model will actually accept: snapped to the nearest valid enum value for
// enum-type models (Veo), clamped into range for range-type models
// (Kling), or clamped to a generic 1-30s window for unrecognized/custom
// model IDs where the real constraint isn't known.
function resolveVideoDuration(modelId, requestedSeconds) {
  const requested = parseInt(requestedSeconds) || DEFAULT_VIDEO_DURATION;
  const m = getVideoModel(modelId);
  const constraint = m?.duration;
  if (!constraint) return Math.max(1, Math.min(30, requested));
  if (constraint.type === "enum") {
    return constraint.options.reduce((closest, v) => (Math.abs(v - requested) < Math.abs(closest - requested) ? v : closest), constraint.options[0]);
  }
  if (constraint.type === "range") {
    return Math.max(constraint.min, Math.min(constraint.max, Math.round(requested)));
  }
  return requested;
}

// ============================================================
// UTILITY TOOLS — single-image operations, not part of the main
// photoshoot pipeline. Each confirmed real against Fal's own docs
// before adding (same standard as everything else in this file). Each
// category is now an ARRAY of options, not a single fixed model —
// different tasks genuinely call for different models (e.g. a portrait
// needs different upscaling than an architectural detail shot), and
// this is what the vision-suggestion feature actually recommends between.
// ============================================================
const UTILITY_MODELS = {
  upscale: [
    {
      // Confirmed via fal.ai/models/fal-ai/clarity-upscaler/api — exact
      // code example, exact field name, exact price. General-purpose,
      // good default for most product/architectural shots.
      id: "fal-ai/clarity-upscaler",
      label: "Clarity Upscaler — general-purpose, high-fidelity",
      imageField: "image_url",
      costPerMegapixel: 0.03, // confirmed directly from Fal's own pricing
      bestFor: "general product, architectural, or texture-heavy images",
      // Confirmed via a real Fal example: {"image_url":"...","upscale_factor":2,...}
      buildScaleParams: (scale) => ({ upscale_factor: scale }),
    },
    {
      // Confirmed via fal.ai/models/clarityai/crystal-upscaler/playground
      // — exact price ($0.016/MP), exact scale range (1x-200x), and its
      // own specialization: portrait/facial detail, NOT general-purpose.
      id: "clarityai/crystal-upscaler",
      label: "Crystal Upscaler — specialized for faces/portraits",
      imageField: "image_url",
      costPerMegapixel: 0.016, // confirmed directly from Fal's own pricing
      bestFor: "images where a person's face is the main subject",
      // Confirmed via fal.ai/models/clarityai/crystal-upscaler/api — a
      // DIFFERENT field name than Clarity Upscaler above despite the
      // similar model name: {"image_url":"...","scale_factor":2,...}
      buildScaleParams: (scale) => ({ scale_factor: scale }),
    },
    {
      // Confirmed via fal.ai/models/fal-ai/seedvr/upscale/image/api —
      // exact code example, exact field name (image_url). Price is the
      // confirmed VIDEO-variant rate ($0.001/MP) used as an estimate —
      // the image variant's exact price wasn't independently confirmed,
      // verify before relying on the cost shown.
      id: "fal-ai/seedvr/upscale/image",
      label: "SeedVR2 — cheap, wide scale range (1x-10x), good for bulk/AI-generated images",
      imageField: "image_url",
      costPerMegapixel: 0.001, // estimated from the confirmed video-variant rate — verify for images specifically
      bestFor: "AI-generated images, or bulk/batch upscaling where cost matters most",
      // Confirmed via fal.ai/models/fal-ai/seedvr/upscale/image/api — this
      // one needs TWO fields together, not a single bare number:
      // {"image_url":"...","upscale_mode":"factor","upscale_factor":2,...}
      buildScaleParams: (scale) => ({ upscale_mode: "factor", upscale_factor: scale }),
    },
  ],
  extend: [
    {
      // Confirmed via fal.ai/models/fal-ai/image-apps-v2/outpaint/api —
      // exact code example, exact field name. Pricing not directly seen —
      // verify before relying on the cost estimate.
      id: "fal-ai/image-apps-v2/outpaint",
      label: "Image Extender — expand beyond the original edges",
      imageField: "image_url",
      costPerImage: 0.05, // placeholder — verify actual price on your dashboard
      bestFor: "expanding the scene around an existing image",
    },
  ],
  restore: [
    {
      // Confirmed via fal.ai/models/fal-ai/image-editing/photo-restoration/api
      // — a DIFFERENT endpoint from the one below despite the similar name
      // ("image-editing" not "image-apps-v2"). Its own description
      // explicitly says "removing imperfections, adding color" — genuine
      // colorization, not just a restoration pass. This is the fix for a
      // real, confirmed problem: the old default model's actual output on
      // a real damaged B&W photo was a sepia-toned vignette effect, not
      // true colorization — this model is built for exactly that job.
      id: "fal-ai/image-editing/photo-restoration",
      label: "Photo Restoration (colorizing) — genuine color, not a sepia filter",
      imageField: "image_url",
      costPerImage: 0.04, // estimated from a third-party review, NOT confirmed directly from Fal's own pricing page — verify on your dashboard
      bestFor: "black-and-white or badly damaged photos that need real colorization, not just cleanup",
      // Confirmed real tunable params from Fal's own schema — exposed in
      // the UI so a badly damaged source can be pushed harder instead of
      // being stuck with only the default strength.
      extraParams: [
        { field: "guidance_scale", label: "Restoration strength", type: "range", min: 1, max: 10, step: 0.5, default: 3.5, hint: "Higher pushes harder on badly damaged photos; default usually looks most natural." },
        { field: "num_inference_steps", label: "Quality steps", type: "range", min: 10, max: 50, step: 5, default: 30, hint: "More steps can improve detail on severely degraded originals, at extra processing time." },
      ],
    },
    {
      // Kept as a second option, not deleted — this one's own real-world
      // test result skewed toward a sepia/vintage effect rather than true
      // colorization, so it's no longer the default, but it may still
      // suit restoration-only work (fixing scratches/resolution) on a
      // photo that's already in color and doesn't need colorizing at all.
      id: "fal-ai/image-apps-v2/photo-restoration",
      label: "Photo Restoration (general) — damage/scratch cleanup, less reliable for true colorization",
      imageField: "image_url",
      costPerImage: 0.05, // placeholder — verify actual price on your dashboard
      bestFor: "photos that are already in color and just need scratch/damage cleanup, not colorization",
    },
  ],
};

// ============================================================
// VOICE / TEXT-TO-SPEECH — the first piece of the movie pipeline (see
// the phased plan discussed with the user: voice → talking avatars →
// script breakdown → full multi-scene assembly). Deliberately starting
// small and verified rather than listing every TTS model Fal offers —
// only including models with a schema confirmed directly from Fal's own
// docs, not guessed at from general knowledge of "TTS APIs usually work
// like this."
// ============================================================
// Translates the natural, common *asterisk* convention for stage
// directions into whichever model is actually being used's REAL syntax,
// rather than requiring the person to learn per-model formatting
// themselves. This is genuinely model-specific — confirmed that MiniMax
// and ElevenLabs use different conventions entirely (parentheses +
// <#x#> pause tags vs. square-bracket audio tags), so this takes a
// config object per model instead of a single hardcoded style.
// ============================================================
const PAUSE_KEYWORDS = /\b(pause|gap|silence|beat|wait|break)\b/i;
// MiniMax's ACTUAL confirmed interjection tags, verified directly from
// Fal's own API docs page: "Supports interjection tags: (laughs),
// (sighs), (coughs), (clears throat), (gasps), (sniffs), (groans),
// (yawns)." Exactly 8 — NOT an open-ended set, which was the wrong
// assumption before (confirmed by a real report: "soft chuckle",
// "gentle shake of head", "voice softens" were all being read aloud
// literally, since none of those match any of the 8 real tags).
// FIXED: "laughs" and "sighs" previously had a trailing \b that silently
// rejected plural/verb forms like "giggles" (confirmed real report — it
// was getting stripped to nothing instead of becoming "(laughs)") while
// the other 6 tags never had that restriction. Removed for consistency.
const MINIMAX_INTERJECTION_MAP = [
  { tag: "laughs", keywords: /\b(laugh|chuckl|giggl|smirk)/i },
  { tag: "sighs", keywords: /\b(sigh|exhal|breath)/i },
  { tag: "coughs", keywords: /\bcough/i },
  { tag: "clears throat", keywords: /clear.*throat/i },
  { tag: "gasps", keywords: /\bgasp/i },
  { tag: "sniffs", keywords: /\bsniff/i },
  { tag: "groans", keywords: /\bgroan/i },
  { tag: "yawns", keywords: /\byawn/i },
];
// Anything that doesn't genuinely map gets stripped, not passed through
// as literal text — a visual/body-language direction like "looks
// around" or "voice softens" can't be spoken as a sound at all, so
// reading it aloud word-for-word is strictly worse than silently
// removing it.
function mapToMinimaxInterjection(phrase) {
  const match = MINIMAX_INTERJECTION_MAP.find((m) => m.keywords.test(phrase));
  return match ? `(${match.tag})` : "";
}
// FIXED: a naive /(\d+(\.\d+)?)/ number match on "1/2 second pause" grabs
// just "1" (the numerator), producing a pause exactly twice as long as
// intended. Fractions written as "X/Y" are now parsed properly first.
function parsePauseSeconds(phrase) {
  const fractionMatch = phrase.match(/(\d+)\s*\/\s*(\d+)/);
  if (fractionMatch) {
    const value = parseFloat(fractionMatch[1]) / parseFloat(fractionMatch[2]);
    return Math.min(99.99, Math.max(0.01, value));
  }
  const numberMatch = phrase.match(/(\d+(\.\d+)?)/);
  return numberMatch ? Math.min(99.99, Math.max(0.01, parseFloat(numberMatch[1]))) : 1;
}
// Matches a line that is ENTIRELY a bare stage direction — e.g. "Pause",
// "2 second pause", "Short pause", "Long pause." — with nothing else on
// the line. Deliberately conservative (anchored start-to-end) so a real
// sentence like "Let's pause and reflect" is never touched — only a
// line that IS, in its entirety, a direction gets converted.
const BARE_PAUSE_LINE = /^(?:(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*second[s]?\s*)?(short|long|brief|quick|extended|little|tiny)?\s*(pause|gap|silence|beat|break)s?\.?$/i;
// Same idea for bare interjection-style directions someone might write
// as their own line rather than inline — "Laughs.", "Sighs" etc.
const BARE_INTERJECTION_LINE = /^(laugh|chuckl|giggl|sigh|exhal|cough|clear.*throat|gasp|sniff|groan|yawn)[a-z]*\.?$/i;
// A leading "Warm, reflective tone" style line — genuine delivery
// guidance from a scriptwriter, not something to speak aloud. Kept
// deliberately narrow (short, ends in "tone"/"style"/"delivery") so it
// doesn't accidentally swallow real opening dialogue.
const LEADING_TONE_NOTE = /^[A-Za-z][\w\s,'-]{2,50}\b(tone|style|delivery|mood)\.?$/i;
// Real fix for production-script formatting: converts bare
// direction-only lines into the same *asterisk* form translateScriptMarkers
// already handles, and pulls out a leading tone note (if present)
// separately rather than leaving it to be read aloud literally.
function prepareProductionScript(text) {
  const lines = text.split("\n");
  let deliveryNote = null;
  let startIndex = 0;
  // Only ever consider the very first non-empty line for a tone note —
  // never scans mid-script, where a short line is far more likely to be
  // genuine dialogue.
  while (startIndex < lines.length && !lines[startIndex].trim()) startIndex++;
  if (startIndex < lines.length && LEADING_TONE_NOTE.test(lines[startIndex].trim())) {
    deliveryNote = lines[startIndex].trim();
    lines.splice(startIndex, 1);
  }
  const converted = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (BARE_PAUSE_LINE.test(trimmed) || BARE_INTERJECTION_LINE.test(trimmed)) return `*${trimmed}*`;
    return line;
  });
  return { text: converted.join("\n"), deliveryNote };
}
function translateScriptMarkers(text, { wrapInterjection, wrapPause } = {}) {
  let replaced = text.replace(/\*([^*]+)\*/g, (_, inner) => {
    const trimmed = inner.trim();
    if (wrapPause && PAUSE_KEYWORDS.test(trimmed)) {
      return wrapPause(parsePauseSeconds(trimmed));
    }
    return wrapInterjection(trimmed);
  });
  // MiniMax's own docs confirm pause markers "cannot be used
  // consecutively" — if an interjection between two pauses gets
  // stripped to nothing (a real, common case: "*pause* *some
  // unrecognized action* *pause*"), the two pause tags could end up
  // directly adjacent, which would be silently invalid. Merge any
  // <#x#> tags separated only by whitespace into one, summing their
  // durations, rather than risk that.
  replaced = replaced.replace(/<#([\d.]+)#>(\s*)<#([\d.]+)#>/g, (_, a, ws, b) => {
    const combined = Math.min(99.99, parseFloat(a) + parseFloat(b));
    return `<#${combined}#>`;
  });
  // Same idea for ElevenLabs/Gemini's [pause] bracket tag — collapse any
  // that end up directly adjacent after an in-between marker was stripped.
  replaced = replaced.replace(/(\[pause\])(\s*)\1+/g, "$1");
  // Clean up doubled-up whitespace left behind wherever a marker was
  // stripped entirely, so it doesn't read as an odd, unnatural gap.
  return replaced.replace(/[ \t]+/g, " ").replace(/ +\n/g, "\n").trim();
}
const VOICE_MODELS = [
  {
    // Confirmed directly from fal.ai/models/fal-ai/minimax/speech-02-hd —
    // both the real example payload shape (nested voice_setting object,
    // not flat fields) AND the exact price ($0.10/1000 characters, shown
    // live on Fal's own playground page, not a third-party estimate).
    id: "fal-ai/minimax/speech-02-hd",
    label: "MiniMax Speech-02 HD — 300+ voices, 30+ languages, emotion control",
    costPer1kChars: 0.10,
    bestFor: "narration, voiceover, dialogue — the default choice for most voice needs",
    supportsEmotionPitchSpeed: true,
    modelFamily: "minimax", // matches VOICE_CLONE_MODELS' modelFamily, so custom cloned voices show up here
    // Confirmed real enum from the voice_setting.emotion field's schema —
    // the exact set this model actually accepts, used as the single
    // source of truth for both the manual dropdown and the "generate
    // every emotion" feature, instead of hardcoding this list twice.
    confirmedEmotions: ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"],
    // This full named list mirrors the model's own real dropdown options
    // (seen directly reflected on a page displaying this model's actual
    // UI) — "Wise_Woman" specifically was independently confirmed from a
    // separate real example payload, giving strong confidence the
    // underscore-formatting pattern below is accurate for the rest too.
    // Descriptions are a reasonable reading of what each name signals
    // (gender, age, tone) — not independently verified against actual
    // audio samples, but far more useful than a bare name alone for
    // deciding which one to try first.
    confirmedVoiceIds: [
      { id: "Wise_Woman", description: "Mature female, measured and knowledgeable — good for narration" },
      { id: "Friendly_Person", description: "Warm, approachable, gender-neutral tone — good default for general use" },
      { id: "Inspirational_Girl", description: "Young female, uplifting and energetic" },
      { id: "Deep_Voice_Man", description: "Male, low register — good for authoritative or dramatic reads" },
      { id: "Calm_Woman", description: "Female, relaxed and steady — good for meditative or soothing content" },
      { id: "Casual_Guy", description: "Male, relaxed conversational tone — good for everyday dialogue" },
      { id: "Lively_Girl", description: "Young female, bright and animated" },
      { id: "Patient_Man", description: "Male, gentle and unhurried — good for instructional content" },
      { id: "Young_Knight", description: "Young male, earnest and slightly formal — good for character voices" },
      { id: "Determined_Man", description: "Male, firm and confident" },
      { id: "Lovely_Girl", description: "Young female, soft and pleasant" },
      { id: "Decent_Boy", description: "Younger male, polite and clear" },
      { id: "Imposing_Manner", description: "Commanding, formal tone — good for authority figures" },
      { id: "Elegant_Man", description: "Male, refined and articulate" },
      { id: "Abbess", description: "Mature female, formal and composed — good for solemn/ceremonial content" },
      { id: "Sweet_Girl_2", description: "Young female, gentle and endearing" },
      { id: "Exuberant_Girl", description: "Young female, high energy and enthusiastic" },
    ],
    voiceListUrl: "https://fal.ai/models/fal-ai/minimax/speech-02-hd/playground",
    // Confirmed directly from the Fal AI SDK provider's own parameter
    // documentation. HONEST SCOPE NOTE: Hindi is the only Indian
    // language explicitly confirmed in this model's real language_boost
    // list — Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi,
    // Gujarati, Punjabi are NOT in it. "auto" lets the model
    // auto-detect the language from the text itself, which may still
    // work reasonably for unlisted languages, but isn't a confirmed
    // guarantee the way Hindi is. Genuine broad Indian-language TTS
    // (11 languages including Telugu/Tamil/Kannada) exists on Sarvam
    // AI's Bulbul model — confirmed real, but it's a wholly separate
    // platform with its own API key and billing, not something on Fal,
    // so it isn't wired in here without a deliberate separate decision.
    confirmedLanguages: [
      "auto", "Hindi", "English", "Chinese", "Chinese,Yue", "Arabic", "Russian", "Spanish", "French",
      "Portuguese", "German", "Turkish", "Dutch", "Ukrainian", "Vietnamese", "Indonesian",
      "Japanese", "Italian", "Korean", "Thai", "Polish", "Romanian", "Greek", "Czech", "Finnish",
    ],
    buildInput: (text, { voiceId, speed, pitch, emotion, language } = {}) => ({
      text: translateScriptMarkers(text, {
        // Only these 8 exact tags are confirmed real for this model —
        // mapToMinimaxInterjection matches common phrasings to them and
        // strips anything that doesn't genuinely map, rather than
        // reading an unrecognized visual direction aloud as literal text.
        wrapInterjection: mapToMinimaxInterjection,
        // Confirmed real: <#x#> for timed pauses (0.01-99.99s, from Fal's own docs page).
        wrapPause: (seconds) => `<#${seconds}#>`,
      }),
      voice_setting: {
        voice_id: voiceId || "Wise_Woman",
        speed: speed ?? 1.0,
        vol: 1.0,
        pitch: pitch ?? 0,
        emotion: emotion || "neutral",
        english_normalization: false,
      },
      ...(language && language !== "auto" ? { language_boost: language } : {}),
      // Confirmed directly from a real 422 validation error returned by
      // Fal's own API: output_format only accepts 'url' or 'hex', NOT a
      // file-extension-style value like 'mp3' — an earlier search result
      // showing "mp3" was misapplied from different context. 'url' is
      // used here since it matches the audio.url response shape this
      // code already reads.
      output_format: "url",
    }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/elevenlabs/tts/eleven-v3
    // — real price ($0.05 per 500 chars = $0.10/1000, same page, not a
    // third-party guess) and the real example payload shape. Genuinely
    // different from MiniMax: expressive delivery comes from tags
    // embedded IN the text itself, not from separate emotion/pitch
    // parameters — this is the model built specifically for reading
    // intent from cues like tone and delivery, which is the actual gap
    // that caused the original bug.
    id: "fal-ai/elevenlabs/tts/eleven-v3",
    label: "ElevenLabs Eleven v3 — expressive delivery, 70+ languages including Telugu/Tamil/Kannada",
    costPer1kChars: 0.10,
    bestFor: "expressive dialogue, character voices, or Indian-language speech (Telugu/Tamil/Kannada/Malayalam/Marathi/Gujarati/Punjabi/Hindi/Urdu all confirmed) — the right pick when local-language coverage matters",
    supportsEmotionPitchSpeed: false,
    // Model-level, not repeated per-voice — same real, confirmed fact
    // (ElevenLabs' own docs: all Default voices expire Dec 31 2026
    // together), but stated once instead of 19 times. A list where
    // every entry carries the identical warning is genuinely less
    // useful, not more honest — the real information here is "this
    // whole category shares one expiration," which a single banner
    // conveys better than 19 repetitions of it.
    voiceCategoryNote: {
      text: "All voices below are ElevenLabs' \"Default\" category — real and working today, but the whole category expires together on Dec 31 2026 (confirmed directly from ElevenLabs' own docs). Fine to use now; just don't build something permanent on a Default voice without a plan to switch later.",
      expiresOn: "2026-12-31",
    },
    confirmedVoiceIds: [
      { id: "Sarah", description: "Female, clear and professional — confirmed working directly by real use.", replacesId: null, replacedBy: "Talia" },
      { id: "Rachel", description: "Female, calm American narration voice — confirmed via a real, working voice_id in ElevenLabs' own SDK examples.", replacedBy: null },
      { id: "Domi", description: "Female, strong and confident — confirmed via a real, working voice_id in ElevenLabs' own SDK examples.", replacedBy: null },
      { id: "Adam", description: "Male, deep and authoritative — tech/explainer style.", replacedBy: "Warren" },
      { id: "Antoni", description: "Male, well-rounded, versatile narration tone.", replacedBy: null },
      { id: "Bella", description: "Female, soft and gentle.", replacedBy: null },
      { id: "Elli", description: "Female, young and emotive.", replacedBy: null },
      { id: "Arnold", description: "Male, crisp and clear.", replacedBy: null },
      { id: "Sam", description: "Male, raspy, casual character voice.", replacedBy: null },
      { id: "Charlie", description: "Male, casual Australian accent.", replacedBy: "Baxter" },
      { id: "George", description: "Male, British, warm mid-range.", replacedBy: "Eldrin" },
      { id: "Callum", description: "Male, hoarse, distinctive character voice.", replacedBy: "Kellan" },
      { id: "Daniel", description: "Male, authoritative, news-anchor style.", replacedBy: "Finley" },
      { id: "Matilda", description: "Female, warm, friendly, good for lifestyle/interview content.", replacedBy: "Maisie" },
      { id: "Chris", description: "Male, casual, trusted-guide tone.", replacedBy: "Caleb" },
      { id: "Brian", description: "Male, deep narrator, news-style/fact-driven delivery.", replacedBy: "Sawyer" },
      { id: "Will", description: "Male, casual and loose — sports/comedy banter tone.", replacedBy: "Warren" },
      { id: "Jessica", description: "Female, warm, natural storytelling voice.", replacedBy: "Jade" },
      { id: "Liam", description: "Male, young and energetic — common pick for tech content.", replacedBy: "Lawrence" },
    ],
    // A dropdown of the above, PLUS a "Custom voice name/ID..." escape
    // hatch (same pattern as this app's "Custom model ID…" elsewhere) —
    // the real library is still 10,000+ voices deep, and this list is
    // deliberately not claiming to be exhaustive, just genuinely
    // trustworthy for the entries it does include. HONEST NOTE: every
    // name above is a real Default voice confirmed to exist today
    // (verified via multiple independent sources, including real
    // working voice_id values from ElevenLabs' own SDK examples) — all
    // of them share the model-level retirement note above.
    voiceInputMode: "dropdown-with-custom",
    voiceInputHint: "Every name above is a real, currently-working ElevenLabs Default voice — all of them retire Dec 31 2026 together, so this is a \"works now, plan ahead\" list. For anything else from their 10,000+ voice library, or ElevenLabs' own newer replacement voices, pick \"Custom voice...\" and paste a name from the link below.",
    voiceListUrl: "https://elevenlabs.io/app/voice-library",
    // CORRECTED from an earlier, incomplete claim — confirmed directly
    // from ElevenLabs' own docs (elevenlabs.io/docs/overview/models) and
    // help center, consistent across both: Eleven v3 supports 70+
    // languages, including Telugu, Tamil, Kannada, Malayalam, Marathi,
    // Gujarati, Punjabi, Sindhi, Urdu, and Hindi — genuinely broad
    // Indian-language coverage, unlike the MiniMax model above. No
    // separate language parameter needed: this model auto-detects the
    // language directly from the input text's script, confirmed from
    // the same docs ("automatically uses the appropriate language of
    // the input text").
    confirmedLanguages: null, // no language_boost-style parameter exists for this model — language is auto-detected from the text itself
    autoDetectsLanguageFromText: true,
    // No confirmed emotion/pitch/speed parameters for this model —
    // unlike MiniMax, expressiveness is driven by bracketed tags in the
    // text itself (confirmed: "[excited] Welcome to Eleven v3!"), so
    // those UI controls are simply not sent for this model rather than
    // sending unconfirmed fields that might be silently ignored or
    // rejected.
    buildInput: (text, { voiceId } = {}) => ({
      text: translateScriptMarkers(text, {
        // Confirmed real usage pattern for this model: square-bracket
        // audio tags for delivery/emotion cues, e.g. "[excited]",
        // "[whispers]". No separately-confirmed pause-tag mechanism for
        // this model, so pause-like markers get the same bracket
        // treatment as any other cue — "[pause]" is a plausible,
        // consistent instruction for a tag-driven model like this one,
        // though not independently confirmed the way MiniMax's <#x#> is.
        wrapInterjection: (s) => `[${s}]`,
        wrapPause: () => `[pause]`,
      }),
      voice: voiceId || "Sarah",
    }),
  },
  {
    // Confirmed directly from Fal's own complete API schema page
    // (fal.ai/models/fal-ai/gemini-tts/api) — full real parameter list,
    // not inferred. Google's Gemini TTS, genuinely broader confirmed
    // Indian-language coverage than either model above: the real
    // language_code enum explicitly includes Hindi, Tamil, Telugu,
    // Gujarati, Kannada, Konkani, Malayalam, Marathi, Odia, Punjabi,
    // Sindhi, and Bangla (Bengali) — 12 Indian languages, each
    // selectable directly, not just auto-detected from script the way
    // ElevenLabs works.
    id: "fal-ai/gemini-tts",
    label: "Gemini TTS (Google) — 30 voices, 12 confirmed Indian languages including Telugu/Tamil",
    // HONEST GAP: Fal's schema page didn't show a direct per-character
    // price the way MiniMax/ElevenLabs/Kokoro's pages did. The number
    // here is Google's own native API pricing (not necessarily what Fal
    // charges) — treat as a rough estimate for the cost ledger, not a
    // confirmed Fal rate.
    costPer1kChars: 0.10,
    bestFor: "Indian-language narration with genuine language selection (not auto-detect), or multi-speaker dialogue — supports real speaker-alias prefixes like 'Alice: ... Bob: ...' for two-person scenes",
    supportsEmotionPitchSpeed: false,
    // All 30 real descriptions below are sourced directly from Google's
    // own official Gemini API docs (ai.google.dev/gemini-api/docs/
    // speech-generation), which publishes a real "Characteristics"
    // column for every voice — cross-confirmed against gender info from
    // an independent source. Not guessed, not left as a placeholder.
    confirmedVoiceIds: [
      { id: "Kore", description: "Female, firm — the model's own default" },
      { id: "Puck", description: "Male, upbeat" },
      { id: "Charon", description: "Male, informative" },
      { id: "Zephyr", description: "Female, bright" },
      { id: "Aoede", description: "Female, breezy" },
      { id: "Achernar", description: "Female, soft" },
      { id: "Fenrir", description: "Male, excitable" },
      { id: "Leda", description: "Female, youthful" },
      { id: "Orus", description: "Male, firm" },
      { id: "Umbriel", description: "Male, easy-going" },
      { id: "Callirrhoe", description: "Female, easy-going" },
      { id: "Autonoe", description: "Female, bright" },
      { id: "Enceladus", description: "Male, breathy" },
      { id: "Iapetus", description: "Male, clear" },
      { id: "Algieba", description: "Male, smooth" },
      { id: "Despina", description: "Female, smooth" },
      { id: "Erinome", description: "Female, clear" },
      { id: "Algenib", description: "Male, gravelly" },
      { id: "Rasalgethi", description: "Male, informative" },
      { id: "Laomedeia", description: "Female, upbeat" },
      { id: "Alnilam", description: "Male, firm" },
      { id: "Schedar", description: "Male, even" },
      { id: "Gacrux", description: "Female, mature" },
      { id: "Pulcherrima", description: "Female, forward" },
      { id: "Achird", description: "Male, friendly" },
      { id: "Zubenelgenubi", description: "Male, casual" },
      { id: "Vindemiatrix", description: "Female, gentle" },
      { id: "Sadachbia", description: "Male, lively" },
      { id: "Sadaltager", description: "Male, knowledgeable" },
      { id: "Sulafat", description: "Female, warm" },
    ],
    voiceInputMode: "dropdown-with-custom",
    voiceInputHint: "All 30 real voices are listed above with real characteristics sourced directly from Google's own Gemini API docs — nothing left as an undescribed placeholder.",
    voiceListUrl: "https://fal.ai/models/fal-ai/gemini-tts/playground",
    // Confirmed real language_code enum values — using the exact strings
    // Fal's schema expects, not just language names.
    confirmedLanguages: [
      "auto", "Hindi (India)", "Telugu (India)", "Tamil (India)", "Kannada (India)",
      "Malayalam (India)", "Marathi (India)", "Gujarati (India)", "Punjabi (India)",
      "Odia (India)", "Sindhi (India)", "Konkani (India)", "Bangla (Bangladesh)",
      "English (India)", "English (US)", "Urdu (Pakistan)",
    ],
    buildInput: (text, { voiceId, language } = {}) => ({
      // Confirmed real field name: "prompt", not "text" — this model's
      // schema is genuinely different from the others here.
      prompt: translateScriptMarkers(text, {
        // No confirmed dedicated pause syntax for this model — but Fal's
        // own docs confirm real inline style markers like [slowly],
        // [whispering], [excited] work directly in the prompt text, so
        // reusing bracket-wrapping (same mechanism, different vocabulary)
        // is a reasonable, honestly-labeled choice rather than stripping
        // markers entirely.
        wrapInterjection: (s) => `[${s}]`,
        wrapPause: () => `[slowly]`,
      }),
      voice: voiceId || "Kore",
      model: "gemini-2.5-flash-tts",
      ...(language && language !== "auto" ? { language_code: language } : {}),
      output_format: "mp3",
    }),
  },
  {
    // Confirmed directly on Fal's own sandbox page
    // (fal.ai/models/fal-ai/kokoro/hindi) — a real Hindi example prompt
    // and real pricing shown live, not inferred. Dedicated, single-
    // language model (not a general multilingual model attempting
    // Hindi as one of many) — and at $0.02/1000 chars, the cheapest
    // confirmed option of any voice model in this app, 5x cheaper than
    // MiniMax or ElevenLabs.
    id: "fal-ai/kokoro/hindi",
    label: "Kokoro TTS (Hindi) — dedicated Hindi model, cheapest confirmed option",
    costPer1kChars: 0.02,
    bestFor: "Hindi narration specifically — purpose-built for one language rather than general multilingual coverage, and the cheapest real option available",
    supportsEmotionPitchSpeed: false,
    // Confirmed real voice ID from a live Fal example ("hf_alpha" — "h"
    // for Hindi, "f" for female). Kokoro's broader voice set (per its
    // own model family, seen independently) suggests more IDs likely
    // exist (hm_ for male, etc.) but only this one was seen working in
    // a real example — same honest standard as every other model here.
    confirmedVoiceIds: [{ id: "hf_alpha", description: "Female Hindi voice — the one confirmed working example" }],
    voiceInputMode: "dropdown-with-custom",
    voiceInputHint: "Only one voice ID was directly confirmed working. Kokoro likely has more (male voices, etc.) — try \"Custom voice...\" if you want to experiment, verified with Preview before relying on it.",
    // NOTE ON SCOPE: this specific endpoint is Hindi only. Telugu/Tamil-
    // specific Kokoro endpoints were NOT directly confirmed to exist on
    // Fal (only the underlying Kokoro model family's broader language
    // capability was found, on a different, separate platform) — adding
    // an unconfirmed "fal-ai/kokoro/telugu" here would repeat the exact
    // mistake that caused a real "voice not found" failure earlier
    // tonight. If you want to try it, the "Custom model ID" option
    // elsewhere in Voice Studio can test that guess safely via Preview,
    // without it being presented here as something already confirmed.
    confirmedLanguages: null,
    // Schema confirmed from Fal's own live example: {prompt, voice} —
    // notably "prompt", not "text", unlike every other model here.
    buildInput: (text, { voiceId } = {}) => ({
      prompt: translateScriptMarkers(text, {
        // Not confirmed whether this model supports any interjection or
        // pause syntax at all — safest honest choice is to strip stage
        // directions entirely rather than guess at a format that might
        // just get read aloud literally, same mistake as before.
        wrapInterjection: () => "",
        wrapPause: () => "",
      }),
      voice: voiceId || "hf_alpha",
    }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/inworld-tts/api — real
    // example payload and real price (~$0.01/1K chars, the cheapest
    // option in Fal's own comparison of this whole category). Genuinely
    // different value proposition from the others: lowest cost while
    // still rated competitively on naturalness in Fal's own review.
    id: "fal-ai/inworld-tts",
    label: "Inworld TTS-1.5 Max — lowest confirmed cost, low-latency, 15 languages",
    costPer1kChars: 0.01,
    bestFor: "cost-sensitive narration at real scale — cheapest confirmed option here while still rated competitively on naturalness",
    supportsEmotionPitchSpeed: false,
    // HONEST, deliberately conservative: "Craig (en)" is the only voice
    // name directly confirmed in Fal's own real example payload for
    // THIS specific endpoint. A fuller voice list exists on a different
    // platform's mirror of the same underlying Inworld model, but
    // borrowing names from a different platform's integration is
    // exactly the mistake that broke ElevenLabs' voice list earlier —
    // freeform input with this one confirmed example is the honest
    // choice until more names are independently verified against this
    // exact Fal endpoint.
    confirmedVoiceIds: [{ id: "Craig (en)", description: "The one voice name directly confirmed in Fal's own real example payload for this endpoint" }],
    voiceInputMode: "dropdown-with-custom",
    voiceInputHint: "Only \"Craig (en)\" is directly confirmed for this exact Fal endpoint. Inworld's real voice set is larger (their own docs mention Alex, Ashley, Deborah, and others) but those weren't independently verified against this specific endpoint — try \"Custom voice...\" and confirm with Preview before relying on one.",
    buildInput: (text, { voiceId } = {}) => ({
      text: translateScriptMarkers(text, {
        // Not confirmed whether this model supports any stage-direction
        // syntax — stripped rather than guessed, same honest standard
        // as Kokoro above.
        wrapInterjection: () => "",
        wrapPause: () => "",
      }),
      voice: voiceId || "Craig (en)",
      sample_rate_hertz: 48000,
    }),
  },
  {
    // Confirmed directly from fal.ai/models/xai/tts/v1/api — real,
    // simple schema (just {text}). "Supports 5 expressive voices" per
    // Fal's own page, but the exact 5 names weren't shown in what was
    // retrieved — freeform input rather than guessing at names for a
    // model with a real, live voice-selection field, which is exactly
    // the mistake already fixed once this session.
    id: "xai/tts/v1",
    label: "xAI TTS v1 — expressive real-time dialogue, inline speech tags",
    costPer1kChars: null, // not confirmed — Fal's own page didn't show a per-character rate in what was retrieved
    bestFor: "expressive, real-time-feeling dialogue with inline delivery control",
    supportsEmotionPitchSpeed: false,
    voiceInputMode: "freeform",
    voiceInputHint: "This model supports 5 expressive voices per Fal's own page, but the exact names weren't independently confirmed here — type a voice name and verify with Preview, or leave blank for the model's default.",
    buildInput: (text, { voiceId } = {}) => ({
      text: translateScriptMarkers(text, {
        wrapInterjection: () => "",
        wrapPause: () => "",
      }),
      ...(voiceId ? { voice: voiceId } : {}),
    }),
  },
];

// ============================================================
// VOICE CLONING — confirmed directly from fal.ai/models/fal-ai/minimax/
// voice-clone/api. Takes a real audio sample (10+ seconds) and returns a
// custom_voice_id usable directly in MiniMax Speech-02 HD's voice_id
// field above — same family, confirmed compatible (the clone endpoint's
// own preview step uses speech-02-hd internally).
// IMPORTANT, confirmed from the same page: a cloned voice is NOT
// permanent by default — "To retain the voice permanently, use it with
// a TTS endpoint at least once within 7 days. Otherwise, it will be
// automatically deleted." This is surfaced directly in the UI, not
// buried — a voice someone recorded and named deserves an honest
// warning before it silently vanishes.
// ============================================================
const VOICE_CLONE_MODELS = [
  {
    id: "fal-ai/minimax/voice-clone",
    label: "MiniMax Voice Clone — clone a real voice from a sample recording",
    modelFamily: "minimax",
    // Confirmed real field name and minimum length requirement directly
    // from Fal's own docs.
    minDurationSeconds: 10,
    retentionDays: 7,
    buildInput: (audioUrl, { previewText } = {}) => ({
      audio_url: audioUrl,
      text: previewText || "Hello, this is a preview of your cloned voice! I hope you like it!",
      model: "speech-02-hd",
    }),
  },
];

// ============================================================
// MUSIC GENERATION — confirmed directly from Fal's own sandbox and API
// docs pages (fal.ai/models/fal-ai/minimax-music/v2). Real dual-prompt
// system: a short style/mood/genre description plus separate structured
// lyrics with real [Verse]/[Chorus]/[Bridge] tags — confirmed real
// syntax from Fal's own example, not guessed. Flat $0.03 per generation,
// not per-character — confirmed on the same page.
// ============================================================
const MUSIC_MODELS = [
  {
    id: "fal-ai/minimax-music/v2",
    label: "MiniMax Music 2.0 — full songs with vocals from style + lyrics",
    costPerGeneration: 0.03,
    bestFor: "complete songs with real sung vocals — give it a style/mood description and structured lyrics",
    minStyleChars: 10,
    maxStyleChars: 300,
    minLyricsChars: 10,
    maxLyricsChars: 3000,
    // Confirmed real section tags from Fal's own example payload.
    supportedLyricTags: ["Intro", "Verse", "Chorus", "Bridge", "Outro"],
    buildInput: (stylePrompt, lyricsPrompt) => ({
      prompt: stylePrompt,
      lyrics_prompt: lyricsPrompt,
    }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/elevenlabs/music and
    // fal.ai/elevenlabs's own FAQ — real price ($0.80/min, rounded up to
    // the nearest minute) and real duration range (10s-5min). Single
    // "prompt" field, not separate style/lyrics — ElevenLabs' own example
    // prompts are full natural-language descriptions ("Lo-fi jazz hip-hop
    // with a dusty vinyl crackle...") rather than a structured lyrics
    // format, so style and lyrics are honestly combined into one prompt
    // here rather than pretending this model has MiniMax's two-field shape.
    id: "fal-ai/elevenlabs/music",
    label: "ElevenLabs Music — studio-quality, vocal or instrumental, 19 output formats — $0.80/min",
    costPerGeneration: null, // priced per output minute, not flat — real ledger cost varies by generated length
    bestFor: "highest production quality when cost per minute isn't the deciding factor — understands both casual mood descriptions and precise musical terminology",
    buildInput: (stylePrompt, lyricsPrompt) => ({
      prompt: lyricsPrompt ? `${stylePrompt}. ${lyricsPrompt}` : stylePrompt,
    }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/diffrhythm and its own
    // playground page — real price ($0.01 per 10s = $0.001/sec), real
    // duration modes (95s standard or 285s extended), and a genuinely
    // different, more precise input format: TIMESTAMPED lyrics, not
    // freeform [Verse]/[Chorus] tags — e.g. "[00:10.00]Moonlight spills
    // through broken blinds". This is real extra complexity, not
    // optional — the person needs to actually write timestamps.
    id: "fal-ai/diffrhythm",
    label: "DiffRhythm — fastest & cheapest confirmed (<30s generation, $0.001/sec) — requires timestamped lyrics",
    costPerSecond: 0.001,
    bestFor: "rapid, cheap prototyping — but only if you're willing to write real [MM:SS.ms] timestamps on each lyric line, not plain lyrics",
    requiresTimestampedLyrics: true,
    buildInput: (stylePrompt, lyricsPrompt) => ({
      // Style field name not directly confirmed for this model on its
      // own page (its real style control is reference-audio conditioning
      // via URL, not confirmed as a separate text field) — honestly
      // omitted rather than guessed at. Only the confirmed "lyrics"
      // field is sent.
      lyrics: lyricsPrompt || stylePrompt,
    }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/ace-step/api — the
    // most thoroughly confirmed of these three: real field names (tags,
    // lyrics, duration) with real documented defaults, straight from
    // Fal's own schema page.
    id: "fal-ai/ace-step",
    label: "ACE-Step — confirmed real schema, cheapest of the lyrics-based options (~$0.012/60s per third-party benchmarking)",
    costPerGeneration: 0.012, // from independent third-party benchmarking, not Fal's own pricing page directly — labeled as an estimate, not a confirmed Fal rate
    bestFor: "budget-conscious iteration — cheapest lyrics-based option found, with real confirmed [verse]/[chorus]/[bridge] structure support",
    supportsDuration: true, // confirmed real, controllable field — not every model here has this
    buildInput: (stylePrompt, lyricsPrompt, opts = {}) => ({
      tags: stylePrompt, // confirmed real field: "Comma-separated list of genre tags"
      lyrics: lyricsPrompt, // confirmed real field, same [verse]/[chorus]/[bridge] structure as MiniMax
      duration: opts.durationSeconds || 60, // confirmed real, controllable field — was previously hardcoded regardless of what the user actually wanted
    }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/lyria2/api — Google's
    // Lyria 2. HONEST LIMIT: no lyrics/vocals field exists anywhere in
    // its real schema — only prompt + negative_prompt + seed. This is an
    // instrumental/ambient/soundscape model, not a song-with-vocals one,
    // confirmed by its own example ("ambient soundscape...gentle,
    // melancholic piano melody") and negative-prompt example
    // ("vocals, slow tempo" — actively excluding vocals as an example).
    id: "fal-ai/lyria2",
    label: "Lyria 2 (Google) — instrumental/ambient only, real negative-prompt control, 48kHz — $0.10/30s",
    costPerGeneration: null, // priced per output length on Fal's own billing, not a flat confirmed rate
    bestFor: "high-quality instrumental or ambient background music with precise negative prompting (e.g. explicitly excluding vocals or a certain tempo) — NOT for songs with vocals, no lyrics field exists",
    instrumentalOnly: true,
    buildInput: (stylePrompt, negativePrompt) => ({
      prompt: stylePrompt,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    }),
  },
  {
    // Confirmed directly from Fal's own blog post and API docs page —
    // note the real model ID capitalization: "CassetteAI/music-generator".
    // HONEST LIMIT: confirmed simple schema is exactly prompt + duration,
    // nothing else — Fal's own announcement specifically calls this out
    // ("all you need to enter is your text prompt and desired duration.
    // No need for additional details") — no lyrics field exists.
    // Instrumental only, but genuinely the fastest confirmed option: a
    // full 3-minute track in under 10 seconds.
    id: "CassetteAI/music-generator",
    label: "CassetteAI — instrumental only, extremely fast (3-min track in <10s) — $0.02/output minute",
    costPerGeneration: null, // priced per output minute on Fal's own billing
    bestFor: "fast instrumental background tracks when speed matters more than vocals or fine control — confirmed real 3-minute track in under 10 seconds",
    instrumentalOnly: true,
    supportsDuration: true, // confirmed real, controllable field
    buildInput: (stylePrompt, _lyricsUnused, opts = {}) => ({
      prompt: stylePrompt,
      duration: opts.durationSeconds || 60, // confirmed real, controllable field — was previously hardcoded regardless of what was actually requested
    }),
  },
  {
    // Confirmed directly from fal.ai/seed-audio-1.0 and its own FAQ —
    // ByteDance's Seed Audio 1.0. Genuinely different capability from
    // MiniMax Music above: this one accepts real reference voice clips
    // (audio_urls, up to 3, 30s each, tagged @Audio1/@Audio2/@Audio3 in
    // the prompt) and can combine that voice with background music in
    // one generation — confirmed by Fal's own "British radio commercial"
    // example (voice + intro/background music together).
    id: "bytedance/seed-audio-1.0",
    label: "Seed Audio 1.0 (ByteDance) — your own voice + music, from a real reference clip",
    costPerGeneration: null, // not directly confirmed on the model page — real pricing shown at generation time in Fal's own billing, not fabricated here
    bestFor: "putting your own actual voice into a track with real reference audio — genuinely different from MiniMax Music, which has no voice-reference capability at all",
    supportsVoiceReference: true,
    maxReferenceClips: 3,
    maxReferenceClipSeconds: 30,
    maxPromptChars: 2048,
    maxOutputSeconds: 120,
    // HONEST SCOPE NOTE, not overpromised: Fal's own examples for this
    // model are all spoken delivery over music (commercials, trailers,
    // dialogue) — none demonstrate true melodic, pitched singing the way
    // MiniMax Music's lyrics_prompt does. This is confirmed real for
    // "your voice speaking/narrating with music behind it," not
    // confirmed for "your voice singing an actual song." Also confirmed:
    // English and Chinese only for now, not yet Indian languages.
    confirmedLanguages: ["English", "Chinese"],
    buildInput: (promptText, referenceAudioUrls = []) => ({
      prompt: promptText,
      ...(referenceAudioUrls.length ? { audio_urls: referenceAudioUrls.slice(0, 3) } : {}),
    }),
  },
];

// ============================================================
// SOUND EFFECTS / SONIC LOGOS — genuinely different from MUSIC_MODELS
// above: short, precise sound design (a whoosh, an impact, a branded
// intro sting like Netflix's "ta-dum") rather than full musical
// compositions. Confirmed directly from fal.ai/models/cassetteai/sound-
// effects-generator — real, exact schema (prompt + duration), real
// price ($0.01/generation, flat).
// ============================================================
const SFX_MODELS = [
  {
    id: "cassetteai/sound-effects-generator",
    label: "CassetteAI Sound Effects — short, precise sound design (up to 30s), confirmed real schema — $0.01/generation",
    costPerGeneration: 0.01,
    bestFor: "sonic logos/intro stings, whooshes, impacts, transitions, ambience — real sound design, not a musical composition",
    buildInput: (prompt, durationSeconds) => ({
      prompt,
      duration: Math.min(30, Math.max(1, durationSeconds || 3)),
    }),
  },
];

// ============================================================
// TALKING AVATAR — confirmed directly from Fal's own model pages
// (fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro and /standard).
// Genuinely simple, fully confirmed schema: one portrait image + one
// audio clip in, one talking video out. Real, honest workflow point:
// this model doesn't need to understand the audio's language — lip
// sync is audio-waveform-to-mouth-shape mapping, not language
// comprehension — so pairing this with Voice Studio's already-confirmed
// Indian-language voices is a real path to a local-language talking
// video, without this model itself claiming any language support.
// ============================================================
const TALKING_AVATAR_MODELS = [
  {
    id: "fal-ai/kling-video/ai-avatar/v2/standard",
    label: "Kling AI Avatar v2 Standard — image + audio → talking video — $0.0562/sec",
    costPerSecond: 0.0562,
    buildInput: (imageUrl, audioUrl) => ({ image_url: imageUrl, audio_url: audioUrl }),
  },
  {
    id: "fal-ai/kling-video/ai-avatar/v2/pro",
    label: "Kling AI Avatar v2 Pro — higher quality/resolution — $0.115/sec",
    costPerSecond: 0.115,
    buildInput: (imageUrl, audioUrl) => ({ image_url: imageUrl, audio_url: audioUrl }),
  },
  {
    // Confirmed directly from fal.ai/models/fal-ai/heygen/avatar4/image-to-video/api
    // — full real schema, not partial. Genuinely different from the Kling
    // options above: can take TEXT directly (prompt + voice) instead of
    // requiring a separate pre-generated audio clip, and has real
    // background control (color/image/video) — the actual answer to
    // "what should the background be," not just a portrait-in/video-out
    // black box.
    id: "fal-ai/heygen/avatar4/image-to-video",
    label: "HeyGen Avatar 4 — image + text OR audio, real background control — $0.10/sec",
    costPerSecond: 0.10,
    supportsNativeText: true, // honest flag — the other two models here don't have this
    supportsBackground: true,
    buildInput: (imageUrl, audioUrlOrNull, opts = {}) => ({
      image_url: imageUrl,
      ...(audioUrlOrNull ? { audio_url: audioUrlOrNull } : { prompt: opts.text, voice: opts.voice || "Ivy" }),
      talking_style: opts.talkingStyle || "stable",
      ...(opts.background ? { background: opts.background } : {}),
      aspect_ratio: opts.aspectRatio || "16:9",
    }),
  },
];

module.exports = {
  IMAGE_MODELS,
  VIDEO_MODELS,
  DEFAULT_IMAGE_MODEL_PRO,
  DEFAULT_IMAGE_MODEL_FAST,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  IMAGE_RESOLUTIONS,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_VIDEO_DURATION,
  resolveVideoDuration,
  getImageModel,
  getVideoModel,
  modelSupportsResolutionParam,
  estimateImageCost,
  estimateVideoCost,
  UTILITY_MODELS,
  VOICE_MODELS,
  VOICE_CLONE_MODELS,
  MUSIC_MODELS,
  SFX_MODELS,
  TALKING_AVATAR_MODELS,
  prepareProductionScript,
};