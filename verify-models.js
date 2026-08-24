#!/usr/bin/env node
// ============================================================
// MODEL REGISTRY VERIFIER
// ------------------------------------------------------------
// Checks fal-models.js against Fal's own, documented Platform Models API
// (https://api.fal.ai/v1/models — see https://fal.ai/docs/platform-apis/v1/models)
// instead of relying on manual web research to catch drift. This is the
// same API Fal's own Explore page and third-party model-catalog tools use.
//
// What this catches automatically, that manual research kept missing:
//   - A registered endpoint_id no longer exists (404) or was renamed
//   - A registered model has flipped from "active" to "deprecated"
//   - The model's REAL OpenAPI schema (via expand=openapi-3.0) so field
//     names like "image_url" vs "start_image_url" vs "image_urls" can be
//     checked against what server.js actually sends, instead of guessed
//   - New candidate models in relevant categories not yet in the registry
//
// USAGE:
//   node verify-models.js                 # verify the current registry
//   node verify-models.js --discover      # also search for new candidates
//   FAL_KEY=xxx node verify-models.js     # optional — higher rate limit,
//                                         # not required (auth is optional
//                                         # per Fal's own docs)
//
// This is a MANUAL/maintenance tool, not something the running app calls
// on every request — the live app keeps using the static fal-models.js
// registry (fast, no external dependency on every dropdown load). Run
// this occasionally, or hand its output to Claude to ask "update the
// registry based on this" rather than re-doing ad-hoc web research.
// ============================================================

const { IMAGE_MODELS, VIDEO_MODELS } = require("./fal-models");

const API_BASE = "https://api.fal.ai/v1";
const FAL_KEY = process.env.FAL_KEY || null;

function authHeaders() {
  return FAL_KEY ? { Authorization: `Key ${FAL_KEY}` } : {};
}

