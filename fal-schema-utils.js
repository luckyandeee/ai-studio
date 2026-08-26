// ============================================================
// SHARED SCHEMA UTILITIES — used by both verify-models.js (offline
// maintenance tool) and fal-catalog.js (live server-side verification),
// so the two never drift apart with duplicated logic.
//
// Reads a model's real OpenAPI 3.0 schema (from Fal's Models API,
// expand=openapi-3.0) to:
//   1. Detect which field means "reference image(s)", duration, etc. —
//      pattern-matched against known real conventions instead of guessed.
//   2. Build a runnable example code snippet from the REAL field names
//      and types, not a hardcoded template — so what a user copies
//      actually matches what that specific model expects.
// ============================================================

function getRequestSchema(openapi) {
  try {
    const paths = openapi?.paths || {};
    const firstPath = Object.values(paths)[0];
    return (
      firstPath?.post?.requestBody?.content?.["application/json"]?.schema ||
      firstPath?.get?.requestBody?.content?.["application/json"]?.schema ||
      null
    );
  } catch {
    return null;
  }
}

function summarizeInputSchema(openapi) {
  const schema = getRequestSchema(openapi);
  if (!schema?.properties) return null;
  const required = new Set(schema.required || []);
  return Object.keys(schema.properties).map((k) => `${k}${required.has(k) ? "*" : ""}`);
}

const IMAGE_FIELD_PATTERNS = [
  { field: "image_urls", multi: true },
  { field: "reference_image_urls", multi: true },
  { field: "images", multi: true },
  { field: "image_url", multi: false },
  { field: "start_image_url", multi: false },
  { field: "input_image", multi: false },
  { field: "image", multi: false },
];
// Same pattern, for reference-audio inputs — voice cloning and
// reference-voice generation models take an audio sample as their main
// input, not text/prompt, and were being silently excluded from
// discovery entirely without this (no recognized input field at all).
const AUDIO_FIELD_PATTERNS = [
  { field: "audio_urls", multi: true },
  { field: "reference_audio_urls", multi: true },
  { field: "audio_url", multi: false },
  { field: "reference_audio_url", multi: false },
  { field: "voice_audio_url", multi: false },
];
const DURATION_FIELD_NAMES = ["duration", "duration_seconds", "video_length", "length"];
const RESOLUTION_FIELD_NAMES = ["resolution", "image_size", "size"];
const SEED_FIELD_NAMES = ["seed"];

