// ============================================================
// PROVIDER ADAPTER — a normalized interface over whichever AI provider
// this app talks to, so the rest of the application (and any future
// provider beyond Fal) can be written against one consistent shape
// instead of provider-specific assumptions leaking everywhere.
//
// IMPORTANT, stated honestly: this is a purely ADDITIVE layer built on
// TOP of existing, already-tested code (fal-catalog.js, fal-client.js,
// fal-models.js, db.js) — it does not replace, rewrite, or move any of
// that logic, and no existing call site has been migrated to route
// through this yet. That migration is real, separate, riskier future
// work that should happen gradually, one call site at a time, tested
// at each step — not as one large rewrite. Building this interface now
// (with only Fal implemented behind it) means the SHAPE is right from
// day one, without touching anything that currently works.
//
// Conceptually:
//   ProviderAdapter
//     discoverModels({ mediaType })
//     getModelDetails(modelId)
//     discoverVoices(modelId)
//     getCapabilities(modelId)
//     validateInput(modelId, input)
//     generate(modelId, input, opts)
//     estimateCost(modelId, params)
//     getStatus(modelId)
//
//   FalAdapter implements it today. A FutureProviderAdapter would
//   implement the exact same 8 methods against a different real API,
//   and the rest of the app would neither know nor care which one it's
//   actually talking to.
// ============================================================
const falCatalog = require("./fal-catalog");
const falClient = require("./fal-client");
const falModels = require("./fal-models");
const db = require("./db");

const CURATED_ARRAYS = {
  image: falModels.IMAGE_MODELS,
  video: falModels.VIDEO_MODELS,
  audio: [
    ...falModels.VOICE_MODELS,
    ...falModels.VOICE_CLONE_MODELS,
    ...falModels.MUSIC_MODELS,
    ...falModels.SFX_MODELS,
    ...falModels.TALKING_AVATAR_MODELS,
  ],
};
function findCuratedEntry(modelId) {
  for (const arr of Object.values(CURATED_ARRAYS)) {
    const found = arr.find((m) => m.id === modelId);
    if (found) return found;
  }
  for (const tool of Object.values(falModels.UTILITY_MODELS)) {
    const found = tool.find((t) => t.id === modelId);
    if (found) return found;
  }
  return null;
}
function mediaTypeOfCurated(modelId) {
  for (const [mediaType, arr] of Object.entries(CURATED_ARRAYS)) {
    if (arr.some((m) => m.id === modelId)) return mediaType;
  }
  return null;
}

