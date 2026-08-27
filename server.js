const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const dotenv = require("dotenv");
dotenv.config();
const db = require("./db");
const progress = require("./progress");
const {
  toFalImageUrl,
  falImageRequest,
  resilientFalImageGeneration,
  falTextRequest,
  falVisionRequest,
  falVideoRequest,
  falVoiceRequest,
  falMergeRequest,
  downloadImageAsDataUri,
  persistFalImage,
} = require("./fal-client");
const {
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
  getVideoModel,
  getImageModel,
  modelSupportsResolutionParam,
  UTILITY_MODELS,
  VOICE_MODELS,
  VOICE_CLONE_MODELS,
  MUSIC_MODELS,
  SFX_MODELS,
  prepareProductionScript,
  TALKING_AVATAR_MODELS,
  MUSIC_INSTRUMENTS,
  MUSIC_GENRE_PRESETS,
} = require("./fal-models");
const {
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
  getRecommendedDefaults,
  enrichDiscoveredModels,
} = require("./fal-catalog");
const { getRealBalance, getRealUsage, getRealPricing } = require("./fal-billing");
const { FalAdapter } = require("./provider-adapter");
const voiceCatalog = require("./fal-voice-catalog");
const videoStitcher = require("./video-stitcher");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const MAX_TOTAL_FRAMES = 10;
const MAX_BATCH_GARMENTS = 8;
const MAX_SHOTS_PER_GARMENT = 4;

// ============================================================
// VENDOR NOTE — MIGRATED FROM GOOGLE (GEMINI/VEO) TO FAL.AI
// ------------------------------------------------------------
// All generative calls now go through fal-client.js, which wraps
// @fal-ai/client. Model *choice* is no longer hardcoded per role the
// way MODEL_COMPOSITE/MODEL_FAST_IMAGE were — the frontend now sends an
// explicit `imageModel` / `videoModel` (chosen from a dropdown, backed
// by the registry in fal-models.js, including a "custom Fal endpoint
// ID" escape hatch) with each request. When the frontend doesn't send
// one (e.g. an older/cached client), resolveImageModels()/
// resolveVideoModel() below fall back to the old lite/pro tier
// heuristic against the curated defaults.
//
// Text/JSON reasoning (creative director, moderation, video briefs,
// prompt rewriting) and vision analysis now run through fal-ai/any-llm
// and fal-ai/any-llm/vision — Fal's OpenRouter-backed "run any LLM"
// endpoints — rather than Gemini directly, so a single FAL_KEY covers
// everything. DEFAULT_TEXT_MODEL/DEFAULT_VISION_MODEL are overridable
// per-request via `textModel`/`visionModel` fields, or globally via the
// FAL_TEXT_MODEL/FAL_VISION_MODEL env vars.
// ============================================================

// Tri-state model tier control: "lite" forces the fast/cheap model, "pro"
// forces the strong model, anything else ("auto"/undefined) falls back to
// the AI classifier's own per-product recommendation. Only used when the
// request doesn't carry an explicit imageModel/videoModel selection.
function resolvePreferLite(classification, modelTier) {
  const tier = modelTier || "auto";
  if (tier === "lite") return true;
  if (tier === "pro") return false;
  // Mirrors the AI prompt's own stated default ("lite unless there's a
  // specific reason pro is needed") at the code level too — if the
  // classification is missing this field entirely (malformed AI response,
  // or a bare fallback object used when parsing fails), this must not
  // silently fall through to the expensive tier by default.
  return classification?.modelTierRecommendation !== "pro";
}

// Resolves the (preferred, alternate) image model pair for a call. An
// explicit `requestedImageModel` (the dropdown selection) is always
// authoritative; the alternate is just a same-session fallback target if
// the preferred model has a transient failure, not a second vote.
function resolveImageModels(classification, requestedImageModel, modelTier) {
  if (requestedImageModel) {
    const alternate =
      requestedImageModel === DEFAULT_IMAGE_MODEL_PRO
        ? DEFAULT_IMAGE_MODEL_FAST
        : DEFAULT_IMAGE_MODEL_PRO;
    return { preferred: requestedImageModel, alternate };
  }
  const preferLite = resolvePreferLite(classification, modelTier);
  return preferLite
    ? { preferred: DEFAULT_IMAGE_MODEL_FAST, alternate: DEFAULT_IMAGE_MODEL_PRO }
    : { preferred: DEFAULT_IMAGE_MODEL_PRO, alternate: DEFAULT_IMAGE_MODEL_FAST };
}

function resolveVideoModelChoice(requestedVideoModel, videoTier) {
  if (requestedVideoModel) return requestedVideoModel;
  if (videoTier === "lite") return "fal-ai/veo3.1/lite/image-to-video";
  if (videoTier === "quality") return "fal-ai/veo3.1/image-to-video";
  return DEFAULT_VIDEO_MODEL;
}

// Fal's convention is a base model ID plus an "/edit" variant for
// image-input calls (e.g. fal-ai/nano-banana-pro vs .../nano-banana-pro/edit).
// The registry stores the /edit form since ~95% of this app's calls pass
// reference images; the couple of pure text-to-image calls (synthetic
// identity generation) strip the suffix back off here.
function endpointFor(modelId, hasImages) {
  const isEditVariant = /\/edit$/.test(modelId);
  const baseId = isEditVariant ? modelId.replace(/\/edit$/, "") : modelId;
  return hasImages ? `${baseId}/edit` : baseId;
}

// ============================================================
// AUTOMATIC MODEL REPLACEMENT (Phase 12 / Section 22) — checks the
// normalized status (already built) before using a requested model; if
// it's genuinely deprecated (not just "missing" — that distinction
// matters everywhere else in this app and matters here too), finds the
// closest real capability-matched replacement and swaps to it
// automatically, returning a clear note explaining what happened rather
// than silently changing behavior or just failing the request.
//
// Also checks whether the caller's actual requested settings (seed,
// resolution, reference-image count) genuinely carry over to the
// replacement — Section 22's own example ("your 2K resolution and
// 8-reference setup were preserved") specifically promises this, not
// just "a replacement was found." Uses the same real getCapabilities
// data already built, not a guess.
// ============================================================
function resolveModelOrReplacement(modelId, requestedSettings = {}) {
  if (!modelId) return { resolvedModelId: modelId, replacementNote: null };
  const status = FalAdapter.getStatus(modelId);
  if (status.status !== "deprecated") return { resolvedModelId: modelId, replacementNote: null };
  const replacement = FalAdapter.findCompatibleReplacement(modelId);
  if (!replacement) {
    return { resolvedModelId: modelId, replacementNote: `${modelId} is deprecated and no compatible replacement was found — this request may fail.` };
  }
  const caps = replacement.capabilities || FalAdapter.getCapabilities(replacement.id);
  const preserved = [], dropped = [];
  if (requestedSettings.resolution) {
    (caps?.resolution?.supported ? preserved : dropped).push(`${requestedSettings.resolution} resolution`);
  }
  if (requestedSettings.referenceCount) {
    const maxRefs = caps?.imageInput?.maxReferenceImages;
    if (maxRefs == null || maxRefs >= requestedSettings.referenceCount) preserved.push(`your ${requestedSettings.referenceCount}-reference setup`);
    else dropped.push(`your ${requestedSettings.referenceCount}-reference setup (this replacement supports up to ${maxRefs})`);
  }
  if (requestedSettings.seed != null) {
    const replacementSupportsSeed = getImageModel(replacement.id)?.supportsSeed;
    (replacementSupportsSeed ? preserved : dropped).push("your locked seed");
  }
  const settingsNote = [
    preserved.length ? `${preserved.join(" and ")} ${preserved.length > 1 ? "were" : "was"} preserved` : null,
    dropped.length ? `${dropped.join(" and ")} couldn't carry over` : null,
  ].filter(Boolean).join(". ");
  return {
    resolvedModelId: replacement.id,
    replacementNote: `${modelId} is no longer available. Automatically switched to ${replacement.label} instead.${settingsNote ? ` ${settingsNote}.` : ""}`,
  };
}
function buildFalImageInput(prompt, imageDataUris, { aspectRatio = "1:1", resolution = DEFAULT_IMAGE_RESOLUTION, modelId = null, seed = null } = {}) {
  const urls = (imageDataUris || []).filter(Boolean).map((u) => toFalImageUrl(u, "image/png"));
  const input = { prompt, num_images: 1 };
  // Single shared lookup — real, confirmed bug fixed here: this was
  // being declared TWICE in this same function (once for the aspect_
  // ratio/image_size check, again for the resolution check just below),
  // a genuine duplicate-const syntax error that broke the file outright.
  // One lookup, reused by every check below (aspect_ratio convention,
  // resolution, seed) — same data, no reason to fetch it more than once.
  const schemaInfo = modelId ? getModelSchemaInfo(modelId) : null;
  // Real, confirmed gap fixed here: this used to send aspect_ratio
  // unconditionally to every single model, regardless of whether it
  // actually has that field. Confirmed directly against FLUX.2 Pro
  // Edit's complete real schema that it has NO aspect_ratio field at
  // all — only image_size (a different preset-shape enum). A model
  // confirmed to use that convention instead simply doesn't receive
  // aspect_ratio at all now (falls back to its own default, which is
  // always safe), rather than risking a validation error or a silently
  // wrong/ignored field. Unknown models keep the prior (default-on)
  // behavior, since that's the existing, already-working assumption for
  // the majority of curated models that DO use aspect_ratio.
  const usesImageSizeConvention = modelId && (getImageModel(modelId)?.usesImageSizeConvention || schemaInfo?.imageSizeConventionField);
  if (aspectRatio && !usesImageSizeConvention) input.aspect_ratio = aspectRatio;
  // Only attach resolution for models confirmed to accept it — sending an
  // unrecognized field to a model with a stricter schema (FLUX Klein,
  // Seedream, GPT Image 2) risks a validation error rather than being
  // silently ignored. When modelId isn't known at this call site (or is a
  // "Custom model ID" the registry has no data on), we can't confirm
  // support either way — default to NOT sending it, since an omitted
  // field just means "use that model's own default," which is always
  // safe, whereas a wrongly-sent field can break the request outright.
  //
  // Checks BOTH the static registry flag AND the live-detected schema
  // (from the ongoing catalog check) — this is what makes new or
  // unflagged models get correct resolution support automatically once
  // they've been checked once, instead of needing a manual flag added
  // to fal-models.js for every model first.
  const supportsResolution = modelId && (modelSupportsResolutionParam(modelId) || schemaInfo?.resolutionField);
  if (resolution && supportsResolution) input.resolution = resolution;
  // Real, valuable capability confirmed directly against Fal's own API
  // reference for Nano Banana Pro/2 — same dual-check pattern as
  // resolution above. Genuinely relevant to this app's whole mission:
  // reusing the same seed across a shoot's multiple frames is a real
  // lever for tighter consistency, on top of the existing identity-lock/
  // reference-image approach, not just a generic "nice to have" param.
  const supportsSeed = modelId && (getImageModel(modelId)?.supportsSeed || schemaInfo?.seedField);
  if (seed != null && supportsSeed) input.seed = seed;
  // Real, confirmed gap fixed here: this used to always send image_urls
  // (plural), a hardcoded assumption true for most of the hand-curated
  // models but not guaranteed for one this app has never had a human
  // look at. getModelSchemaInfo works for BOTH curated (live-checked)
  // and auto-discovered models — using its real detected field name
  // when known, falling back to the same image_urls default only when
  // nothing better is known (preserves exact prior behavior for any
  // model not yet schema-checked).
  if (urls.length) {
    const detectedField = schemaInfo?.imageField;
    if (detectedField && !schemaInfo.supportsMultiImage) {
      // Single-image field (e.g. "image_url") — takes one URL, not an array.
      input[detectedField] = urls[0];
    } else {
      input[detectedField || "image_urls"] = urls;
    }
  }
  return { input, hasImages: urls.length > 0 };
}

const SAFETY_PRINCIPLES = `NON-NEGOTIABLE RULES (apply regardless of product category):
1. Never depict explicit sexual content, nudity, or literal sexual acts.
2. Never depict a minor (anyone who appears under 18) in any romantic, sexual, or suggestive framing, and never in swimwear/underwear/intimate-apparel contexts.
3. Never depict or imply a real, identifiable public figure.
4. For weapons or hazardous/regulated items, keep treatment editorial/documentary — never instructional, never staged to demonstrate use as a weapon.
5. For intimate/adult products (lingerie, underwear, swimwear, condoms, intimate wellness, sexual wellness items): treatment must stay tasteful, non-explicit, and set identityLockSafe=false — precise identity-locked body-compositing is empirically unreliable/unsafe for this combination on the underlying image model regardless of wording, so these MUST go through narrative-style human inclusion (a described scene, not a pixel-precise body lock) whenever a human is included at all.
6. For sexual wellness items specifically (vibrators, and similar): NEVER write a prompt implying literal use, arousal, or post-use satisfaction/afterglow — no "blissful" expressions, no eyes-closed-in-pleasure framing, no "satisfaction" or "release" language, no bedroom-aftermath narrative beats. This applies EVEN WHEN the wording stays non-graphic — an implied climax scene is still a depiction of a sexual act, just described indirectly. The acceptable treatment for these products with a human present is the product visible in a normal domestic context (nightstand, bathroom shelf, packaging held/displayed) with the person fully clothed and NOT positioned as mid-use or post-use — nothing about the scene should suggest the product was just used. If in doubt, default to product-only frames for this category instead of a human frame.
If a request would require violating rules 1-3, set "blocked": true and explain why in "blockedReason" — do not attempt a softened version instead.`;

async function moderateCreativeInputs(fields, { apiKey, textModel, costMeta = null }) {
  const prompt = `You are a content-safety reviewer for a commercial product-photography tool. Review the following user-submitted brief fields. Users are NOT professional copywriters — casual, vague, or clumsy language is completely fine and must be left untouched. You are ONLY looking for language that pushes toward explicit sexual content, literal sexual acts/arousal narratives, or minors in any romantic/sexual/suggestive context.
FIELDS:
${Object.entries(fields)
  .map(([k, v]) => `${k}: ${v || "(empty)"}`)
  .join("\n")}
Return STRICT JSON ONLY, no markdown fences:
{
  "blocked": false,
  "blockedReason": null,
  "flaggedFields": [],
  "softenedFields": {}
}
Rules: set "blocked": true ONLY for minors in any sexual/romantic framing, or explicit requests for literal sexual acts/pornographic description — do not attempt to soften these, just block. For milder cases (e.g. "aroused", "turned on", suggestive-but-not-explicit wording), do NOT block — instead add the field name to "flaggedFields" and put a rewritten tasteful, non-explicit version in "softenedFields" (e.g. rewrite toward mood language like "warm anticipation", "quiet confidence", "soft allure" — preserve the user's underlying creative intent, just not the literal wording). Leave every field that doesn't need changes completely out of softenedFields, and copy it through unchanged.`;
  const response = await falTextRequest(prompt, {
    model: textModel || DEFAULT_TEXT_MODEL,
    apiKey,
    temperature: 0.2,
    costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "moderate-inputs" },
  });
  return JSON.parse(response.text.replace(/```json|```/g, "").trim());
}

async function moderateGeneratedPrompts({ imagePrompts, promptTypes, productLabel }, { apiKey, textModel, costMeta = null }) {
  const humanIndices = promptTypes
    .map((t, i) => (t === "human" ? i : null))
    .filter((i) => i !== null);
  if (humanIndices.length === 0) return { imagePrompts, flaggedIndices: [] };
  const humanPrompts = humanIndices
    .map((i) => `[${i}] ${imagePrompts[i]}`)
    .join("\n\n");
  const prompt = `You are a content-safety reviewer checking image-generation prompts a creative-writing AI just produced for a product called "${productLabel || "this product"}". These prompts were written by another AI, not a person — check them for the same rules a human brief would be held to.
Specifically flag any prompt that implies a literal sexual act, arousal, or post-use satisfaction/afterglow — including INDIRECT framing (e.g. "blissful smile", eyes-closed-in-pleasure, "deep satisfaction", "release", any bedroom-aftermath narrative beat) even when the wording itself isn't graphic. An implied climax scene is still a depiction of a sexual act.
PROMPTS TO CHECK (index: text):
${humanPrompts}
Return STRICT JSON ONLY, no markdown fences:
{
  "flaggedIndices": [],
  "rewrittenPrompts": {}
}
For each flagged index, put a fully rewritten REPLACEMENT prompt in "rewrittenPrompts" (keyed by index as a string) that keeps the same shot composition, lighting, and product placement, but removes ALL implied-sexual-act framing — the person should be fully clothed, in a normal (not mid/post-use) context with the product simply visible nearby. If a prompt can't be salvaged into something appropriate at all, still provide your best clean rewrite — dropping the human element entirely and describing a product-only shot instead is a valid rewrite.`;
  const response = await falTextRequest(prompt, {
    model: textModel || DEFAULT_TEXT_MODEL,
    apiKey,
    temperature: 0.2,
    costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "moderate-generated-prompts" },
  });
  const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
  const correctedPrompts = [...imagePrompts];
  const flaggedIndices = Array.isArray(parsed.flaggedIndices) ? parsed.flaggedIndices : [];
  flaggedIndices.forEach((idx) => {
    const rewrite = parsed.rewrittenPrompts?.[String(idx)];
    if (rewrite) {
      console.warn(`[Output Moderation] Frame ${idx + 1}'s AI-generated prompt implied a sexual act — rewritten before reaching image generation.`);
      correctedPrompts[idx] = rewrite;
    }
  });
  return { imagePrompts: correctedPrompts, flaggedIndices };
}

const SHOT_TYPE_DESC = {
  hero: "Full product visible, centered, moderate distance — the complete object fills roughly 60-80% of the frame, shown as a whole.",
  macro: "EXTREME close-up — camera pushed in tight on ONE small section/detail of the product (a corner, an edge, one repeating motif) so that section fills the ENTIRE frame; the rest of the product must be cropped OUT of view entirely, not visible at all. This must look unmistakably like a different, much closer photograph than the hero shot, not the same composition zoomed slightly.",
  context: "Camera pulled WAY back — the product occupies a small portion (20-35%) of the frame, with generous surrounding environment/space visible around it, showing it in its real-world setting.",
  editorial: "Heavy directional shadows, an unconventional/asymmetric angle (not head-on), dramatic contrast.",
  motion: "Dynamic sense of motion.",
  low_angle: "Extreme low angle, camera near the ground looking up.",
  pov: "First-person point-of-view.",
  bokeh: "Foreground bokeh, shallow depth of field with the product slightly softer or off-center.",
  flatlay: "Flat-lay arrangement, camera directly overhead.",
  alt_lighting: "Golden hour warmth.",
};
const BASE_MATRIX = ["hero", "macro", "context", "editorial"];
const EXTENSION_POOL = ["motion", "low_angle", "pov", "bokeh", "flatlay", "alt_lighting"];
function buildShotSequence(count, shotSequenceHint) {
  let seq = Array.isArray(shotSequenceHint) && shotSequenceHint.length ? [...shotSequenceHint] : [...BASE_MATRIX];
  let ext = EXTENSION_POOL.filter((s) => !seq.includes(s));
  const out = [...seq];
  while (out.length < count && ext.length) out.push(ext.shift());
  if (out.length < count) {
    let i = 0;
    while (out.length < count) {
      out.push(out[i % out.length] + `_v${Math.floor(i / out.length) + 2}`);
      i++;
    }
  }
  return out.slice(0, count);
}
function composeShotProfile(shotTypeRaw, creativeProfile, isHumanFrame) {
  const shotType = shotTypeRaw.split("_v")[0];
  const desc = SHOT_TYPE_DESC[shotType] || "Editorial commercial composition.";
  const humanNote = creativeProfile?.humanInclusionApproach || "Natural, contextual human presence appropriate to the product and brief.";
  const productOnlyNote = creativeProfile?.productOnlyDirection || "Clean commercial product photography.";
  const vibe = isHumanFrame
    ? `${shotType.toUpperCase()} CAMERA FRAMING (mandatory — this frame's distance/crop/angle must look like a clearly different photograph from other frames in this batch): ${desc} ONE single human presence. ${humanNote}`
    : `${shotType.toUpperCase()} CAMERA FRAMING (mandatory — this frame's distance/crop/angle must look like a clearly different photograph from other frames in this batch, not the same shot repeated): ${desc} Pure product photography focus. NO humans. ${productOnlyNote}`;
  return { shotType, vibe };
}
function buildShotProfilesForTypes(count, creativeProfile, wantsHumanArray) {
  const sequence = buildShotSequence(count, creativeProfile?.shotSequenceHint);
  return sequence.map((shotType, i) => composeShotProfile(shotType, creativeProfile, !!wantsHumanArray[i]));
}
function buildProductLockClause(creativeProfile, { imageLabel = "the reference image" } = {}) {
  const silhouetteLockAppropriate = creativeProfile?.silhouetteLockAppropriate !== false;
  const lightColorNote = " If its base color is light, pastel, off-white, ivory, cream, or otherwise low-saturation, this is CRITICAL: do not shift it toward gray, beige, or any darker/cooler/more-saturated tone — preserve its actual lightness and minimal saturation exactly.";
  const requiresBaseLayer = typeof creativeProfile?.requiresVisibleBaseLayer === "boolean" ? creativeProfile.requiresVisibleBaseLayer : !silhouetteLockAppropriate;
  const baseLayerNote = requiresBaseLayer
    ? ` BASE LAYER — CRITICAL, NEVER SKIP: this item is worn over/around the torso without covering it as a stitched garment would on its own (a saree, a dupatta worn as the main covering, or similar). The person MUST be shown wearing an appropriate, modest, coordinating blouse/choli underneath — fitted, torso-covering, at least short sleeves — ${creativeProfile?.baseLayerDescription ? `specifically: ${creativeProfile.baseLayerDescription}` : "in a color/style that complements the item's palette"} — plus a matching underskirt/petticoat where relevant. NEVER render bare skin, an undergarment-only torso, or no visible blouse under the drape.`
    : "";
  if (silhouetteLockAppropriate) {
    const patternFidelityNote = " If the material has any repeating pattern (checks, grids, stripes, small repeating motifs like dots/diamonds inside each check, jaal patterns), preserve its exact scale, density, and spacing precisely — do not enlarge, shrink, simplify, regularize, or omit any repeating element; the number and size of pattern units per unit area must match the source exactly, not an approximation of it.";
    return `PRODUCT LOCK: preserve the product's exact base material color, silhouette, and proportions from ${imageLabel} precisely — do not simplify, recolor, or reinterpret its shape. This means the object's DESIGN only — its crop, distance, and framing in ${imageLabel} are NOT locked and must NOT be copied; follow the camera framing instruction above instead, even if that means showing only a small cropped portion of the object or pulling back so it's small in the frame.${creativeProfile?.actualProductMaterials ? ` Its actual material, confirmed from the source photo, is: ${creativeProfile.actualProductMaterials} — do not describe or render it as any other material, regardless of what any other text might suggest.` : ""}${creativeProfile?.productScope === "component" ? ` NOTE: ${imageLabel} is already an ISOLATED render of just the manufactured product (a component that gets mounted on/applied to something else, like a fixture or ornament) — the brand does not manufacture the carrier surface it's shown on. Lock the component's design/material exactly, but the carrier context in this scene is free creative staging, not something to preserve from any other reference.` : ""} ALSO preserve the exact surface material and finish type — if a surface is smooth grained leather in ${imageLabel}, it must render as smooth grained leather here, never reinterpreted as woven fabric, mesh, plastic, or any other material. Every distinct surface/panel keeps its own specific material exactly as shown. AND preserve its exact mechanical construction (door type, panel mechanisms, hinges, openings) exactly as shown — never substitute a different mechanism even if it would look more dramatic; this is product photography and the real design must never be misrepresented. Lighting may add highlights/reflections on the surface, but must never change the material's actual color, texture type, or the product's actual geometry.${patternFidelityNote}${baseLayerNote}${lightColorNote}`;
  }
  const zoneNote = creativeProfile?.zonedPatternDescription
    ? ` This item has distinct pattern zones that must land in the correct worn position, not be smeared uniformly across the garment: ${creativeProfile.zonedPatternDescription}`
    : creativeProfile?.actualProductMaterials
      ? ` Its actual colors/materials, confirmed from the source photo: ${creativeProfile.actualProductMaterials}`
      : "";
  const wearNote = creativeProfile?.wearInstructions ? ` HOW IT IS ACTUALLY WORN: ${creativeProfile.wearInstructions}` : "";
  return `PRODUCT LOCK (DRAPED/WRAPPED ITEM — DO NOT copy the folded silhouette): ${imageLabel} shows this item folded or flat, which is NOT how it looks worn — do not paste its photographed rectangular/folded shape onto a body, that will look wrong. Instead, lock ONLY its color palette, fabric texture, and motif/pattern designs from ${imageLabel}, and render it in its correct real-world worn form.${wearNote}${zoneNote} Every distinct pattern zone (e.g. a plain/patterned body vs. a decorative border vs. any special end-piece) must keep its own exact color and motif, correctly positioned for how this item is actually worn — never blend zones together or drop any zone's distinct pattern.${baseLayerNote}${lightColorNote}`;
}
function generationCohortFromBirthYear(birthYear) {
  if (!birthYear || typeof birthYear !== "number") return null;
  if (birthYear >= 1997) return { label: "Gen Z", note: "tends to favor authentic/unpolished-feeling imagery, bold color, and fast visual pacing over glossy traditional luxury cues" };
  if (birthYear >= 1981) return { label: "Millennial", note: "tends to favor clean, aspirational, well-composed imagery with a mix of lifestyle and product focus" };
  if (birthYear >= 1965) return { label: "Gen X", note: "tends to favor straightforward, credible, less-trend-chasing imagery — clarity and quality cues over novelty" };
  if (birthYear >= 1946) return { label: "Baby Boomer", note: "tends to favor classic, traditional, unambiguous product presentation over abstract or heavily stylized concepts" };
  return { label: "an older generation", note: "tends to favor classic, traditional presentation" };
}
function buildBrandContextBlock(brandProfile) {
  if (!brandProfile) return "";
  const parts = [];
  if (Array.isArray(brandProfile.whereSold) && brandProfile.whereSold.length) {
    parts.push(`This brand sells primarily via: ${brandProfile.whereSold.join(", ")}. Let this inform realistic platform conventions where relevant (e.g. marketplace listings often benefit from at least some clean product-only shots; social/lifestyle platforms favor more contextual human shots) — but the Shot Mix specified for THIS run is still authoritative on exact counts.`);
  }
  if (brandProfile.targetAudience) parts.push(`Typical customer: ${brandProfile.targetAudience}. Let this inform model casting, styling, and tone unless a specific run's own casting fields say otherwise.`);
  if (brandProfile.region) parts.push(`Primary market/region: ${brandProfile.region}. Let this inform cultural and seasonal relevance of props, styling, and setting.`);
  if (brandProfile.aestheticPreference) parts.push(`Standing brand aesthetic: ${brandProfile.aestheticPreference}. Treat this as the default tone/environment direction, layered underneath (not overriding) whatever specific Creative Direction is given for this particular shoot.`);
  const cohort = generationCohortFromBirthYear(brandProfile.birthYear);
  if (cohort) parts.push(`Founder/brand generational cohort: ${cohort.label}. As a soft, secondary tone signal only (never overriding the Target Customer or Brand Aesthetic fields above when they conflict) — ${cohort.note}.`);
  if (!parts.length) return "";
  return `\nBRAND PROFILE (persistent context for this brand, supplied once and reused across shoots):\n${parts.join("\n")}\n`;
}
function buildPoseFreedomConstraint(poseFreedom) {
  if (poseFreedom === "standing") return "POSE FREEDOM — STANDING ONLY: every human frame must show the model standing. Do not sit, lean into a seated pose, lie down, or use extreme/unconventional body angles — vary camera angle and framing for visual interest instead of varying the model's basic stance.";
  if (poseFreedom === "creative") return "POSE FREEDOM — FULL CREATIVE LATITUDE: the photographer should feel free to vary the model's pose and energy meaningfully across frames — standing, seated, leaning, candid mid-motion, dramatic angles — whatever best serves each individual shot's mood, as long as it stays tasteful and consistent with the brand. Don't default to one safe stance repeated across the whole batch.";
  return "POSE FREEDOM — NATURAL VARIETY: mostly standing poses with occasional tasteful variation (e.g. one seated or candid frame in a larger batch) if it suits a specific shot — not mandatory variety for its own sake, and not locked to standing-only either.";
}

// ============================================================
// DETERMINISTIC SAFETY BACKSTOP for SAFETY_PRINCIPLES rules 5 & 6.
// ------------------------------------------------------------
// Rules 5/6 tell the text model to set identityLockSafe=false and avoid
// arousal/afterglow language for the FULL category rule 5 names: "lingerie,
// underwear, swimwear, condoms, intimate wellness, sexual wellness items".
// In practice this instruction isn't always followed reliably by every
// underlying text model (observed directly: lingerie classified
// identityLockSafe=true, which then hit Fal's own content-policy filter
// on the resulting hyper-detailed anatomical prompt). Rather than trust
// the LLM's judgment alone for a safety-relevant field, force it
// deterministically here whenever the product description matches this
// pattern — this can only make behavior MORE conservative than what the
// model already decided, never less.
//
// Coverage is necessarily keyword-based, not exhaustive: it catches
// explicit category words but can't infer intent from something like
// "personal wellness device" that never uses a matched term. Treat this
// as a backstop for the common/obvious cases, not a guarantee.
// ============================================================
const INTIMATE_SENSITIVE_PATTERN = /\b(bra|panty|panties|lingerie|underwear|brief|thong|nightwear|innerwear|swimwear|swimsuit|bikini|condom|condoms|vibrator|vibrators|dildo|sex\s*toy|intimate\s*wellness|sexual\s*wellness)\b/i;
function isIntimateSensitiveCategory(text) {
  return INTIMATE_SENSITIVE_PATTERN.test(text || "");
}
function enforceIntimateSensitiveSafety(classification, sourceText) {
  if (!classification) return classification;
  if (isIntimateSensitiveCategory(sourceText) || isIntimateSensitiveCategory(classification.productLabel)) {
    if (classification.identityLockSafe !== false) {
      console.warn(`[Safety Backstop] "${classification.productLabel || sourceText}" matched the intimate/sensitive-category pattern but identityLockSafe wasn't false — forcing it to false (narrative route) per SAFETY_PRINCIPLES rule 5.`);
    }
    classification.identityLockSafe = false;
  }
  return classification;
}

// ============================================================
// GENERATION PIPELINE — migrated to Fal.ai
// ============================================================
async function generateLockedProductRender(
  rawProductBase64,
  costMeta,
  {
    apiKey,
    preferredModel,
    alternateModel,
    resolution,
    productScope = "wholeItem",
    componentDescription = null,
    estimatedRealWorldSize = null,
    skipRerender = false,
  } = {},
) {
  if (skipRerender) {
    console.log(`[Product Lock] Skipping canonical re-render per user request — using the source photo directly as the product reference.`);
    const dataUri = rawProductBase64.startsWith("data:") ? rawProductBase64 : `data:image/png;base64,${rawProductBase64}`;
    return { image: dataUri, modelUsed: "source-photo-direct", usedFallback: false };
  }
  console.log(`[Product Lock] Generating one canonical product render (${preferredModel} primary, ${alternateModel} fallback)${productScope === "component" ? " — isolating component from carrier" : ""}...`);
  const sizeNote = estimatedRealWorldSize ? ` (for reference, its actual real-world size is ${estimatedRealWorldSize} — keep this in mind for its proportions/detail density, even though this shot has no scale reference visible)` : "";
  const lightColorNote = ` If the base color is light, pastel, off-white, ivory, cream, or otherwise low-saturation, this is CRITICAL: do not shift it toward gray, beige, or any darker/cooler/more-saturated tone — preserve its actual lightness and minimal saturation exactly as photographed, even under studio lighting that might otherwise tempt a mid-tone reinterpretation.`;
  const patternFidelityNote = ` If the material has any repeating pattern (checks, grids, stripes, small repeating motifs like dots/diamonds inside each check, jaal patterns), preserve its exact scale, density, and spacing precisely — do not enlarge, shrink, simplify, regularize, or omit any repeating element; the number and size of pattern units per unit area must match the source exactly.`;
  const prompt =
    productScope === "component" && componentDescription
      ? `You are given a photo showing a manufactured product MOUNTED ON or APPLIED TO something else that is NOT the product being sold — only part of this photo is the actual product. The actual product is: ${componentDescription}${sizeNote}.
Render ONLY that actual product as a pristine, ultra-detailed studio hero photograph on a plain neutral background, isolated from whatever it was mounted on/applied to in the source photo — do not include the carrier object at all, just the manufactured piece itself, from a clear angle that shows its key design details.
CRITICAL: this must be a precise, faithful reproduction of the actual product only, not a reinterpretation — preserve the exact base color, the exact material/finish type, the exact pattern/design detail, and the exact proportions. Do not invent, add, or omit any design detail. Do not render any part of the carrier object.${lightColorNote}${patternFidelityNote}
Clean, even studio lighting. No text, no watermark, no logo, no background props — the product only.`
      : `You are given a photo of a physical product. Render this EXACT product as a pristine, ultra-detailed studio hero photograph on a plain neutral background, from a clear three-quarter angle that shows its key surfaces.
CRITICAL: this must be a precise, faithful reproduction, not a reinterpretation — preserve the exact base color of every surface, the exact material/finish type of every surface, the exact trim/accent placement and color, and the exact silhouette and proportions. Do not invent, add, or omit any design detail.${lightColorNote}${patternFidelityNote}
Clean, even studio lighting. No text, no watermark, no logo, no background props — the product only.`;
  return resilientFalImageGeneration(
    (model) => buildFalImageInput(prompt, [rawProductBase64], { aspectRatio: "1:1", resolution, modelId: model }).input,
    {
      preferredModel: endpointFor(preferredModel, true),
      alternateModel: endpointFor(alternateModel, true),
      apiKey,
      costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "lock-set" },
    },
  );
}

async function generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution }) {
  console.log(`[Casting] Generating locked seed identity portrait...`);
  const identityPrompt = `${seedIdentity || "A brand-appropriate professional model"}, three-quarter body shot, natural standing pose, arms and torso visible, fully and modestly dressed, no exposed thighs, no high slits, no midriff, no cleavage. SETTING: ${environment || "high-end minimalist studio"}.
CAMERA: shot on a full-frame mirrorless camera (e.g. Sony A7IV), 50mm f/1.8 lens, natural window or ambient light rather than a flat ring-light/beauty-dish studio setup. Slight natural depth-of-field falloff toward the background. Subtle, natural film-like grain — not digitally over-clean.
PHOTOREALISM: pronounced natural facial asymmetry, visible individual skin texture and pores, natural variation in skin tone, minor under-eye texture, natural flyaway hairs, a genuine caught-mid-thought or candid micro-expression rather than a posed magazine smile. Avoid the common AI-generated look entirely: no waxy/plastic-smooth skin, no perfectly even skin tone, no glassy over-sharp catchlights in the eyes, no airbrushed symmetry.
POSE VARIATION: avoid the default hands-clasped-in-front, straight-profile stance — vary weight distribution, hand placement, shoulder angle, and gaze direction the way a real candid photographer would capture a moment.
This should look like an unretouched real photo of a real person caught in a real moment, not a rendered or illustrated one.
No text, no watermark, no logo anywhere.`;
  return resilientFalImageGeneration(
    (model) => buildFalImageInput(identityPrompt, [], { aspectRatio: "1:1", resolution, modelId: model }).input,
    {
      preferredModel: endpointFor(preferredModel, false),
      alternateModel: endpointFor(alternateModel, false),
      apiKey,
      costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "lock-set" },
    },
  );
}

async function generateNeutralIdentityPortrait(rawReferenceBase64, subjectSelectionNote, costMeta, { apiKey, preferredModel, alternateModel, resolution }) {
  console.log(`[Reference Sanitize] Extracting identity into a neutral-wardrobe portrait...`);
  const prompt = `You are given a reference photo of a person. Render a fresh, photorealistic three-quarter-body portrait of THIS EXACT SAME INDIVIDUAL — preserve their face, identity, body proportions, hairstyle, and skin tone precisely.
${subjectSelectionNote || ""}
WARDROBE: completely IGNORE whatever they are wearing in the reference photo — do not preserve, reference, or hint at it in any way, however minimal or revealing it is. Instead dress them in simple, neutral, fully-covering everyday clothing (e.g. a plain crew-neck top and trousers) — unremarkable, appropriate for any professional context, nothing about the original photo's styling should carry through.
Natural standing pose, soft even studio lighting, no text, no watermark, no logo. This portrait exists purely to carry facial/body identity forward into later shots — nothing else about the original photo matters here.`;
  return resilientFalImageGeneration(
    (model) => buildFalImageInput(prompt, [rawReferenceBase64], { aspectRatio: "1:1", resolution, modelId: model }).input,
    {
      preferredModel: endpointFor(preferredModel, true),
      alternateModel: endpointFor(alternateModel, true),
      apiKey,
      costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "sanitize-reference" },
    },
  );
}

async function compositeIdentityWithProduct(
  {
    lockedIdentityImage,
    lockedProductImage,
    environment,
    aspectRatio,
    creativeProfile,
    subjectSelectionNote,
    wardrobeDirective,
    preferredModel,
    alternateModel,
    resolution,
  },
  costMeta,
  apiKey,
) {
  console.log(`[Compositing] Combining identity + LOCKED product render + locked environment...`);
  const negativeText = "ABSOLUTELY NO TEXT, no watermark, no signage, no gallery credit, no caption, no logo anywhere in the image. Exactly ONE subject, never a duplicate or second person. This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame.";
  const productIsOutfit = !!creativeProfile?.productWornAsOutfit;
  const wardrobeInstruction = productIsOutfit
    ? `WARDROBE: the product from image 2 IS the outfit for this shot — a garment being sold, not an accessory. Dress the person in it as their primary visible clothing, fully replacing whatever they happen to be wearing in image 1 (image 1's clothing is a neutral placeholder only — never preserve or reference it). ${wardrobeDirective ? `Styling/accessorizing direction for this shot: ${wardrobeDirective}` : ""} The result must be modest and fully appropriate — cover the body the way the product actually would when correctly worn, per the product lock instructions below (including any required base layer/undergarment).`
    : wardrobeDirective
      ? `WARDROBE: do NOT copy whatever the person happens to be wearing in image 1 — that is irrelevant here. Instead, style their wardrobe for THIS shot according to: ${wardrobeDirective}`
      : `WARDROBE: preserve the person's exact wardrobe from image 1 unchanged — same garment, same color, same cut, same fabric.`;
  const compositePrompt = `You are given two images: the FIRST is a person, the SECOND is the product (already a precise, correct reference — treat it as ground truth, not raw material to reinterpret). Composite the exact product from image 2 onto the person in image 1, physically correct and photorealistic.
${creativeProfile?.humanInclusionApproach || ""}
${subjectSelectionNote || ""}
IDENTITY (always locked, regardless of wardrobe): preserve the person's exact face, identity, body proportions, hairstyle, and skin tone from image 1 exactly.
PHOTOREALISM: this must read as a real photograph, not an illustration or a rendered/airbrushed look — keep natural skin texture, subtle asymmetry, and a genuine unposed expression from image 1 intact; do not smooth, idealize, or flatten the person's features while compositing. Avoid the common AI-generated look (waxy skin, glassy over-sharp eyes, unnaturally perfect symmetry).
UNIFIED CAMERA/GRAIN (critical for realism): apply ONE consistent camera grain, color grade, white balance, and light temperature across the ENTIRE frame — the person, the product, and the background must look like they were captured by the same camera in the same moment, not layered together from separate sources. Match the shadow direction and softness on the product to the light source implied by the person's existing lighting in image 1.
${wardrobeInstruction}
${buildProductLockClause(creativeProfile, { imageLabel: "image 2" })}
SET THE ENVIRONMENT: ${environment || "high-end minimalist studio, seamless neutral backdrop"}. This is the permanent location for the entire photoshoot — establish it clearly and deliberately now, since every subsequent shot in this campaign will be a different camera angle (and possibly different wardrobe) of this SAME fixed location, not a new one.
SCALE — READ THIS CAREFULLY, THIS HAS FAILED TWICE ALREADY: ${creativeProfile?.estimatedRealWorldSize ? `${creativeProfile.estimatedRealWorldSize}. Use that body-relative comparison directly — it tells you exactly how much of the person's height the product should occupy. An isolated product photo has no scale cues of its own; this comparison is the ONLY thing preventing the product from being rendered wildly oversized (spanning their full body) when it should be a modest accessory-scale object.` : `the product must sit at a physically plausible, real-world scale relative to the person's body — not oversized, not miniaturized.`}${productIsOutfit ? " (Scale guidance does not apply the same way for a worn outfit — fit it naturally to the body instead.)" : ""}
Add realistic contact shadows and lighting so the product looks physically integrated into the scene, not pasted on.
${negativeText}
FINAL SCALE CHECK before you finish: ${creativeProfile?.estimatedRealWorldSize && !productIsOutfit ? `re-confirm the product occupies only the portion of the person's height stated above (${creativeProfile.estimatedRealWorldSize}) — if it looks like it spans their full body, that is wrong, shrink it.` : "re-confirm the result looks physically natural and correctly proportioned."}`;
  return resilientFalImageGeneration(
    (model) => buildFalImageInput(compositePrompt, [lockedIdentityImage, lockedProductImage], { aspectRatio: aspectRatio || "1:1", resolution, modelId: model }).input,
    {
      preferredModel: endpointFor(preferredModel, true),
      alternateModel: endpointFor(alternateModel, true),
      apiKey,
      costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "lock-set" },
    },
  );
}

async function compositeProductSwap(
  { baseImage, lockedProductImage, itemClassification, aspectRatio, hasHuman = true, preferredModel, alternateModel, resolution },
  costMeta,
  apiKey,
) {
  console.log(`[Product Swap] Swapping the product on the locked base image...`);
  const swapPrompt = hasHuman
    ? `DIRECTOR'S NOTE: image 1 is an already-finished, correct photograph. image 2 is a DIFFERENT product that needs to replace the one in image 1. Your ONLY job is the product swap. You are NOT allowed to change anything else.
LOCKED — must remain pixel-faithful to image 1, never redrawn, never substituted: the person's exact face/identity, body proportions, hairstyle, skin tone, and expression. their exact pose, position, and camera framing. the background/location/environment, and its lighting. any other visible props or elements.
THE ONLY CHANGE: replace whatever product is shown in image 1 (worn, held, or used — whatever form it originally took) with the product shown in image 2, presented correctly and naturally in that SAME interaction and pose as image 1.
${buildProductLockClause(itemClassification, { imageLabel: "image 2" })}
${itemClassification?.humanInclusionApproach || ""}
Add realistic contact shadows, reflections, and (if worn/draped) fabric physics consistent with image 1's existing lighting direction, so the new product looks physically present in that exact scene, not pasted on.
ABSOLUTELY NO TEXT, no watermark, no signage, no gallery credit, no caption, no logo anywhere in the image. Exactly ONE subject, never a duplicate or second person. This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame.`
    : `DIRECTOR'S NOTE: image 1 is an already-finished, correct product photograph. image 2 is a DIFFERENT product that needs to replace the one in image 1. Your ONLY job is the product swap. You are NOT allowed to change anything else.
LOCKED — must remain pixel-faithful to image 1, never redrawn, never substituted: the background/location/environment and its lighting, any props/staging/surfaces visible, and the overall camera framing/composition.
THE ONLY CHANGE: replace the product shown in image 1 with the product shown in image 2, staged naturally in the same position/composition.
${buildProductLockClause(itemClassification, { imageLabel: "image 2" })}
${itemClassification?.productOnlyDirection || ""}
Add realistic contact shadows and reflections consistent with image 1's existing lighting direction, so the new product looks physically present in that exact scene, not pasted on.
ABSOLUTELY NO TEXT, no watermark, no signage, no gallery credit, no caption, no logo anywhere in the image. This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame.`;
  return resilientFalImageGeneration(
    (model) => buildFalImageInput(swapPrompt, [baseImage, lockedProductImage], { aspectRatio: aspectRatio || "1:1", resolution, modelId: model }).input,
    {
      preferredModel: endpointFor(preferredModel, true),
      alternateModel: endpointFor(alternateModel, true),
      apiKey,
      costMeta: { ...costMeta, endpoint: costMeta?.endpoint || "batch-product-swap" },
    },
  );
}

async function buildLockedSet(
  {
    lockedProductImage,
    modelReferenceBase64,
    environment,
    aspectRatio,
    creativeProfile,
    seedIdentity,
    subjectSelectionNote,
    preResolvedIdentity,
    wardrobeDirective,
    preferredModel,
    alternateModel,
    resolution,
  },
  costMeta,
  apiKey,
) {
  let lockedIdentityImage = null;
  let fallbackReason = null;
  const modelNotes = [];
  if (modelReferenceBase64) {
    lockedIdentityImage = modelReferenceBase64;
  } else if (preResolvedIdentity) {
    lockedIdentityImage = preResolvedIdentity.image;
    if (preResolvedIdentity.usedFallback) modelNotes.push(preResolvedIdentity.fallbackReason);
  } else {
    try {
      const identityResult = await generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution });
      lockedIdentityImage = identityResult.image;
      if (identityResult.usedFallback) modelNotes.push(identityResult.fallbackReason);
    } catch (seedErr) {
      return { lockedSetImage: null, lockedIdentityImage: null, fallbackReason: `Seed identity generation failed: ${seedErr.message}` };
    }
  }
  try {
    const compositeResult = await compositeIdentityWithProduct(
      { lockedIdentityImage, lockedProductImage, environment, aspectRatio, creativeProfile, subjectSelectionNote, wardrobeDirective, preferredModel, alternateModel, resolution },
      costMeta,
      apiKey,
    );
    if (compositeResult.usedFallback) modelNotes.push(compositeResult.fallbackReason);
    return { lockedSetImage: compositeResult.image, lockedIdentityImage, fallbackReason: modelNotes.join(" ") || null, usedSyntheticFallback: false };
  } catch (compositeErr) {
    if (modelReferenceBase64) {
      console.warn(`[Compositing] Failed with the real reference photo (${compositeErr.message}) — auto-falling back to a synthetic identity instead of failing the batch.`);
      try {
        const syntheticIdentityResult = await generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution });
        if (syntheticIdentityResult.usedFallback) modelNotes.push(syntheticIdentityResult.fallbackReason);
        const compositeResult = await compositeIdentityWithProduct(
          { lockedIdentityImage: syntheticIdentityResult.image, lockedProductImage, environment, aspectRatio, creativeProfile, subjectSelectionNote, wardrobeDirective, preferredModel, alternateModel, resolution },
          costMeta,
          apiKey,
        );
        if (compositeResult.usedFallback) modelNotes.push(compositeResult.fallbackReason);
        return {
          lockedSetImage: compositeResult.image,
          lockedIdentityImage: syntheticIdentityResult.image,
          fallbackReason: [`Your reference photo failed compositing (${compositeErr.message}), so this batch used an AI-generated identity instead — the face will NOT match your uploaded photo.`, ...modelNotes].join(" "),
          usedSyntheticFallback: true,
        };
      } catch (fallbackErr) {
        fallbackReason = `Both the real reference photo AND the synthetic-identity fallback failed. Real photo: ${compositeErr.message}. Fallback: ${fallbackErr.message}`;
        return { lockedSetImage: null, lockedIdentityImage: null, fallbackReason, usedSyntheticFallback: false };
      }
    }
    fallbackReason = `Compositing failed even after trying a backup model: ${compositeErr.message}`;
    return { lockedSetImage: null, lockedIdentityImage: null, fallbackReason, usedSyntheticFallback: false };
  }
}

async function resolveLookReference({ modelReferenceBase64, seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution }) {
  if (modelReferenceBase64) return { image: modelReferenceBase64, generated: false };
  const identityResult = await generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution });
  return { image: identityResult.image, generated: true, usedFallback: identityResult.usedFallback, fallbackReason: identityResult.fallbackReason };
}

// ============================================================
// ROUTES
// ============================================================
app.post("/api/generate-text", async (req, res) => {
  let runId;
  try {
    const {
      brandName,
      productDescription,
      usageContext,
      aspectRatio,
      productDimensions,
      humanFrameCount,
      nonHumanFrameCount,
      hasModelReference,
      modelAppearance,
      modelExpression,
      modelWardrobe,
      modelPose,
      modelBodyType,
      poseFreedom,
      negativeDirectives,
      creativeDirection,
      lockWardrobe,
      lockBackground,
      wardrobeVarietyMode,
      matchReferenceOutfit,
      autoBalanceMix,
      brandProfile,
      userApiKey,
      textModel,
      productImageBase64,
      runId: clientRunId,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    const effectiveTextModel = textModel || DEFAULT_TEXT_MODEL;
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "moderating", "Checking your brief for anything that needs softening...");
    const humanCount = Math.max(0, Math.min(parseInt(humanFrameCount) || 0, MAX_TOTAL_FRAMES));
    const nonHumanCount = Math.max(0, Math.min(parseInt(nonHumanFrameCount) || 0, MAX_TOTAL_FRAMES));
    const count = Math.min(humanCount + nonHumanCount, MAX_TOTAL_FRAMES);
    if (count < 1) return res.status(400).json({ error: "Request at least one frame (With Human + Product Only)." });
    let moderation;
    try {
      moderation = await moderateCreativeInputs(
        { productDescription, usageContext, creativeDirection, negativeDirectives, modelAppearance, modelExpression, modelWardrobe, modelPose },
        { apiKey, textModel: effectiveTextModel, costMeta: { runId } },
      );
    } catch (modErr) {
      console.warn(`[Moderation] Pre-check failed (${modErr.message}) — proceeding without softening.`);
      moderation = { blocked: false, flaggedFields: [], softenedFields: {} };
    }
    if (moderation.blocked) {
      return res.status(403).json({ error: moderation.blockedReason || "This request can't be fulfilled as described." });
    }
    progress.updateProgress(runId, "writing", "Writing captions, tags, and per-frame shot descriptions...");
    const softened = moderation.softenedFields || {};
    const safeProductDescription = softened.productDescription || productDescription;
    const safeCreativeDirection = softened.creativeDirection || creativeDirection;
    const safeNegativeDirectives = softened.negativeDirectives || negativeDirectives;
    const safeModelAppearance = softened.modelAppearance || modelAppearance;
    const safeModelExpression = softened.modelExpression || modelExpression;
    const safeModelWardrobe = softened.modelWardrobe || modelWardrobe;
    const safeModelPose = softened.modelPose || modelPose;
    const safeUsageContext = softened.usageContext || usageContext;
    let wardrobeConstraint;
    if (lockWardrobe) {
      wardrobeConstraint = "Wardrobe must be IDENTICAL across every human frame, no variation — describe the exact same garment in every frame's imagePrompt.";
    } else if (matchReferenceOutfit && hasModelReference) {
      wardrobeConstraint = "Wardrobe should match whatever outfit appears in the uploaded reference photo, identically across every frame — the user explicitly asked to preserve the reference photo's actual clothing.";
    } else if (wardrobeVarietyMode === "independent") {
      wardrobeConstraint = "Wardrobe should be styled FRESH for each individual human frame, specific to that shot's composition — each frame's imagePrompt must describe its OWN distinct outfit.";
    } else {
      wardrobeConstraint = "Wardrobe should vary across frames while keeping a cohesive campaign feel — same color palette and styling sensibility, just not the identical outfit every time.";
    }
    const usageConstraint = safeUsageContext
      ? `REAL-WORLD USAGE CONTEXT (weight this heavily): ${safeUsageContext}. Any human's pose/action must make sense given this. If the Pose & Interaction field below conflicts with this context, prioritize plausibility from this usage context.`
      : "";
    const humanDetailsBlock = `Target Profile: ${safeModelAppearance || "Brand-appropriate, decide freely"}. Body type/build: ${modelBodyType || "natural, realistic proportions — avoid an unrealistically thin idealized frame"}. Vibe: ${safeModelExpression || "decide what fits the brand"}. Base wardrobe direction: ${safeModelWardrobe || "decide what fits the brand"}. Pose: ${safeModelPose || "decide what fits the brief"}. ${buildPoseFreedomConstraint(poseFreedom)} ${usageConstraint} CRITICAL: Lock ONE consistent FACE/BODY/IDENTITY description reused across every human frame regardless of wardrobe. WARDROBE RULE: ${wardrobeConstraint}`;
    const humanConstraint = autoBalanceMix
      ? `IF you include human frames (see SHOT MIX below): ${humanDetailsBlock}`
      : humanCount > 0
        ? `The user WANTS ${humanCount} of the ${count} frames to include a human model. ${humanDetailsBlock}`
        : "";
    const productOnlyConstraint = autoBalanceMix
      ? `IF you include product-only frames (see SHOT MIX below): NO humans, NO people, NO faces, NO hands — pure product photography.`
      : nonHumanCount > 0
        ? `The user WANTS ${nonHumanCount} of the ${count} frames to be pure product-only shots — NO humans, NO people, NO faces, NO hands.`
        : "";
    const backgroundConstraint = lockBackground
      ? "The background/environment/location must be IDENTICAL across every single frame in this batch."
      : "The environment may vary slightly between frames if it serves the shot, but should feel like one cohesive campaign.";
    const dimensionsBlock =
      productDimensions && productDimensions.trim()
        ? `USER-PROVIDED DIMENSIONS (AUTHORITATIVE — do not estimate from the photo): ${productDimensions.trim()}. Translate this into a direct visual comparison against an average adult body (~5'6"/168cm). Record as "estimatedRealWorldSize" and set "dimensionsSource" to "user-provided".`
        : `estimate the product's actual physical dimensions using whatever's visible for scale in the source photo. State concrete numbers, then translate into a body-relative comparison. Record as "estimatedRealWorldSize" and set "dimensionsSource" to "ai-estimated".`;
    const promptText = `You are simulating a full award-winning creative agency, acting as both art director AND safety reviewer for this shoot.
${SAFETY_PRINCIPLES}
This tool must work for ANY product ever sold. There is no fixed category list: decide the appropriate creative and safety treatment fresh, from first principles, every time.
CAMPAIGN BRIEF:
Brand: ${brandName}
Product: ${safeProductDescription}
${buildBrandContextBlock(brandProfile)}${safeUsageContext ? `Where/how this product is actually used: ${safeUsageContext}` : ""}
Creative direction from the user: ${safeCreativeDirection || "No specific direction given — use your best creative judgment."}
Aspect Ratio: ${aspectRatio}
STRICT EXCLUSIONS: ${safeNegativeDirectives || "None"}
SHOT MIX: ${
  autoBalanceMix
    ? `${count} total frames. You are acting as a professional creative photographer planning this shoot — decide the optimal split between human-inclusive and product-only frames yourself, based on what would actually best showcase THIS specific product (its category, how buyers expect to see it, whether human context adds real value or is just noise). Some products sell better shown worn/held/in-use by a person; others (fine detail work, home objects, components) sell better as clean, varied product-only compositions. Record your decision as "recommendedHumanFrameCount" and "recommendedNonHumanFrameCount" in the classification (must sum to exactly ${count}), and make promptTypes match that split exactly.`
    : `(must match EXACTLY): ${humanCount} human frame(s), ${nonHumanCount} product-only frame(s), ${count} total.`
}
${humanConstraint}
${productOnlyConstraint}
${backgroundConstraint}
PRODUCT SCOPE: set "productScope" to "component" if the brand's real product is only PART of what's shown, or "wholeItem" otherwise. If "component", describe ONLY the actual manufactured part in "componentDescription".
REAL-WORLD SIZE ESTIMATE: ${dimensionsBlock}
PRODUCT MATERIAL GROUNDING: identify the ACTUAL material/finish/color of the item. Record as "actualProductMaterials".
WEAR/USE BEHAVIOR: does the item's photographed shape match its worn/in-use shape? Set "silhouetteLockAppropriate" accordingly (true for most fitted apparel/accessories, false for draped/wrapped/unstitched items like sarees, dupattas, shawls). If false, write "wearInstructions" and, if applicable, "zonedPatternDescription".
BASE LAYER: would a complete depiction of this item worn require a visible undergarment (e.g. a saree needs a blouse)? Set "requiresVisibleBaseLayer" and "baseLayerDescription" accordingly, independently of the silhouette question above.
PRODUCT WORN AS OUTFIT (a separate question — don't infer from the above): is this product itself the primary garment/outfit a person would wear (a dress, top, shirt, saree, jacket, full outfit), as opposed to something worn/held/used ALONGSIDE separate clothing (jewelry, a bag, a watch, standalone shoes, home decor, cosmetics, electronics)? Set "productWornAsOutfit" to true for the former, false for the latter — this determines whether the model gets fully dressed in the product or shown with their own styling plus the product added. CRITICAL — this is NOT optional or a matter of your discretion once true: if "productWornAsOutfit" is true, every human-frame imagePrompt for this product MUST describe the model actually wearing it as the visual focus of the scene — never held, never laid out nearby, never implied via a separate garment (e.g. a robe) instead. This requirement holds REGARDLESS of "identityLockSafe" — that flag only controls how precisely/pixel-locked the compositing is, never whether she is shown wearing the product. Do not default to a safer-feeling "product visible nearby" framing when the flag is true; that is a wrong answer, not a cautious one.
Generate exactly ${count} highly technical imagePrompts incorporating physical material and lighting logic, AND a parallel "promptTypes" array of the same length where each entry is exactly "human" or "product" — must contain EXACTLY ${humanCount} "human" entries and ${nonHumanCount} "product" entries, index-matched. Write each prompt like you're describing THIS specific photo, not assembling stock phrases — name the product's actual color/pattern/texture rather than generic words like "elegant" or "luxurious" that could describe anything; one concrete sensory detail beats three stacked adjectives, and not every prompt needs the same sentence rhythm.
Also assess "modelTierRecommendation": "pro" or "lite" for identity+product compositing. Default to "lite" — it's meaningfully cheaper and handles the large majority of products well, including most jewelry, apparel, and premium/luxury goods. Recommend "pro" ONLY when the product visibly has fine repeating pattern/texture detail that a lower-fidelity render would visibly blur, smear, or simplify wrong — e.g. dense embroidery, a fine jaal/lattice weave, small repeating jewelry filigree, or an intricate border pattern where the repeat count and spacing must stay exact. A product simply being expensive, premium-branded, or "important" is NOT a reason on its own — judge the actual visual complexity of the product photo, not its price tier. "Not sure" or "can't tell" defaults to "lite", not "pro".
Return STRICT JSON ONLY, no markdown fences, matching this exact shape:
{
  "captions": ["..."],
  "tags": ["#..."],
  "imagePrompts": ["...exactly ${count} strings..."],
  "promptTypes": ["...exactly ${count} entries, each 'human' or 'product'..."],
  "classification": {
    "productLabel": "free-text description",
    "productScope": "wholeItem",
    "componentDescription": null,
    "estimatedRealWorldSize": "concrete size + body-relative comparison",
    "dimensionsSource": "user-provided or ai-estimated",
    "actualProductMaterials": "...",
    "silhouetteLockAppropriate": true,
    "wearBehaviorReasoning": "...",
    "wearInstructions": null,
    "zonedPatternDescription": null,
    "requiresVisibleBaseLayer": false,
    "baseLayerDescription": null,
    "productWornAsOutfit": false,
    "confidenceScore": 0,
    "reasoning": "...",
    "identityLockSafe": true,
    "humanInclusionApproach": "...",
    "productOnlyDirection": "...",
    "sensitivityNotes": "none",
    "blocked": false,
    "blockedReason": null,
    "shotSequenceHint": ["hero","macro","context","editorial"],
    "modelTierRecommendation": "lite",
    "modelTierReasoning": "...",
    "recommendedHumanFrameCount": ${autoBalanceMix ? `"<the human-frame count you decided on>"` : humanCount},
    "recommendedNonHumanFrameCount": ${autoBalanceMix ? `"<the product-only count you decided on, summing with the above to ${count}>"` : nonHumanCount}
  },
  "seedIdentity": "...or null if a reference photo was provided",
  "toneOfVoice": "...",
  "environment": "...",
  "propsAndStaging": "...",
  "wardrobeConsistencyNote": "...",
  "lightingStrategy": "...",
  "physicalStaging": "...",
  "injectedDirectives": "..."
}`;
    const response = await falTextRequest(promptText, {
      model: effectiveTextModel,
      apiKey,
      temperature: 0.7,
      imageDataUri: productImageBase64 || null,
      costMeta: { runId, endpoint: "generate-text", imageCount: productImageBase64 ? 1 : 0 },
    });
    progress.updateProgress(runId, "parsing", "Parsing the creative profile and shot list...");
    const rawText = response.text;
    const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    if (parsed.classification?.blocked) {
      return res.status(403).json({ error: parsed.classification.blockedReason || "This request can't be fulfilled as described." });
    }
    if (parsed.classification && typeof parsed.classification.confidenceScore === "number") {
      const score = parsed.classification.confidenceScore;
      if (score > 0 && score <= 1) parsed.classification.confidenceScore = Math.round(score * 100);
      parsed.classification.confidenceScore = Math.max(0, Math.min(100, parsed.classification.confidenceScore));
    }
    if (parsed.classification && productDimensions && productDimensions.trim()) {
      parsed.classification.dimensionsSource = "user-provided";
    } else if (parsed.classification && !parsed.classification.dimensionsSource) {
      parsed.classification.dimensionsSource = "ai-estimated";
    }
    if (parsed.classification && typeof parsed.classification.silhouetteLockAppropriate !== "boolean") parsed.classification.silhouetteLockAppropriate = true;
    if (parsed.classification && typeof parsed.classification.productWornAsOutfit !== "boolean") parsed.classification.productWornAsOutfit = false;
    if (parsed.classification) enforceIntimateSensitiveSafety(parsed.classification, `${safeProductDescription} ${parsed.classification.productLabel || ""}`);
    const returnedTypes = Array.isArray(parsed.promptTypes) ? parsed.promptTypes : [];
    const humanReturned = returnedTypes.filter((t) => t === "human").length;
    const productReturned = returnedTypes.filter((t) => t === "product").length;
    const typesValid = autoBalanceMix
      ? returnedTypes.length === parsed.imagePrompts?.length && humanReturned + productReturned === count
      : returnedTypes.length === parsed.imagePrompts?.length && humanReturned === humanCount && productReturned === nonHumanCount;
    if (!typesValid) {
      const fallbackHuman = autoBalanceMix ? Math.ceil(count / 2) : humanCount;
      parsed.promptTypes = (parsed.imagePrompts || []).map((_, i) => (i < fallbackHuman ? "human" : "product"));
    }
    if (parsed.classification) {
      const finalHumanCount = parsed.promptTypes.filter((t) => t === "human").length;
      parsed.classification.recommendedHumanFrameCount = finalHumanCount;
      parsed.classification.recommendedNonHumanFrameCount = parsed.promptTypes.length - finalHumanCount;
    }
    progress.updateProgress(runId, "reviewing", "Reviewing the generated shots for anything that crossed the line...");
    let outputModerationNote = null;
    try {
      const outputCheck = await moderateGeneratedPrompts(
        { imagePrompts: parsed.imagePrompts, promptTypes: parsed.promptTypes, productLabel: parsed.classification?.productLabel },
        { apiKey, textModel: effectiveTextModel, costMeta: { runId } },
      );
      if (outputCheck.flaggedIndices.length) {
        parsed.imagePrompts = outputCheck.imagePrompts;
        outputModerationNote = `${outputCheck.flaggedIndices.length} generated shot(s) were rewritten to remove implied content that crossed the line.`;
      }
    } catch (outputModErr) {
      console.warn(`[Output Moderation] Check failed: ${outputModErr.message}`);
    }
    parsed.runId = runId;
    parsed.moderationNote =
      [
        moderation.flaggedFields?.length ? `Some of your input was adjusted to keep things tasteful: ${moderation.flaggedFields.join(", ")}.` : null,
        outputModerationNote,
      ]
        .filter(Boolean)
        .join(" ") || null;
    try {
      db.saveCampaign({
        runId,
        brandName,
        productDescription: safeProductDescription,
        creativeDirection: safeCreativeDirection,
        environment: parsed.environment,
        seedIdentity: parsed.seedIdentity,
        classification: parsed.classification,
        imagePrompts: parsed.imagePrompts,
        promptTypes: parsed.promptTypes,
      });
    } catch (saveErr) {
      console.warn(`[Campaigns] Failed to save campaign ${runId}: ${saveErr.message}`);
    }
    progress.finishProgress(runId);
    res.json(parsed);
  } catch (error) {
    console.error("Art Director error:", error);
    progress.failProgress(runId, error.message);
    const status = error.status || error.response?.status;
    if (status === 429)
      return res.status(429).json({ error: "Fal's rate limit was hit. Wait a bit and retry, or check your usage at https://fal.ai/dashboard/billing." });
    res.status(500).json({ error: "Failed to generate campaign data: " + error.message });
  }
});

app.post("/api/analyze-reference", async (req, res) => {
  try {
    const { modelReferenceBase64, productDescription, creativeDirection, userApiKey, visionModel, runId: clientRunId } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!modelReferenceBase64) return res.status(400).json({ error: "Missing reference photo." });
    // This runs BEFORE generate-text mints the shoot's own run_id (it
    // happens right when the reference photo is uploaded, earlier in the
    // form) — minted here instead and returned so the frontend can carry
    // it forward into generate-text, so this check's cost lands under the
    // same shoot instead of as an orphaned row.
    const runId = clientRunId || crypto.randomUUID();
    const prompt = `Look at this photo of one or more people. Product context: "${productDescription || "unspecified"}". Creative direction: "${creativeDirection || "unspecified"}".
Count the distinct people visible. For each, give a short position-based label and a brief neutral visual description.
Recommend which person is the most likely intended subject, with a one-sentence reason.
Separately: note whether the recommended subject is wearing minimal/revealing clothing (underwear, swimwear, or similar) in this photo.
Return STRICT JSON ONLY, no markdown fences:
{
  "peopleCount": 0,
  "people": [{"id": 0, "label": "...", "description": "..."}],
  "recommendedId": 0,
  "reasoning": "...",
  "minimalClothingWarning": false,
  "minimalClothingNote": null
}`;
    const response = await falVisionRequest(prompt, modelReferenceBase64, {
      model: visionModel || DEFAULT_VISION_MODEL,
      apiKey,
      costMeta: { runId, endpoint: "analyze-reference", imageCount: 1 },
    });
    const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    res.json({ ...parsed, runId });
  } catch (error) {
    console.error("Reference analysis error:", error);
    res.status(500).json({ error: "Failed to analyze reference photo: " + error.message });
  }
});

app.post("/api/lock-set", async (req, res) => {
  try {
    const {
      productImage,
      modelReferenceBase64: rawModelReferenceBase64,
      sanitizedReferenceImage: incomingSanitizedReference,
      environment,
      aspectRatio,
      classification,
      seedIdentity,
      subjectSelectionNote,
      userApiKey,
      runId,
      lockWardrobe,
      matchReferenceOutfit,
      imageModel,
      modelTier,
      imageResolution,
      skipCanonicalRender,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!productImage) return res.status(400).json({ error: "Missing product image." });
    if (classification?.blocked) return res.status(403).json({ error: classification.blockedReason || "Restricted request." });
    const costMeta = { runId, endpoint: "lock-set" };
    const { preferred: preferredModel, alternate: alternateModel } = resolveImageModels(classification, imageModel, modelTier);
    const resolution = imageResolution || DEFAULT_IMAGE_RESOLUTION;
    progress.startProgress(runId, "product-render", `Rendering the canonical product photo (${preferredModel})...`);
    let modelReferenceBase64 = matchReferenceOutfit ? rawModelReferenceBase64 || null : incomingSanitizedReference || null;
    const needsSanitize = !!rawModelReferenceBase64 && !incomingSanitizedReference && !matchReferenceOutfit;
    const needsIdentity = !rawModelReferenceBase64;
    const cleanProductBase64 = productImage.replace(/^data:image\/\w+;base64,/, "");
    const [productSettled, identitySettled, sanitizeSettled] = await Promise.allSettled([
      generateLockedProductRender(cleanProductBase64, costMeta, {
        apiKey,
        preferredModel,
        alternateModel,
        resolution,
        productScope: classification?.productScope,
        componentDescription: classification?.componentDescription,
        estimatedRealWorldSize: classification?.estimatedRealWorldSize,
        skipRerender: skipCanonicalRender,
      }),
      needsIdentity ? generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution }) : Promise.resolve(null),
      needsSanitize
        ? generateNeutralIdentityPortrait(rawModelReferenceBase64, subjectSelectionNote, costMeta, { apiKey, preferredModel, alternateModel, resolution })
        : Promise.resolve(null),
    ]);
    let sanitizeNote = null;
    if (needsSanitize) {
      if (sanitizeSettled.status === "fulfilled") {
        modelReferenceBase64 = sanitizeSettled.value.image;
        if (sanitizeSettled.value.usedFallback) sanitizeNote = sanitizeSettled.value.fallbackReason;
      } else {
        modelReferenceBase64 = null;
        sanitizeNote = `Your reference photo couldn't be processed safely (${sanitizeSettled.reason.message}), so this batch used a fully synthetic identity instead.`;
      }
    }
    if (productSettled.status === "rejected") {
      return res.status(500).json({ error: `Failed to generate the locked product render: ${productSettled.reason.message}` });
    }
    const lockedProductImage = productSettled.value.image;
    let productModelNote = productSettled.value.usedFallback ? productSettled.value.fallbackReason : null;
    let preResolvedIdentity = null;
    let identityModelNote = null;
    if (needsIdentity) {
      if (identitySettled.status === "fulfilled") {
        preResolvedIdentity = identitySettled.value;
        identityModelNote = preResolvedIdentity.usedFallback ? preResolvedIdentity.fallbackReason : null;
      }
    }
    if (!classification?.identityLockSafe) {
      let lockedLookReference = modelReferenceBase64 || (preResolvedIdentity ? preResolvedIdentity.image : null);
      let lookReferenceNote = identityModelNote;
      if (!lockedLookReference) {
        try {
          const lookResult = await resolveLookReference({ modelReferenceBase64, seedIdentity, environment }, costMeta, { apiKey, preferredModel, alternateModel, resolution });
          if (lookResult.generated) {
            lockedLookReference = lookResult.image;
            if (lookResult.usedFallback) lookReferenceNote = lookResult.fallbackReason;
          }
        } catch (lookErr) {
          console.warn(`[Lock-Set] Could not build a synthetic look reference: ${lookErr.message}`);
        }
      }
      progress.finishProgress(runId);
      return res.json({
        lockedSetImage: null,
        lockedProductImage,
        lockedLookReference,
        sanitizedReferenceImage: needsSanitize ? modelReferenceBase64 : incomingSanitizedReference || null,
        skipped: true,
        reason: [
          `This product routes humans through narrative composition, not identity-locked compositing. The product itself is still locked and will be reused across all frames.${lockedLookReference ? " A consistent look reference was also generated." : ""}`,
          productModelNote,
          lookReferenceNote,
          sanitizeNote,
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
    const wardrobeDirective =
      matchReferenceOutfit && modelReferenceBase64
        ? null
        : lockWardrobe
          ? null
          : "a tasteful, brand-appropriate look for a representative preview shot — the actual per-frame wardrobe will vary in the final batch";
    progress.updateProgress(runId, "compositing", "Compositing identity + product + environment into the locked set...");
    const { lockedSetImage, lockedIdentityImage, fallbackReason } = await buildLockedSet(
      {
        lockedProductImage,
        modelReferenceBase64,
        environment,
        aspectRatio,
        creativeProfile: classification,
        seedIdentity,
        subjectSelectionNote,
        preResolvedIdentity,
        wardrobeDirective,
        preferredModel,
        alternateModel,
        resolution,
      },
      costMeta,
      apiKey,
    );
    if (!lockedSetImage) {
      progress.failProgress(runId, fallbackReason || "Failed to build the locked set.");
      return res.status(500).json({ error: fallbackReason || "Failed to build the locked set." });
    }
    progress.finishProgress(runId);
    res.json({
      lockedSetImage,
      lockedProductImage,
      lockedIdentityImage,
      sanitizedReferenceImage: needsSanitize ? modelReferenceBase64 : incomingSanitizedReference || null,
      wardrobeLocked: !!lockWardrobe,
      modelUsed: preferredModel,
      diagnostics: {
        fallbackReason:
          [
            productModelNote,
            identityModelNote,
            fallbackReason,
            sanitizeNote,
            !lockWardrobe ? "Preview shows ONE representative look — wardrobe will vary per frame in the final batch." : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
      },
    });
  } catch (error) {
    console.error("Lock-set error:", error);
    progress.failProgress(req.body?.runId, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate-images", async (req, res) => {
  const routeStartedAt = Date.now();
  try {
    const {
      productImage,
      modelReferenceBase64: rawModelReferenceBase64,
      finalPrompts,
      promptTypes,
      frameModels,
      lockedSetImage: incomingLockedSet,
      lockedProductImage: incomingLockedProduct,
      lockedLookReference: incomingLookReference,
      lockedIdentityImage: incomingIdentityImage,
      sanitizedReferenceImage: incomingSanitizedReference,
      aspectRatio,
      negativeDirectives,
      userApiKey,
      classification,
      seedIdentity,
      environment,
      subjectSelectionNote,
      runId,
      lockWardrobe,
      matchReferenceOutfit,
      imageModel,
      modelTier,
      imageResolution,
      seed,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!finalPrompts || !Array.isArray(finalPrompts)) return res.status(400).json({ error: "No prompts provided." });
    if (classification?.blocked) return res.status(403).json({ error: classification.blockedReason || "Restricted request." });
    const costMeta = { runId, endpoint: "generate-images" };
    const { preferred: rawPreferredModel, alternate: globalAlternateModel } = resolveImageModels(classification, imageModel, modelTier);
    // Phase 12 / Section 22 — automatic replacement if the resolved
    // model has genuinely gone deprecated, not just "missing" (that
    // distinction is deliberate and matters here exactly like it does
    // everywhere else in this app's catalog logic).
    const { resolvedModelId: globalPreferredModel, replacementNote } = resolveModelOrReplacement(rawPreferredModel, { resolution: imageResolution, seed });
    if (replacementNote) console.warn(`[Model Replacement] ${replacementNote}`);
    const resolution = imageResolution || DEFAULT_IMAGE_RESOLUTION;
    // Real, confirmed capability (Fal's own API reference for Nano Banana
    // Pro/2) genuinely relevant to this app's whole mission: reusing the
    // same seed across a shoot's frames is a real lever for tighter
    // consistency, on top of identity-lock/reference images. Only sent
    // for models confirmed to support it (see buildFalImageInput) —
    // silently ignored/omitted otherwise, same safety pattern as
    // resolution above.
    const resolvedSeed = seed != null && seed !== "" ? parseInt(seed) : null;
    progress.startProgress(runId, "preparing", `Preparing to render ${finalPrompts.length} frame(s)...`);
    let modelReferenceBase64 = matchReferenceOutfit ? rawModelReferenceBase64 || null : incomingSanitizedReference || null;
    if (!modelReferenceBase64 && rawModelReferenceBase64 && !matchReferenceOutfit) {
      progress.updateProgress(runId, "sanitizing-reference", "Preparing a neutral-wardrobe identity portrait from your reference photo...");
      try {
        const sanitizeResult = await generateNeutralIdentityPortrait(rawModelReferenceBase64, subjectSelectionNote, costMeta, {
          apiKey,
          preferredModel: globalPreferredModel,
          alternateModel: globalAlternateModel,
          resolution,
        });
        modelReferenceBase64 = sanitizeResult.image;
      } catch (sanitizeErr) {
        modelReferenceBase64 = null;
      }
    }
    const creativeProfile = classification || {};
    const identityLockSafe = !!creativeProfile.identityLockSafe;
    const types = Array.isArray(promptTypes) && promptTypes.length === finalPrompts.length ? promptTypes : finalPrompts.map(() => "product");
    const isAnatomicalFrameArray = types.map((t) => t === "human" && identityLockSafe);
    const wantsHumanArray = types.map((t) => t === "human");
    const anyAnatomicalFrames = isAnatomicalFrameArray.some(Boolean);
    const anyNonAnatomicalHumanFrames = wantsHumanArray.some((wantsHuman, i) => wantsHuman && !isAnatomicalFrameArray[i]);
    const totalAnatomicalFrames = isAnatomicalFrameArray.filter(Boolean).length;
    const needsFreshProduct = !incomingLockedProduct && !!productImage;
    const needsFreshIdentity = !modelReferenceBase64 && !incomingLookReference && !incomingLockedSet && (anyAnatomicalFrames || anyNonAnatomicalHumanFrames);
    let lockedProductImage = incomingLockedProduct || null;
    let productModelNote = null;
    let preResolvedIdentity = null;
    if (needsFreshProduct || needsFreshIdentity) {
      const cleanProductBase64 = needsFreshProduct ? productImage.replace(/^data:image\/\w+;base64,/, "") : null;
      const [productSettled, identitySettled] = await Promise.allSettled([
        needsFreshProduct
          ? generateLockedProductRender(cleanProductBase64, costMeta, {
              apiKey,
              preferredModel: globalPreferredModel,
              alternateModel: globalAlternateModel,
              resolution,
              productScope: creativeProfile?.productScope,
              componentDescription: creativeProfile?.componentDescription,
              estimatedRealWorldSize: creativeProfile?.estimatedRealWorldSize,
            })
          : Promise.resolve(null),
        needsFreshIdentity
          ? generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel: globalPreferredModel, alternateModel: globalAlternateModel, resolution })
          : Promise.resolve(null),
      ]);
      if (needsFreshProduct) {
        if (productSettled.status === "fulfilled") {
          lockedProductImage = productSettled.value.image;
          if (productSettled.value.usedFallback) productModelNote = productSettled.value.fallbackReason;
        }
      }
      if (needsFreshIdentity && identitySettled.status === "fulfilled") preResolvedIdentity = identitySettled.value;
    }
    const productReferenceForFrames = lockedProductImage || productImage;
    const shotProfiles = buildShotProfilesForTypes(finalPrompts.length, creativeProfile, wantsHumanArray);
    let heroFrameUsingLockedSetIndex = -1;
    if (lockWardrobe) {
      for (let i = 0; i < shotProfiles.length; i++) {
        if (isAnatomicalFrameArray[i] && shotProfiles[i].shotType === "hero") {
          heroFrameUsingLockedSetIndex = i;
          break;
        }
      }
    }
    let outputImageUrls = [];
    const frameErrors = [];
    const negativeText = negativeDirectives ? `Also avoid: ${negativeDirectives}.` : "";
    let lookReference = incomingLookReference || modelReferenceBase64 || (preResolvedIdentity ? preResolvedIdentity.image : null);
    let lookReferenceNote = preResolvedIdentity?.usedFallback ? preResolvedIdentity.fallbackReason : null;
    if (anyNonAnatomicalHumanFrames && !lookReference) {
      try {
        const lookResult = await resolveLookReference({ modelReferenceBase64, seedIdentity, environment }, costMeta, {
          apiKey,
          preferredModel: globalPreferredModel,
          alternateModel: globalAlternateModel,
          resolution,
        });
        lookReference = lookResult.image;
        if (lookResult.usedFallback) lookReferenceNote = lookResult.fallbackReason;
      } catch (lookErr) {
        console.warn(`[Look Reference] Failed to build a consistency anchor: ${lookErr.message}`);
      }
    }
    const commonNegative = `NO fake overlay text, watermark, signage, gallery credit, caption, stock-photo credit, or studio stamp anywhere in the image. EXCEPTION: the product's own real, existing branding/logo must stay visible and accurate. Exactly ONE subject, never a duplicate or second person. This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame. ${negativeText}`;
    let compositedBase = incomingLockedSet || null;
    let identityImageForFrames = incomingIdentityImage || modelReferenceBase64 || (preResolvedIdentity ? preResolvedIdentity.image : null);
    let anatomicalFallbackReason = null;
    if (anyAnatomicalFrames && lockWardrobe && !compositedBase) {
      const result = await buildLockedSet(
        {
          lockedProductImage,
          modelReferenceBase64,
          environment,
          aspectRatio,
          creativeProfile,
          seedIdentity,
          subjectSelectionNote,
          preResolvedIdentity,
          preferredModel: globalPreferredModel,
          alternateModel: globalAlternateModel,
          resolution,
        },
        costMeta,
        apiKey,
      );
      compositedBase = result.lockedSetImage;
      identityImageForFrames = identityImageForFrames || result.lockedIdentityImage;
      anatomicalFallbackReason = result.fallbackReason;
    } else if (anyAnatomicalFrames && !lockWardrobe && !identityImageForFrames) {
      try {
        const identityResult = await generateSyntheticIdentity({ seedIdentity, environment }, costMeta, { apiKey, preferredModel: globalPreferredModel, alternateModel: globalAlternateModel, resolution });
        identityImageForFrames = identityResult.image;
        if (identityResult.usedFallback) anatomicalFallbackReason = identityResult.fallbackReason;
      } catch (identErr) {
        anatomicalFallbackReason = `Failed to resolve an identity reference for varying-wardrobe frames: ${identErr.message}`;
      }
    }
    const FRAME_CONCURRENCY = 3;
    async function processFrame(i, { forceProductOnly = false } = {}) {
      const profile = shotProfiles[i];
      const frameCostMeta = { ...costMeta, frameIndex: i };
      // Per-frame model override (from a per-setup-card dropdown in the UI)
      // takes priority over the global selection for this frame only.
      const framePreferredModel = frameModels?.[i] || globalPreferredModel;
      const frameAlternateModel = frameModels?.[i] ? globalPreferredModel : globalAlternateModel;
      if (!forceProductOnly && isAnatomicalFrameArray[i] && lockWardrobe && compositedBase) {
        if (i === heroFrameUsingLockedSetIndex) {
          console.log(`[Frame ${i + 1}] Reusing the approved locked set directly (hero shot) — zero extra cost for this frame.`);
          return { image: compositedBase, modelUsed: "locked-set-reuse" };
        }
        console.log(`[Frame ${i + 1}] Reframing (anatomical, wardrobe locked) via ${framePreferredModel} | Shot: ${profile.shotType}`);
        const reframePrompt = `DIRECTOR'S NOTE: the reference image is a fully built, locked set. You are the camera operator, not the set designer. Your ONLY job this shot is to move the camera: change the angle, distance, crop, framing, and lighting DIRECTION. You are NOT allowed to rebuild, redecorate, or reinterpret anything else.
LOCKED — must remain pixel-faithful to the reference image, never redrawn: the person's face/identity, natural expression. their EXACT wardrobe — same garment, color, cut, fabric. the background/location/environment. the product's material, silhouette, proportions, and mechanical construction.
CAMERA MOVE FOR THIS SHOT (the only thing that should change): ${profile.vibe}
SCENE DETAIL (informs camera work and lighting only — never grounds for changing the set): ${finalPrompts[i]}
${creativeProfile.lightingStrategy || ""}.
${commonNegative}`;
        const reframeResult = await resilientFalImageGeneration(
          (model) => buildFalImageInput(reframePrompt, [compositedBase], { aspectRatio: aspectRatio || "1:1", resolution, modelId: model, seed: resolvedSeed }).input,
          { preferredModel: endpointFor(framePreferredModel, true), alternateModel: endpointFor(frameAlternateModel, true), apiKey, costMeta: frameCostMeta },
        );
        return { image: reframeResult.image, modelUsed: reframeResult.modelUsed };
      } else if (!forceProductOnly && isAnatomicalFrameArray[i] && !lockWardrobe && identityImageForFrames) {
        if (totalAnatomicalFrames === 1 && compositedBase) {
          return { image: compositedBase, modelUsed: "locked-set-reuse" };
        }
        const wardrobeDirective = matchReferenceOutfit && modelReferenceBase64 ? null : `${finalPrompts[i]} ${profile.vibe}`;
        const frameCompositeResult = await compositeIdentityWithProduct(
          {
            lockedIdentityImage: identityImageForFrames,
            lockedProductImage: productReferenceForFrames,
            environment,
            aspectRatio,
            creativeProfile,
            subjectSelectionNote,
            wardrobeDirective,
            preferredModel: framePreferredModel,
            alternateModel: frameAlternateModel,
            resolution,
          },
          frameCostMeta,
          apiKey,
        );
        return { image: frameCompositeResult.image, modelUsed: frameCompositeResult.modelUsed };
      } else {
        const includesHuman = !forceProductOnly && wantsHumanArray[i];
        const scaleGrounding = includesHuman
          ? creativeProfile?.estimatedRealWorldSize
            ? `REAL-WORLD SCALE: ${creativeProfile.estimatedRealWorldSize}. Use that body-relative comparison directly.`
            : "REAL-WORLD SCALE: think about the product's actual physical dimensions and render it at true scale."
          : creativeProfile?.estimatedRealWorldSize
            ? `REAL-WORLD SCALE: ${creativeProfile.estimatedRealWorldSize} — render it at that scale relative to its surroundings.`
            : "";
        const usePersonReference = includesHuman && !!lookReference;
        const wardrobeNote =
          matchReferenceOutfit && modelReferenceBase64
            ? "Match whatever outfit the person is wearing in the reference image, as closely as possible."
            : "Do NOT copy whatever the person happens to be wearing (or not wearing) in the reference image — that photo is for face/likeness matching ONLY. The wardrobe/styling for this shot comes entirely from the shot description above.";
        const identityInstruction = usePersonReference
          ? `IDENTITY: the THIRD reference image shows the person to use for this shoot. Match their face, expression style, general look, and skin tone as faithfully as the composition allows. PHOTOREALISM: keep this looking like a real photograph. ${wardrobeNote} This is standard non-explicit commercial product photography; none of this authorizes nudity or explicit content, which stay prohibited regardless of what the reference photo shows. ${subjectSelectionNote || ""}`
          : "";
        const sceneDescription = forceProductOnly
          ? `Clean, tasteful commercial product photography of ${creativeProfile.productLabel || "the product"} in a normal, everyday setting appropriate to its category.`
          : finalPrompts[i];
        const wornAsOutfitReinforcement =
          includesHuman && creativeProfile.productWornAsOutfit
            ? `\nWORN AS OUTFIT — CRITICAL, OVERRIDES ANYTHING ABOVE THAT CONFLICTS WITH THIS: this product IS the outfit for this shot. The model MUST be shown actually wearing it as the primary visible clothing in the scene — never held, never laid out nearby, never implied via a separate garment like a robe standing in for it. If any instruction above described the product simply staged/laid out rather than worn, disregard that framing and depict her wearing it instead.`
            : "";
        const productOnlyPrompt = `${sceneDescription}.
${profile.vibe}
${creativeProfile.humanInclusionApproach && includesHuman ? creativeProfile.humanInclusionApproach : ""}
${creativeProfile.physicalStaging || ""}
${creativeProfile.lightingStrategy || ""}.
Commercial luxury photography. Photorealistic. True 3D lighting and natural physical shadows.
${buildProductLockClause(creativeProfile, { imageLabel: "the reference image" })}${wornAsOutfitReinforcement}
${scaleGrounding}
${identityInstruction}
${commonNegative}
${creativeProfile.injectedDirectives || ""}`;
        const refImages = [productReferenceForFrames];
        if (usePersonReference) refImages.push(lookReference);
        const productOnlyResult = await resilientFalImageGeneration(
          (model) => buildFalImageInput(productOnlyPrompt, refImages, { aspectRatio: aspectRatio || "1:1", resolution, modelId: model, seed: resolvedSeed }).input,
          { preferredModel: endpointFor(framePreferredModel, true), alternateModel: endpointFor(frameAlternateModel, true), apiKey, costMeta: frameCostMeta },
        );
        return { image: productOnlyResult.image, modelUsed: productOnlyResult.modelUsed };
      }
    }
    const frameResults = new Array(finalPrompts.length).fill(null);
    let nextFrameIndex = 0;
    let completedFrameCount = 0;
    function noteFrameDone() {
      completedFrameCount++;
      progress.updateProgress(runId, "rendering-frames", `${completedFrameCount} of ${finalPrompts.length} frame(s) done...`);
    }
    const resumedFrames = db.getCompletedRunItems(runId, "frame");
    async function frameWorker() {
      while (nextFrameIndex < finalPrompts.length) {
        const i = nextFrameIndex++;
        const cached = resumedFrames.get(String(i));
        if (cached) {
          frameResults[i] = cached;
          noteFrameDone();
          continue;
        }
        try {
          frameResults[i] = await processFrame(i);
          if (frameResults[i]?.image) {
            frameResults[i].image = await persistFalImage(frameResults[i].image, `${runId}-frame${i}-${Date.now()}.png`);
          }
          db.saveRunItem({ runId, itemType: "frame", itemKey: i, status: "success", payload: frameResults[i] });
          noteFrameDone();
        } catch (frameErr) {
          if (frameErr.isSafetyBlock && wantsHumanArray[i]) {
            try {
              frameResults[i] = await processFrame(i, { forceProductOnly: true });
              db.saveRunItem({ runId, itemType: "frame", itemKey: i, status: "success", payload: frameResults[i] });
              frameErrors.push({ frame: i + 1, message: `Human element dropped after rejection (${frameErr.message}); delivered as product-only instead.` });
            } catch (fallbackErr) {
              db.saveRunItem({ runId, itemType: "frame", itemKey: i, status: "error", note: fallbackErr.message });
              frameErrors.push({ frame: i + 1, message: `${frameErr.message} — fallback also failed: ${fallbackErr.message}` });
            }
          } else {
            db.saveRunItem({ runId, itemType: "frame", itemKey: i, status: "error", note: frameErr.message });
            frameErrors.push({ frame: i + 1, message: frameErr.message });
          }
          noteFrameDone();
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(FRAME_CONCURRENCY, finalPrompts.length) }, frameWorker));
    const frameOutputs = frameResults.filter(Boolean);
    outputImageUrls = frameOutputs.map((f) => f.image);
    if (outputImageUrls.length === 0) {
      progress.failProgress(runId, "No frames successfully processed.");
      return res.status(500).json({ error: "No frames successfully processed." });
    }
    progress.finishProgress(runId);
    const totalMs = Date.now() - routeStartedAt;
    res.json({
      images: outputImageUrls,
      modelsUsed: frameOutputs.map((f) => f.modelUsed),
      replacementNote,
      diagnostics: {
        humanFramesRequested: wantsHumanArray.filter(Boolean).length,
        anatomicalPathActive: !!compositedBase || !!identityImageForFrames,
        wardrobeLocked: !!lockWardrobe,
        anatomicalFallbackReason: [productModelNote, anatomicalFallbackReason, lookReferenceNote].filter(Boolean).join(" ") || null,
        framesRequested: finalPrompts.length,
        framesSucceeded: outputImageUrls.length,
        frameErrors,
        totalMs,
      },
    });
  } catch (error) {
    console.error("Image pipeline error:", error);
    progress.failProgress(req.body?.runId, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Post-hoc single-frame regeneration with an explicitly chosen model —
// backs the per-image "regenerate with a different model" control in the
// UI, so a person isn't locked into whatever model rendered the original
// batch. Reuses the same locked-set/product/identity references as the
// original run where available, so a re-roll doesn't silently change the
// product/identity, only the rendering model and (optionally) the prompt.
app.post("/api/regenerate-frame", async (req, res) => {
  try {
    const {
      prompt,
      imageModel,
      referenceImages, // array of base64/data-URI images to pass as context (product, identity, base shot, etc.)
      aspectRatio,
      imageResolution,
      userApiKey,
      runId,
      itemType, // "frame" (single mode) or "batch_item" (batch mode) — identifies which saved run_item this regeneration belongs to, if any
      itemKey, // frame index (single) or product index (batch)
      shotIndex, // batch mode only — which image within that item's images[] array this replaces
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!prompt) return res.status(400).json({ error: "Missing prompt." });
    if (!imageModel) return res.status(400).json({ error: "Missing imageModel." });
    const costMeta = { runId, endpoint: "regenerate-frame" };
    const rawUrl = await falImageRequest(
      endpointFor(imageModel, (referenceImages || []).length > 0),
      buildFalImageInput(prompt, referenceImages || [], { aspectRatio: aspectRatio || "1:1", resolution: imageResolution || DEFAULT_IMAGE_RESOLUTION, modelId: imageModel }).input,
      { apiKey, retries: 2, costMeta },
    );
    // Real, confirmed gap fixed here: this previously returned Fal's own
    // (eventually-expiring) URL directly, AND never touched run_items —
    // meaning even the run's OWN saved record never reflected a
    // regeneration, so reloading a campaign later would silently show the
    // stale original instead of whatever was actually last approved.
    const url = await persistFalImage(rawUrl, `${runId}-regen-${itemType || "frame"}${itemKey ?? ""}${shotIndex != null ? `-${shotIndex}` : ""}-${Date.now()}.png`);
    if (runId && itemType && itemKey != null) {
      try {
        const existing = db.getCompletedRunItems(runId, itemType).get(String(itemKey));
        if (existing) {
          if (itemType === "batch_item" && shotIndex != null && Array.isArray(existing.images) && existing.images[shotIndex]) {
            existing.images[shotIndex] = { ...existing.images[shotIndex], image: url, modelUsed: imageModel };
          } else if (itemType === "frame") {
            existing.image = url;
            existing.modelUsed = imageModel;
          }
          db.saveRunItem({ runId, itemType, itemKey, status: "success", payload: existing });
        }
      } catch (saveErr) {
        console.warn(`[Regenerate Frame] Couldn't update the saved campaign record (${saveErr.message}) — the new image still works, it just won't be what shows up if this campaign is reloaded later.`);
      }
    }
    res.json({ image: url, modelUsed: imageModel });
  } catch (error) {
    console.error("Regenerate-frame error:", error);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// Video equivalent of /api/regenerate-frame: re-renders an already-
// generated video using its stored source image(s), letting the person
// type a new instruction and/or change duration/model without redoing
// the whole selection-and-brief flow from scratch. sourceImages/videoModel/
// aspectRatio/durationSeconds all come back from the original generation
// (see the `results.push(...)` calls in /api/generate-video above) so the
// frontend doesn't need to reconstruct them.
app.post("/api/regenerate-video", async (req, res) => {
  let runId;
  try {
    const {
      sourceImages,
      instruction, // new/edited creative direction — replaces the original prompt's direction, not appended to it
      videoModel,
      durationSeconds,
      aspectRatio,
      productLabel,
      brandName,
      environment,
      aiEnhance,
      generateAudio,
      userApiKey,
      textModel,
      runId: clientRunId,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!Array.isArray(sourceImages) || sourceImages.length === 0) return res.status(400).json({ error: "Missing source image(s) to regenerate from." });
    if (!videoModel) return res.status(400).json({ error: "Missing videoModel." });
    runId = clientRunId || crypto.randomUUID();
    const effectiveTextModel = textModel || DEFAULT_TEXT_MODEL;
    progress.startProgress(runId, "rendering-video", "Rewriting the video direction...");
    const enhancedPrompt = await buildVideoPrompt(
      {
        creativeDirection: instruction,
        productLabel,
        brandName,
        environment,
        aiEnhance: aiEnhance !== false,
        durationSeconds,
        videoModel,
        imageCount: sourceImages.length,
      },
      { apiKey, textModel: effectiveTextModel, costMeta: { runId, endpoint: "regenerate-video" } },
    );
    const clip = await generateVideoClipWithRetry(
      {
        prompt: enhancedPrompt,
        imageBase64: sourceImages[0],
        referenceImages: sourceImages,
        aspectRatio,
        durationSeconds,
        videoModel,
        generateAudio,
      },
      {
        runId,
        apiKey,
        textModel: effectiveTextModel,
        costMeta: { runId, endpoint: "regenerate-video" },
        destFilename: `${runId}-regen-${Date.now()}.mp4`,
        detailPrefix: "Regenerating video",
      },
      { productLabel, brandName, environment },
    );
    progress.finishProgress(runId);
    res.json({
      url: clip.url,
      modelUsed: clip.modelUsed,
      prompt: clip.finalPrompt,
      rewritten: clip.wasRewritten,
      usedReferenceImages: clip.usedReferenceImages,
      sourceImages,
      videoModel,
      videoMode: sourceImages.length > 1 ? "combined" : "separate",
      aspectRatio,
      durationSeconds: resolveVideoDuration(videoModel, durationSeconds, getGuide(videoModel)?.capabilities || getModelSchemaInfo(videoModel)),
      note: [clip.fallbackNote, clip.videoReplacementNote].filter(Boolean).join(" ") || null,
    });
  } catch (error) {
    console.error("Regenerate-video error:", error);
    progress.failProgress(runId, error.message);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// ============================================================
// VIDEO GENERATION — migrated to Fal (Veo 3.1 / Kling / etc. via falVideoRequest)
// ============================================================
const MAX_VIDEO_ITEMS = 6;

// Fal's multi-image "combine" endpoints live on separate endpoint IDs (not
// an extra field on the regular image-to-video call) and use different
// field names/image limits per vendor. This is now driven entirely by the
// `combine` metadata on each VIDEO_MODELS registry entry (see
// fal-models.js) instead of a hardcoded single-vendor regex — adding a new
// combine-capable model going forward is a registry change, not a code
// change. Confirmed combine-capable today: Veo 3.1 (any tier, up to 3
// images) and Seedance 2.0 (either tier, up to 9 images). Kling has no
// confirmed image_urls-style combine endpoint (its multi-reference
// feature, "Kling Elements", is a different mechanism entirely), so it
// correctly has no `combine` entry and always anchors on one image.
function resolveVideoEndpointForRefs(videoModel, refCount) {
  const model = getVideoModel(videoModel);
  if (refCount > 1 && model?.combine) return model.combine.endpoint;
  return null;
}

// Different vendors on Fal use different field names/formats for the same
// concepts. Getting this wrong doesn't error loudly — it just silently
// produces a bad/empty video, which is exactly what "the video generated
// is useless" usually means in practice. Centralizing per-model schema
// quirks here instead of assuming one vendor's shape works for every model.
// Infers the real duration format string a model expects from its own
// schema example ("8s" confirms the suffix convention, "8" confirms bare
// digits, an actual number confirms it's not a string at all) — this is
// what replaces guessing for a model this app has never had a human look
// at. Falls back to the most common convention among the curated models
// (bare number string) only when no example is available at all.
function inferDurationFormat(liveCapabilities) {
  const example = liveCapabilities?.durationExample;
  if (typeof example === "number" || liveCapabilities?.durationType === "integer" || liveCapabilities?.durationType === "number") {
    return (s) => s; // sent as an actual number, not a string
  }
  if (typeof example === "string" && /^\d+$/.test(example)) {
    return (s) => `${s}`; // bare digits, confirmed from the real example
  }
  if (typeof example === "string" && /^\d+[a-zA-Z]/.test(example)) {
    const suffix = example.replace(/^\d+/, ""); // usually "s", but reads whatever Fal's real example actually used rather than assuming
    return (s) => `${s}${suffix}`;
  }
  return (s) => `${s}`; // no example available — bare digits is the majority convention among the models already confirmed here
}
// Converts what Fal's validator said it expected ("4s"/"6s"/"8s", or
// just "8", etc.) into a real format + real enum, straight from the
// failure — not inferred from a schema guess. This is the actual
// learning step: what gets persisted is exactly what Fal confirmed, not
// this app's interpretation of a schema.
function inferFormatFromExpectedValues(expectedValues) {
  const allBareDigits = expectedValues.every((v) => /^\d+$/.test(v));
  if (allBareDigits) return { formatType: "bare", enumOptions: expectedValues.map(Number) };
  const suffixMatch = expectedValues[0]?.match(/^(\d+)([a-zA-Z]+)$/);
  if (suffixMatch) {
    return { formatType: "suffix", suffix: suffixMatch[2], enumOptions: expectedValues.map((v) => parseInt(v)).filter((v) => !isNaN(v)) };
  }
  return { formatType: "bare", enumOptions: null };
}
function getVideoModelSchema(videoModel) {
  // Learned corrections (from a REAL Fal validation failure, see the
  // isSchemaValidationError retry logic in generateVideoClipWithRetry)
  // are the most trustworthy signal available — Fal's own validator
  // confirming exactly what it accepts for THIS model, not an inference
  // from a schema guess. Checked first, for every model, no exceptions.
  // This — not a per-model-ID switch statement — is the actual
  // replacement for hand-written knowledge: the app learns the real
  // answer from a real failure and remembers it, instead of needing
  // someone to pre-research and hardcode it before it can ever work.
  const correction = db.getModelFieldCorrection(videoModel);
  const liveCap = getGuide(videoModel)?.capabilities || getModelSchemaInfo(videoModel);
  if (correction?.field === "duration") {
    const durationFormat = correction.formatType === "suffix" ? (s) => `${s}${correction.suffix}` : (s) => `${s}`;
    const liveCapabilities = correction.enumOptions?.length ? { durationEnum: correction.enumOptions.map(String) } : liveCap;
    return { imageField: liveCap?.imageField || "image_url", durationFormat, liveCapabilities };
  }
  // Live-detected schema (from the ongoing catalog check, works for ANY
  // model whose schema has been read — curated or auto-discovered) is
  // the actual primary source now, for every model. Real schema facts,
  // not per-model-ID logic written by a human ahead of time.
  if (liveCap?.detected && liveCap.imageField) {
    return { imageField: liveCap.imageField, durationFormat: inferDurationFormat(liveCap), liveCapabilities: liveCap };
  }
  // No learned correction and no live schema data yet (never checked, or
  // the check failed) — safest generic default. Bare-digit duration is
  // the majority real convention observed across Fal's own video
  // catalog; the very first real generation attempt on any model that
  // turns out to need something different will self-correct via the
  // learning path above, automatically, without anyone writing code for it.
  return { imageField: "image_url", durationFormat: (s) => `${s}` };
}

function buildFalVideoInput({ prompt, imageBase64, referenceImages, aspectRatio, durationSeconds, negativePrompt, videoModel, forceSingleImage = false, generateAudio = true, endImageBase64 = null }) {
  const model = getVideoModel(videoModel);
  const maxImages = model?.combine?.maxImages || 3;
  const usableRefs = forceSingleImage ? [] : (referenceImages || []).filter(Boolean).slice(0, maxImages);
  const endpointOverride = resolveVideoEndpointForRefs(videoModel, usableRefs.length);
  // THE ACTUAL FIX: resolve which endpoint will genuinely be called
  // BEFORE computing duration/schema, not after. A combine/reference
  // endpoint (e.g. Veo's reference-to-video) can have a completely
  // different, stricter duration constraint than its base single-image
  // model (confirmed directly in production: base Veo Fast accepts
  // 4/6/8s, but its reference-to-video variant only accepts 8s) — using
  // the base model's schema to format a duration that then gets sent to
  // a DIFFERENT endpoint is exactly what caused real "Input should be
  // '8s'" validation failures. Everything below now uses the endpoint
  // that's actually being called, not the one originally requested.
  const actualEndpoint = endpointOverride || videoModel;
  const schema = getVideoModelSchema(actualEndpoint);
  const resolvedDuration = resolveVideoDuration(actualEndpoint, durationSeconds, schema.liveCapabilities);
  const input = {
    prompt,
    aspect_ratio: aspectRatio || "16:9",
    duration: schema.durationFormat(resolvedDuration),
    generate_audio: generateAudio !== false,
  };
  // Live-detected capabilities (from the actual schema, via the ongoing
  // catalog check — see fal-schema-utils.js's detectSchema) supplement
  // the static registry flags. This is what makes this scale to every
  // model instead of needing me to manually verify and hardcode each one
  // — a model that's simply been checked once by the background catalog
  // job gets these capabilities correctly, registry flag or not.
  const liveCap = getGuide(actualEndpoint)?.capabilities;
  const supportsNegativePrompt = model?.supportsNegativePrompt || liveCap?.hasNegativePrompt;
  const supportsEndFrame = model?.supportsEndFrame || liveCap?.hasEndFrame;
  // Gated the same way the resolution param was for images — sending an
  // unrecognized field to a model with a strict schema risks a
  // validation error rather than being silently ignored, so this is only
  // attached when actually confirmed (statically or live), not for every
  // model unconditionally like before.
  if (negativePrompt && supportsNegativePrompt) input.negative_prompt = negativePrompt;
  if (endpointOverride && model?.combine) {
    input[model.combine.imageField] = usableRefs.map((r) => toFalImageUrl(r));
  } else if (usableRefs.length >= 1 || imageBase64) {
    input[schema.imageField] = toFalImageUrl((forceSingleImage ? null : usableRefs[0]) || imageBase64 || (referenceImages || []).filter(Boolean)[0]);
  }
  // Real start→end frame interpolation (confirmed: Kling's actual
  // end_image_url field) — only attached when the resolved model is
  // actually confirmed to support it (statically flagged OR live-
  // detected) AND we're not already routed through the combine/
  // reference endpoint (that's a different feature; this is specifically
  // "animate from image A to image B", not "blend N references").
  if (endImageBase64 && !endpointOverride && supportsEndFrame) {
    input.end_image_url = toFalImageUrl(endImageBase64);
  }
  return { input, endpoint: actualEndpoint };
}

// Rewrites a video prompt using the platform's own stated block reason —
// more targeted than blindly softening, since we know what tripped the
// filter this time instead of guessing.
async function rewriteFilteredVideoPrompt({ originalPrompt, filterReasons, productLabel, brandName, environment }, { apiKey, textModel, costMeta }) {
  const reasonsText = (filterReasons || []).join(" ") || "The prompt was filtered by the video model's safety system for an unspecified reason.";
  const prompt = `You are a video-prompt specialist fixing a prompt that a safety filter rejected, for a commercial product-photography/video tool.
PRODUCT: ${productLabel || "the product"} for brand "${brandName || ""}".
SCENE CONTEXT: ${environment || "a clean commercial setting"}.
ORIGINAL PROMPT THAT WAS REJECTED:
${originalPrompt}
STATED REASON FOR REJECTING IT:
${reasonsText}
Rewrite this into a new prompt that preserves the same product, composition, and creative intent as closely as possible, but removes whatever specifically triggered that filter. Common causes worth checking: audio/dialogue cues, described human touch or physical contact, described facial expressions that could be misread, camera language that implies violence or distress, or overly intense/dramatic phrasing a filter can misread literally. Keep it concrete and camera-technical (shot type, camera movement, pacing). Return ONLY the rewritten prompt text — no preamble, no quotes, no markdown.`;
  const response = await falTextRequest(prompt, { model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.6, costMeta: { ...costMeta, endpoint: "rewrite-filtered-video-prompt" } });
  return response.text.trim();
}

// Real video-extension — confirmed directly from Fal's own Seedance 2.0
// docs: extension isn't a separate endpoint with its own fields, it's
// the reference-to-video endpoint with a previous clip passed as a
// video reference and described via [Video1] in the prompt. This gives
// genuine frame-to-frame continuity (same character, lighting, camera
// state carried forward) rather than two independently-generated clips
// merged afterward. Falls back to independent generation honestly if
// the extension attempt itself fails, rather than blocking the whole
// sequence on one shaky continuation.
async function generateExtendedVideoClip({ prompt, previousVideoUrl, aspectRatio, durationSeconds }, meta) {
  const extendModelId = "bytedance/seedance-2.0/reference-to-video";
  try {
    const input = {
      prompt: `[Video1] ${prompt}`,
      video_urls: [previousVideoUrl],
      aspect_ratio: aspectRatio || "16:9",
      duration: String(Math.min(15, Math.max(4, durationSeconds || 8))),
    };
    const result = await falVideoRequest(extendModelId, input, {
      apiKey: meta.apiKey, runId: meta.runId, costMeta: meta.costMeta,
      destFilename: meta.destFilename, detailPrefix: `${meta.detailPrefix} (extending previous scene)`,
      durationSeconds,
    });
    return { ...result, modelUsed: extendModelId, wasExtended: true };
  } catch (err) {
    console.warn(`[Flow] Video extension failed (${err.message}) — falling back to independent generation for this scene instead of blocking the sequence on one shaky continuation.`);
    return null; // caller falls back to generateVideoClipWithRetry
  }
}

async function generateVideoClipWithRetry(
  { prompt, imageBase64, referenceImages, aspectRatio, durationSeconds, negativePrompt, videoModel: rawVideoModel, generateAudio, endImageBase64 },
  meta,
  rewriteContext,
) {
  // Phase 12 / Section 22 — automatic replacement if the requested
  // model has genuinely gone deprecated. Wired here, the single shared
  // engine every video generation call site in the app already routes
  // through, rather than in each individual route — same "fix once,
  // applies everywhere" reasoning already proven for the spend guard
  // and other cross-cutting checks this session.
  const { resolvedModelId: videoModel, replacementNote: videoReplacementNote } = resolveModelOrReplacement(rawVideoModel);
  if (videoReplacementNote) console.warn(`[Model Replacement] ${videoReplacementNote}`);
  const wasMultiRefRequested = (referenceImages || []).filter(Boolean).length > 1;
  const runOnce = async (p, { forceSingleImage = false, modelOverride = null } = {}) => {
    const effectiveModel = modelOverride || videoModel;
    const { input, endpoint } = buildFalVideoInput({ prompt: p, imageBase64, referenceImages, aspectRatio, durationSeconds, negativePrompt, videoModel: effectiveModel, forceSingleImage, generateAudio, endImageBase64 });
    const result = await falVideoRequest(endpoint, input, {
      apiKey: meta.apiKey,
      runId: meta.runId,
      costMeta: meta.costMeta,
      destFilename: meta.destFilename,
      detailPrefix: meta.detailPrefix,
      durationSeconds,
    });
    return { ...result, usedReferenceImages: !forceSingleImage && wasMultiRefRequested && endpoint !== effectiveModel };
  };
  // A last-resort DIFFERENT model to try if everything above still fails —
  // real signal the specific model is struggling with this input, not
  // just the wording (confirmed in production: a fully rewritten,
  // completely tame prompt still failed identically on the same model
  // twice in a row). Veo Fast as the fallback target since it's the most
  // broadly reliable/well-established option; if that's already what was
  // requested, fall back to Kling instead for a genuinely different
  // vendor rather than retrying the same one a third time.
  const fallbackVideoModel = videoModel === DEFAULT_VIDEO_MODEL ? "fal-ai/kling-video/v3/pro/image-to-video" : DEFAULT_VIDEO_MODEL;
  let attemptPrompt = prompt;
  let fallbackNote = null;
  let usedModel = videoModel;
  let result;
  const tryWithModelFallback = async (p, opts = {}) => {
    try {
      return await runOnce(p, opts);
    } catch (err) {
      // A likeness/privacy check is a VENDOR-SPECIFIC classifier, not a
      // universal content violation — confirmed repeatedly in production
      // that Seedance specifically flags images other vendors don't.
      // Worth trying a different vendor for. A general prompt-content
      // safety block is different: that content would likely trip most
      // vendors' classifiers the same way, so switching models wouldn't
      // help and would just waste a paid attempt — keep skipping those.
      if (err.isSafetyBlock && !err.isImageContentBlock) throw err;
      console.warn(`[Video] ${meta.detailPrefix || "Clip"}: ${videoModel} failed even after retrying (${err.message}) — trying ${fallbackVideoModel} as a genuinely different model instead of giving up.`);
      db.recordImageContentBlockModel(videoModel);
      const fallbackResult = await runOnce(p, { ...opts, modelOverride: fallbackVideoModel });
      usedModel = fallbackVideoModel;
      fallbackNote = [fallbackNote, `${videoModel} couldn't produce this clip even after a prompt rewrite (${err.message}) — used ${fallbackVideoModel} instead, which succeeded.`].filter(Boolean).join(" ");
      return fallbackResult;
    }
  };
  try {
    result = await runOnce(attemptPrompt);
  } catch (err) {
    if (err.isSchemaValidationError) {
      // Real self-correction: Fal's own validator just told us exactly
      // what it expected — learn it, persist it (every future call to
      // this model uses it automatically, forever, no code changes
      // needed), and retry THIS SAME model once with the correction
      // applied before giving up on it. This is the actual replacement
      // for hand-written per-model knowledge: the app learns the real
      // answer from a real failure instead of needing someone to
      // research and hardcode it ahead of time.
      if (err.schemaErrorField === "duration" && err.schemaErrorExpected?.length) {
        const learned = inferFormatFromExpectedValues(err.schemaErrorExpected);
        db.saveModelFieldCorrection(videoModel, { field: "duration", expectedValues: err.schemaErrorExpected, ...learned });
        console.warn(`[Video] ${meta.detailPrefix || "Clip"}: ${videoModel} rejected the duration format — learned the correct one (${JSON.stringify(err.schemaErrorExpected)}) directly from Fal's own error and retrying the same model with it, instead of giving up on it.`);
        try {
          result = await runOnce(attemptPrompt);
          fallbackNote = [fallbackNote, `${videoModel} needed a different duration format than expected — corrected automatically from Fal's own error and it worked on retry. Remembered for next time, on this model and any future one that hits the same thing.`].filter(Boolean).join(" ");
        } catch (retryErr) {
          console.warn(`[Video] ${meta.detailPrefix || "Clip"}: ${videoModel} still failed after the learned correction (${retryErr.message}) — trying ${fallbackVideoModel} instead.`);
          result = await runOnce(attemptPrompt, { modelOverride: fallbackVideoModel });
          usedModel = fallbackVideoModel;
          fallbackNote = [fallbackNote, `${videoModel} failed even after a learned duration-format correction — used ${fallbackVideoModel} instead.`].filter(Boolean).join(" ");
        }
      } else {
        // A wrong value in a non-content field this app doesn't have a
        // specific learning path for yet (aspect_ratio, resolution, fps,
        // bitrate_mode) — same safety net as before, go straight to a
        // genuinely different model rather than a pointless prompt rewrite.
        console.warn(`[Video] ${meta.detailPrefix || "Clip"}: ${videoModel} rejected a non-content field (${err.message}) — this isn't something a prompt rewrite can fix, trying ${fallbackVideoModel} directly instead.`);
        result = await runOnce(attemptPrompt, { modelOverride: fallbackVideoModel });
        usedModel = fallbackVideoModel;
        fallbackNote = [fallbackNote, `${videoModel} rejected the request over a format/field mismatch, not content (${err.message}) — used ${fallbackVideoModel} instead.`].filter(Boolean).join(" ");
      }
    } else if (err.isImageContentBlock && wasMultiRefRequested) {
      // The block is about the IMAGES themselves (a likeness/privacy
      // check), not the prompt wording — rewriting the text and
      // resubmitting the exact same images would just fail again
      // identically, burning a second paid attempt for nothing. Dropping
      // to a single image actually changes what's being evaluated, so
      // that's the only retry worth attempting here.
      console.warn(`[Video] ${meta.detailPrefix || "Clip"}: multi-image reference was flagged as a likeness/privacy issue (${err.message}) — this is about the images, not the prompt, so skipping the pointless prompt-rewrite retry and falling back to a single-image anchor instead.`);
      db.recordImageContentBlockModel(videoModel);
      result = await tryWithModelFallback(attemptPrompt, { forceSingleImage: true });
      fallbackNote = [fallbackNote, `The combined multi-image request was flagged by the video model's own likeness/privacy check (not this app's moderation) — fell back to a single-image anchor instead; the other selected shots informed the text description only.`].filter(Boolean).join(" ");
    } else if (err.isImageContentBlock) {
      // Already single-image and still flagged — but that's still a
      // vendor-specific classifier result, not proof every vendor would
      // flag it. Worth trying a genuinely different model before giving
      // up (confirmed real case: Seedance blocked an image on both its
      // multi-image AND single-image endpoints, but had never been
      // tested against Veo/Kling for the same image before this fix).
      // Goes straight to the fallback model (not through
      // tryWithModelFallback's own retry-then-fallback path) — we
      // already know this exact model+image combo fails, no need to
      // spend a second paid call re-confirming that.
      console.warn(`[Video] ${meta.detailPrefix || "Clip"}: single-image reference was flagged as a likeness/privacy issue on ${videoModel} (${err.message}) — trying ${fallbackVideoModel} instead, since this is that model's own classifier, not a universal block.`);
      db.recordImageContentBlockModel(videoModel);
      result = await runOnce(attemptPrompt, { modelOverride: fallbackVideoModel });
      usedModel = fallbackVideoModel;
      fallbackNote = [fallbackNote, `${videoModel}'s own likeness/privacy check flagged this image (not this app's moderation) — ${fallbackVideoModel} was used instead, which succeeded.`].filter(Boolean).join(" ");
    } else if (err.isSafetyBlock) {
      console.warn(`[Video] ${meta.detailPrefix || "Clip"} was filtered (${(err.filterReasons || []).join(" ") || "no reason given"}) — rewriting the prompt once and retrying.`);
      attemptPrompt = await rewriteFilteredVideoPrompt(
        { originalPrompt: prompt, filterReasons: err.filterReasons, ...rewriteContext },
        { apiKey: meta.apiKey, textModel: meta.textModel, costMeta: meta.costMeta },
      );
      // THE ACTUAL FIX: if the rewritten prompt ALSO fails, that's real
      // evidence pointing at the model itself (this specific model
      // struggling with this specific reference image/scene), not the
      // wording — try a different model instead of giving up entirely,
      // which is what was happening before (confirmed: two consecutive
      // "no_media_generated" failures on the same model, on completely
      // different and inoffensive rewritten prompts).
      result = await tryWithModelFallback(attemptPrompt);
    } else if (wasMultiRefRequested) {
      console.warn(`[Video] ${meta.detailPrefix || "Clip"}: multi-image reference mode failed (${err.message}) — falling back to a single-image anchor.`);
      result = await tryWithModelFallback(attemptPrompt, { forceSingleImage: true });
      fallbackNote = [fallbackNote, `Multi-image reference mode wasn't available for this attempt (${err.message}) — used a single-image anchor instead; the other selected shots informed the text description only.`].filter(Boolean).join(" ");
    } else {
      // Generic failure with a single image, nothing safety-related —
      // still worth one model-fallback attempt before giving up, same
      // reasoning as the safety-block path above.
      result = await tryWithModelFallback(attemptPrompt);
    }
  }
  return { ...result, finalPrompt: attemptPrompt, wasRewritten: attemptPrompt !== prompt, fallbackNote, modelUsed: result.modelUsed || usedModel, videoReplacementNote };
}

// ============================================================
// FLOW STUDIO — intent-driven video creation from multiple references
// (images, a story/context, optionally links). Two real jobs:
// 1. PLAN: turn rich, loosely-structured intent into a concrete prompt +
//    a genuinely reasoned model recommendation (checking whether any
//    reference image contains a human face, then steering away from
//    models with a REAL confirmed track record of failing on that,
//    using the same trust data already tracked elsewhere in this app —
//    not a fresh, separate guess).
// 2. GENERATE: hand the plan to generateVideoClipWithRetry, the same
//    proven engine every other video path in this app already uses —
//    so every fallback behavior already fought for (schema errors,
//    likeness blocks, safety blocks, model-to-model fallback) applies
//    here automatically, rather than being reimplemented and risking a
//    weaker copy of logic that already works.
// ============================================================

// Real check, not an assumption — asks vision directly whether each
// reference image contains a human face, rather than guessing from
// filenames or always assuming yes/no.
async function detectHumanFacesInReferences(referenceImages, { apiKey, visionModel }) {
  if (!referenceImages?.length) return false;
  const checks = referenceImages.slice(0, 6).map(async (img) => {
    try {
      const response = await falVisionRequest(
        "Does this image contain a real or illustrated human face (of any age, any style)? Answer with ONLY one word: YES or NO.",
        img,
        { model: visionModel || DEFAULT_VISION_MODEL, apiKey, costMeta: { endpoint: "flow-face-detect" } },
      );
      return /^\s*YES/i.test(response.text);
    } catch {
      return false; // a failed check shouldn't block the whole plan — treated as "unknown," not "definitely human," so it doesn't wrongly restrict model choice
    }
  });
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

// Real, reasoned recommendation — not the model that's simply first in
// the list. Uses the SAME confirmedLikenessBlockModels data that every
// other video path in this app already learns from in real time.
function recommendVideoModel({ hasHumanFaces, referenceCount, hasEndFrame, prioritize }) {
  const blockedIds = new Set(db.getConfirmedLikenessBlockModels());
  const reasons = [];
  let candidates = VIDEO_MODELS.filter((m) => !m.id.includes("reference-to-video")); // the auto reference-to-video variants are selected implicitly via combine, not chosen directly here
  // Hard requirement, checked first: an end-frame image only actually
  // does anything on the two models confirmed to support it (Kling v3
  // Standard, Kling O3 Pro). Without this filter, the recommendation
  // could still land on Veo Fast — which would silently ignore the end
  // frame entirely, exactly the kind of "looks like it worked but
  // didn't" failure this app has been fixing all session.
  if (hasEndFrame) {
    const endFrameCapable = candidates.filter((m) => m.supportsEndFrame);
    if (endFrameCapable.length) {
      candidates = endFrameCapable;
      reasons.push("You provided an end-frame image — narrowed to the models genuinely confirmed to support start→end frame animation (Kling v3 Standard, Kling O3 Pro); other models would silently ignore it.");
    } else {
      reasons.push("You provided an end-frame image, but no confirmed end-frame-capable model is available right now — it may not be used.");
    }
  }
  if (hasHumanFaces) {
    const beforeCount = candidates.length;
    const filtered = candidates.filter((m) => !blockedIds.has(m.id));
    if (filtered.length) {
      candidates = filtered;
      if (beforeCount !== filtered.length) {
        reasons.push(`Your references include a human face. ${beforeCount - filtered.length} model(s) were excluded because they've genuinely failed on human-inclusive requests in this app before — this isn't a guess, it's this app's own real track record.`);
      } else {
        reasons.push("Your references include a human face — none of the available models have a confirmed history of failing on that here, so the full list is still in play.");
      }
    } else {
      reasons.push("Your references include a human face, and every model has some history of likeness issues here — proceeding with the broadest, most-tested option anyway; the generation step will automatically try a different model if this one is blocked again.");
    }
  }
  if (referenceCount > 1) {
    const combineCapable = candidates.filter((m) => m.combine);
    if (combineCapable.length) {
      candidates = combineCapable;
      reasons.push(`You provided ${referenceCount} reference images — narrowed to models with real confirmed multi-image combine support.`);
    }
  }
  let chosen;
  if (prioritize === "quality") {
    chosen = candidates.find((m) => m.id === "fal-ai/veo3.1/image-to-video") || candidates[0];
    reasons.push("Prioritizing quality — Veo 3.1 standard tier.");
  } else if (prioritize === "budget") {
    chosen = candidates.find((m) => m.id === "fal-ai/veo3.1/lite/image-to-video") || candidates[0];
    reasons.push("Prioritizing lowest cost — Veo 3.1 Lite.");
  } else {
    chosen = candidates.find((m) => m.id === DEFAULT_VIDEO_MODEL) || candidates[0];
    reasons.push(hasEndFrame ? "Balanced default among end-frame-capable models." : "Balanced default — Veo 3.1 Fast, the most broadly reliable option tracked in this app.");
  }
  return { modelId: chosen?.id || DEFAULT_VIDEO_MODEL, reasons, hasHumanFaces };
}

// Resolves a reference card's image into something directly usable by
// both vision analysis and generation — a card may have an uploaded
// data URI OR an external URL, and both are valid, interchangeable
// inputs to Fal's endpoints (confirmed: "you can pass your own URL or a
// Base64 data URI" is standard across Fal's own docs), so no special
// download/conversion step is needed for either case.
function resolveCardImage(card) {
  return card?.imageBase64 || card?.imageUrl || null;
}
// Groups cards sharing a name together (alternate versions of the same
// character/product — e.g. a real photo card plus an AI-generated or
// animated version of the same person) and writes a real description
// block for the planning prompt, naming each version's style tag
// explicitly rather than treating all references as interchangeable.
function describeCards(cards, label) {
  if (!cards?.length) return "";
  const groups = {};
  cards.forEach((c) => {
    const key = c.name?.trim() || `(unnamed ${label})`;
    groups[key] = groups[key] || [];
    groups[key].push(c);
  });
  const lines = Object.entries(groups).map(([name, group]) => {
    const versions = group.map((c) => {
      const styleLabel = { real: "real photo", ai: "AI-generated reference", animated: "animated/cartoon reference" }[c.styleTag] || "reference";
      const hasImage = !!resolveCardImage(c);
      return `${styleLabel}${hasImage ? "" : " (description only, no image)"}${c.description ? `: ${c.description.trim()}` : ""}`;
    });
    // Language/characteristics are character-level, not per-image-version
    // — taken from the first card in the group rather than repeated per version.
    const primary = group[0];
    const extras = [];
    if (primary.language) extras.push(`speaks ${primary.language}`);
    if (primary.characteristics) extras.push(`personality/speech style: ${primary.characteristics.trim()}`);
    return `- ${name} — ${versions.join("; ")}${extras.length ? ` [${extras.join(", ")}]` : ""}`;
  });
  return `${label.toUpperCase()}:\n${lines.join("\n")}`;
}

app.post("/api/flow/plan", async (req, res) => {
  try {
    const {
      intent, storyContext, storyStart, storyEnd,
      personCards, productCards, niche, scenario, hasEndFrame,
      prioritize, textModel, visionModel, userApiKey,
    } = req.body;
    if (!intent || !intent.trim()) return res.status(400).json({ error: "Missing your intent — describe what you want this video to be/achieve." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    const people = (personCards || []).filter((c) => c.name || c.description || resolveCardImage(c));
    const products = (productCards || []).filter((c) => c.name || c.description || resolveCardImage(c));
    const refImageUrls = [...people, ...products].map(resolveCardImage).filter(Boolean);
    // Optional link in the story/context field — best-effort plain fetch,
    // not a full scraper. If it fails, the plan proceeds on the intent
    // text alone rather than blocking on a fetch problem.
    let fetchedContext = "";
    const urlMatch = storyContext?.match(/https?:\/\/\S+/);
    if (urlMatch) {
      try {
        const pageRes = await fetch(urlMatch[0], { headers: { "User-Agent": "Mozilla/5.0" } });
        const html = await pageRes.text();
        fetchedContext = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      } catch (fetchErr) {
        console.warn(`[Flow] Couldn't fetch reference link ${urlMatch[0]}: ${fetchErr.message} — continuing without it.`);
      }
    }
    // Real check against every actual person-card image (upload or URL),
    // not just a generic pool — this is what the human-face-aware model
    // filtering below relies on.
    const hasHumanFaces = people.some((c) => resolveCardImage(c)) && await detectHumanFacesInReferences(people.map(resolveCardImage).filter(Boolean), { apiKey, visionModel });
    // "Talking" is a genuinely different workflow, not just a different
    // prompt style — it routes to the confirmed image+audio avatar model
    // instead of a normal text/image-to-video model, and needs Voice
    // Studio for the actual dialogue audio (which has real, confirmed
    // Indian-language support the avatar model itself doesn't claim).
    if (scenario === "talking") {
      return res.json({
        isTalkingScenario: true,
        guidance: "Talking/dialogue videos use a different, dedicated workflow in this app: generate the spoken audio in Voice Studio first (pick any language — its Indian-language support is real and confirmed), then bring that audio clip plus one portrait-style reference image here. The avatar model maps the audio's waveform to lip movement directly — it doesn't need to understand the language, so this works for Telugu/Hindi/Tamil/etc. dialogue even though the avatar model itself has no confirmed language support of its own.",
        talkingAvatarModels: TALKING_AVATAR_MODELS.map((m) => ({ id: m.id, label: m.label })),
      });
    }
    const recommendation = recommendVideoModel({ hasHumanFaces, referenceCount: refImageUrls.length, hasEndFrame: !!hasEndFrame, prioritize });
    // Scenario-specific direction — each of these is a genuinely
    // different creative brief, not the same instructions with a label
    // swapped in.
    const scenarioGuidance = {
      cinematic: `This is a CINEMATIC scene — prioritize mood, atmosphere, and visual storytelling. Think in terms of a real film shot: lighting quality, lens choice implied by framing, color mood, and deliberate pacing.`,
      product: `This is a PRODUCT HIGHLIGHT video — the product named below must be the clear visual focus of the shot. Camera work should reveal the product's form, material, and detail clearly, not bury it in a busy scene.`,
      fan: `This is a FAN/TRIBUTE-style video — energetic, celebratory, stitched-together-highlight-reel energy. Dynamic cuts and movement implied in the description, enthusiastic tone.`,
      replicate: `The goal is to evoke the STYLE and FEEL of a reference (described below), not copy it — describe original camera work and composition that captures a similar mood/energy, using entirely new, non-derivative description.`,
    }[scenario] || "";
    const peopleBlock = describeCards(people, "people/characters");
    const productsBlock = describeCards(products, "products");
    const planPrompt = `You are a professional video director turning a person's intent into a concrete, camera-literate video generation prompt.

CONTENT GUIDANCE — apply the same tasteful standard used throughout this app for any mature, dramatic, or intimate themes: dramatic emotional content, tension, and real intensity are all fine and often exactly what makes a scene work — describe them directly and confidently. But any intimate/romantic content stays suggested and tasteful, never explicit — no described sexual acts, no graphic nudity, no content sexualizing a real named person. If the intent implies something explicit, direct the scene toward its emotional core (longing, connection, tension) rather than literal depiction. This is about honest, confident dramatic filmmaking, not a workaround for adult content.

${scenarioGuidance}
INTENT: ${intent.trim()}
${peopleBlock}
${productsBlock}
${niche ? `GENRE/NICHE: ${niche.trim()}` : ""}
${storyStart ? `HOW IT STARTS: ${storyStart.trim()}` : ""}
${storyEnd ? `HOW IT ENDS: ${storyEnd.trim()}` : ""}
${storyContext ? `ADDITIONAL STORY/CONTEXT: ${storyContext.trim()}` : ""}
${fetchedContext ? `CONTEXT FETCHED FROM A LINKED PAGE (use for tone/facts, don't quote it verbatim): ${fetchedContext}` : ""}
${refImageUrls.length ? `There are ${refImageUrls.length} reference image(s) provided across the people/products above — describe camera movement and composition that would work well anchored to visual references like these, without assuming details you can't see.` : ""}
Write ONE concrete, camera-technical video prompt: shot type, camera movement, pacing, mood, lighting. Keep it grounded and achievable, not overly abstract.
Return ONLY the prompt text — no explanation, no quotes, no markdown.`;
    const promptResponse = await falTextRequest(planPrompt, {
      model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.7,
      costMeta: { endpoint: "flow-plan" },
    });
    res.json({
      prompt: promptResponse.text.trim(),
      recommendation,
      hasHumanFaces,
      referenceImages: refImageUrls, // resolved list the frontend should carry into generation, since cards may use URLs, not just uploads
    });
  } catch (error) {
    console.error(`[Flow] Planning failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/flow/generate", async (req, res) => {
  let runId;
  try {
    const {
      prompt, referenceImages, videoModel, aspectRatio, durationSeconds, generateAudio, endImageBase64,
      textModel, userApiKey, runId: clientRunId,
    } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Missing prompt." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    const refs = (referenceImages || []).filter(Boolean);
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "rendering-video", "Generating your video...");
    // Reuses the exact same proven engine as every other video path —
    // this is where "auto-fallback without error, always produce an
    // output" actually comes from: it's not new logic, it's the same
    // real fallback chain (schema fixes, likeness-block model-switching,
    // safety-block prompt rewriting) already fought for and confirmed
    // elsewhere in this app.
    const clip = await generateVideoClipWithRetry(
      {
        prompt: prompt.trim(),
        imageBase64: refs[0] || null,
        referenceImages: refs,
        aspectRatio: aspectRatio || "16:9",
        durationSeconds,
        videoModel: videoModel || DEFAULT_VIDEO_MODEL,
        generateAudio,
        endImageBase64: endImageBase64 || null,
      },
      {
        runId, apiKey, textModel: textModel || DEFAULT_TEXT_MODEL,
        costMeta: { runId, endpoint: "flow-generate" },
        destFilename: `${runId}-flow-${Date.now()}.mp4`,
        detailPrefix: "Flow Studio video",
      },
      { productLabel: null, brandName: null, environment: null },
    );
    progress.finishProgress(runId);
    res.json({
      video: clip.dataUri || clip.url,
      modelUsed: clip.modelUsed,
      finalPrompt: clip.finalPrompt,
      wasRewritten: clip.wasRewritten,
      fallbackNote: clip.fallbackNote,
      videoReplacementNote: clip.videoReplacementNote,
    });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Flow] Generation failed even after every fallback: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// Talking-video generation — genuinely different from the general video
// path above: real image+audio avatar model, its own small fallback
// chain (cheaper standard tier first, automatically retries with the
// pro tier if that specific attempt fails, rather than surfacing a raw
// error) since generateVideoClipWithRetry's logic is built around
// text-prompt video models, not this simpler two-file schema.
app.post("/api/flow/generate-talking", async (req, res) => {
  let runId;
  try {
    const {
      imageBase64, audioBase64,
      text, targetLanguage, voiceMode, voiceModelId, voiceReferenceAudioBase64,
      useNativeHeygenVoice, heygenVoiceName,
      background, talkingStyle, aspectRatio, modelId, textModel, userApiKey, runId: clientRunId,
    } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Missing a reference portrait image." });
    if (!audioBase64 && !text?.trim()) return res.status(400).json({ error: "Missing audio or text to speak." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    const imageUrl = toFalImageUrl(imageBase64, "image/png");
    let audioUrl = audioBase64 ? toFalImageUrl(audioBase64, "audio/mpeg") : null;
    let nativeTextForHeygen = null;
    let estimatedAudioDurationSeconds = 8; // real default matching falVideoRequest's own fallback — overwritten below with a real or estimated value whenever possible
    if (!audioUrl && text?.trim()) {
      // Real translation, applied once, the same proven mechanism used
      // everywhere else in this app — not left to whichever avatar
      // model's own (unverified, for this specific endpoint) language
      // handling might or might not do the right thing.
      let finalText = text.trim();
      if (targetLanguage && targetLanguage.trim().toLowerCase() !== "english") {
        progress.startProgress(runId, "generating-voice", "Preparing the translated script...");
        const prepared = await prepareTextForLanguage(finalText, targetLanguage.trim(), { apiKey, textModel, costMeta: { runId } });
        finalText = prepared.preparedText;
      }
      if (useNativeHeygenVoice) {
        // Explicit alternate path: HeyGen's own text-to-speech, using
        // the now-translated text directly. Offered honestly as an
        // option, not the default — this app's own Voice Studio TTS is
        // the directly-proven path for Indian languages; HeyGen's own
        // docs claim broad language support for this too, but that
        // hasn't been independently verified here.
        nativeTextForHeygen = finalText;
        // No real duration available for HeyGen's own TTS output ahead
        // of time — estimated from text length (roughly 15 chars/sec
        // for natural speech) rather than silently assuming a short
        // default, which is exactly what caused the reported timeout.
        estimatedAudioDurationSeconds = Math.max(5, Math.ceil(finalText.length / 15));
      } else {
        // Default, proven path: generate real speech via this app's own
        // TTS (standard voice, or cloned from a reference clip first),
        // then hand the resulting audio to the avatar model — works
        // identically for Kling or HeyGen since both accept audio_url.
        progress.startProgress(runId, "generating-voice", "Generating speech...");
        let effectiveVoiceModel = VOICE_MODELS.find((m) => m.id === voiceModelId) || VOICE_MODELS[0];
        let effectiveVoiceId = req.body.voiceId || null;
        if (voiceMode === "clone" && voiceReferenceAudioBase64) {
          progress.startProgress(runId, "cloning-voice", "Cloning voice from your reference clip...");
          const cloneModel = VOICE_CLONE_MODELS[0];
          const cloneUrl = toFalImageUrl(voiceReferenceAudioBase64, "audio/wav");
          const cloneResult = await falVoiceRequest(cloneModel.id, cloneModel.buildInput(cloneUrl, {}), {
            apiKey, costMeta: { runId, endpoint: "flow-talking-voice-clone" }, costPer1kChars: 0.1, textLength: 60,
          });
          if (cloneResult.customVoiceId) {
            effectiveVoiceModel = VOICE_MODELS.find((m) => m.id === "fal-ai/minimax/speech-02-hd") || effectiveVoiceModel;
            effectiveVoiceId = cloneResult.customVoiceId;
          }
        }
        const voiceResult = await falVoiceRequest(effectiveVoiceModel.id, effectiveVoiceModel.buildInput(finalText, { voiceId: effectiveVoiceId }), {
          apiKey, costMeta: { runId, endpoint: "flow-talking-voice" }, costPer1kChars: effectiveVoiceModel.costPer1kChars,
        });
        audioUrl = voiceResult.url;
        // Real duration when the TTS model actually reports one;
        // otherwise the same text-length estimate as the HeyGen-native
        // path above, rather than defaulting back to a short number
        // that doesn't reflect what's actually about to be processed.
        estimatedAudioDurationSeconds = voiceResult.durationMs ? Math.ceil(voiceResult.durationMs / 1000) : Math.max(5, Math.ceil(finalText.length / 15));
      }
    } else if (audioBase64) {
      // A directly-uploaded finished clip — no text to estimate from, so
      // this estimates from the base64 payload's real size (roughly
      // 16KB/second for typical compressed speech audio) rather than
      // assuming a short default for a file that could be much longer.
      const approxBytes = audioBase64.length * 0.75;
      estimatedAudioDurationSeconds = Math.max(5, Math.ceil(approxBytes / 16000));
    }
    progress.startProgress(runId, "rendering-video", "Generating your talking video...");
    const buildOpts = { text: nativeTextForHeygen, voice: heygenVoiceName, background, talkingStyle, aspectRatio: aspectRatio || "16:9" };
    let primaryModel = TALKING_AVATAR_MODELS.find((m) => m.id === modelId) || TALKING_AVATAR_MODELS[0];
    if (!audioUrl && !nativeTextForHeygen) return res.status(400).json({ error: "No audio or text ended up ready to generate from — this shouldn't happen; try again." });
    if (!audioUrl && !primaryModel.supportsNativeText) {
      primaryModel = TALKING_AVATAR_MODELS.find((m) => m.supportsNativeText) || primaryModel;
    }
    const fallbackModel = TALKING_AVATAR_MODELS.find((m) => m.id !== primaryModel.id && (audioUrl || m.supportsNativeText)) || TALKING_AVATAR_MODELS[0];
    let usedModel = primaryModel;
    let result;
    try {
      result = await falVideoRequest(primaryModel.id, primaryModel.buildInput(imageUrl, audioUrl, buildOpts), {
        apiKey, runId, costMeta: { runId, endpoint: "flow-talking" },
        destFilename: `${runId}-talking-${Date.now()}.mp4`,
        detailPrefix: "Talking video",
        durationSeconds: estimatedAudioDurationSeconds,
      });
    } catch (err) {
      console.warn(`[Flow] Talking video failed on ${primaryModel.id} (${err.message}) — trying ${fallbackModel.id} instead of giving up.`);
      usedModel = fallbackModel;
      result = await falVideoRequest(fallbackModel.id, fallbackModel.buildInput(imageUrl, audioUrl, buildOpts), {
        apiKey, runId, costMeta: { runId, endpoint: "flow-talking-fallback" },
        destFilename: `${runId}-talking-${Date.now()}.mp4`,
        detailPrefix: "Talking video (fallback)",
        durationSeconds: estimatedAudioDurationSeconds,
      });
    }
    progress.finishProgress(runId);
    // Real, confirmed bug fixed here: falVideoRequest already downloads
    // and locally persists the video (that's what destFilename is for),
    // returning a served local path — this used to redundantly try to
    // re-fetch that ALREADY-LOCAL path through downloadImageAsDataUri as
    // if it were still a remote Fal URL, which crashed with "Failed to
    // parse URL from /generated-videos/...". Matches the established
    // correct pattern used by /api/flow/generate (clip.dataUri ||
    // clip.url) — the served path works directly as a <video src> and
    // download link on the frontend, no conversion needed, and is far
    // more efficient than turning a video file into a giant base64
    // data URI would have been anyway.
    res.json({
      video: result.url,
      modelUsed: usedModel.id,
      fallbackNote: usedModel.id !== primaryModel.id ? `${primaryModel.id} couldn't produce this clip — used ${fallbackModel.id} instead, which succeeded.` : null,
    });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Flow] Talking video generation failed even after fallback: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// ============================================================
// LONG-FORM VIDEO — multi-scene generation + real ffmpeg stitching.
// No single Fal model generates more than ~15s in one call, so a
// multi-minute video is built from several shorter scenes, each
// generated through the SAME proven generateVideoClipWithRetry engine
// as everything else in this app (so per-scene fallback behavior is
// inherited, not reimplemented), then physically stitched into one
// file on disk — not a data URI, which genuinely can't scale to this size.
// ============================================================

// Informational now, not a blocker — Fal's own cloud merge endpoint is
// the real primary stitching path (needs only a valid API key, which is
// already required for everything else in this app), so a missing local
// ffmpeg no longer prevents long-video generation. This still reports
// whether the LOCAL fallback would be available if the cloud path ever
// has trouble, since that's still useful to know honestly.
app.get("/api/flow/ffmpeg-status", async (req, res) => {
  res.json({
    cloudMergeAvailable: true, // real capability confirmed directly from Fal's own docs — always true given a valid API key
    localFallbackAvailable: await videoStitcher.checkFfmpegAvailable(),
  });
});

app.post("/api/flow/plan-scenes", async (req, res) => {
  try {
    const {
      intent, storyStart, storyEnd, personCards, productCards, niche, scenario,
      totalDurationMinutes, forceExtended, videoModel, textModel, userApiKey,
    } = req.body;
    if (!intent || !intent.trim()) return res.status(400).json({ error: "Missing your intent." });
    const people = (personCards || []).filter((c) => c.name || c.description || resolveCardImage(c));
    const products = (productCards || []).filter((c) => c.name || c.description || resolveCardImage(c));
    const referenceImageCount = [...people, ...products].map(resolveCardImage).filter(Boolean).length;
    // Base cap is 15 minutes — covers the large majority of real
    // requests. 30 minutes requires an explicit forceExtended flag
    // rather than being available by default, given the real cost/time
    // implications of a run that size (confirmed directly: a 30-minute
    // video at ~225 scenes can run into the hundreds of dollars
    // depending on model, and multiple hours of real generation time).
    const hardCap = forceExtended ? 30 : 15;
    const minutes = Math.max(1, Math.min(hardCap, parseFloat(totalDurationMinutes) || 1));
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // Real recommendation when no model was explicitly chosen — reuses
    // the same logic (including avoiding models with a genuine, tracked
    // history of failing on human-inclusive requests) already proven for
    // the standard Flow Studio path, rather than silently defaulting to
    // one fixed model regardless of what's actually being asked for.
    let effectiveVideoModel = videoModel;
    let modelRecommendation = null;
    if (!effectiveVideoModel) {
      modelRecommendation = recommendVideoModel({
        hasHumanFaces: people.length > 0,
        referenceCount: referenceImageCount,
        prioritize: req.body.prioritize,
      });
      effectiveVideoModel = modelRecommendation.modelId;
    }
    // REAL FIX: scene duration now genuinely respects whichever model
    // will actually generate it, instead of a flat hardcoded 8s for
    // every model regardless of real capability. Kling/Seedance/Happy
    // Horse are confirmed to support up to 15s per clip — using their
    // real ceiling means fewer, longer scenes for the same total video
    // length (less overhead, fewer API calls, faster overall).
    // resolveVideoDuration clamps a large requested number down to
    // whatever this specific model's actual max really is.
    const sceneDurationSeconds = resolveVideoDuration(effectiveVideoModel, 999, getGuide(effectiveVideoModel)?.capabilities || getModelSchemaInfo(effectiveVideoModel));
    const targetSceneCount = Math.max(1, Math.round((minutes * 60) / sceneDurationSeconds));
    const peopleBlock = describeCards(people, "people/characters");
    const productsBlock = describeCards(products, "products");
    const planPrompt = `You are a professional video director breaking a story into a real shot list for a ${minutes}-minute video, made of individual ${sceneDurationSeconds}-second scenes that will be generated separately and merged together.
OVERALL INTENT: ${intent.trim()}
${storyStart ? `HOW IT STARTS: ${storyStart.trim()}` : ""}
${storyEnd ? `HOW IT ENDS: ${storyEnd.trim()}` : ""}
${peopleBlock}
${productsBlock}
${niche ? `GENRE/NICHE: ${niche.trim()}` : ""}
${scenario ? `VIDEO TYPE: ${scenario}` : ""}
${referenceImageCount ? `${referenceImageCount} reference image(s) are available across the people/products above — mention in a scene's note if it should anchor to one, without assuming which specific one.` : ""}

Break this into exactly ${targetSceneCount} scenes that flow as one coherent story from the stated start to the stated end (if given), each a real, camera-technical, ${sceneDurationSeconds}-second-achievable shot description (shot type, camera movement, mood, lighting) — not a vague summary.

For each scene (except the first), decide how it should connect to the one before it:
- "extend": the SAME character(s) continuing the SAME action/moment — this scene will be generated as a direct continuation from the previous scene's actual last frame, carrying forward the same face, lighting, and camera state. Use this for genuine continuous action.
- "cutaway": a genuinely different shot — a different subject, a product close-up, a location change, a time jump. This scene will be generated independently and joined afterward. Use this when the story needs a real cut, not a continuation.
The first scene is always "cutaway" (nothing precedes it to extend from).

CONTENT GUIDANCE: dramatic emotional content, tension, and real intensity are fine and often exactly what makes a scene work — describe them directly. Any intimate/romantic content stays suggested and tasteful, never explicit — no described sexual acts, no graphic nudity.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"scenes": [{"prompt": "...", "durationSeconds": ${sceneDurationSeconds}, "continuityType": "cutaway"}, ...]}`;
    const response = await falTextRequest(planPrompt, {
      model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.7,
      costMeta: { endpoint: "flow-plan-scenes" },
    });
    let parsed;
    try {
      parsed = JSON.parse(response.text.trim().replace(/^```json\s*|```$/g, ""));
    } catch {
      throw new Error("The scene-planning step didn't return valid structured output — try again.");
    }
    res.json({ scenes: parsed.scenes || [], sceneDurationSeconds, recommendedModel: effectiveVideoModel, modelRecommendation });
  } catch (error) {
    console.error(`[Flow] Scene planning failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/flow/estimate-cost", async (req, res) => {
  try {
    const { scenes, videoModel } = req.body;
    if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: "No scenes to estimate." });
    const model = getVideoModel(videoModel) || {};
    // Honest cost basis: use whatever this model's REAL confirmed
    // per-second rate is if the registry has one; otherwise say clearly
    // that this is a rough placeholder, not a number to trust precisely
    // — same standard held everywhere else in this app rather than
    // inventing a specific-looking number with no real basis.
    const perSecondRate = model.costPerSecond || null;
    const totalSeconds = scenes.reduce((sum, s) => sum + (parseFloat(s.durationSeconds) || 8), 0);
    const estimatedCost = perSecondRate ? Number((totalSeconds * perSecondRate).toFixed(2)) : null;
    // Rough, honestly-labeled time estimate — sequential generation
    // (deliberate, not a shortcut — see the generate-long route) means
    // real wall-clock time adds up fast for a long scene count. ~40s
    // per scene is a reasonable real-world average for these video
    // models including retry/fallback overhead, not a precise promise.
    const estimatedMinutes = Math.round((scenes.length * 40) / 60);
    res.json({
      sceneCount: scenes.length,
      totalSeconds,
      estimatedCost,
      isRoughEstimate: !perSecondRate,
      estimatedMinutes,
      note: perSecondRate
        ? `${scenes.length} scene(s), ${totalSeconds}s total, at this model's confirmed $${perSecondRate}/second. Roughly ${estimatedMinutes} minute(s) of real generation time (sequential, not instant) — a rough estimate, not a guarantee.`
        : `${scenes.length} scene(s), ${totalSeconds}s total — this model's exact per-second rate isn't confirmed in this app's registry, so no precise total is shown. Check the real cost on Fal's own pricing page for this model before committing to a long run. Roughly ${estimatedMinutes} minute(s) of real generation time.`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/flow/generate-long", async (req, res) => {
  let runId;
  try {
    const { scenes, videoModel, aspectRatio, referenceImages, personCards, overallLanguage, textModel, userApiKey, runId: clientRunId } = req.body;
    if (!Array.isArray(scenes) || !scenes.length) return res.status(400).json({ error: "No scenes to generate." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    const refs = (referenceImages || []).filter(Boolean);
    const clipUrls = [];
    const perSceneNotes = [];
    // Real per-scene, per-character dialogue: each person card can have
    // its own dialogue lines assigned to a specific scene index. Each
    // character's own selected voice generates their line, multiple
    // characters' lines in the same scene get combined, then laid onto
    // that scene's clip via the same real merge pipeline already proven
    // for the general audio-layer feature — not a separate mechanism.
    // Mirrors the frontend's resolveVoiceValue — a stored card.voiceModelId
    // can be "custom:<id>" for a saved cloned voice. Without this, that
    // value wouldn't match any real VOICE_MODELS id and would silently
    // fall back to the default voice instead of erroring, which is
    // exactly the kind of bug that's easy to miss.
    function resolveVoiceModelId(rawValue) {
      if (rawValue?.startsWith("custom:")) {
        return { model: VOICE_MODELS.find((m) => m.id === "fal-ai/minimax/speech-02-hd") || VOICE_MODELS[0], voiceId: rawValue.slice("custom:".length) };
      }
      return { model: VOICE_MODELS.find((m) => m.id === rawValue) || VOICE_MODELS[0], voiceId: null };
    }
    async function generateSceneDialogueAudio(sceneIndex) {
      const lines = [];
      for (const card of personCards || []) {
        for (const line of card.dialogueLines || []) {
          if (line.sceneIndex === sceneIndex && line.text?.trim()) {
            lines.push({ speaker: card.name || "Character", text: line.text.trim(), voiceModelId: card.voiceModelId, language: card.language || overallLanguage });
          }
        }
      }
      if (!lines.length) return null;
      const clipUrlsForLines = [];
      for (const line of lines) {
        const { model: voiceModel, voiceId: resolvedVoiceId } = resolveVoiceModelId(line.voiceModelId);
        let finalText = line.text;
        // Real language handling — the same proven mechanism used
        // everywhere else in this app, applied per-character here rather
        // than assuming every character speaks the same language.
        if (line.language && line.language.trim().toLowerCase() !== "english") {
          try {
            const prepared = await prepareTextForLanguage(finalText, line.language.trim(), { apiKey, textModel, costMeta: { runId } });
            finalText = prepared.preparedText;
          } catch (langErr) {
            console.warn(`[Flow] Language preparation failed for ${line.speaker}'s line (${langErr.message}) — using the original text instead of blocking generation.`);
          }
        }
        const result = await falVoiceRequest(voiceModel.id, voiceModel.buildInput(finalText, { voiceId: resolvedVoiceId }), {
          apiKey, costMeta: { runId, endpoint: "flow-dialogue-line" }, costPer1kChars: voiceModel.costPer1kChars,
        });
        clipUrlsForLines.push(result.url);
      }
      if (clipUrlsForLines.length === 1) return clipUrlsForLines[0];
      const merged = await falMergeRequest("fal-ai/ffmpeg-api/merge-audios", { audio_urls: clipUrlsForLines }, { apiKey, costMeta: { runId, endpoint: "flow-dialogue-merge" } });
      return merged.url;
    }
    // Sequential, not parallel — deliberately. Fal's queue/rate limits
    // aside, generating scenes one at a time lets real progress be
    // reported per-scene, and keeps a single account's concurrent-call
    // load predictable for a run that could already be many scenes long.
    let previousVideoUrl = null;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      progress.startProgress(runId, "rendering-video", `Generating scene ${i + 1}/${scenes.length}...`);
      let clip = null;
      // Real continuity attempt: only for scenes tagged "extend" that
      // actually have a previous clip to extend from. Falls through to
      // independent generation below if this specific attempt fails,
      // rather than blocking the whole sequence on one shaky continuation.
      if (scene.continuityType === "extend" && previousVideoUrl) {
        const extended = await generateExtendedVideoClip(
          { prompt: scene.prompt, previousVideoUrl, aspectRatio: aspectRatio || "16:9", durationSeconds: scene.durationSeconds || 8 },
          { runId, apiKey, costMeta: { runId, endpoint: "flow-generate-long-scene-extend" }, destFilename: `${runId}-scene${i}-${Date.now()}.mp4`, detailPrefix: `Scene ${i + 1}/${scenes.length}` },
        );
        if (extended) {
          clip = extended;
          perSceneNotes.push(`Scene ${i + 1}: extended directly from the previous scene's actual last frame (real continuity, not a cut).`);
        }
      }
      if (!clip) {
        clip = await generateVideoClipWithRetry(
          {
            prompt: scene.prompt,
            imageBase64: refs[0] || null,
            referenceImages: refs,
            aspectRatio: aspectRatio || "16:9",
            durationSeconds: scene.durationSeconds || 8,
            videoModel: videoModel || DEFAULT_VIDEO_MODEL,
            generateAudio: true,
          },
          {
            runId, apiKey, textModel: textModel || DEFAULT_TEXT_MODEL,
            costMeta: { runId, endpoint: "flow-generate-long-scene" },
            destFilename: `${runId}-scene${i}-${Date.now()}.mp4`,
            detailPrefix: `Scene ${i + 1}/${scenes.length}`,
          },
          { productLabel: null, brandName: null, environment: null },
        );
        if (clip.fallbackNote) perSceneNotes.push(`Scene ${i + 1}: ${clip.fallbackNote}`);
        if (clip.videoReplacementNote) perSceneNotes.push(`Scene ${i + 1}: ${clip.videoReplacementNote}`);
      }
      clipUrls.push(clip.url);
      previousVideoUrl = clip.url;
      // Layer in this scene's assigned dialogue, if any, before moving on.
      const dialogueUrl = await generateSceneDialogueAudio(i);
      if (dialogueUrl) {
        try {
          const withDialogue = await falMergeRequest("fal-ai/ffmpeg-api/merge-audio-video", { video_url: clip.url, audio_url: dialogueUrl }, { apiKey, costMeta: { runId, endpoint: "flow-scene-dialogue-merge" } });
          clipUrls[clipUrls.length - 1] = withDialogue.url;
          previousVideoUrl = withDialogue.url;
        } catch (dialogueMergeErr) {
          console.warn(`[Flow] Couldn't merge dialogue onto scene ${i + 1} (${dialogueMergeErr.message}) — keeping the scene without its dialogue rather than failing the whole run.`);
          perSceneNotes.push(`Scene ${i + 1}: dialogue audio was generated but couldn't be merged onto this scene — the scene plays without it.`);
        }
      }
    }
    progress.updateProgress(runId, "rendering-video", "Merging all scenes into one video...");
    const stitched = await videoStitcher.stitchClips(clipUrls, {
      aspectRatio: aspectRatio || "16:9",
      apiKey,
      onProgress: (msg) => progress.updateProgress(runId, "rendering-video", msg),
    });
    progress.finishProgress(runId);
    // Two real possible shapes: the cloud path returns an already-hosted
    // remote URL directly (no local file involved at all); the local
    // fallback path returns a filename this app's own download route
    // needs to serve. Handle both honestly rather than assuming one.
    res.json({
      downloadUrl: stitched.remoteUrl || `/api/flow/download/${stitched.filename}`,
      sizeBytes: stitched.sizeBytes,
      sceneCount: scenes.length,
      fallbackNotes: perSceneNotes.length ? perSceneNotes : null,
    });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Flow] Long-video generation failed: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// Real disk-based serving — the data-URI-in-JSON pattern used
// everywhere else in this app genuinely can't scale to a multi-minute
// stitched video (easily hundreds of MB to multiple GB as base64 text),
// so this is a dedicated route reading the file directly from disk.
app.get("/api/flow/download/:filename", (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt down to just the filename
  const filePath = path.join(videoStitcher.OUTPUTS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found — it may have been cleaned up already." });
  res.download(filePath);
});

// ============================================================
// AUDIO LAYER — the real fix for "audio is missing." Reuses Voice
// Studio's existing, already-confirmed voice generation for narration
// and character dialogue (including its real Indian-language support —
// nothing new needed there), and Song Studio's existing music models
// for BGM. Multiple audio layers get combined via Fal's own
// fal-ai/ffmpeg-api/merge-audios (confirmed real schema:
// {audio_urls: [...]}), then laid onto the video via
// fal-ai/ffmpeg-api/merge-audio-video (confirmed real schema:
// {video_url, audio_url}) — both genuinely real Fal endpoints, not
// invented for this.
// ============================================================
// Writes a real narration/dialogue script from a rough idea, then
// reuses the exact same proven language-preparation logic already
// fought for in Voice Studio (romanized-input detection, casual
// register, anti-transliteration validation) — genuinely offering
// romanized local-language input here too, not a separate, weaker path.
app.post("/api/flow/write-narration", async (req, res) => {
  try {
    const { roughIdea, videoContext, targetLanguage, textModel, userApiKey, runId: clientRunId } = req.body;
    if (!roughIdea || !roughIdea.trim()) return res.status(400).json({ error: "Describe what should be said first." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // Not previously tagged with any run_id at all — this script is
    // typically the first step of a talking/narrated video, so the run_id
    // minted here is returned to the frontend and expected to be reused
    // for the voice/video generation calls that follow, so the whole
    // narrated-video session's cost lands under one run.
    const runId = clientRunId || crypto.randomUUID();
    const writePrompt = `You are writing a real narration/dialogue script for a video.
WHAT SHOULD BE SAID: ${roughIdea.trim()}
${videoContext ? `VIDEO CONTEXT (for tone consistency, don't restate it): ${videoContext.trim()}` : ""}
Write natural, speakable narration or dialogue — how someone would actually say this out loud, not a written essay. Keep it concise enough to fit the video's pacing.
Return ONLY the script text — no explanation, no quotes, no markdown.`;
    const response = await falTextRequest(writePrompt, {
      model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.7,
      costMeta: { runId, endpoint: "flow-write-narration" },
    });
    let script = response.text.trim();
    let languageResult = null;
    // Real, honest romanized-language support offered directly, the
    // same way Voice Studio already does — not left as something the
    // person has to discover or work around.
    if (targetLanguage && targetLanguage.trim().toLowerCase() !== "english") {
      languageResult = await prepareTextForLanguage(script, targetLanguage.trim(), { apiKey, textModel, costMeta: { runId } });
      script = languageResult.preparedText;
    }
    res.json({
      script,
      runId,
      scriptValidationFailed: languageResult?.scriptValidationFailed || false,
      transliterationDetected: languageResult?.transliterationDetected || false,
    });
  } catch (error) {
    console.error(`[Flow] Narration writing failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Lightweight recommendation-only endpoint — lets the long-video model
// dropdown genuinely reflect whether human references are present
// (avoiding models with a real tracked history of failing on that) as
// soon as person cards exist, without needing a full scene plan first.
app.post("/api/flow/recommend-model", (req, res) => {
  try {
    const { hasHumanFaces, referenceCount, hasEndFrame, prioritize } = req.body;
    res.json(recommendVideoModel({ hasHumanFaces: !!hasHumanFaces, referenceCount: referenceCount || 0, hasEndFrame: !!hasEndFrame, prioritize }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Extracted so the full add-audio pipeline AND standalone preview
// routes (generate-and-listen before committing to video generation)
// share the exact same real logic, not a second copy.
async function generateVoiceAudioForFlow({ text, voiceModel, voiceId, referenceAudioBase64, apiKey, runId, costEndpoint }) {
  let effectiveVoiceModel = VOICE_MODELS.find((m) => m.id === voiceModel) || VOICE_MODELS[0];
  let effectiveVoiceId = voiceId;
  if (referenceAudioBase64) {
    progress.startProgress(runId, "cloning-voice", "Cloning voice from your reference clip...");
    const cloneModel = VOICE_CLONE_MODELS[0];
    const cloneUrl = toFalImageUrl(referenceAudioBase64, "audio/wav");
    const cloneResult = await falVoiceRequest(cloneModel.id, cloneModel.buildInput(cloneUrl, {}), {
      apiKey, costMeta: { runId, endpoint: `${costEndpoint}-clone` }, costPer1kChars: 0.1, textLength: 60,
    });
    if (cloneResult.customVoiceId) {
      effectiveVoiceModel = VOICE_MODELS.find((m) => m.id === "fal-ai/minimax/speech-02-hd") || effectiveVoiceModel;
      effectiveVoiceId = cloneResult.customVoiceId;
    }
  }
  progress.startProgress(runId, "generating-voice", "Generating audio...");
  const result = await falVoiceRequest(effectiveVoiceModel.id, effectiveVoiceModel.buildInput(text, { voiceId: effectiveVoiceId }), {
    apiKey, costMeta: { runId, endpoint: costEndpoint }, costPer1kChars: effectiveVoiceModel.costPer1kChars,
  });
  return result.url;
}
async function generateBgmAudioForFlow({ prompt, model, referenceAudioBase64, apiKey, runId, costEndpoint }) {
  if (referenceAudioBase64) {
    progress.startProgress(runId, "generating-music", "Generating background music styled after your reference...");
    const refModel = MUSIC_MODELS.find((m) => m.supportsVoiceReference);
    if (!refModel) throw new Error("No reference-based music model available.");
    const refUrl = toFalImageUrl(referenceAudioBase64, "audio/mpeg");
    const result = await falVoiceRequest(refModel.id, refModel.buildInput(prompt || "Instrumental music matching the style of the reference clip.", [refUrl]), {
      apiKey, costMeta: { runId, endpoint: `${costEndpoint}-reference` }, flatCost: refModel.costPerGeneration || 0.05,
    });
    return result.url;
  }
  progress.startProgress(runId, "generating-music", "Generating background music...");
  const musicModel = MUSIC_MODELS.find((m) => m.id === model) || MUSIC_MODELS.find((m) => m.instrumentalOnly) || MUSIC_MODELS[0];
  const bgmInput = musicModel.instrumentalOnly ? musicModel.buildInput(prompt) : musicModel.buildInput(prompt, "[Instrumental]");
  const result = await falVoiceRequest(musicModel.id, bgmInput, {
    apiKey, costMeta: { runId, endpoint: costEndpoint }, flatCost: musicModel.costPerGeneration || 0.05,
  });
  return result.url;
}

// Standalone preview routes — generate a real, listenable clip
// independent of any video, so narration/dialogue/BGM can actually be
// heard and approved before an expensive full generation run, closing
// the exact gap found: everything typed just sat as inert text before this.
app.post("/api/flow/preview-voice", async (req, res) => {
  try {
    const { text, voiceModel, voiceId, referenceAudioBase64, targetLanguage, userApiKey, runId: clientRunId } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Missing text to preview." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // Resolved ONCE, not re-derived at each call site — otherwise the
    // translation step and the actual voice generation below would each
    // independently mint their own random fallback ID whenever the client
    // doesn't supply one, splitting one preview's cost across two
    // unrelated, unlinkable run_ids instead of one real, shared one.
    const runId = clientRunId || crypto.randomUUID();
    // A character's own language genuinely shapes what actually gets
    // spoken — same proven mechanism (romanized-input detection, casual
    // register, anti-transliteration) as everywhere else in this app,
    // not silently skipped just because this is a "preview."
    let finalText = text.trim();
    let languageResult = null;
    if (targetLanguage && targetLanguage.trim().toLowerCase() !== "english") {
      languageResult = await prepareTextForLanguage(finalText, targetLanguage.trim(), { apiKey, textModel: req.body.textModel, costMeta: { runId } });
      finalText = languageResult.preparedText;
    }
    const url = await generateVoiceAudioForFlow({ text: finalText, voiceModel, voiceId, referenceAudioBase64, apiKey, runId, costEndpoint: "flow-preview-voice" });
    const dataUri = await downloadImageAsDataUri(url);
    res.json({
      audio: dataUri,
      spokenText: finalText !== text.trim() ? finalText : null,
      scriptValidationFailed: languageResult?.scriptValidationFailed || false,
      transliterationDetected: languageResult?.transliterationDetected || false,
    });
  } catch (error) {
    console.error(`[Flow] Voice preview failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});
app.post("/api/flow/preview-bgm", async (req, res) => {
  try {
    const { prompt, model, referenceAudioBase64, userApiKey, runId } = req.body;
    if (!prompt?.trim() && !referenceAudioBase64) return res.status(400).json({ error: "Missing a BGM prompt or reference clip to preview." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    const url = await generateBgmAudioForFlow({ prompt: prompt?.trim(), model, referenceAudioBase64, apiKey, runId: runId || crypto.randomUUID(), costEndpoint: "flow-preview-bgm" });
    const dataUri = await downloadImageAsDataUri(url);
    res.json({ audio: dataUri });
  } catch (error) {
    console.error(`[Flow] BGM preview failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/flow/add-audio", async (req, res) => {
  let runId;
  try {
    const {
      videoBase64, narrationScript, narrationVoiceModel, narrationVoiceId,
      voiceReferenceAudioBase64, bgmReferenceAudioBase64,
      bgmPrompt, bgmModel, bgmAudioBase64, narrationAudioBase64,
      userApiKey, runId: clientRunId,
    } = req.body;
    if (!videoBase64) return res.status(400).json({ error: "Missing the video to add audio to." });
    if (!narrationScript && !bgmPrompt && !bgmAudioBase64 && !narrationAudioBase64 && !bgmReferenceAudioBase64) {
      return res.status(400).json({ error: "Nothing to add — provide narration text, a BGM prompt/reference, or an uploaded audio clip." });
    }
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    const audioLayerUrls = [];
    // Narration/dialogue — reuses Voice Studio's real generation path
    // directly, same models, same real language support. A voice
    // reference clip clones a real custom voice first (same mechanism
    // as Voice Studio's own cloning feature), then narrates in it.
    if (narrationAudioBase64) {
      audioLayerUrls.push(toFalImageUrl(narrationAudioBase64, "audio/mpeg"));
    } else if (narrationScript) {
      const url = await generateVoiceAudioForFlow({
        text: narrationScript, voiceModel: narrationVoiceModel, voiceId: narrationVoiceId,
        referenceAudioBase64: voiceReferenceAudioBase64, apiKey, runId, costEndpoint: "flow-add-audio-narration",
      });
      audioLayerUrls.push(url);
    }
    // BGM — reuses Song Studio's real music models. A reference clip
    // routes to Seed Audio 1.0's real, confirmed reference-voice
    // mechanism to style the generated music after it — genuinely
    // different from a plain text prompt, not just relabeled.
    if (bgmAudioBase64) {
      audioLayerUrls.push(toFalImageUrl(bgmAudioBase64, "audio/mpeg"));
    } else if (bgmReferenceAudioBase64 || bgmPrompt) {
      const url = await generateBgmAudioForFlow({
        prompt: bgmPrompt, model: bgmModel, referenceAudioBase64: bgmReferenceAudioBase64,
        apiKey, runId, costEndpoint: "flow-add-audio-bgm",
      });
      audioLayerUrls.push(url);
    }
    if (!audioLayerUrls.length) throw new Error("No audio was actually produced to add.");
    // Combine multiple layers (e.g. narration + BGM together) into one
    // track before laying it onto the video — merge-audio-video only
    // takes a single audio_url, so this step is required whenever more
    // than one layer is involved.
    let finalAudioUrl = audioLayerUrls[0];
    if (audioLayerUrls.length > 1) {
      progress.updateProgress(runId, "rendering-video", "Combining audio layers...");
      const mergedAudio = await falMergeRequest("fal-ai/ffmpeg-api/merge-audios", { audio_urls: audioLayerUrls }, {
        apiKey, costMeta: { runId, endpoint: "flow-add-audio-merge-layers" },
      });
      finalAudioUrl = mergedAudio.url;
    }
    progress.updateProgress(runId, "rendering-video", "Laying audio onto the video...");
    const videoUrl = toFalImageUrl(videoBase64, "video/mp4");
    const finalResult = await falMergeRequest("fal-ai/ffmpeg-api/merge-audio-video", { video_url: videoUrl, audio_url: finalAudioUrl }, {
      apiKey, costMeta: { runId, endpoint: "flow-add-audio-final-merge" },
    });
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(finalResult.url);
    res.json({ video: dataUri });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Flow] Adding audio failed: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// Looks at the ACTUAL selected images (not just text labels) before
// writing a combined-video prompt. This is what was missing: without it,
// combining two visually distinct products (e.g. a sky-blue saree and a
// red saree) had nothing telling the video model these are meant to be
// two different things — so it defaulted to blending them into one
// physically-incoherent morph, which is exactly the failure mode this
// fixes. Vision-groundedness lets the prompt explicitly instruct a clean
// sequence/transition between distinct looks instead.
// Verifies a GENERATED image actually satisfies a real requirement (e.g.
// "the model is visibly wearing this product, not holding it or standing
// near it") using vision — but adaptively sampled (see db.js's
// shouldVerifyThisTime), not run on every single generation. A
// model+scenario combination that's proven reliable gets spot-checked
// instead of fully re-verified every time, which is what keeps this
// affordable instead of doubling the cost of every compositing step
// forever. Never blocks or retries automatically on a failure — it
// SURFACES the mismatch clearly so a human decides what to do, since
// auto-retrying on a vision model's own judgment call risks silently
// burning money in a loop if the check itself is wrong.
async function verifyGenerationMatchesRequirement(imageUrl, requirement, { modelId, scenarioType, apiKey, visionModel, costMeta }) {
  const scenarioKey = `${modelId}::${scenarioType}`;
  const decision = db.shouldVerifyThisTime(scenarioKey);
  if (!decision.verify) {
    return { checked: false, passed: null, reason: decision.reason };
  }
  try {
    const response = await falVisionRequest(
      `Look at this image and answer ONLY "YES" or "NO" (nothing else) to this question: Does this image clearly show ${requirement}? Answer NO if it's ambiguous, if the item is merely visible/nearby rather than actually as described, or if you can't tell clearly.`,
      imageUrl,
      { model: visionModel || DEFAULT_VISION_MODEL, apiKey, costMeta: { ...costMeta, endpoint: "verify-generation" } },
    );
    const passed = /^\s*yes/i.test(response.text.trim());
    db.recordVerificationResult(scenarioKey, passed);
    if (!passed) {
      console.warn(`[Verification] ${modelId} (${scenarioType}): output did NOT match the requirement "${requirement}" — response: "${response.text.trim().slice(0, 100)}"`);
    }
    return { checked: true, passed, reason: decision.reason, rawResponse: response.text.trim() };
  } catch (err) {
    console.warn(`[Verification] Couldn't run the check (${err.message}) — treating as unverified, not as a failure (a vision-call error isn't evidence the image is wrong).`);
    return { checked: false, passed: null, reason: `verification call failed: ${err.message}` };
  }
}

async function analyzeImagesForVideo(images, { apiKey, visionModel, costMeta }) {
  const capped = (images || []).filter(Boolean).slice(0, 3);
  if (capped.length < 2) return null; // only matters for combining 2+ images — a single image needs no cross-image reasoning
  const descriptions = [];
  for (let i = 0; i < capped.length; i++) {
    try {
      const response = await falVisionRequest(
        `Describe this product photo in ONE concise sentence: the specific product, its exact color(s)/pattern, and anything visually distinctive about it. This will be compared against other product photos to determine if they show the same item or different ones — be specific about color/pattern, not generic.`,
        capped[i],
        { model: visionModel || DEFAULT_VISION_MODEL, apiKey, costMeta: { ...costMeta, endpoint: "analyze-video-images" } },
      );
      descriptions.push(response.text.trim());
    } catch (err) {
      console.warn(`[Video Vision] Couldn't analyze image ${i + 1} for combining (${err.message}) — proceeding without vision grounding for it.`);
      descriptions.push(null);
    }
  }
  return descriptions;
}

async function buildVideoPrompt(
  { creativeDirection, cameraMove, styleNote, productLabel, brandName, environment, aiEnhance, durationSeconds, videoModel, imageCount, images, visionModel },
  { apiKey, textModel, costMeta },
) {
  let moderation = { blocked: false, softenedFields: {} };
  if (creativeDirection || styleNote) {
    try {
      moderation = await moderateCreativeInputs({ creativeDirection, styleNote }, { apiKey, textModel, costMeta });
    } catch (modErr) {
      console.warn(`[Video Moderation] Pre-check failed (${modErr.message}) — proceeding without softening.`);
    }
  }
  if (moderation.blocked) {
    const err = new Error(moderation.blockedReason || "This video direction can't be fulfilled as described.");
    err.isSafetyBlock = true;
    throw err;
  }
  const safeCreativeDirection = moderation.softenedFields?.creativeDirection || creativeDirection;
  const safeStyleNote = moderation.softenedFields?.styleNote || styleNote;
  const rough =
    [
      safeCreativeDirection ? `User's direction: ${safeCreativeDirection}` : null,
      cameraMove ? `Requested camera move: ${cameraMove}` : null,
      safeStyleNote ? `Style/mood: ${safeStyleNote}` : null,
    ]
      .filter(Boolean)
      .join("\n") || "No specific direction given — invent something fitting for this product.";
  if (!aiEnhance) return rough;
  const isIntimateApparel = isIntimateSensitiveCategory(productLabel);
  const concealedTreatmentRule = isIntimateApparel
    ? `\nCONCEALED/EDITORIAL TREATMENT — MANDATORY, OVERRIDES ANYTHING ABOVE THAT CONFLICTS WITH THIS: this product is intimate/undergarment apparel. NEVER write a direct, clearly-identifiable view of a person wearing it, even if the rough direction above asks for one. Default to tasteful editorial techniques real intimate-apparel advertising uses: a backlit silhouette against a sheer curtain or doorway, a soft shadow cast on a wall, an extreme close-up on fabric texture/lace detail with a hand or draped cloth partially in frame, or a cropped composition (shoulders-to-waist only, face never shown). The product's texture, color, and mood should still read clearly — this is concealment through lighting and framing, not a lower-quality shot.`
    : "";
  // Model-aware prompting: different video vendors on Fal have their own
  // documented conventions for referencing multiple input images, and
  // ignoring that produces a technically-valid but weaker prompt (the
  // model can't tell which described element belongs to which reference
  // image). Confirmed from ByteDance's own Seedance 2.0 docs: prompts
  // should tag each reference explicitly with @Image1, @Image2, etc.
  const model = getVideoModel(videoModel);
  const willCombine = (imageCount || 1) > 1 && !!model?.combine;
  const seedanceTaggingRule =
    willCombine && /^bytedance\/seedance-2\.0/.test(videoModel)
      ? `\nMULTI-IMAGE TAGGING — MANDATORY for this model: this prompt will be sent to Seedance 2.0 with ${Math.min(imageCount, model.combine.maxImages)} reference images. Seedance's own convention is to tag each one explicitly in the prompt text as @Image1, @Image2, etc. (e.g. "@Image1 shows the fabric detail, camera pushes in while @Image2's drape style is echoed in the final pose"). Use these tags naturally in your sentence(s) so the model knows which described element maps to which reference image — an untagged prompt leaves this ambiguous and produces weaker results.`
      : "";
  // Honest, not a workaround: prompt wording cannot fix a classifier that
  // rejects the IMAGES themselves (e.g. Fal's own "likeness of real
  // people" check on Seedance/Veo's multi-image reference endpoints) —
  // that's evaluated on the images, independent of what the text says. The
  // one thing wording CAN do is keep the description grounded in the
  // product/motion rather than the person, which is good practice
  // regardless and costs nothing to include.
  const likenessAwareness =
    willCombine
      ? `\nNOTE ON THIS MODEL'S REFERENCE-IMAGE HANDLING: since this combines multiple images through ${videoModel}'s reference/identity mode, keep the description anchored on the PRODUCT — its material, motion, texture, how it moves/drapes/catches light — rather than on the person's face or identity. This can't override that model's own automated checks on the images themselves (no prompt wording can), but a product-anchored description is simply better creative direction for a product video regardless.`
      : "";
  // THE ACTUAL FIX for "combined videos feel forced/lifeless": the
  // single-image completeness rule below (ONE unbroken beat) was being
  // applied to combined multi-image clips too, forcing genuinely
  // different reference images into one artificial continuous motion
  // instead of letting the clip have real structure. When multiple
  // DIFFERENT images are being combined, real commercial video uses
  // actual editing techniques — a cut/transition between distinct
  // moments, a side-by-side or sequential presentation, deliberate
  // scene changes — not one motion awkwardly trying to cover unrelated
  // content. This is written generically (not tied to any specific
  // product category) so it applies to whatever's actually in the
  // reference images.
  const combineStructureRule = willCombine
    ? `\nMULTI-SCENE STRUCTURE — this clip combines ${Math.min(imageCount, model?.combine?.maxImages || imageCount)} distinct reference images, which are NOT required to blend into one continuous motion. Real commercial video uses actual editing structure for this: choose ONE deliberate approach and commit to it —
  (a) A clean cut or transition partway through the clip, moving from one image's subject/context to the next (e.g. "the scene cuts from [first subject] to [second subject] via a quick whip-pan" or a smooth cross-dissolve) — each half gets its own brief, complete beat rather than sharing one.
  (b) A sequential showcase: the camera moves through each subject in turn within the available time, giving each a clear, distinct moment rather than merging them.
  (c) A mirrored/parallel presentation: the same camera move or gesture echoed across both subjects back-to-back, creating a deliberate visual rhyme rather than blending them into one scene.
Pick whichever suits the actual content best and describe it concretely (specific cut point, specific transition type) — do not default to vaguely implying everything happens at once in one shot just because it's technically one clip.`
    : "";
  // Vision grounding — actually LOOKS at the selected images before
  // writing the prompt above, instead of leaving the AI to invent
  // plausible-sounding differences it can't see. This is what turns
  // "handle multiple images with editing structure" (generic, already
  // existed) into "these are specifically a sky-blue saree and a red
  // saree — cut between them" (concrete and correct). Without this, the
  // structure rule above could still describe a transition between two
  // things it's guessing at, which is close to what caused the original
  // "mind fucked" morph in the first place — the model doesn't know
  // these are different products, so it tries to make them one.
  let visionGroundingBlock = "";
  if (willCombine && images?.length > 1) {
    const descriptions = await analyzeImagesForVideo(images, { apiKey, visionModel, costMeta });
    if (descriptions) {
      const validDescriptions = descriptions.map((d, i) => (d ? `Image ${i + 1}: ${d}` : null)).filter(Boolean);
      if (validDescriptions.length > 1) {
        visionGroundingBlock = `\nWHAT'S ACTUALLY IN EACH REFERENCE IMAGE (from direct visual analysis, not a guess):\n${validDescriptions.join("\n")}\nUse this to write the MULTI-SCENE STRUCTURE above concretely and correctly — if these describe clearly different products/colors/patterns, your cut/sequence/mirror description MUST name what's actually different (e.g. "cuts from the sky-blue silk to the deep red silk") rather than a vague placeholder. If they're actually the same product from different angles, say so and a gentler transition (or no hard cut) is fine instead.`;
      }
    }
  }
  try {
    const effectiveDurationForPrompt = durationSeconds || 4;
    const prompt = `You are a video-prompt specialist for a commercial product photography/video tool. Turn this rough creative direction into ONE polished, technically detailed video-generation prompt (2-4 sentences) describing camera movement, subject motion, pacing, and mood for a short commercial product clip.
PRODUCT: ${productLabel || "the product"} for brand "${brandName || ""}".
SCENE CONTEXT: ${environment || "a clean commercial setting"}.
CLIP LENGTH: exactly ${effectiveDurationForPrompt} seconds.
ROUGH DIRECTION FROM USER:
${rough}
LIVELY & COMPLETE — MANDATORY, regardless of clip length: describe genuine motion and energy — camera movement AND subject/product movement, never a flat, static hold. ${willCombine ? "Given the multi-scene structure below, each distinct beat/segment should read as its own small complete gesture — not the whole clip forced into one unbroken motion." : "The described action must also read as ONE complete visual beat that clearly begins and resolves within these " + effectiveDurationForPrompt + " seconds — never open mid-action, and never leave the motion hanging unresolved when the clip ends."} The FINAL second specifically must show the motion settling into a clean resting position or a deliberate hold — never caught mid-gesture, mid-turn, or freeze-framed awkwardly. Pace the action to actually fit ${effectiveDurationForPrompt} seconds: a short clip needs a more compact, punchier beat, not an excerpt of a longer motion cut short.
CRITICAL — PRESERVE CONCEALMENT IF PRESENT: if the rough direction describes a silhouette, shadow, backlit, cropped, or otherwise obscured/concealed treatment of a person, that concealment is INTENTIONAL and must be preserved exactly — do not sharpen, clarify, reveal, or "improve" it into a direct clear view. Keep the framing/lighting technique that creates the concealment central to your polished prompt, not incidental.${concealedTreatmentRule}${combineStructureRule}${visionGroundingBlock}${seedanceTaggingRule}${likenessAwareness}
AVOID GENERIC/FORMULAIC PHRASING: this is a real, specific product in a real, specific setting — write like you're describing THIS shot, not assembling stock phrases. Concretely:
  - Don't default to the same handful of camera-move words every time ("slow push-in", "gentle orbit") unless that's genuinely the best fit — name the SPECIFIC thing happening: what exactly moves, what catches light, what texture becomes visible as the camera changes position.
  - Ground the motion in the ACTUAL product/material described above and in the vision-grounding notes if present — reference its real color, pattern, or texture rather than generic words like "elegant fabric" or "luxurious material" that could describe anything.
  - Vary sentence rhythm — not every clip needs the same three-beat structure (establish, push in, settle). Let the actual content dictate the shape.
  - One specific, sensory detail (a highlight catching a particular color, a fold settling a particular way) does more work than three generic adjectives ("stunning", "beautiful", "premium") stacked together.
Rules: tasteful and brand-safe, same safety principles as commercial photography — no explicit content, no real public figures, no minors in any suggestive framing. Describe camera motion concretely (e.g. "slow push-in", "orbit left to right", "static locked-off shot with subtle product rotation"). Do not invent on-screen text or dialogue. Return ONLY the final prompt text — no preamble, no quotes, no markdown.`;
    const response = await falTextRequest(prompt, { model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.7, costMeta: { ...costMeta, endpoint: "enhance-video-prompt" } });
    return response.text.trim();
  } catch (enhanceErr) {
    console.warn(`[Video Prompt] AI enhancement failed (${enhanceErr.message}) — falling back to the raw direction.`);
    return rough;
  }
}

const VIDEO_CAMERA_MOVE_POOL = ["push_in", "orbit", "pull_out", "handheld", "pan_left", "pan_right", "static"];
function buildVideoCameraSequence(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(VIDEO_CAMERA_MOVE_POOL[i % VIDEO_CAMERA_MOVE_POOL.length]);
  return out;
}

async function buildVideoCreativeBrief({ items, mode, brandName, productLabel, environment, brandProfile, durationSeconds }, { apiKey, textModel, costMeta }) {
  const moderationFields = {};
  items.forEach((it, i) => {
    moderationFields[`item${i}_note`] = it.userNote || "";
  });
  let moderation = { blocked: false, flaggedFields: [], softenedFields: {} };
  try {
    moderation = await moderateCreativeInputs(moderationFields, { apiKey, textModel, costMeta });
  } catch (modErr) {
    console.warn(`[Video Brief] Moderation pre-check failed (${modErr.message}) — proceeding without softening.`);
  }
  if (moderation.blocked) {
    const err = new Error(moderation.blockedReason || "This video brief can't be fulfilled as described.");
    err.isSafetyBlock = true;
    throw err;
  }
  const itemListText = items
    .map((it, i) => {
      const safeNote = moderation.softenedFields?.[`item${i}_note`] || it.userNote || "";
      return `Shot ${i}: ${it.label || "product"}${safeNote ? ` — user's rough direction: ${safeNote}` : " — no specific direction given, use your best creative judgment"}`;
    })
    .join("\n");
  const modeInstruction =
    mode === "combined"
      ? `MODE: ONE combined video using multiple reference images, which do NOT need to blend into one continuous motion. Use real editing structure instead — a deliberate cut/transition from one subject to the next partway through, a sequential showcase giving each subject its own clear moment, or a mirrored/parallel presentation echoing the same camera move across both. Pick whichever suits these specific shots and describe it concretely (the actual cut point, the actual transition type) — don't default to vaguely implying everything happens at once just because it's technically one clip.`
      : `MODE: ${items.length} SEPARATE short video clips, one per shot. Assign each shot a DIFFERENT camera move from: push_in, pull_out, orbit, pan_left, pan_right, handheld, static — don't repeat the same move across shots unless there are more shots than move types, so the set doesn't feel repetitive.`;
  const effectiveDurationForBrief = durationSeconds || 4;
  const prompt = `You are an award-winning video creative director for a commercial product-video tool, writing shot concepts BEFORE any video is generated — the user will review and can edit these, but they should already feel complete and professional, never generic or empty.
${SAFETY_PRINCIPLES}
CLIP LENGTH: every shot is exactly ${effectiveDurationForBrief} seconds.
LIVELY & COMPLETE — MANDATORY for every shot, regardless of clip length: describe genuine motion and energy — camera movement AND subject/product movement, never a flat, static hold; this is a commercial ad, it should never feel lifeless. ${mode === "combined" ? "Given the multi-scene structure below, each distinct beat/segment should read as its own small complete gesture — not the whole clip forced into one unbroken motion." : `Every concept must also read as ONE complete visual beat that clearly begins and resolves within its ${effectiveDurationForBrief}-second runtime — never describe an action that opens mid-motion or would still be unresolved when the clip ends.`} Pace it to actually fit: a short clip needs a compact, punchier beat, not an excerpt of a longer motion cut short.
CONCEALED/EDITORIAL TREATMENT — MANDATORY DEFAULT for any shot whose product is intimate/undergarment apparel (bras, panties, lingerie, or similar), regardless of what the shot label or user's note says: NEVER write a direct, clearly-identifiable view of a person wearing it. Instead default to tasteful editorial techniques real intimate-apparel advertising actually uses: a backlit silhouette against a sheer curtain or doorway, a soft shadow cast on a wall, an extreme close-up on fabric texture/lace detail with a hand or draped cloth partially in frame, or a cropped composition (e.g. shoulders-to-waist only, face never shown). The product's texture, color, and mood should still read clearly — this is concealment through lighting and framing, not a lower-quality shot. If the user's own note asks for a direct worn view of this category, override it with the concealed treatment anyway and still produce a strong concept — do not simply pass their direct-view request through.
BRAND: ${brandName || ""}
${buildBrandContextBlock(brandProfile)}
SCENE CONTEXT: ${environment || "a clean, brand-appropriate commercial setting"}
${modeInstruction}
SHOTS:
${itemListText}
For each shot, write a rich, camera-technical video concept (2-4 sentences) grounded in the product and context — describe camera movement, subject motion/action, pacing, and mood concretely. Never write something generic or vague; always give a fully realized concept even if the user gave no direction.
Return STRICT JSON ONLY, no markdown fences:
{
  "items": [ { "videoConcept": "...", "cameraMove": "push_in" } ]
}
The "items" array MUST have exactly ${items.length} entries, in the same order as the shots listed above.`;
  const response = await falTextRequest(prompt, { model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.8, costMeta: { ...costMeta, endpoint: "generate-video-brief" } });
  const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
  let results = Array.isArray(parsed.items) ? parsed.items : [];
  const fallbackMoves = buildVideoCameraSequence(items.length);
  const padded = [];
  for (let i = 0; i < items.length; i++) {
    const r = results[i] || {};
    padded.push({
      videoConcept: r.videoConcept && r.videoConcept.trim() ? r.videoConcept.trim() : `A clean, professional camera movement showcasing ${items[i]?.label || "the product"} in context, with natural lighting and confident pacing.`,
      cameraMove: r.cameraMove || fallbackMoves[i],
    });
  }
  return {
    items: padded,
    moderationNote: moderation.flaggedFields?.length ? `Some of your input was adjusted to keep things tasteful: ${moderation.flaggedFields.join(", ")}.` : null,
  };
}

app.post("/api/generate-video", async (req, res) => {
  let runId;
  try {
    const {
      mode,
      items,
      combined,
      aspectRatio,
      brandName,
      productLabel,
      environment,
      videoModel,
      videoTier,
      userApiKey,
      textModel,
      runId: clientRunId,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    const effectiveVideoModel = resolveVideoModelChoice(videoModel, videoTier);
    const effectiveTextModel = textModel || DEFAULT_TEXT_MODEL;
    const results = [];
    const errors = [];
    if (mode === "combined") {
      if (!combined?.images?.length) return res.status(400).json({ error: "No shots provided for combined video." });
      progress.startProgress(runId, "rendering-video", "Preparing the combined video brief...");
      try {
        const enhancedPrompt = await buildVideoPrompt(
          {
            creativeDirection: combined.creativeDirection,
            cameraMove: combined.cameraMove,
            styleNote: combined.styleNote,
            productLabel,
            brandName,
            environment,
            aiEnhance: combined.aiEnhance !== false,
            durationSeconds: combined.durationSeconds,
            videoModel: effectiveVideoModel,
            imageCount: combined.images.length,
            images: combined.images,
            visionModel: req.body.visionModel,
          },
          { apiKey, textModel: effectiveTextModel, costMeta: { runId } },
        );
        const useEndFrame = combined.useEndFrame && combined.images.length === 2;
        const clip = await generateVideoClipWithRetry(
          {
            prompt: enhancedPrompt,
            imageBase64: combined.images[0],
            // End-frame mode animates FROM the first image TO the second
            // — that's a different feature from reference-combine, so
            // only the start image goes through as a "reference" here;
            // passing both would also trigger the combine/reference
            // endpoint routing, which is the wrong mechanism for this.
            referenceImages: useEndFrame ? [combined.images[0]] : combined.images,
            endImageBase64: useEndFrame ? combined.images[1] : null,
            aspectRatio,
            durationSeconds: combined.durationSeconds,
            negativePrompt: combined.negativePrompt,
            videoModel: effectiveVideoModel,
            generateAudio: combined.generateAudio,
          },
          { runId, apiKey, textModel: effectiveTextModel, costMeta: { runId, endpoint: "generate-video" }, destFilename: `${runId}-combined.mp4`, detailPrefix: "Rendering combined video" },
          { productLabel, brandName, environment },
        );
        results.push({
          url: clip.url,
          modelUsed: clip.modelUsed,
          label: "Combined video",
          prompt: clip.finalPrompt,
          rewritten: clip.wasRewritten,
          usedReferenceImages: clip.usedReferenceImages,
          referenceImageCount: combined.images.length,
          sourceImages: combined.images,
          videoModel: effectiveVideoModel,
          videoMode: "combined",
          aspectRatio,
          durationSeconds: combined.durationSeconds,
          generateAudio: combined.generateAudio !== false,
          note:
            clip.fallbackNote ||
            clip.videoReplacementNote ||
            (clip.usedReferenceImages
              ? (() => {
                  const maxImages = getVideoModel(effectiveVideoModel)?.combine?.maxImages || 3;
                  const used = Math.min(combined.images.length, maxImages);
                  return `Anchored on all ${used} selected shot(s)${combined.images.length > maxImages ? ` (this model's combine cap is ${maxImages} — the rest informed the text description only)` : ""}.`;
                })()
              : combined.images.length > 1
                ? `This video model doesn't support multi-image combining — anchored on a single image (the first selected shot); the others informed the text description only.`
                : null),
        });
      } catch (err) {
        errors.push({ item: "combined", message: err.message });
      }
    } else {
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No shots selected for video." });
      const trimmedItems = items.slice(0, MAX_VIDEO_ITEMS);
      if (items.length > trimmedItems.length) {
        console.warn(`[Video] ${items.length} shots requested — only rendering the first ${MAX_VIDEO_ITEMS} to control cost.`);
      }
      progress.startProgress(runId, "rendering-video", `Starting ${trimmedItems.length} video render(s)...`);
      const alreadyDone = db.getCompletedRunItems(runId, "video");
      if (alreadyDone.size > 0) console.log(`[Video] Resuming run ${runId} — ${alreadyDone.size} shot(s) already completed, skipping (no new cost).`);
      for (let i = 0; i < trimmedItems.length; i++) {
        const it = trimmedItems[i];
        const cached = alreadyDone.get(String(i));
        if (cached) {
          results.push({ ...cached, sourceIndex: i, resumed: true });
          continue;
        }
        progress.updateProgress(runId, "rendering-video", `Shot ${i + 1} of ${trimmedItems.length}: writing the motion prompt...`);
        try {
          const enhancedPrompt = await buildVideoPrompt(
            {
              creativeDirection: it.creativeDirection,
              cameraMove: it.cameraMove,
              styleNote: it.styleNote,
              productLabel: it.label || productLabel,
              brandName,
              environment,
              aiEnhance: it.aiEnhance !== false,
              durationSeconds: it.durationSeconds,
              videoModel: it.videoModel || effectiveVideoModel,
              imageCount: 1,
            },
            { apiKey, textModel: effectiveTextModel, costMeta: { runId, frameIndex: i } },
          );
          const clip = await generateVideoClipWithRetry(
            {
              prompt: enhancedPrompt,
              imageBase64: it.image,
              aspectRatio,
              durationSeconds: it.durationSeconds,
              negativePrompt: it.negativePrompt,
              videoModel: it.videoModel || effectiveVideoModel,
              generateAudio: it.generateAudio,
            },
            { runId, apiKey, textModel: effectiveTextModel, costMeta: { runId, endpoint: "generate-video", frameIndex: i }, destFilename: `${runId}-${i}.mp4`, detailPrefix: `Shot ${i + 1} of ${trimmedItems.length}` },
            { productLabel: it.label || productLabel, brandName, environment },
          );
          const payload = {
            url: clip.url,
            modelUsed: clip.modelUsed,
            label: it.label || `Shot ${i + 1}`,
            prompt: clip.finalPrompt,
            rewritten: clip.wasRewritten,
            sourceImages: [it.image],
            videoModel: it.videoModel || effectiveVideoModel,
            videoMode: "separate",
            aspectRatio,
            durationSeconds: it.durationSeconds,
            generateAudio: it.generateAudio !== false,
          };
          db.saveRunItem({ runId, itemType: "video", itemKey: i, status: "success", payload });
          results.push({ ...payload, sourceIndex: i });
        } catch (err) {
          db.saveRunItem({ runId, itemType: "video", itemKey: i, status: "error", note: err.message });
          console.warn(`[Video] Shot ${i + 1} failed: ${err.message}`);
          errors.push({ item: i, message: `${it.label || `Shot ${i + 1}`}: ${err.message}` });
          const status = err.status || err.response?.status;
          const looksSystemic = status === 401 || status === 403 || status === 429 || /billing|quota|permission|not.?enabled|tier|resource_exhausted/i.test(err.message || "");
          if (looksSystemic) {
            const isSpendLimit = status === 429 || /quota|resource_exhausted/i.test(err.message || "");
            const guidance = isSpendLimit
              ? `This looks like Fal's rate/spend limit. Wait a bit and retry, switch to a cheaper video model to fit more clips under the same cap, or check your usage at https://fal.ai/dashboard/billing.`
              : `This looks like an account/billing issue rather than something wrong with a specific shot.`;
            console.warn(`[Video] Aborting the rest of this batch — this looks account/billing-related, not per-shot.`);
            errors.push({ item: "batch", message: `Stopped after ${i + 1} shot(s) — ${guidance} Already-succeeded shots above won't be re-billed on retry.` });
            break;
          }
        }
      }
    }
    if (results.length === 0) {
      progress.failProgress(runId, "No videos were generated successfully.");
      return res.status(500).json({ error: "No videos were generated successfully.", errors });
    }
    progress.finishProgress(runId);
    res.json({ runId, videos: results, errors });
  } catch (error) {
    console.error("Video generation error:", error);
    progress.failProgress(runId, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate-video-brief", async (req, res) => {
  try {
    const { mode, items, brandName, productLabel, environment, brandProfile, durationSeconds, userApiKey, textModel } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No shots provided." });
    const brief = await buildVideoCreativeBrief(
      { items, mode, brandName, productLabel, environment, brandProfile, durationSeconds },
      { apiKey, textModel: textModel || DEFAULT_TEXT_MODEL, costMeta: { endpoint: "generate-video-brief" } },
    );
    res.json(brief);
  } catch (error) {
    console.error("Video brief error:", error);
    if (error.isSafetyBlock) return res.status(403).json({ error: error.message });
    res.status(500).json({ error: "Failed to generate video creative brief: " + error.message });
  }
});

// ============================================================
// BATCH MODE — migrated to Fal
// ============================================================
app.post("/api/generate-batch-text", async (req, res) => {
  let runId;
  try {
    const {
      brandName,
      productDescription,
      usageContext,
      creativeDirection,
      negativeDirectives,
      productImages,
      productImagesForClassification,
      productLabels,
      productDimensions,
      includeHuman,
      modelAppearance,
      modelExpression,
      modelWardrobe,
      modelBodyType,
      modelPose,
      poseFreedom,
      modelReferenceBase64: rawModelReferenceBase64,
      brandProfile,
      userApiKey,
      textModel,
      runId: clientRunId,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!Array.isArray(productImages) || productImages.length === 0) return res.status(400).json({ error: "Upload at least one product image." });
    if (productImages.length > MAX_BATCH_GARMENTS) return res.status(400).json({ error: `Batch mode supports up to ${MAX_BATCH_GARMENTS} products per run.` });
    const wantsHuman = includeHuman !== false;
    const effectiveTextModel = textModel || DEFAULT_TEXT_MODEL;
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "moderating", "Checking your batch brief for anything that needs softening...");
    let moderation;
    try {
      moderation = await moderateCreativeInputs(
        { productDescription, usageContext, creativeDirection, negativeDirectives, modelAppearance, modelExpression, modelWardrobe, modelBodyType, modelPose },
        { apiKey, textModel: effectiveTextModel, costMeta: { runId } },
      );
    } catch (modErr) {
      moderation = { blocked: false, flaggedFields: [], softenedFields: {} };
    }
    if (moderation.blocked) return res.status(403).json({ error: moderation.blockedReason || "This request can't be fulfilled as described." });
    const softened = moderation.softenedFields || {};
    const safeProductDescription = softened.productDescription || productDescription;
    const safeCreativeDirection = softened.creativeDirection || creativeDirection;
    const safeUsageContext = softened.usageContext || usageContext;
    const safeModelAppearance = softened.modelAppearance || modelAppearance;
    const safeModelExpression = softened.modelExpression || modelExpression;
    const safeModelWardrobe = softened.modelWardrobe || modelWardrobe;
    const safeModelPose = softened.modelPose || modelPose;
    const safeNegativeDirectives = softened.negativeDirectives || negativeDirectives;
    progress.updateProgress(runId, "writing", `Analyzing ${productImages.length} product(s) and planning one cohesive shoot...`);
    const productListText = productImages
      .map((_, i) => {
        const userDim = Array.isArray(productDimensions) && productDimensions[i] && productDimensions[i].trim() ? ` [USER-PROVIDED DIMENSIONS: ${productDimensions[i].trim()} — treat as ground truth]` : "";
        return `Product ${i}: ${productLabels?.[i] ? productLabels[i] : "(no label given — identify it visually)"}${userDim}`;
      })
      .join("\n");
    const humanBriefBlock = wantsHuman
      ? `MODEL: this batch uses ONE shared model, reused across every product. Target profile: ${safeModelAppearance || "Brand-appropriate, decide freely"}. Body type/build: ${modelBodyType || "natural, realistic proportions — avoid an unrealistically thin idealized frame"}. Vibe: ${safeModelExpression || "decide what fits the brand"}. Base wardrobe/styling direction: ${safeModelWardrobe || "decide what fits the brand"}. Pose/interaction style guidance: ${safeModelPose || "decide what fits the brief"}. ${buildPoseFreedomConstraint(poseFreedom)} For EACH product, decide independently how a person would naturally relate to it.`
      : `NO HUMAN: this is a pure product-only catalog batch — no person anywhere in any shot.`;
    const batchPromptText = `You are simulating a full award-winning creative agency, acting as both art director AND safety reviewer for a MULTI-PRODUCT batch shoot — ${wantsHuman ? "ONE model will be shown with each" : "each"} of the following ${productImages.length} product(s) in turn, as one cohesive shoot.
${SAFETY_PRINCIPLES}
This tool must work for ANY product. Products in the same batch do NOT need to be the same type — judge each on its own.
BRAND: ${brandName}
SHARED BRIEF: ${safeProductDescription}
${buildBrandContextBlock(brandProfile)}${safeUsageContext ? `Where/how these items are actually used: ${safeUsageContext}` : ""}
Creative direction: ${safeCreativeDirection || "No specific direction given — use your best creative judgment."}
STRICT EXCLUSIONS: ${safeNegativeDirectives || "None"}
${humanBriefBlock}
PRODUCTS IN THIS BATCH (${productImages.length} images attached, in this exact order — your "items" array MUST match). Where marked with USER-PROVIDED DIMENSIONS, use that as ground truth for "estimatedRealWorldSize":
${productListText}
FOR EACH PRODUCT:
1. "actualProductMaterials": real materials/colors/motifs.
2. WEAR/USE BEHAVIOR (only meaningful for wearable items): "silhouetteLockAppropriate" (true = normal fitted item, false = draped/wrapped). If false, "wearInstructions" and, if applicable, "zonedPatternDescription". Separately: "requiresVisibleBaseLayer" and "baseLayerDescription" if a visible undergarment is needed.
ALSO for each product — PRODUCT WORN AS OUTFIT (separate question): is this product itself the primary garment/outfit a person would wear, vs. an accessory/held/used item shown alongside separate clothing? Set "productWornAsOutfit" accordingly. CRITICAL — not optional once true: if "productWornAsOutfit" is true, "imagePromptSeed" and "humanInclusionApproach" MUST describe the model actually wearing this product as the visual focus — never held, never laid out nearby, never implied via a separate garment (e.g. a robe) instead. This holds REGARDLESS of what you set "identityLockSafe" to for this product — that flag only controls how precisely/pixel-locked the compositing is, never whether she is shown wearing it. Do not default to a safer-feeling "product visible nearby" framing when this flag is true; that is a wrong answer, not a cautious one.
3. SIZE: "estimatedRealWorldSize" — concrete size + body-relative comparison. Use user-provided dimension directly if marked above; otherwise estimate visually.
${wantsHuman ? `4. "humanInclusionApproach": direct instructions for how THIS product relates to the model — if productWornAsOutfit is true, this MUST describe her wearing it.` : `4. "productOnlyDirection": creative direction for how THIS product is staged.`}
5. "identityLockSafe" per safety rules 1-6 — judge each product on its own.
6. "imagePromptSeed": one concrete scene description for THIS product${wantsHuman ? " with the model — if productWornAsOutfit is true, she MUST be depicted wearing it here, not near it" : ""}. Write like you're describing THIS specific photo, not assembling stock phrases — name this product's actual color/pattern/texture rather than generic words like "elegant" or "premium" that could describe anything; one concrete sensory detail beats three stacked adjectives.
7. If this product individually would require violating rules 1-3, set "blocked": true with "blockedReason".
Also decide, ONCE for the whole batch: "environment", "toneOfVoice", "lightingStrategy", "physicalStaging", "seedIdentity" (null if includeHuman is false or a reference photo was provided — hasModelReference is ${!!rawModelReferenceBase64}).
Also assess "modelTierRecommendation" per item: "pro" or "lite". Default to "lite" — it's meaningfully cheaper and handles most products well, including most jewelry, apparel, and premium/luxury goods. Recommend "pro" ONLY when THIS SPECIFIC product visibly has fine repeating pattern/texture detail a lower-fidelity render would blur or simplify wrong — dense embroidery, a fine jaal/lattice weave, small repeating jewelry filigree, or an intricate border pattern needing exact repeat spacing. Being expensive or premium-branded is NOT a reason on its own — judge actual visual complexity, not price tier. "Not sure" defaults to "lite". Judge each product independently — one product in this batch needing "pro" says nothing about whether any other product in the same batch needs it.
Return STRICT JSON ONLY, no markdown fences:
{
  "environment": "...", "toneOfVoice": "...", "lightingStrategy": "...", "physicalStaging": "...", "seedIdentity": null,
  "captions": ["one per product, same order"], "tags": ["#..."],
  "batchBlocked": false, "batchBlockedReason": null,
  "items": [
    {
      "productLabel": "...", "actualProductMaterials": "...",
      "silhouetteLockAppropriate": true, "wearBehaviorReasoning": null, "wearInstructions": null, "zonedPatternDescription": null,
      "requiresVisibleBaseLayer": false, "baseLayerDescription": null,
      "productWornAsOutfit": false,
      "estimatedRealWorldSize": "...",
      "modelTierRecommendation": "lite",
      "modelTierReasoning": "one short sentence — what specifically drove this choice, so it's auditable, not a black box",
      "identityLockSafe": true,
      "humanInclusionApproach": null, "productOnlyDirection": null,
      "sensitivityNotes": "none", "imagePromptSeed": "...",
      "blocked": false, "blockedReason": null
    }
  ]
}
The "items" array MUST have exactly ${productImages.length} entries, in the same order as the attached images.`;
    const classificationSourceImages =
      Array.isArray(productImagesForClassification) && productImagesForClassification.length === productImages.length
        ? productImagesForClassification
        : productImages;
    const batchTextResponse = await falTextRequest(batchPromptText, {
      model: effectiveTextModel,
      apiKey,
      temperature: 0.7,
      imageDataUris: classificationSourceImages,
      costMeta: { runId, endpoint: "generate-batch-text", imageCount: productImages.length },
    });
    const batchParsed = JSON.parse(batchTextResponse.text.replace(/```json|```/g, "").trim());
    if (batchParsed.batchBlocked) return res.status(403).json({ error: batchParsed.batchBlockedReason || "This batch can't be fulfilled as described." });
    let itemClassifications = Array.isArray(batchParsed.items) ? batchParsed.items : [];
    if (itemClassifications.length !== productImages.length) {
      const fallback = {
        productLabel: "Unclassified product",
        silhouetteLockAppropriate: true,
        identityLockSafe: true,
        productWornAsOutfit: false,
        imagePromptSeed: safeProductDescription || "the product, presented naturally",
      };
      while (itemClassifications.length < productImages.length) itemClassifications.push({ ...fallback });
      itemClassifications = itemClassifications.slice(0, productImages.length);
    }
    itemClassifications.forEach((it, i) => {
      if (Array.isArray(productDimensions) && productDimensions[i] && productDimensions[i].trim()) it.dimensionsSource = "user-provided";
      else if (!it.dimensionsSource) it.dimensionsSource = "ai-estimated";
      if (typeof it.productWornAsOutfit !== "boolean") it.productWornAsOutfit = false;
      if (typeof it.silhouetteLockAppropriate !== "boolean") it.silhouetteLockAppropriate = true;
      if (!it.modelTierReasoning) it.modelTierReasoning = "(no reasoning given by the AI for this choice)";
      enforceIntimateSensitiveSafety(it, `${productLabels?.[i] || ""} ${it.productLabel || ""} ${safeProductDescription || ""}`);
    });
    try {
      db.saveCampaign({
        runId,
        mode: "batch",
        brandName,
        productDescription: safeProductDescription,
        creativeDirection: safeCreativeDirection,
        environment: batchParsed.environment,
        seedIdentity: batchParsed.seedIdentity,
        classification: {},
        imagePrompts: [],
        promptTypes: [],
        extra: {
          items: itemClassifications,
          productLabels,
          includeHuman: wantsHuman,
          toneOfVoice: batchParsed.toneOfVoice,
          lightingStrategy: batchParsed.lightingStrategy,
          physicalStaging: batchParsed.physicalStaging,
          captions: batchParsed.captions,
          tags: batchParsed.tags,
        },
      });
    } catch (saveErr) {
      console.warn(`[Campaigns] Failed to save batch campaign ${runId}: ${saveErr.message}`);
    }
    progress.finishProgress(runId);
    res.json({
      runId,
      environment: batchParsed.environment || "high-end minimalist studio, seamless neutral backdrop",
      toneOfVoice: batchParsed.toneOfVoice,
      lightingStrategy: batchParsed.lightingStrategy,
      physicalStaging: batchParsed.physicalStaging,
      seedIdentity: batchParsed.seedIdentity,
      captions: batchParsed.captions || [],
      tags: batchParsed.tags || [],
      items: itemClassifications,
      moderationNote: moderation.flaggedFields?.length ? `Some of your input was adjusted to keep things tasteful: ${moderation.flaggedFields.join(", ")}.` : null,
    });
  } catch (error) {
    console.error("Batch text error:", error);
    progress.failProgress(runId, error.message);
    const status = error.status || error.response?.status;
    if (status === 429) return res.status(429).json({ error: "Fal's rate limit was hit. Wait a bit and retry, or check your usage at https://fal.ai/dashboard/billing." });
    res.status(500).json({ error: "Failed to analyze batch: " + error.message });
  }
});

app.post("/api/generate-batch-images", async (req, res) => {
  let runId;
  const routeStartedAt = Date.now();
  try {
    const {
      productImages,
      productLabels,
      items,
      environment,
      toneOfVoice,
      lightingStrategy,
      physicalStaging,
      seedIdentity,
      includeHuman,
      shotsPerItem: rawShotsPerItem,
      backgroundConsistent,
      lockWardrobe,
      aspectRatio,
      modelReferenceBase64: rawModelReferenceBase64,
      matchReferenceOutfit,
      subjectSelectionNote,
      imageModel,
      frameModels, // per-product image model override, index-matched to productImages
      modelTier,
      imageResolution,
      skipCanonicalRender,
      userApiKey,
      runId: clientRunId,
      seed,
    } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!Array.isArray(productImages) || productImages.length === 0) return res.status(400).json({ error: "No product images provided." });
    if (!Array.isArray(items) || items.length !== productImages.length) return res.status(400).json({ error: "Product classification data is missing or mismatched — go back to Step 1." });
    const wantsHuman = includeHuman !== false;
    const shotsPerItem = Math.max(1, Math.min(parseInt(rawShotsPerItem) || 1, MAX_SHOTS_PER_GARMENT));
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "rendering-item", "Starting the batch render...");
    let itemClassifications = items;
    const anyItemBlocked = itemClassifications.some((it) => it.blocked);
    if (anyItemBlocked && itemClassifications.every((it) => it.blocked)) {
      return res.status(403).json({ error: "Every product in this batch was flagged and none could be fulfilled." });
    }
    const env = environment || "high-end minimalist studio, seamless neutral backdrop";
    const sharedProfileFields = { lightingStrategy, physicalStaging };
    const costMeta = { runId, endpoint: "generate-batch-images" };
    const { preferred: preferredModel, alternate: alternateModel } = resolveImageModels(
      null, // used only for the shared identity-portrait calls below (not product-specific) — per-product rendering gets its OWN tier decision per item, see itemPreferredModel in the loop
      imageModel,
      modelTier,
    );
    const resolution = imageResolution || DEFAULT_IMAGE_RESOLUTION;
    // Same real capability as single mode — reusing one seed across a
    // batch's multiple products/frames is a real lever for consistent
    // look across the whole campaign, on top of the shared environment/
    // lighting/identity already locked. Only sent for models confirmed
    // to support it (see buildFalImageInput).
    const resolvedSeed = seed != null && seed !== "" ? parseInt(seed) : null;
    let identityImage = null;
    let identityNote = null;
    if (wantsHuman) {
      if (rawModelReferenceBase64 && matchReferenceOutfit) {
        identityImage = rawModelReferenceBase64;
      } else if (rawModelReferenceBase64) {
        progress.updateProgress(runId, "sanitizing-reference", "Preparing a neutral-wardrobe identity portrait from your reference photo...");
        try {
          const sanitizeResult = await generateNeutralIdentityPortrait(rawModelReferenceBase64, subjectSelectionNote, costMeta, { apiKey, preferredModel, alternateModel, resolution });
          identityImage = sanitizeResult.image;
          if (sanitizeResult.usedFallback) identityNote = sanitizeResult.fallbackReason;
        } catch (sanitizeErr) {
          console.warn(`[Batch Identity] Reference sanitize failed: ${sanitizeErr.message}`);
        }
      }
      if (!identityImage) {
        progress.updateProgress(runId, "casting", "Generating the shared model identity for this batch...");
        try {
          const identityResult = await generateSyntheticIdentity({ seedIdentity, environment: env }, costMeta, { apiKey, preferredModel, alternateModel, resolution });
          identityImage = identityResult.image;
          if (identityResult.usedFallback) identityNote = identityResult.fallbackReason;
        } catch (identErr) {
          identityNote = [identityNote, `Could not generate a shared model identity (${identErr.message}) — human frames in this batch will render product-only instead.`].filter(Boolean).join(" ");
        }
      }
    }
    const results = new Array(productImages.length).fill(null);
    const itemErrors = [];
    const verificationWarnings = []; // separate from itemErrors on purpose — these are successful generations flagged for review, not failures
    let baseImageForSwap = null;
    let baseImageForSwapHasHuman = false;
    let usedSyntheticFallbackForBatch = false;
    let completedShots = 0;
    const totalShots = productImages.length * shotsPerItem;
    const resumedItems = db.getCompletedRunItems(runId, "batch_item");
    for (let pi = 0; pi < productImages.length; pi++) {
      const cachedItem = resumedItems.get(String(pi));
      if (cachedItem) {
        results[pi] = cachedItem;
        completedShots += cachedItem.images?.length || 0;
        continue;
      }
      const classification = { ...itemClassifications[pi], ...sharedProfileFields };
      if (classification.blocked) {
        itemErrors.push({ item: pi, message: classification.blockedReason || "This product was flagged and skipped." });
        continue;
      }
      const itemCostMeta = { ...costMeta, frameIndex: pi };
      // Per-product model override (from a per-product-card dropdown in
      // the UI) takes priority; otherwise each product gets ITS OWN tier
      // decision from ITS OWN classification via resolveImageModels/
      // resolvePreferLite — not a blanket batch-wide decision.
      //
      // THE ACTUAL BUG THIS FIXES: the previous logic required EVERY
      // product in the batch to be individually classified "lite" before
      // ANY of them would use the cheap tier — one "pro"-classified (or
      // even just unclassified) product anywhere in the batch silently
      // forced nano-banana-pro for every other product too. Confirmed
      // directly against a real Fal billing dashboard: nano-banana-pro/
      // edit was overwhelmingly the dominant cost line, with the
      // intended cheap default (nano-banana-2/edit) not appearing at
      // all — exactly what this all-or-nothing check would produce.
      const { preferred: itemPreferredModel, alternate: itemAlternateModel } = resolveImageModels(
        itemClassifications[pi],
        frameModels?.[pi] || imageModel,
        modelTier,
      );
      progress.updateProgress(runId, "rendering-item", `Product ${pi + 1} of ${productImages.length}: rendering canonical product photo with ${itemPreferredModel}...`);
      let lockedProductImageForItem;
      try {
        const productResult = await generateLockedProductRender(productImages[pi].replace(/^data:image\/\w+;base64,/, ""), itemCostMeta, {
          apiKey,
          preferredModel: itemPreferredModel,
          alternateModel: itemAlternateModel,
          estimatedRealWorldSize: classification.estimatedRealWorldSize,
          skipRerender: skipCanonicalRender,
        });
        lockedProductImageForItem = productResult.image;
      } catch (productErr) {
        itemErrors.push({ item: pi, message: `Failed to render this product's canonical product photo: ${productErr.message}` });
        continue;
      }
      const isAnatomical = wantsHuman && classification.identityLockSafe !== false && !!identityImage;
      const wantsNarrativeHuman = wantsHuman && classification.identityLockSafe === false && !!identityImage;
      const wardrobeDirective = lockWardrobe ? null : "style this product's own accessory/wardrobe context naturally for this shot, without forcing an identical look to other products in the batch";
      const shotImages = [];
      let baseShotImage = null;
      let baseShotModelUsed = null;
      let renderedWithHuman = false;
      let humanDropNote = null;
      if (isAnatomical) {
        try {
          if (pi === 0 || !backgroundConsistent || !baseImageForSwap || !baseImageForSwapHasHuman) {
            progress.updateProgress(runId, "compositing", `Product ${pi + 1} of ${productImages.length}: compositing model + product + scene with ${itemPreferredModel}...`);
            const compositeResult = await compositeIdentityWithProduct(
              { lockedIdentityImage: identityImage, lockedProductImage: lockedProductImageForItem, environment: env, aspectRatio, creativeProfile: classification, subjectSelectionNote, wardrobeDirective, preferredModel: itemPreferredModel, alternateModel: itemAlternateModel, resolution },
              itemCostMeta,
              apiKey,
            );
            baseShotImage = compositeResult.image;
            baseShotModelUsed = compositeResult.modelUsed;
            baseImageForSwap = baseShotImage;
            baseImageForSwapHasHuman = true;
          } else {
            progress.updateProgress(runId, "product-swap", `Product ${pi + 1} of ${productImages.length}: swapping into the locked scene with ${itemPreferredModel}...`);
            const swapResult = await compositeProductSwap(
              { baseImage: baseImageForSwap, lockedProductImage: lockedProductImageForItem, itemClassification: classification, aspectRatio, hasHuman: true, preferredModel: itemPreferredModel, alternateModel: itemAlternateModel, resolution },
              itemCostMeta,
              apiKey,
            );
            baseShotImage = swapResult.image;
            baseShotModelUsed = swapResult.modelUsed;
          }
          renderedWithHuman = true;
          // Verification gate — only for the highest-stakes requirement
          // (a product that MUST be shown worn, not just held/nearby —
          // this exact case has been a real, recurring concern this
          // build). Adaptively sampled via db.js's trust-caching: a
          // model that's proven reliable for this specific requirement
          // gets spot-checked, not fully re-verified every time, so this
          // doesn't quietly double the cost of every compositing step
          // forever. Never blocks or retries automatically — surfaces
          // the mismatch as a diagnostic note so a human decides,
          // since auto-retrying on a vision judgment call risks silently
          // burning money in a loop if the check itself is wrong.
          if (classification.productWornAsOutfit === true) {
            const verification = await verifyGenerationMatchesRequirement(
              baseShotImage,
              `the model actually wearing ${classification.productLabel || "the product"} as a real garment on her body (not held in hand, not laid nearby, not draped incidentally)`,
              { modelId: baseShotModelUsed || itemPreferredModel, scenarioType: "productWornAsOutfit", apiKey, visionModel: req.body.visionModel, costMeta: itemCostMeta },
            );
            if (verification.checked && verification.passed === false) {
              verificationWarnings.push({ item: pi, productLabel: classification.productLabel, message: `The model may not actually be wearing this as required (vision check said: "${(verification.rawResponse || "").slice(0, 150)}"). The image was still generated — review it and regenerate with a different model if it looks wrong.` });
            }
          }
        } catch (compErr) {
          if (!usedSyntheticFallbackForBatch && rawModelReferenceBase64) {
            console.warn(`[Batch] Product ${pi + 1}: real reference photo failed compositing (${compErr.message}) — generating a look-alike synthetic identity for the rest of this batch.`);
            try {
              const syntheticResult = await generateSyntheticIdentity({ seedIdentity, environment: env }, costMeta, { apiKey, preferredModel: itemPreferredModel, alternateModel: itemAlternateModel, resolution });
              identityImage = syntheticResult.image;
              usedSyntheticFallbackForBatch = true;
              identityNote = [identityNote, `Your reference photo couldn't be used for compositing (${compErr.message}), so this batch switched to an AI-generated look-alike identity — faces will no longer match your uploaded photo.`].filter(Boolean).join(" ");
              const retryResult = await compositeIdentityWithProduct(
                { lockedIdentityImage: identityImage, lockedProductImage: lockedProductImageForItem, environment: env, aspectRatio, creativeProfile: classification, subjectSelectionNote, wardrobeDirective, preferredModel: itemPreferredModel, alternateModel: itemAlternateModel, resolution },
                itemCostMeta,
                apiKey,
              );
              baseShotImage = retryResult.image;
              baseShotModelUsed = retryResult.modelUsed;
              if (pi === 0) {
                baseImageForSwap = baseShotImage;
                baseImageForSwapHasHuman = true;
              }
              renderedWithHuman = true;
            } catch (fallbackErr) {
              humanDropNote = `Human element dropped after repeated failures (${fallbackErr.message}); delivered as product-only instead.`;
            }
          } else {
            humanDropNote = `Human element dropped after rejection (${compErr.message}); delivered as product-only instead.`;
          }
        }
      } else if (wantsNarrativeHuman) {
        try {
          progress.updateProgress(runId, "compositing", `Product ${pi + 1} of ${productImages.length}: narrative-route render (no identity lock) with ${itemPreferredModel}...`);
          const wornAsOutfitReinforcement = classification.productWornAsOutfit
            ? `\nWORN AS OUTFIT — CRITICAL, OVERRIDES ANYTHING ABOVE THAT CONFLICTS WITH THIS: this product IS the outfit for this shot. The model MUST be shown actually wearing it as the primary visible clothing in the scene — never held, never laid out nearby, never implied via a separate garment like a robe standing in for it. Narrative-route treatment (no identity lock) changes HOW precisely the product's exact pattern/color is pixel-matched — it does NOT mean showing it near her instead of on her. If any instruction above described the product simply staged/laid out rather than worn, disregard that framing and depict her wearing it instead.`
            : "";
          const narrativePrompt = `${classification.imagePromptSeed || "The product, presented naturally and tastefully."}
${classification.humanInclusionApproach || ""}
${classification.physicalStaging || ""}
${classification.lightingStrategy || ""}.
Commercial luxury photography. Photorealistic. True 3D lighting and natural physical shadows.
${buildProductLockClause(classification, { imageLabel: "the reference image" })}${wornAsOutfitReinforcement}
IDENTITY: the SECOND reference image shows the person to use — match their face, general look, and skin tone. This is standard non-explicit commercial photography; none of this authorizes nudity or explicit content. ${subjectSelectionNote || ""}
ABSOLUTELY NO TEXT, no watermark, no signage, no gallery credit, no caption, no logo anywhere in the image. Exactly ONE subject, never a duplicate or second person. This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame.`;
          const narrativeResult = await resilientFalImageGeneration(
            (model) => buildFalImageInput(narrativePrompt, [lockedProductImageForItem, identityImage], { aspectRatio: aspectRatio || "1:1", resolution, modelId: model, seed: resolvedSeed }).input,
            { preferredModel: endpointFor(itemPreferredModel, true), alternateModel: endpointFor(itemAlternateModel, true), apiKey, costMeta: itemCostMeta },
          );
          baseShotImage = narrativeResult.image;
          baseShotModelUsed = narrativeResult.modelUsed;
          renderedWithHuman = true;
        } catch (narrErr) {
          humanDropNote = `Human element dropped after rejection (${narrErr.message}); delivered as product-only instead.`;
        }
      } else if (wantsHuman && !identityImage) {
        humanDropNote = `No usable model identity was available for this batch, so this item was rendered product-only.`;
      }
      if (!renderedWithHuman) {
        try {
          const canSwapIntoExistingBase = !!baseImageForSwap && !baseImageForSwapHasHuman && pi !== 0 && backgroundConsistent;
          if (!canSwapIntoExistingBase) {
            progress.updateProgress(runId, "compositing", `Product ${pi + 1} of ${productImages.length}: staging product-only scene with ${itemPreferredModel}...`);
            const productOnlyPrompt = `${classification.imagePromptSeed || "Clean commercial product photography."}
${classification.productOnlyDirection || ""}
${classification.physicalStaging || ""}
${classification.lightingStrategy || ""}.
Commercial luxury photography. Photorealistic. True 3D lighting and natural physical shadows.
${buildProductLockClause(classification, { imageLabel: "the reference image" })}
SET THE ENVIRONMENT: ${env}. This is the permanent staging for the entire batch.
ABSOLUTELY NO TEXT, no watermark, no signage, no gallery credit, no caption, no logo anywhere in the image. No humans, no people, no hands. This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame.`;
            const productOnlyResult = await resilientFalImageGeneration(
              (model) => buildFalImageInput(productOnlyPrompt, [lockedProductImageForItem], { aspectRatio: aspectRatio || "1:1", resolution, modelId: model, seed: resolvedSeed }).input,
              { preferredModel: endpointFor(itemPreferredModel, true), alternateModel: endpointFor(itemAlternateModel, true), apiKey, costMeta: itemCostMeta },
            );
            baseShotImage = productOnlyResult.image;
            baseShotModelUsed = productOnlyResult.modelUsed;
            if (pi === 0 || !baseImageForSwap) {
              baseImageForSwap = baseShotImage;
              baseImageForSwapHasHuman = false;
            }
          } else {
            progress.updateProgress(runId, "product-swap", `Product ${pi + 1} of ${productImages.length}: swapping into the locked scene with ${itemPreferredModel}...`);
            const swapResult = await compositeProductSwap(
              { baseImage: baseImageForSwap, lockedProductImage: lockedProductImageForItem, itemClassification: classification, aspectRatio, hasHuman: false, preferredModel: itemPreferredModel, alternateModel: itemAlternateModel, resolution },
              itemCostMeta,
              apiKey,
            );
            baseShotImage = swapResult.image;
            baseShotModelUsed = swapResult.modelUsed;
          }
        } catch (productErr) {
          itemErrors.push({ item: pi, message: `Failed to render this product at all: ${productErr.message}` });
          continue;
        }
      }
      if (humanDropNote) itemErrors.push({ item: pi, message: humanDropNote });
      shotImages.push({ image: baseShotImage, modelUsed: baseShotModelUsed, shotType: "hero", includesHuman: renderedWithHuman });
      completedShots++;
      progress.updateProgress(runId, "rendering-frames", `${completedShots} of ${totalShots} shot(s) done...`);
      if (shotsPerItem > 1) {
        const extraShotTypes = buildShotSequence(shotsPerItem, classification.shotSequenceHint).slice(1);
        for (const shotTypeRaw of extraShotTypes) {
          const profile = composeShotProfile(shotTypeRaw, classification, renderedWithHuman);
          const lockedElementsNote = renderedWithHuman
            ? "the person's face/identity, their exact product as shown, the background/location/environment"
            : "the exact product as shown, the background/location/staging/environment";
          const reframePrompt = `DIRECTOR'S NOTE: the reference image is a fully built, locked scene. Your ONLY job this shot is to move the camera.
LOCKED — must remain pixel-faithful to the reference image: ${lockedElementsNote}.
CAMERA MOVE FOR THIS SHOT: ${profile.vibe}
${classification.lightingStrategy || ""}.
ABSOLUTELY NO TEXT, no watermark, no signage, no gallery credit, no caption, no logo anywhere in the image.${renderedWithHuman ? " Exactly ONE subject, never a duplicate or second person." : ""} This must be ONE single photograph only — never a grid, contact sheet, mosaic, storyboard, or multiple images/panels/quadrants combined into one frame.`;
          try {
            const reframeResult = await resilientFalImageGeneration(
              (model) => buildFalImageInput(reframePrompt, [baseShotImage], { aspectRatio: aspectRatio || "1:1", resolution, modelId: model, seed: resolvedSeed }).input,
              { preferredModel: endpointFor(itemPreferredModel, true), alternateModel: endpointFor(itemAlternateModel, true), apiKey, costMeta: itemCostMeta },
            );
            shotImages.push({ image: reframeResult.image, modelUsed: reframeResult.modelUsed, shotType: profile.shotType, includesHuman: renderedWithHuman });
          } catch (reframeErr) {
            itemErrors.push({ item: pi, message: `Shot type "${profile.shotType}" failed: ${reframeErr.message}` });
          }
          completedShots++;
          progress.updateProgress(runId, "rendering-frames", `${completedShots} of ${totalShots} shot(s) done...`);
        }
      }
      // Real, confirmed gap: batch results were being saved to the DB
      // with Fal's own (eventually-expiring) URLs — persistFalImage was
      // already proven for single mode's main loop but was never applied
      // here, so every batch campaign's saved images were silently going
      // dead after a few days with no way to recover them.
      for (const shot of shotImages) {
        if (shot?.image) {
          shot.image = await persistFalImage(shot.image, `${runId}-batch${pi}-${shot.shotType || "shot"}-${Date.now()}.png`);
        }
      }
      results[pi] = { index: pi, label: productLabels?.[pi] || classification.productLabel || `Product ${pi + 1}`, classification, images: shotImages };
      db.saveRunItem({ runId, itemType: "batch_item", itemKey: pi, status: "success", payload: results[pi] });
    }
    const succeededItems = results.filter(Boolean);
    if (succeededItems.length === 0) {
      progress.failProgress(runId, "No products successfully processed.");
      return res.status(500).json({ error: "No products successfully processed.", itemErrors });
    }
    progress.finishProgress(runId);
    res.json({
      runId,
      environment: env,
      toneOfVoice,
      items: succeededItems,
      diagnostics: {
        itemsRequested: productImages.length,
        itemsSucceeded: succeededItems.length,
        shotsPerItem,
        backgroundConsistent: !!backgroundConsistent,
        includeHuman: wantsHuman,
        identityNote,
        itemErrors,
        verificationWarnings,
        totalMs: Date.now() - routeStartedAt,
      },
    });
  } catch (error) {
    console.error("Batch images error:", error);
    progress.failProgress(runId, error.message);
    const status = error.status || error.response?.status;
    if (status === 429) return res.status(429).json({ error: "Fal's rate limit was hit. Wait a bit and retry, or check your usage at https://fal.ai/dashboard/billing." });
    res.status(500).json({ error: "Failed to generate batch photoshoot: " + error.message });
  }
});

// ============================================================
// UTILITY / RESUMABILITY / CREDITS / CAMPAIGNS ROUTES
// (unchanged from the original — no vendor-specific logic here)
// ============================================================
app.get("/api/run-status/:runId", (req, res) => {
  try {
    const runId = req.params.runId;
    const frames = db.getCompletedRunItems(runId, "frame");
    const batchItems = db.getCompletedRunItems(runId, "batch_item");
    const videos = db.getCompletedRunItems(runId, "video");
    const lockSet = db.getCompletedRunItems(runId, "lock_set");
    const campaign = db.getCampaign(runId);
    if (!frames.size && !batchItems.size && !videos.size && !lockSet.size && !campaign) {
      return res.status(404).json({ error: "No saved progress found for this run." });
    }
    res.json({
      runId,
      campaign,
      frames: Object.fromEntries(frames),
      batchItems: Object.fromEntries(batchItems),
      videos: Object.fromEntries(videos),
      lockSet: Object.fromEntries(lockSet),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/api/progress/:runId", (req, res) => {
  const p = progress.getProgress(req.params.runId);
  if (!p) return res.json({ stage: null, detail: null, elapsedMs: 0, done: false });
  res.json({ ...p, elapsedMs: Date.now() - p.startedAt });
});
app.get("/api/campaigns", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 200));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const { rows, total } = db.listCampaigns(limit, (page - 1) * limit);
    res.json({ campaigns: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/api/campaigns/:runId", (req, res) => {
  try {
    const campaign = db.getCampaign(req.params.runId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/api/credits/summary", (req, res) => {
  try {
    res.json(db.getSummary());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/api/credits/transactions", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 25, 500));
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const { rows, total } = db.getTransactions(limit, (page - 1) * limit);
    res.json({ transactions: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/api/credits/budget", (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount < 0) return res.status(400).json({ error: "Invalid budget amount." });
    db.setBudget(amount);
    res.json(db.getSummary());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Real Fal account balance — ground truth from Fal itself, not this
// app's own estimate-based ledger. Requires an admin-scoped Fal API key
// (see fal-billing.js); if none is configured this returns available:false
// with a clear explanation rather than a fabricated number.
app.get("/api/fal-billing/balance", async (req, res) => {
  const adminKey = req.headers["x-fal-admin-key"] || null;
  const data = await getRealBalance(adminKey);
  res.json(data);
});

// Real, paginated usage history straight from Fal — cursor-based per
// Fal's own API (not offset-based like this app's internal ledger), date
// range capped at 90 days per Fal's own limit.
app.get("/api/fal-billing/usage", async (req, res) => {
  const adminKey = req.headers["x-fal-admin-key"] || null;
  const { start, end, cursor, limit } = req.query;
  const data = await getRealUsage(adminKey, { start, end, cursor, limit: parseInt(limit) || 100 });
  res.json(data);
});

// Real per-model pricing from Fal — works with a regular (non-admin) key.
app.get("/api/fal-billing/pricing", async (req, res) => {
  const modelId = req.query.id;
  if (!modelId) return res.status(400).json({ available: false, reason: "Missing ?id=" });
  const apiKey = req.headers["x-fal-key"] || null;
  const data = await getRealPricing(modelId, apiKey);
  res.json(data);
});

// Everything the app has actually LEARNED across all models, in one
// place — real verification track records (from vision-checking actual
// outputs against stated requirements) and confirmed likeness-block
// history. This is what the frontend's trust-summary panel reads from;
// nothing here is invented for display, it's the literal data driving
// real decisions elsewhere in the app (model filtering, verification
// sampling).
app.get("/api/models/trust-summary", (req, res) => {
  try {
    // Real catalog-level status (Section 2's normalized states) for
    // every model this app currently knows about — curated and
    // discovered alike. This panel already showed generation-quality
    // trust (verificationStats) and voice-id trust (voiceCatalog), but
    // never the model catalog status itself — whether the model is even
    // still active — anywhere. Counted by state so the panel can lead
    // with an honest, calm summary line instead of only alarming counts.
    const allModelIds = [
      ...IMAGE_MODELS, ...VIDEO_MODELS, ...MUSIC_MODELS, ...SFX_MODELS,
      ...VOICE_CLONE_MODELS, ...TALKING_AVATAR_MODELS,
      ...Object.values(UTILITY_MODELS).flat(),
    ].map((m) => m.id);
    const curatedSet = new Set(allModelIds);
    const discoveredIds = getDiscoveredModels().map((m) => m.id);
    const catalogStatuses = [...curatedSet, ...discoveredIds].map((id) => ({
      id,
      source: curatedSet.has(id) ? "curated" : "discovered",
      ...FalAdapter.getStatus(id),
    }));
    const byState = {};
    catalogStatuses.forEach((m) => { byState[m.status] = (byState[m.status] || 0) + 1; });
    res.json({
      verificationStats: db.listAllVerificationStats(),
      confirmedLikenessBlockModels: db.getConfirmedLikenessBlockModels(),
      voiceCatalog: {
        status: voiceCatalog.getVoiceCatalogStatus(),
        entries: voiceCatalog.getVoiceVerificationDetails(),
      },
      catalogStatus: {
        byState,
        // Only the states actually worth a human looking at — a flat
        // list of all 60+ "selectable" models would just be noise here.
        needsAttention: catalogStatuses.filter((m) => ["deprecated", "failed", "unavailable"].includes(m.status)),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/reliability-health", (req, res) => {
  try {
    const windowHours = Math.max(0.25, Math.min(parseFloat(req.query.windowHours) || 1, 24));
    res.json(db.getReliabilityHealth(windowHours));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get("/api/videos", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    res.json({ videos: db.listRunItems("video", limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NEW — powers the frontend's model dropdowns (image + video), and tells
// it the current default text/vision reasoning models. The frontend
// fetches this once on load rather than hardcoding model IDs, so adding a
// new Fal model to fal-models.js is enough to make it selectable — no
// frontend redeploy needed.
//
// Live status (see fal-catalog.js) is merged in here: each model gets a
// `liveStatus` field ("active" | "deprecated" | "missing" | null if not
// yet checked) from a background verification against Fal's own Models
// API, not from anything hardcoded. A model Fal itself reports as
// deprecated/missing is filtered OUT of the response entirely — offering
// a dropdown option that's confirmed broken serves no one. If the
// background check hasn't completed yet (server just started, or the
// last check failed), `liveStatus` is simply absent and the model is
// still offered as normal — an unverified model is not the same as a
// broken one, so a failed/pending check never silently removes anything.
// Converts an auto-discovered model into the same shape a hand-curated
// fal-models.js entry has, so it can sit in the exact same array the
// frontend already renders — no separate UI path needed for it to
// actually show up and be selectable. Cost is a placeholder (this
// pipeline doesn't have real per-model pricing yet — that's Fal's
// separate /models/pricing endpoint, not something the browse listing
// includes) — clearly distinguishable via `costUnconfirmed: true` rather
// than presented as a real number, consistent with how every other
// unconfirmed price in this app is already handled.
function discoveredModelToRegistryShape(m) {
  const c = m.classification;
  const weight = c.editWeight || (c.workType === "creation-only" ? "lite" : null);
  return {
    id: m.id,
    label: `${m.guideMetadata?.displayName || m.id} 🆕`,
    tier: weight === "heavy" ? "pro" : "lite",
    costPerImage: weight === "heavy" ? 0.1 : 0.04, // placeholder estimate — see note above
    costUnconfirmed: true,
    maxReferenceImages: c.maxReferenceImages || undefined,
    textToImageOnly: c.workType === "creation-only",
    supportsResolutionParam: !!m.schemaInfo?.resolutionField,
    discovered: true,
    discoveredDescription: m.guideMetadata?.description || null,
    likelyHumanSupport: c.likelyHumanSupport,
    // AI-synthesized (Claude, via fal-ai/any-llm) — clearly labeled as
    // such, not presented as an equally-confirmed fact the way the
    // curated registry's hand-researched bestFor text is. null until
    // enrichDiscoveredModels has actually processed this model.
    aiEnrichment: m.aiEnrichment || null,
  };
}
app.get("/api/models", (req, res) => {
  const withLiveStatus = (models) =>
    models
      .map((m) => {
        const live = getLiveStatus(m.id);
        return live ? { ...m, liveStatus: live.status, liveCheckedAt: live.checkedAt } : m;
      })
      // Only "deprecated" is a trustworthy removal signal — Fal actually
      // HAS that entry cataloged and explicitly marked it deprecated.
      // "missing" (not found via Find Mode) turned out NOT to mean
      // "broken": Fal's discovery/Explore catalog doesn't separately
      // index every specific tier/variant endpoint (confirmed in
      // production — 9 real, working, docs-confirmed video endpoints
      // like the Lite/Fast/reference-to-video variants all came back
      // "missing" here despite being directly verified against Fal's own
      // docs pages earlier). Treating "not in the discovery index" as
      // "doesn't work" was the bug — it silently deleted most of the
      // video model registry based on a false signal. Only remove on an
      // explicit "deprecated", never on "missing".
      .filter((m) => m.liveStatus !== "deprecated");
  res.json({
    imageModels: [...withLiveStatus(IMAGE_MODELS), ...getDiscoveredModels({ mediaType: "image" }).map(discoveredModelToRegistryShape)],
    videoModels: [...withLiveStatus(VIDEO_MODELS), ...getDiscoveredModels({ mediaType: "video" }).map(discoveredModelToRegistryShape)],
    utilityModels: UTILITY_MODELS,
    voiceModels: voiceCatalog.getVerifiedVoiceModels(),
    voiceVerificationDetails: voiceCatalog.getVoiceVerificationDetails(),
    voiceCatalogStatus: voiceCatalog.getVoiceCatalogStatus(),
    voiceCloneModels: VOICE_CLONE_MODELS,
    musicModels: MUSIC_MODELS,
    musicInstruments: MUSIC_INSTRUMENTS,
    musicGenrePresets: MUSIC_GENRE_PRESETS,
    talkingAvatarModels: TALKING_AVATAR_MODELS,
    customVoices: db.listCustomVoices("minimax"),
    imageResolutions: IMAGE_RESOLUTIONS,
    catalogMeta: { ...getRefreshMeta(), discovery: getDiscoveryStatus() },
    confirmedLikenessBlockModels: db.getConfirmedLikenessBlockModels(),
    defaults: {
      imagePro: DEFAULT_IMAGE_MODEL_PRO,
      imageFast: DEFAULT_IMAGE_MODEL_FAST,
      video: DEFAULT_VIDEO_MODEL,
      text: DEFAULT_TEXT_MODEL,
      vision: DEFAULT_VISION_MODEL,
      imageResolution: DEFAULT_IMAGE_RESOLUTION,
      videoDuration: DEFAULT_VIDEO_DURATION,
    },
    // Auto-promoted defaults — a discovered model that's earned enough
    // real successful generations (see checkPromotionEligibility in
    // fal-catalog.js), separate from the stable hardcoded `defaults`
    // above on purpose: those stay a fixed last-resort safety net deep
    // in the generation pipeline; this is what a FRESH session's
    // dropdown should actually pre-select instead, when something has
    // genuinely earned it. null for a category until something does.
    recommendedDefaults: getRecommendedDefaults(),
  });
});

// ============================================================
// MODEL EXPLORER API (Phase 2/3 -> 4 bridge) — exposes the
// ProviderAdapter's Provider -> Family -> Variant grouping and
// per-model inspection over HTTP for the first time. Purely additive:
// doesn't touch /api/models above or anything that reads it — this is
// new data for a not-yet-built UI, not a replacement for what's
// already working. See provider-adapter.js for how the data itself is
// built and tested.
// ============================================================
app.get("/api/models/explorer", (req, res) => {
  try {
    const mediaType = req.query.mediaType || undefined; // undefined = all media types, matches discoverModels' own convention
    const tree = FalAdapter.groupModelsByFamily({ mediaType });
    // Enrich each leaf with capabilities + cost inline — without this,
    // the frontend would need one /api/models/inspect call PER MODEL
    // just to render meaningful filters/sort, which doesn't scale as
    // the discovered-model list grows.
    for (const provider of Object.values(tree)) {
      for (const family of Object.values(provider)) {
        family.forEach((m, i) => {
          family[i] = { ...m, capabilities: FalAdapter.getCapabilities(m.id), estimatedCost: FalAdapter.estimateCost(m.id, {}) };
        });
      }
    }
    res.json({ tree, catalogMeta: { ...getRefreshMeta(), discovery: getDiscoveryStatus() } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Query param, not a path param — Fal model IDs contain slashes
// (fal-ai/nano-banana-pro/edit), which would break a normal Express
// :modelId route (it only captures up to the first slash).
app.get("/api/models/inspect", (req, res) => {
  try {
    const modelId = req.query.id;
    if (!modelId) return res.status(400).json({ error: "Missing ?id=<model id> query param." });
    const details = FalAdapter.getModelDetails(modelId);
    if (!details) return res.status(404).json({ error: `No discovery or curated data found for "${modelId}".` });
    res.json({
      ...details,
      capabilities: FalAdapter.getCapabilities(modelId),
      voices: details.mediaType === "audio" ? FalAdapter.discoverVoices(modelId) : null,
      estimatedCost: FalAdapter.estimateCost(modelId, {}),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// On-demand refresh — lets the frontend (a "Check for model updates"
// button) or a script trigger an immediate re-verification instead of
// waiting for the periodic background check. Always returns 200 with a
// clear ok:true/false — a failed refresh is informational, never a hard
// error, since the existing registry stays valid either way.
app.post("/api/models/refresh", async (req, res) => {
  const allIds = [
    ...IMAGE_MODELS, ...VIDEO_MODELS, ...MUSIC_MODELS, ...SFX_MODELS,
    ...VOICE_CLONE_MODELS, ...TALKING_AVATAR_MODELS,
    ...Object.values(UTILITY_MODELS).flat(),
  ].map((m) => m.id);
  const result = await refreshModelLiveStatus(allIds, { thorough: true });
  res.json(result);
});

// Model Guide — description, category, and a real example code snippet
// for one model, built from Fal's own live OpenAPI schema (see
// fal-schema-utils.js) rather than anything hand-written. Only populated
// once the background/on-demand catalog check has run for that model at
// least once (see fal-catalog.js) — if it hasn't, this returns available:
// false rather than a stale or fabricated guess, so the UI can show
// "check for updates first" instead of wrong information.
app.get("/api/models/guide", (req, res) => {
  const modelId = req.query.id;
  if (!modelId) return res.status(400).json({ error: "Missing ?id=" });
  const guide = getGuide(modelId);
  if (!guide) {
    return res.json({ available: false, reason: "Not verified against Fal's live catalog yet — try the model catalog refresh in Settings first." });
  }
  res.json({ available: true, ...guide });
});

// Browse Fal's ENTIRE catalog (not just this app's curated registry) —
// served instantly from the pre-loaded browse cache (see
// refreshBrowseCatalog in fal-catalog.js), not a live API call per
// request. This is what fixes the earlier "limit 25 exceeds maximum of
// 10" error: that cap only applied to the old approach of requesting
// full schemas for many search results at once. Browsing is cheap and
// broad here; only a specific model's full detail (below) is fetched
// live, one at a time, on demand.
app.get("/api/models/search", (req, res) => {
  const { q, category } = req.query;
  const cache = getBrowseCache();
  const results = searchBrowseCache({ q, category });
  res.json({
    ok: true,
    results,
    cacheMeta: { lastFetched: cache.lastFetched, totalCached: cache.models.length, error: cache.error, isBrowsing: cache.fetching },
  });
});

// Manual "hard refresh" of the browse cache — the 72-hour automatic
// refresh (see app.listen below) covers routine staleness, this is for
// "I want the latest right now."
app.post("/api/models/search/refresh", async (req, res) => {
  const cache = await refreshBrowseCatalog();
  res.json({ ok: !cache.error, lastFetched: cache.lastFetched, totalCached: cache.models.length, error: cache.error });
});

// Full detail (description, license, thumbnail, real example code) for
// ONE specific model from the browse list — fetched live and lazily,
// only when someone actually clicks to view it, not for the whole list
// at once.
app.get("/api/models/detail", async (req, res) => {
  const modelId = req.query.id;
  if (!modelId) return res.status(400).json({ error: "Missing ?id=" });
  try {
    const detail = await getSingleModelDetail(modelId);
    if (!detail) return res.status(404).json({ available: false, reason: "Not found on Fal's live catalog." });
    res.json({ available: true, ...detail });
  } catch (error) {
    res.status(502).json({ available: false, reason: error.message });
  }
});

// ============================================================
// SMART WIZARD — a third mode alongside Single and Batch. Instead of a
// static form filled out once and hoped-for, this asks a small number of
// TARGETED clarifying questions first (like a real creative director
// would), then uses the answers to build a refined brief — aiming to get
// the desired output in one real generation instead of several guesses.
// Works with an uploaded reference photo OR from a pure text description
// (no photo at all) — the latter generates a base product image first,
// see /api/wizard-generate-base below, then hands off into the same
// existing single-mode pipeline everything else in this app already uses
// rather than duplicating it.
// ============================================================
app.post("/api/wizard-questions", async (req, res) => {
  let runId;
  try {
    const { productDescription, productImageBase64, wantsVariants, userApiKey, textModel, runId: clientRunId, creationType } = req.body;
    const isLogo = creationType === "logo";
    if (!productDescription && !productImageBase64) {
      return res.status(400).json({ error: isLogo ? "Describe the brand/business first." : "Describe the product or upload a photo first." });
    }
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "thinking", "Reading your description and figuring out what's genuinely ambiguous...");
    const effectiveTextModel = textModel || DEFAULT_TEXT_MODEL;
    const prompt = isLogo
      ? `You are a brand designer doing a quick intake call before designing a logo. Based on what's provided below, ask clarifying questions that would genuinely change the design direction — not generic boilerplate.
HOW MANY: use your judgment — typically 3-6, enough to remove real ambiguity, not padded for its own sake.
EACH QUESTION IS EITHER "mcq" (3-4 tap-able options) or "text" (only for something specific only the person would know, like an exact brand name spelling or a specific competitor to differentiate from) — most should be mcq.
For "mcq" questions, add "allowMultiple": true when more than one option could genuinely apply together (e.g. style could blend "modern" AND "minimalist") — default to false (single choice) when the options are genuinely mutually exclusive (e.g. icon+wordmark vs. wordmark-only vs. icon-only can't really be more than one at once).
Cover the things that actually shape a logo: icon+wordmark vs. wordmark-only vs. icon-only (mcq, single), style direction — minimalist/modern/vintage/playful/luxury/bold (mcq, likely multi), color palette preference or "let the AI decide" (mcq or text), whether any specific symbol/imagery should be included or explicitly avoided (text), and industry/niche if not already stated (text). Do NOT ask things already answered below.
BRAND DESCRIPTION: ${productDescription || "(no text provided — a reference image was given instead)"}
${wantsVariants ? "NOTE: the person wants to see multiple distinct style directions, not just one — include an mcq question about how many directions and whether to specify a theme for each or let the AI decide." : ""}
Return ONLY this JSON shape, no markdown, no preamble. "options" required for "mcq", omit entirely for "text". "allowMultiple" only on "mcq" questions, omit for "text":
{"questions": [{"type": "mcq", "question": "...", "options": ["...", "...", "..."], "allowMultiple": false}, {"type": "text", "question": "..."}]}`
      : `You are a product designer helping someone INVENT a new product concept that will be brought to life through AI image generation — this is a design/creation exercise, not planning a photoshoot of something that already exists (that's what this app's Single/Batch Photoshoot modes are for, and they're not what's happening here). Based on what's provided below, ask clarifying questions that would genuinely change the DESIGN itself or how it should be visualized — not generic boilerplate, and NOT photoshoot-logistics questions (nothing about whether it's "physical vs CGI," nothing about photography use-case/licensing, nothing that only matters if a real object already exists to be photographed).
HOW MANY: use your judgment — enough to remove the real ambiguity in this specific case, typically somewhere between 3 and 7. Don't pad with questions that don't actually change anything, and don't stop early if a genuine ambiguity remains unresolved. Quality of questions matters more than hitting a number — someone who can't write a detailed prompt themselves is relying on these questions to build the full picture, so err toward asking one more genuinely useful question rather than cutting it short.
EACH QUESTION IS EITHER:
  - "mcq": has a natural small set of good answers — give 3-4 concrete, concrete-enough-to-tap options (the person taps a button, doesn't type).
  - "text": needs a specific detail only the person would know and multiple-choice would be awkward or overly narrow for (e.g. an exact number/size, a specific place name, a brand-specific term, a precise color name they have in mind). Use this sparingly — most questions should be "mcq" since tapping is faster than typing, but don't force something into fake multiple-choice options when a real answer wouldn't fit any of them.
For "mcq" questions, add "allowMultiple": true when more than one option could genuinely apply together (e.g. finish/texture could reasonably be "aged" AND "hand-hammered" at once) — default to false (single choice) when the options are genuinely mutually exclusive (e.g. hero focus can't really be both "the overall form" and "a specific detail" at once — pick one).
GOOD QUESTIONS TO ASK (when genuinely ambiguous) — go beyond surface design mechanics into what actually shapes a strong result:
  - CONTEXT & USE: where and how will this actually be seen or used — e.g. a product listing thumbnail vs. a large lifestyle/interior shot vs. a catalog close-up (mcq, single) — this changes framing, detail level, and what's worth emphasizing.
  - THEIR VISION: how do THEY picture the finished piece — the mood/feeling it should evoke (e.g. "warm and inviting" vs. "dramatic and imposing" vs. "clean and modern") (mcq, single or multi if blending fits) — don't assume a generic "premium" tone; ask.
  - WHAT MATTERS MOST: if something has to give, what's the priority — e.g. intricate detail work vs. overall silhouette vs. material authenticity vs. dramatic lighting (mcq, single) — this resolves genuine trade-offs the design will have to make.
  - PLACEMENT & INSTALLATION (whenever the product is something that gets mounted, hung, installed, or built into a physical space — decor, fixtures, architectural elements, wall/door pieces, signage, furniture, etc.): where exactly does it go — wall vs. door vs. ceiling vs. freestanding (mcq, single, only if not already stated); what's immediately BEHIND and AROUND it in the final image — a plain wall, textured surface, wood paneling, an open doorway, a full room setting (mcq, single) — this is the actual foreground/background composition and easy to get wrong by guessing; what's the surrounding lighting like — daylight through a window, warm ambient indoor lighting, dramatic spotlighting (mcq, single). Someone who makes physical installed pieces (a decor manufacturer, a fixture maker) often knows exactly what they make but not how to describe the SCENE around it in words — these questions do that work for them instead of leaving it to a generic prompt.
  - visual hero/focal point (mcq, single — e.g. the overall form vs. a specific detail); material, finish, or texture specifics not already stated (text or mcq, often multi); style/aesthetic direction — e.g. minimalist vs ornate, modern vs traditional (mcq, could be multi); scale or proportion details that would change the design (text).
Do NOT ask things already answered by the input below. Prioritize CONTEXT/VISION/PLACEMENT questions above generic style questions when both are ambiguous — knowing WHERE something lives and WHY it's being made shapes the final image more than any single material choice, and someone who can't write a detailed prompt themselves is relying entirely on these questions to fill that gap.
${productImageBase64 ? "IMPORTANT: the attached photo is being used as INSPIRATION for a newly-designed product, not necessarily the exact item to recreate as-is — unless the person's description says otherwise, assume they may want something NEW created in a similar spirit. Worth asking (mcq) how closely the new design should stick to the reference vs. take creative liberty, since that genuinely changes the outcome." : ""}
PRODUCT DESCRIPTION: ${productDescription || "(no text description provided — a photo was uploaded instead, look at it)"}
${wantsVariants ? "NOTE: the person wants to explore multiple color/style variations of this product — they've already specified how many and what should differ via dedicated controls, so don't ask about that; focus your questions on the core design itself, which applies across all variations." : ""}
Return ONLY this JSON shape, no markdown, no preamble. "options" is required for "mcq" type, omit it entirely for "text" type. "allowMultiple" only on "mcq" questions, omit for "text":
{"questions": [{"type": "mcq", "question": "...", "options": ["...", "...", "..."], "allowMultiple": false}, {"type": "text", "question": "..."}]}`;
    const response = await falTextRequest(prompt, {
      model: effectiveTextModel,
      apiKey,
      imageDataUri: productImageBase64 || null,
      costMeta: { runId, endpoint: "wizard-questions" },
    });
    progress.updateProgress(runId, "parsing", "Organizing the questions...");
    let parsed;
    try {
      parsed = JSON.parse(response.text.trim().replace(/^```json\s*|\s*```$/g, ""));
    } catch {
      progress.finishProgress(runId);
      return res.status(502).json({ error: "Couldn't generate questions — try again." });
    }
    progress.finishProgress(runId);
    res.json({ questions: parsed.questions || [] });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Wizard] wizard-questions failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// For the "no reference photo" path — generates a real base product image
// purely from a text description, using a capable text-to-image model.
// The result then flows into the EXACT SAME downstream pipeline as an
// uploaded photo would (compositing, safety classification, etc.) —
// nothing is duplicated, this just supplies the missing starting image.
app.post("/api/wizard-generate-base", async (req, res) => {
  let runId;
  try {
    const { productDescription, refinedBrief, aspectRatio, userApiKey, runId: clientRunId, referenceImageBase64, preferredModel } = req.body;
    if (!productDescription && !referenceImageBase64) return res.status(400).json({ error: "Missing product description." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "generating-base", referenceImageBase64 ? "Inventing a new design, inspired by your reference..." : "Imagining the base product from your description...");
    // Two genuinely different prompts, not one prompt with a reference
    // bolted on: with a reference, this must EXPLICITLY invent something
    // NEW rather than reproduce what's in the image — a fashion brand
    // exploring new product ideas wants inspiration, not a copy of a
    // photo they already have (Single Mode already does exact
    // reproduction perfectly; this is deliberately a different job).
    const prompt = referenceImageBase64
      ? `A single professional product photograph, ONE newly-designed item only, isolated on a clean seamless white/neutral studio background, centered, no props, no people, sharp focus, even studio lighting, e-commerce catalog style. INVENT a NEW, ORIGINAL design INSPIRED by the attached reference image's style, aesthetic, and spirit — do NOT reproduce the reference item exactly; this should be a genuinely different, newly-imagined product that captures the same feeling. ${productDescription ? `Additional direction: ${productDescription}. ` : ""}${refinedBrief ? `Design direction: ${refinedBrief}. ` : ""}Photorealistic, high detail, accurate color and texture — a real photograph of a real physical object, not an illustration.`
      : `A single professional product photograph, ONE item only, isolated on a clean seamless white/neutral studio background, centered, no props, no people, no shadows beyond soft natural contact shadow, e-commerce catalog style, sharp focus, even studio lighting. The product: ${productDescription}${refinedBrief ? `. Additional detail: ${refinedBrief}` : ""}. Photorealistic, high detail, accurate color and texture — this needs to look like a real photograph of a real physical object, not an illustration.`;
    // Actually respect the user's model choice when it's safe to — a
    // reference image being present means any edit-capable model works
    // fine. Without one, only a confirmed text-to-image model can be
    // used at all (an edit-only model like FLUX Klein genuinely cannot
    // run with zero reference images — confirmed by a real
    // "image_urls Field required" failure). If the picked model can't be
    // used for this specific step, fall back — but say so clearly rather
    // than silently substituting a different model than what was chosen.
    let fallbackNote = null;
    let effectivePreferred = preferredModel;
    let effectiveAlternate = referenceImageBase64 ? DEFAULT_IMAGE_MODEL_FAST : "fal-ai/nano-banana";
    if (!preferredModel) {
      effectivePreferred = referenceImageBase64 ? DEFAULT_IMAGE_MODEL_PRO : "fal-ai/nano-banana";
    } else if (!referenceImageBase64 && !getImageModel(preferredModel)?.textToImageOnly) {
      effectivePreferred = "fal-ai/nano-banana";
      effectiveAlternate = "fal-ai/nano-banana";
      fallbackNote = `${preferredModel} can't generate an image from a text description alone (it needs a reference photo to edit) — used Nano Banana instead for this step. Your selected model will still be used for the actual photoshoot images.`;
    }
    const genResult = await resilientFalImageGeneration(
      (model) => buildFalImageInput(prompt, referenceImageBase64 ? [referenceImageBase64] : [], { aspectRatio: aspectRatio || "1:1", modelId: model }).input,
      { preferredModel: effectivePreferred, alternateModel: effectiveAlternate, apiKey, costMeta: { runId, endpoint: "wizard-generate-base" } },
    );
    progress.finishProgress(runId);
    // Download and return as a real data URI, not the remote Fal URL —
    // the browser can't reliably fetch() a cross-origin URL's raw bytes
    // (that needs CORS permission Fal's CDN doesn't guarantee), which is
    // exactly what was silently breaking the hand-off into Single Mode.
    // NOTE: resilientFalImageGeneration returns {image, modelUsed,
    // usedFallback}, not a plain URL string — confirmed directly by a
    // real "Failed to parse URL from [object Object]" failure when this
    // was passed to fetch() as if it were already a string.
    const dataUri = await downloadImageAsDataUri(genResult.image);
    res.json({ image: dataUri, fallbackNote });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    res.status(500).json({ error: error.message });
  }
});

// Logo generation — deliberately a SEPARATE route with its own prompt,
// not a variant of wizard-generate-base. A logo has nothing in common
// with product photography styling (no photorealism, no studio lighting,
// no physical object) — it needs clean vector-style design conventions
// instead, so sharing a prompt template would produce the wrong thing
// for one or the other.
app.post("/api/wizard-generate-logo", async (req, res) => {
  let runId;
  try {
    const { brandDescription, refinedBrief, userApiKey, runId: clientRunId } = req.body;
    if (!brandDescription) return res.status(400).json({ error: "Missing brand description." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "generating-logo", "Designing your logo...");
    const prompt = `A professional, modern logo design, clean vector-style graphic, centered on a plain white background, no photograph or photorealistic elements, no mockup or product placement — just the logo itself, flat and crisp like a real brand identity file. Sharp clean edges, balanced composition, professional typography if text is included, print-ready quality. Brand: ${brandDescription}${refinedBrief ? `. Design direction: ${refinedBrief}` : ""}. This must look like an actual finished logo design, not an illustration of a logo, not a 3D render, not a scene containing a logo.`;
    // Always zero reference images for a logo — must use the confirmed
    // pure text-to-image model, not an edit-only one. Same bug class as
    // the earlier "image_urls Field required" failure on the base-image
    // route: an edit-only model called with no images always fails.
    const genResult = await resilientFalImageGeneration(
      (model) => buildFalImageInput(prompt, [], { aspectRatio: "1:1", modelId: model }).input,
      { preferredModel: "fal-ai/nano-banana", alternateModel: "fal-ai/nano-banana", apiKey, costMeta: { runId, endpoint: "wizard-generate-logo" } },
    );
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(genResult.image);
    res.json({ image: dataUri });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// IMAGE TOOLS — Upscale, Extend, and Restore/Colorize. Single-image
// utility operations, separate from the main photoshoot pipeline.
// Reuses falImageRequest (the same resilient, timeout-protected function
// every other image call in this app uses) rather than a fresh
// fal.subscribe() call, so this inherits the same retry/timeout safety
// net automatically instead of needing its own copy of that logic.
// ============================================================
// Analyzes the actual uploaded image and suggests which tool genuinely
// fits it, instead of showing three options with zero guidance. A
// real, specific recommendation grounded in what's actually visible in
// the image — not a guess at what the person meant.
app.post("/api/tools/suggest", async (req, res) => {
  try {
    const { imageBase64, userApiKey, visionModel, runId: clientRunId } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Missing image." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // Runs right after the image is uploaded, before the actual
    // tools/process call — minted here and returned so the frontend can
    // reuse it for that follow-up call, grouping "suggest + process" as
    // one real run instead of two disconnected ledger rows.
    const runId = clientRunId || crypto.randomUUID();
    const modelMenu = Object.entries(UTILITY_MODELS)
      .map(([tool, models]) => models.map((m) => `  - tool "${tool}", model "${m.id}" (${m.label}): best for ${m.bestFor || "general use"}`).join("\n"))
      .join("\n");
    const prompt = `Look at this image and recommend the single best tool AND specific model for it, based on what's actually visible. Available options:
${modelMenu}
Tool meanings: "upscale" = increase resolution/sharpen detail (use when the image looks low-res, soft, or blurry). "extend" = expand the image beyond its current edges (use when it looks tightly cropped or cut off). "restore" = fix damage, scratches, fading, or colorize black-and-white (use when there's visible damage or it's grayscale).
If none clearly apply (the image already looks clean, well-composed, and high-resolution), say tool "none" and explain there's nothing obviously needed.
Return ONLY this JSON, no markdown, no preamble: {"tool": "upscale" | "extend" | "restore" | "none", "modelId": "the specific model id from the list above, or null if tool is none", "reason": "one short sentence explaining what you actually see that supports both the tool AND model choice"}`;
    const response = await falVisionRequest(prompt, imageBase64, { model: visionModel || DEFAULT_VISION_MODEL, apiKey, costMeta: { runId, endpoint: "tools-suggest" } });
    let parsed;
    try {
      parsed = JSON.parse(response.text.trim().replace(/^```json\s*|\s*```$/g, ""));
    } catch {
      return res.status(502).json({ error: "Couldn't analyze the image." });
    }
    // Validate the model actually exists in that tool's real option list —
    // don't trust the AI's output blindly for something that drives an
    // actual API call downstream.
    if (parsed.tool && parsed.tool !== "none" && parsed.modelId) {
      const validModel = (UTILITY_MODELS[parsed.tool] || []).some((m) => m.id === parsed.modelId);
      if (!validModel) parsed.modelId = UTILITY_MODELS[parsed.tool]?.[0]?.id || null;
    }
    res.json({ ...parsed, runId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tools/process", async (req, res) => {
  let runId;
  try {
    const { tool, modelId, imageBase64, options = {}, userApiKey, runId: clientRunId } = req.body;
    const toolOptions = UTILITY_MODELS[tool];
    if (!toolOptions) return res.status(400).json({ error: `Unknown tool "${tool}" — expected upscale, extend, or restore.` });
    const config = modelId ? toolOptions.find((m) => m.id === modelId) : toolOptions[0];
    if (!config) return res.status(400).json({ error: `"${modelId}" isn't a valid model for the ${tool} tool.` });
    if (!imageBase64) return res.status(400).json({ error: "Missing image." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "processing-image", `Running ${config.label}...`);
    // "scale" needs model-specific mapping — confirmed directly against
    // Fal's own docs that these three upscale models use genuinely
    // different field shapes (upscale_factor / scale_factor / a combined
    // upscale_mode+upscale_factor pair), none of them literally "scale".
    // Sending the raw generic key was being silently ignored by every
    // one of them — this is what actually wires the 2x/4x dropdown to
    // something real.
    const { scale, ...restOptions } = options;
    const scaleParams = scale && config.buildScaleParams ? config.buildScaleParams(scale) : {};
    const input = { [config.imageField]: toFalImageUrl(imageBase64), ...restOptions, ...scaleParams };
    const url = await falImageRequest(config.id, input, {
      apiKey,
      costMeta: { runId, endpoint: `tools-${tool}`, model: config.id },
    });
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(url);
    res.json({ image: dataUri });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Image Tools] ${req.body?.tool} failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// VOICE / TEXT-TO-SPEECH — first piece of the phased movie pipeline.
// Deliberately its own standalone tool (not bundled into Image Tools)
// since audio is a genuinely different output type — but built to be
// reusable later by talking-avatar generation, which will need exactly
// this same "turn a script into audio" step as an internal ingredient.
// ============================================================
// ============================================================
// SMART TEXT PREPARATION — handles the real way people actually type,
// not just "translate English to X". Three genuinely different cases,
// handled by one smart prompt instead of requiring the person to pick:
//   1. Plain English that needs translating.
//   2. Romanized/transliterated Indian language — e.g. "nenu ardam
//      avutundi" (Telugu, typed in Latin letters, extremely common on
//      phone keyboards without native script input).
//   3. Natural code-switching — English words mixed into an Indian-
//      language sentence, which is how people actually talk, not an
//      error to "fix" by translating everything.
// Returns the prepared text WITHOUT generating any audio — the person
// reviews and can edit it before anything gets spoken, addressing the
// real ask: "give options to edit it" rather than translate-and-speak
// blindly.
// ============================================================
// Real Unicode-range validation, not just trust — this is what actually
// catches the exact failure that happened: the LLM silently returning
// English for Telugu while correctly translating Hindi. Only languages
// with a genuinely distinct non-Latin script can be validated this way;
// languages that share Latin script (Spanish, French, etc.) are skipped.
const TARGET_LANGUAGE_SCRIPT_RANGES = {
  Hindi: /[\u0900-\u097F]/, Marathi: /[\u0900-\u097F]/,
  Telugu: /[\u0C00-\u0C7F]/, Tamil: /[\u0B80-\u0BFF]/, Kannada: /[\u0C80-\u0CFF]/,
  Malayalam: /[\u0D00-\u0D7F]/, Bengali: /[\u0980-\u09FF]/, Gujarati: /[\u0A80-\u0AFF]/,
  Punjabi: /[\u0A00-\u0A7F]/, Odia: /[\u0B00-\u0B7F]/, Urdu: /[\u0600-\u06FF]/,
  Arabic: /[\u0600-\u06FF]/, Chinese: /[\u4E00-\u9FFF]/, Japanese: /[\u3040-\u30FF\u4E00-\u9FFF]/,
};
// Extracted so both /api/voice/prepare-text and the new narration-script
// writer share the exact same proven logic — anti-transliteration
// guidance, casual-register instruction, script validation with a
// forceful retry, and a second-opinion transliteration check — rather
// than a second, weaker copy of hard-won prompt engineering.
async function prepareTextForLanguage(text, targetLanguage, { apiKey, textModel, costMeta = null }) {
  const buildPrompt = (forceful) => `You are a professional human translator preparing text to be spoken aloud in ${targetLanguage} by a text-to-speech engine. The input text could be any of these — figure out which, automatically, without being told:
1. Plain English that needs REAL TRANSLATION into ${targetLanguage} — actual ${targetLanguage} words that carry the same meaning, the words a native ${targetLanguage} speaker would naturally use.
2. ${targetLanguage} already written in Latin/English letters instead of native script (very common when typing on a phone without native keyboard support) — e.g. Telugu written as "nenu ardam avutundi" instead of "నేను అర్థం అవుతుంది". Convert this to proper native ${targetLanguage} script — do NOT translate it as if it were English, since it already means something in ${targetLanguage}.
3. A natural mix of English and ${targetLanguage} in the same sentence (code-switching, exactly how people actually speak) — this is intentional, not a mistake. Keep genuinely English words/phrases as English exactly as written; only convert the ${targetLanguage} portions into native ${targetLanguage} script.

CRITICAL — DO NOT TRANSLITERATE. Transliteration (spelling English words out phonetically in ${targetLanguage} script, so they still sound like English when read) is WRONG and is not the same thing as translation. For example, for the English input "a wise man said nothing", correct Telugu translation is "ఒక జ్ఞాని ఏమీ చెప్పలేదు" (real Telugu words meaning "a wise person said nothing") — NOT "ఒక వైజ్ మ్యాన్ నథింగ్ చెప్పాడు" (which is just the English words "wise man" and "nothing" spelled out in Telugu letters — this is the exact mistake to avoid). If you find yourself writing script that, if read aloud, would sound like English words with an accent, stop — that is transliteration, not translation. Use real, natural ${targetLanguage} vocabulary instead.

CRITICAL — REGISTER: write CASUAL, EVERYDAY SPOKEN ${targetLanguage}, the way people actually talk to each other in real conversation — NOT formal, literary, textbook, or "news broadcast" ${targetLanguage}. Include the natural colloquial particles, contractions, and rhythm real speech has (for Telugu, things like "...ante", "...le", "...ani" at natural points — not because these specific words are required, but because that conversational texture is what's wanted). A stiff, technically-correct-but-formal translation is still the wrong output here. For "once a wise man said nothing", a natural CASUAL Telugu rendering sounds like "oka maha jnani okasari em cheppadu ante em ledu le ani" in feel and rhythm (written here in Latin letters only to illustrate the tone — your actual output must be in native ${targetLanguage} script) — relaxed, spoken, like a real person telling a story, not a formal statement.

Preserve the speaker's actual meaning and natural tone — don't make it more formal or literary than the original. Keep any *asterisk* stage-direction markers (like *pause*, *laughs*) EXACTLY as-is, untranslated, in their original position — only convert the actual spoken words around them.
${forceful ? `\nIMPORTANT — YOUR PREVIOUS ATTEMPT FAILED: it produced transliteration (English words spelled out in ${targetLanguage} script) instead of real translation, or stayed in English. Try again using genuine, natural ${targetLanguage} vocabulary that a native speaker would actually use — not a phonetic rendering of the English words.\n` : ""}
Return ONLY the prepared text, ready to be read aloud — no explanation, no quotes, no preamble.
INPUT TEXT: ${text.trim()}`;
  const scriptCheck = TARGET_LANGUAGE_SCRIPT_RANGES[targetLanguage.trim()];
  let preparedText = (await falTextRequest(buildPrompt(false), {
    model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.3,
    costMeta: { ...costMeta, endpoint: "prepare-text-language" },
  })).text.trim();
  let scriptValidationFailed = false;
  if (scriptCheck && !scriptCheck.test(preparedText)) {
    console.warn(`[Language Prep] Output didn't contain ${targetLanguage} script on first attempt — retrying with a more forceful prompt.`);
    const retryText = (await falTextRequest(buildPrompt(true), {
      model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.2,
      costMeta: { ...costMeta, endpoint: "prepare-text-language-retry" },
    })).text.trim();
    if (scriptCheck.test(retryText)) {
      preparedText = retryText;
    } else {
      scriptValidationFailed = true;
      preparedText = retryText;
    }
  }
  let transliterationDetected = false;
  if (scriptCheck && !scriptValidationFailed) {
    try {
      const judgePrompt = `Look at this ${targetLanguage} text. Does it contain genuine, natural ${targetLanguage} vocabulary, or is it actually English words spelled out phonetically in ${targetLanguage} script (transliteration) — meaning if you read it aloud with an English accent, it would sound like the original English sentence? Answer with ONLY one word: "REAL" or "TRANSLITERATED".
TEXT: ${preparedText}`;
      const judgeResponse = await falTextRequest(judgePrompt, {
        model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0,
        costMeta: { ...costMeta, endpoint: "prepare-text-language-judge" },
      });
      if (/TRANSLITERATED/i.test(judgeResponse.text)) {
        console.warn(`[Language Prep] Output passed script check but was judged as transliteration — retrying once more.`);
        const retryText = (await falTextRequest(buildPrompt(true), {
          model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.4,
          costMeta: { ...costMeta, endpoint: "prepare-text-language-retry-translit" },
        })).text.trim();
        preparedText = retryText;
        transliterationDetected = true;
      }
    } catch (judgeErr) {
      console.warn(`[Language Prep] Transliteration check itself failed: ${judgeErr.message} — proceeding with unverified text.`);
    }
  }
  return { preparedText, scriptValidationFailed, transliterationDetected };
}

app.post("/api/voice/prepare-text", async (req, res) => {
  try {
    const { text, targetLanguage, textModel, userApiKey, runId: clientRunId } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Missing text." });
    if (!targetLanguage || !targetLanguage.trim()) return res.status(400).json({ error: "Missing target language." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // Not tied to progress polling (this step is fast/synchronous), but
    // still tagged with a real run_id so its cost lands under the same
    // run as whatever speech generation follows it, instead of showing
    // up as an orphaned ledger row with no run to attribute it to.
    const runId = clientRunId || crypto.randomUUID();
    const result = await prepareTextForLanguage(text, targetLanguage, { apiKey, textModel, costMeta: { runId } });
    res.json({ ...result, runId });
  } catch (error) {
    console.error(`[Voice] Text preparation failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Splits a script into language-tagged segments using [Language]...[/Language]
// markers — untagged text falls back to the base language. This is what
// makes real code-switching within one continuous narration possible:
// each segment gets its own real translation pass (or none, if it's
// already the base language) before being generated and stitched
// together, rather than treating the whole script as one language.
function parseMultilingualSegments(text, baseLanguage) {
  const regex = /\[([A-Za-z]+)\]([\s\S]*?)\[\/\1\]/g;
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const untagged = text.slice(lastIndex, match.index).trim();
      if (untagged) segments.push({ language: baseLanguage, text: untagged });
    }
    const segmentText = match[2].trim();
    if (segmentText) segments.push({ language: match[1], text: segmentText });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ language: baseLanguage, text: remaining });
  }
  return segments;
}

app.post("/api/voice/generate-multilingual", async (req, res) => {
  let runId;
  try {
    const { text, modelId, voiceId, baseLanguage, textModel, userApiKey, runId: clientRunId } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Missing script text." });
    const model = VOICE_MODELS.find((m) => m.id === modelId) || VOICE_MODELS[0];
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    const segments = parseMultilingualSegments(text, baseLanguage?.trim() || "english");
    if (!segments.length) return res.status(400).json({ error: "No spoken segments found — check your [Language]...[/Language] tags." });
    if (segments.length > 20) return res.status(400).json({ error: "Too many segments (max 20) — combine some tagged sections." });
    const segmentAudioUrls = [];
    const segmentDetails = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      progress.startProgress(runId, "translating", `Preparing segment ${i + 1}/${segments.length} (${seg.language})...`);
      // Must run BEFORE translation, not after — converts bare "Pause"
      // lines to *asterisk* form first, so the translation step (which
      // already knows to preserve *asterisk* markers untouched) doesn't
      // accidentally mistranslate a bare direction into a real word.
      const segProductionScript = prepareProductionScript(seg.text);
      let finalText = segProductionScript.text;
      let prepNote = null;
      if (seg.language.toLowerCase() !== "english") {
        try {
          const prepared = await prepareTextForLanguage(finalText, seg.language, { apiKey, textModel, costMeta: { runId } });
          finalText = prepared.preparedText;
          if (prepared.scriptValidationFailed) prepNote = `Couldn't confirm real ${seg.language} script for this segment even after retrying.`;
          else if (prepared.transliterationDetected) prepNote = `This segment may be transliterated rather than real ${seg.language}.`;
        } catch (err) {
          prepNote = `Language preparation failed for this segment (${err.message}) — used the original text.`;
        }
      }
      progress.startProgress(runId, "generating-voice", `Generating segment ${i + 1}/${segments.length}...`);
      const result = await falVoiceRequest(model.id, model.buildInput(finalText, { voiceId }), {
        apiKey, costMeta: { runId, endpoint: "voice-multilingual-segment" }, costPer1kChars: model.costPer1kChars,
      });
      segmentAudioUrls.push(result.url);
      segmentDetails.push({ language: seg.language, originalText: seg.text, finalText, note: prepNote });
    }
    let finalUrl = segmentAudioUrls[0];
    if (segmentAudioUrls.length > 1) {
      progress.updateProgress(runId, "generating-voice", "Combining all segments into one continuous audio...");
      const merged = await falMergeRequest("fal-ai/ffmpeg-api/merge-audios", { audio_urls: segmentAudioUrls }, { apiKey, costMeta: { runId, endpoint: "voice-multilingual-merge" } });
      finalUrl = merged.url;
    }
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(finalUrl);
    res.json({ audio: dataUri, modelUsed: model.id, segments: segmentDetails });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Voice] Multilingual generation failed: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

app.post("/api/voice/auto-tag-languages", async (req, res) => {
  try {
    const { script, instruction, textModel, userApiKey, runId: clientRunId } = req.body;
    if (!script?.trim()) return res.status(400).json({ error: "Missing the script." });
    if (!instruction?.trim()) return res.status(400).json({ error: "Describe which parts should be in which language." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // This is typically the first step of a multilingual voiceover
    // session (auto-tag, then generate-multilingual) — the run_id minted
    // here is returned so the frontend can reuse it for the actual
    // generation, rather than this call's cost being an orphaned row
    // unlinked from the voiceover it was prepared for.
    const runId = clientRunId || crypto.randomUUID();
    const tagPrompt = `You are marking up a voiceover script for code-switched (multi-language) narration.
INSTRUCTION: ${instruction.trim()}
Wrap the lines/sentences that should be in a non-English language with tags like [Telugu]...[/Telugu] or [Hindi]...[/Hindi] (language name, capitalized, no spaces) around exactly those lines — leave everything else completely untouched, word for word. Do not add, remove, reword, or reorder any of the original text — only insert tags around the parts described in the instruction.
Return ONLY the tagged script — no explanation, no markdown fences.
SCRIPT:
${script.trim()}`;
    const response = await falTextRequest(tagPrompt, {
      model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.2,
      costMeta: { runId, endpoint: "voice-auto-tag" },
    });
    res.json({ taggedScript: response.text.trim(), runId });
  } catch (error) {
    console.error(`[Voice] Auto-tagging failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// AI-SUGGESTED DELIVERY MARKUP — the actual "smart" layer on top of the
// click-to-insert toolbar (buildVoiceMarkupToolbarHtml in app.js): a
// director's pass over the whole line at once, rather than clicking one
// tag at a time. Real safety property, not just a nice prompt: the
// model is given the EXACT tag vocabulary this specific voice model
// will actually honor (fixedMarkupTags for MiniMax's 8 confirmed sound
// cues, or the freeform convention for ElevenLabs/Gemini) — never an
// open invitation to invent tags, which would just reproduce the
// original "*confident* silently vanishes" bug one level up, now
// AI-authored instead of human-typed. A model with markupTagMode
// "unsupported" (Kokoro/Inworld/xAI) is refused outright rather than
// generating tags that would just get stripped on generation.
// ============================================================
app.post("/api/voice/suggest-markup", async (req, res) => {
  try {
    const { text, modelId, textModel, userApiKey, runId: clientRunId } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "Missing line text." });
    const model = VOICE_MODELS.find((m) => m.id === modelId);
    if (!model) return res.status(400).json({ error: "Unknown voice model — pick one for this line first." });
    if (!model.markupTagMode || model.markupTagMode === "unsupported") {
      return res.status(400).json({ error: `${model.label} doesn't support any delivery/tone tags — switch to MiniMax, ElevenLabs, or Gemini TTS on this line first, then try again.` });
    }
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    const runId = clientRunId || crypto.randomUUID();
    const tagVocabInstruction = model.markupTagMode === "fixed"
      ? `This voice model ONLY understands these exact tags — anything else is silently NOT spoken at all: ${(model.fixedMarkupTags || []).map((t) => `*${t}*`).join(", ")}, plus *N second pause* for a timed pause (e.g. *2 second pause*). Do not use any tag outside this exact list.`
      : `This voice model reads any short, specific descriptive delivery cue written as *cue* (e.g. *whispers*, *building excitement*, *sarcastic*, *3 second pause*) as a real instruction for HOW to say the words immediately after it. Use genuine, specific cues that actually fit this line — don't invent a vague one just to have used a tag.`;
    const prompt = `You are an experienced voice director marking up a script for a text-to-speech performance — the real gap this closes is a flat, monotone AI read with zero expression.
${tagVocabInstruction}
CRITICAL RULES:
- Do NOT change, add, remove, or reorder a single word of the original script — insert *tag* markers between the existing words only, never rewrite them.
- Place each tag immediately BEFORE the exact words it directs.
- Restraint matters — a natural performance doesn't have a cue before every clause; most lines need zero, one, or two tags, not one per sentence.
Return ONLY the tagged script, nothing else — no explanation, no markdown fences, no surrounding quotes.
SCRIPT:
${text.trim()}`;
    const response = await falTextRequest(prompt, {
      model: textModel || DEFAULT_TEXT_MODEL, apiKey, temperature: 0.6,
      costMeta: { runId, endpoint: "voice-suggest-markup" },
    });
    res.json({ taggedText: response.text.trim(), runId });
  } catch (error) {
    console.error(`[Voice] Markup suggestion failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/voice/generate", async (req, res) => {
  let runId;
  try {
    const { text, modelId, voiceId, speed, pitch, emotion, language, translateTo, textModel, userApiKey, isPreview, runId: clientRunId } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "Missing text to speak." });
    // Persisted preview cache — survives server restarts and future
    // sessions, not just the in-memory cache the frontend already keeps
    // for the current session. Only applies to previews (fixed, cheap
    // sample text); real generations always run fresh.
    if (isPreview) {
      const cacheKey = `${modelId}:${voiceId}`;
      const cached = db.getVoicePreview(cacheKey);
      if (cached) return res.json({ audio: cached, modelUsed: modelId, cached: true });
    }
    // Phase 12 / Section 22 — same proven pattern as image/video: swap a
    // genuinely deprecated model for a real capability-matched
    // replacement automatically, rather than just failing.
    const { resolvedModelId: modelIdAfterReplacement, replacementNote: voiceReplacementNote } = resolveModelOrReplacement(modelId);
    if (voiceReplacementNote) console.warn(`[Model Replacement] ${voiceReplacementNote}`);
    const model = VOICE_MODELS.find((m) => m.id === modelIdAfterReplacement);
    // An unrecognized model ID means the person typed a custom one — try
    // it for real with a generic payload instead of silently swapping in
    // MiniMax, which would be actively misleading (they'd think they
    // tested one model but actually got a different one back).
    const effectiveModel = model || {
      id: modelIdAfterReplacement,
      label: modelIdAfterReplacement,
      costPer1kChars: 0.10, // unknown — reasonable placeholder for the cost ledger, not a claim about this specific model's real price
      buildInput: (t, { voiceId: vId } = {}) => (vId ? { text: t, voice: vId } : { text: t }),
    };
    if (!modelId) return res.status(400).json({ error: "No voice model selected." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    let speakText = text.trim();
    let translatedText = null;
    if (translateTo && translateTo.trim()) {
      progress.startProgress(runId, "translating", `Translating into ${translateTo}...`);
      // Reuses this app's existing text-reasoning model (the same one
      // powering every creative-director/moderation call elsewhere) for
      // translation, rather than adding a separate translation API —
      // this is a general LLM capability, not a claim about any specific
      // TTS model's confirmed language list, so it's kept clearly
      // separate from the per-model "confirmedLanguages" data above.
      const translatePrompt = `Translate the following text into ${translateTo.trim()}. Preserve the meaning and tone exactly. If the text contains stage-direction markers like *pause*, *laughs*, or bracketed/parenthetical cues, keep those markers EXACTLY as-is, untranslated, in their original position — only translate the actual spoken words around them. Return ONLY the translated text, no preamble, no quotes, no explanation.
TEXT: ${speakText}`;
      try {
        const translateResponse = await falTextRequest(translatePrompt, {
          model: textModel || DEFAULT_TEXT_MODEL,
          apiKey,
          temperature: 0.3,
          costMeta: { runId, endpoint: "voice-translate" },
        });
        translatedText = translateResponse.text.trim();
        speakText = translatedText;
      } catch (translateErr) {
        console.warn(`[Voice] Translation failed (${translateErr.message}) — speaking the original text instead.`);
      }
    }
    // Real production-script handling — a script written the way an
    // actual writer/production house formats one (bare "Pause" lines, a
    // leading "Warm, reflective tone" note) rather than this app's own
    // *asterisk* convention. Without this, "Pause" would be spoken as a
    // literal word in the output — confirmed as a real risk, not a
    // hypothetical one.
    const productionScript = prepareProductionScript(speakText);
    speakText = productionScript.text;
    progress.updateProgress(runId, "generating-voice", `Generating speech with ${effectiveModel.label}...`);
    const input = effectiveModel.buildInput(speakText, { voiceId, speed, pitch, emotion, language });
    // The real, final text actually sent to the model — markers already
    // converted to this model's real pause/interjection syntax. Field
    // name differs by model (MiniMax/ElevenLabs use "text", Gemini
    // TTS/Kokoro use "prompt"), so check both rather than assume one.
    const finalSpokenText = input.text || input.prompt || speakText;
    // The real fix landing here: __strippedMarkers (see fal-models.js's
    // translateScriptMarkers) tells the person exactly what got silently
    // dropped instead of a word just vanishing from the output with zero
    // explanation — confirmed directly: "*confident*" disappearing
    // entirely on models that don't support descriptive tone tags.
    const strippedMarkers = input.__strippedMarkers || [];
    const result = await falVoiceRequest(effectiveModel.id, input, {
      apiKey,
      costMeta: { runId, endpoint: "voice-generate", model: effectiveModel.id },
      costPer1kChars: effectiveModel.costPer1kChars,
      textLength: speakText.length,
    });
    progress.finishProgress(runId);
    // If this was a saved custom (cloned) voice, using it here is
    // exactly what resets MiniMax's 7-day auto-deletion clock — do this
    // automatically rather than requiring the person to remember.
    try { db.touchCustomVoiceLastUsed(voiceId); } catch {}
    // Same CORS reasoning as every image tool tonight — a browser can't
    // reliably download a cross-origin audio file via a plain <a
    // download> either, so this returns a real data URI, not the raw
    // Fal CDN URL.
    const dataUri = await downloadImageAsDataUri(result.url);
    if (isPreview) {
      try { db.saveVoicePreview(`${modelId}:${voiceId}`, dataUri); } catch {}
    }
    res.json({
      audio: dataUri,
      durationMs: result.durationMs,
      modelUsed: effectiveModel.id,
      replacementNote: voiceReplacementNote,
      translatedText,
      finalSpokenText,
      deliveryNote: productionScript.deliveryNote,
      strippedMarkers,
      strippedMarkersNote: strippedMarkers.length
        ? `${strippedMarkers.map((m) => `"${m}"`).join(", ")} ${strippedMarkers.length === 1 ? "wasn't" : "weren't"} spoken — ${effectiveModel.label} doesn't support ${strippedMarkers.length === 1 ? "that" : "those"} as a delivery/tone cue. ElevenLabs Eleven v3 and Gemini TTS support arbitrary descriptive tags like this directly (e.g. "[confident]") if that's what you need.`
        : null,
    });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Voice] Generation failed: ${error.message}`);
    // This exact failure is what prompted this whole fix — a voice name
    // that looked valid but wasn't recognized by the model's real,
    // current library. Detecting it here means the person sees a clear,
    // actionable message instead of a raw JSON error dump they'd have
    // to decode themselves.
    let friendlyMessage = error.message;
    if (/voice not found/i.test(error.message)) {
      friendlyMessage = `That voice name isn't recognized by this model right now. Try "Sarah" (confirmed working), or open the voice library link in Voice Studio to find and copy a real, current voice name.`;
      // The actual fix for voices staying broken across every attempt
      // until the slow batch sweep happens to reach them: mark it
      // broken THE MOMENT a real call proves it broken, so the very
      // next /api/models response already excludes it — not just after
      // some later background check finally gets around to it.
      try { voiceCatalog.recordVoiceFailure(req.body.modelId, req.body.voiceId, error.message); } catch {}
    }
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: friendlyMessage });
  }
});

// ============================================================
// VOICE CLONING — create a genuinely custom voice from a real recording
// (the person reading a prompt, or their own text in their own
// language) instead of picking from a preset list. Saved persistently
// so it's available across sessions, not just this one.
// ============================================================
app.post("/api/voice/clone", async (req, res) => {
  let runId;
  try {
    const { audioBase64, name, previewText, languageNote, generateEmotions, userApiKey, runId: clientRunId } = req.body;
    if (!audioBase64) return res.status(400).json({ error: "Missing audio recording." });
    if (!name || !name.trim()) return res.status(400).json({ error: "Enter a name for this voice first." });
    const model = VOICE_CLONE_MODELS[0];
    if (!model) return res.status(400).json({ error: "No voice cloning model available." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    progress.startProgress(runId, "cloning-voice", `Cloning "${name.trim()}"'s voice from the recording...`);
    // toFalImageUrl is a generic data-URI/URL passthrough despite the
    // name (confirmed earlier tonight) — reused directly for audio
    // rather than building a separate upload mechanism.
    // Frontend now always converts to real WAV before sending (fixed
    // after a confirmed "unsupported_audio_format" error — Fal's clone
    // endpoint only accepts .wav or .mp3, not the webm a browser
    // recorder produces by default) — this fallback mime is now
    // realistically never hit, but kept accurate rather than stale.
    const audioUrl = toFalImageUrl(audioBase64, "audio/wav");
    const input = model.buildInput(audioUrl, { previewText });
    const result = await falVoiceRequest(model.id, input, {
      apiKey,
      costMeta: { runId, endpoint: "voice-clone", model: model.id },
      costPer1kChars: 0.10, // billed against the preview text generated as part of cloning, same rate as the underlying speech-02-hd preview step
      textLength: (previewText || "Hello, this is a preview of your cloned voice! I hope you like it!").length,
      progressLabel: `Analyzing "${name.trim()}"'s voice sample and building the clone...`,
    });
    if (!result.customVoiceId) {
      throw new Error("Fal completed the request but didn't return a custom_voice_id — cloning may have failed silently.");
    }
    db.saveCustomVoice({
      name: name.trim(),
      customVoiceId: result.customVoiceId,
      modelFamily: model.modelFamily,
      sourceText: previewText || null,
      languageNote: languageNote || null,
    });
    // The full emotional range — real, separate paid calls (opt-in via
    // generateEmotions, not automatic), using the regular TTS model with
    // the freshly-cloned voice_id and MiniMax's own confirmed emotion
    // enum. Each one also refreshes the voice's 7-day retention clock,
    // same as any real use of it.
    const emotionSamples = [];
    if (generateEmotions) {
      const ttsModel = VOICE_MODELS.find((m) => m.id === "fal-ai/minimax/speech-02-hd");
      const EMOTIONS = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];
      const emotionSampleText = "This is how I sound right now.";
      for (const emotion of EMOTIONS) {
        try {
          progress.updateProgress(runId, "cloning-voice", `Generating "${emotion}" sample for "${name.trim()}"...`);
          const emotionInput = ttsModel.buildInput(emotionSampleText, { voiceId: result.customVoiceId, emotion });
          const emotionResult = await falVoiceRequest(ttsModel.id, emotionInput, {
            apiKey,
            costMeta: { runId, endpoint: "voice-clone-emotion", model: ttsModel.id },
            costPer1kChars: ttsModel.costPer1kChars,
            progressLabel: `Generating "${emotion}" sample for "${name.trim()}"...`,
            textLength: emotionSampleText.length,
          });
          const emotionDataUri = await downloadImageAsDataUri(emotionResult.url);
          db.saveVoicePreview(`${ttsModel.id}:${result.customVoiceId}:${emotion}`, emotionDataUri);
          emotionSamples.push({ emotion, audio: emotionDataUri });
        } catch (emotionErr) {
          console.warn(`[Voice Clone] Emotion sample "${emotion}" failed: ${emotionErr.message}`);
          emotionSamples.push({ emotion, error: emotionErr.message });
        }
      }
      db.touchCustomVoiceLastUsed(result.customVoiceId);
    }
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(result.url);
    res.json({
      customVoiceId: result.customVoiceId,
      previewAudio: dataUri,
      emotionSamples,
      retentionWarning: `This voice will be automatically deleted by MiniMax if not used again within ${model.retentionDays} days — using it to generate real speech resets that clock automatically.`,
    });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Voice Clone] Failed: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});
// Lets someone remove a saved custom voice they no longer want listed —
// only deletes the app's own local record; MiniMax's own 7-day
// auto-expiry independently handles the underlying voice on their end.
app.delete("/api/voice/custom/:customVoiceId", (req, res) => {
  try {
    db.deleteCustomVoice(req.params.customVoiceId);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// SONG STUDIO — turns a personal story/prompt (like "write me a song
// about my 8-year relationship, referencing these tracks for style")
// into the two separate, structured inputs MiniMax Music 2.0 actually
// needs: a short style/mood description and properly tagged lyrics.
// Writing raw prose straight into lyrics_prompt would produce weaker
// results than genuine [Verse]/[Chorus] structure, so this step matters.
// ============================================================
// ============================================================
// SONG BRIEF + MODEL RECOMMENDATION — takes a rich description (what
// it's about, how it should feel, how it should be sung/rapped,
// language) and does two real things with it: writes the actual
// lyrics+style, and recommends which of the real, verified models
// actually fits — based on each model's genuine confirmed capabilities
// (instrumentalOnly, supportsVoiceReference, requiresTimestampedLyrics,
// cost), not a guess dressed up as intelligence.
// ============================================================
// ============================================================
// VOICE MODEL RECOMMENDATION — the actual missing piece that let
// MiniMax (which only confirms Hindi among Indian languages) stay the
// effective default even when generating in Telugu, Tamil, Kannada, or
// any other Indian regional language — while Gemini TTS, which
// genuinely confirms 12+ of them, sat right there unrecommended. Same
// honesty bar as recommendMusicModel: every recommendation traces back
// to a model's own real confirmedLanguages array in fal-models.js, never
// a guess about what "probably" works.
// ============================================================
const INDIAN_REGIONAL_LANGUAGES = [
  "telugu", "tamil", "kannada", "malayalam", "marathi", "gujarati",
  "punjabi", "odia", "bengali", "bangla", "sindhi", "konkani", "urdu", "assamese", "hindi",
];
// "Telugu" (what a person types) needs to match "Telugu (India)" (what's
// actually in a model's confirmed list) — handles that, plus exact
// matches, without needing every model's list reformatted to match.
function languageMatchesConfirmed(targetLanguage, confirmedList) {
  if (!targetLanguage || !confirmedList?.length) return false;
  const needle = targetLanguage.trim().toLowerCase();
  return confirmedList.some((lang) => {
    const l = lang.toLowerCase();
    return l === needle || l.startsWith(`${needle} `) || l.includes(`(${needle}`) || l.split(" (")[0] === needle;
  });
}
// ============================================================
// VOICE MODEL RECOMMENDATION — mirrors recommendMusicModel's pattern
// below: explicit, confirmed-language-aware guidance instead of leaving
// a person to guess which of the voice models actually supports the
// language they're generating in. This is the real fix for the actual
// root cause: Gemini TTS has genuinely confirmed support for 12+ Indian
// regional languages (Hindi, Telugu, Tamil, Kannada, Malayalam,
// Marathi, Gujarati, Punjabi, Odia, Sindhi, Konkani, Bangla, Urdu), but
// nothing in this app ever pointed anyone toward it — MiniMax (which
// only confirms Hindi among Indian languages, everything else relying
// on unconfirmed "auto" detection) was the de facto default regardless
// of what language was actually being generated.
// ============================================================
// Broader than gemini-tts's own confirmed list on purpose — this is
// used to decide which model to GUESS with when no model confirms the
// exact language, not to claim confirmation. For any of India's other
// real scheduled/major regional languages, gemini-tts (broad Indian-
// language family) is still the more reasonable bet than a model with
// zero non-Hindi Indian-language confirmation at all.
const CONFIRMED_INDIAN_LANGUAGES = new Set([
  "hindi", "telugu", "tamil", "kannada", "malayalam", "marathi",
  "gujarati", "punjabi", "odia", "sindhi", "konkani", "bangla", "bengali", "urdu",
  "assamese", "bodo", "dogri", "kashmiri", "maithili", "manipuri", "meitei",
  "nepali", "sanskrit", "santali", "bhojpuri", "rajasthani", "tulu",
]);
function normalizeLanguageForMatch(language) {
  return (language || "").toLowerCase().replace(/\s*\(.*?\)\s*/g, "").trim(); // strips "(India)"/"(Bangladesh)" etc. suffixes
}
function recommendVoiceModel({ language, wantsEmotionControl, wantsOwnVoice, prioritize } = {}) {
  const reasons = [];
  if (wantsOwnVoice) {
    reasons.push("You want to clone a specific real voice, not use a preset — MiniMax Voice Clone is the actual voice-cloning endpoint (a separate model from MiniMax Speech-02 HD's presets).");
    return { modelId: "fal-ai/minimax/voice-clone", reasons, confidence: "high" };
  }
  const normalized = normalizeLanguageForMatch(language);
  if (normalized && normalized !== "english" && normalized !== "auto") {
    // Checked FIRST, ahead of the 2.5 sibling below: real, confirmed
    // broader language coverage (70+ languages vs. 2.5's confirmed set)
    // AND independently benchmarked #1 for naturalness on Artificial
    // Analysis' Speech Arena — the two things most directly requested
    // when someone asks for a specific non-English language: does it
    // cover it, and does it actually sound natural doing it.
    const gemini31Entry = VOICE_MODELS.find((m) => m.id === "fal-ai/gemini-3.1-flash-tts");
    const gemini31Confirms = gemini31Entry?.confirmedLanguages?.some((l) => normalizeLanguageForMatch(l) === normalized);
    const geminiEntry = VOICE_MODELS.find((m) => m.id === "fal-ai/gemini-tts");
    const geminiConfirms = geminiEntry?.confirmedLanguages?.some((l) => normalizeLanguageForMatch(l) === normalized);
    // ElevenLabs eleven-v3 auto-detects language from the input text's
    // script rather than taking an explicit language parameter — checked
    // via its own real, confirmed language list (autoDetectedLanguagesSupported),
    // a genuinely different field than confirmedLanguages for exactly
    // that reason (see fal-models.js).
    const elevenEntry = VOICE_MODELS.find((m) => m.id === "fal-ai/elevenlabs/tts/eleven-v3");
    const elevenConfirms = elevenEntry?.autoDetectedLanguagesSupported?.some((l) => normalizeLanguageForMatch(l) === normalized);
    if (gemini31Confirms) {
      reasons.push(`You're generating in ${language} — Gemini 3.1 Flash TTS has confirmed real support for this language (one of 70+ it covers, including the broadest confirmed Indian-regional-language set of any model here) and is independently benchmarked as the most natural-sounding voice model available, which directly answers "the voices don't sound natural" as much as "does it cover my language."`);
      return { modelId: "fal-ai/gemini-3.1-flash-tts", reasons, confidence: "high", alternativeModelId: elevenConfirms ? "fal-ai/elevenlabs/tts/eleven-v3" : "fal-ai/gemini-tts" };
    }
    if (geminiConfirms && elevenConfirms) {
      reasons.push(`You're generating in ${language} — both Gemini TTS (2.5) and ElevenLabs Eleven v3 have confirmed real support for this language. Gemini TTS takes it as an explicit parameter; ElevenLabs auto-detects it from the text's script instead. Recommending Gemini TTS as the more predictable of the two, but ElevenLabs is a genuinely good alternative, especially for more expressive/character delivery.`);
      return { modelId: "fal-ai/gemini-tts", reasons, confidence: "high", alternativeModelId: "fal-ai/elevenlabs/tts/eleven-v3" };
    }
    if (geminiConfirms) {
      reasons.push(`You're generating in ${language} — Gemini TTS (2.5) has confirmed real support for this language, one of 12+ Indian regional languages it genuinely covers. Most other voice models here only confirm Hindi (if any Indian language at all) and fall back to unconfirmed "auto" detection for the rest.`);
      return { modelId: "fal-ai/gemini-tts", reasons, confidence: "high" };
    }
    if (elevenConfirms) {
      reasons.push(`You're generating in ${language} — ElevenLabs Eleven v3 has confirmed real support for this language (it auto-detects language directly from the text's script rather than needing it set explicitly).`);
      return { modelId: "fal-ai/elevenlabs/tts/eleven-v3", reasons, confidence: "high" };
    }
    // Checked before the plain speech-02-hd fallback: 2.6-hd has a
    // genuinely broader confirmed language enum than 02-hd for this exact
    // purpose (adds confirmed Tamil).
    const minimax26Entry = VOICE_MODELS.find((m) => m.id === "fal-ai/minimax/speech-2.6-hd");
    const minimax26Confirms = minimax26Entry?.confirmedLanguages?.some((l) => normalizeLanguageForMatch(l) === normalized);
    if (minimax26Confirms) {
      reasons.push(`You're generating in ${language} — MiniMax Speech-2.6 HD has confirmed real support for this language (a broader confirmed set than the 02-HD generation, including Tamil).`);
      return { modelId: "fal-ai/minimax/speech-2.6-hd", reasons, confidence: "high" };
    }
    const minimaxEntry = VOICE_MODELS.find((m) => m.id === "fal-ai/minimax/speech-02-hd");
    const minimaxConfirms = minimaxEntry?.confirmedLanguages?.some((l) => normalizeLanguageForMatch(l) === normalized);
    if (minimaxConfirms) {
      reasons.push(`You're generating in ${language} — MiniMax Speech-02 HD has confirmed real support for this language.`);
      return { modelId: "fal-ai/minimax/speech-02-hd", reasons, confidence: "high" };
    }
    if (CONFIRMED_INDIAN_LANGUAGES.has(normalized)) {
      reasons.push(`You're generating in ${language}. Being honest about a real limit: no model in this app's registry has CONFIRMED support for this exact language. Gemini 3.1 Flash TTS has the broadest confirmed set of Indian languages here, so it's still the best bet — but this specific one hasn't been directly verified. Try it; if quality isn't there, that's a real limit right now, not a bug to chase.`);
      return { modelId: "fal-ai/gemini-3.1-flash-tts", reasons, confidence: "low", languageGap: true };
    }
    reasons.push(`You're generating in ${language} — no model here has confirmed support for it specifically. Defaulting to MiniMax Speech-02 HD (broadest general confirmed coverage, 30+ languages), but treat this as untested for your language.`);
    return { modelId: "fal-ai/minimax/speech-02-hd", reasons, confidence: "low", languageGap: true };
  }
  if (wantsEmotionControl) {
    reasons.push("You want emotion/pitch/speed control — MiniMax Speech-02 HD is the only model here with confirmed emotion control (7 real emotions) alongside pitch/speed tuning.");
    return { modelId: "fal-ai/minimax/speech-02-hd", reasons, confidence: "high" };
  }
  if (prioritize === "budget") {
    reasons.push("Budget-conscious request — Inworld TTS-1.5 Max is the cheapest confirmed option here.");
    return { modelId: "fal-ai/inworld-tts", reasons, confidence: "medium" };
  }
  reasons.push("Standard voice request, English or unspecified language — MiniMax Speech-02 HD is the most thoroughly confirmed general-purpose option here (300+ voices, 30+ languages, emotion control).");
  return { modelId: "fal-ai/minimax/speech-02-hd", reasons, confidence: "high" };
}
app.post("/api/voice/recommend-model", (req, res) => {
  const { language, wantsEmotionControl, wantsOwnVoice, prioritize } = req.body;
  res.json(recommendVoiceModel({ language, wantsEmotionControl, wantsOwnVoice, prioritize }));
});

// ============================================================
// VOICE VARIATION DIRECTIONS (Phase 8) — generates N genuinely distinct
// creative directions for one line, each mapped to REAL settings for
// the specific model selected — never a generic label with nothing
// real behind it. For emotion-capable models (MiniMax), maps to a real
// confirmed emotion. For tag-based models (ElevenLabs/Gemini), maps to
// a real bracket-tag cue embedded via the SAME translateScriptMarkers
// infrastructure already built and tested for the *word* markup system
// — no parallel mechanism invented. For a model with no real
// expressive lever at all, this is honest about that instead of
// generating N near-identical clips and calling them "variations."
//
// REAL BUG FIXED HERE: this used to also vary VOICE per take — meaning
// whichever voice a person picked in the line's own dropdown was
// silently overridden and reassigned differently for every single take,
// even on a single-voice generation. Voice, language, speed, and pitch
// are the person's own deliberate choices, not something "creative
// direction" should touch — only emotion/delivery genuinely benefits
// from exploring multiple takes of the SAME voice. Voice is now a fixed
// input to this function, never something it generates or varies.
// ============================================================
async function generateVoiceDirections({ lineText, model, count, apiKey }) {
  const hasEmotions = !!model.confirmedEmotions?.length;
  const hasTags = !!model.autoDetectsLanguageFromText || model.markupTagMode === "freeform";

  if (!hasEmotions && !hasTags) {
    return {
      directions: [{ label: "Default", emotion: null, tagPrefix: null }],
      cappedReason: `${model.label} has no real expressive control beyond a single delivery — genuinely different takes aren't possible on this model. Switch to MiniMax (emotion control), or ElevenLabs/Gemini TTS (descriptive delivery tags) for meaningful variation.`,
    };
  }

  const realLevers = [
    hasEmotions ? `real confirmed emotions: ${model.confirmedEmotions.join(", ")}` : null,
    hasTags ? `descriptive delivery tags embedded in the text (e.g. "confident", "warm", "urgent" — any real English word works, this model reads them directly)` : null,
  ].filter(Boolean).join(". ");

  const prompt = `You are directing ${count} genuinely different performances of ONE line, in the SAME voice, for a professional voice production tool. Real constraints for the model actually being used — do not invent anything outside these: ${realLevers}.

LINE TO PERFORM: "${lineText}"

Generate exactly ${count} DISTINCT creative directions for this line — each should sound meaningfully different in DELIVERY/EMOTION when actually performed (e.g. calm/premium vs energetic/advertising vs dramatic/cinematic), grounded in the real levers above. Do not suggest a different voice — only how the SAME voice delivers this line differently.

Return ONLY this JSON array, no markdown fences: [{"label": "short 2-4 word description", ${hasEmotions ? `"emotion": "one of the confirmed emotions listed above", ` : ""}${hasTags ? `"tagPrefix": "one real descriptive word for the delivery tag", ` : ""}"reasoning": "one short phrase on why this direction fits"}]`;

  try {
    const response = await falTextRequest(prompt, { apiKey, temperature: 0.9, costMeta: { endpoint: "voice-directions" } });
    const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    // Real, deliberate validation — never trust the LLM's own claim of an
    // emotion without checking it against what's ACTUALLY real for this
    // model, same discipline as the model-enrichment contradiction guard
    // built earlier this session.
    const validated = (Array.isArray(parsed) ? parsed : []).slice(0, count).map((d, i) => ({
      label: d.label || `Take ${i + 1}`,
      emotion: hasEmotions && model.confirmedEmotions.includes(d.emotion) ? d.emotion : null,
      tagPrefix: hasTags && typeof d.tagPrefix === "string" ? d.tagPrefix.trim() : null,
      reasoning: d.reasoning || null,
    }));
    if (validated.length) return { directions: validated, cappedReason: null };
  } catch (err) {
    console.warn(`[Voice Directions] Couldn't get AI-directed variations (${err.message}) — falling back to cycling real emotions directly.`);
  }
  // Fallback if the AI call fails entirely — still genuinely real, just
  // mechanical instead of creatively directed: cycles through actual
  // confirmed emotions rather than returning nothing. Never touches voice.
  const fallbackDirections = [];
  for (let i = 0; i < count; i++) {
    fallbackDirections.push({
      label: hasEmotions ? model.confirmedEmotions[i % model.confirmedEmotions.length] : `Take ${i + 1}`,
      emotion: hasEmotions ? model.confirmedEmotions[i % model.confirmedEmotions.length] : null,
      tagPrefix: null,
      reasoning: null,
    });
  }
  return { directions: fallbackDirections, cappedReason: null };
}
app.post("/api/voice/script/generate-variations", async (req, res) => {
  try {
    const { lineText, modelId, count = 4, runId, userApiKey, voiceId, language, speed, pitch, emotion: fixedEmotion } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!lineText?.trim()) return res.status(400).json({ error: "No line text provided." });
    const model = VOICE_MODELS.find((m) => m.id === modelId);
    if (!model) return res.status(400).json({ error: `Unknown voice model: ${modelId}` });
    const safeCount = Math.min(8, Math.max(1, parseInt(count) || 4));
    // REAL FIX: a single take means "generate exactly what I configured,"
    // full stop — no AI creative-direction layer at all, so the person's
    // own emotion choice is respected exactly rather than a directed
    // reinterpretation of it. Multiple takes still explore emotion/
    // delivery variety (see generateVoiceDirections above), but even
    // then voice/language/speed/pitch are FIXED to the line's own
    // settings for every single take, never reassigned.
    const { directions, cappedReason } = safeCount === 1
      ? { directions: [{ label: "Take 1", emotion: fixedEmotion || null, tagPrefix: null, reasoning: null }], cappedReason: null }
      : await generateVoiceDirections({ lineText, model, count: safeCount, apiKey });
    const results = await Promise.all(
      directions.map(async (direction, i) => {
        try {
          const textWithTag = direction.tagPrefix ? `*${direction.tagPrefix}* ${lineText}` : lineText;
          const input = model.buildInput(textWithTag, {
            voiceId, // fixed — the person's own choice, never reassigned per take
            emotion: direction.emotion || fixedEmotion,
            language, // REAL FIX: this was never sent/used at all before — language_boost/language_code now actually reaches the model
            speed, // REAL FIX: same — the speed slider had zero effect on generated audio until now
            pitch, // REAL FIX: same
          });
          const strippedMarkers = input.__strippedMarkers || [];
          const result = await falVoiceRequest(model.id, input, {
            apiKey, costPer1kChars: model.costPer1kChars, textLength: lineText.length,
            costMeta: { runId, endpoint: "voice-variation", frameIndex: i },
          });
          const dataUri = await downloadImageAsDataUri(result.url);
          // REAL FIX: durationMs was computed by falVoiceRequest but
          // discarded here — so there was no way to see how long a take
          // actually ran, which matters directly for dialogue pacing.
          return { ...direction, audio: dataUri, durationMs: result.durationMs ?? null, modelUsed: model.id, strippedMarkers, error: null };
        } catch (err) {
          return { ...direction, audio: null, durationMs: null, modelUsed: model.id, error: err.message };
        }
      }),
    );
    res.json({ results, cappedReason, modelUsed: model.id });
  } catch (error) {
    console.error("Voice variation generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// AUDIO LIBRARY (Phase 11) — real, simple REST endpoints over the
// db.js functions above. Deliberately minimal: list/save/delete/
// favorite is enough to make generated audio actually reusable instead
// of vanishing when a modal closes, without over-building before real
// usage shows what's actually needed beyond that.
// ============================================================
app.get("/api/audio-library", (req, res) => {
  try {
    res.json({ items: db.listAudioLibraryItems({ type: req.query.type || undefined }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/api/audio-library", (req, res) => {
  try {
    const { type, name, audioDataUri, modelUsed, voiceUsed, language, runId, metadata } = req.body;
    if (!type || !["voice", "song", "sfx"].includes(type)) return res.status(400).json({ error: "type must be 'voice', 'song', or 'sfx'." });
    if (!name?.trim()) return res.status(400).json({ error: "Missing a name for this item." });
    if (!audioDataUri) return res.status(400).json({ error: "Missing audio data." });
    const id = db.saveAudioLibraryItem({ type, name: name.trim(), audioDataUri, modelUsed, voiceUsed, language, runId, metadata });
    res.json({ id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.delete("/api/audio-library/:id", (req, res) => {
  try {
    db.deleteAudioLibraryItem(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post("/api/audio-library/:id/favorite", (req, res) => {
  try {
    const favorite = db.toggleAudioLibraryFavorite(parseInt(req.params.id));
    if (favorite === null) return res.status(404).json({ error: "Item not found." });
    res.json({ favorite });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// SONG VARIATION DIRECTIONS (Phase 10) — generates N distinct musical
// direction reinterpretations of one brief (e.g. cinematic vs
// commercial pop vs stripped-back acoustic vs dark moody electronic),
// keeping the lyrics unchanged across versions so the song's actual
// content stays consistent while the production direction varies. Real
// AI-authored directions, not generic labels — same discipline as the
// voice variation directions above. Capped lower than voice (max 4, not
// 8) since a real song generation costs and takes much longer per clip
// than a short voice line does — 8 full songs in one batch would be a
// genuinely expensive, slow request.
// ============================================================
async function generateSongDirections({ style, lyrics, model, count, apiKey }) {
  const isInstrumental = !!model.instrumentalOnly;
  const prompt = `You are directing ${count} genuinely different musical interpretations of the same song brief for a professional music production tool.

ORIGINAL STYLE/MOOD BRIEF: "${style}"
${isInstrumental ? "" : `LYRICS (must stay exactly the same across all versions — only the musical direction changes): "${(lyrics || "").slice(0, 500)}${(lyrics || "").length > 500 ? "..." : ""}"`}

Generate exactly ${count} DISTINCT musical direction reinterpretations of this brief — each should sound genuinely different in genre/arrangement/energy when actually produced (e.g. cinematic orchestral vs upbeat commercial pop vs stripped-back acoustic vs dark moody electronic), while staying true to the original brief's core idea${isInstrumental ? "" : " and never changing the lyrics themselves"}.

Return ONLY this JSON array, no markdown fences: [{"label": "short 2-4 word description (e.g. \\"Cinematic\\", \\"Commercial Pop\\")", "styleDirection": "a full, detailed style/mood/genre/instrumentation prompt for this specific direction, written as a real production brief", "reasoning": "one short phrase on why this direction fits"}]`;

  try {
    const response = await falTextRequest(prompt, { apiKey, temperature: 0.9, costMeta: { endpoint: "song-directions" } });
    const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    const validated = (Array.isArray(parsed) ? parsed : []).slice(0, count).map((d, i) => ({
      label: d.label || `Version ${String.fromCharCode(65 + i)}`,
      styleDirection: typeof d.styleDirection === "string" && d.styleDirection.trim() ? d.styleDirection.trim() : style,
      reasoning: d.reasoning || null,
    }));
    if (validated.length) return validated;
  } catch (err) {
    console.warn(`[Song Directions] Couldn't get AI-directed variations (${err.message}) — falling back to simple style-prefix variations.`);
  }
  // Fallback if the AI call fails entirely — still genuinely different
  // (real distinct genre prefixes), just not creatively reasoned.
  const fallbackLabels = ["Cinematic", "Upbeat", "Stripped Back", "Moody"];
  return Array.from({ length: count }, (_, i) => ({
    label: fallbackLabels[i % fallbackLabels.length],
    styleDirection: `${fallbackLabels[i % fallbackLabels.length]} version: ${style}`,
    reasoning: null,
  }));
}
app.post("/api/music/generate-variations", async (req, res) => {
  try {
    const { style, lyrics, modelId, count = 3, durationSeconds, runId, userApiKey } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!style?.trim()) return res.status(400).json({ error: "Missing style/mood description." });
    const model = MUSIC_MODELS.find((m) => m.id === modelId);
    if (!model) return res.status(400).json({ error: `Unknown music model: ${modelId}` });
    if (!model.instrumentalOnly && (!lyrics || !lyrics.trim())) return res.status(400).json({ error: "Missing lyrics." });
    const safeCount = Math.min(4, Math.max(1, parseInt(count) || 3));
    const directions = await generateSongDirections({ style, lyrics, model, count: safeCount, apiKey });
    const results = await Promise.all(
      directions.map(async (direction, i) => {
        try {
          const secondArg = model.instrumentalOnly ? (model.supportsNegativePrompt ? lyrics?.trim() : undefined) : lyrics?.trim();
          const input = model.buildInput(direction.styleDirection, secondArg, { durationSeconds: model.supportsDuration ? parseInt(durationSeconds) : undefined });
          const result = await falVoiceRequest(model.id, input, {
            apiKey, costMeta: { runId, endpoint: "song-variation", model: model.id, frameIndex: i },
            flatCost: model.costPerGeneration || 0.05,
          });
          const dataUri = await downloadImageAsDataUri(result.url);
          return { ...direction, audio: dataUri, modelUsed: model.id, error: null };
        } catch (err) {
          return { ...direction, audio: null, modelUsed: model.id, error: err.message };
        }
      }),
    );
    res.json({ results, modelUsed: model.id });
  } catch (error) {
    console.error("Song variation generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

function recommendMusicModel({ wantsVocals, wantsOwnVoice, language, prioritize }) {
  const reasons = [];
  if (wantsOwnVoice) {
    reasons.push("You want your own actual voice in the track — only Seed Audio 1.0 has a real, confirmed reference-voice mechanism among the models here.");
    return { modelId: "bytedance/seed-audio-1.0", reasons, confidence: "high" };
  }
  if (!wantsVocals) {
    if (prioritize === "speed") {
      reasons.push("You want instrumental only, prioritizing speed — CassetteAI is confirmed to generate a full 3-minute track in under 10 seconds, the fastest of the real instrumental options here.");
      return { modelId: "CassetteAI/music-generator", reasons, confidence: "high" };
    }
    reasons.push("You want instrumental only — Lyria 2 (Google) gives real negative-prompt control and 48kHz output for precise instrumental/ambient work.");
    return { modelId: "fal-ai/lyria2", reasons, confidence: "high" };
  }
  // Wants vocals from here on. Computed LIVE from each model's own
  // confirmedVocalLanguages array instead of a hand-typed list here —
  // this is the exact bug being fixed: Lyria 3 Pro was added to
  // MUSIC_MODELS with real confirmed Hindi (+7 other languages) vocal
  // support, but this function still said "none of the models have
  // confirmed non-English vocal support" because nobody updated this
  // hardcoded array to match. Reading it straight from the registry
  // means it can't go stale like that again the next time a model with
  // real non-English vocal support gets added.
  const modelsWithLanguage = (lang) =>
    MUSIC_MODELS.filter((m) => (m.confirmedVocalLanguages || []).some((l) => l.toLowerCase() === lang.toLowerCase()));
  const languageIsNonEnglish = language && language.toLowerCase() !== "english";
  if (languageIsNonEnglish) {
    const matches = modelsWithLanguage(language);
    if (matches.length) {
      const best = matches[0];
      reasons.push(`You asked for vocals in ${language} — ${best.label.replace(/^★ /, "")} has real, confirmed sung-vocal support for it (not just spoken narration), the only model(s) here that do: ${matches.map((m) => m.label.replace(/^★ /, "")).join(", ")}.`);
      return { modelId: best.id, reasons, confidence: "high" };
    }
    reasons.push(`You asked for vocals in ${language}. Being honest about a real, narrower gap than before: Lyria 3 Pro now has confirmed sung-vocal support for 8 languages (English, German, Spanish, French, Hindi, Japanese, Korean, Portuguese) — closing the Hindi gap — but ${language} still isn't confirmed in any model here. Defaulting to the strongest confirmed vocal model for structure/quality; try it, and if the language doesn't come through, that's the actual limit right now, not a bug to chase.`);
    return { modelId: "fal-ai/minimax-music/v2", reasons, confidence: "low", languageGap: true };
  }
  if (prioritize === "budget") {
    reasons.push("Budget-conscious vocal track — ACE-Step is confirmed the cheapest lyrics-based option (~$0.0002/second), with real [verse]/[chorus]/[bridge] structure support.");
    return { modelId: "fal-ai/ace-step", reasons, confidence: "high" };
  }
  if (prioritize === "quality") {
    reasons.push("Highest production quality prioritized — ElevenLabs Music gives section-level composition control, at a higher real cost ($0.80/output minute).");
    return { modelId: "fal-ai/elevenlabs/music", reasons, confidence: "high" };
  }
  reasons.push("Standard vocal track request — MiniMax Music 2.0 is the most thoroughly confirmed lyrics+style model here, with a real dual-input schema and reasonable $0.03/generation cost.");
  return { modelId: "fal-ai/minimax-music/v2", reasons, confidence: "high" };
}

app.post("/api/music/write-lyrics", async (req, res) => {
  try {
    const {
      storyPrompt, referenceNotes, lyricLanguageStyle,
      emotionalFeel, vocalStyle, lyricalGenre, wantsVocals, wantsOwnVoice, prioritize,
      textModel, userApiKey, runId: clientRunId,
    } = req.body;
    if (!storyPrompt || !storyPrompt.trim()) return res.status(400).json({ error: "Missing your song idea/story." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    // First step of a Song Studio session — minted here and returned so
    // the frontend can reuse it for the actual music/generate call that
    // follows, so "cost of this song" (lyrics + generation) is one real
    // number instead of the lyric-writing cost being an orphaned row.
    const runId = clientRunId || crypto.randomUUID();
    // Real, explicit control instead of leaving language/cultural style to
    // guesswork — this is the actual gap that produced a generic Western
    // pop ballad from a story that was itself written in Indian English
    // with real Telugu code-switching ("ani") and Hindi/Telugu song
    // references.
    const languageInstruction = {
      match: `Look carefully at how the story below is actually written — if it naturally mixes in words or particles from an Indian language (like "ani" in Telugu, meaning "saying that"/"like that", or similar words from Hindi or other Indian languages), that mixing is real and intentional, part of how this person actually speaks. Reflect that SAME mixing style in the lyrics — do not launder it into pure, generic English. If none of that is present, plain English is fine.`,
      english: `Write these lyrics in English, but keep an Indian-English rhythm and phrasing sensibility if the story or reference material suggests that world, rather than a generic Western pop cadence.`,
    }[lyricLanguageStyle] || (lyricLanguageStyle
      ? `Write these lyrics primarily in ${lyricLanguageStyle} (native script), with natural English code-switching only where it would genuinely occur in real speech for a bilingual speaker — not fully English, not stiff textbook ${lyricLanguageStyle} either.`
      : `Look carefully at how the story below is actually written — if it naturally mixes in words from an Indian language, reflect that same mixing style. If not, plain English is fine.`);
    // Real, specific handling for the vocal delivery/genre the person
    // asked for, rather than a single generic "songwriter" persona —
    // rap needs real rhythm/rhyme-scheme awareness distinct from a sung
    // ballad, and this makes that difference explicit rather than
    // hoping the model infers it from one word in a sea of instructions.
    const styleGuidance = {
      rap: `Write in a genuine RAP cadence — real rhyme schemes, internal rhymes, punchlines, and rhythmic flow built for spoken/rhythmic delivery over a beat, not a sung melody. Line lengths and stress patterns should read like rap bars, not verse-chorus pop lyrics.`,
      classic: `Write in a classic, timeless songwriting style — clear verse/chorus structure, singable melody-friendly phrasing, the kind of lyric that would sit comfortably in a well-known ballad or standard.`,
      poetic: `Lean into rich imagery, metaphor, and poetic language — prioritize evocative, layered meaning over simple, direct statements.`,
      folk: `Write with a folk/storytelling sensibility — narrative, conversational, grounded in concrete detail and a personal voice, like someone telling a real story around a fire.`,
    }[lyricalGenre] || "";
    const vocalDeliveryNote = vocalStyle ? `The vocal delivery should feel: ${vocalStyle}.` : "";
    const emotionalNote = emotionalFeel ? `The emotional core of this song is: ${emotionalFeel} — every line should serve that feeling.` : "";
    const writePrompt = `You are a professional songwriter who is genuinely fluent in Indian-English songwriting and Indian-language code-switching (Telugu, Hindi, etc.) — not only Western pop songwriting conventions. A huge, common failure mode to avoid: taking a story written by an Indian person, referencing Indian songs, and turning it into a generic Western pop/R&B ballad that could have been written for any American artist with the names swapped in — same structure, same phrasing clichés, same emotional delivery style as a thousand English pop songs, none of the original cultural texture surviving. Do not do that.

${languageInstruction}
${styleGuidance}
${vocalDeliveryNote}
${emotionalNote}

If reference tracks are mentioned below, match their actual genre and cultural/musical sensibility — the real phrasing style, the way emotion is expressed, the imagery used in that specific genre — not just a generic mood word like "upbeat" taken in isolation. A Telugu/Hindi film-music-influenced reference should produce lyrics that feel like they belong in that world, not a Western chart-pop structure with a translated feeling bolted on.

Turn the following personal story/idea into song lyrics with real structure, using [Intro], [Verse], [Chorus], [Bridge], [Outro] tags (only the ones that genuinely fit — not every song needs all of them).
Keep the person's real, specific details, names, and emotional meaning intact — don't generalize them away into generic lyrics.
${referenceNotes ? `Reference tracks/style mentioned (match their genre and cultural sensibility, not just a generic mood word; do not copy any actual lyrics from them, write entirely original words): ${referenceNotes}` : ""}
Also write a separate short (10-300 character) style/mood/genre description suitable for an AI music generator — instruments, energy, genre, mood.
Return ONLY valid JSON in this exact shape, no explanation, no markdown fences:
{"lyrics": "...", "style": "..."}
STORY/IDEA: ${storyPrompt.trim()}`;
    const response = await falTextRequest(writePrompt, {
      model: textModel || DEFAULT_TEXT_MODEL,
      apiKey,
      temperature: 0.8,
      costMeta: { runId, endpoint: "music-write-lyrics" },
    });
    let parsed;
    try {
      parsed = JSON.parse(response.text.trim().replace(/^```json\s*|```$/g, ""));
    } catch {
      throw new Error("The songwriting step didn't return valid structured output — try again.");
    }
    const recommendation = recommendMusicModel({
      wantsVocals: wantsVocals !== false, // default true unless explicitly told otherwise
      wantsOwnVoice: !!wantsOwnVoice,
      language: lyricLanguageStyle && lyricLanguageStyle !== "match" && lyricLanguageStyle !== "english" ? lyricLanguageStyle : null,
      prioritize,
    });
    res.json({ lyrics: parsed.lyrics, style: parsed.style, recommendation, runId });
  } catch (error) {
    console.error(`[Music] Lyric writing failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/music/generate", async (req, res) => {
  let runId;
  try {
    const { style, lyrics, referenceAudioBase64, modelId: rawModelId, durationSeconds, userApiKey, runId: clientRunId } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    // Phase 12 / Section 22 — same proven pattern as image/video/voice:
    // swap a genuinely deprecated model for a real capability-matched
    // replacement automatically, applied once here so every branch below
    // (reference-voice, lyrics, custom model) benefits without needing
    // its own separate check.
    const { resolvedModelId: modelId, replacementNote: musicReplacementNote } = resolveModelOrReplacement(rawModelId);
    if (musicReplacementNote) console.warn(`[Model Replacement] ${musicReplacementNote}`);
    let model, input;
    const knownModel = modelId ? MUSIC_MODELS.find((m) => m.id === modelId) : null;
    if (referenceAudioBase64) {
      // Reference-voice path — Seed Audio 1.0 (or a custom model ID),
      // genuinely different capability from the lyrics-only flow below.
      if (!style || !style.trim()) return res.status(400).json({ error: "Missing a description of what you want (mention @Audio1 to reference your voice clip)." });
      // toFalImageUrl is a generic data-URI/URL passthrough despite the
      // name (confirmed earlier tonight) — reused directly for the
      // reference audio clip rather than building a separate upload path.
      const referenceUrl = toFalImageUrl(referenceAudioBase64, "audio/wav");
      model = knownModel || MUSIC_MODELS.find((m) => m.supportsVoiceReference);
      if (knownModel || !modelId) {
        if (!model) return res.status(400).json({ error: "No reference-voice model available." });
        input = model.buildInput(style.trim(), [referenceUrl]);
      } else {
        // Genuinely custom/unverified model ID — try it for real with a
        // reasonable generic shape rather than silently swapping in Seed
        // Audio, which would be misleading (same honest standard as
        // Voice Studio's custom-model support).
        model = { id: modelId, label: modelId, costPerGeneration: 0.05 };
        input = { prompt: style.trim(), audio_urls: [referenceUrl] };
      }
      progress.startProgress(runId, "generating-music", "Generating with your reference voice — this can take a minute or two...");
    } else {
      if (!style || !style.trim()) return res.status(400).json({ error: "Missing style/mood description." });
      // Only require lyrics for models that actually have a lyrics field
      // in their real schema — Lyria 2 and CassetteAI genuinely don't,
      // and requiring one here would block a valid generation path for
      // no real reason.
      const willBeInstrumentalOnly = knownModel?.instrumentalOnly;
      if (!willBeInstrumentalOnly && (!lyrics || !lyrics.trim())) return res.status(400).json({ error: "Missing lyrics." });
      model = knownModel || MUSIC_MODELS.find((m) => !m.supportsVoiceReference) || MUSIC_MODELS[0];
      if (knownModel || !modelId) {
        // Real, confirmed gap fixed here: this used to unconditionally
        // pass undefined for every instrumental-only model's second
        // buildInput argument, on the reasoning that it might be stale
        // lyrics text left over from switching models. That's still
        // correct for a model with no real use for a second argument at
        // all (CassetteAI) — but Lyria2 genuinely supports negative_prompt,
        // and the frontend now correctly relabels this same field for
        // that purpose when Lyria2 is selected (see
        // updateSongLyricsModelHint), so what's actually in it at that
        // point is a real negative prompt, not leftover lyrics.
        const secondArg = willBeInstrumentalOnly ? (model.supportsNegativePrompt ? lyrics?.trim() : undefined) : lyrics?.trim();
        input = model.buildInput(style.trim(), secondArg, { durationSeconds: model.supportsDuration ? durationSeconds : undefined });
      } else {
        model = { id: modelId, label: modelId, costPerGeneration: 0.05 };
        input = { prompt: style.trim(), lyrics_prompt: lyrics?.trim() };
      }
      progress.startProgress(runId, "generating-music", "Composing your song — this can take a minute or two...");
    }
    const result = await falVoiceRequest(model.id, input, {
      apiKey,
      costMeta: { runId, endpoint: "music-generate", model: model.id },
      flatCost: model.costPerGeneration || 0.05, // Seed Audio's exact price isn't confirmed on its own page — reasonable placeholder for the cost ledger only, not a claimed real rate
      progressLabel: referenceAudioBase64 ? "Generating with your reference voice — this can take a minute or two..." : "Composing your song — this can take a minute or two...",
    });
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(result.url);
    res.json({ audio: dataUri, modelUsed: model.id, replacementNote: musicReplacementNote });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[Music] Generation failed: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// ============================================================
// SFX PROMPT REFINEMENT — the real model here (CassetteAI) takes one
// flat text prompt for one continuous clip, up to 30 seconds, no
// separate intro/outro fields, no vocals, no music structure. Most
// people describing a sound don't think in those terms ("Netflix-like",
// "upbeat excitement and curiosity") — this translates a casual brief
// into a specific, professional sound-design prompt the model will
// actually respond well to, structured as ONE cohesive sound that
// naturally opens, builds, and resolves (a real sonic-logo brief, not a
// promise of separate generated segments this model can't produce).
// Asks clarifying questions only when something essential is genuinely
// missing, not as a default step.
// ============================================================
app.post("/api/sfx/refine-prompt", async (req, res) => {
  try {
    const { description, previousQuestions, answers, userApiKey } = req.body;
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    if (!description?.trim()) return res.status(400).json({ error: "Describe the sound you want first." });
    const context = previousQuestions?.length && answers?.length
      ? `\n\nFOLLOW-UP: they were asked "${previousQuestions.join('" and "')}" and answered: "${answers.join('", "')}"`
      : "";
    const prompt = `You are a professional sound designer helping someone brief an AI sound-effect generator. They likely don't know audio production terminology — your job is to translate their casual description into precise sound-design language, not to expect them to already speak it.

THEIR DESCRIPTION: "${description.trim()}"${context}

REAL CONSTRAINT on the actual generator this goes to: it produces ONE continuous sound clip, up to 30 seconds, from a single text prompt — no separate intro/outro generation steps, no vocals, no musical composition. If they want something with a beginning and an end (like "intro and outro"), write ONE prompt describing a sound that naturally opens (a rise/swell/build), has a clear core moment, and resolves (a tail/decay/settle) — a real sonic-logo brief, the way a professional would actually write one, not a promise of multiple separate pieces.

Decide: is there enough here to write a strong, specific prompt, or is something ESSENTIAL missing (no sense of mood/energy/instrumentation/context at all)? Their example above already has real usable detail (brand context, tone, structural want, a style reference) — don't ask questions just because it's casually phrased; only ask if something truly essential is absent.

If essential information is missing, return: {"needsClarification": true, "questions": ["...", "..."]} — at most 2 short, specific questions.
Otherwise return: {"needsClarification": false, "refinedPrompt": "a specific, professional, ready-to-use sound-design prompt, one continuous description", "explanation": "one short sentence on what you translated or added and why"}

Return ONLY this JSON, no markdown fences.`;
    const response = await falTextRequest(prompt, { apiKey, temperature: 0.7, costMeta: { endpoint: "sfx-prompt-refine" } });
    const parsed = JSON.parse(response.text.replace(/```json|```/g, "").trim());
    res.json(parsed);
  } catch (error) {
    console.error("SFX prompt refinement error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/sfx/generate", async (req, res) => {
  let runId;
  try {
    const { prompt, durationSeconds, modelId, userApiKey, runId: clientRunId } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: "Describe the sound you want (e.g. \"a short cinematic whoosh into a deep bass hit, like a Netflix intro\")." });
    const apiKey = userApiKey || process.env.FAL_KEY;
    if (!apiKey) return res.status(401).json({ error: "Missing Fal API Key." });
    runId = clientRunId || crypto.randomUUID();
    const model = SFX_MODELS.find((m) => m.id === modelId) || SFX_MODELS[0];
    const input = model.buildInput(prompt.trim(), durationSeconds);
    progress.startProgress(runId, "generating-music", "Generating sound effect...");
    const result = await falVoiceRequest(model.id, input, {
      apiKey, costMeta: { runId, endpoint: "sfx-generate", model: model.id }, flatCost: model.costPerGeneration || 0.01,
    });
    progress.finishProgress(runId);
    const dataUri = await downloadImageAsDataUri(result.url);
    res.json({ audio: dataUri, modelUsed: model.id });
  } catch (error) {
    if (runId) progress.finishProgress(runId);
    console.error(`[SFX] Generation failed: ${error.message}`);
    res.status(error.isSafetyBlock ? 403 : 500).json({ error: error.message });
  }
});

// Frontend-triggered voice verification — the real fix for the startup
// key problem: this app's actual auth is a user-submitted key from the
// browser, which only exists once a real request comes in. Called once
// on app load; the function itself no-ops if the persisted cache is
// still fresh, so this is cheap to call even when there's nothing to do.
app.post("/api/voice/verify-catalog", (req, res) => {
  const { userApiKey, forceRecheck } = req.body;
  const apiKey = userApiKey || process.env.FAL_KEY;
  if (!apiKey) return res.status(401).json({ error: "No API key available to verify with." });
  if (forceRecheck) voiceCatalog.clearCache(); // otherwise the freshness guard inside verifyAllVoices would just skip this
  voiceCatalog.verifyAllVoices(apiKey); // deliberately not awaited — runs in the background, response returns immediately
  res.json({ started: true, status: voiceCatalog.getVoiceCatalogStatus() });
});
app.get("/api/voice/catalog-status", (req, res) => res.json(voiceCatalog.getVoiceCatalogStatus()));

app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(PORT, () => {
  console.log(`Server executing seamlessly at http://localhost:${PORT}`);
  console.log(`[Version] Migrated from Google (Gemini/Veo) to Fal.ai — image/video generation now routes through fal-client.js with a model registry (fal-models.js) and dropdown-selectable models; text/JSON reasoning and vision analysis run through fal-ai/any-llm and fal-ai/any-llm/vision. Added GET /api/models and POST /api/regenerate-frame.`);
  console.log(`[Concurrency] All Fal calls now share one app-wide concurrency limit (${process.env.FAL_MAX_CONCURRENCY || 3} at a time, default — confirmed against Fal's own account limits, which start at 2 for new accounts and scale to 40). Set FAL_MAX_CONCURRENCY in the environment to match your actual account tier if you're seeing slower-than-expected throughput or timeouts under load.`);

  // Model catalog: load whatever was persisted from last time FIRST (see
  // fal-catalog.js's initFromPersistedCache), synchronously, before
  // deciding whether a live check is even needed. This is the actual
  // optimization: a server restart 30 seconds after the last real check
  // — which happens constantly with nodemon during development — now
  // costs ZERO Fal API calls instead of repeating the whole verification
  // from an empty cache every single time. Only a genuinely stale (or
  // first-ever) cache triggers a live check.
  // Real, confirmed gap closed here: this used to only ever check
  // IMAGE_MODELS and VIDEO_MODELS against Fal's live catalog — MUSIC_
  // MODELS, SFX_MODELS, VOICE_CLONE_MODELS, TALKING_AVATAR_MODELS, and
  // the UTILITY_MODELS (upscale/extend/restore/videoBackground) were
  // never checked at all, so a deprecated model in any of those
  // categories would only be discovered when a real generation call
  // failed. VOICE_MODELS is now INCLUDED here (previously deliberately
  // excluded) — this refresh is the free OpenAPI-schema/metadata check
  // (findModelsLive, via GET /v1/models?expand=openapi-3.0), not a paid
  // generation, so there's no real cost reason to leave voice models
  // out of it. What's still correctly kept separate is the OTHER voice
  // verification system (voiceCatalog.verifyAllVoices, below) — that one
  // does real, individually-billed test generations per voice and
  // genuinely does need a real user API key, so it stays frontend-
  // triggered. This schema refresh is what makes fal-voice-catalog.js's
  // live voice/language/emotion enum merge (see withLiveDiscoveredData)
  // actually have real data to merge, instead of silently no-op'ing
  // forever because the server never fetched a voice model's schema.
  const curatedModelIds = [
    ...IMAGE_MODELS, ...VIDEO_MODELS, ...VOICE_MODELS, ...MUSIC_MODELS, ...SFX_MODELS,
    ...VOICE_CLONE_MODELS, ...TALKING_AVATAR_MODELS,
    ...Object.values(UTILITY_MODELS).flat(),
  ].map((m) => m.id);
  // Recomputed fresh on every call rather than a fixed array captured
  // once — discovered model IDs accumulate over time as syncDiscoveredModels
  // runs, so each periodic live-status recheck needs to see the CURRENT
  // set, not just whatever existed at server startup.
  const allKnownModelIds = () => [...curatedModelIds, ...getDiscoveredModels().map((m) => m.id)];
  const { registryFresh, browseFresh } = initFromPersistedCache();
  if (registryFresh && browseFresh) {
    console.log(`[Model Catalog] Persisted cache is still fresh — skipping the live check entirely this startup.`);
    setTimeout(() => syncDiscoveredModels(curatedModelIds).then(() => enrichDiscoveredModels(process.env.FAL_KEY)), 5000);
  } else {
    setTimeout(() => {
      const registryStep = registryFresh ? Promise.resolve() : refreshModelLiveStatus(curatedModelIds);
      registryStep
        .then(() => (browseFresh ? Promise.resolve() : refreshBrowseCatalog()))
        .then(() => syncDiscoveredModels(curatedModelIds))
        .then(() => enrichDiscoveredModels(process.env.FAL_KEY));
    }, 5000);
  }
  // Periodic re-checks stay on their own independent intervals — these
  // fire hours apart, so there's no realistic overlap risk between them
  // the way there was for two back-to-back startup calls.
  setInterval(() => refreshModelLiveStatus(allKnownModelIds()), 6 * 60 * 60 * 1000);
  setInterval(() => refreshBrowseCatalog(), 72 * 60 * 60 * 1000);
  // Discovery sync runs on its own, MORE frequent interval than the
  // browse refresh above — it processes a bounded batch each time (see
  // DISCOVERY_BATCH_SIZE in fal-catalog.js), so a large first-ever
  // backlog gets worked through gradually across several passes instead
  // of bursting dozens of schema-fetch calls at once. Reuses whatever's
  // currently in the browse cache — doesn't need it perfectly fresh,
  // just reasonably recent, which the 72h refresh above already ensures.
  // Enrichment chained right after — only ever touches models that
  // already passed real schema classification, using process.env.FAL_KEY
  // since this is a background job with no specific user/request behind
  // it (unlike the rest of this app's LLM calls, which use whichever key
  // the requesting user supplied).
  setInterval(() => syncDiscoveredModels(curatedModelIds).then(() => enrichDiscoveredModels(process.env.FAL_KEY)), 30 * 60 * 1000);

  // Voice catalog: load whatever was verified last time synchronously,
  // so it's ready immediately for the first /api/models call. The
  // startup setTimeout that used to trigger a fresh check here was
  // removed — it could only ever use process.env.FAL_KEY, which this
  // app was never designed to require (every other route already uses
  // a key submitted from the browser instead). The real initial check
  // now happens from the frontend on page load (see app.js), where a
  // genuine user key actually exists. This interval stays only as a
  // harmless fallback for anyone who does set a server-side key —
  // verifyAllVoices() itself now safely no-ops without one.
  voiceCatalog.loadPersistedCache();
  setInterval(() => voiceCatalog.verifyAllVoices(), 14 * 24 * 60 * 60 * 1000);
});