function detectSchema(openapi) {
  const schema = getRequestSchema(openapi);
  if (!schema?.properties) return { detected: false, reason: "no schema (expansion may have failed)" };
  const props = schema.properties;
  const propNames = Object.keys(props);

  const imageMatch = IMAGE_FIELD_PATTERNS.find((p) => propNames.includes(p.field));
  const audioMatch = AUDIO_FIELD_PATTERNS.find((p) => propNames.includes(p.field));
  const durationField = DURATION_FIELD_NAMES.find((n) => propNames.includes(n));
  const resolutionField = RESOLUTION_FIELD_NAMES.find((n) => propNames.includes(n));
  const seedField = SEED_FIELD_NAMES.find((n) => propNames.includes(n));
  // Real, confirmed bug fixed here: this only recognized a field named
  // exactly "prompt" as the model's main content input — but every
  // voice/TTS model in this app's own curated registry uses "text"
  // instead (confirmed directly: every VOICE_MODELS buildInput function
  // sends `text`, never `prompt`). That meant every discovered voice
  // model would silently fail classification (workType stuck at
  // "unknown") and get excluded from the usable list entirely, no
  // matter how complete its real schema was — the exact opposite of
  // "dynamic," for the one category (voice) this matters most for.
  const hasPrompt = propNames.includes("prompt") || propNames.includes("text");
  const hasAudioFlag = propNames.includes("generate_audio");
  // These run automatically against every model's REAL live schema via
  // the existing catalog check — this is the actual scalable answer to
  // "verify this for every model": instead of one-by-one manual research
  // per model (which doesn't scale and goes stale), the system now
  // detects these capabilities itself, for any model, present or future,
  // the next time its schema gets checked. No more manual time needed
  // per model once this runs.
  const hasEndFrame = propNames.includes("end_image_url");
  const hasStartFrame = propNames.includes("start_image_url");
  const hasNegativePrompt = propNames.includes("negative_prompt");
  const hasCfgScale = propNames.includes("cfg_scale") || propNames.includes("guidance_scale");
  const hasCameraControl = propNames.includes("camera_control");

  let maxImages = null;
  if (imageMatch?.multi) {
    maxImages = props[imageMatch.field]?.maxItems || null; // not always present in the schema
  }
  // Range bounds (minimum/maximum) for a duration field that ISN'T a
  // fixed enum — without this, a genuinely flexible model (e.g. 3-15s)
  // couldn't be told apart from one with no real constraint info at all.
  const durationSchema = durationField ? props[durationField] : null;
  const durationMin = durationSchema?.minimum ?? null;
  const durationMax = durationSchema?.maximum ?? null;
  // The real format string a discovered model expects ("8s" vs bare "8"
  // vs an actual number) isn't reliably inferable from the JSON schema
  // TYPE alone — a string-typed duration field could mean either
  // convention. Fal's own schemas often include a real example value on
  // the property though, which settles it directly instead of guessing:
  // an example like "8s" confirms the suffix convention; "8" confirms
  // bare digits; a number confirms it's sent as an actual number, not a
  // string at all.
  const durationExample = durationSchema?.example ?? null;

  // ============================================================
  // GENERIC ENUM EXTRACTION — the actual fix for the real gap: instead
  // of a human researching and hand-typing a model's real voice list,
  // language list, or emotion list, this reads them straight from Fal's
  // own schema — for ANY field that constrains its values with a real
  // `enum`, on ANY model, automatically. If Fal's schema defines
  // voice_id or language_boost as an enum (which many of their models
  // genuinely do), the valid options are sitting right there in the
  // exact same machine-readable data this app already fetches — no
  // research needed, no hardcoded list to go stale, and it re-reads
  // itself fresh every time the catalog check runs.
  // ============================================================
  const allEnums = {};
  for (const [name, def] of Object.entries(props)) {
    if (Array.isArray(def?.enum) && def.enum.length) allEnums[name] = def.enum;
    // One level of nesting — real, common pattern for voice models (e.g.
    // MiniMax's actual schema nests voice_id/emotion inside a
    // voice_setting object, not at the top level). A top-level-only scan
    // would silently miss exactly the models most likely to need this.
    if (def?.type === "object" && def?.properties) {
      for (const [nestedName, nestedDef] of Object.entries(def.properties)) {
        if (Array.isArray(nestedDef?.enum) && nestedDef.enum.length) allEnums[`${name}.${nestedName}`] = nestedDef.enum;
      }
    }
  }
  // Convenience lookups for the fields that matter most for voice/audio
  // models specifically — still fully generic (checks several real
  // field-name conventions Fal actually uses, doesn't assume one), but
  // named so callers don't have to know Fal's exact field-naming
  // convention for a given model ahead of time.
  const VOICE_FIELD_NAMES = ["voice_id", "voice", "voice_name", "speaker"];
  const LANGUAGE_FIELD_NAMES = ["language_boost", "language_code", "language", "lang"];
  const EMOTION_FIELD_NAMES = ["emotion", "mood", "tone", "style"];
  const findEnum = (names) => {
    const key = Object.keys(allEnums).find((k) => names.includes(k) || names.includes(k.split(".").pop()));
    return key ? { field: key, options: allEnums[key] } : null;
  };
  const voiceOptions = findEnum(VOICE_FIELD_NAMES);
  const languageOptions = findEnum(LANGUAGE_FIELD_NAMES);
  const emotionOptions = findEnum(EMOTION_FIELD_NAMES);

  return {
    detected: true,
    hasPrompt,
    requiredFields: schema.required || [],
    imageField: imageMatch?.field || null,
    supportsMultiImage: !!imageMatch?.multi,
    audioField: audioMatch?.field || null,
    supportsMultiAudio: !!audioMatch?.multi,
    maxImages,
    durationField: durationField || null,
    durationType: durationField ? props[durationField]?.type || null : null,
    durationEnum: durationField ? props[durationField]?.enum || null : null,
    durationMin,
    durationMax,
    durationExample,
    resolutionField: resolutionField || null,
    seedField: seedField || null,
    resolutionEnum: resolutionField ? props[resolutionField]?.enum || null : null,
    hasAudioFlag,
    hasEndFrame,
    hasStartFrame,
    hasNegativePrompt,
    hasCfgScale,
    hasCameraControl,
    allEnums,
    voiceOptions,
    languageOptions,
    emotionOptions,
    allFields: propNames,
  };
}