const FalAdapter = {
  // --------------------------------------------------------
  // discoverModels({ mediaType }) — normalized list combining curated
  // (hand-verified, real buildInput) and auto-discovered (schema-
  // classified) models for one media type. Real, working data from both
  // existing sources — not a new discovery mechanism.
  // --------------------------------------------------------
  discoverModels({ mediaType } = {}) {
    const curated = (mediaType ? CURATED_ARRAYS[mediaType] || [] : Object.values(CURATED_ARRAYS).flat())
      .filter((m) => !m.hidden) // hidden = internal-only combine/reference endpoints, not user-selectable
      .map((m) => ({
        id: m.id,
        provider: "fal",
        label: m.label,
        mediaType: mediaType || mediaTypeOfCurated(m.id) || "unknown",
        source: "curated",
        status: falCatalog.getNormalizedStatus(m.id, { isCurated: true }),
      }));
    const discovered = falCatalog.getDiscoveredModels({ mediaType }).map((m) => ({
      id: m.id,
      provider: "fal",
      label: m.guideMetadata?.displayName || m.id,
      mediaType: m.classification?.mediaType || "unknown",
      source: "discovered",
      status: falCatalog.getNormalizedStatus(m.id, { isCurated: false }),
    }));
    return [...curated, ...discovered];
  },

  // --------------------------------------------------------
  // getModelDetails(modelId) — full real detail for one model, curated
  // or discovered, normalized into one shape regardless of source.
  // --------------------------------------------------------
  getModelDetails(modelId) {
    const curated = findCuratedEntry(modelId);
    if (curated) {
      return {
        id: modelId,
        provider: "fal",
        source: "curated",
        mediaType: mediaTypeOfCurated(modelId) || "unknown",
        label: curated.label,
        raw: curated,
        liveSchema: falCatalog.getGuide(modelId)?.capabilities || null,
        status: falCatalog.getNormalizedStatus(modelId, { isCurated: true }),
      };
    }
    const discovered = falCatalog.getDiscoveredModels().find((m) => m.id === modelId);
    if (discovered) {
      return {
        id: modelId,
        provider: "fal",
        source: "discovered",
        mediaType: discovered.classification?.mediaType || "unknown",
        label: discovered.guideMetadata?.displayName || modelId,
        raw: discovered,
        liveSchema: discovered.schemaInfo || null,
        status: falCatalog.getNormalizedStatus(modelId, { isCurated: false }),
      };
    }
    return null;
  },

  // --------------------------------------------------------
  // discoverVoices(modelId) — real voice list for a voice model, from
  // whichever source actually has it: the curated confirmedVoiceIds
  // (hand-verified, with descriptions) if this is a curated model, or
  // the schema-derived voiceOptions enum (see fal-schema-utils.js) for
  // a discovered one. Prefers curated (richer, human-described) but
  // falls back to schema data rather than returning nothing.
  // --------------------------------------------------------
  discoverVoices(modelId) {
    const curated = findCuratedEntry(modelId);
    if (curated?.confirmedVoiceIds?.length) {
      return { voices: curated.confirmedVoiceIds, source: "curated", discoveryStatus: "cached" };
    }
    const details = this.getModelDetails(modelId);
    const schemaVoices = details?.liveSchema?.voiceOptions?.options;
    if (schemaVoices?.length) {
      return { voices: schemaVoices.map((id) => ({ id, description: null })), source: "schema", discoveryStatus: "live" };
    }
    if (curated?.voiceInputMode === "freeform") {
      return { voices: [], source: "none", discoveryStatus: "unsupported", note: "This model takes a freeform voice name/ID — no fixed list to choose from." };
    }
    return { voices: [], source: "none", discoveryStatus: details ? "unavailable" : "unsupported" };
  },

  // --------------------------------------------------------
  // getCapabilities(modelId) — normalized capability object, merging
  // curated hand-confirmed flags with live schema-detected ones so a
  // caller gets the fullest real picture regardless of source.
  // --------------------------------------------------------
  getCapabilities(modelId) {
    const details = this.getModelDetails(modelId);
    if (!details) return null;
    const curated = details.source === "curated" ? details.raw : null;
    const schema = details.liveSchema;
    return {
      mediaType: details.mediaType,
      hasPrompt: schema?.hasPrompt ?? null,
      imageInput: { supported: !!(curated?.maxReferenceImages || schema?.imageField), maxReferenceImages: curated?.maxReferenceImages ?? schema?.maxImages ?? null },
      audioInput: { supported: !!schema?.audioField, field: schema?.audioField ?? null },
      duration: schema?.durationField ? { field: schema.durationField, min: schema.durationMin, max: schema.durationMax, options: schema.durationEnum } : (curated?.duration || null),
      resolution: { supported: !!(curated?.supportsResolutionParam || schema?.resolutionField), options: schema?.resolutionEnum || (curated?.supportsResolutionParam ? falModels.IMAGE_RESOLUTIONS : null) },
      negativePrompt: !!schema?.hasNegativePrompt,
      voices: curated?.confirmedVoiceIds?.length ? curated.confirmedVoiceIds.length : (schema?.voiceOptions?.options?.length || 0),
      languages: curated?.confirmedLanguages || schema?.languageOptions?.options || null,
      emotions: curated?.confirmedEmotions || schema?.emotionOptions?.options || null,
      // AI-synthesized "what is this good for" — only present once
      // enrichDiscoveredModels has processed this model (discovered
      // models only; curated models already have hand-written bestFor).
      bestFor: curated?.bestFor || (details.source === "discovered" ? details.raw?.aiEnrichment?.bestFor : null) || null,
    };
  },

  // --------------------------------------------------------
  // validateInput(modelId, input) — genuinely new: checks a proposed
  // request body against the model's real known schema (required
  // fields present, no unrecognized fields) before it's ever sent.
  // Returns valid:null (not valid:false) when there isn't enough schema
  // data to judge either way — an unconfirmed guess is not the same as
  // a confirmed problem, same principle as everywhere else in this app.
  // --------------------------------------------------------
  validateInput(modelId, input) {
    const details = this.getModelDetails(modelId);
    const schema = details?.liveSchema;
    if (!schema?.detected) {
      return { valid: null, reason: "No real schema data available for this model yet — cannot validate either way." };
    }
    const knownFields = new Set(schema.allFields || []);
    const providedFields = Object.keys(input || {});
    const unknownFields = providedFields.filter((f) => !knownFields.has(f));
    const missingRequired = (schema.requiredFields || []).filter((f) => !providedFields.includes(f));
    const valid = unknownFields.length === 0 && missingRequired.length === 0;
    return {
      valid,
      unknownFields,
      missingRequired,
      reason: valid
        ? "All provided fields are recognized and all required fields are present."
        : [
            unknownFields.length ? `Unrecognized field(s): ${unknownFields.join(", ")}` : null,
            missingRequired.length ? `Missing required field(s): ${missingRequired.join(", ")}` : null,
          ].filter(Boolean).join(" "),
    };
  },

  // --------------------------------------------------------
  // generate(modelId, input, opts) — a THIN routing wrapper, stated
  // honestly: it picks the right low-level fal-client function by media
  // type and calls it with EXACTLY the input given. It deliberately does
  // NOT reimplement the higher-level orchestration that already lives in
  // server.js's route handlers (duration resolution, retry-with-
  // fallback, local persistence, moderation) — that orchestration is
  // real, tested, and stays exactly where it is. This exists for
  // callers that already have a fully-built, valid input and just need
  // it sent to the right underlying request function.
  // --------------------------------------------------------
  async generate(modelId, input, { apiKey, mediaType, costMeta, retries } = {}) {
    const resolvedMediaType = mediaType || this.getModelDetails(modelId)?.mediaType;
    if (resolvedMediaType === "image") return falClient.falImageRequest(modelId, input, { apiKey, retries, costMeta });
    if (resolvedMediaType === "video") return falClient.falVideoRequest(modelId, input, { apiKey, retries, costMeta });
    if (resolvedMediaType === "audio") return falClient.falVoiceRequest(modelId, input, { apiKey, retries, costMeta });
    throw new Error(`generate(): couldn't determine media type for ${modelId} — pass { mediaType } explicitly if this model isn't in the registry yet.`);
  },

  // --------------------------------------------------------
  // estimateCost(modelId, params) — routes to the existing, already-
  // correct cost estimators per media type, plus a real audio estimator
  // (image/video already had one each; audio's cost fields vary more —
  // per-character, flat-per-generation, or per-second — so this reads
  // whichever one the model's real registry entry actually defines).
  // --------------------------------------------------------
  estimateCost(modelId, params = {}) {
    const details = this.getModelDetails(modelId);
    const mediaType = params.mediaType || details?.mediaType;
    if (mediaType === "image") return falModels.estimateImageCost(modelId, params);
    if (mediaType === "video") return falModels.estimateVideoCost(modelId, params.durationSeconds);
    if (mediaType === "audio") {
      const curated = findCuratedEntry(modelId);
      if (curated?.costPer1kChars != null) return Number(((curated.costPer1kChars * (params.textLength || 0)) / 1000).toFixed(6));
      if (curated?.costPerSecond != null) return Number((curated.costPerSecond * (params.durationSeconds || 0)).toFixed(6));
      if (curated?.costPerGeneration != null) return curated.costPerGeneration;
      return null; // genuinely unknown — no placeholder guess for audio, unlike image/video which have a documented fallback
    }
    return null;
  },

  // --------------------------------------------------------
  // getStatus(modelId) — the normalized 8-state status (Section 2),
  // already built and tested in fal-catalog.js's getNormalizedStatus.
  // --------------------------------------------------------
  getStatus(modelId) {
    const isCurated = !!findCuratedEntry(modelId);
    return falCatalog.getNormalizedStatus(modelId, { isCurated });
  },

  // --------------------------------------------------------
  // findCompatibleReplacement(modelId) — Section 22: when a model goes
  // deprecated, find the closest real alternative instead of just
  // failing. Scores candidates on OBJECTIVE capability match (same
  // reference-image support, same audio/negative-prompt/resolution
  // fields) using the exact same getCapabilities data already built —
  // no separate judgment mechanism. Same-provider-family candidates get
  // a bonus, since a sibling model is the most likely to look/sound
  // similar, not just be technically compatible on paper.
  // --------------------------------------------------------
  findCompatibleReplacement(modelId) {
    const details = this.getModelDetails(modelId);
    if (!details) return null;
    const targetCaps = this.getCapabilities(modelId);
    const targetFamily = inferProviderFamily(modelId, details.label);
    const candidates = this.discoverModels({ mediaType: details.mediaType })
      .filter((m) => m.id !== modelId)
      .map((m) => ({ ...m, status: this.getStatus(m.id) }))
      .filter((m) => ["selectable", "supported"].includes(m.status.status));
    if (!candidates.length) return null;
    const scored = candidates.map((c) => {
      const caps = this.getCapabilities(c.id);
      let score = 0;
      if (!!caps.imageInput?.supported === !!targetCaps.imageInput?.supported) score += 2;
      if ((caps.imageInput?.maxReferenceImages || 0) >= (targetCaps.imageInput?.maxReferenceImages || 0)) score += 1;
      if (!!caps.audioInput?.supported === !!targetCaps.audioInput?.supported) score += 1;
      if (!!caps.negativePrompt === !!targetCaps.negativePrompt) score += 1;
      if (!!caps.resolution?.supported === !!targetCaps.resolution?.supported) score += 1;
      const candFamily = inferProviderFamily(c.id, c.label);
      if (targetFamily && candFamily && targetFamily.provider === candFamily.provider) score += 2;
      return { ...c, score, capabilities: caps };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  },
};

// ============================================================
// PROVIDER / FAMILY INFERENCE (Section 5) — Fal hosts models from many
// real vendors under one API; the vendor name isn't always in the "fal-
// ai/" prefix, so this maps real, already-researched knowledge of each
// curated model's actual maker into a lookup table, checked in order.
// For a DISCOVERED model (never hand-researched), falls back to the
// AI-enrichment pass's familyGuess/tierGuess instead of guessing here —
// this table is deliberately NOT a generic classifier, just documented
// real facts about the models this app already knows about.
// ============================================================
const PROVIDER_FAMILY_PATTERNS = [
  { match: /^openai\/|\/sora-2\b/i, provider: "OpenAI", family: (id) => (/sora/i.test(id) ? "Sora" : "GPT Image") },
  { match: /^bytedance\/|\/bytedance\//i, provider: "ByteDance", family: (id) => (/seedream/i.test(id) ? "Seedream" : /seedance/i.test(id) ? "Seedance" : /seed-audio/i.test(id) ? "Seed Audio" : "ByteDance") },
  { match: /^alibaba\//i, provider: "Alibaba", family: () => "Happy Horse" },
  { match: /^xai\//i, provider: "xAI", family: () => "xAI TTS" },
  { match: /^cassetteai\//i, provider: "CassetteAI", family: () => "CassetteAI" },
  { match: /nano-banana|gemini-tts|\/lyria/i, provider: "Google", family: (id) => (/nano-banana/i.test(id) ? "Gemini Image" : /gemini-tts/i.test(id) ? "Gemini TTS" : "Lyria") },
  { match: /\/veo3/i, provider: "Google", family: () => "Veo" },
  { match: /flux-2/i, provider: "Black Forest Labs", family: () => "FLUX.2" },
  { match: /kling-video\/ai-avatar/i, provider: "Kuaishou (Kling)", family: () => "Kling Avatar" },
  { match: /kling-video/i, provider: "Kuaishou (Kling)", family: () => "Kling Video" },
  { match: /\/vidu\//i, provider: "Vidu (ShengShu)", family: () => "Vidu Q" },
  { match: /heygen/i, provider: "HeyGen", family: () => "Avatar" },
  { match: /elevenlabs\/tts/i, provider: "ElevenLabs", family: () => "Eleven TTS" },
  { match: /elevenlabs\/music/i, provider: "ElevenLabs", family: () => "Eleven Music" },
  { match: /minimax\/speech|minimax\/voice-clone/i, provider: "MiniMax", family: () => "MiniMax Speech" },
  { match: /minimax-music/i, provider: "MiniMax", family: () => "MiniMax Music" },
  { match: /kokoro/i, provider: "Kokoro", family: () => "Kokoro TTS" },
  { match: /inworld/i, provider: "Inworld AI", family: () => "Inworld TTS" },
  { match: /diffrhythm/i, provider: "DiffRhythm", family: () => "DiffRhythm" },
  { match: /ace-step/i, provider: "ACE-Step", family: () => "ACE-Step" },
  { match: /clarity-upscaler|crystal-upscaler/i, provider: "Clarity AI", family: (id) => (/crystal/i.test(id) ? "Crystal Upscaler" : "Clarity Upscaler") },
  { match: /seedvr/i, provider: "ByteDance", family: () => "SeedVR" },
  { match: /bria\//i, provider: "Bria AI", family: () => "Video Background Removal" },
  { match: /image-apps-v2|image-editing/i, provider: "Fal (in-house tools)", family: () => "Image Tools" },
];
function inferProviderFamily(modelId, label = "") {
  const combined = `${modelId} ${label}`;
  const rule = PROVIDER_FAMILY_PATTERNS.find((r) => r.match.test(combined));
  return rule ? { provider: rule.provider, family: rule.family(combined) } : null;
}
Object.assign(FalAdapter, {
  // --------------------------------------------------------
  // groupModelsByFamily({ mediaType }) — Provider -> Family -> Variant
  // tree (Section 5). Curated models use the real, researched mapping
  // above; discovered models fall back to the AI-enrichment pass's own
  // familyGuess/tierGuess (clearly marked as a guess, not a confirmed
  // fact, same distinction kept everywhere else in this app).
  // --------------------------------------------------------
  groupModelsByFamily({ mediaType } = {}) {
    const models = this.discoverModels({ mediaType });
    const tree = {};
    for (const m of models) {
      const details = this.getModelDetails(m.id);
      let provider, family, tierGuessed = false;
      const inferred = inferProviderFamily(m.id, m.label);
      if (inferred) {
        provider = inferred.provider;
        family = inferred.family;
      } else if (m.source === "discovered" && details?.raw?.aiEnrichment) {
        provider = details.raw.aiEnrichment.familyGuess !== "unknown" ? details.raw.aiEnrichment.familyGuess.split(" ")[0] : "Unknown";
        family = details.raw.aiEnrichment.familyGuess !== "unknown" ? details.raw.aiEnrichment.familyGuess : "Ungrouped";
        tierGuessed = true;
      } else {
        provider = "Unknown";
        family = "Ungrouped";
      }
      tree[provider] = tree[provider] || {};
      tree[provider][family] = tree[provider][family] || [];
      tree[provider][family].push({ ...m, familyGuessed: tierGuessed });
    }
    return tree;
  },
});

module.exports = { FalAdapter, MODEL_STATUS: falCatalog.MODEL_STATUS };