async function findModels(endpointIds, { expand = [] } = {}) {
  // Docs: "endpoint_id ... Can be a single value or multiple values
  // (1-50 models). Use array syntax: ?endpoint_id=model1&endpoint_id=model2"
  const params = new URLSearchParams();
  endpointIds.forEach((id) => params.append("endpoint_id", id));
  expand.forEach((e) => params.append("expand", e));
  const res = await fetch(`${API_BASE}/models?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fal Models API returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function searchModels({ category, q, limit = 30 }) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  params.set("status", "active");
  const res = await fetch(`${API_BASE}/models?${params.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fal Models API search returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Pulls out just the top-level required/accepted input field names from an
// OpenAPI 3.0 schema, since that's the part that's bitten this project
// before (wrong field name = silent bad request, not a loud error).
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

// ============================================================
// SCHEMA-DRIVEN FIELD DETECTION — the actual automation upgrade. Instead
// of a human/AI reading a docs page and guessing which field means "put
// the reference image here" (exactly the mistake that produced a wrong
// Kling endpoint earlier this project), this reads the model's REAL
// OpenAPI property list and matches against known naming conventions
// fal's various vendors actually use, in priority order. It still
// produces a DRAFT for review, not a silent auto-add — this narrows what
// a human/AI needs to confirm from "read the whole docs page" down to
// "check one flagged guess," which is the actual time savings.
// ============================================================
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

  let maxImages = null;
  if (imageMatch?.multi) {
    const arraySchema = props[imageMatch.field];
    maxImages = arraySchema?.maxItems || null; // not always present in the schema
  }

  return {
    detected: true,
    hasPrompt,
    imageField: imageMatch?.field || null,
    supportsMultiImage: !!imageMatch?.multi,
    maxImages,
    durationField: durationField || null,
    durationType: durationField ? props[durationField]?.type || null : null,
    durationEnum: durationField ? props[durationField]?.enum || null : null,
    resolutionField: resolutionField || null,
    resolutionEnum: resolutionField ? props[resolutionField]?.enum || null : null,
    hasAudioFlag,
    allFields: propNames,
  };
}

function guessTier(tags) {
  const t = (tags || []).map((x) => x.toLowerCase());
  if (t.includes("pro") || t.includes("premium")) return "pro";
  if (t.includes("lite") || t.includes("fast") || t.includes("turbo") || t.includes("flash")) return "lite";
  return "unverified";
}

// Renders a candidate as a ready-to-paste (after review) fal-models.js
// entry, with the detected schema shown as a comment so the reviewer
// sees exactly what was inferred and why — not just a bare guess.
function renderDraftEntry(model, detection) {
  const lines = [];
  lines.push(`  {`);
  lines.push(`    // DRAFT — schema auto-detected, NOT verified against a real generation.`);
  lines.push(`    // Source: https://fal.ai/models/${model.endpoint_id}`);
  if (detection.detected) {
    lines.push(`    // Detected fields: ${detection.allFields.join(", ")}`);
    lines.push(`    // Guessed image field: ${detection.imageField || "NOT FOUND — check manually"}${detection.supportsMultiImage ? " (array/multi)" : " (single)"}`);
    if (detection.durationField) lines.push(`    // Guessed duration field: ${detection.durationField} (type: ${detection.durationType}${detection.durationEnum ? `, enum: ${JSON.stringify(detection.durationEnum)}` : ""})`);
    if (detection.resolutionField) lines.push(`    // Has a resolution/size field: ${detection.resolutionField}${detection.resolutionEnum ? ` (enum: ${JSON.stringify(detection.resolutionEnum)})` : ""}`);
  } else {
    lines.push(`    // Schema detection FAILED (${detection.reason}) — inspect ${model.endpoint_id}'s docs page manually.`);
  }
  lines.push(`    id: "${model.endpoint_id}",`);
  lines.push(`    label: "${model.metadata?.display_name || model.endpoint_id} — VERIFY before use",`);
  lines.push(`    tier: "${guessTier(model.metadata?.tags)}",`);
  lines.push(`    costPerImage: null, // NOT in the schema — check fal.ai/models/${model.endpoint_id} for real pricing`);
  lines.push(`  },`);
  return lines.join("\n");
}

async function verifyRegistry() {
  const allEntries = [
    ...IMAGE_MODELS.map((m) => ({ ...m, kind: "image" })),
    ...VIDEO_MODELS.map((m) => ({ ...m, kind: "video" })),
  ];
  const ids = allEntries.map((m) => m.id);
  console.log(`\n=== Verifying ${ids.length} registered model(s) against Fal's live API ===\n`);

  // Fal's Find Mode caps at 50 IDs per call — chunk defensively even
  // though this registry is currently well under that.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

  const found = new Map(); // endpoint_id -> model object from Fal
  for (const chunk of chunks) {
    const { models } = await findModels(chunk, { expand: ["openapi-3.0"] });
    models.forEach((m) => found.set(m.endpoint_id, m));
  }

  let deprecatedCount = 0;
  let missingCount = 0;
  for (const entry of allEntries) {
    const live = found.get(entry.id);
    if (!live) {
      missingCount++;
      console.log(`❌ MISSING  [${entry.kind}] ${entry.id}`);
      console.log(`   Not returned by Fal's API at all — likely renamed or removed. Check fal.ai/models for the current slug.`);
      continue;
    }
    const status = live.metadata?.status || "unknown";
    if (status === "deprecated") {
      deprecatedCount++;
      console.log(`⚠️  DEPRECATED [${entry.kind}] ${entry.id} (${live.metadata?.display_name || ""})`);
    } else {
      console.log(`✅ OK  [${entry.kind}] ${entry.id} — ${live.metadata?.display_name || ""}`);
    }
    const fields = summarizeInputSchema(live.openapi);
    if (fields) {
      console.log(`   Real accepted fields: ${fields.join(", ")}`);
    } else if (live.openapi?.error) {
      console.log(`   (schema expansion failed: ${live.openapi.error.message})`);
    }
  }

  console.log(`\n=== Summary: ${allEntries.length - missingCount - deprecatedCount} OK, ${deprecatedCount} deprecated, ${missingCount} missing ===`);
  if (deprecatedCount || missingCount) {
    console.log(`Action needed: update fal-models.js for the flagged entries above before relying on them further.`);
  }
}

// Discovery now does real schema analysis per candidate (not just listing
// names), producing paste-ready draft entries. Still deliberately NOT
// wired to write fal-models.js automatically — every draft is printed as
// "VERIFY before use" and with costPerImage: null, because pricing isn't
// in the OpenAPI schema at all (Fal documents that in prose, not as a
// machine-readable field) and because no field guess here has been
// confirmed against an actual successful generation yet. That last step —
// spending real money to prove a guess correct — needs a human decision,
// not an automatic one.
async function discoverCandidates() {
  const categories = ["image-to-image", "image-to-video"];
  console.log(`\n=== Searching for candidate models + auto-detecting their schemas ===\n`);
  const knownIds = new Set([...IMAGE_MODELS, ...VIDEO_MODELS].map((m) => m.id));
  const maxPerCategory = 8; // schema-fetching is one extra call per candidate — keep this bounded
  for (const category of categories) {
    const { models } = await searchModels({ category, limit: 40 });
    const unlisted = models.filter((m) => !knownIds.has(m.endpoint_id)).slice(0, maxPerCategory);
    console.log(`--- ${category}: analyzing ${unlisted.length} unlisted candidate(s) ---\n`);
    for (const candidate of unlisted) {
      const { models: detailed } = await findModels([candidate.endpoint_id], { expand: ["openapi-3.0"] });
      const full = detailed[0] || candidate;
      const detection = detectSchema(full.openapi);
      console.log(renderDraftEntry(full, detection));
      console.log("");
    }
  }
  console.log(`=== ${categories.length} categories analyzed ===`);
  console.log(`Every entry above is a DRAFT: field names are auto-detected from the real schema (not guessed from docs prose), but pricing is unverified and NONE of these have been confirmed against an actual successful generation. Review, fill in real pricing, and test one call before relying on any of them — or hand this output to Claude to do that review.`);
}

async function main() {
  try {
    await verifyRegistry();
    if (process.argv.includes("--discover")) {
      await discoverCandidates();
    }
  } catch (err) {
    console.error(`\nVerification failed: ${err.message}`);
    console.error(`If this is a network error, check your connection. If it's a 429, wait a bit or set FAL_KEY for a higher rate limit.`);
    process.exit(1);
  }
}

main();