// Picks a small, sensible example value per field based on its real
// schema type/enum/default — never a blind hardcoded guess, so the
// snippet stays truthful to what that field actually accepts.
function exampleValueFor(field, fieldSchema) {
  if (field === "prompt") return "A clean studio product photo, soft even lighting, plain background.";
  if (/image_urls|reference_image_urls|^images$/.test(field)) return ["https://your-cdn.com/reference-1.jpg", "https://your-cdn.com/reference-2.jpg"];
  if (/image_url|input_image|^image$/.test(field)) return "https://your-cdn.com/your-image.jpg";
  if (fieldSchema?.enum?.length) return fieldSchema.enum[0];
  if (fieldSchema?.default !== undefined) return fieldSchema.default;
  if (fieldSchema?.type === "boolean") return true;
  if (fieldSchema?.type === "integer" || fieldSchema?.type === "number") return 1;
  if (fieldSchema?.type === "array") return [];
  return "...";
}

// Builds a real, runnable code snippet from the model's actual schema —
// only required fields plus a short list of commonly-useful optional
// ones, so it stays short enough to actually read, not a dump of every
// parameter the model accepts.
function buildExampleSnippet(modelId, openapi) {
  const schema = getRequestSchema(openapi);
  if (!schema?.properties) return null;
  const props = schema.properties;
  const required = new Set(schema.required || []);
  const priorityOrder = [
    "prompt", "image_url", "image_urls", "reference_image_urls", "images",
    "start_image_url", "input_image", "duration", "aspect_ratio", "resolution", "generate_audio",
  ];
  const fieldsToShow = [
    ...new Set([...priorityOrder.filter((f) => props[f]), ...required]),
  ].slice(0, 8);
  if (!fieldsToShow.length) return null;

  const exampleInput = {};
  fieldsToShow.forEach((field) => {
    exampleInput[field] = exampleValueFor(field, props[field]);
  });
  const inputJson = JSON.stringify(exampleInput, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "  " + line))
    .join("\n");

  return `import { fal } from "@fal-ai/client";
// npm install @fal-ai/client
// export FAL_KEY="your-fal-api-key"

const result = await fal.subscribe("${modelId}", {
  input: ${inputJson},
});
console.log(result.data);`;
}

