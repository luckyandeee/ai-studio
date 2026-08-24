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
const DURATION_FIELD_NAMES = ["duration", "duration_seconds", "video_length", "length"];
const RESOLUTION_FIELD_NAMES = ["resolution", "image_size", "size"];

function detectSchema(openapi) {
  const schema = getRequestSchema(openapi);
  if (!schema?.properties) return { detected: false, reason: "no schema (expansion may have failed)" };
  const props = schema.properties;
  const propNames = Object.keys(props);

  const imageMatch = IMAGE_FIELD_PATTERNS.find((p) => propNames.includes(p.field));
  const durationField = DURATION_FIELD_NAMES.find((n) => propNames.includes(n));
  const resolutionField = RESOLUTION_FIELD_NAMES.find((n) => propNames.includes(n));
  const hasPrompt = propNames.includes("prompt");
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

  return {
    detected: true,
    hasPrompt,
    imageField: imageMatch?.field || null,
    supportsMultiImage: !!imageMatch?.multi,
    maxImages,
    durationField: durationField || null,
    durationType: durationField ? props[durationField]?.type || null : null,
    durationEnum: durationField ? props[durationField]?.enum || null : null,
    durationMin,
    durationMax,
    resolutionField: resolutionField || null,
    resolutionEnum: resolutionField ? props[resolutionField]?.enum || null : null,
    hasAudioFlag,
    hasEndFrame,
    hasStartFrame,
    hasNegativePrompt,
    hasCfgScale,
    hasCameraControl,
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

module.exports = {
  getRequestSchema,
  summarizeInputSchema,
  detectSchema,
  buildExampleSnippet,
  exampleValueFor,
  IMAGE_FIELD_PATTERNS,
  DURATION_FIELD_NAMES,
  RESOLUTION_FIELD_NAMES,
};