// ============================================================
// AUTO-CLASSIFICATION — sorts a model into the dimensions this app
// actually cares about when picking one for a job: is it pure creation
// or can it edit/work from an existing reference? does it support
// enough reference images to be useful for identity/consistency work?
// is it a light, fast edit or a full/heavy regeneration? Built ONLY
// from objective, verifiable facts — the model's real detected schema,
// plus Fal's own listed category/tags/description (quoting Fal's own
// labeling, never this app inventing a judgment) — deliberately never
// from borrowed "models like this are usually good at X" assumptions.
// This is the actual mechanism that makes a brand-new Fal release
// usable the moment its schema is read, with no human manually
// classifying it first.
// ============================================================
function classifyModelCapabilities(schemaInfo, { category = "", tags = [], description = "" } = {}) {
  if (!schemaInfo?.detected) {
    return { classified: false, reason: schemaInfo?.reason || "no schema available" };
  }
  const cat = (category || "").toLowerCase();
  const desc = (description || "").toLowerCase();
  const tagSet = new Set((tags || []).map((t) => (t || "").toLowerCase()));

  // Media type — read from Fal's OWN category label, the single most
  // reliable signal available (no guessing needed).
  let mediaType = "unknown";
  if (/speech|audio|voice|music|sound/.test(cat)) mediaType = "audio";
  else if (/video/.test(cat)) mediaType = "video";
  else if (/image/.test(cat)) mediaType = "image";

  // Creation vs edit — objective from the schema itself: a reference-
  // input field (image or audio) alongside a prompt/text means it can
  // work FROM something existing; that alone (even with no prompt) means
  // edit-only — voice cloning specifically takes ONLY a reference audio
  // clip, no text, and that's still a real, valid, usable model.
  const hasReferenceInput = !!schemaInfo.imageField || !!schemaInfo.audioField;
  const workType = hasReferenceInput
    ? (schemaInfo.hasPrompt ? "creation-or-edit" : "edit-only")
    : (schemaInfo.hasPrompt ? "creation-only" : "unknown");

  // Consistency/identity-lock friendliness — a real, verifiable signal,
  // but NOT a quality guarantee: multi-reference support is NECESSARY
  // for the kind of multi-image identity/product locking this app does,
  // but schema alone can't confirm the model is actually GOOD at
  // preserving a face/product across references, only that it accepts
  // more than one. Framed as "supports multi-reference," never as
  // "guaranteed consistent" — that distinction matters.
  const supportsMultiReference = !!schemaInfo.supportsMultiImage;
  const maxReferenceImages = schemaInfo.maxImages || (hasReferenceInput ? (supportsMultiReference ? null : 1) : 0);

  // Edit weight ("light/fast" vs "heavy/pro") — not a schema field, but
  // Fal's own tags/description are a real first-party signal for it
  // (Fal itself commonly tags/describes models as "fast"/"lite" or
  // "pro"/"high-fidelity") — still objective (quoting Fal's own
  // labeling), not this app inventing a judgment call.
  let editWeight = null;
  if (workType === "edit-only" || workType === "creation-or-edit") {
    if (tagSet.has("fast") || tagSet.has("lite") || /\bfast\b|\blite\b|\bquick\b/.test(desc)) editWeight = "light";
    else if (tagSet.has("pro") || /\bpro\b|\bhigh.fidelity\b|\bhigh.quality\b/.test(desc)) editWeight = "heavy";
  }

  // Human/people support — a real signal ONLY when Fal's own
  // description/tags explicitly mention it (face, portrait, avatar,
  // person, talking) — never silently inferred. Absence of a mention
  // means "unknown," deliberately not "no" — a model can support people
  // perfectly well without Fal happening to say so in its short listing.
  const mentionsHuman =
    /\b(face|faces|portrait|avatar|person|people|human|talking)\b/.test(desc) ||
    tagSet.has("face") || tagSet.has("portrait") || tagSet.has("avatar");

  const hasAudioOutput = mediaType === "audio" || !!schemaInfo.hasAudioFlag;

  return {
    classified: true,
    mediaType,
    workType,
    supportsMultiReference,
    maxReferenceImages,
    editWeight, // "light" | "heavy" | null (unknown/not applicable)
    likelyHumanSupport: mentionsHuman ? "mentioned" : "unknown",
    hasAudioOutput,
  };
}

module.exports = {
  getRequestSchema,
  summarizeInputSchema,
  detectSchema,
  buildExampleSnippet,
  exampleValueFor,
  classifyModelCapabilities,
  IMAGE_FIELD_PATTERNS,
  DURATION_FIELD_NAMES,
  RESOLUTION_FIELD_NAMES,
};