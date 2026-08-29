let state = {
  // Real timestamp when this page/session actually started — used to
  // filter the Audio Library to "generated this session" without
  // needing every generator to share one consistent runId (SFX
  // deliberately mints a fresh one per generation for cost-tracking
  // granularity, unlike Voice/Song Studio's one-per-session pattern).
  appSessionStartedAt: Date.now(),
  rawIsolatedProductBase64: null,
  isolatedProductBase64: null,
  originalProductImage: null,
  cutoutProductImage: null,
  useOriginalPhoto: false,
  modelReferenceBase64: null,
  generatedPrompts: [],
  promptTypes: [],
  generatedText: null,
  classification: null,
  environment: null,
  seedIdentity: null,
  lockedSetImage: null,
  lockedProductImage: null,
  lockedLookReference: null,
  lockedIdentityImage: null,
  sanitizedReferenceImage: null,
  runId: null,
  referencePeople: null,
  selectedPersonId: null,
  subjectSelectionNote: "",
  batchGarments: [],
  batchModelReferenceBase64: null,
  batchRunId: null,
 batchReferencePeople: null,
  batchSelectedPersonId: null,
  batchSubjectSelectionNote: "",
  videoSelections: [],
  batchGeneratedShared: null,
  batchItems: [],
  batchSubmittedPayload: null,
  videoBriefDrafts: {},
  videoRunId: null,
  videoBriefAiSuggestions: null, // per-shot {videoConcept, cameraMove} from the AI director — null until fetched, never blocks the modal if it fails
  // --- Fal.ai model registry (NEW — populated from GET /api/models on load) ---
  imageModels: [],
  videoModels: [],
  modelDefaults: {},
  imageResolutions: [],
  confirmedLikenessBlockModels: [],
  activityLog: [], // { ts, level: "info"|"success"|"warning"|"error", message }
  unseenWarningCount: 0,
  videoResultsMeta: {}, // cardId -> { sourceImages, videoModel, aspectRatio, durationSeconds, label } — for the Regenerate button
  imageHistory: {}, // cardId -> { versions: [url, ...], index: N } — for the image carousel
  videoHistory: {}, // cardId -> { versions: [url, ...], index: N } — for the video carousel
  videoCardCounter: 0,
  frameModels: [], // per-setup-card image model override, single mode, index-matched to generatedPrompts
  batchFrameModels: [], // per-product image model override, batch mode, index-matched to batchItems
  videoBriefModels: {}, // draftKey -> videoModel override
};
// ============================================================
// GLOBAL AUDIO COORDINATION — real fix for a real gap: this app has
// many independent audio surfaces (Voice Studio takes, Song Studio
// results, SFX results, Voice Clone previews, Flow Studio's narration/
// BGM/talking-video previews, and the Mixer's own shared preview
// player) — none of them coordinated with each other, so playing one
// never stopped another, and multiple clips could overlap.
//
// Two real mechanisms, because they're genuinely different kinds of
// audio elements:
//  1. A capture-phase "play" listener on document — real DOM <audio>
//     elements (every take/result player, static or dynamically
//     rendered via innerHTML) all bubble/capture through the document
//     tree, so one listener here catches every one of them, present
//     now or added later, with no per-render wiring needed.
//  2. playAudioExclusively() — for JS-created `new Audio()` instances
//     (never attached to the DOM, so their events do NOT reach
//     document — a real, easy-to-miss browser behavior, not a bug in
//     this approach) — a single shared instance reused everywhere
//     instead of each call site creating its own untracked one.
// Each direction explicitly stops the other kind too, so no matter
// which one starts, everything else really does stop.
// ============================================================
let globalPreviewAudio = null;
function stopAllDomAudioExcept(exceptEl) {
  document.querySelectorAll("audio").forEach((a) => {
    if (a !== exceptEl && !a.paused) a.pause();
  });
}
document.addEventListener("play", (e) => {
  if (e.target.tagName !== "AUDIO") return;
  stopAllDomAudioExcept(e.target);
  if (globalPreviewAudio && globalPreviewAudio !== e.target && !globalPreviewAudio.paused) globalPreviewAudio.pause();
  if (typeof mixerPreviewAudio !== "undefined" && mixerPreviewAudio && mixerPreviewAudio !== e.target && !mixerPreviewAudio.paused) {
    mixerPreviewAudio.pause();
    mixerPreviewKey = null;
    if (typeof updateMixerPreviewButtons === "function") updateMixerPreviewButtons();
    if (typeof stopPlayheadTracking === "function") stopPlayheadTracking();
  }
}, true); // capture phase — HTML5 media "play" events don't bubble, so this is the only way one listener catches every audio element
// Shared exclusive player for one-shot JS-created previews (voice
// preview cache, etc.) — replaces each call site's own untracked
// `new Audio(src).play()`, so these now stop real DOM players (and
// vice versa) instead of silently overlapping them.
function playAudioExclusively(src) {
  stopAllDomAudioExcept(null);
  if (typeof mixerPreviewAudio !== "undefined" && mixerPreviewAudio && !mixerPreviewAudio.paused) {
    mixerPreviewAudio.pause();
    mixerPreviewKey = null;
    if (typeof updateMixerPreviewButtons === "function") updateMixerPreviewButtons();
    if (typeof stopPlayheadTracking === "function") stopPlayheadTracking();
  }
  if (globalPreviewAudio) globalPreviewAudio.pause();
  globalPreviewAudio = new Audio(src);
  globalPreviewAudio.play();
  return globalPreviewAudio;
}
const dom = {
  studioForm: document.getElementById("studioForm"),
  imageInput: document.getElementById("imageInput"),
  humanFrameCount: document.getElementById("humanFrameCount"),
  nonHumanFrameCount: document.getElementById("nonHumanFrameCount"),
  totalFrameCount: document.getElementById("totalFrameCount"),
  frameCountWarning: document.getElementById("frameCountWarning"),
  lockWardrobe: document.getElementById("lockWardrobe"),
  lockBackground: document.getElementById("lockBackground"),
  wardrobeVarietyRow: document.getElementById("wardrobeVarietyRow"),
  matchReferenceOutfitRow: document.getElementById("matchReferenceOutfitRow"),
  matchReferenceOutfit: document.getElementById("matchReferenceOutfit"),
  forceProModel: document.getElementById("forceProModel"),
  clothingWarningBanner: document.getElementById("clothingWarningBanner"),
  creativeDirection: document.getElementById("creativeDirection"),
  productDimensions: document.getElementById("productDimensions"),
  comparisonContainer: document.getElementById("comparisonContainer"),
  previewCanvas: document.getElementById("previewCanvas"),
  resultImage: document.getElementById("resultImage"),
  downloadBtn: document.getElementById("downloadBtn"),
  useOriginalToggleBtn: document.getElementById("useOriginalToggleBtn"),
  resultImageLabel: document.getElementById("resultImageLabel"),
  cutoutQualityNote: document.getElementById("cutoutQualityNote"),
  uploadNewBtn: document.getElementById("uploadNewBtn"),
  chokeControl: document.getElementById("chokeControl"),
  chokeSlider: document.getElementById("chokeSlider"),
  chokeValue: document.getElementById("chokeValue"),
  dropzonePrompt: document.getElementById("dropzonePrompt"),
  generateBtn: document.getElementById("generateBtn"),
  placeholderView: document.getElementById("placeholderView"),
  statusView: document.getElementById("statusView"),
  statusMessage: document.getElementById("statusMessage"),
  statusDetail: document.getElementById("statusDetail"),
  statusElapsed: document.getElementById("statusElapsed"),
  stage1View: document.getElementById("stage1View"),
  captionContainer: document.getElementById("captionContainer"),
  tagContainer: document.getElementById("tagContainer"),
  promptReviewContainer: document.getElementById("promptReviewContainer"),
  dynamicPromptList: document.getElementById("dynamicPromptList"),
  promptCountBadge: document.getElementById("promptCountBadge"),
  lockSetBtn: document.getElementById("lockSetBtn"),
  lockSetHint: document.getElementById("lockSetHint"),
  lockedSetView: document.getElementById("lockedSetView"),
  lockedSetImage: document.getElementById("lockedSetImage"),
  lockedSetDiagnostics: document.getElementById("lockedSetDiagnostics"),
  regenerateLockBtn: document.getElementById("regenerateLockBtn"),
  approveLockBtn: document.getElementById("approveLockBtn"),
  saveKeysBtn: document.getElementById("saveKeysBtn"),
  geminiKeyInput: document.getElementById("geminiKeyInput"),
  falTextModelInput: document.getElementById("falTextModelInput"),
  falVisionModelInput: document.getElementById("falVisionModelInput"),
  falAdminKeyInput: document.getElementById("falAdminKeyInput"),
  refreshModelsBtn: document.getElementById("refreshModelsBtn"),
  browseModelsBtn: document.getElementById("browseModelsBtn"),
  modelCatalogStatus: document.getElementById("modelCatalogStatus"),
  globalImageModelSelect: document.getElementById("globalImageModelSelect"),
  wizardImageModelSelect: document.getElementById("wizardImageModelSelect"),
  globalBatchImageModelSelect: document.getElementById("globalBatchImageModelSelect"),
  globalVideoModelSelect: document.getElementById("globalVideoModelSelect"),
  globalImageResolutionSelect: document.getElementById("globalImageResolutionSelect"),
  globalBatchImageResolutionSelect: document.getElementById("globalBatchImageResolutionSelect"),
  activityLogList: document.getElementById("activityLogList"),
  activityLogBadge: document.getElementById("activityLogBadge"),
  clearActivityLogBtn: document.getElementById("clearActivityLogBtn"),
  modelReferenceInput: document.getElementById("modelReferenceInput"),
  multiPersonPicker: document.getElementById("multiPersonPicker"),
  multiPersonReasoning: document.getElementById("multiPersonReasoning"),
  multiPersonOptions: document.getElementById("multiPersonOptions"),
  navCreditsSpent: document.getElementById("navCreditsSpent"),
  navBackendDot: document.getElementById("navBackendDot"),
  backendOfflineBanner: document.getElementById("backendOfflineBanner"),
  creditsTotalSpent: document.getElementById("creditsTotalSpent"),
  creditsTotalSpentInr: document.getElementById("creditsTotalSpentInr"),
  creditsCallCount: document.getElementById("creditsCallCount"),
  creditsRemaining: document.getElementById("creditsRemaining"),
  creditsRemainingInr: document.getElementById("creditsRemainingInr"),
  creditsFxRate: document.getElementById("creditsFxRate"),
  creditsTransactionBody: document.getElementById("creditsTransactionBody"),
  budgetInput: document.getElementById("budgetInput"),
  saveBudgetBtn: document.getElementById("saveBudgetBtn"),
  campaignsList: document.getElementById("campaignsList"),
  batchModeNavBtn: document.getElementById("batchModeNavBtn"),
  singleProductRow: document.getElementById("singleProductRow"),
  batchModeRow: document.getElementById("batchModeRow"),
  wizardModeRow: document.getElementById("wizardModeRow"),
  audioModeRow: document.getElementById("audioModeRow"),
  wizardModeNavBtn: document.getElementById("wizardModeNavBtn"),
  batchForm: document.getElementById("batchForm"),
  batchImageInput: document.getElementById("batchImageInput"),
  batchGarmentList: document.getElementById("batchGarmentList"),
  batchModelReferenceInput: document.getElementById("batchModelReferenceInput"),
  shotsPerGarment: document.getElementById("shotsPerGarment"),
  backgroundConsistentToggle: document.getElementById(
    "backgroundConsistentToggle",
  ),
  includeHumanToggle: document.getElementById("includeHumanToggle"),
  batchLockWardrobe: document.getElementById("batchLockWardrobe"),
  batchModelSection: document.getElementById("batchModelSection"),
  batchAspectRatio: document.getElementById("batchAspectRatio"),
  batchForceProModel: document.getElementById("batchForceProModel"),
  batchGenerateBtn: document.getElementById("batchGenerateBtn"),
  batchPlaceholderView: document.getElementById("batchPlaceholderView"),
  batchResultsSection: document.getElementById("batchResultsSection"),
  batchDiagnosticsNote: document.getElementById("batchDiagnosticsNote"),
  batchResultsContainer: document.getElementById("batchResultsContainer"),
  batchClothingWarningBanner: document.getElementById(
    "batchClothingWarningBanner",
  ),
  batchMatchReferenceOutfitRow: document.getElementById(
    "batchMatchReferenceOutfitRow",
  ),
  batchMatchReferenceOutfit: document.getElementById(
    "batchMatchReferenceOutfit",
  ),
  batchMultiPersonPicker: document.getElementById("batchMultiPersonPicker"),
  batchMultiPersonReasoning: document.getElementById(
    "batchMultiPersonReasoning",
  ),
  batchMultiPersonOptions: document.getElementById("batchMultiPersonOptions"),
  batchModelBodyType: document.getElementById("batchModelBodyType"),
  batchSkipCanonicalRender: document.getElementById("batchSkipCanonicalRender"),
  batchLockWardrobe: document.getElementById("batchLockWardrobe"),
  batchStage1View: document.getElementById("batchStage1View"),
  batchCaptionContainer: document.getElementById("batchCaptionContainer"),
  batchTagContainer: document.getElementById("batchTagContainer"),
  batchEnvironmentText: document.getElementById("batchEnvironmentText"),
  batchToneText: document.getElementById("batchToneText"),
  batchPromptReviewContainer: document.getElementById("batchPromptReviewContainer"),
  batchPromptCountBadge: document.getElementById("batchPromptCountBadge"),
  batchDynamicPromptList: document.getElementById("batchDynamicPromptList"),
  batchApproveBtn: document.getElementById("batchApproveBtn"),
  modelBodyType: document.getElementById("modelBodyType"),
  skipCanonicalRender: document.getElementById("skipCanonicalRender"),
  brandProfileNavBtn: document.getElementById("brandProfileNavBtn"),
  saveBrandProfileBtn: document.getElementById("saveBrandProfileBtn"),
  bpBrandName: document.getElementById("bpBrandName"),
  bpTargetAudience: document.getElementById("bpTargetAudience"),
  bpRegion: document.getElementById("bpRegion"),
  bpAesthetic: document.getElementById("bpAesthetic"),
  bpBirthYear: document.getElementById("bpBirthYear"),
  videoQueueBar: document.getElementById("videoQueueBar"),
  videoQueueCount: document.getElementById("videoQueueCount"),
  videoQueueContinueBtn: document.getElementById("videoQueueContinueBtn"),
  videoQueueClearBtn: document.getElementById("videoQueueClearBtn"),
  videoBriefModal: document.getElementById("videoBriefModal"),
  videoBriefList: document.getElementById("videoBriefList"),
  videoBriefCombinedNote: document.getElementById("videoBriefCombinedNote"),
  videoBriefAspectRatio: document.getElementById("videoBriefAspectRatio"),
  videoBriefDuration: document.getElementById("videoBriefDuration"),
  videoBriefForceQuality: document.getElementById("videoBriefForceQuality"),
  videoBriefGenerateBtn: document.getElementById("videoBriefGenerateBtn"),
  videoResultsSection: document.getElementById("videoResultsSection"),
  videoResultsErrors: document.getElementById("videoResultsErrors"),
  videoResultsContainer: document.getElementById("videoResultsContainer"),
};
function markBackendOffline(detail) {
  dom.backendOfflineBanner.classList.remove("d-none");
  if (dom.navBackendDot) dom.navBackendDot.classList.remove("d-none");
  console.warn("[Backend] Marked offline:", detail);
}
function markBackendOnline() {
  dom.backendOfflineBanner.classList.add("d-none");
  if (dom.navBackendDot) dom.navBackendDot.classList.add("d-none");
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 20 * 60 * 1000) {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: abortController.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 60000)} minute(s) with no response.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutHandle),
  );
}
async function fetchJson(url, options = {}, timeoutMs = 20 * 60 * 1000) {
  let res;
  try {
    res = await fetchWithTimeout(url, options, timeoutMs);
  } catch (err) {
    markBackendOffline(err.message);
    throw new Error(
      `Could not reach the backend server (${err.message}). Make sure "node server.js" is running on port 3000, then try again.`,
    );
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    markBackendOffline(`non-JSON response, HTTP ${res.status}`);
    throw new Error(
      `The server returned an unexpected response (HTTP ${res.status}) instead of data — this usually means the backend isn't running or isn't reachable at this address. Make sure "node server.js" is running on port 3000, then try again.`,
    );
  }
  markBackendOnline();
  return { res, data };
}
const ACTIVE_RUN_KEY = "studio_active_run_v1";
// ============================================================
// ADVANCED MODE — power-user surfaces (Model Trust, custom model ID
// options, reasoning/vision model overrides, live model catalog) are
// hidden by default via the .advanced-only/.simple-only CSS classes
// (see style.css) and only shown once this is turned on. Persisted so
// it doesn't reset every reload, same pattern as the active-run/budget
// settings below.
// ============================================================
const ADVANCED_MODE_KEY = "studio_advanced_mode_v1";
function applyAdvancedMode(enabled) {
  document.body.classList.toggle("advanced-mode", enabled);
  const toggleEl = document.getElementById("advancedModeToggle");
  if (toggleEl) toggleEl.checked = enabled;
}
(function initAdvancedMode() {
  let enabled = false;
  try { enabled = localStorage.getItem(ADVANCED_MODE_KEY) === "1"; } catch (e) {}
  applyAdvancedMode(enabled);
})();
document.getElementById("advancedModeToggle")?.addEventListener("change", (e) => {
  const enabled = e.target.checked;
  applyAdvancedMode(enabled);
  try { localStorage.setItem(ADVANCED_MODE_KEY, enabled ? "1" : "0"); } catch (err) {}
  logActivity("info", `Advanced mode ${enabled ? "on" : "off"} — power-user model controls are now ${enabled ? "visible" : "hidden"}.`);
});
// Real, confirmed gap: none of the three results sections (single-mode
// photoshoot, batch, video) ever had a way to hide themselves again once
// shown — only reloading the page or switching modes entirely got rid of
// them. These just toggle the section back to d-none; the underlying
// results (state.imageHistory / state.videoHistory etc.) are untouched,
// so nothing is actually lost — showing results again (e.g. re-opening
// Video Library) works exactly as before.
document.getElementById("hidePhotoshootResultsBtn")?.addEventListener("click", () => {
  document.getElementById("photoshootResultsSection")?.classList.add("d-none");
});
document.getElementById("hideBatchResultsBtn")?.addEventListener("click", () => {
  dom.batchResultsSection?.classList.add("d-none");
});
document.getElementById("hideVideoResultsBtn")?.addEventListener("click", () => {
  dom.videoResultsSection?.classList.add("d-none");
});
function saveActiveRun(runId, mode) {
  try { localStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify({ runId, mode, savedAt: Date.now() })); } catch (e) {}
}
function clearActiveRun() {
  try { localStorage.removeItem(ACTIVE_RUN_KEY); } catch (e) {}
}
async function checkForResumableRun() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || "null"); } catch (e) { saved = null; }
  if (!saved?.runId || Date.now() - saved.savedAt > 48 * 60 * 60 * 1000) { clearActiveRun(); return; }
  try {
    const { res, data } = await fetchJson(`/api/run-status/${encodeURIComponent(saved.runId)}`);
    if (res.ok) showResumeBanner(saved, data);
    else clearActiveRun();
  } catch (e) {
  }
}
function showResumeBanner(saved, statusData) {
  const doneCount = Object.keys(statusData.frames || {}).length + Object.keys(statusData.batchItems || {}).length + Object.keys(statusData.videos || {}).length;
  const bar = document.createElement("div");
  bar.className = "alert alert-warning d-flex justify-content-between align-items-center py-2 px-3 mb-0 rounded-0";
  bar.style.cssText = "position: sticky; top: 0; z-index: 1900;";
  bar.innerHTML = `<span class="small">⏸️ Unfinished ${saved.mode} run — ${doneCount} piece(s) already completed and paid for. Resume?</span>
    <span><button class="btn btn-sm btn-dark me-2" id="resumeRunBtn">Resume</button><button class="btn btn-sm btn-outline-dark" id="discardRunBtn">Discard</button></span>`;
  document.body.prepend(bar);
  document.getElementById("resumeRunBtn").addEventListener("click", () => { bar.remove(); resumeRun(saved, statusData); });
  document.getElementById("discardRunBtn").addEventListener("click", () => { clearActiveRun(); bar.remove(); });
}
async function resumeRun(saved, statusData) {
  if (saved.mode === "single") {
    await loadCampaign(saved.runId);
    const doneFrames = Object.values(statusData.frames || {});
    if (doneFrames.length) {
      renderFinalImageGrid(doneFrames.map((f) => f.image), { framesRequested: state.promptTypes.length, framesSucceeded: doneFrames.length }, doneFrames.map((f) => f.modelUsed));
      alert(`Resumed — ${doneFrames.length} frame(s) already done, won't be re-billed. Re-upload the product/reference photo, then Approve & Launch to finish the rest.`);
    }
  } else if (saved.mode === "batch") {
    showAppMode("batch");
    if (statusData.campaign) {
      const bn = document.getElementById("batchBrandName");
      const pd = document.getElementById("batchProductDesc");
      const cd = document.getElementById("batchCreativeDirection");
      if (bn) bn.value = statusData.campaign.brandName || "";
      if (pd) pd.value = statusData.campaign.productDescription || "";
      if (cd) cd.value = statusData.campaign.creativeDirection || "";
    }
    state.batchRunId = saved.runId;
    alert(`Resumed — ${Object.keys(statusData.batchItems || {}).length} product(s) already completed. Re-upload the same photos in the same order, then Approve to finish the rest.`);
  } else if (saved.mode === "video") {
    state.videoRunId = saved.runId;
    alert(`Resumed — ${Object.keys(statusData.videos || {}).length} clip(s) already generated. Re-select the same shots to finish the rest without re-billing them.`);
  }
}
function isVideoSelected(url) {
  return state.videoSelections.some((s) => s.url === url);
}
function toggleVideoSelection(url, label, source, isHuman = false) {
  const idx = state.videoSelections.findIndex((s) => s.url === url);
  if (idx >= 0) {
    state.videoSelections.splice(idx, 1);
    logActivity("info", `Deselected "${label}" for video (${state.videoSelections.length} shot(s) still queued).`);
  } else {
    state.videoSelections.push({ url, label, source, isHuman });
    logActivity("info", `Selected "${label}" for video (${state.videoSelections.length} shot(s) now queued).`);
  }
  updateVideoQueueBar();
}
// If an image that's ALREADY queued for video gets edited or regenerated,
// the queued entry is still pointing at the old URL (it was captured at
// check-time, before the edit happened) — without this, the video step
// would silently use the pre-edit image even though the checkbox still
// shows checked and the card now displays the edited version.
function migrateVideoSelectionUrl(oldUrl, newUrl) {
  const idx = state.videoSelections.findIndex((s) => s.url === oldUrl);
  if (idx >= 0) {
    state.videoSelections[idx] = { ...state.videoSelections[idx], url: newUrl };
    updateVideoQueueBar();
    logActivity("info", "This image was already queued for video — updated the queue to use the edited/regenerated version instead of the original.");
  }
}
function updateVideoQueueBar() {
  const count = state.videoSelections.length;
  dom.videoQueueCount.innerText = count;
  dom.videoQueueBar.classList.toggle("d-none", count === 0);
}
dom.videoQueueClearBtn.addEventListener("click", () => {
  state.videoSelections = [];
  updateVideoQueueBar();
  document.querySelectorAll(".video-select-checkbox").forEach((cb) => {
    cb.checked = false;
  });
});
dom.videoQueueContinueBtn.addEventListener("click", openVideoBriefModal);
document.querySelectorAll('input[name="videoBriefMode"]').forEach((radio) => {
  radio.addEventListener("change", async () => {
    toggleStatusView(true, "Updating video concepts...");
    await refreshVideoBriefSuggestions();
    toggleStatusView(false);
    refreshGlobalVideoModelOptions();
    renderVideoBriefList();
  });
});
// Only offer models that can actually do the job for the current
// selection, instead of listing every model and warning after the fact.
// With 1 image selected (or in Separate mode), every video model works
// fine. With 2+ images selected in Combined mode, only Veo 3.1 (any tier)
// has a confirmed multi-image "combine" endpoint on Fal — Kling and
// anything else would silently only use the first image, so there's no
// reason to let it be picked and waste a generation finding that out.
function getEligibleVideoModels() {
  const mode = getVideoBriefMode();
  if (mode === "combined" && state.videoSelections.length > 1) {
    const combineCapable = state.videoModels.filter((m) => modelSupportsCombining(m.id));
    const includesHuman = state.videoSelections.some((s) => s.isHuman);
    if (!includesHuman) return combineCapable;
    // A model with CONFIRMED real evidence of failing this exact
    // scenario (human-inclusive multi-image combining) — not a theory,
    // not "might be risky," but repeated actual production failures
    // tracked server-side every time it happens — has no business still
    // being offered here as if it might work. This is the same
    // philosophy as excluding non-combining models entirely, extended
    // one step further: "technically can combine" isn't the same
    // standard as "has been shown to actually work for this."
    // A model excluded here for one of two reasons, both real evidence,
    // not a guess: (1) documented in the registry itself as known
    // likeness-sensitive from repeated confirmed production failures
    // (protects a fresh deployment from day one, not just after it
    // fails again locally), or (2) this session's own reactive tracking
    // caught it failing this exact way already.
    return combineCapable.filter((m) => {
      const model = state.videoModels.find((vm) => vm.id === m.id);
      return !model?.knownLikenessSensitive && !state.confirmedLikenessBlockModels.includes(m.id);
    });
  }
  return state.videoModels;
}
// Shows genuinely model-specific guidance the moment a model is picked —
// built from this app's own real registry data (combine convention, max
// images, duration shape), not generic advice. Directly answers "how do
// I make this model actually work well" instead of leaving it to luck.
function updateVideoModelHint() {
  const hintEl = document.getElementById("videoModelHint");
  if (!hintEl) return;
  const modelId = getGlobalVideoModel() || DEFAULT_VIDEO_MODEL_FALLBACK;
  const model = state.videoModels.find((m) => m.id === modelId);
  if (!model) {
    hintEl.textContent = "";
    return;
  }
  const tips = [];
  if (model.combine) {
    const tagWord = model.combine.promptTagFormat === "character" ? "character1, character2" : model.combine.promptTagFormat === "element" ? "@Element1, @Element2" : "@Image1, @Image2";
    tips.push(`Combines up to ${model.combine.maxImages} images — reference them in your creative direction as ${tagWord} for the best result.`);
  } else {
    tips.push(`Single-image only — if you select 2+ shots, only the first will be used.`);
  }
  if (model.duration?.type === "enum") {
    tips.push(`Fixed duration options only: ${model.duration.options.join("/")}s.`);
  } else if (model.duration?.type === "range") {
    tips.push(`Flexible duration: ${model.duration.min}-${model.duration.max}s.`);
  }
  hintEl.textContent = "💡 " + tips.join(" ");
}
function refreshGlobalVideoModelOptions() {
  if (!dom.globalVideoModelSelect) return;
  const currentValue = getGlobalVideoModel();
  const eligible = getEligibleVideoModels();
  const excludedCount = state.videoModels.length - eligible.length;
  dom.globalVideoModelSelect.innerHTML = '<option value="">Auto (AI picks pro/fast)</option>';
  populateStaticModelSelect(dom.globalVideoModelSelect, eligible);
  // Keep the previous choice only if it's still valid for the new
  // eligible set — otherwise fall back to Auto rather than silently
  // landing on whatever the first eligible option happens to be.
  dom.globalVideoModelSelect.value = eligible.some((m) => m.id === currentValue) ? currentValue : "";
  populateDurationSelect(getGlobalVideoModel() || DEFAULT_VIDEO_MODEL_FALLBACK);
  updateVideoModelHint();
  if (excludedCount > 0) {
    logActivity("info", `${excludedCount} video model(s) hidden from the list — they can't combine multiple images, and ${state.videoSelections.length} shots are currently selected.`);
  }
}
function getVideoBriefMode() {
  return document.querySelector('input[name="videoBriefMode"]:checked')?.value || "separate";
}
// Calls the AI video creative director so the review cards open pre-filled
// with a real concept instead of blank boxes. Never blocks the modal from
// opening — any failure here just means blank fields, same as before.
async function refreshVideoBriefSuggestions() {
  const mode = getVideoBriefMode();
  const source = mode === "combined"
    ? [{ label: `Combined (${state.videoSelections.length} shot(s) selected)` }]
    : state.videoSelections.map((s) => ({ label: s.label }));
  if (source.length === 0) { state.videoBriefAiSuggestions = null; return; }
  try {
    const brandName = document.getElementById("brandName")?.value || document.getElementById("batchBrandName")?.value || "";
    const environment = state.environment || state.batchGeneratedShared?.environment || "";
    const productLabel = state.classification?.productLabel || "";
    const items = source.map((s) => ({ label: s.label, userNote: "" }));
    const { res, data } = await fetchJson("/api/generate-video-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, items, brandName, productLabel, environment, brandProfile: getBrandProfile(), durationSeconds: parseInt(dom.videoBriefDuration.value) || 4, userApiKey: getUserKey() }),
    });
    state.videoBriefAiSuggestions = res.ok && Array.isArray(data.items) ? data.items : null;
    if (!res.ok) logActivity("warning", `Video concept suggestions failed (${data.error || "unknown error"}) — opening with blank fields instead.`);
  } catch (err) {
    console.warn("Video brief director failed, opening with blank fields:", err.message);
    logActivity("warning", `Video concept suggestions failed (${err.message}) — opening with blank fields instead.`);
    state.videoBriefAiSuggestions = null;
  }
}
async function openVideoBriefModal() {
  if (state.videoSelections.length === 0) return;
  logActivity("info", `Opening video brief for ${state.videoSelections.length} selected shot(s)...`);
  warnIfReliabilityIssues();
  toggleStatusView(true, "Writing video concepts for your selected shots...");
  await refreshVideoBriefSuggestions();
  toggleStatusView(false);
  refreshGlobalVideoModelOptions();
  renderVideoBriefList();
  new bootstrap.Modal(dom.videoBriefModal).show();
}
function cameraMoveSelectHtml(index, selectedValue = "") {
  const options = [
    ["", "Let AI decide"], ["static", "Static / locked-off"], ["push_in", "Slow push-in"],
    ["pull_out", "Slow pull-out"], ["pan_left", "Pan left"], ["pan_right", "Pan right"],
    ["orbit", "Orbit around product"], ["handheld", "Subtle handheld drift"],
  ];
  return `<select class="form-select form-select-sm" data-video-camera-idx="${index}">
    ${options.map(([v, l]) => `<option value="${v}" ${v === selectedValue ? "selected" : ""}>${l}</option>`).join("")}
  </select>`;
}
// Registry-driven now: any model whose entry from /api/models declares a
// `combine` block is treated as genuinely combine-capable (currently Veo
// 3.1, any tier, and Seedance 2.0, either tier). Everything else — Kling
// included — has no confirmed image_urls-style combine endpoint and will
// silently anchor on just the first selected image if picked. This check
// runs upfront so it shows as a warning in the modal BEFORE you spend
// money on a generation, not just as a note in the result after.
function modelSupportsCombining(modelId) {
  return !!state.videoModels.find((m) => m.id === modelId)?.combine;
}
function updateCombineWarning() {
  const warningEl = document.getElementById("videoCombineWarning");
  const likenessEl = document.getElementById("videoLikenessNote");
  if (!warningEl) return;
  // "Auto" resolves to an empty string in the dropdown, which never
  // matches any real model ID — so modelSupportsCombining("") always
  // came back false, incorrectly showing "can't combine" for Auto even
  // though Auto genuinely resolves to Veo Fast server-side, which DOES
  // combine. Resolve the same fallback duration-select uses below so
  // Auto gets evaluated as what it actually is, not as nothing.
  const rawModel = readModelSelectValue("data-video-model-idx", 0) || getGlobalVideoModel();
  const effectiveModel = rawModel || DEFAULT_VIDEO_MODEL_FALLBACK;
  const canCombine = modelSupportsCombining(effectiveModel);
  if (state.videoSelections.length > 1 && !canCombine) {
    warningEl.classList.remove("d-none");
    warningEl.textContent = `⚠️ ${effectiveModel} can't actually combine multiple images — it'll only use the FIRST selected shot; the rest won't appear in the video at all. Pick Veo 3.1 or Seedance 2.0 above to genuinely combine all ${state.videoSelections.length} shots.`;
  } else {
    warningEl.classList.add("d-none");
  }
  // End-frame toggle — only shown when it genuinely applies: exactly 2
  // shots selected (start + end, not a blend of more) and the current
  // model is actually confirmed to accept end_image_url. A model that
  // doesn't support this just never gets offered the option, rather than
  // showing it and having it silently do nothing.
  const endFrameToggle = document.getElementById("videoEndFrameToggle");
  if (endFrameToggle) {
    const modelSupportsEndFrame = !!state.videoModels.find((m) => m.id === effectiveModel)?.supportsEndFrame;
    const shouldShow = state.videoSelections.length === 2 && modelSupportsEndFrame;
    endFrameToggle.classList.toggle("d-none", !shouldShow);
    if (shouldShow) updateEndFrameThumbnails();
  }
  // Only shows anything when there's REAL, confirmed evidence for THIS
  // specific model (tracked server-side, updated every time this
  // actually happens) — not for every combine-capable model by default.
  // An earlier version also showed a softer "this hasn't been tested yet"
  // note for unconfirmed models, but that told the user nothing
  // actionable (they'd click Generate either way) — it just added
  // friction and eroded trust in the warning that actually matters.
  // Silence is the honest signal for "no known issue" — a caveat with no
  // different action attached to it isn't information, it's noise.
  if (likenessEl) {
    const includesHuman = state.videoSelections.some((s) => s.isHuman);
    const knownSensitive = !!state.videoModels.find((m) => m.id === effectiveModel)?.knownLikenessSensitive;
    const isConfirmedRisky = knownSensitive || state.confirmedLikenessBlockModels.includes(effectiveModel);
    if (state.videoSelections.length > 1 && canCombine && includesHuman && isConfirmedRisky) {
      likenessEl.classList.remove("d-none");
      likenessEl.className = "alert alert-warning py-2 px-2 small mt-2 mb-0";
      likenessEl.textContent = `⚠️ ${effectiveModel} has actually failed this way before in this app (real evidence, not a guess): a likeness/privacy check on the combined images (separate from this app's own moderation, and not something prompt wording can avoid). If it fails again, try product-only shots or switch to Separate mode.`;
    } else {
      likenessEl.classList.add("d-none");
    }
  }
}
// The actual input mechanism for start/end frame selection — shows the
// two real selected images so which is start vs end is a visible,
// deliberate choice, not an invisible assumption based on the order
// shots happened to be clicked in. Either slot can also be overridden
// with a freshly-uploaded image that was never part of this photoshoot
// at all — Kling's real API just needs two image URLs, it doesn't care
// where they came from, so there's no reason to restrict this to only
// what the app itself generated.
state.endFrameSwapped = false;
state.endFrameOverrides = { start: null, end: null };
function updateEndFrameThumbnails() {
  const [a, b] = state.videoSelections;
  const [autoStart, autoEnd] = a && b ? (state.endFrameSwapped ? [b, a] : [a, b]) : [null, null];
  const startImg = document.getElementById("videoStartFrameImg");
  const endImg = document.getElementById("videoEndFrameImg");
  if (startImg) startImg.src = state.endFrameOverrides.start || autoStart?.url || "";
  if (endImg) endImg.src = state.endFrameOverrides.end || autoEnd?.url || "";
}
function wireFrameUpload(inputId, slot) {
  document.getElementById(inputId)?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    state.endFrameOverrides[slot] = base64;
    updateEndFrameThumbnails();
    logActivity("info", `Using an uploaded image as the ${slot} frame instead of a shot from this photoshoot.`);
  });
}
wireFrameUpload("videoStartFrameUpload", "start");
wireFrameUpload("videoEndFrameUpload", "end");
document.getElementById("videoUseEndFrame")?.addEventListener("change", (e) => {
  document.getElementById("videoEndFrameSelector").classList.toggle("d-none", !e.target.checked);
  document.getElementById("videoEndFrameSelector").classList.toggle("d-flex", e.target.checked);
  if (e.target.checked) updateEndFrameThumbnails();
});
document.getElementById("videoSwapFramesBtn")?.addEventListener("click", () => {
  state.endFrameSwapped = !state.endFrameSwapped;
  const { start, end } = state.endFrameOverrides;
  state.endFrameOverrides = { start: end, end: start };
  updateEndFrameThumbnails();
});
function renderVideoBriefList() {
  const mode = getVideoBriefMode();
  dom.videoBriefCombinedNote.classList.toggle("d-none", mode !== "combined");
  const container = dom.videoBriefList;
  container.innerHTML = "";
  const items = mode === "combined"
    ? [{ label: `Combined (${state.videoSelections.length} shot(s) selected)`, url: state.videoSelections[0]?.url, images: state.videoSelections.map((s) => s.url), draftKey: "__combined__" }]
    : state.videoSelections.map((s) => ({ ...s, images: [s.url], draftKey: s.url }));
  items.forEach((item, index) => {
    const draft = state.videoBriefDrafts[item.draftKey] || {};
    const suggestion = state.videoBriefAiSuggestions?.[index] || {};
    const creativeDirectionValue = draft.creativeDirection || suggestion.videoConcept || "";
    const cameraMoveValue = draft.cameraMove || suggestion.cameraMove || "";
    const card = document.createElement("div");
    card.className = "card border-light shadow-sm p-3 bg-light";
    // Combined mode: show a real strip of every image actually going into
    // the request (capped at 3 visually, matching Veo's true reference-
    // image limit), instead of one thumbnail from only the first shot —
    // what you see here now matches what's actually sent in the payload.
    const thumbsHtml = (item.images || [item.url])
      .slice(0, 3)
      .map((u) => `<img src="${u}" class="rounded border" style="width: ${item.images.length > 1 ? 56 : 90}px; height: ${item.images.length > 1 ? 90 : 90}px; object-fit: cover; background:#fff;">`)
      .join("");
    const overflowBadge = item.images && item.images.length > 3
      ? `<div class="d-flex align-items-center justify-content-center rounded border text-muted small" style="width: 56px; height: 90px; background:#fff;">+${item.images.length - 3}<br>text only</div>`
      : "";
    card.innerHTML = `
      <div class="d-flex gap-3">
        <div class="d-flex gap-1">${thumbsHtml}${overflowBadge}</div>
        <div class="flex-grow-1">
          <div class="fw-semibold small mb-2">${item.label}</div>
          <textarea class="form-control form-control-sm mb-2" rows="2" placeholder="Creative direction (optional — leave blank to let AI decide)" data-video-direction-idx="${index}">${creativeDirectionValue}</textarea>
          <div class="row g-2">
            <div class="col-6">${cameraMoveSelectHtml(index, cameraMoveValue)}</div>
            <div class="col-6">
              <input type="text" class="form-control form-control-sm" placeholder="Style/mood (optional)" data-video-style-idx="${index}" value="${draft.styleNote || ""}">
            </div>
          </div>
          ${mode === "combined" ? `
          <div class="mt-2">
            <small class="text-muted">Using the "Video model" picked above — no need to choose it twice for one combined clip.</small>
          </div>
          <div class="d-none mt-2" id="videoEndFrameToggle">
            <div class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" id="videoUseEndFrame">
              <label class="form-check-label small" for="videoUseEndFrame">Use as start → end frames <span class="text-muted fw-normal">(animates from the start image to the end image — a real, different feature from blending, only shown because the selected model actually supports it)</span></label>
            </div>
            <div class="d-none align-items-start gap-2 justify-content-center border rounded p-2 bg-white" id="videoEndFrameSelector">
              <div class="text-center">
                <img id="videoStartFrameImg" class="rounded border" style="width:72px;height:72px;object-fit:cover;">
                <div class="xx-small fw-bold mt-1">▶️ Start</div>
                <label class="btn btn-sm btn-link p-0 xx-small" for="videoStartFrameUpload">📁 Use my own</label>
                <input type="file" accept="image/*" id="videoStartFrameUpload" class="d-none">
              </div>
              <button type="button" class="btn btn-sm btn-outline-secondary mt-3" id="videoSwapFramesBtn" title="Swap which image is start vs end">🔄</button>
              <div class="text-center">
                <img id="videoEndFrameImg" class="rounded border" style="width:72px;height:72px;object-fit:cover;">
                <div class="xx-small fw-bold mt-1">⏹️ End</div>
                <label class="btn btn-sm btn-link p-0 xx-small" for="videoEndFrameUpload">📁 Use my own</label>
                <input type="file" accept="image/*" id="videoEndFrameUpload" class="d-none">
              </div>
            </div>
            <p class="xx-small text-muted mt-1 mb-0">Either image can be from this photoshoot or uploaded fresh — Kling doesn't care where they come from, so a product photo from anywhere works too.</p>
          </div>` : `
          <div class="mt-2">
            <label class="form-label xx-small text-muted mb-1">Video model for this shot</label>
            ${modelSelectHtml({ models: getEligibleVideoModels(), dataAttr: "data-video-model-idx", index, selectedValue: state.videoBriefModels[item.draftKey] || "" })}
          </div>`}
          ${mode === "combined" ? `<div id="videoCombineWarning" class="alert alert-warning py-2 px-2 small mt-2 mb-0 d-none"></div>` : ""}
          ${mode === "combined" ? `<div id="videoLikenessNote" class="alert alert-info py-2 px-2 small mt-2 mb-0 d-none"></div>` : ""}
          <div class="form-check form-switch mt-2">
            <input class="form-check-input" type="checkbox" id="videoAiEnhance-${index}" data-video-enhance-idx="${index}" ${draft.aiEnhance === false ? "" : "checked"}>
            <label class="form-check-label small" for="videoAiEnhance-${index}">Let AI polish this into a full prompt</label>
          </div>
        </div>
      </div>`;
    container.appendChild(card);
  });
  if (mode === "combined") {
    updateCombineWarning();
    document.querySelector('[data-video-model-idx="0"]')?.addEventListener("change", updateCombineWarning);
    // dom.globalVideoModelSelect is a persistent element OUTSIDE this
    // container (unlike the per-card dropdown above, which gets destroyed
    // and rebuilt fresh every render along with its listener) — without
    // removing the old listener first, every modal open/mode-switch would
    // stack another duplicate "change" handler on it indefinitely.
    dom.globalVideoModelSelect?.removeEventListener("change", updateCombineWarning);
    dom.globalVideoModelSelect?.addEventListener("change", updateCombineWarning);
  }
}
function collectVideoBriefItems() {
  const mode = getVideoBriefMode();
  const source = mode === "combined"
    ? [{ url: state.videoSelections[0]?.url, label: "Combined", draftKey: "__combined__" }]
    : state.videoSelections.map((s) => ({ ...s, draftKey: s.url }));
  return source.map((sel, index) => {
    const item = {
      image: sel.url, label: sel.label,
      creativeDirection: document.querySelector(`[data-video-direction-idx="${index}"]`)?.value || "",
      cameraMove: document.querySelector(`[data-video-camera-idx="${index}"]`)?.value || "",
      styleNote: document.querySelector(`[data-video-style-idx="${index}"]`)?.value || "",
      aiEnhance: document.querySelector(`[data-video-enhance-idx="${index}"]`)?.checked !== false,
      durationSeconds: parseInt(dom.videoBriefDuration.value) || 4,
      videoModel: readModelSelectValue("data-video-model-idx", index) || getGlobalVideoModel() || undefined,
      generateAudio: document.getElementById("videoBriefGenerateAudio")?.checked !== false,
      negativePrompt: document.getElementById("videoBriefNegativePrompt")?.value?.trim() || undefined,
    };
    state.videoBriefDrafts[sel.draftKey] = { creativeDirection: item.creativeDirection, cameraMove: item.cameraMove, styleNote: item.styleNote, aiEnhance: item.aiEnhance };
    if (item.videoModel) state.videoBriefModels[sel.draftKey] = item.videoModel;
    return item;
  });
}
// ============================================================
// TOASTS — lightweight, non-blocking "done" notifications. Video takes
// much longer than images, so a silent overlay closing isn't enough
// feedback; this fires whether you're watching the tab or not.
// ============================================================
function showToast(message, variant = "success") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container position-fixed bottom-0 end-0 p-3";
    container.style.zIndex = "2000";
    document.body.appendChild(container);
  }
  const toastEl = document.createElement("div");
  toastEl.className = `toast align-items-center text-white bg-${variant} border-0`;
  toastEl.setAttribute("role", "alert");
  toastEl.innerHTML = `<div class="d-flex"><div class="toast-body">${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  container.appendChild(toastEl);
  const toast = new bootstrap.Toast(toastEl, { delay: 5000 });
  toast.show();
  toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
}
// ============================================================
// ACTIVITY LOG (NEW) — a persistent, always-visible record of every
// operation this session: what started, what finished, and critically,
// every WARNING (fallbacks, softened content, dropped elements) and ERROR
// — the exact category of thing that's easy to miss when it's just a
// line of small gray text under a preview image. Nothing here auto-
// clears; the "Clear" button is the only way to empty it. Capped at 300
// entries (oldest drop off) so a long session doesn't grow unbounded.
// ============================================================
const ACTIVITY_LOG_MAX = 300;
const ACTIVITY_LOG_ICONS = { info: "ℹ️", success: "✅", warning: "⚠️", error: "❌" };
const ACTIVITY_LOG_COLORS = { info: "text-muted", success: "text-success", warning: "text-warning", error: "text-danger" };
function logActivity(level, message) {
  if (!message) return;
  state.activityLog.push({ ts: Date.now(), level, message });
  if (state.activityLog.length > ACTIVITY_LOG_MAX) state.activityLog.shift();
  if (level === "warning" || level === "error") {
    state.unseenWarningCount++;
    updateActivityLogBadge();
  }
  renderActivityLog();
  if (level === "error") console.error(`[Activity] ${message}`);
  else if (level === "warning") console.warn(`[Activity] ${message}`);
}
function updateActivityLogBadge() {
  if (!dom.activityLogBadge) return;
  if (state.unseenWarningCount > 0) {
    dom.activityLogBadge.textContent = state.unseenWarningCount > 99 ? "99+" : String(state.unseenWarningCount);
    dom.activityLogBadge.classList.remove("d-none");
  } else {
    dom.activityLogBadge.classList.add("d-none");
  }
}
function renderActivityLog() {
  if (!dom.activityLogList) return;
  dom.activityLogList.innerHTML = state.activityLog
    .map((entry) => {
      const time = new Date(entry.ts).toLocaleTimeString();
      return `<div class="mb-1 ${ACTIVITY_LOG_COLORS[entry.level] || ""}"><span class="text-muted" style="font-size: 0.7rem;">${time}</span> ${ACTIVITY_LOG_ICONS[entry.level] || ""} ${entry.message}</div>`;
    })
    .join("");
  dom.activityLogList.scrollTop = dom.activityLogList.scrollHeight;
}
document.getElementById("activityLogOffcanvas")?.addEventListener("show.bs.offcanvas", () => {
  state.unseenWarningCount = 0;
  updateActivityLogBadge();
});
dom.clearActivityLogBtn?.addEventListener("click", () => {
  state.activityLog = [];
  renderActivityLog();
});
// Every existing error path in this app already calls alert(err.message)
// — rather than hand-editing dozens of individual catch blocks to also
// log, wrapping alert() once here gives every one of them automatic,
// consistent activity-log coverage. The visible browser dialog behaves
// exactly as before; this only adds a parallel permanent record of it.
const _nativeAlert = window.alert.bind(window);
window.alert = function (message) {
  logActivity("error", String(message));
  _nativeAlert(message);
};

// ============================================================
// RELIABILITY HEALTH — quota (429, YOUR account cap) vs overload (503,
// Fal's own servers / the underlying model provider) are DELIBERATELY
// kept as two separate signals, never merged into one generic "there
// was a problem" warning, because they mean different things and call
// for different reactions.
// ============================================================
async function refreshReliabilityHealth() {
  try {
    const { res, data } = await fetchJson("/api/reliability-health?windowHours=1");
    if (!res.ok) return null;
    updateReliabilityNavBadge(data);
    return data;
  } catch (err) {
    return null;
  }
}
function updateReliabilityNavBadge(health) {
  const badge = document.getElementById("reliabilityNavBadge");
  if (!badge) return; // optional element — degrades silently if not in the HTML yet
  if (health.quota.warn) {
    badge.classList.remove("d-none", "bg-warning");
    badge.classList.add("bg-danger");
    badge.title = `Quota/rate limit hit ${health.quota.count}x in the last hour (${health.quota.models.join(", ") || "recent calls"}). This is YOUR account's usage cap on Fal — waiting (or raising your concurrency/tier) is the fix. Check https://fal.ai/dashboard/billing.`;
    badge.innerText = "⚠️ Quota";
  } else if (health.overload.warn) {
    badge.classList.remove("d-none", "bg-danger");
    badge.classList.add("bg-warning");
    badge.title = `Fal reported overload/unavailability ${health.overload.count}x in the last hour (${health.overload.models.join(", ") || "recent calls"}) — not your usage cap, usually temporary (a specific model provider under heavy demand).`;
    badge.innerText = "🌐 Overload";
  } else {
    badge.classList.add("d-none");
  }
}
// Non-blocking heads-up shown right before you commit to a generation —
// never prevents the action, just tells you what's been happening.
async function warnIfReliabilityIssues() {
  const health = await refreshReliabilityHealth();
  if (!health) return;
  if (health.quota.warn) {
    showToast(`⚠️ Quota limit hit ${health.quota.count}x in the last hour (${health.quota.models.join(", ") || "recent calls"}) — this is YOUR account's usage cap. Consider waiting before continuing.`, "danger");
  } else if (health.overload.warn) {
    showToast(`🌐 Fal reported overload ${health.overload.count}x in the last hour — not your usage cap, usually temporary. The app will keep retrying through it.`, "warning");
  }
}
// Polls the already-existing /api/run-status endpoint WHILE a video request
// is in flight, rendering each newly-completed clip immediately instead of
// making you stare at an elapsed-time counter for minutes. renderedKeys is
// shared with the caller so the final render can skip anything already shown.
function startVideoProgressivePolling(runId, renderedKeys) {
  const handle = setInterval(async () => {
    try {
      const { res, data } = await fetchJson(`/api/run-status/${encodeURIComponent(runId)}`);
      if (!res.ok || !data.videos) return;
      const fresh = [];
      Object.entries(data.videos).forEach(([key, payload]) => {
        const dedupeKey = `${runId}:${key}`;
        if (!renderedKeys.has(dedupeKey) && payload?.url) {
          renderedKeys.add(dedupeKey);
          fresh.push(payload);
        }
      });
      if (fresh.length) renderVideoResults(fresh, [], { append: true });
    } catch (e) {
      // Non-fatal — this is a nice-to-have progressive view; the final response still renders everything regardless.
    }
  }, 4000);
  return () => clearInterval(handle);
}
dom.videoBriefGenerateBtn.addEventListener("click", async () => {
  const mode = getVideoBriefMode();
  const briefItems = collectVideoBriefItems();
  const runId = state.videoRunId || (state.videoRunId = crypto.randomUUID());
  const modalInstance = bootstrap.Modal.getInstance(dom.videoBriefModal);
  const renderedVideoKeys = new Set();
  let stopPolling = null;
  try {
    toggleStatusView(true, mode === "combined" ? "Rendering your combined video..." : `Rendering ${briefItems.length} video(s)...`);
    startProgressPolling(runId);
    saveActiveRun(runId, "video");
    stopPolling = startVideoProgressivePolling(runId, renderedVideoKeys);
    const payload = { runId, mode, aspectRatio: dom.videoBriefAspectRatio.value, videoTier: getVideoTier(), textModel: getTextModel(), userApiKey: getUserKey() };
    if (mode === "combined") {
      const b = briefItems[0];
      payload.videoModel = b.videoModel;
      const useEndFrame = document.getElementById("videoUseEndFrame")?.checked || false;
      const autoOrdered = state.endFrameSwapped ? [...state.videoSelections].reverse().map((s) => s.url) : state.videoSelections.map((s) => s.url);
      const orderedImages = useEndFrame
        ? [state.endFrameOverrides.start || autoOrdered[0], state.endFrameOverrides.end || autoOrdered[1]]
        : state.videoSelections.map((s) => s.url);
      payload.combined = { images: orderedImages, creativeDirection: b.creativeDirection, cameraMove: b.cameraMove, styleNote: b.styleNote, aiEnhance: b.aiEnhance, durationSeconds: b.durationSeconds, generateAudio: b.generateAudio, negativePrompt: b.negativePrompt, useEndFrame };
    } else {
      payload.items = briefItems;
    }
    const { res, data } = await fetchJson("/api/generate-video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await refreshCreditsSummary();
    // Refresh regardless of success/failure — a fallback chain can record
    // a newly-confirmed likeness block even on a run that ultimately
    // succeeded (it just means the FIRST model tried failed before the
    // fallback kicked in). This makes the exclusion take effect for the
    // very next attempt in this same session, not just after reloading
    // the page later.
    fetchJson("/api/models").then(({ data: registryData }) => {
      if (registryData?.confirmedLikenessBlockModels) state.confirmedLikenessBlockModels = registryData.confirmedLikenessBlockModels;
    }).catch(() => {});
    if (!res.ok) {
      const detail = Array.isArray(data.errors) && data.errors.length ? data.errors.map((e) => e.message).join(" | ") : null;
      throw new Error(detail || data.error || "Video generation failed.");
    }
    if (modalInstance) modalInstance.hide();
    if (mode === "combined") {
      if ((data.videos || []).length > 0) {
        const clearedUrls = new Set(state.videoSelections.map((s) => s.url));
        state.videoSelections.forEach((s) => delete state.videoBriefDrafts[s.url]);
        delete state.videoBriefDrafts.__combined__;
        state.videoSelections = [];
        // The "separate" branch below already did this — combined mode was
        // missing it, so checkboxes stayed visually checked after a
        // successful combine even though the selection was cleared
        // internally, making the next selection feel "stuck" rather than
        // starting fresh.
        document.querySelectorAll(".video-select-checkbox").forEach((cb) => {
          const img = cb.closest(".card")?.querySelector("img");
          if (img && clearedUrls.has(img.src)) cb.checked = false;
        });
        logActivity("info", `Video queue cleared after successful generation — ${clearedUrls.size} shot(s) deselected, ready for a fresh selection.`);
      }
    } else {
      const succeededUrls = new Set((data.videos || []).map((v) => state.videoSelections[v.sourceIndex]?.url).filter(Boolean));
      succeededUrls.forEach((url) => delete state.videoBriefDrafts[url]);
      state.videoSelections = state.videoSelections.filter((s) => !succeededUrls.has(s.url));
      document.querySelectorAll(".video-select-checkbox").forEach((cb) => {
        const img = cb.closest(".card")?.querySelector("img");
        if (img && succeededUrls.has(img.src)) cb.checked = false;
      });
      if (succeededUrls.size) logActivity("info", `Video queue cleared for ${succeededUrls.size} completed shot(s) — deselected, ready for a fresh selection.`);
    }
    updateVideoQueueBar();
    if ((data.errors || []).length === 0) {
      state.videoRunId = null;
      clearActiveRun();
    }
    // Skip anything the progressive poller already rendered, so the final
    // render never shows the same clip twice.
    const newVideos = (data.videos || []).filter((v) => {
      const key = mode === "combined" ? "combined" : String(v.sourceIndex);
      return !renderedVideoKeys.has(`${runId}:${key}`);
    });
    renderVideoResults(newVideos, data.errors || []);
    const succeededCount = (data.videos || []).length;
    (data.videos || []).forEach((v) => {
      if (v.note) logActivity("warning", `Video "${v.label}": ${v.note}`);
      if (v.rewritten) logActivity("warning", `Video "${v.label}": prompt was auto-rewritten after a content-policy block, then succeeded.`);
    });
    if ((data.errors || []).length > 0) {
      logActivity("warning", `Video generation: ${data.errors.length} issue(s) — ${data.errors.map((e) => e.message).join(" | ")}`);
    }
    if (succeededCount > 0) {
      logActivity("success", `${succeededCount} video(s) generated successfully.`);
      showToast(`✅ ${succeededCount} video${succeededCount > 1 ? "s" : ""} ready.`, "success");
    } else if ((data.errors || []).length > 0) {
      showToast(`⚠️ Video generation had issues — see details below.`, "warning");
    }
  } catch (err) {
    alert("Video generation failed: " + err.message);
  } finally {
    if (stopPolling) stopPolling();
    toggleStatusView(false);
  }
});
function buildDurationOptionsHtml(modelId, currentValue) {
  const model = state.videoModels.find((m) => m.id === modelId);
  const constraint = model?.duration;
  let options;
  if (constraint?.type === "range") {
    options = [];
    for (let s = constraint.min; s <= constraint.max; s++) options.push(s);
  } else if (constraint?.type === "enum") {
    options = constraint.options;
  } else {
    options = [4, 6, 8];
  }
  const selected = options.includes(parseInt(currentValue)) ? parseInt(currentValue) : options[Math.floor(options.length / 2)];
  return options.map((s) => `<option value="${s}" ${s === selected ? "selected" : ""}>${s}s</option>`).join("");
}
function renderVideoResults(videos, errors, { append = true } = {}) {
  const stillPending = state.videoSelections.length;
  const retryHint = stillPending > 0
    ? `<div class="alert alert-info py-2 px-3 small mb-2">${stillPending} shot(s) still pending — your inputs are saved. <button type="button" class="btn btn-sm btn-outline-primary ms-2" id="videoRetryPendingBtn">Retry now</button></div>` : "";
  const failBanner = errors.length ? `<div class="alert alert-warning py-2 px-3 small mb-2">⚠️ ${errors.map((e) => e.message).join(" | ")}</div>` : "";
  dom.videoResultsErrors.innerHTML = failBanner + retryHint;
  const newCardsHtml = videos.map((v) => {
    const cardId = `vc${state.videoCardCounter++}`;
    // Stored so the Regenerate button can look up the original source
    // images/model/context later without re-deriving them — mirrors how
    // image cards already carry enough context for their own Edit button.
    state.videoResultsMeta[cardId] = {
      sourceImages: v.sourceImages || [],
      videoModel: v.videoModel,
      aspectRatio: v.aspectRatio,
      durationSeconds: v.durationSeconds,
      generateAudio: v.generateAudio !== false,
      label: v.label,
    };
    state.videoHistory[cardId] = { versions: [v.url], index: 0 };
    return `
    <div class="col-6 col-md-4" data-video-card-id="${cardId}">
      <div class="card h-100 shadow-sm border-0 overflow-hidden">
        <video src="${v.url}" class="w-100" style="background:#000;" controls loop></video>
        <div class="d-flex align-items-center justify-content-between px-2 py-1 bg-white border-top d-none" data-video-carousel-nav="${cardId}">
          <button type="button" class="btn btn-sm btn-link p-0" data-video-carousel-prev="${cardId}" title="Previous version">◀</button>
          <span class="xx-small text-muted" data-video-carousel-count="${cardId}">1/1</span>
          <button type="button" class="btn btn-sm btn-link p-0" data-video-carousel-next="${cardId}" title="Next version">▶</button>
        </div>
        <div class="card-body p-2 bg-white d-flex justify-content-between align-items-center">
          <span class="small fw-semibold text-muted">${v.label}</span>
          <button type="button" class="btn btn-sm btn-outline-primary px-2 py-1" data-download-url="${v.url}" data-download-filename="${buildDownloadFilename([document.getElementById("brandName")?.value || document.getElementById("batchBrandName")?.value, v.label], "mp4")}">📥</button>
        </div>
        ${v.note ? `<div class="px-2 pb-2 xx-small text-muted">${v.note}</div>` : ""}
        ${v.runSpend ? `<div class="px-2 pb-1 xx-small text-muted">💳 $${v.runSpend.spent.toFixed(3)} for this run <span class="text-muted">(${v.runSpend.callCount} call${v.runSpend.callCount === 1 ? "" : "s"})</span></div>` : ""}
        ${v.sourceImages?.length ? `
        <div class="px-2 pb-2">
          <textarea class="form-control form-control-sm mb-1" rows="2" placeholder="Describe a change and regenerate (optional — leave blank to just retry as-is)" data-video-edit-instruction="${cardId}"></textarea>
          <select class="form-select form-select-sm mb-1" data-video-edit-model="${cardId}">${state.videoModels.filter((m) => !m.hidden && (v.sourceImages.length <= 1 || modelSupportsCombining(m.id))).map((m) => `<option value="${m.id}" ${m.id === v.videoModel ? "selected" : ""}>${m.label}</option>`).join("")}</select>
          <div class="form-check form-switch mb-1">
            <input class="form-check-input" type="checkbox" id="videoEditAudio-${cardId}" data-video-edit-audio="${cardId}" ${v.generateAudio === false ? "" : "checked"}>
            <label class="form-check-label xx-small" for="videoEditAudio-${cardId}">Generate audio</label>
          </div>
          <div class="d-flex gap-1">
            <select class="form-select form-select-sm" style="max-width: 90px;" data-video-edit-duration="${cardId}">${buildDurationOptionsHtml(v.videoModel, v.durationSeconds)}</select>
            <button type="button" class="btn btn-sm btn-outline-secondary flex-grow-1" data-video-regenerate="${cardId}">🔄 Regenerate</button>
          </div>
        </div>` : ""}
      </div>
    </div>`;
  }).join("");
  if (append) {
    dom.videoResultsContainer.insertAdjacentHTML("beforeend", newCardsHtml); // append — never wipes prior successes from THIS session's generations
  } else {
    dom.videoResultsContainer.innerHTML = ""; // replace — for "show me everything" views like the video library, where re-appending on every click would just keep stacking duplicate <video> players
    dom.videoResultsContainer.insertAdjacentHTML("beforeend", newCardsHtml);
  }
  dom.videoResultsSection.classList.remove("d-none");
  dom.videoResultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("videoRetryPendingBtn")?.addEventListener("click", openVideoBriefModal);
  // Bind regenerate buttons for the cards just added (guarded by a data
  // flag so re-renders don't double-bind the same button).
  dom.videoResultsContainer.querySelectorAll("[data-video-regenerate]:not([data-bound])").forEach((btn) => {
    btn.setAttribute("data-bound", "1");
    const cardId = btn.getAttribute("data-video-regenerate");
    btn.addEventListener("click", () => regenerateVideoCard(cardId));
  });
  // Switching the model on a card should refresh its duration options to
  // match that model's real constraint (e.g. Veo's 4/6/8s enum vs Kling's
  // 3-15s range) — otherwise picking a new vendor could leave a duration
  // selected that model doesn't actually accept.
  dom.videoResultsContainer.querySelectorAll("[data-video-edit-model]:not([data-bound])").forEach((sel) => {
    sel.setAttribute("data-bound", "1");
    const cardId = sel.getAttribute("data-video-edit-model");
    sel.addEventListener("change", () => {
      const cardEl = document.querySelector(`[data-video-card-id="${cardId}"]`);
      const durationEl = cardEl?.querySelector(`[data-video-edit-duration="${cardId}"]`);
      if (durationEl) durationEl.innerHTML = buildDurationOptionsHtml(sel.value, parseInt(durationEl.value));
    });
  });
  // Same carousel-nav wiring pattern as images — steps back/forward
  // through every version a card has accumulated via Regenerate.
  dom.videoResultsContainer.querySelectorAll("[data-video-carousel-prev]:not([data-bound])").forEach((btn) => {
    btn.setAttribute("data-bound", "1");
    const cardId = btn.getAttribute("data-video-carousel-prev");
    btn.addEventListener("click", () => stepVideoCarousel(cardId, -1));
  });
  dom.videoResultsContainer.querySelectorAll("[data-video-carousel-next]:not([data-bound])").forEach((btn) => {
    btn.setAttribute("data-bound", "1");
    const cardId = btn.getAttribute("data-video-carousel-next");
    btn.addEventListener("click", () => stepVideoCarousel(cardId, 1));
  });
}
function stepVideoCarousel(cardId, delta) {
  const h = state.videoHistory[cardId];
  const cardEl = document.querySelector(`[data-video-card-id="${cardId}"]`);
  if (!h || !cardEl) return;
  const newIndex = Math.max(0, Math.min(h.versions.length - 1, h.index + delta));
  if (newIndex === h.index) return;
  h.index = newIndex;
  const url = h.versions[h.index];
  const videoEl = cardEl.querySelector("video");
  if (videoEl) videoEl.src = url;
  const countEl = cardEl.querySelector(`[data-video-carousel-count="${cardId}"]`);
  if (countEl) countEl.textContent = `${h.index + 1}/${h.versions.length}`;
  cardEl.querySelector(`[data-download-url]`)?.setAttribute("data-download-url", url);
}
async function regenerateVideoCard(cardId) {
  const meta = state.videoResultsMeta[cardId];
  const cardEl = document.querySelector(`[data-video-card-id="${cardId}"]`);
  if (!meta || !cardEl) return;
  const instructionEl = cardEl.querySelector(`[data-video-edit-instruction="${cardId}"]`);
  const modelEl = cardEl.querySelector(`[data-video-edit-model="${cardId}"]`);
  const durationEl = cardEl.querySelector(`[data-video-edit-duration="${cardId}"]`);
  const btn = cardEl.querySelector(`[data-video-regenerate="${cardId}"]`);
  const videoEl = cardEl.querySelector("video");
  const originalSrc = videoEl.src;
  const instruction = instructionEl?.value?.trim() || "";
  const newModel = modelEl?.value || meta.videoModel;
  const newDuration = parseInt(durationEl?.value) || meta.durationSeconds;
  btn.disabled = true;
  btn.textContent = "Regenerating...";
  videoEl.style.opacity = "0.4";
  logActivity("info", `Regenerating video "${meta.label}"${instruction ? ` with new direction: "${instruction}"` : " as-is"} (${newDuration}s, ${newModel})...`);
  try {
    const { res, data } = await fetchJson("/api/regenerate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceImages: meta.sourceImages,
        instruction,
        videoModel: newModel,
        durationSeconds: newDuration,
        aspectRatio: meta.aspectRatio,
        productLabel: state.classification?.productLabel || document.getElementById("productDescription")?.value,
        brandName: document.getElementById("brandName")?.value || document.getElementById("batchBrandName")?.value,
        environment: state.environment,
        runId: state.runId || state.batchRunId,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Regeneration failed.");
    videoEl.src = data.url;
    meta.videoModel = data.modelUsed || newModel;
    const downloadBtn = cardEl.querySelector("[data-download-url]");
    if (downloadBtn) downloadBtn.setAttribute("data-download-url", data.url);
    meta.durationSeconds = data.durationSeconds;
    if (instructionEl) instructionEl.value = "";
    const h = state.videoHistory[cardId];
    if (h) {
      h.versions.push(data.url);
      h.index = h.versions.length - 1;
      const navEl = cardEl.querySelector(`[data-video-carousel-nav="${cardId}"]`);
      if (navEl) {
        navEl.classList.toggle("d-none", h.versions.length <= 1);
        const countEl = navEl.querySelector(`[data-video-carousel-count="${cardId}"]`);
        if (countEl) countEl.textContent = `${h.index + 1}/${h.versions.length}`;
      }
    }
    logActivity("success", `Video "${meta.label}" regenerated successfully.`);
    showToast("✅ Video regenerated.", "success");
  } catch (err) {
    videoEl.src = originalSrc;
    alert("Video regenerate failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Regenerate";
    videoEl.style.opacity = "1";
  }
}
// Tri-state model tier controls (Auto / Force Lite / Force Pro-Quality).
// Each reads the new radio group first; if that markup hasn't been added
// to index.html yet, falls back to the old single checkbox so nothing
// breaks in the meantime — "pro"/"quality" if checked, "auto"/"fast" if not.
function getModelTier() {
  const radio = document.querySelector('input[name="modelTier"]:checked')?.value;
  if (radio) return radio;
  return dom.forceProModel?.checked ? "pro" : "auto";
}
function getBatchModelTier() {
  const radio = document.querySelector('input[name="batchModelTier"]:checked')?.value;
  if (radio) return radio;
  return dom.batchForceProModel?.checked ? "pro" : "auto";
}
function getVideoTier() {
  const radio = document.querySelector('input[name="videoTier"]:checked')?.value;
  if (radio) return radio;
  return dom.videoBriefForceQuality?.checked ? "quality" : "fast";
}
// NOTE ON MIGRATION: this key is now a Fal.ai API key, not a Gemini key —
// kept under the same input element/localStorage key name since it's the
// same field in index.html, just relabeled "Fal API Key" there.
function getUserKey() {
  return localStorage.getItem("user_gemini_key") || "";
}
function getUserAdminKey() {
  return localStorage.getItem("user_fal_admin_key") || "";
}
dom.saveKeysBtn.addEventListener("click", () => {
  localStorage.setItem("user_gemini_key", dom.geminiKeyInput.value.trim());
  if (dom.falAdminKeyInput) localStorage.setItem("user_fal_admin_key", dom.falAdminKeyInput.value.trim());
  if (dom.falTextModelInput) localStorage.setItem("fal_text_model", dom.falTextModelInput.value.trim());
  if (dom.falVisionModelInput) localStorage.setItem("fal_vision_model", dom.falVisionModelInput.value.trim());
  const modalInstance = bootstrap.Modal.getInstance(
    document.getElementById("settingsModal"),
  );
  if (modalInstance) modalInstance.hide();
  alert("Settings saved.");
});
function getTextModel() {
  return localStorage.getItem("fal_text_model") || state.modelDefaults.text || "";
}
function getVisionModel() {
  return localStorage.getItem("fal_vision_model") || state.modelDefaults.vision || "";
}
// ============================================================
// FAL MODEL REGISTRY (NEW) — fetched once on load from GET /api/models,
// used to populate every image/video model dropdown in the app (the
// global defaults in index.html, plus every per-card dropdown built
// dynamically by modelSelectHtml() below).
// ============================================================
const CUSTOM_MODEL_VALUE = "__custom__";
async function loadModelRegistry() {
  try {
    const { res, data } = await fetchJson("/api/models");
    if (!res.ok) return;
    state.imageModels = data.imageModels || [];
    state.videoModels = data.videoModels || [];
    state.utilityModels = data.utilityModels || {};
    state.voiceModels = data.voiceModels || [];
    state.voiceVerificationDetails = data.voiceVerificationDetails || [];
    state.voiceCatalogStatus = data.voiceCatalogStatus || {};
    state.voiceCloneModels = data.voiceCloneModels || [];
    state.musicModels = data.musicModels || [];
    state.musicInstruments = data.musicInstruments || { indian: [], western: [] };
    state.musicGenrePresets = data.musicGenrePresets || [];
    state.voiceoverLanguages = data.voiceoverLanguages || [];
    state.scriptRanges = data.scriptRanges || {};
    populateVoiceRequirementLanguages();
    state.talkingAvatarModels = data.talkingAvatarModels || [];
    populateMusicModelSelects();
    renderSongArchitect();
    state.customVoices = data.customVoices || [];
    state.modelDefaults = data.defaults || {};
    state.recommendedDefaults = data.recommendedDefaults || {};
    state.imageResolutions = data.imageResolutions || [];
    state.confirmedLikenessBlockModels = data.confirmedLikenessBlockModels || [];
    populateStaticModelSelect(dom.globalImageModelSelect, state.imageModels);
    populateStaticModelSelect(dom.globalBatchImageModelSelect, state.imageModels);
    populateStaticModelSelect(dom.wizardImageModelSelect, state.imageModels);
    populateStaticModelSelect(dom.globalVideoModelSelect, state.videoModels);
    // Auto-promotion — a discovered model that's earned enough real
    // successful generations becomes the actual pre-selected dropdown
    // value for a fresh session, not just an available option buried in
    // the list (see getRecommendedDefaults in fal-catalog.js). Only
    // applies when nothing was already explicitly chosen (the select is
    // still on its placeholder "Auto" option) — a routine model-list
    // refresh must never silently override a deliberate pick.
    const applyRecommendedDefault = (selectEl, modelId) => {
      if (!selectEl || !modelId) return;
      if (selectEl.value) return; // something (Auto placeholder has a real value too, or an explicit pick) is already set — leave it alone
      if ([...selectEl.options].some((o) => o.value === modelId)) selectEl.value = modelId;
    };
    if (state.recommendedDefaults.image) {
      applyRecommendedDefault(dom.globalImageModelSelect, state.recommendedDefaults.image);
      applyRecommendedDefault(dom.globalBatchImageModelSelect, state.recommendedDefaults.image);
      applyRecommendedDefault(dom.wizardImageModelSelect, state.recommendedDefaults.image);
    }
    if (state.recommendedDefaults.video) {
      applyRecommendedDefault(dom.globalVideoModelSelect, state.recommendedDefaults.video);
    }
    updateImageToolModelOptions();
    updateVoiceStudioModelOptions();
    populateResolutionSelect(dom.globalImageResolutionSelect, state.imageResolutions, state.modelDefaults.imageResolution);
    populateResolutionSelect(dom.globalBatchImageResolutionSelect, state.imageResolutions, state.modelDefaults.imageResolution);
    populateDurationSelect(state.modelDefaults.video || DEFAULT_VIDEO_MODEL_FALLBACK);
    dom.globalVideoModelSelect?.addEventListener("change", () => populateDurationSelect(getGlobalVideoModel() || state.modelDefaults.video));
    dom.globalVideoModelSelect?.addEventListener("change", updateVideoModelHint);
    updateVideoModelHint();
    if (dom.falTextModelInput && !dom.falTextModelInput.value) dom.falTextModelInput.placeholder = state.modelDefaults.text || dom.falTextModelInput.placeholder;
    if (dom.falVisionModelInput && !dom.falVisionModelInput.value) dom.falVisionModelInput.placeholder = state.modelDefaults.vision || dom.falVisionModelInput.placeholder;
    updateModelCatalogStatus(data.catalogMeta);
  } catch (err) {
    console.warn("Could not load the Fal model registry:", err.message);
  }
}
let catalogStatusPollHandle = null;
function updateModelCatalogStatus(catalogMeta) {
  if (!dom.modelCatalogStatus) return;
  if (catalogMeta?.isVerifying) {
    dom.modelCatalogStatus.innerHTML = `<span class="spinner-border spinner-border-sm text-primary" role="status"></span> Checking against Fal's live catalog now — if Fal is rate-limiting, this can take a minute or more (the app waits and retries automatically rather than giving up).`;
  } else if (!catalogMeta?.lastRefreshAttempt) {
    dom.modelCatalogStatus.textContent = "Background check hasn't run yet since the server started (runs automatically within a few seconds).";
  } else if (catalogMeta.lastRefreshError) {
    dom.modelCatalogStatus.textContent = `Last check failed (${catalogMeta.lastRefreshError}) — showing the existing list as-is.`;
  } else {
    const when = new Date(catalogMeta.lastRefreshAttempt).toLocaleString();
    dom.modelCatalogStatus.textContent = `Last checked ${when} — ${catalogMeta.cachedCount} model(s) verified against Fal's live catalog.`;
  }
  // While a check is actively running, poll for completion every 3s so the
  // status visibly updates the moment it finishes — a one-time snapshot
  // isn't enough now that a single rate-limited call can take 57+ seconds.
  if (catalogMeta?.isVerifying && !catalogStatusPollHandle) {
    catalogStatusPollHandle = setInterval(async () => {
      const { data } = await fetchJson("/api/models").catch(() => ({ data: null }));
      if (!data) return;
      updateModelCatalogStatus(data.catalogMeta);
      if (!data.catalogMeta?.isVerifying) {
        clearInterval(catalogStatusPollHandle);
        catalogStatusPollHandle = null;
        logActivity("success", "Model catalog check finished.");
      }
    }, 3000);
  } else if (!catalogMeta?.isVerifying && catalogStatusPollHandle) {
    clearInterval(catalogStatusPollHandle);
    catalogStatusPollHandle = null;
  }
}
dom.refreshModelsBtn?.addEventListener("click", async () => {
  toggleStatusView(true, "Checking the model catalog against Fal's live API...");
  logActivity("info", "Running a thorough model catalog check (Settings → Check now)...");
  let pollHandle = null;
  const pollProgress = async () => {
    const { data } = await fetchJson("/api/models").catch(() => ({ data: null }));
    if (data?.catalogMeta?.verifyProgressDetail) {
      dom.statusDetail.textContent = data.catalogMeta.verifyProgressDetail;
    }
  };
  pollHandle = setInterval(pollProgress, 1500);
  try {
    const { res, data } = await fetchJson("/api/models/refresh", { method: "POST" });
    if (!res.ok || !data.ok) {
      logActivity("warning", `Model catalog check failed: ${data.error || "unknown error"} — existing list unchanged.`);
    } else if (data.flaggedCount > 0) {
      // Real, confirmed bug fixed here: this said "deprecated/missing" as
      // if those were the same uncertain thing — but flaggedCount only
      // ever counts a model Fal explicitly marked deprecated (see
      // refreshModelLiveStatus's own removed/notInDiscoveryIndex/
      // notYetVerified split, already correctly separated on the
      // backend). "Missing" or "unverified" never appear in this count
      // and never get removed — the wording just wasn't reflecting that.
      const verifiedCount = data.checkedCount - data.flaggedCount - (data.unindexedCount || 0);
      logActivity("warning", `Catalog synced: ${verifiedCount} verified, ${data.flaggedCount} confirmed deprecated (removed)${data.unindexedCount ? `, ${data.unindexedCount} pending verification` : ""}.`);
    } else if (data.unindexedCount > 0) {
      logActivity("info", `Catalog synced: all ${data.checkedCount} model(s) still available — ${data.unindexedCount} couldn't be fully confirmed this pass, which doesn't mean broken, just not yet double-checked.`);
    } else {
      logActivity("success", `Catalog synced: all ${data.checkedCount} model(s) verified active.`);
    }
    await loadModelRegistry();
  } catch (err) {
    logActivity("warning", `Model catalog check failed: ${err.message}`);
  } finally {
    clearInterval(pollHandle);
    toggleStatusView(false);
  }
});

// Model Guide — shows description/category/example code for a given
// model ID. Data comes from GET /api/models/guide, which is only
// populated once the live catalog check has run for that model (see
// fal-catalog.js) — if it hasn't, this is honest about that instead of
// showing nothing or a fabricated guess. Callable from anywhere (a
// per-dropdown ℹ️ button, or the Model Explorer list) since it just
// needs a model ID and label, not a specific dropdown to read from.
async function openModelGuide(modelId, modelLabel) {
  if (!modelId || modelId === CUSTOM_MODEL_VALUE) {
    alert("Pick a specific model (not Auto/Custom) to see its guide.");
    return;
  }
  const titleEl = document.getElementById("modelGuideTitle");
  const bodyEl = document.getElementById("modelGuideBody");
  titleEl.textContent = modelLabel || modelId;
  bodyEl.innerHTML = `<div class="text-muted small">Loading...</div>`;
  new bootstrap.Modal(document.getElementById("modelGuideModal")).show();
  try {
    const { res, data } = await fetchJson(`/api/models/guide?id=${encodeURIComponent(modelId)}`);
    if (!res.ok || !data.available) {
      bodyEl.innerHTML = `
        <p class="text-muted small mb-3">${data.reason || "Guide not available yet for this model."}</p>
        <button type="button" class="btn btn-sm btn-outline-primary" id="modelGuideRefreshInline">🔄 Check catalog now</button>
        <p class="xx-small text-muted mt-2 mb-0">This runs the same live check as Settings → Model Catalog → "Check now" — the guide will populate once it completes.</p>
      `;
      document.getElementById("modelGuideRefreshInline")?.addEventListener("click", () => dom.refreshModelsBtn?.click());
      return;
    }
    bodyEl.innerHTML = `
      ${data.thumbnailUrl ? `<img src="${data.thumbnailUrl}" alt="Example output from ${escapeHtml(modelLabel || modelId)}" class="img-fluid rounded mb-3" style="max-height:280px; width:100%; object-fit:cover;">` : ""}
      <p class="small text-muted mb-1"><code>${modelId}</code>${data.category ? ` <span class="badge bg-secondary">${data.category}</span>` : ""}${data.licenseType && data.licenseType !== "commercial" ? ` <span class="badge bg-warning text-dark">${data.licenseType} license — verify before commercial use</span>` : ""}</p>
      <p class="mb-3">${data.description || "No description available from Fal for this model."}</p>
      ${renderCapabilityBadges(data.capabilities)}
      ${data.exampleCode ? `
        <label class="form-label small fw-semibold mb-1">Example code (for your own scripts — outside this app)</label>
        <div class="position-relative">
          <pre class="bg-dark text-light p-3 rounded small" style="max-height: 320px; overflow:auto;"><code id="modelGuideCodeBlock">${escapeHtml(data.exampleCode)}</code></pre>
          <button type="button" class="btn btn-sm btn-light position-absolute top-0 end-0 m-2" id="modelGuideCopyBtn">📋 Copy</button>
        </div>
        <p class="xx-small text-muted mt-2 mb-0">Auto-generated from this model's real API schema — placeholder values (image URLs, etc.) need to be swapped for your own.</p>
      ` : `<p class="text-muted small">No example available (this model's schema didn't expose a standard input shape).</p>`}
      <p class="xx-small text-muted mt-3 mb-0">Source: <a href="https://fal.ai/models/${modelId}" target="_blank" rel="noopener">fal.ai/models/${modelId}</a> · checked ${data.checkedAt ? new Date(data.checkedAt).toLocaleString() : "recently"}</p>
    `;
    document.getElementById("modelGuideCopyBtn")?.addEventListener("click", async (e) => {
      try {
        await navigator.clipboard.writeText(data.exampleCode);
        e.target.textContent = "✅ Copied";
        setTimeout(() => { e.target.textContent = "📋 Copy"; }, 1500);
        logActivity("info", `Copied example code for ${modelId}.`);
      } catch {
        alert("Couldn't copy automatically — select the code block manually.");
      }
    });
  } catch (err) {
    bodyEl.innerHTML = `<p class="text-danger small">Failed to load guide: ${err.message}</p>`;
  }
}
document.querySelectorAll("[data-model-guide-btn]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const selectId = btn.getAttribute("data-model-guide-btn");
    const selectEl = document.getElementById(selectId);
    const modelId = readModelSelectEl(selectEl) || selectEl?.value;
    const modelLabel = selectEl?.selectedOptions?.[0]?.textContent || modelId;
    openModelGuide(modelId, modelLabel);
  });
});
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// MARKUP TOOLBAR — shared insertion primitive for the click-to-insert
// delivery/emotion/section tag toolbars (Voice Studio's per-line
// *tag* markers, Song Studio's [Section] lyric tags). Inserts at the
// real cursor position (or replaces a selection, same as any normal
// text editor), rather than requiring someone to hand-type asterisks/
// brackets and get the exact syntax right themselves — that's the
// actual point of this: the SAME underlying *tag*/[Tag] syntax
// translateScriptMarkers already parses server-side, just inserted by
// a click instead of memorized and typed. Dispatches a real "input"
// event afterward so this app's EXISTING input listeners (state sync,
// character counters) pick up the change with zero special-casing.
// ============================================================
function insertAtCursor(textarea, insertText, { padWithSpaces = true } = {}) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const hasSelection = end > start;
  const before = textarea.value.slice(0, start);
  // Real fix for a real data-loss bug: a delivery/emotion tag describes
  // HOW to say the words near it, it isn't a replacement for them. If
  // someone selects a word or phrase (the natural way to say "this bit
  // right here") and clicks a tag, the old behavior silently deleted
  // their selected text and replaced it with just the tag — losing
  // real typed content with no undo affordance in this UI. Now: a
  // selection is preserved, with the tag inserted immediately before
  // it (this app's own existing convention — every real example in
  // this file's own markupHint strings puts the cue before the words
  // it describes, e.g. "*confident* We can do this."), not consumed.
  const after = hasSelection ? textarea.value.slice(start) : textarea.value.slice(end);
  let finalInsert = insertText;
  if (padWithSpaces) {
    // Avoids gluing the inserted marker onto an adjacent word (e.g.
    // "hello*pause*world") when inserting mid-sentence without a
    // selection — only adds a space where one doesn't already exist.
    const needsLeadingSpace = before && !/\s$/.test(before);
    const needsTrailingSpace = after && !/^\s/.test(after);
    finalInsert = `${needsLeadingSpace ? " " : ""}${insertText}${needsTrailingSpace ? " " : ""}`;
  }
  textarea.value = before + finalInsert + after;
  const newCursorPos = (before + finalInsert).length;
  textarea.focus();
  textarea.setSelectionRange(newCursorPos, newCursorPos);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// Builds the actual delivery-tag toolbar for a Voice Studio line, from
// REAL structured per-model data (markupTagMode/fixedMarkupTags in
// fal-models.js) rather than a static list — so the buttons shown are
// exactly the ones this specific model will actually honor. A "fixed"
// model (MiniMax family) only offers its real 8 confirmed sound cues;
// a "freeform" model (ElevenLabs/Gemini) offers a starter set PLUS a
// custom tag input, since it genuinely accepts any descriptive phrase;
// an "unsupported" model shows no buttons at all and says so plainly,
// rather than offering controls that would silently do nothing.
const FREEFORM_TAG_SUGGESTIONS = ["whispers", "excited", "sarcastic", "confident", "dramatically", "sadly", "slowly", "shouting", "laughing", "sighs"];
function buildVoiceMarkupToolbarHtml(model, line) {
  if (!model) return "";
  // Unified control, same input for every model — what differs is
  // honestly what happens to it per model's real capability (see
  // /api/voice/suggest-markup), not the UI paradigm itself.
  const intentionInput = `<input type="text" class="form-control form-control-sm mt-1" data-line-field="intention" placeholder="Describe the intention/feeling (e.g. reluctant, a little sad, rushed)..." value="${escapeHtml(line?.intention || "")}">`;
  if (model.markupTagMode === "unsupported") {
    return `${intentionInput}<div class="xx-small text-muted mt-1">🚫 This model has no confirmed way to express emotion, tone, or intention at all — whatever you type above can't reach the audio. Switch to MiniMax, ElevenLabs, or Gemini TTS on this line to use it.</div>`;
  }
  const pauseBtn = `<button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-markup-insert="*2 second pause*" title="Insert a 2-second pause">⏸ Pause</button>`;
  // The "smart" layer: hands the WHOLE line + the intention above to the
  // AI director instead of clicking a tag per word/phrase — see
  // /api/voice/suggest-markup, constrained to this exact model's real
  // tag vocabulary (and, for MiniMax, its real confirmed emotion list
  // too) so it can never suggest something that gets silently stripped.
  const aiSuggestBtn = `<button type="button" class="btn btn-sm btn-outline-primary py-0 px-1" data-markup-ai-suggest="1" title="Direct this whole line using the intention above">🪄 Apply Intention</button>`;
  if (model.markupTagMode === "fixed") {
    const tagButtons = (model.fixedMarkupTags || [])
      .map((t) => `<button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-markup-insert="*${escapeHtml(t)}*">🗣 ${escapeHtml(t)}</button>`)
      .join("");
    return `${intentionInput}<div class="d-flex flex-wrap gap-1 mt-1 mb-1">${pauseBtn}${tagButtons}${aiSuggestBtn}</div><div class="xx-small text-muted mb-1">Only these real sound cues are actually spoken by this model — "Apply Intention" also picks the closest real confirmed emotion for you.</div>`;
  }
  const tagButtons = FREEFORM_TAG_SUGGESTIONS
    .map((t) => `<button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-markup-insert="*${t}*">💬 ${t}</button>`)
    .join("");
  return `${intentionInput}<div class="d-flex flex-wrap gap-1 mt-1 mb-1">${pauseBtn}${tagButtons}<button type="button" class="btn btn-sm btn-outline-primary py-0 px-1" data-markup-custom="1">✏️ Custom...</button>${aiSuggestBtn}</div><div class="xx-small text-muted mb-1">This model reads any descriptive tag directly — "Apply Intention" turns the text above into real delivery cues for this exact line.</div>`;
}

// Renders detectSchema()'s real output as readable badges — this is
// genuine, per-model detected data (from the actual live API schema),
// not marketing copy and not generic diffusion-model knowledge borrowed
// from unrelated tools. Directly answers "what can I actually do with
// this one" before spending money finding out the hard way.
function renderCapabilityBadges(cap) {
  if (!cap?.detected) {
    return `<p class="xx-small text-muted mb-3">Capability details unavailable for this model (schema couldn't be read).</p>`;
  }
  const badges = [];
  if (cap.imageField) {
    badges.push(cap.supportsMultiImage
      ? `📎 Multi-image reference${cap.maxImages ? ` (up to ${cap.maxImages})` : ""}`
      : `📎 Single reference image`);
  }
  if (cap.durationField) {
    if (cap.durationEnum?.length) {
      badges.push(`⏱️ Duration: ${cap.durationEnum.join("/")}${typeof cap.durationEnum[0] === "string" && !cap.durationEnum[0].endsWith("s") ? "s" : ""} only`);
    } else if (cap.durationMin != null && cap.durationMax != null) {
      badges.push(`⏱️ Duration: ${cap.durationMin}-${cap.durationMax}s`);
    } else {
      badges.push(`⏱️ Duration: flexible (${cap.durationType || "range"})`);
    }
  }
  if (cap.resolutionField) {
    badges.push(`🖼️ Resolution: ${cap.resolutionEnum?.join("/") || "adjustable"}`);
  }
  if (cap.hasAudioFlag) badges.push(`🔊 Native audio generation`);
  if (cap.hasEndFrame) badges.push(`🎬 Start → end frame control`);
  if (cap.hasNegativePrompt) badges.push(`🚫 Negative prompt support`);
  if (cap.hasCameraControl) badges.push(`🎥 Structured camera control`);
  if (cap.hasCfgScale) badges.push(`🎚️ Prompt-adherence scale (cfg/guidance)`);
  if (!badges.length) return "";
  return `
    <div class="mb-3">
      <label class="form-label small fw-semibold mb-1">Real capabilities (from this model's actual schema)</label>
      <div class="d-flex flex-wrap gap-1">${badges.map((b) => `<span class="badge bg-light text-dark border">${b}</span>`).join("")}</div>
    </div>`;
}
// Model Explorer — the main, always-visible entry point (Settings →
// "Browse all models") for seeing every available model before
// committing to anything, not just the one currently picked in a
// dropdown mid-workflow.
function renderModelExplorerList(containerId, models) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!models.length) {
    container.innerHTML = `<div class="text-muted small p-2">No models loaded yet — open this after the app has finished loading.</div>`;
    return;
  }
  container.innerHTML = models
    .map((m) => {
      const cost = m.costPerImage != null ? `$${m.costPerImage}/image` : m.costPerMegapixel != null ? `~$${m.costPerMegapixel}/MP` : m.costPerSecond != null ? `$${m.costPerSecond}/sec` : "";
      const tierBadge = { pro: "bg-dark", lite: "bg-success", fast: "bg-primary", quality: "bg-dark" }[m.tier] || "bg-secondary";
      return `
        <button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" data-explorer-model-id="${m.id}" data-explorer-model-label="${escapeHtml(m.label)}">
          <span>
            <span class="badge ${tierBadge} me-2">${m.tier}</span>
            ${escapeHtml(m.label)}
          </span>
          <span class="text-muted small flex-shrink-0 ms-2">${cost}</span>
        </button>`;
    })
    .join("");
  container.querySelectorAll("[data-explorer-model-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openModelGuide(btn.getAttribute("data-explorer-model-id"), btn.getAttribute("data-explorer-model-label"));
    });
  });
}
function populateModelExplorer() {
  renderModelExplorerList("modelExplorerImageList", state.imageModels);
  renderModelExplorerList("modelExplorerVideoList", state.videoModels);
}
dom.browseModelsBtn?.addEventListener("click", () => {
  populateModelExplorer();
  const settingsModalEl = document.getElementById("settingsModal");
  const settingsInstance = bootstrap.Modal.getInstance(settingsModalEl);
  // Sequence the modal swap on Bootstrap's own hide event instead of
  // firing both at once — opening a second modal before the first has
  // finished closing causes a leftover/duplicate backdrop in Bootstrap 5.
  const openExplorer = () => new bootstrap.Modal(document.getElementById("browseCatalogModal")).show();
  if (settingsInstance) {
    settingsModalEl.addEventListener("hidden.bs.modal", openExplorer, { once: true });
    settingsInstance.hide();
  } else {
    openExplorer();
  }
});

// Sets a model as the "Custom model ID" choice on a given dropdown +
// its paired text input — the same mechanism a person clicking through
// the UI manually would trigger, just done programmatically. The change
// listener that shows/focuses the custom input (see readModelSelectEl's
// neighbor above) is delegated and only fires on a real "change" event,
// so setting .value alone isn't enough — it has to be dispatched.
document.getElementById("globalSeedRandomizeBtn")?.addEventListener("click", () => {
  const input = document.getElementById("globalSeedInput");
  if (input) {
    // Real 32-bit range — matches what Nano Banana Pro/2's own seed
    // field actually accepts (a standard integer seed), not an
    // arbitrary made-up range.
    input.value = Math.floor(Math.random() * 2147483647);
  }
});
document.getElementById("globalBatchSeedRandomizeBtn")?.addEventListener("click", () => {
  const input = document.getElementById("globalBatchSeedInput");
  if (input) input.value = Math.floor(Math.random() * 2147483647);
});
function applyModelAsCustom(selectId, modelId) {
  const selectEl = document.getElementById(selectId);
  if (!selectEl) return false;
  selectEl.value = CUSTOM_MODEL_VALUE;
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  const customInput = document.getElementById(selectEl.getAttribute("data-model-custom-target"));
  if (customInput) customInput.value = modelId;
  return true;
}

// ============================================================
// MODEL EXPLORER (Phase 4) — the search/sort/favorites HTML for this
// already existed (modelExplorerSearch/Sort/FavoritesOnly/Results), but
// had genuinely zero JavaScript behind it anywhere in this file, and
// its container even shared a duplicate id with an unrelated older
// modal (fixed separately — see browseCatalogModal). This is the real
// implementation: fetches the live Provider -> Family -> Variant tree
// (with capabilities/cost already enriched server-side) from
// /api/models/explorer, and lets a person search/sort/favorite/select
// from it into whichever model dropdown actually opened it.
// ============================================================
const MODEL_EXPLORER_FAVORITES_KEY = "studio_model_favorites_v1";
function getModelFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem(MODEL_EXPLORER_FAVORITES_KEY) || "[]")); } catch (e) { return new Set(); }
}
function toggleModelFavorite(modelId) {
  const favs = getModelFavorites();
  favs.has(modelId) ? favs.delete(modelId) : favs.add(modelId);
  try { localStorage.setItem(MODEL_EXPLORER_FAVORITES_KEY, JSON.stringify([...favs])); } catch (e) {}
  return favs.has(modelId);
}
let modelExplorerState = { flatModels: [], targetSelectId: null, mediaType: null };
function flattenExplorerTree(tree) {
  const flat = [];
  for (const [provider, families] of Object.entries(tree)) {
    for (const [family, models] of Object.entries(families)) {
      for (const m of models) flat.push({ ...m, provider, family });
    }
  }
  return flat;
}
// Normalized status (Section 2's 8-state model) -> a short badge label +
// Bootstrap color class. "verified"/"discovered" intentionally aren't
// alarming colors — per this app's own hard-learned lesson, "not yet
// fully confirmed" is not the same as "broken."
const EXPLORER_STATUS_BADGE = {
  selectable: { label: "Ready", cls: "bg-success" },
  supported: { label: "Ready", cls: "bg-success" },
  verified: { label: "Verified", cls: "bg-info text-dark" },
  discovered: { label: "New", cls: "bg-secondary" },
  failed: { label: "Issues", cls: "bg-danger" },
  deprecated: { label: "Deprecated", cls: "bg-danger" },
  unavailable: { label: "Unavailable", cls: "bg-danger" },
  unknown: { label: "Unknown", cls: "bg-secondary" },
};
function renderModelExplorerResults() {
  const resultsEl = document.getElementById("modelExplorerResults");
  if (!resultsEl) return;
  const query = (document.getElementById("modelExplorerSearch")?.value || "").trim().toLowerCase();
  const sort = document.getElementById("modelExplorerSort")?.value || "default";
  const favoritesOnly = document.getElementById("modelExplorerFavoritesOnly")?.checked;
  const favorites = getModelFavorites();
  let items = modelExplorerState.flatModels.filter((m) => {
    if (favoritesOnly && !favorites.has(m.id)) return false;
    if (!query) return true;
    return `${m.id} ${m.label} ${m.provider} ${m.family}`.toLowerCase().includes(query);
  });
  if (sort === "cost-asc") {
    items = [...items].sort((a, b) => (a.estimatedCost ?? Infinity) - (b.estimatedCost ?? Infinity));
  } else if (sort === "favorites") {
    items = [...items].sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0));
  }
  if (!items.length) {
    resultsEl.innerHTML = `<div class="text-muted small p-3">No models match${query ? ` "${escapeHtml(query)}"` : ""}${favoritesOnly ? " in your favorites" : ""}.</div>`;
    return;
  }
  // Grouped by Provider > Family for readability, in whatever order
  // sorting above already produced (so "cheapest first" still reads
  // cheapest-first within the grouped view, not re-alphabetized away).
  const groups = new Map();
  items.forEach((m) => {
    const key = `${m.provider} · ${m.family}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  resultsEl.innerHTML = [...groups.entries()]
    .map(([groupLabel, models]) => `
      <div class="mb-2">
        <div class="text-muted xx-small fw-bold text-uppercase mt-2 mb-1">${escapeHtml(groupLabel)}</div>
        ${models.map((m) => {
          const badge = EXPLORER_STATUS_BADGE[m.status?.status] || EXPLORER_STATUS_BADGE.unknown;
          const isFav = favorites.has(m.id);
          const cost = m.estimatedCost != null ? `$${Number(m.estimatedCost).toFixed(3)}${m.capabilities?.mediaType === "video" ? "/sec" : m.capabilities?.mediaType === "audio" ? "/gen" : ""}` : "—";
          const caps = [];
          if (m.capabilities?.imageInput?.supported) caps.push(`📎 up to ${m.capabilities.imageInput.maxReferenceImages || "?"} refs`);
          if (m.capabilities?.voices) caps.push(`🎙️ ${m.capabilities.voices} voices`);
          if (m.capabilities?.languages?.length) caps.push(`🌐 ${m.capabilities.languages.length} languages`);
          if (m.capabilities?.negativePrompt) caps.push("🚫 negative prompt");
          return `
          <div class="d-flex justify-content-between align-items-start border rounded p-2 mb-1 model-explorer-card" data-explorer-select-id="${escapeHtml(m.id)}" data-explorer-select-label="${escapeHtml(m.label)}" style="cursor:pointer;">
            <div class="flex-grow-1 me-2">
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <span class="fw-semibold small">${escapeHtml(m.label)}</span>
                <span class="badge ${badge.cls}" style="font-size:0.65rem;">${badge.label}</span>
                ${m.source === "discovered" ? '<span class="badge bg-light text-dark border" style="font-size:0.65rem;">🆕 auto-discovered</span>' : ""}
              </div>
              ${m.capabilities?.bestFor ? `<div class="xx-small text-muted mt-1">${escapeHtml(m.capabilities.bestFor)}</div>` : ""}
              ${caps.length ? `<div class="xx-small text-muted mt-1">${caps.join(" · ")}</div>` : ""}
            </div>
            <div class="d-flex flex-column align-items-end flex-shrink-0 gap-1">
              <span class="small text-muted">${cost}</span>
              <button type="button" class="btn btn-sm p-0 border-0" data-explorer-fav-id="${escapeHtml(m.id)}" title="${isFav ? "Remove favorite" : "Add favorite"}">${isFav ? "⭐" : "☆"}</button>
            </div>
          </div>`;
        }).join("")}
      </div>`)
    .join("");
  resultsEl.querySelectorAll("[data-explorer-fav-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleModelFavorite(btn.getAttribute("data-explorer-fav-id"));
      renderModelExplorerResults(); // re-render so the star and any favorites-first sort reflect the change immediately
    });
  });
  resultsEl.querySelectorAll("[data-explorer-select-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const modelId = card.getAttribute("data-explorer-select-id");
      const modelLabel = card.getAttribute("data-explorer-select-label");
      if (!modelExplorerState.targetSelectId) return;
      const selectEl = document.getElementById(modelExplorerState.targetSelectId);
      const hasOption = selectEl && [...selectEl.options].some((o) => o.value === modelId);
      if (hasOption) {
        selectEl.value = modelId;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        applyModelAsCustom(modelExplorerState.targetSelectId, modelId);
      }
      logActivity("success", `Set "${modelLabel}" as the model for this step.`);
      bootstrap.Modal.getInstance(document.getElementById("modelExplorerModal"))?.hide();
    });
  });
}
async function openModelExplorerFor(targetSelectId, mediaType) {
  modelExplorerState.targetSelectId = targetSelectId;
  modelExplorerState.mediaType = mediaType;
  const badgeEl = document.getElementById("modelExplorerMediaTypeBadge");
  if (badgeEl) badgeEl.textContent = mediaType ? mediaType[0].toUpperCase() + mediaType.slice(1) : "";
  const resultsEl = document.getElementById("modelExplorerResults");
  if (resultsEl) resultsEl.innerHTML = `<div class="text-muted small p-3">Loading...</div>`;
  new bootstrap.Modal(document.getElementById("modelExplorerModal")).show();
  try {
    const { res, data } = await fetchJson(`/api/models/explorer${mediaType ? `?mediaType=${encodeURIComponent(mediaType)}` : ""}`);
    if (!res.ok) throw new Error(data.error || "Failed to load models.");
    modelExplorerState.flatModels = flattenExplorerTree(data.tree);
    renderModelExplorerResults();
  } catch (err) {
    if (resultsEl) resultsEl.innerHTML = `<div class="text-danger small p-3">Couldn't load the model list: ${escapeHtml(err.message)}</div>`;
  }
}
document.querySelectorAll("[data-model-explorer-btn]").forEach((btn) => {
  btn.addEventListener("click", () => {
    openModelExplorerFor(btn.getAttribute("data-model-explorer-btn"), btn.getAttribute("data-media-type"));
  });
});
document.getElementById("modelExplorerSearch")?.addEventListener("input", renderModelExplorerResults);
document.getElementById("modelExplorerSort")?.addEventListener("change", renderModelExplorerResults);
document.getElementById("modelExplorerFavoritesOnly")?.addEventListener("change", renderModelExplorerResults);

// Live search across Fal's ENTIRE catalog (not just this app's curated
// list) — results include a real schema-derived example snippet, same
// source of truth as the guide modal.
async function runModelSearch() {
  const q = document.getElementById("modelSearchQuery")?.value.trim();
  const category = document.getElementById("modelSearchCategory")?.value;
  const resultsEl = document.getElementById("modelSearchResults");
  resultsEl.innerHTML = `<div class="text-muted small p-2">Loading...</div>`;
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    const { res, data } = await fetchJson(`/api/models/search?${params.toString()}`);
    if (!res.ok || !data.ok) {
      resultsEl.innerHTML = `<div class="text-danger small p-2">Couldn't load the catalog: ${data.error || "unknown error"}</div>`;
      return;
    }
    updateBrowseCacheStatus(data.cacheMeta);
    if (!data.results.length) {
      resultsEl.innerHTML = data.cacheMeta?.totalCached
        ? `<div class="text-muted small p-2">No matches — try a broader term or clear the filters.</div>`
        : `<div class="text-muted small p-2">Catalog hasn't finished loading yet (happens automatically ~15s after server start) — try "🔄 Refresh now" below in a moment.</div>`;
      return;
    }
    resultsEl.innerHTML = data.results
      .map((m) => {
        const isImageModel = /image-to-image|text-to-image/.test(m.category || "");
        const isVideoModel = /image-to-video|text-to-video/.test(m.category || "");
        // Category can be missing/unrecognized for some catalog entries —
        // in that case, show both rather than silently hiding a model
        // someone might genuinely want, but the common case (a clearly
        // categorized model) now only offers the button that matches
        // what it actually does.
        const showImageBtn = isImageModel || (!isImageModel && !isVideoModel);
        const showVideoBtn = isVideoModel || (!isImageModel && !isVideoModel);
        return `
      <div class="list-group-item">
        <div class="d-flex gap-2 align-items-start">
          ${m.thumbnailUrl ? `<img src="${m.thumbnailUrl}" alt="" class="rounded flex-shrink-0" style="width:56px;height:56px;object-fit:cover;">` : `<div class="rounded bg-light flex-shrink-0 d-flex align-items-center justify-content-center text-muted" style="width:56px;height:56px;font-size:1.2rem;">🖼️</div>`}
          <div class="flex-grow-1">
            <div class="fw-semibold small">${escapeHtml(m.displayName || m.id)} ${m.category ? `<span class="badge bg-secondary">${m.category}</span>` : ""}${m.licenseType && m.licenseType !== "commercial" ? ` <span class="badge bg-warning text-dark" title="Check licensing before commercial use">${m.licenseType}</span>` : ""}</div>
            <div class="text-muted xx-small mb-1">${escapeHtml(m.id)}</div>
            <div class="small">${escapeHtml(m.description || "No description available.")}</div>
          </div>
        </div>
        <div class="d-flex gap-1 mt-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-search-view-id="${m.id}">View code</button>
          ${showImageBtn ? `<button type="button" class="btn btn-sm btn-outline-success" data-search-use-id="${m.id}" data-search-use-label="${escapeHtml(m.displayName || m.id)}" data-search-target="image">✅ Use for images</button>` : ""}
          ${showVideoBtn ? `<button type="button" class="btn btn-sm btn-outline-success" data-search-use-id="${m.id}" data-search-use-label="${escapeHtml(m.displayName || m.id)}" data-search-target="video">✅ Use for video</button>` : ""}
        </div>
        <div class="mt-2 d-none" data-search-code-for="${m.id}"></div>
      </div>`;
      })
      .join("");
    resultsEl.querySelectorAll("[data-search-view-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const modelId = btn.getAttribute("data-search-view-id");
        const codeEl = resultsEl.querySelector(`[data-search-code-for="${modelId}"]`);
        if (!codeEl.classList.contains("d-none")) {
          codeEl.classList.add("d-none");
          return;
        }
        codeEl.classList.remove("d-none");
        codeEl.innerHTML = `<div class="text-muted xx-small">Fetching real example from Fal...</div>`;
        // Lazy, single-model fetch — the broad list above deliberately
        // doesn't carry full schemas (that's what caused the earlier
        // rate-limit error fetching many at once); one model at a time
        // here has plenty of headroom.
        try {
          const { res: dRes, data: detail } = await fetchJson(`/api/models/detail?id=${encodeURIComponent(modelId)}`);
          if (!dRes.ok || !detail.available) {
            codeEl.innerHTML = `<div class="text-muted xx-small">${detail.reason || "Couldn't load an example for this model."}</div>`;
            return;
          }
          codeEl.innerHTML = detail.exampleCode
            ? `<pre class="bg-dark text-light p-2 rounded xx-small" style="max-height:220px;overflow:auto;"><code>${escapeHtml(detail.exampleCode)}</code></pre>`
            : `<div class="text-muted xx-small">No example available for this model.</div>`;
        } catch (err) {
          codeEl.innerHTML = `<div class="text-danger xx-small">Failed to load: ${err.message}</div>`;
        }
      });
    });
    resultsEl.querySelectorAll("[data-search-use-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const modelId = btn.getAttribute("data-search-use-id");
        const modelLabel = btn.getAttribute("data-search-use-label");
        const target = btn.getAttribute("data-search-target");
        const selectId = target === "video" ? "globalVideoModelSelect" : "globalImageModelSelect";
        applyModelAsCustom(selectId, modelId);
        logActivity("success", `Set "${modelLabel}" (${modelId}) as the custom ${target} model — check the ${target === "video" ? "Video Brief" : "Photoshoot"} setup.`);
        showToast(`✅ "${modelLabel}" is now your custom ${target} model.`, "success");
        bootstrap.Modal.getInstance(document.getElementById("browseCatalogModal"))?.hide();
      });
    });
  } catch (err) {
    resultsEl.innerHTML = `<div class="text-danger small p-2">Search failed: ${err.message}</div>`;
  }
}
document.getElementById("modelSearchBtn")?.addEventListener("click", runModelSearch);
document.getElementById("modelSearchQuery")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runModelSearch();
});
document.getElementById("modelSearchCategory")?.addEventListener("change", runModelSearch);

let browseStatusPollHandle = null;
function updateBrowseCacheStatus(cacheMeta) {
  const el = document.getElementById("modelBrowseCacheStatus");
  if (!el || !cacheMeta) return;
  if (cacheMeta.isBrowsing) {
    el.innerHTML = `<span class="spinner-border spinner-border-sm text-primary" role="status"></span> Loading the full catalog now — can take a minute or more if Fal is rate-limiting (waits and retries automatically).`;
  } else if (!cacheMeta.totalCached) {
    el.textContent = "Catalog still loading (happens automatically shortly after server start)...";
  } else {
    const when = cacheMeta.lastFetched ? new Date(cacheMeta.lastFetched).toLocaleString() : "recently";
    el.textContent = `${cacheMeta.totalCached} models loaded · last refreshed ${when} · auto-refreshes every 72h`;
  }
  if (cacheMeta.isBrowsing && !browseStatusPollHandle) {
    browseStatusPollHandle = setInterval(async () => {
      const { data } = await fetchJson("/api/models/search").catch(() => ({ data: null }));
      if (!data) return;
      updateBrowseCacheStatus(data.cacheMeta);
      if (!data.cacheMeta?.isBrowsing) {
        clearInterval(browseStatusPollHandle);
        browseStatusPollHandle = null;
        logActivity("success", "Browse catalog finished loading.");
        runModelSearch(); // refresh the visible list now that loading is done
      }
    }, 3000);
  } else if (!cacheMeta.isBrowsing && browseStatusPollHandle) {
    clearInterval(browseStatusPollHandle);
    browseStatusPollHandle = null;
  }
}
document.getElementById("modelBrowseRefreshBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("modelBrowseRefreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";
  logActivity("info", "Hard-refreshing Fal's full catalog browse cache...");
  try {
    const { res, data } = await fetchJson("/api/models/search/refresh", { method: "POST" });
    if (res.ok && data.ok) {
      logActivity("success", `Browse cache refreshed: ${data.totalCached} models loaded.`);
    } else {
      logActivity("warning", `Browse cache refresh had issues: ${data.error || "unknown"} — showing what's cached.`);
    }
    await runModelSearch();
  } catch (err) {
    logActivity("warning", `Browse cache refresh failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Refresh now";
  }
});
// Load the full catalog automatically the first time the Explorer opens,
// per the actual ask: browse everything up front, don't require someone
// to already know what to search for.
document.getElementById("browseCatalogModal")?.addEventListener("shown.bs.modal", () => {
  if (!document.getElementById("modelSearchResults").dataset.loaded) {
    document.getElementById("modelSearchResults").dataset.loaded = "1";
    runModelSearch();
  }
});

document.getElementById("settingsModal")?.addEventListener("show.bs.modal", async () => {
  const { data } = await fetchJson("/api/models").catch(() => ({ data: null }));
  if (data) updateModelCatalogStatus(data.catalogMeta);
});

document.getElementById("trustSummaryOffcanvas")?.addEventListener("show.bs.offcanvas", loadTrustSummary);
async function loadTrustSummary() {
  const listEl = document.getElementById("trustSummaryList");
  listEl.innerHTML = `<div class="text-muted small p-2">Loading...</div>`;
  try {
    const { res, data } = await fetchJson("/api/models/trust-summary");
    if (!res.ok) throw new Error(data.error || "Failed to load.");
    const sections = [];
    // Real catalog-level status (Section 2's normalized states) — leads
    // the panel since "is this model even still active" is the more
    // fundamental question than generation-quality trust below it. A
    // calm one-line summary by default; only the states genuinely worth
    // a human looking at (deprecated/failed/unavailable) get their own
    // detail — everything "selectable" is just noise to list out.
    if (data.catalogStatus) {
      const { byState, needsAttention } = data.catalogStatus;
      const total = Object.values(byState).reduce((a, b) => a + b, 0);
      const readyCount = (byState.selectable || 0) + (byState.supported || 0);
      const summaryParts = [`${readyCount} ready`];
      if (byState.verified) summaryParts.push(`${byState.verified} verified`);
      if (byState.discovered) summaryParts.push(`${byState.discovered} newly discovered`);
      if (byState.unknown) summaryParts.push(`${byState.unknown} unknown`);
      sections.push(`
        <div class="mb-3">
          <div class="fw-bold small mb-1">📦 Model catalog status</div>
          <div class="xx-small text-muted mb-2">${total} model(s) tracked — ${summaryParts.join(", ")}${needsAttention.length ? `, ${needsAttention.length} needing attention` : ""}.</div>
          ${needsAttention.length ? needsAttention.map((m) => `
            <div class="border rounded p-2 mb-1 bg-light">
              <div class="d-flex justify-content-between align-items-start">
                <code class="xx-small">${escapeHtml(m.id)}</code>
                <span class="badge ${m.status === "deprecated" ? "bg-danger" : m.status === "failed" ? "bg-warning text-dark" : "bg-secondary"}">${escapeHtml(m.status)}</span>
              </div>
              <div class="text-muted xx-small">${escapeHtml(m.reason)}</div>
            </div>`).join("") : ""}
        </div>`);
    }
    if ((data.confirmedLikenessBlockModels || []).length > 0) {
      sections.push(`
        <div class="mb-3">
          <div class="fw-bold small text-danger mb-1">⚠️ Confirmed likeness-block history</div>
          ${data.confirmedLikenessBlockModels.map((id) => `<div class="border rounded p-2 mb-1 bg-light"><code class="xx-small">${escapeHtml(id)}</code><div class="text-muted xx-small">Actually failed a real human-inclusive combine request in this app — excluded from that scenario's dropdown from now on.</div></div>`).join("")}
        </div>`);
    }
    if ((data.verificationStats || []).length > 0) {
      sections.push(`
        <div class="fw-bold small mb-1">🔍 Verification track record</div>
        ${data.verificationStats.map((s) => {
          const rate = s.totalChecks ? Math.round((s.successes / s.totalChecks) * 100) : 0;
          const resultBadge = s.lastResult === "pass" ? '<span class="badge bg-success">last: pass</span>' : '<span class="badge bg-danger">last: fail</span>';
          return `
          <div class="border rounded p-2 mb-2 bg-light">
            <div class="d-flex justify-content-between align-items-start">
              <div class="fw-semibold xx-small">${escapeHtml(s.modelId)}</div>
              ${resultBadge}
            </div>
            <div class="text-muted xx-small">requirement: <code>${escapeHtml(s.requirementType)}</code></div>
            <div class="xx-small mt-1">${s.successes}/${s.totalChecks} passed (${rate}%) · ${s.consecutiveSuccesses} consecutive</div>
            <div class="text-muted xx-small fst-italic mt-1">${escapeHtml(s.currentTrustTier)}</div>
            <div class="text-muted xx-small">last checked ${s.lastCheckedAt ? new Date(s.lastCheckedAt).toLocaleString() : "never"}</div>
          </div>`;
        }).join("")}`);
    }
    // Real voice-catalog data — the exact same verification results
    // actually driving Voice Studio's dropdown, previously built but
    // never surfaced anywhere in this panel. Shown with genuine
    // per-voice entries, not just a summary count, matching the same
    // "real track record, not a guess" standard as the sections above.
    const voiceEntries = data.voiceCatalog?.entries || [];
    const voiceStatus = data.voiceCatalog?.status;
    if (voiceStatus) {
      const workingEntries = voiceEntries.filter((e) => e.working);
      const failedEntries = voiceEntries.filter((e) => !e.working);
      sections.push(`
        <div class="mb-3">
          <div class="fw-bold small mb-1">🎙️ Voice catalog verification</div>
          <div class="xx-small text-muted mb-2">
            Last checked: ${voiceStatus.lastCheckedAt ? new Date(voiceStatus.lastCheckedAt).toLocaleString() : "never yet"}${voiceStatus.isVerifying ? " — checking right now..." : ""}<br>
            ${voiceEntries.length} voice(s) tested so far: ${workingEntries.length} confirmed working, ${failedEntries.length} genuinely not found.
          </div>
          ${failedEntries.length ? `
            <div class="fw-semibold xx-small text-danger mb-1">Confirmed broken — hidden from the picker</div>
            ${failedEntries.map((e) => `<div class="border rounded p-2 mb-1 bg-light"><code class="xx-small">${escapeHtml(e.voiceId)}</code> on <code class="xx-small">${escapeHtml(e.modelId)}</code><div class="text-muted xx-small">${escapeHtml(e.error || "Voice not found")}</div></div>`).join("")}
          ` : ""}
          ${workingEntries.length ? `
            <div class="fw-semibold xx-small text-success mb-1 mt-2">Confirmed working</div>
            <div class="xx-small text-muted">${workingEntries.map((e) => escapeHtml(e.voiceId)).join(", ")}</div>
          ` : ""}
          ${!voiceEntries.length ? `<div class="xx-small text-muted">No voices checked yet — happens automatically on app load, or click "Re-check which voices actually work" in Voice Studio.</div>` : ""}
        </div>`);
    }
    listEl.innerHTML = sections.length ? sections.join("") : `<div class="text-muted small p-2">Nothing tracked yet — this fills in as the app actually verifies outputs and encounters real failures. No history yet isn't a problem, it just means nothing's been learned yet.</div>`;
  } catch (err) {
    listEl.innerHTML = `<div class="text-danger small p-2">Failed to load: ${err.message}</div>`;
  }
}
const DEFAULT_VIDEO_MODEL_FALLBACK = "fal-ai/veo3.1/fast/image-to-video";

// Video duration is a genuine PER-MODEL constraint, not one universal
// limit — Veo only accepts exactly 4/6/8s (an enum, not a range), while
// Kling supports any integer 3-15s. This repopulates the duration
// dropdown's actual options to match whatever's really valid for the
// currently-selected video model, so "custom duration" means "the real
// range this model supports," not a number that will just 422.
function populateDurationSelect(modelId) {
  if (!dom.videoBriefDuration) return;
  const model = state.videoModels.find((m) => m.id === modelId);
  const constraint = model?.duration;
  const previousValue = dom.videoBriefDuration.value;
  let options;
  if (constraint?.type === "range") {
    options = [];
    for (let s = constraint.min; s <= constraint.max; s++) options.push(s);
  } else if (constraint?.type === "enum") {
    options = constraint.options;
  } else {
    options = [4, 6, 8]; // unknown/custom model — conservative default that's valid for Veo at minimum
  }
  dom.videoBriefDuration.innerHTML = options.map((s) => `<option value="${s}">${s}s</option>`).join("");
  // Keep the previous choice if it's still valid for the new model;
  // otherwise fall back to the closest/default rather than silently
  // resetting to the first option every time the model changes.
  if (options.includes(parseInt(previousValue))) {
    dom.videoBriefDuration.value = previousValue;
  } else {
    dom.videoBriefDuration.value = String(options[Math.floor(options.length / 2)]);
  }
}
function populateResolutionSelect(selectEl, resolutions, defaultValue) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  (resolutions.length ? resolutions : ["1K", "2K", "4K"]).forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r === "1K" ? "1K — cheapest, plenty for social feeds" : r;
    if (r === (defaultValue || "1K")) opt.selected = true;
    selectEl.appendChild(opt);
  });
}
function getGlobalImageResolution() {
  return dom.globalImageResolutionSelect?.value || state.modelDefaults.imageResolution || "1K";
}
function getGlobalBatchImageResolution() {
  return dom.globalBatchImageResolutionSelect?.value || state.modelDefaults.imageResolution || "1K";
}
// Appends model options (+ a trailing "Custom model ID…" option) to one of
// the static <select> elements in index.html, which already has its first
// "Auto/Default" option and a data-model-custom-target attribute pointing
// at its paired custom-ID text input.
//
// IMPORTANT: this is called every time the registry reloads (page load,
// and again after every "Check now" catalog refresh) — it must clear out
// whatever it added last time first, or every re-run stacks another full
// duplicate set of options on top of the last one (confirmed in
// production: three "Check now" clicks produced three copies of every
// model in the dropdown).
// Populates both Song Studio model dropdowns from the real, full backend
// registry — the actual fix for the dropdown that silently only ever
// showed one option while the backend already had several real, verified
// models sitting unused. Split by genuine capability (does it accept
// reference voice clips, or lyrics/style like the others) rather than a
// static, hand-maintained list that can drift out of sync again.
function populateMusicModelSelects() {
  const lyricsSelect = document.getElementById("songLyricsModelSelect");
  const refSelect = document.getElementById("songRefModelSelect");
  const lyricsModels = (state.musicModels || []).filter((m) => !m.supportsVoiceReference);
  const refModels = (state.musicModels || []).filter((m) => m.supportsVoiceReference);
  [[lyricsSelect, lyricsModels], [refSelect, refModels]].forEach(([selectEl, models]) => {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      selectEl.appendChild(opt);
    });
    const customOpt = document.createElement("option");
    customOpt.value = CUSTOM_MODEL_VALUE;
    customOpt.textContent = "Custom model ID...";
    customOpt.className = "advanced-only";
    selectEl.appendChild(customOpt);
  });
  updateSongLyricsModelHint();
  updateSongVocalLanguageGapNote();
}
function updateSongLyricsModelHint() {
  const selectEl = document.getElementById("songLyricsModelSelect");
  const hintEl = document.getElementById("songLyricsModelHint");
  const lyricsFieldWrap = document.getElementById("songLyricsPrompt")?.closest(".mb-3");
  const durationSection = document.getElementById("songDurationSection");
  const toolbarEl = document.getElementById("songLyricsMarkupToolbar");
  if (!selectEl || !hintEl) return;
  const modelId = readModelSelectEl(selectEl);
  const model = (state.musicModels || []).find((m) => m.id === modelId);
  durationSection?.classList.toggle("d-none", !model?.supportsDuration);
  // Real per-model structural tags (see MUSIC_MODELS' supportedLyricTags
  // in fal-models.js) — ACE-Step's confirmed set is genuinely narrower
  // than MiniMax's (no Intro/Outro), so this never offers a tag a
  // specific model wasn't actually confirmed to understand. Hidden
  // entirely for instrumental-only/timestamped-lyrics models, where
  // section tags don't apply at all.
  if (toolbarEl) {
    if (model?.supportedLyricTags?.length && !model?.instrumentalOnly && !model?.requiresTimestampedLyrics) {
      toolbarEl.innerHTML = model.supportedLyricTags
        .map((t) => `<button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-lyric-tag-insert="[${escapeHtml(t)}]">${escapeHtml(t)}</button>`)
        .join("");
      toolbarEl.classList.remove("d-none");
    } else {
      toolbarEl.innerHTML = "";
      toolbarEl.classList.add("d-none");
    }
  }
  if (model?.instrumentalOnly) {
    if (model?.supportsNegativePrompt) {
      // Real fix for a real gap: Lyria2 genuinely supports negative_prompt
      // (confirmed real field), but the lyrics field was just being
      // hidden with no alternative — meaning there was no way to
      // actually use this capability at all. Relabels the same input
      // rather than hiding it, since the underlying textarea is what
      // gets sent through either way (see the generate handler below).
      hintEl.textContent = "This model is instrumental only, but genuinely supports negative prompting — use the field below to exclude things (e.g. \"vocals, fast tempo, drums\") rather than for lyrics.";
      if (lyricsFieldWrap) {
        lyricsFieldWrap.classList.remove("d-none");
        const label = lyricsFieldWrap.querySelector("label");
        if (label) label.textContent = "Negative prompt (optional) — things to exclude";
        const textarea = document.getElementById("songLyricsPrompt");
        if (textarea) textarea.placeholder = "e.g. vocals, fast tempo, distortion";
      }
    } else {
      hintEl.textContent = "This model is instrumental only — no lyrics field exists in its real schema, so anything typed below will be ignored.";
      if (lyricsFieldWrap) lyricsFieldWrap.classList.add("d-none");
    }
  } else if (model?.requiresTimestampedLyrics) {
    hintEl.textContent = 'This model needs real timestamps on each lyric line, e.g. "[00:10.00]Moonlight spills through broken blinds" — not plain [Verse]/[Chorus] tags.';
    if (lyricsFieldWrap) {
      lyricsFieldWrap.classList.remove("d-none");
      resetSongLyricsFieldLabel(lyricsFieldWrap);
    }
  } else {
    hintEl.textContent = model?.supportsDuration ? "" : "This model doesn't expose a real duration control — its length is determined by other factors (like lyrics length), not a setting you can pick.";
    if (lyricsFieldWrap) {
      lyricsFieldWrap.classList.remove("d-none");
      resetSongLyricsFieldLabel(lyricsFieldWrap);
    }
  }
}
// Restores the lyrics field's real original label/placeholder — needed
// because Lyria2's negative-prompt mode above relabels the exact same
// input rather than adding a separate one, so switching back to a real
// lyrics-capable model has to undo that, not just show the field again.
function resetSongLyricsFieldLabel(lyricsFieldWrap) {
  const label = lyricsFieldWrap.querySelector("label");
  if (label) label.innerHTML = 'Lyrics <span class="text-muted fw-normal">(use [Verse], [Chorus], [Bridge], [Intro], [Outro] tags)</span>';
  const textarea = document.getElementById("songLyricsPrompt");
  if (textarea) textarea.placeholder = "[Verse]\n...\n[Chorus]\n...";
}

// ============================================================
// SONG ARCHITECT — instrument + genre picker that works across EVERY
// music model, not just one. The real constraint this has to respect:
// each model wants its style description in a genuinely different
// shape (see styleFieldFormat in fal-models.js) — MiniMax/ElevenLabs/
// Lyria/Sonilo/CassetteAI/Seed Audio all want a natural-language
// sentence, ACE-Step's real confirmed field is literally "comma-
// separated genre tags" (a paragraph would be the WRONG shape for it),
// and DiffRhythm has no confirmed style field at all — compiling the
// same picks differently per model, or refusing to compile at all when
// there's genuinely nowhere for it to go, rather than writing text into
// a field that silently does nothing.
// ============================================================
const songArchitectState = { selectedInstruments: new Set(), genreId: "" };

function renderSongArchitect() {
  const genreSelect = document.getElementById("songArchitectGenre");
  const indianGroup = document.getElementById("songArchitectGenreIndianGroup");
  const westernGroup = document.getElementById("songArchitectGenreWesternGroup");
  if (genreSelect && indianGroup && westernGroup) {
    indianGroup.innerHTML = (state.musicGenrePresets || []).filter((g) => g.region === "indian")
      .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}</option>`).join("");
    westernGroup.innerHTML = (state.musicGenrePresets || []).filter((g) => g.region !== "indian")
      .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}</option>`).join("");
  }
  const indianWrap = document.getElementById("songArchitectInstrumentsIndian");
  const westernWrap = document.getElementById("songArchitectInstrumentsWestern");
  const instrumentBtn = (inst) => `<button type="button" class="btn btn-sm ${songArchitectState.selectedInstruments.has(inst.id) ? "btn-dark" : "btn-outline-secondary"} py-0 px-1" data-architect-instrument="${escapeHtml(inst.id)}">${escapeHtml(inst.label)}</button>`;
  if (indianWrap) indianWrap.innerHTML = (state.musicInstruments?.indian || []).map(instrumentBtn).join("");
  if (westernWrap) westernWrap.innerHTML = (state.musicInstruments?.western || []).map(instrumentBtn).join("");
  updateSongArchitectFormatNote();
}

function updateSongArchitectFormatNote() {
  const noteEl = document.getElementById("songArchitectFormatNote");
  const applyBtn = document.getElementById("songArchitectApplyBtn");
  if (!noteEl) return;
  const modelId = readModelSelectEl(document.getElementById("songLyricsModelSelect"));
  const model = (state.musicModels || []).find((m) => m.id === modelId);
  if (!model) { noteEl.textContent = ""; return; }
  if (model.styleFieldFormat === "unconfirmed") {
    noteEl.innerHTML = `⚠️ ${model.label.replace(/^★ /, "")} has no confirmed separate style field — this Architect can't compile into it. Pick a different Music model to use it.`;
    if (applyBtn) applyBtn.disabled = true;
  } else if (model.styleFieldFormat === "tags") {
    noteEl.innerHTML = `Will compile as comma-separated genre tags — ${model.label.replace(/^★ /, "")}'s real confirmed field expects short tags, not a full sentence.`;
    if (applyBtn) applyBtn.disabled = false;
  } else {
    noteEl.innerHTML = `Will compile as a natural-language style description for ${model.label.replace(/^★ /, "")}.`;
    if (applyBtn) applyBtn.disabled = false;
  }
}

function updateSongArchitectVocalNote() {
  const noteEl = document.getElementById("songArchitectVocalNote");
  if (!noteEl) return;
  const preset = (state.musicGenrePresets || []).find((g) => g.id === songArchitectState.genreId);
  if (!preset || preset.region !== "indian") { noteEl.innerHTML = ""; return; }
  const modelId = readModelSelectEl(document.getElementById("songLyricsModelSelect"));
  const currentModel = (state.musicModels || []).find((m) => m.id === modelId);
  const currentHasVocals = (currentModel?.confirmedVocalLanguages || []).length > 0;
  if (currentHasVocals) { noteEl.innerHTML = ""; return; }
  const vocalCapable = (state.musicModels || []).find((m) => (m.confirmedVocalLanguages || []).some((l) => isLikelyIndianOrHindi(l)));
  noteEl.innerHTML = vocalCapable
    ? `<span class="text-warning">🇮🇳 For real sung Indian-language vocals (not just instrumentation), ${vocalCapable.label.replace(/^★ /, "")} is the confirmed option — the currently selected model's vocals are only confirmed in other languages.</span>`
    : "";
}
// Small local check (mirrors fal-models.js's isIndianLanguage server-side)
// just for deciding whether to surface the vocal-model nudge — not a
// second source of truth for anything sent to the backend.
function isLikelyIndianOrHindi(lang) {
  return /hindi/i.test(lang || "");
}

function compileSongArchitectPrompt() {
  const preset = (state.musicGenrePresets || []).find((g) => g.id === songArchitectState.genreId);
  const mood = document.getElementById("songArchitectMood")?.value?.trim();
  const instruments = [...songArchitectState.selectedInstruments];
  const modelId = readModelSelectEl(document.getElementById("songLyricsModelSelect"));
  const model = (state.musicModels || []).find((m) => m.id === modelId);
  if (model?.styleFieldFormat === "tags") {
    // ACE-Step's real confirmed shape: short comma-separated tags, not prose.
    const parts = [...(preset?.styleDescriptors || []), ...instruments, mood].filter(Boolean);
    return parts.join(", ");
  }
  // Prose format (the default, and what every other model here actually wants).
  const sentenceParts = [];
  if (preset?.styleDescriptors?.length) sentenceParts.push(preset.styleDescriptors.join(", "));
  if (mood) sentenceParts.push(mood);
  if (preset?.tempoHint) sentenceParts.push(preset.tempoHint);
  let sentence = sentenceParts.join(", ");
  if (instruments.length) sentence += `${sentence ? ", featuring " : "Featuring "}${instruments.join(", ")}`;
  if (preset?.vocalStyleHint) sentence += `. Vocal style: ${preset.vocalStyleHint}.`;
  return sentence;
}

document.getElementById("songArchitectGenre")?.addEventListener("change", (e) => {
  songArchitectState.genreId = e.target.value;
  const preset = (state.musicGenrePresets || []).find((g) => g.id === e.target.value);
  if (preset) songArchitectState.selectedInstruments = new Set(preset.instruments || []);
  renderSongArchitect();
  updateSongArchitectVocalNote();
});
document.getElementById("songArchitectInstrumentsIndian")?.addEventListener("click", (e) => {
  const id = e.target.closest("[data-architect-instrument]")?.getAttribute("data-architect-instrument");
  if (!id) return;
  songArchitectState.selectedInstruments.has(id) ? songArchitectState.selectedInstruments.delete(id) : songArchitectState.selectedInstruments.add(id);
  renderSongArchitect();
});
document.getElementById("songArchitectInstrumentsWestern")?.addEventListener("click", (e) => {
  const id = e.target.closest("[data-architect-instrument]")?.getAttribute("data-architect-instrument");
  if (!id) return;
  songArchitectState.selectedInstruments.has(id) ? songArchitectState.selectedInstruments.delete(id) : songArchitectState.selectedInstruments.add(id);
  renderSongArchitect();
});
document.getElementById("songArchitectApplyBtn")?.addEventListener("click", () => {
  const compiled = compileSongArchitectPrompt();
  if (!compiled.trim()) return alert("Pick a genre or at least one instrument first.");
  const styleEl = document.getElementById("songStylePrompt");
  if (!styleEl) return;
  styleEl.value = compiled.slice(0, 300);
  styleEl.dispatchEvent(new Event("input", { bubbles: true }));
});

// Honest, always-current version of the old static banner — computed
// live from state.musicModels' real confirmedVocalLanguages instead of
// a hand-typed sentence that goes stale the moment a model like Lyria 3
// Pro gets added with real non-English vocal support (exactly what
// happened here).
function updateSongVocalLanguageGapNote() {
  const noteEl = document.getElementById("songVocalLanguageGapNote");
  if (!noteEl) return;
  const value = document.getElementById("songLyricLanguageStyle")?.value;
  const models = state.musicModels || [];
  if (!value || value === "match" || value === "english") {
    noteEl.className = "alert alert-secondary py-2 px-3 xx-small mb-2";
    noteEl.innerHTML = `Real note: sung-vocal pronunciation quality is only individually confirmed per model — MiniMax/ACE-Step/ElevenLabs Music are confirmed for English vocals; Lyria 3 Pro adds confirmed Hindi (+7 more languages). Real Telugu/Hindi/etc. <em>speech</em> narration is solid elsewhere in this app (Voice Studio) regardless.`;
    return;
  }
  const matches = models.filter((m) => (m.confirmedVocalLanguages || []).some((l) => l.toLowerCase() === value.toLowerCase()));
  if (matches.length) {
    noteEl.className = "alert alert-success py-2 px-3 xx-small mb-2";
    noteEl.innerHTML = `✅ ${matches.map((m) => m.label.replace(/^★ /, "")).join(", ")} ${matches.length === 1 ? "has" : "have"} real, confirmed sung-vocal support for ${escapeHtml(value)} — pick it as your Music model below for real singing, not just narration.`;
  } else {
    noteEl.className = "alert alert-warning py-2 px-3 xx-small mb-2";
    noteEl.innerHTML = `Honest limit: no model here has confirmed sung-vocal support for ${escapeHtml(value)} specifically yet (Lyria 3 Pro confirms Hindi + 7 others, closing that one gap) — this language setting shapes the written lyrics text, but the model singing it may not pronounce ${escapeHtml(value)} correctly. Real ${escapeHtml(value)} <em>speech</em> narration is solid elsewhere in this app (Voice Studio).`;
  }
}
document.getElementById("songLyricLanguageStyle")?.addEventListener("change", updateSongVocalLanguageGapNote);

document.getElementById("songLyricsModelSelect")?.addEventListener("change", () => {
  updateSongLyricsModelHint();
  updateSongArchitectFormatNote();
  updateSongArchitectVocalNote();
});
// Section tags belong on their own line (real convention this app's
// own models expect — "[Verse]\nlyrics..."), so this inserts a leading
// newline when the cursor isn't already at the start of one, rather
// than reusing insertAtCursor's word-spacing padding (built for inline
// *tag* markers, a different insertion shape than a block tag).
document.getElementById("songLyricsMarkupToolbar")?.addEventListener("click", (e) => {
  const tag = e.target.closest("[data-lyric-tag-insert]")?.getAttribute("data-lyric-tag-insert");
  if (!tag) return;
  const textarea = document.getElementById("songLyricsPrompt");
  if (!textarea) return;
  const before = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
  const needsNewlineBefore = before.length > 0 && !before.endsWith("\n");
  insertAtCursor(textarea, `${needsNewlineBefore ? "\n" : ""}${tag}\n`, { padWithSpaces: false });
});
document.getElementById("songDurationSlider")?.addEventListener("input", (e) => {
  document.getElementById("songDurationValue").textContent = `${e.target.value}s`;
});
document.getElementById("sfxDurationSlider")?.addEventListener("input", (e) => {
  document.getElementById("sfxDurationValue").textContent = `${e.target.value}s`;
});
let sfxLastQuestions = null;
async function runSfxRefine(answers = null) {
  const description = document.getElementById("sfxPrompt")?.value?.trim();
  if (!description) return alert("Describe the sound you want first — plain words are fine.");
  const btn = document.getElementById("sfxRefineBtn");
  const questionsEl = document.getElementById("sfxRefineQuestions");
  const explanationEl = document.getElementById("sfxRefineExplanation");
  btn.disabled = true;
  btn.textContent = "Thinking...";
  try {
    const { res, data } = await fetchJson("/api/sfx/refine-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, previousQuestions: sfxLastQuestions, answers, userApiKey: getUserKey() }),
    });
    if (!res.ok) throw new Error(data.error || "Couldn't refine that.");
    if (data.needsClarification) {
      sfxLastQuestions = data.questions;
      questionsEl.classList.remove("d-none");
      explanationEl.classList.add("d-none");
      questionsEl.innerHTML = `
        <div class="border rounded p-2 bg-light">
          <p class="xx-small text-muted mb-2">A couple quick things so this comes out right:</p>
          ${data.questions.map((q, i) => `<label class="xx-small fw-semibold mb-1 d-block">${escapeHtml(q)}</label><input type="text" class="form-control form-control-sm mb-2" data-sfx-answer-index="${i}">`).join("")}
          <button type="button" class="btn btn-sm btn-primary w-100" id="sfxAnswerSubmitBtn">Continue</button>
        </div>`;
      document.getElementById("sfxAnswerSubmitBtn")?.addEventListener("click", () => {
        const answerInputs = questionsEl.querySelectorAll("[data-sfx-answer-index]");
        const collectedAnswers = [...answerInputs].map((el) => el.value.trim());
        runSfxRefine(collectedAnswers);
      });
    } else {
      sfxLastQuestions = null;
      questionsEl.classList.add("d-none");
      document.getElementById("sfxPrompt").value = data.refinedPrompt;
      if (data.explanation) {
        explanationEl.textContent = `✨ ${data.explanation}`;
        explanationEl.classList.remove("d-none");
      }
      logActivity("success", "Refined your sound description into a professional prompt.");
    }
  } catch (err) {
    alert("Couldn't refine that: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Describe it your way — I'll turn it into a professional sound-design prompt";
  }
}
// Shared across music/SFX results — same "durationMs computed but
// discarded" bug existed in all three generation routes (song single,
// song variations, SFX), now fixed server-side; this renders it
// consistently, and flags when a model with a real requestedDuration
// INPUT didn't actually honor it (a genuine mismatch worth knowing
// about, not just cosmetic).
function formatDurationNote(durationMs, requestedDurationSeconds) {
  if (!durationMs) return `<div class="xx-small text-muted fst-italic">duration not reported by this model</div>`;
  const actualSeconds = durationMs / 1000;
  if (requestedDurationSeconds) {
    const off = Math.abs(actualSeconds - requestedDurationSeconds) > requestedDurationSeconds * 0.3;
    return `<div class="xx-small ${off ? "text-danger fw-semibold" : "text-muted"}">${actualSeconds.toFixed(1)}s${off ? ` ⚠️ (asked for ${requestedDurationSeconds}s)` : ` (requested ${requestedDurationSeconds}s)`}</div>`;
  }
  return `<div class="xx-small text-muted">${actualSeconds.toFixed(1)}s</div>`;
}
document.getElementById("sfxRefineBtn")?.addEventListener("click", () => runSfxRefine());

document.getElementById("sfxGenerateBtn")?.addEventListener("click", async () => {
  const prompt = document.getElementById("sfxPrompt")?.value?.trim();
  if (!prompt) return alert("Describe the sound you want first.");
  const btn = document.getElementById("sfxGenerateBtn");
  const resultEl = document.getElementById("sfxResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Generating sound effect...");
  startProgressPolling(runId);
  try {
    const { res, data } = await fetchJson("/api/sfx/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId, prompt,
        durationSeconds: parseInt(document.getElementById("sfxDurationSlider")?.value) || 3,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Generation failed.");
    saveToAudioLibrary({ type: "sfx", name: `SFX — ${prompt.slice(0, 40)}${prompt.length > 40 ? "..." : ""}`, audioDataUri: data.audio, modelUsed: data.modelUsed, runId, silent: true });
    resultEl.innerHTML = `
      <audio controls class="w-100 mb-2" src="${data.audio}"></audio>
      ${formatDurationNote(data.durationMs, data.requestedDurationSeconds)}
      <a href="${data.audio}" data-download-url="${data.audio}" data-download-filename="sfx-${Date.now()}.wav" class="btn btn-sm btn-dark fw-bold w-100 mt-1">⬇️ Download</a>
    `;
    logActivity("success", "Sound effect generated.");
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `SFX generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
function populateStaticModelSelect(selectEl, models) {
  if (!selectEl) return;
  const previousValue = selectEl.value;
  // Keep only the first, static option (the hardcoded "Auto/Default"
  // placeholder already in index.html) — everything else here was added
  // by a previous call to this function and needs to go before adding
  // the current set, not pile up alongside it.
  while (selectEl.options.length > 1) selectEl.remove(1);
  models.filter((m) => !m.hidden).forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    selectEl.appendChild(opt);
  });
  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = "Custom model ID…";
  customOpt.className = "advanced-only";
  selectEl.appendChild(customOpt);
  // Restore whatever was selected before, as long as it's still a valid
  // option — otherwise a routine background refresh would silently reset
  // someone's deliberate model choice back to "Auto".
  if ([...selectEl.options].some((o) => o.value === previousValue)) {
    selectEl.value = previousValue;
  }
}
// Builds a <select> (+ a hidden-until-needed text input for a custom Fal
// endpoint ID) for a dynamically-rendered per-card dropdown (prompt
// review cards, batch concept cards, video brief cards — these have no
// static markup since they're generated per-run). dataAttr identifies the
// select/input pair for later reading via readModelSelectValue().
// minReferenceImages: when this step needs multiple images combined at
// once (e.g. identity + product compositing), models that can only
// accept a single reference get excluded rather than shown as if they'd
// work — the same "don't offer options that silently underperform"
// philosophy already applied to video's combine-capability filtering
// (FLUX Klein specifically only takes 1 reference image; picking it for
// a 2-image compositing step would silently drop one of the images,
// same failure mode as a non-combining video model).
function modelSelectHtml({ models, dataAttr, index, selectedValue = "", labelPrefix = "", minReferenceImages = 1 }) {
  // Same real-evidence exclusion as video: a model documented (or
  // reactively confirmed via db.recordImageContentBlockModel, now wired
  // into the image path too) as likeness-sensitive has no business being
  // offered for a compositing step (minReferenceImages >= 2 already
  // signals "this needs identity + product combined") — that's exactly
  // the scenario this kind of block happens in.
  const needsCompositing = minReferenceImages > 1;
  const fitting = models.filter((m) => {
    if (m.hidden) return false;
    if ((m.maxReferenceImages || 1) < minReferenceImages) return false;
    if (needsCompositing && (m.knownLikenessSensitive || state.confirmedLikenessBlockModels.includes(m.id))) return false;
    return true;
  });
  const excludedCount = models.filter((m) => !m.hidden).length - fitting.length;
  const options = fitting
    .map((m) => `<option value="${m.id}" ${m.id === selectedValue ? "selected" : ""}>${labelPrefix}${m.label}</option>`)
    .join("");
  const isCustomSelected = selectedValue && !models.some((m) => m.id === selectedValue);
  const customId = `${dataAttr}-custom-${index}`;
  return `<div class="model-select-wrap">
    <select class="form-select form-select-sm" ${dataAttr}="${index}" data-model-custom-target="${customId}">
      <option value="">Default</option>
      ${options}
      <option value="${CUSTOM_MODEL_VALUE}" class="${isCustomSelected ? "" : "advanced-only"}" ${isCustomSelected ? "selected" : ""}>Custom model ID…</option>
    </select>
    <input type="text" class="form-control form-control-sm mt-1 ${isCustomSelected ? "" : "d-none"}" id="${customId}" placeholder="e.g. fal-ai/some-model/edit" value="${isCustomSelected ? selectedValue : ""}">
    ${excludedCount > 0 ? `<small class="text-muted xx-small d-block mt-1">${excludedCount} model(s) hidden — either they don't accept enough reference images for this step's compositing, or they're known/confirmed to reject human-inclusive combined requests.</small>` : ""}
  </div>`;
}
// Delegated listener: whenever ANY model <select> (static or dynamically
// injected by modelSelectHtml()) changes, toggle its paired custom-ID text
// input based on the data-model-custom-target attribute.
document.addEventListener("change", (e) => {
  const target = e.target.getAttribute?.("data-model-custom-target");
  if (!target) return;
  const input = document.getElementById(target);
  if (!input) return;
  input.classList.toggle("d-none", e.target.value !== CUSTOM_MODEL_VALUE);
  if (e.target.value === CUSTOM_MODEL_VALUE) input.focus();
});
// Reads back a select's effective value given the select element itself:
// the dropdown choice, or the paired custom text input if "Custom model
// ID…" is selected. Returns "" (meaning "use server default") if left on
// "Auto"/"Default".
function readModelSelectEl(selectEl) {
  if (!selectEl) return "";
  if (selectEl.value === CUSTOM_MODEL_VALUE) {
    const input = document.getElementById(selectEl.getAttribute("data-model-custom-target"));
    return input?.value.trim() || "";
  }
  return selectEl.value || "";
}
// Same, but looked up by a data-*-idx attribute (for the per-card selects
// built by modelSelectHtml(), which are dynamically rendered and not
// reachable via the static `dom` object).
function readModelSelectValue(dataAttr, index) {
  return readModelSelectEl(document.querySelector(`[${dataAttr}="${index}"]`));
}
function getGlobalImageModel() {
  return readModelSelectEl(dom.globalImageModelSelect);
}
function getWizardImageModel() {
  return readModelSelectEl(dom.wizardImageModelSelect);
}
// Explains the real two-step situation instead of either hiding a model
// that IS genuinely usable (for the final photoshoot, which always has a
// reference image by the time it runs) or leaving the "why did it use a
// different model" confusion unexplained. Filtering this dropdown down
// to only text-to-image models would be WRONG — most models here are
// perfectly fine for the actual photoshoot step; they just can't handle
// the separate "invent from a blank text description" step if there's
// no reference photo at all yet.
function updateWizardImageModelHint() {
  const hintEl = document.getElementById("wizardImageModelHint");
  if (!hintEl) return;
  const modelId = getWizardImageModel();
  const model = state.imageModels.find((m) => m.id === modelId);
  const hasReference = state.wizardIsReference || !!document.getElementById("wizardImageInput")?.files?.[0];
  if (modelId && model && !hasReference && !model.textToImageOnly) {
    hintEl.textContent = `i️ ${model.label} can't create an image from a text description alone (it needs a reference photo to edit) — Nano Banana will be used instead for this creation. Upload a reference photo above and ${model.label} can be used directly.`;
  } else {
    hintEl.textContent = "";
  }
}
document.getElementById("wizardImageModelSelect")?.addEventListener("change", updateWizardImageModelHint);
function getGlobalBatchImageModel() {
  return readModelSelectEl(dom.globalBatchImageModelSelect);
}
function getGlobalVideoModel() {
  return readModelSelectEl(dom.globalVideoModelSelect);
}
const BRAND_PROFILE_KEY = "brand_profile_v1";
const WHERE_SOLD_CHECKBOX_IDS = [
  "bpSellInstagram",
  "bpSellAmazon",
  "bpSellFlipkart",
  "bpSellEtsy",
  "bpSellWhatsapp",
  "bpSellWebsite",
  "bpSellPhysical",
];
function getBrandProfile() {
  try {
    const raw = localStorage.getItem(BRAND_PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}
function populateBrandProfileForm(profile) {
  dom.bpBrandName.value = profile?.brandName || "";
  dom.bpTargetAudience.value = profile?.targetAudience || "";
  dom.bpRegion.value = profile?.region || "";
  dom.bpAesthetic.value = profile?.aestheticPreference || "";
  dom.bpBirthYear.value = profile?.birthYear || "";
  const whereSold = new Set(profile?.whereSold || []);
  WHERE_SOLD_CHECKBOX_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = whereSold.has(el.value);
  });
}
function readBrandProfileForm() {
  const whereSold = WHERE_SOLD_CHECKBOX_IDS.map((id) =>
    document.getElementById(id),
  )
    .filter((el) => el && el.checked)
    .map((el) => el.value);
  const rawYear = parseInt(dom.bpBirthYear.value);
  const currentYear = new Date().getFullYear();
  const birthYear =
    rawYear && rawYear >= 1930 && rawYear <= currentYear ? rawYear : null;
  return {
    brandName: dom.bpBrandName.value.trim(),
    whereSold,
    targetAudience: dom.bpTargetAudience.value.trim(),
    region: dom.bpRegion.value.trim(),
    aestheticPreference: dom.bpAesthetic.value.trim(),
    birthYear,
  };
}
function applyBrandNameAutofill(profile) {
  if (!profile) return;
  const singleBrandNameEl = document.getElementById("brandName");
  if (singleBrandNameEl && !singleBrandNameEl.value.trim() && profile.brandName) singleBrandNameEl.value = profile.brandName;
  const batchBrandNameEl = document.getElementById("batchBrandName");
  if (batchBrandNameEl && !batchBrandNameEl.value.trim() && profile.brandName) batchBrandNameEl.value = profile.brandName;
}
dom.saveBrandProfileBtn.addEventListener("click", () => {
  const profile = readBrandProfileForm();
  localStorage.setItem(BRAND_PROFILE_KEY, JSON.stringify(profile));
  applyBrandNameAutofill(profile);
  const modalInstance = bootstrap.Modal.getInstance(document.getElementById("brandProfileModal"));
  if (modalInstance) modalInstance.hide();
});
dom.brandProfileNavBtn.addEventListener("click", () => {
  populateBrandProfileForm(getBrandProfile());
  new bootstrap.Modal(document.getElementById("brandProfileModal")).show();
});
async function refreshCreditsSummary() {
  try {
    const { res, data } = await fetchJson("/api/credits/summary");
    if (!res.ok) return;
    dom.navCreditsSpent.innerText = `$${data.totalSpent.toFixed(2)}`;
    dom.creditsTotalSpent.innerText = `$${data.totalSpent.toFixed(2)}`;
    if (dom.creditsTotalSpentInr)
      dom.creditsTotalSpentInr.innerText = `≈ ₹${data.totalSpentInr.toFixed(2)}`;
    dom.creditsCallCount.innerText = data.callCount;
    dom.creditsRemaining.innerText =
      data.remaining != null ? `$${data.remaining.toFixed(2)}` : "—";
    dom.creditsRemaining.classList.toggle(
      "text-danger",
      data.remaining != null && data.remaining < 0,
    );
    if (dom.creditsRemainingInr)
      dom.creditsRemainingInr.innerText =
        data.remainingInr != null ? `≈ ₹${data.remainingInr.toFixed(2)}` : "";
    if (dom.creditsFxRate)
      dom.creditsFxRate.innerText = `$1 ≈ ₹${data.exchangeRateUsdToInr}`;
    renderCreditsByFeature(data.byFeature);
  } catch (err) {
    console.warn("Could not refresh credits summary:", err.message);
  }
}
// Where the money is actually going — Photography vs Video vs Audio vs
// Text & Planning, computed server-side (db.js's categorizeTransaction)
// from real model IDs, not guessed here. Simple proportional bars,
// widest-first, since this is a glance-at-it panel, not a full chart.
const CREDITS_FEATURE_ICONS = { Photography: "📸", Video: "🎬", Audio: "🎙️", "Text & Planning": "📝", "Vision & Analysis": "👁️", Other: "🔧" };
function renderCreditsByFeature(byFeature) {
  const container = document.getElementById("creditsByFeatureBars");
  if (!container) return;
  if (!byFeature || !byFeature.length) {
    container.innerHTML = `<div class="text-muted xx-small">No spend recorded yet.</div>`;
    return;
  }
  const maxSpent = Math.max(...byFeature.map((f) => f.spent), 0.0001);
  container.innerHTML = byFeature
    .map((f) => {
      const pct = Math.max(4, Math.round((f.spent / maxSpent) * 100));
      const icon = CREDITS_FEATURE_ICONS[f.feature] || "🔧";
      return `<div class="d-flex align-items-center gap-2">
        <div class="xx-small text-nowrap" style="width: 130px;">${icon} ${f.feature}</div>
        <div class="flex-grow-1 bg-light rounded" style="height: 8px;">
          <div class="bg-dark rounded" style="height: 8px; width: ${pct}%;"></div>
        </div>
        <div class="xx-small text-nowrap text-end" style="width: 100px;">$${f.spent.toFixed(3)} <span class="text-muted">(${f.callCount})</span></div>
      </div>`;
    })
    .join("");
}
async function loadFalRealBalance() {
  const amountEl = document.getElementById("falRealBalanceAmount");
  const noteEl = document.getElementById("falRealBalanceNote");
  try {
    const { data } = await fetchJson("/api/fal-billing/balance", {
      headers: { "X-Fal-Admin-Key": getUserAdminKey() },
    });
    if (!data.available) {
      amountEl.textContent = "—";
      noteEl.innerHTML = `${data.reason} <a href="#" data-open-admin-key-settings>Add key</a>`;
      document.querySelector("[data-open-admin-key-settings]")?.addEventListener("click", (e) => {
        e.preventDefault();
        bootstrap.Modal.getInstance(document.getElementById("creditsModal"))?.hide();
        new bootstrap.Modal(document.getElementById("settingsModal")).show();
      });
      return;
    }
    amountEl.textContent = `${data.currency === "USD" ? "$" : data.currency + " "}${data.balance?.toFixed(2)}`;
    noteEl.textContent = `Account: ${data.username || "—"} · fetched live from Fal just now`;
  } catch (err) {
    amountEl.textContent = "—";
    noteEl.textContent = `Couldn't reach Fal: ${err.message}`;
  }
}
let creditsLedgerPage = 1;
async function loadCreditsLedger(page = 1) {
  creditsLedgerPage = page;
  try {
    const { res, data } = await fetchJson(`/api/credits/transactions?limit=25&page=${page}`);
    if (!res.ok) return;
    dom.creditsTransactionBody.innerHTML = data.transactions
      .map((t) => {
        const statusBadge =
          t.status === "success"
            ? "success"
            : t.status === "blocked"
              ? "danger"
              : "warning";
        const dt = new Date(t.created_at + "Z");
        const timeLabel = `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`;
        return `<tr>
          <td class="small text-nowrap">${timeLabel}</td>
          <td class="small">${t.endpoint}${t.frame_index != null ? ` #${t.frame_index + 1}` : ""}</td>
          <td class="small">${CREDITS_FEATURE_ICONS[t.feature] || "🔧"} ${t.feature}</td>
          <td class="small">${t.model}</td>
          <td><span class="badge bg-${statusBadge}">${t.status}</span></td>
          <td class="text-end small">$${t.estimated_cost.toFixed(4)} <span class="text-muted">(₹${t.estimated_cost_inr.toFixed(2)})</span></td>
        </tr>`;
      })
      .join("");
    const p = data.pagination;
    document.getElementById("creditsPageInfo").textContent = `Page ${p.page} of ${p.totalPages} (${p.total} total)`;
    document.getElementById("creditsPrevBtn").disabled = p.page <= 1;
    document.getElementById("creditsNextBtn").disabled = p.page >= p.totalPages;
  } catch (err) {
    console.warn("Could not load credits ledger:", err.message);
  }
}
document.getElementById("creditsPrevBtn")?.addEventListener("click", () => loadCreditsLedger(Math.max(1, creditsLedgerPage - 1)));
document.getElementById("creditsNextBtn")?.addEventListener("click", () => loadCreditsLedger(creditsLedgerPage + 1));

let realUsageCursor = null;
async function loadRealUsageHistory(append = false) {
  const bodyEl = document.getElementById("realUsageBody");
  if (!append) bodyEl.innerHTML = `<div class="text-muted small p-2">Loading...</div>`;
  try {
    const params = new URLSearchParams();
    if (realUsageCursor) params.set("cursor", realUsageCursor);
    const { data } = await fetchJson(`/api/fal-billing/usage?${params.toString()}`, {
      headers: { "X-Fal-Admin-Key": getUserAdminKey() },
    });
    if (!data.available) {
      bodyEl.innerHTML = `<div class="text-muted small p-2">${data.reason}</div>`;
      document.getElementById("realUsageNextBtn").classList.add("d-none");
      return;
    }
    const rows = (data.items || [])
      .map(
        (r) => `<div class="d-flex justify-content-between border-bottom py-1 small">
          <span>${r.timestamp ? new Date(r.timestamp).toLocaleString() : ""} — ${r.endpoint_id || ""}</span>
          <span>${r.cost_total != null ? `$${Number(r.cost_total).toFixed(4)}` : ""} ${r.quantity != null ? `(${r.quantity} ${r.unit || ""} × $${r.unit_price})` : ""}</span>
        </div>`,
      )
      .join("");
    if (append) bodyEl.insertAdjacentHTML("beforeend", rows);
    else bodyEl.innerHTML = rows || `<div class="text-muted small p-2">No usage recorded in the last 30 days.</div>`;
    realUsageCursor = data.next_cursor || data.cursor || null;
    document.getElementById("realUsageNextBtn").classList.toggle("d-none", !realUsageCursor);
  } catch (err) {
    bodyEl.innerHTML = `<div class="text-danger small p-2">${err.message}</div>`;
  }
}
document.getElementById("realUsageNextBtn")?.addEventListener("click", () => loadRealUsageHistory(true));
document.querySelectorAll("[data-ledger-tab]").forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll("[data-ledger-tab]").forEach((b) => b.classList.remove("active"));
    tabBtn.classList.add("active");
    const tab = tabBtn.getAttribute("data-ledger-tab");
    document.getElementById("creditsEstimateTab").classList.toggle("d-none", tab !== "estimate");
    document.getElementById("creditsRealTab").classList.toggle("d-none", tab !== "real");
    if (tab === "real") {
      realUsageCursor = null;
      loadRealUsageHistory(false);
    }
  });
});
document
  .getElementById("creditsModal")
  .addEventListener("show.bs.modal", () => {
    loadCreditsLedger(1);
    loadFalRealBalance();
  });
dom.saveBudgetBtn.addEventListener("click", async () => {
  const amount = parseFloat(dom.budgetInput.value);
  if (isNaN(amount) || amount < 0) return alert("Enter a valid budget amount.");
  try {
    const { res, data } = await fetchJson("/api/credits/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) throw new Error(data.error || "Failed to set budget.");
    await refreshCreditsSummary();
    dom.budgetInput.value = "";
  } catch (err) {
    alert(err.message);
  }
});
let campaignsPage = 1;
async function loadCampaignsList(page = 1) {
  campaignsPage = page;
  dom.campaignsList.innerHTML = `<div class="text-muted small">Loading...</div>`;
  try {
    const { res, data } = await fetchJson(`/api/campaigns?limit=15&page=${page}`);
    if (!res.ok) throw new Error(data.error || "Failed to load campaigns.");
    if (!data.campaigns.length) {
      dom.campaignsList.innerHTML = `<div class="text-muted small">No saved campaigns yet.</div>`;
    } else {
      dom.campaignsList.innerHTML = data.campaigns
        .map((c) => {
          const time = new Date(c.created_at + "Z").toLocaleString();
          const desc = (c.product_description || "").slice(0, 90);
          const spend = c.spend || { spent: 0, callCount: 0 };
          return `<div class="d-flex justify-content-between align-items-center border-bottom py-2">
            <div class="small">
              <div class="fw-semibold">${c.brand_name || "(no brand name)"}</div>
              <div class="text-muted">${desc}${desc.length === 90 ? "..." : ""}</div>
              <div class="text-muted xx-small">${time} · 💳 $${spend.spent.toFixed(3)} <span class="text-muted">(${spend.callCount} call${spend.callCount === 1 ? "" : "s"})</span></div>
            </div>
            <button class="btn btn-sm btn-outline-primary" data-run-id="${c.run_id}">Load</button>
          </div>`;
        })
        .join("");
      dom.campaignsList.querySelectorAll("button[data-run-id]").forEach((btn) => {
        btn.addEventListener("click", () =>
          loadCampaign(btn.getAttribute("data-run-id")),
        );
      });
    }
    const p = data.pagination;
    if (p) {
      document.getElementById("campaignsPageInfo").textContent = `Page ${p.page} of ${p.totalPages} (${p.total} total)`;
      document.getElementById("campaignsPrevBtn").disabled = p.page <= 1;
      document.getElementById("campaignsNextBtn").disabled = p.page >= p.totalPages;
    }
  } catch (err) {
    dom.campaignsList.innerHTML = `<div class="text-danger small">${err.message}</div>`;
  }
}
document.getElementById("campaignsPrevBtn")?.addEventListener("click", () => loadCampaignsList(Math.max(1, campaignsPage - 1)));
document.getElementById("campaignsNextBtn")?.addEventListener("click", () => loadCampaignsList(campaignsPage + 1));
async function loadCampaign(runId) {
  try {
    const { res, data } = await fetchJson(
      `/api/campaigns/${encodeURIComponent(runId)}`,
    );
    if (!res.ok) throw new Error(data.error || "Failed to load campaign.");
    state.runId = data.runId;
    state.environment = data.environment || null;
    state.seedIdentity = data.seedIdentity || null;
    state.classification = data.classification || {};
    state.promptTypes = data.promptTypes || [];
    state.lockedSetImage = null;
    state.lockedProductImage = null;
    state.lockedLookReference = null;
    const isBatch = data.mode === "batch";
    if (isBatch) {
      // Switch into Batch Mode so the fields we're about to fill are actually visible
      showAppMode("batch");
      const bn = document.getElementById("batchBrandName");
      const pd = document.getElementById("batchProductDesc");
      const cd = document.getElementById("batchCreativeDirection");
      if (bn) bn.value = data.brandName || "";
      if (pd) pd.value = data.productDescription || "";
      if (cd) cd.value = data.creativeDirection || "";
      state.batchRunId = data.runId;
      const modalInstance = bootstrap.Modal.getInstance(
        document.getElementById("campaignsModal"),
      );
      if (modalInstance) modalInstance.hide();
      if (data.generatedItems?.length) {
        renderBatchResults({ items: data.generatedItems, diagnostics: {} });
        dom.batchResultsSection.classList.remove("d-none");
        dom.batchResultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
        logActivity("info", `Batch campaign loaded — showing ${data.generatedItems.length} previously generated product(s).`);
      } else {
        alert(
          "Batch campaign loaded. Re-upload the same product photos (in the same order) before running Step 1 again.",
        );
      }
      return;
    }
    // Single mode — switch back into Single Mode view too, in case Batch or Wizard Mode was showing
    showAppMode("single");
    document.getElementById("brandName").value = data.brandName || "";
    document.getElementById("productDesc").value =
      data.productDescription || "";
    dom.creativeDirection.value = data.creativeDirection || "";
    const banner = document.getElementById("classificationBanner");
    banner.classList.remove("d-none");
    document.getElementById("detectedCategoryLabel").innerText =
      state.classification.productLabel || "Unclassified";
    document.getElementById("detectedConfidence").innerText =
      state.classification.confidenceScore ?? "—";
    document.getElementById("detectedReasoning").innerText = state
      .classification.reasoning
      ? `"${state.classification.reasoning}"`
      : "";
    dom.placeholderView.classList.add("d-none");
    document.getElementById("lockedSetView").classList.add("d-none");
    document.getElementById("photoshootResultsSection").classList.add("d-none");
    if (data.imagePrompts?.length)
      renderPromptReviewCards(data.imagePrompts, data.promptTypes);
    const humanFrames = (data.promptTypes || []).filter(
      (t) => t === "human",
    ).length;
    dom.lockSetHint.textContent =
      humanFrames > 0
        ? "This previews the identity+product+background composite once, before spending on the full batch."
        : "No human frames requested — this step will skip straight through.";
    const modalInstance = bootstrap.Modal.getInstance(
      document.getElementById("campaignsModal"),
    );
    if (modalInstance) modalInstance.hide();
    // Real, confirmed gap fixed here: this used to only ever restore text
    // fields and tell the person to re-upload/re-run everything, even
    // though the actual generated images were sitting right there in
    // run_items the whole time, already paid for.
    if (data.generatedItems?.length) {
      const imageUrls = data.generatedItems.map((i) => i.image);
      const modelsUsed = data.generatedItems.map((i) => i.modelUsed);
      renderFinalImageGrid(imageUrls, { framesRequested: imageUrls.length, framesSucceeded: imageUrls.length }, modelsUsed);
      document.getElementById("photoshootResultsSection").scrollIntoView({ behavior: "smooth", block: "start" });
      logActivity("info", `Campaign loaded — showing ${imageUrls.length} previously generated image(s).`);
    } else {
      alert(
        "Campaign loaded. Upload the product photo (and reference photo, if used) before locking the set.",
      );
    }
  } catch (err) {
    alert(err.message);
  }
}
document
  .getElementById("campaignsModal")
  .addEventListener("show.bs.modal", () => loadCampaignsList(1));
function updateFrameCountTotal() {
  const human = Math.max(0, parseInt(dom.humanFrameCount.value) || 0);
  const nonHuman = Math.max(0, parseInt(dom.nonHumanFrameCount.value) || 0);
  const total = human + nonHuman;
  dom.totalFrameCount.innerText = total;
  const overCap = total > 10;
  dom.frameCountWarning.classList.toggle("d-none", !overCap);
  dom.generateBtn.disabled = overCap || !state.isolatedProductBase64;
  return { human, nonHuman, total, overCap };
}
dom.humanFrameCount.addEventListener("input", updateFrameCountTotal);
dom.nonHumanFrameCount.addEventListener("input", updateFrameCountTotal);
document.addEventListener("DOMContentLoaded", () => {
  dom.geminiKeyInput.value = getUserKey();
  if (dom.falAdminKeyInput) dom.falAdminKeyInput.value = getUserAdminKey();
  if (dom.falTextModelInput) dom.falTextModelInput.value = localStorage.getItem("fal_text_model") || "";
  if (dom.falVisionModelInput) dom.falVisionModelInput.value = localStorage.getItem("fal_vision_model") || "";
  loadModelRegistry();
  // Fire-and-forget: the server-side check safely no-ops on its own if
  // the cache is still fresh, so calling this on every load is cheap —
  // but this IS the only place a real user key exists to run it with in
  // the first place, since the server has no key at cold startup.
  const userKey = getUserKey();
  if (userKey) {
    fetchJson("/api/voice/verify-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userApiKey: userKey }),
    }).catch(() => {}); // best-effort — a failed verification trigger shouldn't disrupt anything else on load
  }
  [].slice
    .call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
    .forEach((el) => new bootstrap.Tooltip(el));
  dom.uploadNewBtn.addEventListener("click", () => dom.imageInput.click());
  dom.chokeSlider.addEventListener("input", (e) => {
    dom.chokeValue.innerText = `${e.target.value}px`;
  });
  dom.chokeSlider.addEventListener("change", async (e) => {
    if (!state.rawIsolatedProductBase64) return;
    const trimAmount = parseInt(e.target.value);
    dom.chokeSlider.disabled = true;
    try {
      toggleStatusView(true, `Refining edges at ${trimAmount}px depth...`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      state.isolatedProductBase64 = await applyColorDecontamination(
        state.rawIsolatedProductBase64,
        trimAmount,
      );
      dom.resultImage.src = state.isolatedProductBase64;
      dom.downloadBtn.href = state.isolatedProductBase64;
    } catch (err) {
      alert("Failed to refine edges: " + err.message);
    } finally {
      dom.chokeSlider.disabled = false;
      toggleStatusView(false);
    }
  });
  dom.modelReferenceInput.addEventListener("change", handleReferenceUpload);
  dom.lockWardrobe.addEventListener("change", () => {
    dom.wardrobeVarietyRow.classList.toggle("d-none", dom.lockWardrobe.checked);
  });
updateFrameCountTotal();
  refreshCreditsSummary();
  checkForResumableRun();
  refreshReliabilityHealth();
  setInterval(refreshReliabilityHealth, 60000);
  const existingBrandProfile = getBrandProfile();
  if (!existingBrandProfile) {
    populateBrandProfileForm(null);
    new bootstrap.Modal(document.getElementById("brandProfileModal")).show();
  } else {
    applyBrandNameAutofill(existingBrandProfile);
  }
});
async function handleReferenceUpload(e) {
  const file = e.target.files[0];
  dom.multiPersonPicker.classList.add("d-none");
  dom.clothingWarningBanner.classList.add("d-none");
  dom.multiPersonOptions.innerHTML = "";
  state.referencePeople = null;
  state.selectedPersonId = null;
  state.subjectSelectionNote = "";
  state.sanitizedReferenceImage = null;
  if (!file) {
    state.modelReferenceBase64 = null;
    dom.matchReferenceOutfitRow.classList.add("d-none");
    return;
  }
  dom.matchReferenceOutfitRow.classList.remove("d-none");
  // A fresh reference-photo upload is the natural "starting a shoot"
  // moment — mint the run_id here (not consumed until Generate is
  // actually clicked) so analyze-reference's cost lands under the same
  // campaign as everything that follows, instead of as an orphaned row.
  state.pendingShootRunId = crypto.randomUUID();
  const reader = new FileReader();
  reader.onload = async (event) => {
    state.modelReferenceBase64 = event.target.result;
    try {
      toggleStatusView(true, "Checking reference photo for multiple people...");
      const referenceImageForAnalysis = await resizeImageForClassification(
        state.modelReferenceBase64,
        512,
      );
      const { res, data } = await fetchJson("/api/analyze-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelReferenceBase64: referenceImageForAnalysis,
          productDescription: document.getElementById("productDesc").value,
          creativeDirection: dom.creativeDirection.value,
          userApiKey: getUserKey(),
          runId: state.pendingShootRunId,
        }),
      });
      toggleStatusView(false);
      if (!res.ok) {
        console.warn("Reference analysis skipped:", data.error);
        return;
      }
      if (data.minimalClothingWarning) {
        dom.clothingWarningBanner.innerText = `i️ ${data.minimalClothingNote || "This reference photo shows minimal/revealing clothing."} We'll automatically generate a neutral-wardrobe version of this person's face/body to use for compositing. Check "Match the reference photo's actual outfit" instead if you specifically want that outfit preserved.`;
        dom.clothingWarningBanner.classList.remove("d-none");
      } else {
        dom.clothingWarningBanner.classList.add("d-none");
      }
      if (data.peopleCount > 1) {
        state.referencePeople = data;
        renderMultiPersonPicker(data);
      }
    } catch (err) {
      toggleStatusView(false);
      console.warn("Reference analysis failed:", err.message);
    }
  };
  reader.readAsDataURL(file);
}
function renderMultiPersonPicker(data) {
  dom.multiPersonReasoning.innerText = `AI suggestion: ${data.reasoning || "using framing to guess the subject."}`;
  dom.multiPersonOptions.innerHTML = "";
  data.people.forEach((person) => {
    const isRecommended = person.id === data.recommendedId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-sm ${isRecommended ? "btn-primary" : "btn-outline-secondary"}`;
    btn.innerText = `${person.label}${isRecommended ? " ★" : ""} — ${person.description}`;
    btn.addEventListener("click", () =>
      selectReferencePerson(person, data.people),
    );
    dom.multiPersonOptions.appendChild(btn);
  });
  dom.multiPersonPicker.classList.remove("d-none");
  const recommended =
    data.people.find((p) => p.id === data.recommendedId) || data.people[0];
  selectReferencePerson(recommended, data.people);
}
function selectReferencePerson(person, allPeople) {
  state.selectedPersonId = person.id;
  state.subjectSelectionNote = `Use ONLY the person labeled "${person.label}" (${person.description}) as the subject — ignore any other people visible in the reference photo.`;
  [...dom.multiPersonOptions.children].forEach((btn, i) => {
    const matches = allPeople[i]?.id === person.id;
    btn.className = `btn btn-sm ${matches ? "btn-primary" : "btn-outline-secondary"}`;
  });
}
async function handleBatchReferenceUpload(e) {
  const file = e.target.files[0];
  dom.batchMultiPersonPicker.classList.add("d-none");
  dom.batchClothingWarningBanner.classList.add("d-none");
  dom.batchMultiPersonOptions.innerHTML = "";
  state.batchReferencePeople = null;
  state.batchSelectedPersonId = null;
  state.batchSubjectSelectionNote = "";
  if (!file) {
    state.batchModelReferenceBase64 = null;
    dom.batchMatchReferenceOutfitRow.classList.add("d-none");
    return;
  }
  dom.batchMatchReferenceOutfitRow.classList.remove("d-none");
  // Same reasoning as Single Mode — a fresh reference-photo upload marks
  // the start of this batch shoot, so mint the run_id here rather than
  // letting this check's cost fall outside the campaign it belongs to.
  state.pendingBatchRunId = crypto.randomUUID();
  const reader = new FileReader();
  reader.onload = async (event) => {
    state.batchModelReferenceBase64 = event.target.result;
    try {
      toggleStatusView(true, "Checking reference photo for multiple people...");
      const referenceImageForAnalysis = await resizeImageForClassification(
        state.batchModelReferenceBase64,
        512,
      );
      const { res, data } = await fetchJson("/api/analyze-reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelReferenceBase64: referenceImageForAnalysis,
          productDescription: document.getElementById("batchProductDesc").value,
          creativeDirection: document.getElementById("batchCreativeDirection")
            .value,
          userApiKey: getUserKey(),
          runId: state.pendingBatchRunId,
        }),
      });
      toggleStatusView(false);
      if (!res.ok) {
        console.warn("Batch reference analysis skipped:", data.error);
        return;
      }
      if (data.minimalClothingWarning) {
        dom.batchClothingWarningBanner.innerText = `i️ ${data.minimalClothingNote || "This reference photo shows minimal/revealing clothing."} We'll auto-generate a neutral-wardrobe identity from it. Check "Match the reference photo's actual outfit" instead if you specifically want that outfit preserved.`;
        dom.batchClothingWarningBanner.classList.remove("d-none");
      } else {
        dom.batchClothingWarningBanner.classList.add("d-none");
      }
      if (data.peopleCount > 1) {
        state.batchReferencePeople = data;
        renderBatchMultiPersonPicker(data);
      }
    } catch (err) {
      toggleStatusView(false);
      console.warn("Batch reference analysis failed:", err.message);
    }
  };
  reader.readAsDataURL(file);
}
function renderBatchMultiPersonPicker(data) {
  dom.batchMultiPersonReasoning.innerText = `AI suggestion: ${data.reasoning || "using framing to guess the subject."}`;
  dom.batchMultiPersonOptions.innerHTML = "";
  data.people.forEach((person) => {
    const isRecommended = person.id === data.recommendedId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-sm ${isRecommended ? "btn-primary" : "btn-outline-secondary"}`;
    btn.innerText = `${person.label}${isRecommended ? " ★" : ""} — ${person.description}`;
    btn.addEventListener("click", () =>
      selectBatchReferencePerson(person, data.people),
    );
    dom.batchMultiPersonOptions.appendChild(btn);
  });
  dom.batchMultiPersonPicker.classList.remove("d-none");
  const recommended =
    data.people.find((p) => p.id === data.recommendedId) || data.people[0];
  selectBatchReferencePerson(recommended, data.people);
}
function selectBatchReferencePerson(person, allPeople) {
  state.batchSelectedPersonId = person.id;
  state.batchSubjectSelectionNote = `Use ONLY the person labeled "${person.label}" (${person.description}) as the subject — ignore any other people visible in the reference photo.`;
  [...dom.batchMultiPersonOptions.children].forEach((btn, i) => {
    const matches = allPeople[i]?.id === person.id;
    btn.className = `btn btn-sm ${matches ? "btn-primary" : "btn-outline-secondary"}`;
  });
}
dom.imageInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.rawIsolatedProductBase64 = null;
  state.isolatedProductBase64 = null;
  state.originalProductImage = null;
  state.cutoutProductImage = null;
  state.useOriginalPhoto = false;
  dom.resultImage.classList.add("d-none");
  dom.downloadBtn.classList.add("d-none");
  dom.uploadNewBtn.classList.add("d-none");
  dom.chokeControl.classList.remove("d-flex");
  dom.chokeControl.classList.add("d-none");
  dom.useOriginalToggleBtn.classList.add("d-none");
  dom.chokeValue.innerText = `...`;
  const reader = new FileReader();
  reader.onload = function (event) {
    const img = new Image();
    img.onload = async function () {
      const MAX_DIMENSION = getDeviceCapabilities();
      const dynamicMaxChoke = Math.max(5, Math.round(MAX_DIMENSION * 0.02));
      const defaultChoke = Math.max(1, Math.round(dynamicMaxChoke * 0.15));
      dom.chokeSlider.max = dynamicMaxChoke;
      dom.chokeSlider.value = defaultChoke;
      dom.chokeValue.innerText = `${defaultChoke}px`;
      let width = img.width;
      let height = img.height;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width > height) {
          height = Math.round((height * MAX_DIMENSION) / width);
          width = MAX_DIMENSION;
        } else {
          width = Math.round((width * MAX_DIMENSION) / height);
          height = MAX_DIMENSION;
        }
      }
      const ctx = dom.previewCanvas.getContext("2d");
      dom.previewCanvas.width = width;
      dom.previewCanvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      dom.dropzonePrompt.classList.add("d-none");
      dom.comparisonContainer.classList.remove("d-none");
      dom.previewCanvas.classList.remove("d-none");
      dom.resultImage.classList.add("d-none");
      dom.downloadBtn.classList.add("d-none");
      const safeNormalizedPng = dom.previewCanvas.toDataURL("image/png");
      state.originalProductImage = safeNormalizedPng;
      let settled = false;
      try {
        toggleStatusView(true, "Isolating product edges in browser memory...");
        updateFrameCountTotal();
        state.isolatedProductBase64 = await withTimeout(
          window.removeProductBackground(safeNormalizedPng, (progress) => {
            if (settled) return;
            if (progress.status === "progress") {
              toggleStatusView(
                true,
                `Loading local AI models: ${Math.round(progress.progress)}%`,
              );
            }
          }),
          90000,
          "Local background removal timed out after 90 seconds — the AI model download may have stalled. This can happen on a slow connection during the model's first download; try again, or check your network.",
        );
        settled = true;
        toggleStatusView(true, "Refining edges and removing color halos...");
        state.rawIsolatedProductBase64 = state.isolatedProductBase64;
        const currentChoke = parseInt(dom.chokeSlider.value) || 1;
        state.isolatedProductBase64 = await applyColorDecontamination(
          state.rawIsolatedProductBase64,
          currentChoke,
        );
        state.cutoutProductImage = state.isolatedProductBase64;
        state.useOriginalPhoto = false;
        dom.resultImage.src = state.isolatedProductBase64;
        dom.resultImage.classList.remove("d-none");
        dom.downloadBtn.classList.remove("d-none");
        dom.uploadNewBtn.classList.remove("d-none");
        dom.chokeControl.classList.remove("d-none");
        dom.chokeControl.classList.add("d-flex");
        dom.useOriginalToggleBtn.classList.remove("d-none");
        updateUseOriginalToggleUI();
        dom.downloadBtn.href = state.isolatedProductBase64;
        dom.downloadBtn.download = "isolated-product.png";
        dom.downloadBtn.onclick = (ev) => {
          ev.preventDefault();
          const link = document.createElement("a");
          link.href = state.isolatedProductBase64;
          link.download = "isolated-product.png";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        };
        toggleStatusView(false);
        updateFrameCountTotal();
      } catch (err) {
        settled = true;
        toggleStatusView(false);
        if (state.originalProductImage) {
          state.useOriginalPhoto = true;
          state.isolatedProductBase64 = state.originalProductImage;
          dom.resultImage.src = state.originalProductImage;
          dom.resultImage.classList.remove("d-none");
          dom.downloadBtn.classList.remove("d-none");
          dom.uploadNewBtn.classList.remove("d-none");
          dom.useOriginalToggleBtn.classList.remove("d-none");
          updateUseOriginalToggleUI();
          updateFrameCountTotal();
        }
        alert(
          "Local background removal failed: " +
            err.message +
            (state.originalProductImage
              ? "\n\nFalling back to your original photo — you can still proceed."
              : ""),
        );
      }
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
});
function updateUseOriginalToggleUI() {
  if (state.useOriginalPhoto) {
    dom.useOriginalToggleBtn.innerHTML = "✅ Use AI Cutout Instead";
    dom.useOriginalToggleBtn.classList.remove("btn-outline-dark");
    dom.useOriginalToggleBtn.classList.add("btn-warning");
    dom.resultImageLabel.innerText = "Original Photo (cutout skipped)";
    dom.cutoutQualityNote.innerText = "Sending your original photo as-is.";
    dom.chokeControl.classList.add("d-none");
    dom.chokeControl.classList.remove("d-flex");
  } else {
    dom.useOriginalToggleBtn.innerHTML = "📷 Use Original Photo Instead";
    dom.useOriginalToggleBtn.classList.remove("btn-warning");
    dom.useOriginalToggleBtn.classList.add("btn-outline-dark");
    dom.resultImageLabel.innerText = "Cutout Result";
    dom.cutoutQualityNote.innerText =
      "Not happy with the cutout? You can skip it and send your original photo instead.";
    if (state.cutoutProductImage) {
      dom.chokeControl.classList.remove("d-none");
      dom.chokeControl.classList.add("d-flex");
    }
  }
}
dom.useOriginalToggleBtn.addEventListener("click", () => {
  state.useOriginalPhoto = !state.useOriginalPhoto;
  const activeImage = state.useOriginalPhoto
    ? state.originalProductImage
    : state.cutoutProductImage;
  if (!activeImage) return;
  state.isolatedProductBase64 = activeImage;
  dom.resultImage.src = activeImage;
  dom.downloadBtn.href = activeImage;
  updateUseOriginalToggleUI();
});
dom.batchModeNavBtn.addEventListener("click", () => showAppMode("batch"));
dom.wizardModeNavBtn.addEventListener("click", () => showAppMode("wizard"));
document.getElementById("flowModeNavBtn")?.addEventListener("click", () => {
  showAppMode("flow");
  populateFlowAudioModelSelects(); // real fix: this was defined but never actually called, so the narration/BGM dropdowns would have stayed empty
});
document.getElementById("audioModeNavBtn")?.addEventListener("click", () => showAppMode("audio"));
// ============================================================
// AUDIO STUDIO SECTION SWITCHER — deliberately plain radio button-group
// + .d-none toggling, not Bootstrap's Tab component. Audio Studio used
// to look like "some tab thing" sitting inside a modal; now that it's a
// real page mode like Single/Batch/Flow, its internal section switch
// should read as a segmented control on a page, not a tab bar — the
// same visual language the rest of the app already avoids using for
// primary navigation.
// ============================================================
document.getElementById("audioStudioSwitcher")?.addEventListener("change", (e) => {
  const sectionId = document.querySelector(`label[for="${e.target.id}"]`)?.getAttribute("data-audio-section");
  if (!sectionId) return;
  ["voiceStudioTabPane", "songStudioModal", "mixerConsoleTabPane", "audioToolsTabPane"].forEach((id) => {
    document.getElementById(id)?.classList.toggle("d-none", id !== sectionId);
  });
  if (sectionId === "songStudioModal") state.songStudioRunId = crypto.randomUUID();
  if (sectionId === "mixerConsoleTabPane") {
    // Real fix: restoring here needs to happen exactly ONCE per page
    // load, not every time this tab is switched to — otherwise
    // switching away and back mid-edit (before the 600ms debounced
    // save fires) would silently overwrite fresh in-progress changes
    // with a stale saved copy, a real data-loss bug of its own.
    if (!state.mixerSessionRestored) {
      state.mixerSessionRestored = true;
      restoreMixerSession().then(() => {
        renderMixerMainTrack();
        renderMixerBackground();
        renderMixerOverlays();
        renderMixerIntroOutro();
      });
    } else {
      loadMixerLibrary();
      renderMixerMainTrack();
      renderMixerBackground();
      renderMixerOverlays();
      renderMixerIntroOutro();
    }
  }
  if (sectionId === "audioToolsTabPane") populateAudioToolsLibrarySelects();
});
// ============================================================
// NEW SESSION — real reset, not just a visual clear: Audio Studio's
// state is genuinely session-based (Voice Studio's script persists to
// localStorage, the Mixer's Main Track/Intro/Outro/Background/Overlays
// live in memory for as long as the tab's open) — this wipes all of
// it in one place instead of manually deleting every line and clip.
// Doesn't touch the Audio Library itself (nothing already generated or
// saved is deleted) — only the CURRENT working session's arrangement.
// ============================================================
document.getElementById("audioStudioNewSessionBtn")?.addEventListener("click", () => {
  if (!confirm("Start a new session? This clears the current Voice Studio script and everything loaded into the Mixer (Main Track, Intro, Outro, Background, Overlays). Nothing in your Audio Library gets deleted — only this session's current arrangement.")) return;
  // Voice Studio — real reset, including the persisted copy, not just
  // the in-memory one (otherwise reopening the modal would silently
  // restore the "cleared" script from localStorage).
  localStorage.removeItem("voiceScriptSession");
  state.voiceScript = { lines: [newVoiceScriptLine()], runId: crypto.randomUUID() };
  renderVoiceScript();
  document.getElementById("voiceScriptCombineResult").innerHTML = "";
  // Mixer — clears every slot back to empty, including the persisted
  // copy (otherwise the old arrangement would silently come back on
  // the next reload, since only the in-memory state would be cleared).
  localStorage.removeItem("mixerSession");
  state.mixerSessionRestored = true; // explicit, defensive — prevents any later first-visit-to-Mixer this session from attempting a restore after an intentional reset (the localStorage clear above already makes that a no-op regardless, but this is the clearer signal)
  state.mixerMainTrack = [];
  state.mixerIntro = null;
  state.mixerOutro = null;
  state.mixerBackground = null;
  state.mixerOverlays = [];
  renderMixerMainTrack();
  renderMixerIntroOutro();
  renderMixerBackground();
  renderMixerOverlays();
  const mixerResultEl = document.getElementById("mixerRenderResult");
  if (mixerResultEl) mixerResultEl.innerHTML = "";
  // Song Studio — clears the working fields, fresh run ID for whatever
  // gets generated next.
  ["songStylePrompt", "songLyricsPrompt", "songStoryPrompt"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const songResultEl = document.getElementById("songStudioResult");
  if (songResultEl) songResultEl.innerHTML = "";
  state.songStudioRunId = crypto.randomUUID();
  // Audio Tools — clears any staged uploads so a stale file from a
  // previous session isn't silently reused.
  state.audioToolsUploads = {};
  document.querySelectorAll('#audioToolsTabPane input[type="file"]').forEach((input) => { input.value = ""; });
  document.querySelectorAll('#audioToolsTabPane [id$="UploadStatus"]').forEach((el) => { el.textContent = ""; });
  ["toolsExtractResult", "toolsConvertResult", "toolsRingtoneResult", "toolsRevoiceResult"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });
  logActivity("success", "Audio Studio session cleared — starting fresh.");
});
// The new choice-screen landing view — each card is a one-way jump into
// that mode; "Home" (nav button + brand link) is the one-way jump back,
// replacing the old toggle-back-to-single-on-second-click behavior now
// that there's an explicit home state to return to instead.
document.querySelectorAll("[data-choice-mode]").forEach((card) => {
  card.addEventListener("click", () => {
    const mode = card.getAttribute("data-choice-mode");
    showAppMode(mode);
    if (mode === "flow") populateFlowAudioModelSelects();
  });
});
document.getElementById("wizardFromHomeBtn")?.addEventListener("click", () => showAppMode("wizard"));
document.getElementById("homeNavBtn")?.addEventListener("click", () => showAppMode("home"));
document.getElementById("homeNavBrand")?.addEventListener("click", (e) => {
  e.preventDefault();
  showAppMode("home");
});
// Shared 6-way mode switcher (home/single/batch/wizard/flow/audio) —
// only one visible at a time. "home" is the choice-screen landing view.
// Audio Studio used to be a Bootstrap modal — now it's a real page mode
// like every other one here, not "some tab thing or modal thing" sitting
// on top of the page. The 6 init listeners that used to fire on the
// modal's own "show.bs.modal" event (fresh run ID, live voice-catalog
// recheck, populating dropdowns, etc.) still exist completely unchanged
// — rather than rewriting each one's internal logic, this just keeps
// dispatching that exact same event on the (renamed) container element
// every time Audio mode is entered, so all of them keep firing exactly
// as before with zero risk of subtly changing what any of them do.
function showAppMode(mode) {
  document.getElementById("modeChoiceScreen")?.classList.toggle("d-none", mode !== "home");
  dom.singleProductRow.classList.toggle("d-none", mode !== "single");
  dom.batchModeRow.classList.toggle("d-none", mode !== "batch");
  dom.wizardModeRow.classList.toggle("d-none", mode !== "wizard");
  document.getElementById("flowModeRow")?.classList.toggle("d-none", mode !== "flow");
  dom.audioModeRow?.classList.toggle("d-none", mode !== "audio");
  if (mode === "audio") dom.audioModeRow?.dispatchEvent(new Event("show.bs.modal"));
  if (mode !== "home") window.scrollTo({ top: 0, behavior: "smooth" });
}
// ============================================================
// SMART WIZARD — third mode. Deliberately hands off into Single Product
// Mode's existing pipeline at the end rather than duplicating it: the
// wizard's whole job is producing a BETTER, more specific brief through
// guided questions, then feeding that into the same battle-tested
// generation flow everything else in this app already uses.
// ============================================================
document.getElementById("wizardImageInput")?.addEventListener("change", (e) => {
  const hasFile = !!e.target.files[0];
  document.getElementById("wizardUseAsIsRow").classList.toggle("d-none", !hasFile);
  if (!hasFile) document.getElementById("wizardUseReferenceAsIs").checked = false;
});
function updateWizardCreationTypeUI() {
  const isLogo = document.getElementById("wizardTypeLogo").checked;
  // A logo is always designed from a description, never a reference
  // photo — there's no equivalent of "upload the product photo" for
  // something that doesn't exist yet, so skip that option entirely
  // rather than showing a choice that doesn't apply.
  document.getElementById("wizardReferenceUpload").classList.toggle("d-none", isLogo);
  document.getElementById("wizardUploadLabel").innerHTML = isLogo ? "" : 'Product Photo <span class="text-muted fw-normal">(optional — skip this and just describe it below instead)</span>';
  document.getElementById("wizardDescribeLabel").innerHTML = isLogo
    ? "Describe the brand"
    : 'Describe the product <span class="text-muted fw-normal">(optional if you uploaded a photo above, required if you didn\'t)</span>';
  document.getElementById("wizardProductDescription").placeholder = isLogo
    ? "e.g. a boutique coffee roastery called \"Northbound Coffee\" — warm, artisanal, slightly rustic feel"
    : "e.g. a deep purple Kanjeevaram silk saree with a gold zari border and peacock motif pallu";
  document.getElementById("wizardDescribeHint").textContent = "";
  document.getElementById("wizardVariantsLabel").textContent = isLogo
    ? "I want to see multiple distinct style directions, not just one"
    : "I want to explore multiple color/style variations of this product";
}
document.getElementById("wizardTypeProduct")?.addEventListener("change", updateWizardCreationTypeUI);
document.getElementById("wizardTypeLogo")?.addEventListener("change", updateWizardCreationTypeUI);
document.getElementById("wizardWantsVariants")?.addEventListener("change", (e) => {
  document.getElementById("wizardVariantsControls").classList.toggle("d-none", !e.target.checked);
});
state.wizardAnswers = [];
state.wizardQuestions = [];
document.getElementById("wizardStartBtn")?.addEventListener("click", async () => {
  const isLogo = document.getElementById("wizardTypeLogo").checked;
  const fileInput = document.getElementById("wizardImageInput");
  const hasFile = !isLogo && !!fileInput.files[0];
  const useAsIs = hasFile && document.getElementById("wizardUseReferenceAsIs").checked;
  const description = document.getElementById("wizardProductDescription").value.trim();
  const wantsVariants = document.getElementById("wizardWantsVariants").checked;
  if (isLogo && !description) return alert("Describe the brand first.");
  if (!isLogo && !hasFile && !description) return alert("Upload a product photo, or describe it — at least one is needed.");
  const btn = document.getElementById("wizardStartBtn");
  btn.disabled = true;
  const runId = crypto.randomUUID();
  toggleStatusView(true, "Reading your description and preparing questions...");
  startProgressPolling(runId);
  try {
    let imageBase64 = null;
    if (hasFile) {
      // Captured regardless of the as-is checkbox — needed either way,
      // as the exact product if "use as-is" is checked, or as inspiration
      // for a newly-invented design if it isn't.
      imageBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(fileInput.files[0]);
      });
    }
    state.wizardImageBase64 = imageBase64;
    state.wizardDescription = description;
    state.wizardWantsVariants = wantsVariants;
    state.wizardVariantCount = Math.max(2, Math.min(6, parseInt(document.getElementById("wizardVariantCount").value) || 3));
    state.wizardVariantTheme = document.getElementById("wizardVariantTheme").value.trim();
    // wizardIsReference now specifically means "use this exact photo,
    // skip inventing" — NOT just "a file was given." A reference photo
    // being present no longer skips the invent step by default; only
    // this explicit checkbox does. This matches the actual intent: a
    // fashion brand giving a reference for inspiration wants something
    // NEW created, not the same photo handed back.
    state.wizardIsReference = useAsIs;
    state.wizardCreationType = isLogo ? "logo" : "product";
    const { res, data } = await fetchJson("/api/wizard-questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, productDescription: description, productImageBase64: imageBase64, wantsVariants, userApiKey: getUserKey(), textModel: getTextModel(), creationType: state.wizardCreationType }),
    });
    if (!res.ok) throw new Error(data.error || "Couldn't generate questions.");
    state.wizardQuestions = data.questions || [];
    state.wizardAnswers = new Array(state.wizardQuestions.length).fill(null);
    state.wizardMcqState = {};
    renderWizardQuestions();
    document.getElementById("wizardStep1").classList.add("d-none");
    document.getElementById("wizardStep2").classList.remove("d-none");
    updateWizardImageModelHint();
  } catch (err) {
    alert("Couldn't start the wizard: " + err.message);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
// Tracks the raw pieces per MCQ question (which options are selected,
// plus any free-text "other") separately from the final combined answer
// string, so they can be recombined cleanly on every interaction without
// losing track of what's actually selected.
state.wizardMcqState = {};
function computeWizardMcqAnswer(qi) {
  const s = state.wizardMcqState[qi] || { selected: [], other: "" };
  const parts = [...s.selected];
  if (s.other?.trim()) parts.push(s.other.trim());
  return parts.join(", ");
}
function renderWizardQuestions() {
  const listEl = document.getElementById("wizardQuestionsList");
  listEl.innerHTML = state.wizardQuestions.map((q, qi) => {
    if (q.type === "text") {
      return `
      <div class="border rounded p-3 bg-light">
        <div class="fw-semibold small mb-2">${escapeHtml(q.question)}</div>
        <input type="text" class="form-control form-control-sm" data-wizard-text-q="${qi}" placeholder="Type your answer..." value="${escapeHtml(state.wizardAnswers[qi] || "")}">
      </div>`;
    }
    if (!state.wizardMcqState[qi]) state.wizardMcqState[qi] = { selected: [], other: "" };
    const mcqState = state.wizardMcqState[qi];
    return `
    <div class="border rounded p-3 bg-light">
      <div class="fw-semibold small mb-2">${escapeHtml(q.question)}${q.allowMultiple ? ' <span class="text-muted fw-normal xx-small">(pick as many as fit)</span>' : ""}</div>
      <div class="d-flex flex-wrap gap-2 mb-2">
        ${(q.options || []).map((opt, oi) => `<button type="button" class="btn btn-sm ${mcqState.selected.includes(opt) ? "btn-primary" : "btn-outline-secondary"}" data-wizard-answer-q="${qi}" data-wizard-answer-opt="${oi}">${escapeHtml(opt)}</button>`).join("")}
      </div>
      <input type="text" class="form-control form-control-sm" data-wizard-other-q="${qi}" placeholder="Or type your own..." value="${escapeHtml(mcqState.other || "")}">
    </div>`;
  }).join("");
  listEl.querySelectorAll("[data-wizard-answer-q]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qi = parseInt(btn.getAttribute("data-wizard-answer-q"));
      const oi = parseInt(btn.getAttribute("data-wizard-answer-opt"));
      const opt = state.wizardQuestions[qi].options[oi];
      const mcqState = state.wizardMcqState[qi];
      if (state.wizardQuestions[qi].allowMultiple) {
        // Toggle membership — this option can coexist with others already picked.
        const idx = mcqState.selected.indexOf(opt);
        if (idx === -1) mcqState.selected.push(opt); else mcqState.selected.splice(idx, 1);
      } else {
        // Single-choice — picking one replaces whatever was selected before.
        mcqState.selected = mcqState.selected[0] === opt ? [] : [opt];
      }
      state.wizardAnswers[qi] = computeWizardMcqAnswer(qi);
      renderWizardQuestions();
    });
  });
  // Text inputs save directly on input WITHOUT re-rendering the list —
  // re-rendering on every keystroke would reset focus and break typing,
  // unlike MCQ buttons which only need a visual re-render for selection
  // feedback, not continuous input.
  listEl.querySelectorAll("[data-wizard-text-q]").forEach((input) => {
    input.addEventListener("input", () => {
      const qi = parseInt(input.getAttribute("data-wizard-text-q"));
      state.wizardAnswers[qi] = input.value;
    });
  });
  listEl.querySelectorAll("[data-wizard-other-q]").forEach((input) => {
    input.addEventListener("input", () => {
      const qi = parseInt(input.getAttribute("data-wizard-other-q"));
      state.wizardMcqState[qi].other = input.value;
      state.wizardAnswers[qi] = computeWizardMcqAnswer(qi);
    });
  });
}
document.getElementById("wizardBackBtn")?.addEventListener("click", () => {
  document.getElementById("wizardStep2").classList.add("d-none");
  document.getElementById("wizardStep1").classList.remove("d-none");
});
document.getElementById("wizardAnswersSubmitBtn")?.addEventListener("click", async () => {
  if (state.wizardAnswers.some((a) => !a || !a.trim())) return alert("Answer every question first — a few still need a response.");
  document.getElementById("wizardStep2").classList.add("d-none");
  const step3 = document.getElementById("wizardStep3");
  step3.classList.remove("d-none");
  const statusEl = document.getElementById("wizardStep3Status");
  const runId = crypto.randomUUID();
  const refinedBrief = state.wizardQuestions.map((q, i) => `${q.question} → ${state.wizardAnswers[i]}`).join(". ");
  // Logo mode branches off entirely here — a logo has no product to
  // composite, no identity to lock, none of Single Mode's pipeline
  // applies. It generates directly and shows the result right in the
  // wizard, with the same carousel/chaining pattern already built for
  // Image Tools (same functions, a different chain key).
  // Shared by both Product Creation and Logo Design — a single created
  // image (or one of several variants) with carousel history, a
  // regenerate button, and download. This IS the wizard's actual job:
  // create the product/logo itself. It deliberately does NOT call
  // generate-text or generate-images — that's a full marketing
  // photoshoot (captions, tags, multiple shot concepts), which is
  // Single/Batch mode's job, not this one's. Two tools doing the same
  // thing helps no one.
  function renderWizardCreationCard({ chainId, imageUrl, containerEl, regenerateFn, downloadName, cardTitle }) {
    delete state.imageHistory[chainId];
    pushImageVersion(chainId, imageUrl);
    const render = () => {
      const h = state.imageHistory[chainId];
      const currentUrl = h.versions[h.index];
      containerEl.innerHTML = `
        ${cardTitle ? `<div class="fw-semibold small mb-1">${escapeHtml(cardTitle)}</div>` : ""}
        <div class="border rounded overflow-hidden mb-2">
          <img src="${currentUrl}" class="img-fluid" style="max-height: 360px; width: 100%; object-fit: contain; background: #f8f9fa;">
          ${carouselNavHtml(chainId)}
        </div>
        <div class="d-flex gap-2 mb-2">
          <a href="${currentUrl}" data-download-url="${currentUrl}" data-download-filename="${downloadName}" class="btn btn-sm btn-dark fw-bold flex-grow-1">⬇️ Download</a>
          <button type="button" class="btn btn-sm btn-outline-primary flex-grow-1" data-wizard-regen="${chainId}">🔄 Try another version</button>
        </div>
        <label class="form-label xx-small text-muted mb-1">Model for edits/regeneration on this one</label>
        ${modelSelectHtml({ models: state.imageModels, dataAttr: "data-wizard-model", index: chainId, selectedValue: getWizardImageModel() || "" })}
        <div class="d-flex gap-1 align-items-center mt-2">
          <input type="text" class="form-control form-control-sm" style="font-size: 0.8rem;" data-wizard-edit-input="${chainId}" placeholder="Describe what to change (e.g. 'thicker gold border')...">
          <button type="button" class="btn btn-sm btn-outline-primary px-2 py-1" data-wizard-edit-btn="${chainId}" title="Edit this exact image with the instruction typed above">✏️</button>
        </div>
      `;
      wireCarouselNav(chainId, containerEl, (newUrl) => {
        const link = containerEl.querySelector("a[data-download-url]");
        if (link) { link.href = newUrl; link.setAttribute("data-download-url", newUrl); }
      });
      const getCardModel = () => readModelSelectEl(containerEl.querySelector(`[data-wizard-model="${chainId}"]`)) || getWizardImageModel() || state.modelDefaults?.image || state.imageModels.find((m) => m.tier === "pro")?.id;
      containerEl.querySelector(`[data-wizard-regen="${chainId}"]`)?.addEventListener("click", async () => {
        const btn = containerEl.querySelector(`[data-wizard-regen="${chainId}"]`);
        btn.disabled = true;
        btn.textContent = "Working...";
        try {
          const newUrl = await regenerateFn(getCardModel());
          pushImageVersion(chainId, newUrl);
          render();
          logActivity("success", "Generated another version.");
        } catch (err) {
          alert("Couldn't generate another version: " + err.message);
        } finally {
          toggleStatusView(false);
        }
      });
      containerEl.querySelector(`[data-wizard-edit-btn="${chainId}"]`)?.addEventListener("click", async () => {
        const editInput = containerEl.querySelector(`[data-wizard-edit-input="${chainId}"]`);
        const imgEl = containerEl.querySelector("img");
        const model = getCardModel();
        toggleStatusView(true, "Applying your edit...");
        const newUrl = await editFrameWithInstruction({
          imgEl,
          editInstruction: editInput?.value,
          model,
          aspectRatio: "1:1",
          runId: crypto.randomUUID(),
          resolution: getGlobalImageResolution(),
          cardId: chainId,
          cardEl: containerEl,
        });
        toggleStatusView(false);
        if (newUrl && editInput) editInput.value = "";
        if (newUrl) {
          const link = containerEl.querySelector("a[data-download-url]");
          if (link) { link.href = newUrl; link.setAttribute("data-download-url", newUrl); }
        }
      });
    };
    render();
  }
  if (state.wizardCreationType === "logo") {
    try {
      statusEl.textContent = "Designing your logo...";
      toggleStatusView(true, "Designing your logo...");
      startProgressPolling(runId);
      const generateLogo = async () => {
        const genRunId = crypto.randomUUID();
        const { res, data } = await fetchJson("/api/wizard-generate-logo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: genRunId, brandDescription: state.wizardDescription, refinedBrief, userApiKey: getUserKey() }),
        });
        if (!res.ok) throw new Error(data.error || "Couldn't generate the logo.");
        return data.image;
      };
      const firstImage = await generateLogo();
      toggleStatusView(false);
      step3.classList.add("d-none");
      const resultEl = document.getElementById("wizardLogoResult");
      resultEl.classList.remove("d-none");
      renderWizardCreationCard({
        chainId: "wizard-logo",
        imageUrl: firstImage,
        containerEl: resultEl,
        regenerateFn: async () => {
          toggleStatusView(true, "Designing another version...");
          startProgressPolling(crypto.randomUUID());
          return generateLogo();
        },
        downloadName: "logo-design.png",
      });
      const startOverBtn = document.createElement("button");
      startOverBtn.type = "button";
      startOverBtn.className = "btn btn-link btn-sm w-100 mt-1";
      startOverBtn.textContent = "← Start a new wizard session";
      startOverBtn.addEventListener("click", () => {
        delete state.imageHistory["wizard-logo"];
        resultEl.classList.add("d-none");
        document.getElementById("wizardStep1").classList.remove("d-none");
      });
      resultEl.appendChild(startOverBtn);
      logActivity("success", "Logo design ready.");
    } catch (err) {
      toggleStatusView(false);
      step3.classList.add("d-none");
      document.getElementById("wizardStep2").classList.remove("d-none");
      alert("Wizard failed: " + err.message);
    }
    return;
  }
  try {
    const generateProduct = async (variationHint = "") => {
      const genRunId = crypto.randomUUID();
      const brief = variationHint ? `${refinedBrief} ${variationHint}` : refinedBrief;
      const { res, data } = await fetchJson("/api/wizard-generate-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: genRunId, productDescription: state.wizardDescription, referenceImageBase64: state.wizardImageBase64, refinedBrief: brief, aspectRatio: "1:1", userApiKey: getUserKey(), preferredModel: getWizardImageModel() }),
      });
      if (!res.ok) throw new Error(data.error || "Couldn't create the product image.");
      if (data.fallbackNote) logActivity("info", data.fallbackNote);
      return data.image;
    };
    const wantsVariants = state.wizardWantsVariants;
    const variantCount = wantsVariants ? state.wizardVariantCount : 1;
    const buildHint = (i) => wantsVariants
      ? `Variation ${i + 1} of ${variantCount} — ${state.wizardVariantTheme ? state.wizardVariantTheme : "explore a genuinely different color, pattern, or style direction than the other variations"} while keeping the same core product concept recognizable across all ${variantCount}.`
      : "";
    statusEl.textContent = wantsVariants ? `Creating ${variantCount} variations...` : "Creating your product...";
    toggleStatusView(true, statusEl.textContent);
    startProgressPolling(runId);
    const images = [];
    for (let i = 0; i < variantCount; i++) {
      images.push(await generateProduct(buildHint(i)));
    }
    toggleStatusView(false);
    step3.classList.add("d-none");
    document.getElementById("wizardPlaceholderView").classList.add("d-none");
    const gridEl = document.getElementById("wizardFinalImageGrid");
    document.getElementById("wizardPhotoshootResultsSection").classList.remove("d-none");
    gridEl.innerHTML = "";
    images.forEach((imageUrl, i) => {
      const col = document.createElement("div");
      col.className = images.length > 1 ? "col-12 col-md-6" : "col-12";
      gridEl.appendChild(col);
      renderWizardCreationCard({
        chainId: `wizard-product-${i}`,
        imageUrl,
        containerEl: col,
        regenerateFn: async () => {
          toggleStatusView(true, "Creating another version...");
          startProgressPolling(crypto.randomUUID());
          return generateProduct(buildHint(i));
        },
        downloadName: `product-creation-${i + 1}.png`,
        cardTitle: images.length > 1 ? `Variation ${i + 1}` : null,
      });
    });
    logActivity("success", `Wizard creation ready — ${images.length} image(s) generated right here.`);
  } catch (err) {
    toggleStatusView(false);
    step3.classList.add("d-none");
    document.getElementById("wizardStep2").classList.remove("d-none");
    alert("Wizard failed: " + err.message);
  }
});

// ============================================================
// IMAGE TOOLS — Upscale, Extend, Restore/Colorize. Single-image
// utilities separate from the photoshoot pipeline. Supports chaining
// multiple tools on the same image (e.g. restore a damaged B&W photo,
// then upscale the restored result) by reusing the same version-history
// carousel system already built for the main photoshoot cards — a fixed
// key ("image-tools") into the same state.imageHistory store, so no new
// mechanism was needed, just applying the existing one to a new context.
// ============================================================
const IMAGE_TOOLS_CHAIN_ID = "image-tools";
function updateImageToolModelOptions() {
  const tool = document.getElementById("imageToolSelect")?.value;
  const selectEl = document.getElementById("imageToolModelSelect");
  const hintEl = document.getElementById("imageToolModelHint");
  const extraParamsEl = document.getElementById("imageToolExtraParams");
  if (!selectEl || !tool) return;
  const options = state.utilityModels?.[tool] || [];
  const previousValue = selectEl.value;
  selectEl.innerHTML = options.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}${m.costPerMegapixel ? ` — $${m.costPerMegapixel}/MP` : m.costPerImage ? ` — ~$${m.costPerImage}/image` : ""}</option>`).join("");
  // Keep the same model selected across a tool-list refresh if it's
  // still valid for this tool, otherwise fall back to the first option.
  if (options.some((m) => m.id === previousValue)) selectEl.value = previousValue;
  const renderExtraParams = () => {
    const model = options.find((m) => m.id === selectEl.value);
    if (!extraParamsEl) return;
    if (!model?.extraParams?.length) {
      extraParamsEl.innerHTML = "";
      return;
    }
    extraParamsEl.innerHTML = model.extraParams.map((p) => `
      <div class="mb-2">
        <label class="form-label xx-small fw-semibold mb-1 d-flex justify-content-between">
          <span>${escapeHtml(p.label)}</span>
          <span class="text-muted" data-extra-param-value="${p.field}">${p.default}</span>
        </label>
        <input type="range" class="form-range" data-extra-param="${p.field}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}">
        ${p.hint ? `<p class="xx-small text-muted mb-0">${escapeHtml(p.hint)}</p>` : ""}
      </div>`).join("");
    extraParamsEl.querySelectorAll("[data-extra-param]").forEach((slider) => {
      slider.addEventListener("input", () => {
        const valueEl = extraParamsEl.querySelector(`[data-extra-param-value="${slider.getAttribute("data-extra-param")}"]`);
        if (valueEl) valueEl.textContent = slider.value;
      });
    });
  };
  const updateHint = () => {
    const model = options.find((m) => m.id === selectEl.value);
    hintEl.textContent = model?.bestFor ? `💡 Best for: ${model.bestFor}` : "";
    renderExtraParams();
  };
  selectEl.onchange = updateHint;
  updateHint();
}
document.getElementById("imageToolSelect")?.addEventListener("change", (e) => {
  document.getElementById("imageToolExtendOptions").classList.toggle("d-none", e.target.value !== "extend");
  document.getElementById("imageToolUpscaleOptions").classList.toggle("d-none", e.target.value !== "upscale");
  updateImageToolModelOptions();
});
document.getElementById("imageToolsInput")?.addEventListener("change", async (e) => {
  const suggestionEl = document.getElementById("imageToolsSuggestion");
  suggestionEl.classList.add("d-none");
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    // A fresh file chosen here is the start of a new tools "chain" (see
    // imageToolsRunBtn below) — mint the run_id now so this suggestion
    // check and the FIRST tool run on this file share one run_id, instead
    // of the suggestion always landing as an orphaned row.
    state.pendingToolsRunId = crypto.randomUUID();
    const { res, data } = await fetchJson("/api/tools/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64, userApiKey: getUserKey(), runId: state.pendingToolsRunId }),
    });
    if (!res.ok || !data.tool) return;
    const toolLabels = { upscale: "📈 Upscale", extend: "🖼️ Extend", restore: "🎨 Restore & Colorize" };
    if (data.tool === "none") {
      suggestionEl.textContent = `👁️ ${data.reason || "This image already looks clean and well-composed — no obvious fix needed, but feel free to use a tool anyway."}`;
      suggestionEl.classList.remove("d-none");
      return;
    }
    const currentTool = document.getElementById("imageToolSelect").value;
    if (data.tool === currentTool) {
      suggestionEl.textContent = `👁️ ${toolLabels[data.tool]} looks like the right pick — ${data.reason || ""}`;
      suggestionEl.classList.remove("d-none");
      if (data.modelId) { const el = document.getElementById("imageToolModelSelect"); if (el) el.value = data.modelId; }
      return;
    }
    suggestionEl.innerHTML = `👁️ ${data.reason || "Based on what's actually in this image:"} <button type="button" class="btn btn-sm btn-outline-primary ms-2 py-0" id="imageToolsSuggestionApply">Use ${toolLabels[data.tool]} instead</button>`;
    suggestionEl.classList.remove("d-none");
    document.getElementById("imageToolsSuggestionApply")?.addEventListener("click", () => {
      document.getElementById("imageToolSelect").value = data.tool;
      document.getElementById("imageToolSelect").dispatchEvent(new Event("change"));
      if (data.modelId) { const el = document.getElementById("imageToolModelSelect"); if (el) el.value = data.modelId; }
      suggestionEl.classList.add("d-none");
    });
  } catch {
    // Vision suggestion failing shouldn't block using the tool at all —
    // silently skip it, the person can still pick manually.
  }
});
function updateImageToolsChainUI() {
  const h = state.imageHistory[IMAGE_TOOLS_CHAIN_ID];
  const hint = document.getElementById("imageToolsChainHint");
  const label = document.getElementById("imageToolsInputLabel");
  const resetBtn = document.getElementById("imageToolsResetBtn");
  if (h && h.versions.length > 1) {
    label.textContent = "Image (optional — leave blank to run the next tool on the current result)";
    hint.textContent = `${h.versions.length} step(s) applied so far. Leave the file blank to keep chaining, or choose a new file to start a fresh chain.`;
    resetBtn.classList.remove("d-none");
  } else {
    label.textContent = "Image";
    hint.textContent = "";
    resetBtn.classList.add("d-none");
  }
}
document.getElementById("imageToolsResetBtn")?.addEventListener("click", () => {
  delete state.imageHistory[IMAGE_TOOLS_CHAIN_ID];
  document.getElementById("imageToolsResult").innerHTML = "";
  document.getElementById("imageToolsInput").value = "";
  updateImageToolsChainUI();
});
function renderImageToolsResult() {
  const resultEl = document.getElementById("imageToolsResult");
  const h = state.imageHistory[IMAGE_TOOLS_CHAIN_ID];
  const currentUrl = h.versions[h.index];
  resultEl.innerHTML = `
    <div class="border rounded overflow-hidden">
      <img src="${currentUrl}" class="img-fluid" style="max-height: 400px; width: 100%; object-fit: contain; background: #f8f9fa;">
      ${carouselNavHtml(IMAGE_TOOLS_CHAIN_ID)}
    </div>
    <a href="${currentUrl}" data-download-url="${currentUrl}" data-download-filename="image-tools-result.png" class="btn btn-sm btn-dark fw-bold w-100 mt-2">⬇️ Download This Version</a>
  `;
  wireCarouselNav(IMAGE_TOOLS_CHAIN_ID, resultEl, (newUrl) => {
    const link = resultEl.querySelector("a[data-download-url]");
    if (link) { link.href = newUrl; link.setAttribute("data-download-url", newUrl); }
  });
}
document.getElementById("imageToolsRunBtn")?.addEventListener("click", async () => {
  const tool = document.getElementById("imageToolSelect").value;
  const fileInput = document.getElementById("imageToolsInput");
  const existingChain = state.imageHistory[IMAGE_TOOLS_CHAIN_ID];
  if (!fileInput.files[0] && !existingChain) return alert("Choose an image first.");
  const resultEl = document.getElementById("imageToolsResult");
  const btn = document.getElementById("imageToolsRunBtn");
  // A fresh file here means this run pairs with the tools/suggest check
  // that just ran on it — reuse that pending run_id so they share one
  // run. Continuing an existing chain (no new file) still gets its own
  // fresh run_id per step, same as before.
  const isFreshFile = !!fileInput.files[0];
  const runId = isFreshFile ? (state.pendingToolsRunId || crypto.randomUUID()) : crypto.randomUUID();
  if (isFreshFile) state.pendingToolsRunId = null;
  btn.disabled = true;
  toggleStatusView(true, `Running ${document.getElementById("imageToolSelect").selectedOptions[0].textContent}...`);
  startProgressPolling(runId);
  try {
    let imageBase64;
    if (fileInput.files[0]) {
      // A new file was chosen — starts a fresh chain, replacing any
      // previous one even if it existed.
      imageBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(fileInput.files[0]);
      });
      delete state.imageHistory[IMAGE_TOOLS_CHAIN_ID];
      pushImageVersion(IMAGE_TOOLS_CHAIN_ID, imageBase64); // step 0 — the original upload
    } else {
      // No new file — continue from whichever version is CURRENTLY shown
      // in the carousel, so stepping back to an earlier result and
      // running a different tool from there genuinely branches off it,
      // not silently always the latest.
      const h = state.imageHistory[IMAGE_TOOLS_CHAIN_ID];
      imageBase64 = h.versions[h.index];
    }
    const options = {};
    if (tool === "extend") options.direction = document.getElementById("imageToolExtendDirection").value;
    if (tool === "upscale") options.scale = parseInt(document.getElementById("imageToolUpscaleScale").value);
    document.querySelectorAll("#imageToolExtraParams [data-extra-param]").forEach((slider) => {
      options[slider.getAttribute("data-extra-param")] = parseFloat(slider.value);
    });
    const modelId = document.getElementById("imageToolModelSelect")?.value || "";
    const { res, data } = await fetchJson("/api/tools/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, tool, modelId, imageBase64, options, userApiKey: getUserKey() }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Tool failed.");
    pushImageVersion(IMAGE_TOOLS_CHAIN_ID, data.image);
    renderImageToolsResult();
    fileInput.value = ""; // clear so the next run defaults to continuing the chain, not re-uploading
    logActivity("success", `Image Tools: ${tool} completed (step ${state.imageHistory[IMAGE_TOOLS_CHAIN_ID].versions.length} in this chain).`);
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Image Tools: ${tool} failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
    updateImageToolsChainUI();
  }
});
document.getElementById("imageToolsModal")?.addEventListener("show.bs.modal", updateImageToolsChainUI);

// ============================================================
// VOICE STUDIO — first piece of the movie pipeline (voice → talking
// avatars → script breakdown → full assembly, as scoped with the user).
// Standalone tool: text in, real speech out. Reuses the same blob-
// download mechanism, activity logging, and progress-polling patterns
// already proven throughout the rest of this app rather than inventing
// new ones for the sake of being a "new" feature.
// ============================================================
function updateVoiceStudioModelOptions() {
  const selectEl = document.getElementById("voiceStudioModelSelect");
  const hintEl = document.getElementById("voiceStudioModelHint");
  const voiceIdSelect = document.getElementById("voiceStudioVoiceId");
  const voiceIdFreeform = document.getElementById("voiceStudioVoiceIdFreeform");
  const voiceDescriptionEl = document.getElementById("voiceStudioVoiceDescription");
  const languageSelect = document.getElementById("voiceStudioLanguage");
  const languageHintEl = document.getElementById("voiceStudioLanguageHint");
  if (!selectEl) return;
  const models = state.voiceModels || [];
  const CUSTOM_VOICE_VALUE = "__custom_voice__";
  // Real models first, then the same "Custom model ID..." escape hatch
  // already used for image/video — the huge Fal audio catalog shared
  // tonight can't all be individually verified, but this makes every
  // model in it genuinely usable without guessing at its schema, since
  // the preview button lets it be tested before committing.
  selectEl.innerHTML = models.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}${m.costPer1kChars ? ` — $${m.costPer1kChars}/1K chars` : ""}</option>`).join("")
    + `<option value="${CUSTOM_MODEL_VALUE}" class="advanced-only">Custom model ID...</option>`;
  const getCurrentModelId = () => readModelSelectEl(selectEl);
  const updateVoiceDescription = () => {
    const model = models.find((m) => m.id === getCurrentModelId());
    document.getElementById("voiceStudioPreviewPlayer")?.classList.add("d-none");
    if (voiceIdSelect.value === CUSTOM_VOICE_VALUE) {
      voiceIdFreeform.classList.remove("d-none");
      voiceIdFreeform.value = "";
      voiceIdFreeform.placeholder = "Paste a voice name from the library link below";
      voiceDescriptionEl.innerHTML = model?.voiceListUrl ? `<a href="${model.voiceListUrl}" target="_blank" rel="noopener">Browse the full voice library here</a>` : "";
      return;
    }
    voiceIdFreeform.classList.add("d-none");
    const chosen = (model?.confirmedVoiceIds || []).find((v) => v.id === voiceIdSelect.value);
    const savedVoice = (state.customVoices || []).find((v) => v.custom_voice_id === voiceIdSelect.value);
    const verification = (state.voiceVerificationDetails || []).find((d) => d.modelId === model?.id && d.voiceId === voiceIdSelect.value);
    const verificationNote = verification?.working === true
      ? ` (✅ confirmed working as of ${new Date(verification.checkedAt).toLocaleDateString()})`
      : " (❓ not yet checked — hit Preview to test it for real)";
    const replacementNote = chosen?.replacedBy ? ` Real replacement available whenever you want it: "${chosen.replacedBy}".` : "";
    voiceDescriptionEl.textContent = chosen?.description
      ? `🗣️ ${chosen.description}${verificationNote}${replacementNote}`
      : savedVoice
        ? `🎤 Your custom voice, cloned ${new Date(savedVoice.created_at + "Z").toLocaleDateString()}`
        : "";
  };
  const updateHint = () => {
    const modelId = getCurrentModelId();
    const model = models.find((m) => m.id === modelId);
    const isCustomModel = selectEl.value === CUSTOM_MODEL_VALUE;
    hintEl.textContent = model?.bestFor ? `💡 Best for: ${model.bestFor}` : isCustomModel ? "Untested — verify with the preview button before generating real content." : "";
    const isPureFreeform = model?.voiceInputMode === "freeform";
    const hasCustomOption = model?.voiceInputMode === "dropdown-with-custom";
    voiceIdSelect.classList.toggle("d-none", isPureFreeform || isCustomModel);
    voiceIdFreeform.classList.toggle("d-none", !(isPureFreeform || isCustomModel));
    if (isCustomModel) {
      voiceIdFreeform.value = "";
      voiceIdFreeform.placeholder = "Voice name/ID (optional — leave blank if this model doesn't need one)";
      voiceDescriptionEl.textContent = "";
    } else if (isPureFreeform) {
      const confirmed = model?.confirmedVoiceIds?.[0];
      voiceIdFreeform.value = confirmed?.id || "";
      voiceIdFreeform.placeholder = confirmed?.id || "voice name";
      voiceDescriptionEl.innerHTML = `${model?.voiceInputHint || ""} ${model?.voiceListUrl ? `<a href="${model.voiceListUrl}" target="_blank" rel="noopener">Browse real previews here</a>` : ""}`;
    } else {
      // Saved custom (cloned) voices that share this model's family show
      // up right alongside the built-in presets — a voice someone
      // actually recorded is just as real a choice as a preset name.
      const matchingCustomVoices = (state.customVoices || []).filter((v) => v.model_family === model?.modelFamily);
      const customVoicesHtml = matchingCustomVoices.map((v) => `<option value="${v.custom_voice_id}">🎤 ${escapeHtml(v.name)}</option>`).join("");
      // Real, live status per voice — actually checked against the real
      // API by this app's own verification system, shown BEFORE preview
      // so there's real information to decide with, not just a name.
      // ✅ = confirmed working by a real check; ❓ = not checked yet
      // (neither confirmed working nor failing); a confirmed failure
      // never reaches here at all, since getVerifiedVoiceModels() already
      // filters those out upstream.
      const optionsHtml = (model?.confirmedVoiceIds || []).map((v) => {
        const verification = (state.voiceVerificationDetails || []).find((d) => d.modelId === model.id && d.voiceId === v.id);
        const statusIcon = verification?.working === true ? "✅" : "❓";
        return `<option value="${v.id}">${statusIcon} ${v.id.replace(/_/g, " ")}${v.description ? ` — ${v.description}` : ""}</option>`;
      }).join("");
      voiceIdSelect.innerHTML = customVoicesHtml + optionsHtml + (hasCustomOption ? `<option value="${CUSTOM_VOICE_VALUE}">Custom voice...</option>` : "");
      updateVoiceDescription();
      // Model-level note (e.g. ElevenLabs' whole Default category
      // retiring together) — stated once here, not repeated on every
      // single voice option, which the previous version did and made
      // the list feel more like a countdown than a usable catalog.
      const categoryNoteEl = document.getElementById("voiceStudioCategoryNote");
      if (categoryNoteEl) {
        categoryNoteEl.textContent = model?.voiceCategoryNote?.text || "";
        categoryNoteEl.classList.toggle("d-none", !model?.voiceCategoryNote);
      }
      // Honest, visible explanation — not a silent absence. A cloned
      // voice is tied to the specific vendor that created it (MiniMax's
      // custom_voice_id means nothing to ElevenLabs, the same way a
      // Gmail password can't log into Outlook), so it genuinely can't
      // appear here, and pretending otherwise would just be another
      // "voice not found" error waiting to happen.
      const hasOtherFamilyVoices = (state.customVoices || []).length > 0 && matchingCustomVoices.length === 0;
      const missingVoiceHint = document.getElementById("voiceStudioMissingCustomVoiceHint");
      if (missingVoiceHint) {
        missingVoiceHint.innerHTML = hasOtherFamilyVoices
          ? `⚠️ Your cloned voice(s) (e.g. "${escapeHtml(state.customVoices[0].name)}") only work through MiniMax — they can't appear here, since ElevenLabs has no way to recognize a voice ID MiniMax created. For your own voice speaking Telugu/Tamil/etc., switch to MiniMax above and use the Translate toggle together with your cloned voice — quality isn't confirmed the way ElevenLabs' presets are, but it's the only path that's actually your own voice.`
          : "";
        missingVoiceHint.classList.toggle("d-none", !hasOtherFamilyVoices);
      }
    }
    languageSelect.innerHTML = (model?.confirmedLanguages || ["auto"]).map((l) => `<option value="${l}">${l === "auto" ? "Auto-detect" : l}</option>`).join("");
    // Honest, visible scope note — genuinely different for each model
    // now that Gemini TTS has real broad Indian-language support, not
    // just Hindi like MiniMax. Flexible match (startsWith, not exact
    // equality) since Gemini TTS uses "Hindi (India)" while MiniMax
    // uses plain "Hindi" — an exact-string check would silently miss it.
    const langs = model?.confirmedLanguages || [];
    const hasBroadIndianSupport = ["Telugu", "Tamil", "Kannada"].some((lang) => langs.some((l) => l.startsWith(lang)));
    const hasOnlyHindi = !hasBroadIndianSupport && langs.some((l) => l.startsWith("Hindi"));
    languageHintEl.innerHTML = hasBroadIndianSupport
      ? `(Genuinely confirmed: Telugu, Tamil, Kannada, and more Indian languages — this model has real, direct language selection, not just script auto-detection)`
      : hasOnlyHindi
        ? `(Hindi confirmed; Telugu/Tamil/Kannada/Malayalam/Bengali/Marathi aren't in this model's confirmed language list — try ElevenLabs or Gemini TTS above for those)`
        : "";
    document.getElementById("voiceStudioLanguageRow").classList.toggle("d-none", !model?.confirmedLanguages);
    document.getElementById("voiceStudioEmotionPitchRow").classList.toggle("d-none", !model?.supportsEmotionPitchSpeed);
    // Real, proactive fix for the exact "*confident* -> nothing" bug —
    // shown BEFORE generation, using each model's own real, honest
    // markupHint (see fal-models.js) instead of one generic static line
    // that was the same regardless of which model actually supports what.
    const markupHintEl = document.getElementById("voiceStudioMarkupHint");
    if (markupHintEl) markupHintEl.textContent = model?.markupHint || "Use *text* for stage directions.";
    if (model?.autoDetectsLanguageFromText) {
      hintEl.textContent += (hintEl.textContent ? " " : "") + "🌐 Auto-detects the language directly from the text you type — write in Telugu/Tamil/etc. script directly, or use the translate toggle above.";
    }
    updateVoiceStudioCostEstimate();
    updateVoiceStudioLanguageSuggestion();
  };
  voiceIdSelect.onchange = updateVoiceDescription;
  selectEl.onchange = updateHint;
  updateHint();
}
function updateVoiceStudioCostEstimate() {
  const el = document.getElementById("voiceStudioCostEstimate");
  const text = document.getElementById("voiceStudioText")?.value || "";
  const model = (state.voiceModels || []).find((m) => m.id === document.getElementById("voiceStudioModelSelect")?.value);
  if (!el || !model?.costPer1kChars || !text.trim()) {
    if (el) el.textContent = "";
    return;
  }
  const cost = (text.trim().length / 1000) * model.costPer1kChars;
  el.textContent = `${text.trim().length} character(s) — est. $${cost.toFixed(4)}`;
}
// Real Unicode block detection for major Indian scripts — reliable,
// instant, no API call needed. Confirmed language_boost coverage for
// fal-ai/minimax/speech-02-hd is Hindi only among these; ElevenLabs
// Eleven v3 has confirmed real support for all of them. This is what
// actually closes the gap the user pointed out: the right model already
// existed, nothing was steering anyone toward it.
const INDIAN_SCRIPT_RANGES = [
  { name: "Telugu", regex: /[\u0C00-\u0C7F]/ },
  { name: "Tamil", regex: /[\u0B80-\u0BFF]/ },
  { name: "Kannada", regex: /[\u0C80-\u0CFF]/ },
  { name: "Malayalam", regex: /[\u0D00-\u0D7F]/ },
  { name: "Bengali", regex: /[\u0980-\u09FF]/ },
  { name: "Gujarati", regex: /[\u0A80-\u0AFF]/ },
  { name: "Punjabi", regex: /[\u0A00-\u0A7F]/ },
  { name: "Odia", regex: /[\u0B00-\u0B7F]/ },
  { name: "Hindi/Marathi", regex: /[\u0900-\u097F]/ },
];
function detectIndianScript(text) {
  return INDIAN_SCRIPT_RANGES.find((r) => r.regex.test(text)) || null;
}
// Maps the translate-target dropdown's language names to the same
// detection-name space used for script detection, so both paths (typing
// Telugu directly, or typing English with "translate to Telugu" on)
// trigger the identical suggestion logic.
const TRANSLATE_TARGET_TO_INDIAN_LANG = {
  Hindi: "Hindi/Marathi", Marathi: "Hindi/Marathi", Telugu: "Telugu", Tamil: "Tamil",
  Kannada: "Kannada", Malayalam: "Malayalam", Bengali: "Bengali", Gujarati: "Gujarati",
  Punjabi: "Punjabi", Odia: "Odia",
};
function updateVoiceStudioLanguageSuggestion() {
  const suggestionEl = document.getElementById("voiceStudioLanguageSuggestion");
  if (!suggestionEl) return;
  const currentModelId = readModelSelectEl(document.getElementById("voiceStudioModelSelect"));
  const currentModel = (state.voiceModels || []).find((m) => m.id === currentModelId);
  // Two genuinely different ways this can be detected: the raw text
  // typed is already in an Indian script, OR the translate toggle is on
  // and its target is an Indian language — the actual gap that was
  // missed before, since translated text doesn't exist yet at typing
  // time, only after generation.
  const rawText = document.getElementById("voiceStudioText")?.value || "";
  const scriptDetected = detectIndianScript(rawText);
  const translateOn = document.getElementById("voiceStudioTranslateToggle")?.checked;
  const translateTarget = translateOn ? document.getElementById("voiceStudioTranslateTarget")?.value : null;
  const translateDetectedName = translateTarget ? TRANSLATE_TARGET_TO_INDIAN_LANG[translateTarget] : null;
  const detectedName = translateDetectedName || scriptDetected?.name;
  const viaTranslation = !!translateDetectedName;
  if (!detectedName) {
    suggestionEl.classList.add("d-none");
    return;
  }
  // Hindi is the one language MiniMax actually confirms — no need to
  // suggest switching away from it for that specific case. Flexible
  // match since Gemini TTS uses "Hindi (India)" while MiniMax uses
  // plain "Hindi" — an exact-string check would silently miss one of them.
  const minimaxConfirmsThis = detectedName === "Hindi/Marathi" && currentModel?.confirmedLanguages?.some((l) => l.startsWith("Hindi"));
  const BROAD_INDIAN_LANGUAGE_MODELS = ["fal-ai/elevenlabs/tts/eleven-v3", "fal-ai/gemini-tts"];
  if (minimaxConfirmsThis || BROAD_INDIAN_LANGUAGE_MODELS.includes(currentModelId)) {
    suggestionEl.classList.add("d-none");
    return;
  }
  const displayName = translateTarget || detectedName;
  const usingCustomVoice = !document.getElementById("voiceStudioVoiceIdFreeform")?.classList.contains("d-none")
    ? false
    : (state.customVoices || []).some((v) => v.custom_voice_id === document.getElementById("voiceStudioVoiceId")?.value);
  suggestionEl.innerHTML = `🇮🇳 ${viaTranslation ? `You're translating to ${displayName}` : `This looks like ${displayName}`} — ${currentModel?.label || "the current model"} doesn't confirm support for it. ElevenLabs Eleven v3 or Gemini TTS both have confirmed real ${displayName} support.
    <button type="button" class="btn btn-sm btn-outline-dark ms-1 py-0" data-switch-model="fal-ai/elevenlabs/tts/eleven-v3">Switch to ElevenLabs</button>
    <button type="button" class="btn btn-sm btn-outline-dark ms-1 py-0" data-switch-model="fal-ai/gemini-tts">Switch to Gemini TTS</button>
    ${usingCustomVoice ? `<div class="xx-small mt-1">⚠️ Your cloned voice only works through MiniMax — switching means using a preset voice instead, not your cloned one.</div>` : ""}`;
  suggestionEl.classList.remove("d-none");
  suggestionEl.querySelectorAll("[data-switch-model]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const selectEl = document.getElementById("voiceStudioModelSelect");
      selectEl.value = btn.getAttribute("data-switch-model");
      selectEl.dispatchEvent(new Event("change"));
      suggestionEl.classList.add("d-none");
    });
  });
}
document.getElementById("voiceStudioText")?.addEventListener("input", updateVoiceStudioCostEstimate);
document.getElementById("voiceStudioText")?.addEventListener("input", updateVoiceStudioLanguageSuggestion);
document.getElementById("voiceStudioTranslateToggle")?.addEventListener("change", updateVoiceStudioLanguageSuggestion);
document.getElementById("voiceStudioTranslateTarget")?.addEventListener("change", updateVoiceStudioLanguageSuggestion);
document.getElementById("voiceStudioVoiceIdFreeform")?.addEventListener("input", (e) => {
  document.getElementById("voiceStudioPreviewPlayer")?.classList.add("d-none");
  // Catches exactly the real failure seen in production: typing a saved
  // custom voice's NAME (e.g. "vemuri") into a different model's custom
  // voice field. That name only exists on MiniMax — no other vendor can
  // recognize it, so this stops the wasted attempt (and its real,
  // billed translation step) before it ever reaches the server.
  const typed = e.target.value.trim().toLowerCase();
  const matchingSavedVoice = (state.customVoices || []).find((v) => v.name.toLowerCase() === typed);
  const currentModelId = readModelSelectEl(document.getElementById("voiceStudioModelSelect"));
  const currentModel = (state.voiceModels || []).find((m) => m.id === currentModelId);
  const voiceDescriptionEl = document.getElementById("voiceStudioVoiceDescription");
  if (matchingSavedVoice && matchingSavedVoice.model_family !== currentModel?.modelFamily) {
    voiceDescriptionEl.innerHTML = `⚠️ "${escapeHtml(matchingSavedVoice.name)}" is a voice you cloned through MiniMax — it only exists there. ${currentModel?.label || "This model"} has no way to recognize it and this will fail. Switch to MiniMax above to actually use it.`;
  }
});
document.getElementById("voiceStudioTranslateToggle")?.addEventListener("change", (e) => {
  document.getElementById("voiceStudioTranslateRow").classList.toggle("d-none", !e.target.checked);
  if (!e.target.checked) document.getElementById("voiceStudioPreparedRow").classList.add("d-none");
});
document.getElementById("voiceStudioMultilingualToggle")?.addEventListener("change", (e) => {
  document.getElementById("voiceStudioMultilingualSection")?.classList.toggle("d-none", !e.target.checked);
  // Mutually exclusive with the single-language mode above — they're
  // genuinely different workflows (whole-script translation vs.
  // per-segment code-switching), not meant to run together.
  if (e.target.checked) {
    document.getElementById("voiceStudioTranslateToggle").checked = false;
    document.getElementById("voiceStudioTranslateRow")?.classList.add("d-none");
    document.getElementById("voiceStudioMultilingualScript").value = document.getElementById("voiceStudioText")?.value || "";
  }
});
document.getElementById("voiceStudioAutoTagBtn")?.addEventListener("click", async () => {
  const script = document.getElementById("voiceStudioMultilingualScript")?.value?.trim();
  const instruction = document.getElementById("voiceStudioAutoTagInstruction")?.value?.trim();
  if (!script) return alert("Add your script first.");
  if (!instruction) return alert("Describe which parts should be in which language.");
  const btn = document.getElementById("voiceStudioAutoTagBtn");
  const statusEl = document.getElementById("voiceStudioAutoTagStatus");
  btn.disabled = true;
  statusEl.textContent = "Tagging...";
  try {
    const { res, data } = await fetchJson("/api/voice/auto-tag-languages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script, instruction, textModel: getTextModel(), userApiKey: getUserKey(), runId: state.voiceStudioRunId }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Auto-tagging failed.");
    document.getElementById("voiceStudioMultilingualScript").value = data.taggedScript;
    statusEl.textContent = "Tagged — review the [Language] tags below before generating, edit freely.";
    logActivity("success", "Script auto-tagged for multi-language narration.");
  } catch (err) {
    statusEl.textContent = "Failed: " + err.message;
    logActivity("warning", `Auto-tagging failed — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("voiceStudioGenerateMultilingualBtn")?.addEventListener("click", async () => {
  const text = document.getElementById("voiceStudioMultilingualScript")?.value?.trim();
  if (!text) return alert("Add your tagged script first.");
  const btn = document.getElementById("voiceStudioGenerateMultilingualBtn");
  const statusEl = document.getElementById("voiceStudioMultilingualStatus");
  btn.disabled = true;
  statusEl.textContent = "Generating each segment and merging into one file — this can take a minute...";
  try {
    const { res, data } = await fetchJson("/api/voice/generate-multilingual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        modelId: readModelSelectEl(document.getElementById("voiceStudioModelSelect")),
        voiceId: readModelSelectEl(document.getElementById("voiceStudioVoiceId")) || document.getElementById("voiceStudioVoiceIdFreeform")?.value,
        baseLanguage: document.getElementById("voiceStudioMultilingualBase")?.value,
        textModel: getTextModel(), userApiKey: getUserKey(), runId: state.voiceStudioRunId,
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Generation failed.");
    state.voiceStudioVersions = state.voiceStudioVersions || [];
    state.voiceStudioVersions.unshift({
      audio: data.audio, modelUsed: `${data.modelUsed} (multi-language, ${data.segments.length} segments)`, ts: Date.now(),
      finalSpokenText: data.segments.map((s) => `[${s.language}] ${s.finalText}`).join("\n"),
    });
    renderVoiceStudioResults(text);
    statusEl.textContent = `Done — ${data.segments.length} segments generated and merged.`;
    logActivity("success", `Multi-language audio generated (${data.segments.length} segments).`);
  } catch (err) {
    statusEl.textContent = "Failed: " + err.message;
    logActivity("warning", `Multi-language generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
async function runVoiceTextPreparation() {
  const text = document.getElementById("voiceStudioText")?.value?.trim();
  if (!text) return alert("Type something to prepare first.");
  const targetLanguage = document.getElementById("voiceStudioTranslateTarget")?.value;
  const btn = document.getElementById("voiceStudioPrepareBtn");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Preparing...";
  try {
    const { res, data } = await fetchJson("/api/voice/prepare-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLanguage, textModel: getTextModel(), userApiKey: getUserKey(), runId: state.voiceStudioRunId }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Preparation failed.");
    document.getElementById("voiceStudioPreparedText").value = data.preparedText;
    document.getElementById("voiceStudioPreparedRow").classList.remove("d-none");
    if (data.scriptValidationFailed) {
      alert(`Heads up: even after retrying, this didn't come back in real ${targetLanguage} script — it may still be in English. Please check the prepared text below and edit it manually if needed before generating.`);
      logActivity("warning", `Prepare-text couldn't produce real ${targetLanguage} script even after a retry — check the result manually.`);
    } else if (data.transliterationDetected) {
      alert(`Heads up: this came back as English words spelled out in ${targetLanguage} script (transliteration) rather than real ${targetLanguage} translation, even after retrying. Please review the prepared text below carefully — it may need manual correction before generating.`);
      logActivity("warning", `Prepare-text produced transliteration instead of real ${targetLanguage} translation — check the result manually.`);
    } else {
      logActivity("info", `Prepared text for ${targetLanguage} — review and edit it before generating.`);
    }
  } catch (err) {
    alert("Couldn't prepare the text: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
document.getElementById("voiceStudioPrepareBtn")?.addEventListener("click", runVoiceTextPreparation);
document.getElementById("voiceStudioReprepareBtn")?.addEventListener("click", runVoiceTextPreparation);
// Cache keyed by "modelId:voiceId" — a voice previewed once this session
// is never regenerated (and never re-charged) if previewed again.
state.voicePreviewCache = state.voicePreviewCache || {};
// One shared run_id for this Voice Studio session, minted fresh every
// time the modal opens — reused across prepare-text/auto-tag/generate
// calls made while it's open, so "cost of this voiceover" is one real,
// joinable number instead of several disconnected ledger rows.
document.getElementById("audioModeRow")?.addEventListener("show.bs.modal", () => {
  state.voiceStudioRunId = crypto.randomUUID();
});
document.getElementById("audioModeRow")?.addEventListener("show.bs.modal", async () => {
  const userKey = getUserKey();
  if (!userKey) return; // nothing to verify against without a key — the manual recheck button still explains this if they try it directly
  const statusEl = document.getElementById("voiceStudioRecheckStatus");
  try {
    const { data: startData } = await fetchJson("/api/voice/verify-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userApiKey: userKey }), // no forceRecheck — cheap, only does real work on stale/unchecked entries
    });
    if (!startData?.status?.isVerifying && startData?.status?.totalChecked > 0) return; // already fresh, nothing to wait on
    if (statusEl) statusEl.textContent = "Confirming which voices actually work right now...";
    let status;
    do {
      await new Promise((r) => setTimeout(r, 2000));
      const { data } = await fetchJson("/api/voice/catalog-status");
      status = data;
    } while (status.isVerifying);
    await loadModelRegistry(); // real, fresh results now reflected in the dropdown automatically, no click required
    updateVoiceStudioModelOptions();
    if (statusEl) statusEl.textContent = "";
  } catch {
    // Silent — this is a proactive background check, not a user-initiated
    // action; a failure here shouldn't interrupt anyone, the manual
    // recheck button remains available as a fallback.
  }
});
document.getElementById("voiceStudioRecheckBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("voiceStudioRecheckBtn");
  const statusEl = document.getElementById("voiceStudioRecheckStatus");
  const userKey = getUserKey();
  if (!userKey) return alert("Add your Fal API key first.");
  btn.disabled = true;
  statusEl.textContent = "Starting a fresh check — this clears the previous results and re-tests every voice for real...";
  try {
    await fetchJson("/api/voice/verify-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userApiKey: userKey, forceRecheck: true }),
    });
    // Poll real status rather than guessing how long this takes — the
    // actual number of voices and any rate-limit pauses both affect
    // duration, so a fixed wait would either finish too early or make
    // people wait longer than necessary.
    let status;
    do {
      await new Promise((r) => setTimeout(r, 2000));
      const { data } = await fetchJson("/api/voice/catalog-status");
      status = data;
      statusEl.textContent = `Checking... ${status.totalChecked} voice(s) verified so far (${status.workingCount} working, ${status.failedCount} genuinely broken).`;
    } while (status.isVerifying);
    // Clear the client-side preview cache too — a stale cached preview
    // for a voice whose status just changed would otherwise keep
    // playing old audio instead of reflecting the real, current result.
    state.voicePreviewCache = {};
    await loadModelRegistry(); // pulls the freshly-filtered voice list so the dropdown actually reflects what just got checked
    statusEl.textContent = `Done — ${status.workingCount} voice(s) confirmed working, ${status.failedCount} genuinely not found and hidden.`;
    logActivity("success", `Voice re-check complete: ${status.workingCount} working, ${status.failedCount} hidden.`);
  } catch (err) {
    statusEl.textContent = "Re-check failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("voiceStudioPreviewBtn")?.addEventListener("click", async () => {
  const modelId = readModelSelectEl(document.getElementById("voiceStudioModelSelect"));
  const freeformVisible = !document.getElementById("voiceStudioVoiceIdFreeform")?.classList.contains("d-none");
  const voiceId = freeformVisible
    ? document.getElementById("voiceStudioVoiceIdFreeform")?.value?.trim()
    : document.getElementById("voiceStudioVoiceId")?.value;
  if (!voiceId) return alert("Pick or type a voice first.");
  const cacheKey = `${modelId}:${voiceId}`;
  const btn = document.getElementById("voiceStudioPreviewBtn");
  const player = document.getElementById("voiceStudioPreviewPlayer");
  if (state.voicePreviewCache[cacheKey]) {
    // Already generated this session — just play it again, no new
    // charge, no new API call.
    player.src = state.voicePreviewCache[cacheKey];
    player.classList.remove("d-none");
    player.play();
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Generating...";
  try {
    const { res, data } = await fetchJson("/api/voice/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: crypto.randomUUID(),
        // Deliberately short and fixed — this is a preview, not the
        // actual content, so it should cost as little as realistically
        // possible while still giving a genuine sense of the voice.
        text: "Hello, this is a short preview of this voice.",
        isPreview: true,
        modelId,
        voiceId,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Preview failed.");
    state.voicePreviewCache[cacheKey] = data.audio;
    player.src = data.audio;
    player.classList.remove("d-none");
    player.play();
    logActivity("info", `Previewed voice "${voiceId}" — cached, won't be re-charged if previewed again this session.`);
  } catch (err) {
    alert("Couldn't generate a preview: " + err.message);
    if (/voice not found|isn't recognized/i.test(err.message)) {
      // Real, proven failure — remove it from this session's dropdown
      // immediately rather than leaving it there to fail again on the
      // next attempt. The server has already recorded this too, so
      // future page loads won't offer it either.
      const currentModel = (state.voiceModels || []).find((m) => m.id === modelId);
      if (currentModel?.confirmedVoiceIds) {
        currentModel.confirmedVoiceIds = currentModel.confirmedVoiceIds.filter((v) => v.id !== voiceId);
        updateVoiceStudioModelOptions();
        logActivity("warning", `"${voiceId}" removed from the picker — confirmed not working.`);
      }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});
// ============================================================
// VOICE CLONING — record (or upload) a real sample, clone it, and it
// becomes selectable in the main voice picker above. Uses the browser's
// native MediaRecorder — no new library needed.
// ============================================================
state.voiceCloneRecorder = null;
state.voiceCloneAudioBase64 = null;
// Fal's clone endpoint only accepts .wav or .mp3 — confirmed directly
// from a real "unsupported_audio_format" error. Browsers record via
// MediaRecorder as webm/ogg by default, never wav, and uploaded files
// could be almost anything — so this decodes whatever comes in through
// the Web Audio API and re-encodes it as a real WAV file, standard PCM
// encoding, no external library needed. Applied to both the recording
// and upload paths, not just one, since either could hand back a format
// this endpoint won't accept.
async function convertAudioBlobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const bitDepth = 16;
    // Interleave all channels into one sample stream, PCM's expected layout.
    const interleaved = new Float32Array(audioBuffer.length * numChannels);
    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < audioBuffer.length; i++) {
        interleaved[i * numChannels + channel] = channelData[i];
      }
    }
    const dataLength = interleaved.length * (bitDepth / 8);
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    writeString(36, "data");
    view.setUint32(40, dataLength, true);
    let offset = 44;
    for (let i = 0; i < interleaved.length; i++, offset += 2) {
      const sample = Math.max(-1, Math.min(1, interleaved[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    audioCtx.close();
  }
}
document.getElementById("voiceCloneRecordBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("voiceCloneRecordBtn");
  const statusEl = document.getElementById("voiceCloneStatus");
  if (state.voiceCloneRecorder?.state === "recording") {
    state.voiceCloneRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    state.voiceCloneRecorder = recorder;
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      statusEl.textContent = "Converting to a format the cloning model accepts...";
      try {
        const wavBlob = await convertAudioBlobToWav(blob);
        const reader = new FileReader();
        reader.onload = (e) => {
          state.voiceCloneAudioBase64 = e.target.result;
          const player = document.getElementById("voiceCloneRecordedPlayer");
          player.src = state.voiceCloneAudioBase64;
          player.classList.remove("d-none");
          document.getElementById("voiceCloneSubmitBtn").disabled = false;
          statusEl.textContent = "Recording captured — listen back above, then clone when ready.";
        };
        reader.readAsDataURL(wavBlob);
      } catch (convErr) {
        statusEl.textContent = "Couldn't process the recording: " + convErr.message + " — try again or use Upload instead.";
      }
      btn.textContent = "🔴 Record";
      btn.classList.remove("btn-danger");
      btn.classList.add("btn-outline-danger");
    };
    recorder.start();
    btn.textContent = "⏹️ Stop";
    btn.classList.remove("btn-outline-danger");
    btn.classList.add("btn-danger");
    statusEl.textContent = "Recording... read the text above naturally, then click Stop.";
  } catch (err) {
    alert("Couldn't access the microphone: " + err.message + " — check your browser's microphone permission, or use Upload instead.");
  }
});
document.getElementById("voiceCloneUpload")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("voiceCloneStatus");
  statusEl.textContent = "Converting to a format the cloning model accepts...";
  try {
    const wavBlob = await convertAudioBlobToWav(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      state.voiceCloneAudioBase64 = ev.target.result;
      const player = document.getElementById("voiceCloneRecordedPlayer");
      player.src = state.voiceCloneAudioBase64;
      player.classList.remove("d-none");
      document.getElementById("voiceCloneSubmitBtn").disabled = false;
      statusEl.textContent = `Loaded "${file.name}" — listen back above, then clone when ready.`;
    };
    reader.readAsDataURL(wavBlob);
  } catch (convErr) {
    statusEl.textContent = `Couldn't process "${file.name}": ${convErr.message} — try a different file, ideally .wav or .mp3.`;
  }
});
function renderSavedCustomVoices() {
  const listEl = document.getElementById("voiceCloneSavedList");
  if (!listEl) return;
  const voices = state.customVoices || [];
  if (!voices.length) { listEl.innerHTML = ""; return; }
  listEl.innerHTML = `<p class="xx-small fw-semibold text-muted mb-1">Your saved voices</p>` + voices.map((v) => {
    const daysSinceUsed = Math.floor((Date.now() - new Date(v.last_used_at + "Z").getTime()) / 86400000);
    const nearExpiry = daysSinceUsed >= 5;
    return `<div class="d-flex justify-content-between align-items-center border rounded px-2 py-1 mb-1 small ${nearExpiry ? "border-warning" : ""}">
      <span>🎤 ${escapeHtml(v.name)} ${nearExpiry ? `<span class="text-warning">⚠️ not used in ${daysSinceUsed}d — use it soon or it'll be auto-deleted</span>` : ""}</span>
      <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" data-delete-custom-voice="${v.custom_voice_id}">✕</button>
    </div>`;
  }).join("");
  listEl.querySelectorAll("[data-delete-custom-voice]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delete-custom-voice");
      if (!confirm("Remove this voice from your saved list? (This only removes it from this app — MiniMax's own 7-day expiry still applies independently.)")) return;
      try {
        await fetchJson(`/api/voice/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.customVoices = state.customVoices.filter((v) => v.custom_voice_id !== id);
        renderSavedCustomVoices();
        updateVoiceStudioModelOptions();
        logActivity("info", "Removed a saved custom voice.");
      } catch (err) {
        alert("Couldn't remove it: " + err.message);
      }
    });
  });
}
document.getElementById("voiceCloneSubmitBtn")?.addEventListener("click", async () => {
  const name = document.getElementById("voiceCloneName")?.value?.trim();
  if (!name) return alert("Enter a name for this voice first.");
  if (!state.voiceCloneAudioBase64) return alert("Record or upload audio first.");
  const btn = document.getElementById("voiceCloneSubmitBtn");
  const resultEl = document.getElementById("voiceCloneResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, `Cloning "${name}"'s voice...`);
  startProgressPolling(runId);
  try {
    const { res, data } = await fetchJson("/api/voice/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        audioBase64: state.voiceCloneAudioBase64,
        name,
        previewText: document.getElementById("voiceCloneText")?.value?.trim(),
        languageNote: document.getElementById("voiceCloneLanguage")?.value?.trim(),
        generateEmotions: document.getElementById("voiceCloneEmotionsToggle")?.checked,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Voice cloning failed.");
    const emotionEmoji = { neutral: "😐", happy: "😄", sad: "😢", angry: "😠", fearful: "😨", disgusted: "🤢", surprised: "😲" };
    const emotionsHtml = (data.emotionSamples || []).length
      ? `<p class="xx-small fw-semibold text-muted mb-1 mt-2">The full range — ${escapeHtml(name)}, every emotion</p>
         <div class="row g-2 mb-2">
           ${data.emotionSamples.map((e) => e.audio ? `
             <div class="col-6">
               <div class="border rounded p-2 text-center">
                 <div class="small fw-semibold">${emotionEmoji[e.emotion] || ""} ${e.emotion}</div>
                 <audio controls class="w-100 mt-1" style="height: 32px;" src="${e.audio}"></audio>
               </div>
             </div>` : `
             <div class="col-6">
               <div class="border rounded p-2 text-center text-danger xx-small">${e.emotion} failed: ${escapeHtml(e.error || "unknown error")}</div>
             </div>`).join("")}
         </div>`
      : "";
    resultEl.innerHTML = `
      <div class="alert alert-success py-2 px-3 small mb-2">✅ "${escapeHtml(name)}" cloned successfully — now selectable in the voice picker above.</div>
      <audio controls class="w-100 mb-1" src="${data.previewAudio}"></audio>
      ${emotionsHtml}
      <p class="xx-small text-muted mb-0">${data.retentionWarning}</p>
    `;
    logActivity("success", `Voice "${name}" cloned successfully.`);
    // Refresh the full registry so the new custom voice shows up in the
    // picker immediately. loadModelRegistry() only updates the underlying
    // data — it does NOT re-render Voice Studio's dropdown on its own
    // (confirmed: it only re-renders Image Tools' dropdown), so that has
    // to be called explicitly too, or the new voice stays invisible until
    // the modal is closed and reopened.
    await loadModelRegistry();
    updateVoiceStudioModelOptions();
    renderSavedCustomVoices();
    // Reset the recording state for a fresh clone next time.
    state.voiceCloneAudioBase64 = null;
    document.getElementById("voiceCloneRecordedPlayer").classList.add("d-none");
    document.getElementById("voiceCloneName").value = "";
    btn.disabled = true;
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Voice cloning failed — ${err.message}`);
    btn.disabled = false;
  } finally {
    toggleStatusView(false);
  }
});
document.getElementById("audioModeRow")?.addEventListener("show.bs.modal", renderSavedCustomVoices);

// ============================================================
// SONG STUDIO
// ============================================================
// One shared run_id for this Song Studio session, minted fresh every
// time Audio Studio is entered — reused across write-lyrics and
// generate so "cost of this song" is one real number, not two
// disconnected rows. The Song section itself also mints a fresh one
// when switched to directly (see audioStudioSwitcher's change handler
// above) — this one covers arriving with the Song section already
// selected from a page reload or direct mode entry.
document.getElementById("audioModeRow")?.addEventListener("show.bs.modal", () => {
  state.songStudioRunId = crypto.randomUUID();
});
document.getElementById("songStylePrompt")?.addEventListener("input", (e) => {
  document.getElementById("songStyleCount").textContent = `${e.target.value.length} / 300`;
});
document.getElementById("songLyricsPrompt")?.addEventListener("input", (e) => {
  document.getElementById("songLyricsCount").textContent = `${e.target.value.length} / 3000`;
});
document.getElementById("songWriteLyricsBtn")?.addEventListener("click", async () => {
  const storyPrompt = document.getElementById("songStoryPrompt")?.value?.trim();
  if (!storyPrompt) return alert("Describe what the song should be about first.");
  const referenceNotes = document.getElementById("songReferenceNotes")?.value?.trim();
  const emotionalFeel = document.getElementById("songEmotionalFeel")?.value?.trim();
  const vocalStyle = document.getElementById("songVocalStyle")?.value?.trim();
  const lyricalGenre = document.getElementById("songLyricalGenre")?.value;
  const wantsVocals = document.getElementById("songWantsVocals")?.checked;
  const wantsOwnVoice = document.getElementById("songWantsOwnVoice")?.checked;
  const prioritize = document.getElementById("songPriority")?.value;
  const btn = document.getElementById("songWriteLyricsBtn");
  const statusEl = document.getElementById("songWriterStatus");
  const recBox = document.getElementById("songRecommendationBox");
  btn.disabled = true;
  recBox.classList.add("d-none");
  statusEl.textContent = "Writing lyrics and thinking through which model fits best...";
  try {
    const { res, data } = await fetchJson("/api/music/write-lyrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storyPrompt, referenceNotes, emotionalFeel, vocalStyle, lyricalGenre,
        wantsVocals, wantsOwnVoice, prioritize,
        lyricLanguageStyle: document.getElementById("songLyricLanguageStyle")?.value,
        textModel: getTextModel(), userApiKey: getUserKey(), runId: state.songStudioRunId,
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Couldn't write lyrics.");
    const lyricsEl = document.getElementById("songLyricsPrompt");
    const styleEl = document.getElementById("songStylePrompt");
    lyricsEl.value = (data.lyrics || "").slice(0, 3000);
    styleEl.value = (data.style || "").slice(0, 300);
    lyricsEl.dispatchEvent(new Event("input"));
    styleEl.dispatchEvent(new Event("input"));
    // Render the real recommendation — actual reasoning from the
    // "brain," with a genuine button that switches the model dropdown,
    // not just a suggestion left for the person to act on manually.
    if (data.recommendation) {
      const rec = data.recommendation;
      const model = (state.musicModels || []).find((m) => m.id === rec.modelId);
      recBox.innerHTML = `
        <div class="alert ${rec.languageGap ? "alert-warning" : "alert-success"} py-2 px-3 xx-small mb-0">
          <strong>Recommended: ${escapeHtml(model?.label || rec.modelId)}</strong>
          <div class="mt-1">${rec.reasons.map((r) => escapeHtml(r)).join(" ")}</div>
          <button type="button" class="btn btn-sm btn-dark mt-2" id="songUseRecommendedBtn">Use this model</button>
        </div>`;
      recBox.classList.remove("d-none");
      document.getElementById("songUseRecommendedBtn")?.addEventListener("click", () => {
        const targetSelect = wantsOwnVoice ? document.getElementById("songRefModelSelect") : document.getElementById("songLyricsModelSelect");
        if (!targetSelect) return;
        targetSelect.value = rec.modelId;
        targetSelect.dispatchEvent(new Event("change"));
        // The reference-voice section is a Bootstrap collapse — directly
        // toggling its CSS class (the previous approach) doesn't
        // reliably open it; this is the actual bug that made the button
        // look like it did nothing. The real Bootstrap Collapse API is
        // required to animate it open correctly.
        if (wantsOwnVoice) {
          const sectionEl = document.getElementById("songReferenceVoiceSection");
          if (sectionEl) bootstrap.Collapse.getOrCreateInstance(sectionEl, { toggle: false }).show();
        }
        // Make the change genuinely visible, not just technically
        // present in a dropdown the person may not be looking at —
        // scroll to it and briefly highlight it.
        targetSelect.scrollIntoView({ behavior: "smooth", block: "center" });
        targetSelect.classList.add("border", "border-success", "border-3");
        setTimeout(() => targetSelect.classList.remove("border", "border-success", "border-3"), 1500);
        logActivity("success", `Switched to ${model?.label || rec.modelId}.`);
      });
    }
    statusEl.textContent = "Lyrics and style filled in below — edit freely before generating.";
    logActivity("success", "Wrote song lyrics and got a model recommendation.");
  } catch (err) {
    statusEl.textContent = "Failed: " + err.message;
    logActivity("warning", `Lyric writing failed — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
state.songStudioVersions = [];
// ============================================================
// AUDIO LIBRARY (Phase 11) — real, working browse/save/favorite/delete
// for generated voice takes, songs, and SFX. saveToAudioLibrary is the
// shared function both Voice Studio and Song Studio call — one save
// path, not two parallel implementations.
// ============================================================
let audioLibraryFilter = "all";
async function saveToAudioLibrary({ type, name, audioDataUri, modelUsed, voiceUsed, language, runId, metadata, silent = false }) {
  try {
    const { res, data } = await fetchJson("/api/audio-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, name, audioDataUri, modelUsed, voiceUsed, language, runId, metadata }),
    });
    if (!res.ok) throw new Error(data.error || "Failed to save.");
    if (!silent) logActivity("success", `Saved "${name}" to your Audio Library.`);
    return true;
  } catch (err) {
    if (silent) logActivity("warning", `Couldn't auto-save "${name}" to your Audio Library — ${err.message}`);
    else alert("Couldn't save to Audio Library: " + err.message);
    return false;
  }
}
async function loadAudioLibrary() {
  const listEl = document.getElementById("audioLibraryList");
  if (!listEl) return;
  const sessionOnly = document.getElementById("audioLibrarySessionOnly")?.checked;
  listEl.innerHTML = `<div class="text-muted small">Loading...</div>`;
  try {
    const { res, data } = await fetchJson(`/api/audio-library${audioLibraryFilter !== "all" ? `?type=${audioLibraryFilter}` : ""}`);
    if (!res.ok) throw new Error(data.error || "Failed to load.");
    let items = data.items || [];
    if (sessionOnly) {
      items = items.filter((item) => new Date(item.createdAt.replace(" ", "T") + "Z").getTime() >= state.appSessionStartedAt);
    }
    if (!items.length) {
      listEl.innerHTML = sessionOnly
        ? `<p class="text-muted small mb-0">Nothing generated yet this session — everything you make in Voice Studio, Song Studio, or Sound Effects shows up here automatically.</p>`
        : `<p class="text-muted small mb-0">Nothing here yet — everything you generate in Voice Studio, Song Studio, or Sound Effects is saved here automatically.</p>`;
      return;
    }
    const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
    listEl.innerHTML = items.map((item) => `
      <div class="border rounded p-2 mb-2" data-audio-item-id="${item.id}">
        <div class="d-flex justify-content-between align-items-center">
          <span class="fw-semibold small">${typeIcon[item.type] || ""} ${escapeHtml(item.name)}</span>
          <div class="d-flex gap-1">
            <button type="button" class="btn btn-sm p-0 border-0" data-audio-item-action="favorite" title="${item.favorite ? "Remove favorite" : "Add favorite"}">${item.favorite ? "⭐" : "☆"}</button>
            <a href="${item.audio}" data-download-url="${item.audio}" data-download-filename="${escapeHtml(item.name).replace(/[^a-z0-9]+/gi, "-")}.mp3" class="btn btn-sm btn-outline-dark">⬇️</a>
            <button type="button" class="btn btn-sm btn-outline-danger" data-audio-item-action="delete" title="Delete">✕</button>
          </div>
        </div>
        <div class="xx-small text-muted">${item.modelUsed ? escapeHtml(item.modelUsed) : ""}${item.voiceUsed ? ` · ${escapeHtml(item.voiceUsed)}` : ""}${item.language ? ` · ${escapeHtml(item.language)}` : ""}</div>
        <audio controls class="w-100 mt-1" src="${item.audio}"></audio>
      </div>`).join("");
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("audioLibraryModal")?.addEventListener("show.bs.modal", loadAudioLibrary);
document.getElementById("audioLibrarySessionOnly")?.addEventListener("change", loadAudioLibrary);
document.querySelectorAll("[data-audio-library-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-audio-library-filter]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    audioLibraryFilter = btn.getAttribute("data-audio-library-filter");
    loadAudioLibrary();
  });
});
document.getElementById("audioLibraryList")?.addEventListener("click", async (e) => {
  const itemEl = e.target.closest("[data-audio-item-id]");
  const action = e.target.closest("[data-audio-item-action]")?.getAttribute("data-audio-item-action");
  if (!itemEl || !action) return;
  const id = itemEl.getAttribute("data-audio-item-id");
  if (action === "delete") {
    if (!confirm("Delete this from your Audio Library? This can't be undone.")) return;
    await fetchJson(`/api/audio-library/${id}`, { method: "DELETE" });
    loadAudioLibrary();
  } else if (action === "favorite") {
    await fetchJson(`/api/audio-library/${id}/favorite`, { method: "POST" });
    loadAudioLibrary();
  }
});

document.getElementById("songGenerateVariationsBtn")?.addEventListener("click", async () => {
  const style = document.getElementById("songStylePrompt")?.value?.trim();
  const lyrics = document.getElementById("songLyricsPrompt")?.value?.trim();
  const selectedModelId = readModelSelectEl(document.getElementById("songLyricsModelSelect"));
  const selectedModel = (state.musicModels || []).find((m) => m.id === selectedModelId);
  if (!style || style.length < 10) return alert("Style/mood description needs to be at least 10 characters.");
  if (!selectedModel?.instrumentalOnly && (!lyrics || lyrics.length < 10)) return alert("Lyrics need to be at least 10 characters — write your own, use the lyric writer above, or pick an instrumental-only model if you don't want vocals.");
  const btn = document.getElementById("songGenerateVariationsBtn");
  const resultEl = document.getElementById("songVariationsResult");
  const count = parseInt(document.getElementById("songVariationCount")?.value) || 3;
  const runId = state.songStudioRunId || crypto.randomUUID();
  state.songStudioRunId = runId;
  btn.disabled = true;
  resultEl.innerHTML = `<p class="text-muted small">Generating ${count} creative directions — this takes longer than one song, since each is a full real generation...</p>`;
  try {
    const { res, data } = await fetchJson("/api/music/generate-variations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        style, lyrics, modelId: selectedModelId, count, runId,
        durationSeconds: selectedModel?.supportsDuration ? parseInt(document.getElementById("songDurationSlider")?.value) : undefined,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Failed to generate creative directions.");
    resultEl.innerHTML = (data.results || []).map((v, i) => `
      <div class="border rounded p-2 mb-2" data-song-variation-index="${i}">
        <div class="d-flex justify-content-between align-items-center">
          <span class="fw-bold small">${escapeHtml(v.label)}</span>
          <div class="d-flex gap-1">
            ${v.audio ? `<a href="${v.audio}" data-download-url="${v.audio}" data-download-filename="song-${v.label.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}.mp3" class="btn btn-sm btn-outline-dark">⬇️</a>` : ""}
          </div>
        </div>
        ${v.reasoning ? `<div class="xx-small text-muted mb-1">${escapeHtml(v.reasoning)}</div>` : ""}
        ${v.error ? `<div class="xx-small text-danger">Failed: ${escapeHtml(v.error)}</div>` : v.audio ? `<audio controls class="w-100 mt-1" src="${v.audio}"></audio>${formatDurationNote(v.durationMs, v.requestedDurationSeconds)}` : ""}
      </div>`).join("") || `<p class="text-muted small">No results.</p>`;
    state.lastSongVariations = data.results || [];
    await Promise.all(
      (data.results || [])
        .filter((v) => v.audio && !v.error)
        .map((v) => saveToAudioLibrary({ type: "song", name: `Song — ${v.label}`, audioDataUri: v.audio, modelUsed: v.modelUsed, runId, metadata: { reasoning: v.reasoning, label: v.label }, silent: true })),
    );
    logActivity("success", `Generated ${data.results?.length || 0} creative direction(s) for your song.`);
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
    logActivity("warning", `Song variation generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("songGenerateBtn")?.addEventListener("click", async () => {
  const style = document.getElementById("songStylePrompt")?.value?.trim();
  const lyrics = document.getElementById("songLyricsPrompt")?.value?.trim();
  const selectedModelId = readModelSelectEl(document.getElementById("songLyricsModelSelect"));
  const selectedModel = (state.musicModels || []).find((m) => m.id === selectedModelId);
  if (!style || style.length < 10) return alert("Style/mood description needs to be at least 10 characters.");
  if (!selectedModel?.instrumentalOnly && (!lyrics || lyrics.length < 10)) return alert("Lyrics need to be at least 10 characters — write your own, use the lyric writer above, or pick an instrumental-only model if you don't want vocals.");
  const btn = document.getElementById("songGenerateBtn");
  const resultEl = document.getElementById("songStudioResult");
  const runId = state.songStudioRunId || crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Composing your song — this can take a minute or two...");
  startProgressPolling(runId);
  try {
    const { res, data } = await fetchJson("/api/music/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId, style, lyrics, modelId: selectedModelId,
        durationSeconds: selectedModel?.supportsDuration ? parseInt(document.getElementById("songDurationSlider")?.value) : undefined,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Song generation failed.");
    state.songStudioVersions.unshift({ audio: data.audio, ts: Date.now(), durationMs: data.durationMs, requestedDurationSeconds: data.requestedDurationSeconds });
    saveToAudioLibrary({ type: "song", name: `Song — ${style.slice(0, 40)}${style.length > 40 ? "..." : ""}`, audioDataUri: data.audio, modelUsed: data.modelUsed, runId, silent: true });
    resultEl.innerHTML = state.songStudioVersions.map((v, i) => `
      <div class="border rounded p-2 mb-2 ${i === 0 ? "border-primary" : ""}">
        ${i === 0 ? `<div class="xx-small fw-bold text-primary mb-1">Latest</div>` : `<div class="xx-small text-muted mb-1">Earlier version</div>`}
        <audio controls class="w-100 mb-2" src="${v.audio}"></audio>
        ${formatDurationNote(v.durationMs, v.requestedDurationSeconds)}
        <a href="${v.audio}" data-download-url="${v.audio}" data-download-filename="song-${v.ts}.mp3" class="btn btn-sm btn-dark fw-bold w-100 mt-1">⬇️ Download</a>
      </div>`).join("");
    logActivity("success", "Song generated.");
  } catch (err) {
    resultEl.innerHTML = state.songStudioVersions.length ? resultEl.innerHTML : `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Song generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
// ============================================================
// SONG STUDIO — reference-voice path (Seed Audio 1.0). Reuses the same
// proven WAV-conversion function already verified for voice cloning,
// rather than building a second one.
// ============================================================
state.songRefAudioBase64 = null;
state.songRefRecorder = null;
document.getElementById("songRefRecordBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("songRefRecordBtn");
  const statusEl = document.getElementById("songRefStatus");
  if (state.songRefRecorder?.state === "recording") {
    state.songRefRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    state.songRefRecorder = recorder;
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: "audio/webm" });
      statusEl.textContent = "Converting...";
      try {
        const wavBlob = await convertAudioBlobToWav(blob);
        const reader = new FileReader();
        reader.onload = (e) => {
          state.songRefAudioBase64 = e.target.result;
          const player = document.getElementById("songRefPlayer");
          player.src = state.songRefAudioBase64;
          player.classList.remove("d-none");
          statusEl.textContent = "Recording captured — listen back above.";
        };
        reader.readAsDataURL(wavBlob);
      } catch (convErr) {
        statusEl.textContent = "Couldn't process the recording: " + convErr.message;
      }
      btn.textContent = "🔴 Record";
      btn.classList.remove("btn-danger");
      btn.classList.add("btn-outline-danger");
    };
    recorder.start();
    btn.textContent = "⏹️ Stop";
    btn.classList.remove("btn-outline-danger");
    btn.classList.add("btn-danger");
    statusEl.textContent = "Recording... up to 30 seconds, then click Stop.";
  } catch (err) {
    alert("Couldn't access the microphone: " + err.message);
  }
});
document.getElementById("songRefUpload")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("songRefStatus");
  statusEl.textContent = "Converting...";
  try {
    const wavBlob = await convertAudioBlobToWav(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      state.songRefAudioBase64 = ev.target.result;
      const player = document.getElementById("songRefPlayer");
      player.src = state.songRefAudioBase64;
      player.classList.remove("d-none");
      statusEl.textContent = `Loaded "${file.name}".`;
    };
    reader.readAsDataURL(wavBlob);
  } catch (convErr) {
    statusEl.textContent = `Couldn't process "${file.name}": ${convErr.message}`;
  }
});
document.getElementById("songRefGenerateBtn")?.addEventListener("click", async () => {
  const prompt = document.getElementById("songRefPrompt")?.value?.trim();
  if (!prompt) return alert("Describe what should happen first.");
  if (!state.songRefAudioBase64) return alert("Record or upload your voice clip first.");
  const btn = document.getElementById("songRefGenerateBtn");
  const resultEl = document.getElementById("songRefResult");
  const runId = state.songStudioRunId || crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Generating with your reference voice — this can take a minute or two...");
  startProgressPolling(runId);
  try {
    const { res, data } = await fetchJson("/api/music/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, style: prompt, referenceAudioBase64: state.songRefAudioBase64, modelId: readModelSelectEl(document.getElementById("songRefModelSelect")), userApiKey: getUserKey() }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Generation failed.");
    resultEl.innerHTML = `
      <audio controls class="w-100 mb-2" src="${data.audio}"></audio>
      <a href="${data.audio}" data-download-url="${data.audio}" data-download-filename="voice-ref-${Date.now()}.mp3" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>
    `;
    logActivity("success", "Generated audio using your reference voice.");
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Reference-voice generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
// ============================================================
// FLOW STUDIO
// ============================================================
state.flowResolvedReferenceImages = []; // populated after planning, from the person/product cards' images (upload or URL)
state.flowEndFrameBase64 = null;
document.getElementById("flowEndFrameUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    state.flowEndFrameBase64 = ev.target.result;
    const preview = document.getElementById("flowEndFramePreview");
    preview.src = state.flowEndFrameBase64;
    preview.classList.remove("d-none");
  };
  reader.readAsDataURL(file);
});
// ============================================================
// FLOW STUDIO — repeatable reference cards for people/products. Each
// card is a real independent object: name, image (upload OR URL, your
// choice), description, and a style tag (real photo/AI-generated/
// animated) — multiple cards can share a name to represent alternate
// versions of the same character, exactly as requested.
// ============================================================
state.flowPersonCards = [];
document.getElementById("flowOverallLanguage")?.addEventListener("change", (e) => {
  const narrationLangSelect = document.getElementById("flowNarrationLanguage");
  if (narrationLangSelect) narrationLangSelect.value = e.target.value; // real default from the overall project setting, not left independent
});
state.flowProductCards = [];
// Resolves all person+product cards into a flat image list directly,
// client-side — used by both the standard flow (which also gets this
// from the plan response) and the long-video flow (whose plan-scenes
// route doesn't resolve cards), so there's one consistent source
// instead of relying on a server round-trip that not every path makes.
function resolveFlowReferenceImages() {
  return [...state.flowPersonCards, ...state.flowProductCards]
    .map((c) => c.imageBase64 || c.imageUrl)
    .filter(Boolean);
}
function renderCardGroup(cards, containerId, kind) {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  containerEl.innerHTML = cards.map((card, i) => `
    <div class="border rounded p-2 mb-2 bg-light">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <input type="text" class="form-control form-control-sm border-0 bg-transparent fw-semibold p-0" style="width:60%;" placeholder="Name (e.g. Meghana, handbag)" value="${escapeHtml(card.name || "")}" data-card-name="${i}">
        <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" data-remove-card="${i}">✕</button>
      </div>
      <div class="row g-1 mb-1">
        <div class="col-6"><input type="file" accept="image/*" class="form-control form-control-sm" data-card-upload="${i}"></div>
        <div class="col-6"><input type="text" class="form-control form-control-sm" placeholder="or image URL" value="${escapeHtml(card.imageUrl || "")}" data-card-url="${i}"></div>
      </div>
      ${card.imageBase64 || card.imageUrl ? `<img src="${card.imageBase64 || card.imageUrl}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;" class="mb-1">` : ""}
      <textarea class="form-control form-control-sm mb-1" rows="2" placeholder="Description — who/what they are, backstory..." data-card-description="${i}">${escapeHtml(card.description || "")}</textarea>
      <select class="form-select form-select-sm" data-card-style="${i}">
        <option value="" ${!card.styleTag ? "selected" : ""}>No style tag</option>
        <option value="real" ${card.styleTag === "real" ? "selected" : ""}>Real photo</option>
        <option value="ai" ${card.styleTag === "ai" ? "selected" : ""}>AI-generated reference</option>
        <option value="animated" ${card.styleTag === "animated" ? "selected" : ""}>Animated/cartoon reference</option>
      </select>
      ${kind === "person" ? `
      <div class="row g-1 mb-1">
        <div class="col-6">
          <label class="xx-small text-muted mb-0 d-block">Language they speak</label>
          <select class="form-select form-select-sm" data-card-language="${i}">
            <option value="" ${!card.language ? "selected" : ""}>Match overall video language</option>
            <option value="english" ${card.language === "english" ? "selected" : ""}>English</option>
            <option value="Hindi" ${card.language === "Hindi" ? "selected" : ""}>Hindi</option>
            <option value="Telugu" ${card.language === "Telugu" ? "selected" : ""}>Telugu</option>
            <option value="Tamil" ${card.language === "Tamil" ? "selected" : ""}>Tamil</option>
            <option value="Kannada" ${card.language === "Kannada" ? "selected" : ""}>Kannada</option>
            <option value="Malayalam" ${card.language === "Malayalam" ? "selected" : ""}>Malayalam</option>
            <option value="Marathi" ${card.language === "Marathi" ? "selected" : ""}>Marathi</option>
            <option value="Bengali" ${card.language === "Bengali" ? "selected" : ""}>Bengali</option>
          </select>
        </div>
        <div class="col-6">
          <label class="xx-small text-muted mb-0 d-block">Voice for their dialogue</label>
          <select class="form-select form-select-sm" data-card-voice="${i}">${buildVoiceOptionsHtml(card.voiceModelId)}</select>
        </div>
      </div>
      <label class="xx-small text-muted mb-0 mt-1 d-block">Personality / how they speak <span class="fw-normal">(e.g. sarcastic, formal and clipped, warm and talkative — shapes how their lines get written)</span></label>
      <input type="text" class="form-control form-control-sm mb-1" placeholder="e.g. blunt, dry sense of humor, speaks in short sentences" value="${escapeHtml(card.characteristics || "")}" data-card-characteristics="${i}">
      <label class="xx-small text-muted mb-0 mt-1 d-block fw-semibold">${escapeHtml(card.name || "This character")}'s dialogue script <span class="fw-normal">(edit freely — this is exactly what gets spoken)</span></label>
      <div data-card-dialogue-list="${i}"></div>
      <button type="button" class="btn btn-sm btn-outline-secondary w-100 mt-1" data-add-card-dialogue="${i}">➕ Add dialogue line</button>` : ""}
    </div>`).join("") || `<p class="xx-small text-muted mb-0">None added yet.</p>`;
  // Real per-character dialogue editor — proper textareas + scene
  // picker + inline preview per line, right where you'd look for a
  // character's "final script," not a browser prompt() popup buried
  // in the scene list.
  if (kind === "person") {
    cards.forEach((card, cardIdx) => {
      const listEl = containerEl.querySelector(`[data-card-dialogue-list="${cardIdx}"]`);
      if (!listEl) return;
      const sceneOptions = state.flowScenes.length
        ? state.flowScenes.map((_, si) => `<option value="${si}">Scene ${si + 1}</option>`).join("")
        : `<option value="">No scenes drafted yet — draft scenes first, then assign</option>`;
      listEl.innerHTML = (card.dialogueLines || []).map((line, lineIdx) => `
        <div class="border rounded p-2 mb-1 bg-white">
          <textarea class="form-control form-control-sm mb-1" rows="2" data-dialogue-text="${cardIdx}:${lineIdx}">${escapeHtml(line.text || "")}</textarea>
          <div class="d-flex gap-1 align-items-center">
            <select class="form-select form-select-sm" style="width:auto;flex:1;" data-dialogue-scene="${cardIdx}:${lineIdx}">${sceneOptions}</select>
            <button type="button" class="btn btn-sm btn-outline-primary py-0 px-2" data-preview-card-dialogue="${cardIdx}:${lineIdx}">▶️</button>
            <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" data-remove-card-dialogue="${cardIdx}:${lineIdx}">✕</button>
          </div>
          <audio class="w-100 d-none mt-1" data-card-dialogue-player="${cardIdx}:${lineIdx}" controls></audio>
        </div>`).join("") || `<p class="xx-small text-muted mb-0">No lines yet.</p>`;
      // Set the actual selected scene AFTER inserting the HTML — <select>
      // doesn't reliably honor a "selected" attribute built via string
      // concatenation once scene count changes between renders.
      (card.dialogueLines || []).forEach((line, lineIdx) => {
        const sel = listEl.querySelector(`[data-dialogue-scene="${cardIdx}:${lineIdx}"]`);
        if (sel && line.sceneIndex !== null && line.sceneIndex !== undefined) sel.value = String(line.sceneIndex);
      });
      listEl.querySelectorAll("[data-dialogue-text]").forEach((el) => {
        el.addEventListener("input", () => {
          const [ci, li] = el.getAttribute("data-dialogue-text").split(":").map(Number);
          state.flowPersonCards[ci].dialogueLines[li].text = el.value;
        });
      });
      listEl.querySelectorAll("[data-dialogue-scene]").forEach((el) => {
        el.addEventListener("change", () => {
          const [ci, li] = el.getAttribute("data-dialogue-scene").split(":").map(Number);
          state.flowPersonCards[ci].dialogueLines[li].sceneIndex = el.value === "" ? null : parseInt(el.value);
        });
      });
      listEl.querySelectorAll("[data-remove-card-dialogue]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const [ci, li] = btn.getAttribute("data-remove-card-dialogue").split(":").map(Number);
          state.flowPersonCards[ci].dialogueLines.splice(li, 1);
          renderCardGroup(state.flowPersonCards, "flowPersonCards", "person");
          if (typeof renderFlowSceneList === "function" && state.flowScenes.length) renderFlowSceneList();
        });
      });
      listEl.querySelectorAll("[data-preview-card-dialogue]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const [ci, li] = btn.getAttribute("data-preview-card-dialogue").split(":").map(Number);
          const line = state.flowPersonCards[ci]?.dialogueLines?.[li];
          if (!line?.text?.trim()) return alert("Write the line first.");
          const player = listEl.querySelector(`[data-card-dialogue-player="${ci}:${li}"]`);
          btn.disabled = true;
          try {
            const card = state.flowPersonCards[ci];
            const resolvedLineVoice = resolveVoiceValue(card.voiceModelId);
            const { res, data } = await fetchJson("/api/flow/preview-voice", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: line.text, voiceModel: resolvedLineVoice.voiceModel, voiceId: resolvedLineVoice.voiceId,
                targetLanguage: card.language || document.getElementById("flowOverallLanguage")?.value,
                textModel: getTextModel(), userApiKey: getUserKey(),
              }),
            });
            await refreshCreditsSummary();
            if (!res.ok) throw new Error(data.error || "Preview failed.");
            player.src = data.audio;
            player.classList.remove("d-none");
            player.play();
          } catch (err) {
            alert("Preview failed: " + err.message);
          } finally {
            btn.disabled = false;
          }
        });
      });
    });
    containerEl.querySelectorAll("[data-add-card-dialogue]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cardIdx = parseInt(btn.getAttribute("data-add-card-dialogue"));
        state.flowPersonCards[cardIdx].dialogueLines = state.flowPersonCards[cardIdx].dialogueLines || [];
        state.flowPersonCards[cardIdx].dialogueLines.push({ text: "", sceneIndex: null });
        renderCardGroup(state.flowPersonCards, "flowPersonCards", "person");
      });
    });
  }
  containerEl.querySelectorAll("[data-remove-card]").forEach((btn) => {
    btn.addEventListener("click", () => {
      cards.splice(parseInt(btn.getAttribute("data-remove-card")), 1);
      renderCardGroup(cards, containerId, kind);
    });
  });
  containerEl.querySelectorAll("[data-card-name]").forEach((el) => {
    el.addEventListener("input", () => { cards[parseInt(el.getAttribute("data-card-name"))].name = el.value; });
  });
  containerEl.querySelectorAll("[data-card-description]").forEach((el) => {
    el.addEventListener("input", () => { cards[parseInt(el.getAttribute("data-card-description"))].description = el.value; });
  });
  containerEl.querySelectorAll("[data-card-style]").forEach((el) => {
    el.addEventListener("change", () => { cards[parseInt(el.getAttribute("data-card-style"))].styleTag = el.value; });
  });
  containerEl.querySelectorAll("[data-card-voice]").forEach((el) => {
    el.addEventListener("change", () => { cards[parseInt(el.getAttribute("data-card-voice"))].voiceModelId = el.value; });
  });
  containerEl.querySelectorAll("[data-card-language]").forEach((el) => {
    el.addEventListener("change", () => { cards[parseInt(el.getAttribute("data-card-language"))].language = el.value; });
  });
  containerEl.querySelectorAll("[data-card-characteristics]").forEach((el) => {
    el.addEventListener("input", () => { cards[parseInt(el.getAttribute("data-card-characteristics"))].characteristics = el.value; });
  });
  containerEl.querySelectorAll("[data-card-url]").forEach((el) => {
    el.addEventListener("input", () => {
      const idx = parseInt(el.getAttribute("data-card-url"));
      cards[idx].imageUrl = el.value;
      if (el.value) cards[idx].imageBase64 = null; // URL and upload are mutually exclusive per card — the most recent choice wins
    });
  });
  containerEl.querySelectorAll("[data-card-upload]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = parseInt(el.getAttribute("data-card-upload"));
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        cards[idx].imageBase64 = ev.target.result;
        cards[idx].imageUrl = null;
        renderCardGroup(cards, containerId, kind); // re-render to show the thumbnail preview
      };
      reader.readAsDataURL(file);
    });
  });
}
document.getElementById("flowAddPersonBtn")?.addEventListener("click", () => {
  state.flowPersonCards.push({ name: "", imageBase64: null, imageUrl: null, description: "", styleTag: "", voiceModelId: null, dialogueLines: [], language: "", characteristics: "" });
  renderCardGroup(state.flowPersonCards, "flowPersonCards", "person");
});
document.getElementById("flowAddProductBtn")?.addEventListener("click", () => {
  state.flowProductCards.push({ name: "", imageBase64: null, imageUrl: null, description: "", styleTag: "" });
  renderCardGroup(state.flowProductCards, "flowProductCards", "product");
});
// Repeatable video-reference list — real multi-reference support
// instead of the single link/file this used to be limited to.
state.flowVideoRefs = [];
function renderVideoRefList() {
  const listEl = document.getElementById("flowVideoRefList");
  if (!listEl) return;
  listEl.innerHTML = state.flowVideoRefs.map((ref, i) => `
    <div class="border rounded p-2 mb-2 bg-light">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <input type="text" class="form-control form-control-sm border-0 bg-transparent p-0" placeholder="Video link (Reels/YouTube/etc.)" value="${escapeHtml(ref.link || "")}" data-videoref-link="${i}">
        <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 flex-shrink-0" data-remove-videoref="${i}">✕</button>
      </div>
      <textarea class="form-control form-control-sm" rows="1" placeholder="What matters about this reference..." data-videoref-description="${i}">${escapeHtml(ref.description || "")}</textarea>
    </div>`).join("") || `<p class="xx-small text-muted mb-0">None added yet.</p>`;
  listEl.querySelectorAll("[data-remove-videoref]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.flowVideoRefs.splice(parseInt(btn.getAttribute("data-remove-videoref")), 1);
      renderVideoRefList();
    });
  });
  listEl.querySelectorAll("[data-videoref-link]").forEach((el) => {
    el.addEventListener("input", () => { state.flowVideoRefs[parseInt(el.getAttribute("data-videoref-link"))].link = el.value; });
  });
  listEl.querySelectorAll("[data-videoref-description]").forEach((el) => {
    el.addEventListener("input", () => { state.flowVideoRefs[parseInt(el.getAttribute("data-videoref-description"))].description = el.value; });
  });
}
document.getElementById("flowAddVideoRefBtn")?.addEventListener("click", () => {
  state.flowVideoRefs.push({ link: "", description: "" });
  renderVideoRefList();
});
// Start frame — symmetric with end frame, overrides the implicit
// "first card image" default for a dedicated opening shot.
state.flowStartFrameBase64 = null;
document.getElementById("flowStartFrameUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    state.flowStartFrameBase64 = ev.target.result;
    const preview = document.getElementById("flowStartFramePreview");
    preview.src = state.flowStartFrameBase64;
    preview.classList.remove("d-none");
  };
  reader.readAsDataURL(file);
});
// Scenario switch — "talking" is a genuinely different workflow (real
// image+audio avatar model), so it swaps to its own dedicated fields
// entirely rather than repurposing the standard-video form.
function populateTalkingModelSelect() {
  const selectEl = document.getElementById("flowTalkingModelSelect");
  if (!selectEl) return;
  selectEl.innerHTML = (state.talkingAvatarModels || []).map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join("");
  updateFlowTalkingBackgroundVisibility();
}
function updateFlowTalkingBackgroundVisibility() {
  const modelId = readModelSelectEl(document.getElementById("flowTalkingModelSelect"));
  const model = (state.talkingAvatarModels || []).find((m) => m.id === modelId);
  document.getElementById("flowTalkingBackgroundSection")?.classList.toggle("d-none", !model?.supportsBackground);
  document.getElementById("flowTalkingDeliverySection")?.classList.toggle("d-none", !model?.supportsDeliveryControls);
  // HeyGen-native voice option only makes sense when HeyGen is actually
  // selected — hides it otherwise rather than offering a choice that
  // would silently do nothing on a different model.
  const heygenOption = document.querySelector('#flowTalkingVoiceMode option[value="heygen-native"]');
  if (heygenOption) heygenOption.disabled = !model?.supportsNativeText;
}
document.getElementById("flowTalkingModelSelect")?.addEventListener("change", updateFlowTalkingBackgroundVisibility);
document.getElementById("flowScenario")?.addEventListener("change", (e) => {
  const isTalking = e.target.value === "talking";
  document.getElementById("flowStandardFields")?.classList.toggle("d-none", isTalking);
  document.getElementById("flowTalkingFields")?.classList.toggle("d-none", !isTalking);
  if (isTalking) {
    document.getElementById("flowTalkingGuidance").textContent = "Type what should be said and pick a target language below — it translates for real (same proven mechanism as Voice Studio) before speaking, whether or not you're cloning a voice. Or skip straight to a finished audio clip if you already have one.";
    populateTalkingModelSelect();
    populateVoiceSelectWithCustom(document.getElementById("flowTalkingStandardVoiceSelect"));
    const langSelect = document.getElementById("flowTalkingTargetLanguage");
    const overallLang = document.getElementById("flowOverallLanguage")?.value;
    if (langSelect && overallLang) langSelect.value = overallLang; // real default from the overall project setting
  }
});
let flowTalkingImageBase64 = null, flowTalkingAudioBase64 = null, flowTalkingCloneAudioBase64 = null;
document.getElementById("flowTalkingImageUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowTalkingImageBase64 = ev.target.result;
    const preview = document.getElementById("flowTalkingImagePreview");
    preview.src = flowTalkingImageBase64;
    preview.classList.remove("d-none");
  };
  reader.readAsDataURL(file);
});
document.getElementById("flowTalkingAudioUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowTalkingAudioBase64 = ev.target.result;
    const preview = document.getElementById("flowTalkingAudioPreview");
    preview.src = flowTalkingAudioBase64;
    preview.classList.remove("d-none");
  };
  reader.readAsDataURL(file);
});
document.getElementById("flowTalkingCloneUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowTalkingCloneAudioBase64 = ev.target.result;
    document.getElementById("flowTalkingCloneStatus").textContent = `Will clone the voice from "${file.name}".`;
  };
  reader.readAsDataURL(file);
});
// Three real, distinct modes — switching between them shows/hides the
// fields that actually apply, rather than one form trying to cover all
// cases with ambiguous fields.
document.getElementById("flowTalkingAudioMode")?.addEventListener("change", async (e) => {
  const mode = e.target.value;
  document.getElementById("flowTalkingFinishedAudioSection")?.classList.toggle("d-none", mode !== "finished");
  document.getElementById("flowTalkingLibraryAudioSection")?.classList.toggle("d-none", mode !== "library");
  document.getElementById("flowTalkingGenerateSpeechSection")?.classList.toggle("d-none", mode !== "generate");
  if (mode === "library") {
    const selectEl = document.getElementById("flowTalkingLibrarySelect");
    if (selectEl) {
      selectEl.innerHTML = `<option value="">Loading...</option>`;
      try {
        // REAL GAP FIXED: this used to only fetch type=voice, which
        // completely missed anything produced by the Mixer (saved as
        // type "mix" regardless of whether the actual content was pure
        // voice narration, e.g. a combined script with intro/outro) or
        // by the Combine button's local-fallback path (same "mix" type,
        // see server.js's saveLocalRenderToLibrary). Any of these could
        // easily BE the finished narration someone wants here — no
        // narrow filter, every real audio type shows up.
        const { res, data } = await fetchJson("/api/audio-library");
        if (!res.ok) throw new Error(data.error);
        const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
        const items = data.items || [];
        selectEl.innerHTML = items.length
          ? `<option value="">Pick a saved clip...</option>` + items.map((it) => `<option value="${it.id}">${typeIcon[it.type] || ""} ${escapeHtml(it.name)}</option>`).join("")
          : `<option value="">Nothing in your library yet — generate or combine something first.</option>`;
      } catch (err) {
        selectEl.innerHTML = `<option value="">Couldn't load your library.</option>`;
      }
    }
  }
});
document.getElementById("flowTalkingLibrarySelect")?.addEventListener("change", async (e) => {
  const id = e.target.value;
  const preview = document.getElementById("flowTalkingLibraryPreview");
  if (!id) { preview?.classList.add("d-none"); flowTalkingAudioBase64 = null; return; }
  try {
    const { res, data } = await fetchJson("/api/audio-library");
    if (!res.ok) throw new Error(data.error);
    const item = (data.items || []).find((it) => String(it.id) === id);
    if (item) {
      flowTalkingAudioBase64 = item.audio;
      if (preview) { preview.src = item.audio; preview.classList.remove("d-none"); }
    }
  } catch (err) {
    alert("Couldn't load that clip: " + err.message);
  }
});
document.getElementById("flowTalkingVoiceMode")?.addEventListener("change", (e) => {
  document.getElementById("flowTalkingStandardVoiceSelect")?.classList.toggle("d-none", e.target.value !== "standard");
  document.getElementById("flowTalkingCloneSection")?.classList.toggle("d-none", e.target.value !== "clone");
  document.getElementById("flowTalkingExistingCloneSection")?.classList.toggle("d-none", e.target.value !== "existing-clone");
  document.getElementById("flowTalkingHeygenVoiceSection")?.classList.toggle("d-none", e.target.value !== "heygen-native");
  const showEmotion = e.target.value === "clone" || e.target.value === "existing-clone";
  document.getElementById("flowTalkingCloneEmotionSection")?.classList.toggle("d-none", !showEmotion);
  document.getElementById("flowTalkingEmotionScopeNote")?.classList.toggle("d-none", !showEmotion);
  if (e.target.value === "existing-clone") populateFlowTalkingExistingCloneSelect();
});
document.getElementById("flowTalkingSpeed")?.addEventListener("input", (e) => {
  document.getElementById("flowTalkingSpeedValue").textContent = e.target.value;
});
document.getElementById("flowTalkingPitch")?.addEventListener("input", (e) => {
  document.getElementById("flowTalkingPitchValue").textContent = e.target.value;
});
// Real "clone once, reuse everywhere" fix — state.customVoices is
// already loaded app-wide from /api/models (see Voice Studio's own
// picker doing the same match-by-family lookup), so this needs no new
// fetch, just the same list surfaced here too. Filtered to MiniMax
// specifically since that's the only confirmed real cloning family in
// this app (see Voice Studio's clone section) — a voice cloned for a
// different family wouldn't actually work on the model this route uses.
function populateFlowTalkingExistingCloneSelect() {
  const selectEl = document.getElementById("flowTalkingExistingCloneSelect");
  if (!selectEl) return;
  const minimaxClones = (state.customVoices || []).filter((cv) => cv.model_family === "minimax");
  selectEl.innerHTML = minimaxClones.length
    ? minimaxClones.map((cv) => `<option value="${escapeHtml(cv.custom_voice_id)}">🎙️ ${escapeHtml(cv.name)}</option>`).join("")
    : `<option value="">No cloned voices yet — clone one in Voice Studio first, or pick "Clone a voice from a reference clip" above.</option>`;
}
document.getElementById("flowTalkingBackgroundType")?.addEventListener("change", (e) => {
  const isColor = e.target.value === "color";
  document.getElementById("flowTalkingBackgroundColor")?.classList.toggle("d-none", !isColor);
  document.getElementById("flowTalkingBackgroundUrl")?.classList.toggle("d-none", isColor);
});
document.getElementById("flowTalkingGenerateBtn")?.addEventListener("click", async () => {
  if (!flowTalkingImageBase64) return alert("Add a portrait reference image first.");
  const audioMode = document.getElementById("flowTalkingAudioMode")?.value;
  const voiceMode = document.getElementById("flowTalkingVoiceMode")?.value;
  const text = document.getElementById("flowTalkingText")?.value?.trim();
  if (audioMode === "finished" && !flowTalkingAudioBase64) return alert("Upload a finished audio clip first.");
  if (audioMode === "library" && !flowTalkingAudioBase64) return alert("Pick a saved clip from your Audio Library first.");
  if (audioMode === "generate" && !text) return alert("Type what should be said first.");
  if (audioMode === "generate" && voiceMode === "clone" && !flowTalkingCloneAudioBase64) return alert("Upload a reference clip to clone a voice from, or switch to a standard voice.");
  if (audioMode === "generate" && voiceMode === "existing-clone" && !document.getElementById("flowTalkingExistingCloneSelect")?.value) return alert("Pick one of your already-cloned voices, or switch to a standard voice.");
  const modelId = readModelSelectEl(document.getElementById("flowTalkingModelSelect"));
  const backgroundType = document.getElementById("flowTalkingBackgroundType")?.value;
  const background = document.getElementById("flowTalkingBackgroundSection")?.classList.contains("d-none")
    ? null
    : { type: backgroundType, value: backgroundType === "color" ? document.getElementById("flowTalkingBackgroundColor")?.value : document.getElementById("flowTalkingBackgroundUrl")?.value };
  const deliveryVisible = !document.getElementById("flowTalkingDeliverySection")?.classList.contains("d-none");
  const talkingStyle = deliveryVisible ? document.getElementById("flowTalkingStyle")?.value : null;
  const aspectRatio = deliveryVisible ? document.getElementById("flowTalkingAspectRatio")?.value : null;
  const btn = document.getElementById("flowTalkingGenerateBtn");
  const resultEl = document.getElementById("flowStudioResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Generating your talking video — this can take a minute, with automatic fallback if the model has trouble...");
  startProgressPolling(runId);
  const resolvedTalkingVoice = resolveVoiceSelection(document.getElementById("flowTalkingStandardVoiceSelect"));
  try {
    const { res, data } = await fetchJson("/api/flow/generate-talking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId, imageBase64: flowTalkingImageBase64,
        audioBase64: (audioMode === "finished" || audioMode === "library") ? flowTalkingAudioBase64 : null,
        text: audioMode === "generate" ? text : null,
        targetLanguage: document.getElementById("flowTalkingTargetLanguage")?.value,
        voiceMode, voiceModelId: resolvedTalkingVoice.voiceModel, voiceId: resolvedTalkingVoice.voiceId,
        voiceReferenceAudioBase64: voiceMode === "clone" ? flowTalkingCloneAudioBase64 : null,
        existingCustomVoiceId: voiceMode === "existing-clone" ? document.getElementById("flowTalkingExistingCloneSelect")?.value : null,
        voiceEmotion: (voiceMode === "clone" || voiceMode === "existing-clone") ? document.getElementById("flowTalkingEmotion")?.value : null,
        voiceSpeed: (voiceMode === "clone" || voiceMode === "existing-clone") ? parseFloat(document.getElementById("flowTalkingSpeed")?.value) : null,
        voicePitch: (voiceMode === "clone" || voiceMode === "existing-clone") ? parseInt(document.getElementById("flowTalkingPitch")?.value) : null,
        useNativeHeygenVoice: voiceMode === "heygen-native",
        heygenVoiceName: document.getElementById("flowTalkingHeygenVoiceName")?.value?.trim() || null,
        background: background?.value ? background : null,
        talkingStyle, aspectRatio,
        modelId, textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Talking video generation failed.");
    resultEl.innerHTML = `
      ${data.fallbackNote ? `<div class="alert alert-info py-2 px-3 xx-small mb-2">ℹ️ ${escapeHtml(data.fallbackNote)}</div>` : ""}
      <video controls class="w-100 mb-2 rounded" src="${data.video}"></video>
      <p class="xx-small text-muted mb-2">Generated with ${escapeHtml(data.modelUsed)}</p>
      <a href="${data.video}" data-download-url="${data.video}" data-download-filename="talking-${Date.now()}.mp4" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>
    `;
    document.getElementById("flowEditSection")?.classList.add("d-none"); // talking-video edits aren't wired to regenerate-video's text-prompt model, so this is left hidden rather than offering an edit path that wouldn't work
    logActivity("success", `Talking video generated with ${data.modelUsed}${data.fallbackNote ? " (fell back automatically)" : ""}.`);
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Talking video generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
// ============================================================
// FLOW STUDIO — long-form video (multi-scene + real cloud merge, with
// local ffmpeg as a fallback only)
// ============================================================
state.flowScenes = [];
// Mirrors the same duration-constraint logic already proven in
// populateDurationSelect — reused as a real max-duration lookup instead
// of a second, divergent implementation.
function getModelMaxDuration(modelId) {
  const model = (state.videoModels || []).find((m) => m.id === modelId);
  const constraint = model?.duration;
  if (constraint?.type === "range") return constraint.max;
  if (constraint?.type === "enum") return Math.max(...constraint.options);
  return 8; // unknown/custom model — conservative default
}
// Real fix for a real bug: this dropdown was hardcoded to 4/6/8s
// regardless of which model actually got recommended — so a model like
// Kling (real, confirmed 3-15s range) was artificially capped at 8s in
// the UI even though it could genuinely do more. Respects each model's
// actual constraint type: enum models (like Veo's exact [4,6,8]) get
// their real allowed values, range models get a sensible spread up to
// their real confirmed max.
function populateFlowDurationSelect(modelId) {
  const selectEl = document.getElementById("flowDuration");
  if (!selectEl) return;
  const model = (state.videoModels || []).find((m) => m.id === modelId);
  const constraint = model?.duration;
  let options;
  if (constraint?.type === "enum") {
    options = [...constraint.options].sort((a, b) => a - b);
  } else if (constraint?.type === "range") {
    const { min, max } = constraint;
    const spread = new Set([min, Math.round((min + max) / 2), max]);
    if (max - min > 6) spread.add(Math.round(min + (max - min) / 3)).add(Math.round(min + (2 * (max - min)) / 3));
    options = [...spread].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
  } else {
    options = [4, 6, 8];
  }
  const previousValue = selectEl.value;
  selectEl.innerHTML = options.map((v) => `<option value="${v}">${v}s</option>`).join("");
  // Keep the previous choice if it's still valid for the new model;
  // otherwise land on a sensible middle value rather than always
  // resetting to the first option.
  if (options.includes(parseInt(previousValue))) selectEl.value = previousValue;
  else selectEl.value = String(options[Math.floor(options.length / 2)]);
}
async function populateFlowLongVideoModelSelect() {
  const selectEl = document.getElementById("flowLongVideoModelSelect");
  if (!selectEl) return;
  const realModels = (state.videoModels || []).filter((m) => !m.id.includes("reference-to-video"));
  selectEl.innerHTML = realModels.map((m) => `<option value="${m.id}">${escapeHtml(m.label)} — up to ${getModelMaxDuration(m.id)}s/scene</option>`).join("");
  // Real recommendation, not a static default — reflects whether human
  // references are actually present right now, using this app's own
  // tracked likeness-block history, same as the standard flow already does.
  const recBox = document.getElementById("flowLongVideoRecommendation");
  try {
    const { data } = await fetchJson("/api/flow/recommend-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hasHumanFaces: state.flowPersonCards.some((c) => c.imageBase64 || c.imageUrl),
        referenceCount: state.flowPersonCards.length + state.flowProductCards.length,
        hasEndFrame: !!state.flowEndFrameBase64,
      }),
    });
    if (data?.modelId && realModels.some((m) => m.id === data.modelId)) {
      selectEl.value = data.modelId;
      if (recBox) {
        recBox.innerHTML = `<strong>Recommended:</strong> ${(data.reasons || []).map((r) => escapeHtml(r)).join(" ")}`;
        recBox.classList.remove("d-none");
      }
    } else if (realModels.some((m) => m.id === DEFAULT_VIDEO_MODEL_FALLBACK)) {
      selectEl.value = DEFAULT_VIDEO_MODEL_FALLBACK;
    }
  } catch {
    if (realModels.some((m) => m.id === DEFAULT_VIDEO_MODEL_FALLBACK)) selectEl.value = DEFAULT_VIDEO_MODEL_FALLBACK;
  }
  updateFlowSceneDurationNote();
}
function updateFlowSceneDurationNote() {
  const modelId = document.getElementById("flowLongVideoModelSelect")?.value;
  const maxDuration = getModelMaxDuration(modelId);
  document.getElementById("flowSceneDurationNote").textContent = `Each scene will be planned at up to ${maxDuration}s — this model's real, confirmed maximum, not a generic guess. Different models genuinely differ here (Veo caps at 8s; Kling and Seedance go up to 15s), which changes how many scenes a given total length needs.`;
}
document.getElementById("flowLongVideoModelSelect")?.addEventListener("change", updateFlowSceneDurationNote);
document.getElementById("flowForceExtendedToggle")?.addEventListener("change", (e) => {
  const minutesInput = document.getElementById("flowTotalMinutes");
  minutesInput.max = e.target.checked ? 30 : 15;
  if (!e.target.checked && parseInt(minutesInput.value) > 15) minutesInput.value = 15;
});
document.getElementById("flowLongVideoToggle")?.addEventListener("change", async (e) => {
  const section = document.getElementById("flowLongVideoSection");
  section.classList.toggle("d-none", !e.target.checked);
  if (!e.target.checked) return;
  populateFlowLongVideoModelSelect();
  // Informational, not blocking — Fal's own cloud merge is the real
  // primary path now and just needs a valid API key (already required
  // for everything else here), so a missing local ffmpeg no longer
  // prevents this feature from working.
  const noteEl = document.getElementById("flowFfmpegWarning");
  try {
    const { data } = await fetchJson("/api/flow/ffmpeg-status");
    noteEl.textContent = data.localFallbackAvailable
      ? "Scenes merge via Fal's own cloud service — no local server setup needed. (A local fallback is also available on this server if that ever has trouble.)"
      : "Scenes merge via Fal's own cloud service — no local server setup needed.";
  } catch {
    noteEl.textContent = "Scenes merge via Fal's own cloud service — no local server setup needed.";
  }
});
function renderFlowSceneList() {
  const listEl = document.getElementById("flowSceneList");
  const modelId = document.getElementById("flowLongVideoModelSelect")?.value;
  const maxDuration = getModelMaxDuration(modelId);
  listEl.innerHTML = state.flowScenes.map((scene, i) => `
    <div class="border rounded p-2 mb-2 bg-light">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <span class="xx-small fw-semibold">Scene ${i + 1}</span>
        <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" data-remove-scene="${i}">✕</button>
      </div>
      <textarea class="form-control form-control-sm mb-1" rows="2" data-scene-prompt="${i}">${escapeHtml(scene.prompt)}</textarea>
      <div class="d-flex align-items-center gap-2 mb-1">
        <label class="xx-small text-muted mb-0">Duration:</label>
        <input type="number" class="form-control form-control-sm" style="width:70px;" min="2" max="${maxDuration}" value="${scene.durationSeconds}" data-scene-duration="${i}">
        <span class="xx-small text-muted">sec (max ${maxDuration}s)</span>
      </div>
      ${i > 0 ? `
      <div class="mb-1">
        <label class="xx-small text-muted mb-0">Connects to previous scene:</label>
        <select class="form-select form-select-sm" data-scene-continuity="${i}">
          <option value="extend" ${scene.continuityType === "extend" ? "selected" : ""}>Extend — same character/action continuing (real frame-to-frame continuity)</option>
          <option value="cutaway" ${scene.continuityType !== "extend" ? "selected" : ""}>Cutaway — different shot, generated independently and joined</option>
        </select>
      </div>` : ""}
      <label class="xx-small text-muted mb-0">Dialogue in this scene:</label>
      <div data-scene-dialogue-list="${i}" class="mb-1"></div>
      <p class="xx-small text-muted mb-0">Add or edit lines in each character's card above, in "People / characters" — assign them to Scene ${i + 1} there.</p>
    </div>`).join("");
  listEl.querySelectorAll("[data-remove-scene]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.flowScenes.splice(parseInt(btn.getAttribute("data-remove-scene")), 1);
      renderFlowSceneList();
    });
  });
  listEl.querySelectorAll("[data-scene-prompt]").forEach((el) => {
    el.addEventListener("input", () => { state.flowScenes[parseInt(el.getAttribute("data-scene-prompt"))].prompt = el.value; });
  });
  listEl.querySelectorAll("[data-scene-duration]").forEach((el) => {
    el.addEventListener("input", () => { state.flowScenes[parseInt(el.getAttribute("data-scene-duration"))].durationSeconds = Math.min(maxDuration, parseInt(el.value) || 8); });
  });
  listEl.querySelectorAll("[data-scene-continuity]").forEach((el) => {
    el.addEventListener("change", () => { state.flowScenes[parseInt(el.getAttribute("data-scene-continuity"))].continuityType = el.value; });
  });
  // Render each scene's already-assigned dialogue lines (pulled live
  // from the actual person cards, since that's where dialogue really
  // lives) with a real remove action per line.
  state.flowScenes.forEach((_, sceneIdx) => {
    const listContainer = listEl.querySelector(`[data-scene-dialogue-list="${sceneIdx}"]`);
    if (!listContainer) return;
    const linesHere = [];
    state.flowPersonCards.forEach((card, cardIdx) => {
      (card.dialogueLines || []).forEach((line, lineIdx) => {
        if (line.sceneIndex === sceneIdx) linesHere.push({ cardIdx, lineIdx, name: card.name || "Character", text: line.text });
      });
    });
    listContainer.innerHTML = linesHere.map((l) => `
      <div class="xx-small border-bottom py-1">
        <div class="d-flex justify-content-between align-items-center">
          <span><strong>${escapeHtml(l.name)}:</strong> ${escapeHtml(l.text)}</span>
          <div class="d-flex gap-1">
            <button type="button" class="btn btn-sm btn-outline-primary py-0 px-1" data-preview-dialogue="${l.cardIdx}:${l.lineIdx}">▶️</button>
            <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" data-remove-dialogue="${l.cardIdx}:${l.lineIdx}">✕</button>
          </div>
        </div>
        <audio class="w-100 d-none" data-dialogue-player="${l.cardIdx}:${l.lineIdx}" controls></audio>
      </div>`).join("") || `<p class="xx-small text-muted mb-0">None yet.</p>`;
    listContainer.querySelectorAll("[data-preview-dialogue]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.getAttribute("data-preview-dialogue");
        const [cardIdx, lineIdx] = key.split(":").map(Number);
        const card = state.flowPersonCards[cardIdx];
        const line = card?.dialogueLines?.[lineIdx];
        if (!line) return;
        const player = listContainer.querySelector(`[data-dialogue-player="${key}"]`);
        btn.disabled = true;
        try {
          const resolvedSceneLineVoice = resolveVoiceValue(card.voiceModelId);
          const { res, data } = await fetchJson("/api/flow/preview-voice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: line.text, voiceModel: resolvedSceneLineVoice.voiceModel, voiceId: resolvedSceneLineVoice.voiceId,
              targetLanguage: card.language || document.getElementById("flowOverallLanguage")?.value,
              textModel: getTextModel(), userApiKey: getUserKey(),
            }),
          });
          await refreshCreditsSummary();
          if (!res.ok) throw new Error(data.error || "Preview failed.");
          player.src = data.audio;
          player.classList.remove("d-none");
          player.play();
        } catch (err) {
          alert("Preview failed: " + err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
    listContainer.querySelectorAll("[data-remove-dialogue]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const [cardIdx, lineIdx] = btn.getAttribute("data-remove-dialogue").split(":").map(Number);
        state.flowPersonCards[cardIdx].dialogueLines.splice(lineIdx, 1);
        renderFlowSceneList();
      });
    });
  });
  // Editing scenes invalidates any prior cost estimate/generate-readiness —
  // force a fresh estimate before allowing generation again, rather than
  // letting a stale number stand in for the actually-changed plan.
  document.getElementById("flowCostEstimateBox")?.classList.add("d-none");
  document.getElementById("flowGenerateLongBtn")?.classList.add("d-none");
}
document.getElementById("flowPlanScenesBtn")?.addEventListener("click", async () => {
  const intent = document.getElementById("flowIntent")?.value?.trim();
  if (!intent) return alert("Describe what you want this video to be/achieve first.");
  const btn = document.getElementById("flowPlanScenesBtn");
  btn.disabled = true;
  btn.textContent = "Drafting scenes...";
  try {
    const { res, data } = await fetchJson("/api/flow/plan-scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent,
        storyStart: document.getElementById("flowStoryStart")?.value?.trim(),
        storyEnd: document.getElementById("flowStoryEnd")?.value?.trim(),
        personCards: state.flowPersonCards, productCards: state.flowProductCards,
        niche: document.getElementById("flowNiche")?.value?.trim(),
        scenario: document.getElementById("flowScenario")?.value,
        totalDurationMinutes: document.getElementById("flowTotalMinutes")?.value,
        forceExtended: document.getElementById("flowForceExtendedToggle")?.checked,
        videoModel: document.getElementById("flowLongVideoModelSelect")?.value,
        textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Scene planning failed.");
    state.flowScenes = data.scenes;
    renderFlowSceneList();
    renderCardGroup(state.flowPersonCards, "flowPersonCards", "person"); // real scenes now exist — refresh so dialogue scene-pickers actually offer them
    document.getElementById("flowSceneListSection")?.classList.remove("d-none");
    logActivity("success", `Drafted ${data.scenes.length} scene(s) — edit freely before estimating cost.`);
  } catch (err) {
    alert("Scene planning failed: " + err.message);
    logActivity("warning", `Scene planning failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "🧠 Draft Scenes";
  }
});
document.getElementById("flowAddSceneBtn")?.addEventListener("click", () => {
  state.flowScenes.push({ prompt: "", durationSeconds: 8 });
  renderFlowSceneList();
});
document.getElementById("flowEstimateCostBtn")?.addEventListener("click", async () => {
  if (!state.flowScenes.length) return alert("Draft or add at least one scene first.");
  const btn = document.getElementById("flowEstimateCostBtn");
  const boxEl = document.getElementById("flowCostEstimateBox");
  btn.disabled = true;
  try {
    const { res, data } = await fetchJson("/api/flow/estimate-cost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes: state.flowScenes, videoModel: document.getElementById("flowLongVideoModelSelect")?.value || DEFAULT_VIDEO_MODEL_FALLBACK }),
    });
    if (!res.ok) throw new Error(data.error || "Cost estimate failed.");
    boxEl.innerHTML = `
      <div class="alert ${data.isRoughEstimate ? "alert-warning" : "alert-info"} py-2 px-3 small mb-2">
        ${data.estimatedCost !== null ? `<strong>Estimated cost: $${data.estimatedCost}</strong><br>` : ""}
        ${escapeHtml(data.note)}
      </div>`;
    boxEl.classList.remove("d-none");
    document.getElementById("flowGenerateLongBtn")?.classList.remove("d-none");
    logActivity("info", "Cost estimated — review before generating.");
  } catch (err) {
    alert("Cost estimate failed: " + err.message);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("flowGenerateLongBtn")?.addEventListener("click", async () => {
  if (!state.flowScenes.length) return alert("No scenes to generate.");
  if (!confirm(`Generate ${state.flowScenes.length} scene(s) and stitch them into one video? This will take real time and spend real credits — the cost estimate above is your guide, not a guarantee.`)) return;
  const btn = document.getElementById("flowGenerateLongBtn");
  const resultEl = document.getElementById("flowStudioResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, `Generating ${state.flowScenes.length} scene(s) — this will take a while for a long video...`);
  startProgressPolling(runId);
  try {
    const { res, data } = await fetchJson("/api/flow/generate-long", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId, scenes: state.flowScenes, videoModel: document.getElementById("flowLongVideoModelSelect")?.value || DEFAULT_VIDEO_MODEL_FALLBACK,
        referenceImages: resolveFlowReferenceImages(),
        personCards: state.flowPersonCards,
        overallLanguage: document.getElementById("flowOverallLanguage")?.value,
        textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Long-video generation failed.");
    resultEl.innerHTML = `
      ${data.fallbackNotes ? `<div class="alert alert-info py-2 px-3 xx-small mb-2">ℹ️ ${data.fallbackNotes.map(escapeHtml).join("<br>")}</div>` : ""}
      <p class="small mb-2">✓ ${data.sceneCount} scene(s) stitched into one video (${(data.sizeBytes / 1024 / 1024).toFixed(1)} MB).</p>
      <a href="${data.downloadUrl}" class="btn btn-dark fw-bold w-100">⬇️ Download Full Video</a>
    `;
    logActivity("success", `Long video generated: ${data.sceneCount} scenes stitched into one file.`);
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Long-video generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
document.getElementById("flowPlanBtn")?.addEventListener("click", async () => {
  const intent = document.getElementById("flowIntent")?.value?.trim();
  if (!intent) return alert("Describe what you want this video to be/achieve first.");
  const storyContext = document.getElementById("flowStoryContext")?.value?.trim();
  const prioritize = document.getElementById("flowPriority")?.value;
  const scenario = document.getElementById("flowScenario")?.value;
  const niche = document.getElementById("flowNiche")?.value?.trim();
  const storyStart = document.getElementById("flowStoryStart")?.value?.trim();
  const storyEnd = document.getElementById("flowStoryEnd")?.value?.trim();
  // Fold the repeatable video-ref list into storyContext — the backend's
  // URL-fetch logic scans this field for a link, but only ever fetches
  // the FIRST one found; every reference's own description still gets
  // included as real text context regardless, which is the honest,
  // achievable version of "multiple video references" without a real
  // video-analysis capability behind it.
  let combinedStoryContext = storyContext || "";
  state.flowVideoRefs.filter((r) => r.link || r.description).forEach((r, i) => {
    combinedStoryContext = `${combinedStoryContext} Reference video ${i + 1}${r.link ? ` (${r.link})` : ""}: ${r.description || "no description given"}.`.trim();
  });
  const btn = document.getElementById("flowPlanBtn");
  const statusEl = document.getElementById("flowPlanStatus");
  const planBox = document.getElementById("flowPlanBox");
  btn.disabled = true;
  planBox.classList.add("d-none");
  statusEl.textContent = "Checking references and planning the shot...";
  try {
    const { res, data } = await fetchJson("/api/flow/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent, storyContext: combinedStoryContext, prioritize, scenario,
        personCards: state.flowPersonCards, productCards: state.flowProductCards,
        niche, storyStart, storyEnd,
        hasEndFrame: !!state.flowEndFrameBase64,
        textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Planning failed.");
    if (data.isTalkingScenario) {
      statusEl.textContent = "";
      planBox.innerHTML = `<div class="alert alert-info py-2 px-3 small mb-0">${escapeHtml(data.guidance)}</div>`;
      planBox.classList.remove("d-none");
      return;
    }
    const model = (state.videoModels || []).find((m) => m.id === data.recommendation.modelId);
    state.flowResolvedReferenceImages = data.referenceImages || [];
    populateFlowDurationSelect(data.recommendation.modelId);
    planBox.innerHTML = `
      <div class="alert alert-success py-2 px-3 xx-small mb-2">
        <strong>Recommended: ${escapeHtml(model?.label || data.recommendation.modelId)}</strong>
        ${data.hasHumanFaces ? '<div class="mt-1">👤 Human face detected in your references.</div>' : ""}
        <div class="mt-1">${data.recommendation.reasons.map((r) => escapeHtml(r)).join(" ")}</div>
      </div>
      <label class="form-label xx-small fw-semibold mb-1">Planned prompt <span class="text-muted fw-normal">(edit freely before generating)</span></label>
      <textarea class="form-control form-control-sm mb-2" id="flowPlannedPrompt" rows="4">${escapeHtml(data.prompt)}</textarea>
      <input type="hidden" id="flowPlannedModelId" value="${escapeHtml(data.recommendation.modelId)}">
      <button type="button" class="btn btn-primary w-100 fw-bold" id="flowGenerateBtn">🎬 Generate Video</button>
    `;
    planBox.classList.remove("d-none");
    statusEl.textContent = "";
    document.getElementById("flowGenerateBtn")?.addEventListener("click", runFlowGeneration);
    logActivity("success", "Video planned — review the prompt and model before generating.");
  } catch (err) {
    statusEl.textContent = "Planning failed: " + err.message;
    logActivity("warning", `Flow planning failed — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
async function runFlowGeneration() {
  const plannedPrompt = document.getElementById("flowPlannedPrompt")?.value?.trim();
  const plannedModelId = document.getElementById("flowPlannedModelId")?.value;
  if (!plannedPrompt) return alert("The prompt is empty.");
  const btn = document.getElementById("flowGenerateBtn");
  const resultEl = document.getElementById("flowStudioResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Generating your video — this can take a minute or two, with automatic fallback if a model has trouble...");
  startProgressPolling(runId);
  try {
    // An explicit start frame becomes the PRIMARY reference image (the
    // one the video actually starts from), overriding whichever card
    // image would otherwise be first — this is what makes the field
    // genuinely do what its label says, not just sit there unused.
    const referenceImagesWithStart = state.flowStartFrameBase64
      ? [state.flowStartFrameBase64, ...state.flowResolvedReferenceImages]
      : state.flowResolvedReferenceImages;
    const { res, data } = await fetchJson("/api/flow/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId, prompt: plannedPrompt, videoModel: plannedModelId,
        referenceImages: referenceImagesWithStart,
        endImageBase64: state.flowEndFrameBase64 || null,
        durationSeconds: parseInt(document.getElementById("flowDuration")?.value) || 6,
        textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Video generation failed.");
    // Editing genuinely requires a real source IMAGE to regenerate from
    // (confirmed: /api/regenerate-video rejects anything else with
    // "Missing source image(s)") — a text-only generation with no
    // reference images has no valid image to offer here. The previous
    // version of this code fell back to the generated VIDEO's own file,
    // which would have been sent to a model expecting an image and
    // almost certainly failed. Only enabling editing when it can
    // actually work, rather than offering a button that silently breaks.
    const hasRealSourceImages = state.flowResolvedReferenceImages.length > 0;
    state.flowLastResult = hasRealSourceImages ? { videoModel: plannedModelId, sourceImages: state.flowResolvedReferenceImages } : null;
    state.flowCurrentVideoBase64 = data.video; // real video now exists — the audio layer needs this to lay narration/BGM onto
    resultEl.innerHTML = `
      ${data.fallbackNote ? `<div class="alert alert-info py-2 px-3 xx-small mb-2">ℹ️ ${escapeHtml(data.fallbackNote)}</div>` : ""}
      <video controls class="w-100 mb-2 rounded" src="${data.video}"></video>
      <p class="xx-small text-muted mb-2">Generated with ${escapeHtml(data.modelUsed)}</p>
      <a href="${data.video}" data-download-url="${data.video}" data-download-filename="flow-${Date.now()}.mp4" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>
    `;
    if (hasRealSourceImages) {
      document.getElementById("flowEditSection")?.classList.remove("d-none");
    } else {
      document.getElementById("flowEditSection")?.classList.add("d-none");
    }
    document.getElementById("flowAudioSection")?.classList.remove("d-none");
    logActivity("success", `Flow Studio video generated with ${data.modelUsed}${data.fallbackNote ? " (fell back automatically)" : ""}.`);
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Flow Studio generation failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
}
// Post-generation editing — reuses the existing, already-proven
// regenerate-video route rather than building a second edit pipeline.
document.getElementById("flowEditBtn")?.addEventListener("click", async () => {
  const instruction = document.getElementById("flowEditInstruction")?.value?.trim();
  if (!instruction) return alert("Describe what should change first.");
  if (!state.flowLastResult) return alert("Nothing to edit yet — generate a video first.");
  const btn = document.getElementById("flowEditBtn");
  const resultEl = document.getElementById("flowStudioResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Regenerating with your change...");
  startProgressPolling(runId);
  try {
    const { res, data } = await fetchJson("/api/regenerate-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId, instruction,
        sourceImages: state.flowLastResult.sourceImages,
        videoModel: state.flowLastResult.videoModel,
        durationSeconds: parseInt(document.getElementById("flowDuration")?.value) || 6,
        textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Regeneration failed.");
    // Real fix: without this, adding audio after an edit would have
    // silently used the stale PRE-edit video, since this was never
    // updated on a successful edit.
    state.flowCurrentVideoBase64 = data.url;
    resultEl.innerHTML = `
      <video controls class="w-100 mb-2 rounded" src="${data.url}"></video>
      <p class="xx-small text-muted mb-2">Regenerated with ${escapeHtml(data.modelUsed)}</p>
      <a href="${data.url}" data-download-url="${data.url}" data-download-filename="flow-edit-${Date.now()}.mp4" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>
    `;
    logActivity("success", "Video regenerated with your edit.");
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    logActivity("warning", `Edit failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
// ============================================================
// FLOW STUDIO — audio layer (narration/dialogue + BGM, merged onto the
// video via the real backend pipeline). Populated from the same real
// voice/music registries already proven in Voice Studio and Song Studio
// — not a separate, second implementation.
// ============================================================
// Real fix for a genuine gap: Flow Studio's voice dropdowns previously
// only ever showed base preset models, never voices you'd already
// cloned and saved in Voice Studio — meaning reusing your own saved
// voice required re-uploading a reference clip every single time, even
// though a saved voice already existed. This populates BOTH, clearly
// separated, and the resolver below turns a selection back into the
// correct {voiceModel, voiceId} pair — a saved custom voice always
// pairs with MiniMax, the only model family cloned voices actually
// belong to (confirmed: ElevenLabs/Gemini/Kokoro have no way to
// recognize a voice ID MiniMax created).
function buildVoiceOptionsHtml(selectedValue) {
  const baseOptions = (state.voiceModels || []).map((m) => `<option value="${m.id}" ${selectedValue === m.id ? "selected" : ""}>${escapeHtml(m.label)}</option>`).join("");
  const customVoices = state.customVoices || [];
  const customOptions = customVoices.length
    ? `<optgroup label="Your saved voices">${customVoices.map((v) => `<option value="custom:${v.custom_voice_id}" ${selectedValue === `custom:${v.custom_voice_id}` ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}</optgroup>`
    : "";
  return `<optgroup label="Standard voices">${baseOptions}</optgroup>${customOptions}`;
}
function populateVoiceSelectWithCustom(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = buildVoiceOptionsHtml(null);
}
function resolveVoiceValue(value) {
  if (value?.startsWith("custom:")) {
    const customVoiceId = value.slice("custom:".length);
    const savedVoice = (state.customVoices || []).find((v) => v.custom_voice_id === customVoiceId);
    return { voiceModel: "fal-ai/minimax/speech-02-hd", voiceId: customVoiceId, isCustom: true, name: savedVoice?.name };
  }
  return { voiceModel: value, voiceId: null, isCustom: false };
}
function resolveVoiceSelection(selectEl) {
  return resolveVoiceValue(readModelSelectEl(selectEl));
}
function populateFlowAudioModelSelects() {
  populateVoiceSelectWithCustom(document.getElementById("flowNarrationVoiceSelect"));
  const bgmSelect = document.getElementById("flowBgmModelSelect");
  if (bgmSelect) bgmSelect.innerHTML = (state.musicModels || []).filter((m) => !m.supportsVoiceReference).map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join("");
}
document.getElementById("flowPreviewNarrationBtn")?.addEventListener("click", async () => {
  const text = document.getElementById("flowNarrationScript")?.value?.trim();
  if (!text) return alert("Write or generate a script first.");
  const btn = document.getElementById("flowPreviewNarrationBtn");
  const player = document.getElementById("flowNarrationPreviewPlayer");
  btn.disabled = true;
  btn.textContent = "Generating...";
  try {
    const resolvedVoice = resolveVoiceSelection(document.getElementById("flowNarrationVoiceSelect"));
    const { res, data } = await fetchJson("/api/flow/preview-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voiceModel: resolvedVoice.voiceModel, voiceId: resolvedVoice.voiceId,
        referenceAudioBase64: flowVoiceRefAudioBase64,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Preview failed.");
    player.src = data.audio;
    player.classList.remove("d-none");
    player.play();
    logActivity("success", "Narration preview generated.");
  } catch (err) {
    alert("Preview failed: " + err.message);
    logActivity("warning", `Narration preview failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶️ Generate & Listen";
  }
});
document.getElementById("flowPreviewBgmBtn")?.addEventListener("click", async () => {
  const prompt = document.getElementById("flowBgmPrompt")?.value?.trim();
  if (!prompt && !flowBgmRefAudioBase64) return alert("Add a BGM prompt or reference clip first.");
  const btn = document.getElementById("flowPreviewBgmBtn");
  const player = document.getElementById("flowBgmPreviewPlayer");
  btn.disabled = true;
  btn.textContent = "Generating...";
  try {
    const { res, data } = await fetchJson("/api/flow/preview-bgm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        model: readModelSelectEl(document.getElementById("flowBgmModelSelect")),
        referenceAudioBase64: flowBgmRefAudioBase64,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Preview failed.");
    player.src = data.audio;
    player.classList.remove("d-none");
    player.play();
    logActivity("success", "BGM preview generated.");
  } catch (err) {
    alert("Preview failed: " + err.message);
    logActivity("warning", `BGM preview failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶️ Generate & Listen";
  }
});
let flowNarrationAudioBase64 = null, flowBgmAudioBase64 = null;
let flowVoiceRefAudioBase64 = null, flowBgmRefAudioBase64 = null;
document.getElementById("flowWriteNarrationBtn")?.addEventListener("click", async () => {
  const roughIdea = document.getElementById("flowNarrationIdea")?.value?.trim();
  if (!roughIdea) return alert("Describe what should be said first.");
  const targetLanguage = document.getElementById("flowNarrationLanguage")?.value;
  const btn = document.getElementById("flowWriteNarrationBtn");
  const statusEl = document.getElementById("flowNarrationWriteStatus");
  btn.disabled = true;
  statusEl.textContent = "Writing the script...";
  try {
    const { res, data } = await fetchJson("/api/flow/write-narration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roughIdea, targetLanguage,
        videoContext: document.getElementById("flowIntent")?.value?.trim(),
        textModel: getTextModel(), userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Writing the script failed.");
    document.getElementById("flowNarrationScript").value = data.script;
    if (data.scriptValidationFailed) {
      statusEl.textContent = `Heads up: even after retrying, this didn't come back in real ${targetLanguage} script. Please review the script below carefully.`;
    } else if (data.transliterationDetected) {
      statusEl.textContent = `Heads up: this may have come back as English words spelled out in ${targetLanguage} script rather than real ${targetLanguage}. Please review below.`;
    } else {
      statusEl.textContent = "Script ready below — edit freely before it's used.";
    }
    logActivity("success", "Narration script written — review it before generating.");
  } catch (err) {
    statusEl.textContent = "Failed: " + err.message;
    logActivity("warning", `Narration writing failed — ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("flowNarrationUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowNarrationAudioBase64 = ev.target.result;
    document.getElementById("flowNarrationUploadStatus").textContent = `Using uploaded clip "${file.name}" instead of generating.`;
  };
  reader.readAsDataURL(file);
});
document.getElementById("flowBgmUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowBgmAudioBase64 = ev.target.result;
    document.getElementById("flowBgmUploadStatus").textContent = `Using uploaded clip "${file.name}" instead of generating.`;
  };
  reader.readAsDataURL(file);
});
// REAL GAP FIXED: Flow Studio's talking-audio narration had a "pick
// from Audio Library" option; BGM had none at all — only generate-new
// or upload-from-computer, so a song or Mixer render you'd already
// made was completely unreachable here. Populated once when the Audio
// accordion section is first opened (see the accordion listener below)
// rather than on every keystroke.
async function populateFlowBgmLibrarySelect() {
  const selectEl = document.getElementById("flowBgmLibrarySelect");
  if (!selectEl) return;
  selectEl.innerHTML = `<option value="">Loading...</option>`;
  try {
    const { res, data } = await fetchJson("/api/audio-library");
    if (!res.ok) throw new Error(data.error);
    const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
    const items = data.items || [];
    selectEl.innerHTML = items.length
      ? `<option value="">Pick a saved clip...</option>` + items.map((it) => `<option value="${it.id}">${typeIcon[it.type] || ""} ${escapeHtml(it.name)}</option>`).join("")
      : `<option value="">Nothing in your library yet.</option>`;
  } catch {
    selectEl.innerHTML = `<option value="">Couldn't load your library.</option>`;
  }
}
document.getElementById("flowBgmLibrarySelect")?.addEventListener("change", async (e) => {
  const id = e.target.value;
  const preview = document.getElementById("flowBgmLibraryPreview");
  if (!id) { preview?.classList.add("d-none"); return; }
  try {
    const { res, data } = await fetchJson("/api/audio-library");
    if (!res.ok) throw new Error(data.error);
    const item = (data.items || []).find((it) => String(it.id) === id);
    if (item) {
      flowBgmAudioBase64 = item.audio; // same variable the upload path sets — Generate & Listen and the final render both already read from this
      if (preview) { preview.src = item.audio; preview.classList.remove("d-none"); }
      document.getElementById("flowBgmUploadStatus").textContent = `Using "${item.name}" from your library instead of generating.`;
    }
  } catch (err) {
    alert("Couldn't load that clip: " + err.message);
  }
});
document.getElementById("flowAudioCollapse")?.addEventListener("show.bs.collapse", populateFlowBgmLibrarySelect, { once: true });
// These two were missing entirely — the backend already supports real
// voice-cloning and BGM-style-matching from a reference clip, but
// nothing was collecting the file or sending it.
document.getElementById("flowVoiceRefUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowVoiceRefAudioBase64 = ev.target.result;
    document.getElementById("flowVoiceRefStatus").textContent = `Will clone a voice from "${file.name}" for the narration above.`;
  };
  reader.readAsDataURL(file);
});
document.getElementById("flowBgmRefUpload")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    flowBgmRefAudioBase64 = ev.target.result;
    document.getElementById("flowBgmRefStatus").textContent = `Will generate BGM styled after "${file.name}".`;
  };
  reader.readAsDataURL(file);
});
document.getElementById("flowAddAudioBtn")?.addEventListener("click", async () => {
  if (!state.flowCurrentVideoBase64) return alert("Generate a video first.");
  const narrationScript = document.getElementById("flowNarrationScript")?.value?.trim();
  const bgmPrompt = document.getElementById("flowBgmPrompt")?.value?.trim();
  if (!narrationScript && !bgmPrompt && !flowNarrationAudioBase64 && !flowBgmAudioBase64 && !flowBgmRefAudioBase64) {
    return alert("Add narration text, a BGM prompt/reference, or upload a clip first.");
  }
  const btn = document.getElementById("flowAddAudioBtn");
  const resultEl = document.getElementById("flowStudioResult");
  const runId = crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Generating and laying audio onto your video...");
  startProgressPolling(runId);
  try {
    const resolvedNarrationVoice = resolveVoiceSelection(document.getElementById("flowNarrationVoiceSelect"));
    const { res, data } = await fetchJson("/api/flow/add-audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        videoBase64: state.flowCurrentVideoBase64,
        narrationScript: flowNarrationAudioBase64 ? null : narrationScript,
        narrationVoiceModel: resolvedNarrationVoice.voiceModel, narrationVoiceId: resolvedNarrationVoice.voiceId,
        narrationAudioBase64: flowNarrationAudioBase64,
        voiceReferenceAudioBase64: flowVoiceRefAudioBase64,
        bgmPrompt: flowBgmAudioBase64 ? null : bgmPrompt,
        bgmModel: readModelSelectEl(document.getElementById("flowBgmModelSelect")),
        bgmAudioBase64: flowBgmAudioBase64,
        bgmReferenceAudioBase64: flowBgmRefAudioBase64,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Adding audio failed.");
    state.flowCurrentVideoBase64 = data.video; // the version WITH audio is now the current one, so further edits/audio layers build on this, not the silent original
    resultEl.innerHTML = `
      <video controls class="w-100 mb-2 rounded" src="${data.video}"></video>
      <p class="xx-small text-muted mb-2">Audio added.</p>
      <a href="${data.video}" data-download-url="${data.video}" data-download-filename="flow-with-audio-${Date.now()}.mp4" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>
    `;
    logActivity("success", "Audio added to the video.");
  } catch (err) {
    alert("Adding audio failed: " + err.message);
    logActivity("warning", `Adding audio failed — ${err.message}`);
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
});
document.querySelectorAll('#voiceStudioSpeed, #voiceStudioPitch').forEach((slider) => {
  slider.addEventListener("input", () => {
    document.querySelector(`[data-range-value="${slider.id}"]`).textContent = slider.value;
  });
});
document.getElementById("audioModeRow")?.addEventListener("show.bs.modal", updateVoiceStudioModelOptions);

// ============================================================
// VOICE SCRIPT EDITOR (Phase 7/8) — the actual replacement for the old
// single-textbox flow. Every line has its own fully independent model/
// voice/language/emotion controls (capability-gated per line, same
// discipline as everywhere else in this app — never shows a control a
// model doesn't really support), and can generate multiple AI-directed
// takes via /api/voice/script/generate-variations.
// ============================================================
function newVoiceScriptLine() {
  const defaultModel = state.voiceModels?.[0];
  return {
    id: "line-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    // REAL GAP FIXED: lines were only ever labeled "Line 1", "Line 2"
    // — meaningless once a script has more than a couple of lines, no
    // way to tell at a glance which is the intro, which is a specific
    // character's part, etc. A real, editable name per line, used
    // everywhere the line gets referenced (saved take names, the
    // Combine result, etc.) instead of just an index number.
    name: "",
    // REAL GAP FIXED: every line used to be exclusively "generate from
    // text" — no way to drop an existing recording or a past library
    // clip directly into the sequential script. "external" swaps the
    // model/voice/text controls for an upload + library picker, and
    // treats whatever's picked as that line's take directly (free,
    // no generation call) — combinable and Mixer-usable exactly like
    // any generated take.
    sourceType: "generate",
    text: "",
    modelId: defaultModel?.id || "",
    voiceId: defaultModel?.confirmedVoiceIds?.[0]?.id || "",
    language: "",
    translateTargetLanguage: "",
    translateStatus: null,
    isTranslating: false,
    previewText: null,
    previewStrippedMarkers: [],
    previewEstimatedSeconds: null,
    intention: "",
    targetDurationSeconds: null,
    // Multi-language code-switching within ONE line (e.g. "Welcome!
    // [Hindi]कैसे हो आप[/Hindi] friend.") — a genuinely different mode
    // from the single translateTargetLanguage above: that translates
    // the WHOLE line into one language; this mixes several within it,
    // each segment generated and translated separately then stitched
    // together. Real backend already existed for this
    // (/api/voice/generate-multilingual) but had no reachable UI.
    multilingualMode: false,
    multilingualBaseLanguage: "english",
    multilingualAutoTagInstruction: "",
    isAutoTagging: false,
    emotion: "neutral",
    speed: 1.0,
    pitch: 0,
    variationCount: 4,
    variations: [],
    selectedVariationIndex: null,
    cappedReason: null,
    isGenerating: false,
  };
}
// Rough, honestly-labeled estimate — real speaking rate varies by
// language, speaker, and content, so this is a planning aid (get a
// sense of pacing/duration BEFORE spending a real generation on it),
// not a guarantee. ~2.5 words/second is a typical average conversational
// pace at 1.0x; the line's own speed multiplier scales it directly,
// same lever that actually reaches the model now (see the real
// speed-passthrough fix in server.js).
function estimateSpeechDurationSeconds(text, speed) {
  const wordCount = (text || "").trim().split(/\s+/).filter(Boolean).length;
  if (!wordCount) return 0;
  return wordCount / (2.5 * (speed || 1.0));
}
// REAL, achievable duration targeting: the only genuine lever any of
// these models exposes is the speed multiplier (see
// supportsEmotionPitchSpeed) — there's no confirmed "generate exactly
// N seconds" parameter for speech the way some music models have.
// Inverts the same word-rate estimate used for the display estimate,
// clamped to the actual real range the speed slider allows (0.5x-2.0x)
// so this can never silently ask for something the model would reject.
function computeSpeedForTargetDuration(text, targetSeconds) {
  const wordCount = (text || "").trim().split(/\s+/).filter(Boolean).length;
  if (!wordCount || !targetSeconds || targetSeconds <= 0) return null;
  const rawSpeed = wordCount / (2.5 * targetSeconds);
  return Math.min(2.0, Math.max(0.5, +rawSpeed.toFixed(1)));
}
// Pure arithmetic, no AI call — for models with a real descriptive-tag
// capability but no formal speed parameter, this is the honest ceiling
// of duration control: comparing natural pace against the target and
// suggesting a real pacing tag only when the gap is big enough to
// matter (small gaps aren't worth cluttering the line with a tag that
// wouldn't audibly change much).
function computePacingTag(text, targetSeconds) {
  const wordCount = (text || "").replace(/\*[^*]+\*/g, "").trim().split(/\s+/).filter(Boolean).length; // strip existing tags — they aren't spoken content, shouldn't count toward pace math
  if (!wordCount || !targetSeconds) return null;
  const natural = wordCount / 2.5;
  if (natural > targetSeconds * 1.3) return "speaking quickly";
  if (natural < targetSeconds * 0.75) return "speaking slowly";
  return null;
}
function renderPacingControlContent(line, pacing) {
  return `<div class="d-flex align-items-center gap-2 mt-2">
    <label class="xx-small text-muted mb-0 text-nowrap">🎯 Target duration</label>
    <input type="number" class="form-control form-control-sm" style="max-width:80px;" min="0.5" step="0.5" data-line-field="targetDurationSeconds" placeholder="sec" value="${line.targetDurationSeconds ?? ""}">
    <span data-line-pacing-suggestion>${renderPacingSuggestion(line, pacing)}</span>
  </div>
  <div class="xx-small text-muted">No formal speed control on this model — but it reads a real pacing cue like *speaking quickly* or *speaking slowly* directly. Not as precise as MiniMax's actual speed number, but genuinely real.</div>`;
}
function renderPacingSuggestion(line, pacing) {
  if (pacing) return `<button type="button" class="btn btn-sm btn-outline-primary text-nowrap" data-line-action="apply-pacing-tag" data-pacing-tag="${pacing}">+ "*${pacing}*"</button>`;
  return line.targetDurationSeconds ? `<span class="xx-small text-muted">pace already close to your target</span>` : "";
}
function renderLinePreviewContent(line) {
  if (!line.previewText?.trim()) return `<span class="text-muted">Nothing to preview yet.</span>`;
  const strippedHtml = line.previewStrippedMarkers?.length
    ? `<div class="text-warning mt-1">⚠️ "${line.previewStrippedMarkers.join('", "')}" won't be spoken — not supported by this model.</div>`
    : "";
  return `<div><strong>👁 Will actually send:</strong> "${escapeHtml(line.previewText)}"</div><div class="text-muted">≈${line.previewEstimatedSeconds ?? 0}s</div>${strippedHtml}`;
}
// Debounced — this is a FREE, instant server call (buildInput is a pure
// transform, no Fal request) but still shouldn't fire on every single
// keystroke; a short pause after typing is enough to feel live without
// spamming requests.
const linePreviewTimers = {};
function scheduleLinePreview(line) {
  clearTimeout(linePreviewTimers[line.id]);
  // Multi-language mode's [Language]...[/Language] tags are parsed and
  // stripped by a DIFFERENT server-side step (parseMultilingualSegments,
  // at actual generation time), not by buildInput — this single-model
  // preview would show the literal tags as if they'd be spoken, which is
  // actively misleading rather than just incomplete. Skipped honestly
  // rather than showing a wrong preview.
  if (line.multilingualMode) return;
  linePreviewTimers[line.id] = setTimeout(async () => {
    if (!line.text?.trim() || !line.modelId) return;
    try {
      const { res, data } = await fetchJson("/api/voice/preview-text-processing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line.text, modelId: line.modelId, voiceId: line.voiceId, language: line.language || undefined, speed: line.speed, pitch: line.pitch, emotion: line.emotion }),
      });
      if (!res.ok) return;
      line.previewText = data.finalSpokenText;
      line.previewStrippedMarkers = data.strippedMarkers || [];
      line.previewEstimatedSeconds = data.estimatedSeconds;
      const lineEl = document.querySelector(`[data-line-id="${line.id}"]`);
      const previewEl = lineEl?.querySelector("[data-line-preview]");
      if (previewEl) previewEl.innerHTML = renderLinePreviewContent(line);
    } catch {} // best-effort — a failed preview shouldn't block anything, real generation will surface any real error
  }, 400);
}
// REAL BUG THIS CATCHES: the language dropdown only sets the model's
// pronunciation/language_code parameter — it does NOT translate
// anything. Picking "Hindi" there while the text is still plain English
// sends a model conflicting signals ("read this AS Hindi" + English-
// script text), which is exactly what produced broken/truncated output
// (e.g. Gemini only vocalizing one recognizable word from the whole
// line) with zero warning beforehand. Matches against
// state.scriptRanges — the exact same source of truth server-side
// translation validation uses, so this can't quietly drift from it.
function languageScriptMismatch(text, language) {
  if (!text?.trim() || !language) return null;
  const baseLang = language.replace(/\s*\(.+\)\s*$/, "").trim(); // "Hindi (India)" -> "Hindi"
  const pattern = state.scriptRanges?.[baseLang];
  if (!pattern) return null; // no known script check for this language (e.g. English/auto) — nothing to warn about
  const re = new RegExp(pattern);
  return re.test(text) ? null : baseLang;
}
function buildScriptMismatchHtml(mismatchLang) {
  if (!mismatchLang) return "";
  return `<div class="alert alert-warning py-1 px-2 xx-small mt-1 mb-0" data-line-mismatch-warning>⚠️ You picked ${escapeHtml(mismatchLang)} but this text has no ${escapeHtml(mismatchLang)} script in it yet — the model will get conflicting signals (real broken output, not a hypothetical). <button type="button" class="btn btn-link btn-sm p-0 xx-small" data-line-action="quick-translate">Translate it now →</button></div>`;
}
function renderLineMismatchWarning(lineEl, line) {
  const container = lineEl.querySelector("[data-line-mismatch-container]");
  if (!container) return;
  container.innerHTML = buildScriptMismatchHtml(languageScriptMismatch(line.text, line.language));
}
// Shared by both the normal Translate button and the mismatch warning's
// "Translate it now" quick-fix — one real code path, not two that could
// drift apart.
async function translateLine(line, targetLanguage) {
  line.isTranslating = true;
  renderVoiceScript();
  try {
    const { res, data } = await fetchJson("/api/voice/prepare-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line.text, targetLanguage, textModel: getTextModel(), userApiKey: getUserKey(), runId: state.voiceScript.runId }),
    });
    if (!res.ok) throw new Error(data.error || "Translation failed.");
    line.text = data.preparedText;
    line.previewText = null; // stale — refreshed below
    if (data.scriptValidationFailed) {
      line.translateStatus = { warn: true, text: `Couldn't confirm real ${targetLanguage} script even after retrying — check the result before generating.` };
    } else if (data.transliterationDetected) {
      line.translateStatus = { warn: true, text: `This came out as transliteration on the first pass and was retried — double-check it reads as real ${targetLanguage}, not English words spelled out phonetically.` };
    } else {
      line.translateStatus = { warn: false, text: `Translated to ${targetLanguage}.` };
    }
    // Auto-align the model's own language parameter (a DIFFERENT
    // setting — see languageRowHtml) with what was just translated
    // into, when the current model actually has a matching option.
    const currentModel = (state.voiceModels || []).find((m) => m.id === line.modelId);
    const match = (currentModel?.confirmedLanguages || []).find((l) => l.toLowerCase().startsWith(targetLanguage.toLowerCase()));
    if (match) line.language = match;
  } catch (err) {
    line.translateStatus = { warn: true, text: "Translation failed: " + err.message };
  } finally {
    line.isTranslating = false;
    renderVoiceScript();
    scheduleLinePreview(line);
  }
}
// ============================================================
// REQUIREMENTS-FIRST FILTER — "tell me what you need, only show me
// options that actually work," applied to every line's model/voice
// dropdowns rather than showing the full unfiltered catalog and hoping
// the person picks something compatible. Language filtering checks
// each model's REAL confirmed/discovered/auto-detected language
// coverage (the same data Phase 1's dynamic loading already computes) —
// never a guess. Gender filtering reads the REAL hand-written
// description text on each curated voice (e.g. "Mature female,
// measured...") — genuinely present data, not fabricated; a voice with
// no description (a live-discovered or custom one) is never excluded
// by a gender filter, since there's no way to honestly know either way.
// ============================================================
state.voiceRequirements = state.voiceRequirements || { language: "", gender: "" };
function populateVoiceRequirementLanguages() {
  const sel = document.getElementById("voiceRequirementLanguage");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">Any language</option>${(state.voiceoverLanguages || []).map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("")}`;
  sel.value = current;
}
function modelMatchesLanguageRequirement(model, requiredLanguage) {
  if (!requiredLanguage) return true;
  const pool = [...(model.confirmedLanguages || []), ...(model.autoDetectedLanguagesSupported || [])];
  return pool.some((l) => l.toLowerCase().startsWith(requiredLanguage.toLowerCase()));
}
function voiceMatchesGenderRequirement(voice, gender) {
  if (!gender || !voice.description) return true; // no description to check — never excluded, since we can't honestly confirm either way
  return voice.description.toLowerCase().includes(gender);
}
document.getElementById("voiceRequirementLanguage")?.addEventListener("change", (e) => {
  state.voiceRequirements.language = e.target.value;
  renderVoiceScript();
});
document.getElementById("voiceRequirementGender")?.addEventListener("change", (e) => {
  state.voiceRequirements.gender = e.target.value;
  renderVoiceScript();
});
function renderVoiceScriptLine(line, index) {
  const model = (state.voiceModels || []).find((m) => m.id === line.modelId) || null;
  // 🇮🇳 = Indian-language-capable (server-sorted first). 🎯 = a model
  // BUILT for one specific language, not a generalist that happens to
  // cover it as one of 30 — a real, useful distinction someone asking
  // for "local/regional voice models" actually wants visible, not
  // buried in a label string.
  const requirements = state.voiceRequirements || {};
  const eligibleModels = (state.voiceModels || []).filter((m) => modelMatchesLanguageRequirement(m, requirements.language));
  // The line's own currently-selected model might not match a filter
  // just applied — keep it selectable regardless (never silently yank
  // away what's already chosen), just don't let it look like the ONLY
  // real option by hiding everything else that would also work.
  const modelPool = eligibleModels.some((m) => m.id === line.modelId) || !line.modelId
    ? eligibleModels
    : [...eligibleModels, ...(state.voiceModels || []).filter((m) => m.id === line.modelId)];
  const requirementNoteHtml = requirements.language && eligibleModels.length < (state.voiceModels || []).length
    ? `<div class="xx-small text-muted mb-1">Showing ${eligibleModels.length} of ${(state.voiceModels || []).length} models confirmed for ${escapeHtml(requirements.language)}.</div>`
    : "";
  const modelOptions = modelPool
    .map((m) => {
      const badge = `${m.indianLanguageCoverage?.length ? "🇮🇳 " : ""}${m.isDedicatedRegionalModel ? "🎯 " : ""}`;
      return `<option value="${escapeHtml(m.id)}" ${m.id === line.modelId ? "selected" : ""}>${badge}${escapeHtml(m.label)}</option>`;
    })
    .join("");

  let voiceControlHtml;
  if (model?.voiceInputMode === "freeform" || (!model?.confirmedVoiceIds?.length && model)) {
    voiceControlHtml = `<input type="text" class="form-control form-control-sm" data-line-field="voiceId" value="${escapeHtml(line.voiceId || "")}" placeholder="Voice name (this model has no fixed list)">`;
  } else if (model?.confirmedVoiceIds?.length) {
    const totalVoices = model.confirmedVoiceIds.length;
    // Live-discovered voices (pulled straight from Fal's own schema,
    // see fal-voice-catalog.js's withLiveDiscoveredData) have no
    // human-written description yet — flagged honestly with 🆕 rather
    // than pretending they're as vetted as a curated entry.
    const opts = model.confirmedVoiceIds
      .filter((v) => voiceMatchesGenderRequirement(v, requirements.gender) || v.id === line.voiceId) // never hide the currently-selected voice, same "don't yank away an active choice" rule as the model filter above
      .map((v) => {
        const isLive = v.source === "live";
        const label = isLive ? `🆕 ${v.id} — newly discovered, not yet verified` : `${v.id}${v.description ? ` — ${v.description}` : ""}`;
        const searchKey = `${v.id} ${v.description || ""}`.toLowerCase();
        return `<option value="${escapeHtml(v.id)}" data-search="${escapeHtml(searchKey)}" ${v.id === line.voiceId ? "selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
    // REAL GAP FIXED: cloned voices (see the Voice Clone section) were
    // saved and usable via the backend the whole time, but never
    // appeared anywhere in this picker — matched by modelFamily since a
    // clone is only usable on the same family it was made for (MiniMax's
    // clone endpoint outputs a MiniMax-compatible voice_id).
    const matchingCustomVoices = model.modelFamily
      ? (state.customVoices || []).filter((cv) => cv.model_family === model.modelFamily)
      : [];
    const customOpts = matchingCustomVoices
      .map((cv) => `<option value="${escapeHtml(cv.custom_voice_id)}" data-search="${escapeHtml(cv.name.toLowerCase())}" ${cv.custom_voice_id === line.voiceId ? "selected" : ""}>🎙️ ${escapeHtml(cv.name)} (your cloned voice)</option>`)
      .join("");
    const totalVoicesWithCustom = totalVoices + matchingCustomVoices.length;
    // A native <select> stops being usable once a model's real voice
    // count climbs into the dozens/hundreds (MiniMax alone lists 300+ on
    // its own page) — this is the direct, concrete cost of the dynamic
    // load actually working, so a filter box earns its place here
    // rather than being decoration.
    const searchHtml = totalVoicesWithCustom > 10
      ? `<input type="text" class="form-control form-control-sm mb-1" data-line-field="voiceSearch" placeholder="🔎 Search ${totalVoicesWithCustom} voices...">`
      : "";
    const discovery = model.voiceDiscovery;
    const discoveryNote = discovery?.liveDiscoveredVoiceCount > 0
      ? `<div class="xx-small text-muted mt-1">${discovery.curatedVoiceCount} known + ${discovery.liveDiscoveredVoiceCount} newly discovered live from Fal 🆕</div>`
      : "";
    voiceControlHtml = `${searchHtml}<div class="d-flex gap-1"><select class="form-select form-select-sm" data-line-field="voiceId">${customOpts}${opts}</select><button type="button" class="btn btn-sm btn-outline-secondary text-nowrap" data-line-action="preview-voice" title="Hear a short sample of this exact voice — cached, so repeat previews are free">🔊</button></div>${discoveryNote}`;
  } else {
    voiceControlHtml = `<div class="form-control form-control-sm text-muted bg-light">Pick a model first</div>`;
  }

  const indianLangSet = new Set((model?.indianLanguageCoverage || []).map((l) => l.toLowerCase()));
  const languageRowHtml = model?.confirmedLanguages?.length && !line.multilingualMode
    ? `<select class="form-select form-select-sm mt-2" data-line-field="language">
        <option value="">Auto / default</option>
        ${model.confirmedLanguages.map((l) => `<option value="${escapeHtml(l)}" ${l === line.language ? "selected" : ""}>${indianLangSet.has(l.toLowerCase()) ? "🇮🇳 " : ""}${escapeHtml(l)}</option>`).join("")}
      </select>`
    : "";
  const scriptMismatch = line.multilingualMode ? null : languageScriptMismatch(line.text, line.language);
  const scriptMismatchHtml = buildScriptMismatchHtml(scriptMismatch);

  // Translation, wired to the REAL, already-tested backend
  // (/api/voice/prepare-text — real transliteration detection + native-
  // script validation with retry) that existed but had no reachable UI
  // anywhere in the active Voice Studio. Deliberately independent of
  // whether the model has its own confirmedLanguages parameter — a
  // model like ElevenLabs Eleven v3 has NO language field at all and
  // only auto-detects from the text's own script, which makes
  // translating into real native script BEFORE generation the only way
  // Indian-language output happens correctly on it at all, not optional
  // polish.
  const translateToolbarHtml = `
    <div class="d-flex gap-1 align-items-center mt-1 mb-1">
      <select class="form-select form-select-sm" style="max-width:160px;" data-line-field="translateTargetLanguage" ${line.multilingualMode ? "disabled" : ""}>
        <option value="">Translate to...</option>
        ${(state.voiceoverLanguages || []).map((l) => `<option value="${escapeHtml(l)}" ${l === line.translateTargetLanguage ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}
      </select>
      <button type="button" class="btn btn-sm btn-outline-primary" data-line-action="translate" ${line.isTranslating || !line.translateTargetLanguage || line.multilingualMode ? "disabled" : ""}>${line.isTranslating ? "🌐 Translating..." : "🌐 Translate"}</button>
      <div class="form-check form-switch mb-0 ms-2">
        <input class="form-check-input" type="checkbox" data-line-field="multilingualMode" id="multilingualToggle-${line.id}" ${line.multilingualMode ? "checked" : ""}>
        <label class="form-check-label xx-small" for="multilingualToggle-${line.id}">Mix languages in this line</label>
      </div>
    </div>
    ${line.translateStatus && !line.multilingualMode ? `<div class="xx-small ${line.translateStatus.warn ? "text-warning" : "text-success"} mb-1">${escapeHtml(line.translateStatus.text)}</div>` : ""}
    ${line.multilingualMode ? `
      <div class="border rounded p-2 mb-1 bg-light">
        <div class="xx-small text-muted mb-1">Wrap the parts that should switch language: <code>Welcome! [Hindi]कैसे हो आप[/Hindi] friend.</code> — everything else is spoken as the base language below.</div>
        <div class="d-flex gap-1 mb-1">
          <select class="form-select form-select-sm" style="max-width:140px;" data-line-field="multilingualBaseLanguage">
            <option value="english" ${line.multilingualBaseLanguage === "english" ? "selected" : ""}>Base: English</option>
            ${(state.voiceoverLanguages || []).map((l) => `<option value="${escapeHtml(l)}" ${l === line.multilingualBaseLanguage ? "selected" : ""}>Base: ${escapeHtml(l)}</option>`).join("")}
          </select>
          <input type="text" class="form-control form-control-sm" data-line-field="multilingualAutoTagInstruction" placeholder="e.g. make the greeting Hindi" value="${escapeHtml(line.multilingualAutoTagInstruction)}">
          <button type="button" class="btn btn-sm btn-outline-primary text-nowrap" data-line-action="auto-tag" ${line.isAutoTagging || !line.multilingualAutoTagInstruction?.trim() ? "disabled" : ""}>${line.isAutoTagging ? "✨..." : "✨ Auto-tag"}</button>
        </div>
      </div>
    ` : ""}
  `;

  // REAL duration control, not just an estimate: for the 2 models that
  // actually confirm a speed parameter (see supportsEmotionPitchSpeed),
  // this auto-computes and applies the speed multiplier needed to hit
  // the target — the only genuine lever that exists for TTS duration,
  // since none of these models take a literal "generate N seconds"
  // parameter the way some music models do. For the other 6 models,
  // shown honestly disabled rather than pretending it works — no
  // confirmed speed field means no real way to actively hit a target.
  const targetDurationHtml = model?.supportsEmotionPitchSpeed
    ? `<div class="d-flex align-items-center gap-2 mt-2">
        <label class="xx-small text-muted mb-0 text-nowrap">🎯 Target duration</label>
        <input type="number" class="form-control form-control-sm" style="max-width:80px;" min="0.5" step="0.5" data-line-field="targetDurationSeconds" placeholder="sec" value="${line.targetDurationSeconds ?? ""}">
        <span class="xx-small text-muted" data-line-target-speed-note>${line.targetDurationSeconds ? `→ speed set to ${line.speed}x` : "sets speed automatically"}</span>
      </div>`
    : model?.markupTagMode === "freeform"
    // REAL point you made: no confirmed speed PARAMETER doesn't mean no
    // lever at all — these models read descriptive delivery tags
    // directly, and "speaking quickly"/"speaking slowly" is a genuine,
    // real instruction within that same confirmed capability, just not
    // a formal numeric control. Computed and suggested with zero AI
    // calls — pure arithmetic on word count vs target, same estimate
    // math already used elsewhere, so this costs nothing to offer.
    ? (() => {
        const pacing = computePacingTag(line.text, line.targetDurationSeconds);
        return `<div data-line-pacing-container>${renderPacingControlContent(line, pacing)}</div>`;
      })()
    : `<div class="xx-small text-muted mt-2">🎯 This model has no confirmed speed parameter or descriptive-tag capability — duration can't be actively influenced, only estimated below. Switch to MiniMax (real speed control) or ElevenLabs/Gemini (pacing tags) for duration control.</div>`;
  const emotionRowHtml = model?.supportsEmotionPitchSpeed
    ? `<div class="row g-2 mt-2">
        <div class="col-4"><label class="xx-small text-muted mb-0">Speed ${line.speed}</label><input type="range" class="form-range" data-line-field="speed" min="0.5" max="2.0" step="0.1" value="${line.speed}"></div>
        <div class="col-4"><label class="xx-small text-muted mb-0">Pitch ${line.pitch}</label><input type="range" class="form-range" data-line-field="pitch" min="-12" max="12" step="1" value="${line.pitch}"></div>
        <div class="col-4"><label class="xx-small text-muted mb-0">Emotion</label><select class="form-select form-select-sm" data-line-field="emotion">${(model.confirmedEmotions || []).map((e) => `<option value="${e}" ${e === line.emotion ? "selected" : ""}>${e}</option>`).join("")}</select></div>
      </div>`
    : "";
  // Real, honestly-labeled planning estimate — see estimateSpeechDurationSeconds.
  // Recomputed live as text/speed change (see the input listener below),
  // not just at render time, so it stays accurate while typing.
  const durationEstimateHtml = `<div class="xx-small text-muted mt-1" data-line-duration-estimate>≈${estimateSpeechDurationSeconds(line.text, line.speed).toFixed(1)}s estimated (rough — actual pace varies by model/language)</div>`;
  // Real, free, accurate preview — see /api/voice/preview-text-processing
  // (a pure text transform, no Fal call, no cost). Shows exactly what
  // the model will actually receive/speak BEFORE any real generation:
  // catches a *tag* that this specific model doesn't support (silently
  // stripped otherwise) and gives a duration estimate off the REAL
  // spoken text, not the raw typed text. Populated live via a debounced
  // fetch — see the input listener below — so this starts empty and
  // fills in shortly after typing pauses.
  const previewHtml = line.multilingualMode ? "" : `<div class="border rounded p-2 mt-1 mb-1 bg-light xx-small" data-line-preview>${line.previewText != null ? renderLinePreviewContent(line) : `<span class="text-muted">👁 Preview loads as you type...</span>`}</div>`;

  const estimatedSecondsNow = estimateSpeechDurationSeconds(line.text, line.speed);
  const variationsHtml = line.variations.length
    ? `<div class="d-flex flex-column gap-2 mt-2">${line.variations
        .map(
          (v, i) => {
            // Real anomaly flag, not decoration: when actual duration is
            // wildly off from the estimate (>2.5x longer or <0.4x
            // shorter), that's a genuine signal something went wrong in
            // generation — most commonly a language/script mismatch (see
            // languageScriptMismatch above) or a model padding/extending
            // a very short input unpredictably. Surfaced right on the
            // take instead of leaving a bad clip looking identical to a
            // good one.
            const actualSeconds = v.durationMs ? v.durationMs / 1000 : null;
            const isAnomalous = actualSeconds && estimatedSecondsNow > 0.5 &&
              (actualSeconds > estimatedSecondsNow * 2.5 || actualSeconds < estimatedSecondsNow * 0.4);
            return `
      <div class="border rounded p-2 ${line.selectedVariationIndex === i ? "border-primary bg-light" : ""}" data-variation-index="${i}">
        <div class="d-flex justify-content-between align-items-center">
          <span class="small fw-semibold">${escapeHtml(v.label)}${line.selectedVariationIndex === i ? " ✅" : ""}</span>
          <div class="d-flex align-items-center gap-1">
            ${v.audio ? (v.durationMs ? `<span class="xx-small ${isAnomalous ? "text-danger fw-semibold" : "text-muted"}">${actualSeconds.toFixed(1)}s${isAnomalous ? " ⚠️" : ""}</span>` : `<span class="xx-small text-muted fst-italic" title="This model's API response doesn't include a duration field">duration n/a</span>`) : ""}
            ${v.audio ? `<button type="button" class="btn btn-sm btn-outline-primary" data-variation-action="use">Use this take</button><button type="button" class="btn btn-sm btn-outline-secondary" data-variation-action="download">⬇️</button>` : ""}
          </div>
        </div>
        ${isAnomalous ? `<div class="xx-small text-danger">⚠️ ${actualSeconds.toFixed(1)}s actual vs ~${estimatedSecondsNow.toFixed(1)}s expected — often a language/script mismatch (see the warning above if present) or a model adding unexpected silence/padding on a short line. Listen before using this take.</div>` : ""}
        ${v.reasoning ? `<div class="xx-small text-muted">${escapeHtml(v.reasoning)}</div>` : ""}
        ${v.error ? `<div class="xx-small text-danger">Failed: ${escapeHtml(v.error)}</div>` : v.audio ? `<audio class="w-100 mt-1" controls src="${v.audio}"></audio>` : ""}
        ${v.strippedMarkers?.length ? `<div class="xx-small text-warning">⚠️ "${v.strippedMarkers.join('", "')}" wasn't spoken by this model.</div>` : ""}
        ${v.segments?.length ? `<div class="xx-small text-muted mt-1">${v.segments.map((s) => `<span class="badge bg-secondary me-1">${escapeHtml(s.language)}</span>${escapeHtml(s.finalText)}${s.note ? ` <span class="text-warning">(${escapeHtml(s.note)})</span>` : ""}`).join("<br>")}</div>` : ""}
      </div>`;
          },
        )
        .join("")}</div>`
    : "";
  const cappedNote = line.cappedReason ? `<div class="alert alert-warning py-1 px-2 xx-small mt-2 mb-0">${escapeHtml(line.cappedReason)}</div>` : "";

  return `
  <div class="card border" data-line-id="${line.id}">
    <div class="card-body p-3">
      <div class="d-flex justify-content-between align-items-center mb-2 gap-2">
        <span class="text-muted small flex-shrink-0">${index + 1}.</span>
        <input type="text" class="form-control form-control-sm fw-bold" data-line-field="name" value="${escapeHtml(line.name || "")}" placeholder="Name this line (e.g. Intro, Priya's part, Call to action)">
        <div class="d-flex gap-1 flex-shrink-0">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-line-action="moveUp" ${index === 0 ? "disabled" : ""} title="Move up">↑</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-line-action="moveDown" title="Move down">↓</button>
          <button type="button" class="btn btn-sm btn-outline-danger" data-line-action="delete" title="Delete line">✕</button>
        </div>
      </div>
      <div class="btn-group btn-group-sm w-100 mb-2" role="group">
        <input type="radio" class="btn-check" name="lineSource-${line.id}" id="lineSourceGen-${line.id}" autocomplete="off" ${line.sourceType !== "external" ? "checked" : ""} data-line-field="sourceType" value="generate">
        <label class="btn btn-outline-dark" for="lineSourceGen-${line.id}">✨ Generate from text</label>
        <input type="radio" class="btn-check" name="lineSource-${line.id}" id="lineSourceExt-${line.id}" autocomplete="off" ${line.sourceType === "external" ? "checked" : ""} data-line-field="sourceType" value="external">
        <label class="btn btn-outline-dark" for="lineSourceExt-${line.id}">📁 Use existing audio</label>
      </div>
      ${line.sourceType === "external" ? `
      <div class="border rounded p-2 bg-light mb-2">
        <div class="xx-small text-muted mb-2">Drop in a recording, an upload, or anything already in your Audio Library — used as this line's take directly, free, no generation call.</div>
        <div class="d-flex gap-2 mb-2">
          <label class="btn btn-sm btn-outline-dark flex-grow-1 mb-0" for="extUpload-${line.id}">📁 Upload a file</label>
          <input type="file" accept="audio/*" class="d-none" data-line-action="external-upload" id="extUpload-${line.id}">
        </div>
        <select class="form-select form-select-sm" data-line-action="external-library">
          <option value="">Or pick from your Audio Library...</option>
        </select>
      </div>
      ${variationsHtml}
      ` : `
      <textarea class="form-control form-control-sm mb-1" rows="2" data-line-field="text" placeholder="Type this line...">${escapeHtml(line.text)}</textarea>
      ${durationEstimateHtml}
      ${previewHtml}
      ${translateToolbarHtml}
      ${buildVoiceMarkupToolbarHtml(model, line)}
      <small class="text-muted d-block mb-2">${escapeHtml(model?.markupHint || "Pick a model to see what stage-direction markup it supports.")}</small>
      ${requirementNoteHtml}
      <div class="row g-2">
        <div class="col-6"><select class="form-select form-select-sm" data-line-field="modelId">${modelOptions}</select></div>
        <div class="col-6">${voiceControlHtml}</div>
      </div>
      ${languageRowHtml}
      <div data-line-mismatch-container>${scriptMismatchHtml}</div>
      ${emotionRowHtml}
      ${targetDurationHtml}
      <div class="d-flex align-items-center gap-2 mt-2">
        ${line.multilingualMode ? "" : `
        <label class="xx-small text-muted mb-0">Takes:</label>
        <select class="form-select form-select-sm" style="width:auto" data-line-field="variationCount">
          ${[1, 2, 4, 8].map((n) => `<option value="${n}" ${n === line.variationCount ? "selected" : ""}>${n}</option>`).join("")}
        </select>`}
        <button type="button" class="btn btn-sm btn-primary flex-grow-1" data-line-action="generate" ${line.isGenerating ? "disabled" : ""}>${line.isGenerating ? "Generating..." : line.multilingualMode ? "🌐 Generate Multi-language Take" : "🎬 Generate Takes"}</button>
      </div>
      ${cappedNote}
      ${variationsHtml}
      `}
    </div>
  </div>`;
}
function renderVoiceScript() {
  const container = document.getElementById("voiceScriptLines");
  if (!container) return;
  if (!state.voiceScript.lines.length) {
    container.innerHTML = `<p class="text-muted small mb-0">No lines yet — click "Add Line" below to start building your script.</p>`;
    return;
  }
  container.innerHTML = state.voiceScript.lines.map((line, i) => renderVoiceScriptLine(line, i)).join("");
}
// Populates one line's "pick from Audio Library" select with every
// real type (voice/song/sfx/upload/mix) — not narrowed, since any of
// them could reasonably be dropped into a sequential script (a past
// combined take, a sound effect between lines, anything).
async function populateLineExternalLibrarySelect(lineId) {
  const lineEl = document.querySelector(`[data-line-id="${lineId}"]`);
  const selectEl = lineEl?.querySelector('[data-line-action="external-library"]');
  if (!selectEl) return;
  try {
    const { res, data } = await fetchJson("/api/audio-library");
    if (!res.ok) throw new Error(data.error);
    const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
    const items = data.items || [];
    selectEl.innerHTML = `<option value="">Or pick from your Audio Library...</option>` +
      items.map((it) => `<option value="${it.id}">${typeIcon[it.type] || ""} ${escapeHtml(it.name)}</option>`).join("");
  } catch {
    selectEl.innerHTML = `<option value="">Couldn't load your library.</option>`;
  }
}
// Sets an external clip (uploaded or picked from the library) as this
// line's take directly — same real shape a generated take has
// ({label, audio, audioUrl}), so Combine and the Mixer both treat it
// identically, just with audioUrl left null (base64 only) — the
// Combine handler above already falls back to .audio for exactly this.
function setLineExternalClip(lineId, audioDataUri, label) {
  const line = state.voiceScript.lines.find((l) => l.id === lineId);
  if (!line) return;
  line.variations = [{ label, audio: audioDataUri, audioUrl: null, isExternal: true }];
  line.selectedVariationIndex = 0;
  renderVoiceScript();
  saveVoiceScriptSession();
}
document.getElementById("voiceScriptLines")?.addEventListener("change", (e) => {
  const lineEl = e.target.closest("[data-line-id]");
  if (!lineEl) return;
  const lineId = lineEl.getAttribute("data-line-id");
  if (e.target.matches('[data-line-action="external-upload"]')) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setLineExternalClip(lineId, ev.target.result, `📁 ${file.name}`);
    reader.readAsDataURL(file);
  } else if (e.target.matches('[data-line-action="external-library"]')) {
    const id = e.target.value;
    if (!id) return;
    const selectedText = e.target.selectedOptions[0]?.textContent || "Library clip";
    fetchJson("/api/audio-library").then(({ res, data }) => {
      if (!res.ok) return;
      const item = (data.items || []).find((it) => String(it.id) === id);
      if (item) setLineExternalClip(lineId, item.audio, selectedText.trim());
    });
  }
});
// ============================================================
// SESSION PERSISTENCE — real ask: "changes shouldn't impact what we
// already did." Autosaves the script's real structure (text, model,
// voice, language, emotion, speed, target duration, intention — every
// setting) plus each take's real Fal-hosted URL to localStorage, so a
// reload, an accidental modal close, or the browser tab closing doesn't
// silently discard work. Deliberately does NOT persist the base64 audio
// blobs themselves (would blow past localStorage's real ~5-10MB quota
// after a handful of takes) — the real Fal URL survives instead, so a
// restored take can still be played by re-fetching, and the honest
// tradeoff is stated in the UI note rather than pretending the blob
// itself was safely kept.
// ============================================================
function saveVoiceScriptSession() {
  try {
    const lightweight = {
      lines: (state.voiceScript?.lines || []).map((l) => ({ ...l, variations: (l.variations || []).map((v) => ({ ...v, audio: null })) })),
      runId: state.voiceScript?.runId,
    };
    localStorage.setItem("voiceScriptSession", JSON.stringify(lightweight));
  } catch {} // storage quota or private-browsing mode — best-effort only, never blocks the actual feature
}
function restoreVoiceScriptSession() {
  try {
    const saved = localStorage.getItem("voiceScriptSession");
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    return parsed?.lines?.length ? parsed : null;
  } catch {
    return null;
  }
}
let sessionSaveTimer = null;
function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveVoiceScriptSession, 600);
}
// ============================================================
// MIXER SESSION PERSISTENCE — the real fix for a real, longstanding
// gap: the Mixer's whole arrangement (Main Track, Intro, Outro,
// Background, Overlays) only ever lived in browser memory, never saved
// anywhere. Every page reload — including every time a new patch got
// applied and the server restarted — silently wiped it, with no
// warning. This isn't new-session-button behavior; it happened
// automatically, which is exactly the kind of "unnecessary" surprise
// worth fixing properly rather than working around.
//
// Genuinely better than Voice Studio's own session save above: every
// Mixer item already comes from the real, server-side Audio Library
// (never lost to a reload), so only a tiny reference (library item id
// + whatever edit settings were applied) needs to live in localStorage
// — restoring re-fetches the real audio from the library rather than
// needing to keep a copy of it, so the restored arrangement is fully
// playable immediately, not just structurally present.
// ============================================================
function mixerItemRef(item) {
  return item ? { id: item.id, edit: item.edit || null } : null;
}
function saveMixerSession() {
  try {
    const session = {
      mainTrack: state.mixerMainTrack.map(mixerItemRef),
      intro: mixerItemRef(state.mixerIntro),
      outro: mixerItemRef(state.mixerOutro),
      background: mixerItemRef(state.mixerBackground),
      overlays: state.mixerOverlays.map((ov) => ({ item: mixerItemRef(ov.item), delaySeconds: ov.delaySeconds, volume: ov.volume })),
      backgroundVolume: document.getElementById("mixerBackgroundVolume")?.value,
      backgroundDuck: document.getElementById("mixerBackgroundDuck")?.checked,
      durationMode: document.getElementById("mixerDurationMode")?.value,
    };
    localStorage.setItem("mixerSession", JSON.stringify(session));
  } catch {} // storage quota or private-browsing mode — best-effort only, never blocks the actual feature
}
let mixerSessionSaveTimer = null;
function scheduleMixerSessionSave() {
  clearTimeout(mixerSessionSaveTimer);
  mixerSessionSaveTimer = setTimeout(saveMixerSession, 600);
}
async function restoreMixerSession() {
  let saved;
  try {
    const raw = localStorage.getItem("mixerSession");
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch {
    return;
  }
  await loadMixerLibrary(); // need the real library loaded first so each saved reference can be matched back to its actual playable audio
  const rehydrate = (ref) => {
    if (!ref) return null;
    const libItem = (state.mixerLibraryItems || []).find((it) => String(it.id) === String(ref.id));
    // A referenced item that's since been deleted from the library
    // can't be restored — honestly dropped rather than shown broken.
    return libItem ? { ...libItem, edit: ref.edit || {} } : null;
  };
  state.mixerMainTrack = (saved.mainTrack || []).map(rehydrate).filter(Boolean);
  state.mixerIntro = rehydrate(saved.intro);
  state.mixerOutro = rehydrate(saved.outro);
  state.mixerBackground = rehydrate(saved.background);
  state.mixerOverlays = (saved.overlays || [])
    .map((ov) => ({ item: rehydrate(ov.item), delaySeconds: ov.delaySeconds, volume: ov.volume }))
    .filter((ov) => ov.item);
  if (saved.backgroundVolume != null) { const el = document.getElementById("mixerBackgroundVolume"); if (el) el.value = saved.backgroundVolume; }
  if (saved.backgroundDuck != null) { const el = document.getElementById("mixerBackgroundDuck"); if (el) el.checked = saved.backgroundDuck; }
  if (saved.durationMode) { const el = document.getElementById("mixerDurationMode"); if (el) el.value = saved.durationMode; }
}
document.getElementById("mixerBackgroundVolume")?.addEventListener("change", scheduleMixerSessionSave);
document.getElementById("mixerBackgroundDuck")?.addEventListener("change", scheduleMixerSessionSave);
document.getElementById("mixerDurationMode")?.addEventListener("change", scheduleMixerSessionSave);
document.getElementById("audioModeRow")?.addEventListener("show.bs.modal", () => {
  if (!state.voiceScript) {
    const restored = restoreVoiceScriptSession();
    state.voiceScript = restored || { lines: [], runId: null };
  }
  if (!state.voiceScript.runId) state.voiceScript.runId = crypto.randomUUID();
  if (!state.voiceScript.lines.length) state.voiceScript.lines.push(newVoiceScriptLine());
  renderVoiceScript();
});
document.getElementById("voiceScriptAddLineBtn")?.addEventListener("click", () => {
  state.voiceScript.lines.push(newVoiceScriptLine());
  renderVoiceScript();
  saveVoiceScriptSession();
});
// System-based combine — NOT an AI call, deterministic ffmpeg
// concatenation of each line's currently-selected take, in script
// order. Needs the ORIGINAL Fal-hosted URL (audioUrl), not the base64
// data URI kept for playback — Fal's merge endpoint takes real URLs.
// Shared by Combine and the Mixer Console — a locally-rendered result
// comes back as {downloadUrl, sizeBytes} (a real file on this app's own
// disk, served via /api/flow/download/:filename — the same route
// video-stitcher.js's local fallback already uses), while a Fal-cloud
// result comes back as {audio, audioUrl} (base64 + a hosted URL). Both
// are real, valid outcomes depending on which path actually ran —
// rendering only one shape would silently break whichever one wasn't
// anticipated.
function renderAudioResult(resultEl, data, downloadFilenameBase) {
  if (data.downloadUrl) {
    resultEl.innerHTML += `<audio controls class="w-100 mb-1" src="${data.downloadUrl}"></audio><a href="${data.downloadUrl}" download class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download (${(data.sizeBytes / 1024).toFixed(0)} KB)</a>`;
  } else if (data.audio) {
    resultEl.innerHTML += `<audio controls class="w-100 mb-1" src="${data.audio}"></audio><a href="${data.audio}" data-download-url="${data.audio}" data-download-filename="${downloadFilenameBase}-${Date.now()}.mp3" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>`;
  }
  // Real "use it anywhere afterward" fix: every combine/mix path now
  // auto-saves server-side (see server.js's saveLocalRenderToLibrary) —
  // this note applies to any of them uniformly, so a result from the
  // Mixer, a plain sequential combine, or a background mix all get the
  // same visible confirmation and path back into the library, instead
  // of each one growing its own copy of this same message.
  if (data.libraryItemId) {
    resultEl.innerHTML += `<div class="xx-small text-success mt-1">✅ Saved to your Audio Library — reusable in any Main Track, Intro, Outro, Background, or Overlay slot in the Mixer from now on.</div>`;
  }
}
// ============================================================
// MIXER CONSOLE — arrange anything already in the Audio Library
// (voice takes, songs, SFX — all three, not just songs like the
// Combine picker above) onto a Main track (sequential) plus one
// optional Background track (looped, volume-reduced, plays under the
// whole main track). Renders via /api/audio/mixer/render — 100% local
// ffmpeg, no AI call, no per-render API cost.
// ============================================================
state.mixerMainTrack = state.mixerMainTrack || []; // array of library item objects, in play order
state.mixerBackground = state.mixerBackground || null; // one library item object, or null

document.getElementById("mixerFfmpegWarning")?.addEventListener("click", (e) => {
  if (e.target.closest("#mixerFfmpegRecheckBtn")) loadMixerLibrary();
});

// ============================================================
// PREVIEW — "play and see what it is" before committing to a full
// render. One shared <audio> object (not a native <audio> per row —
// with 4 different lists that can all reference the same library item,
// N embedded players would be both visually heavy and impossible to
// keep in sync about which one is "the" currently-playing instance).
// A single ▶/⏸ toggle button next to every item, everywhere it
// appears, all driven by the same shared player.
// ============================================================
let mixerPreviewAudio = null;
let mixerPreviewKey = null;
let mixerPlayheadRaf = null;
function toggleMixerPreview(key, src) {
  if (mixerPreviewAudio && mixerPreviewKey === key && !mixerPreviewAudio.paused) {
    mixerPreviewAudio.pause();
    mixerPreviewKey = null;
    updateMixerPreviewButtons();
    stopPlayheadTracking();
    return;
  }
  if (mixerPreviewAudio) mixerPreviewAudio.pause();
  stopAllDomAudioExcept(null); // this new player is detached (new Audio()), so its own "play" event never reaches document's capture listener — stop real DOM audio explicitly here instead
  if (globalPreviewAudio && !globalPreviewAudio.paused) globalPreviewAudio.pause();
  mixerPreviewAudio = new Audio(src);
  mixerPreviewKey = key;
  mixerPreviewAudio.play();
  mixerPreviewAudio.addEventListener("ended", () => {
    mixerPreviewKey = null;
    updateMixerPreviewButtons();
    stopPlayheadTracking();
  });
  updateMixerPreviewButtons();
  startPlayheadTracking(key);
}
// ============================================================
// PLAYHEAD — real seek visualization: while the shared preview player
// is playing a clip, if that same clip's waveform is currently loaded
// (see loadWaveformForPanel), a moving line tracks actual playback
// position across the real waveform, and the position is genuinely
// seekable — click anywhere on the waveform (below the trim-selection
// area) to jump playback there, not just eyeball where you are.
// ============================================================
function startPlayheadTracking(key) {
  stopPlayheadTracking();
  const tick = () => {
    if (!mixerPreviewAudio || mixerPreviewKey !== key) return;
    Object.keys(waveformCache).forEach((editRef) => {
      const item = resolveEditRef(editRef);
      if (item && `${item.type}:${item.id}` === key) drawPlayheadOverlay(editRef, mixerPreviewAudio.currentTime, waveformCache[editRef].duration);
    });
    mixerPlayheadRaf = requestAnimationFrame(tick);
  };
  mixerPlayheadRaf = requestAnimationFrame(tick);
}
function stopPlayheadTracking() {
  if (mixerPlayheadRaf) cancelAnimationFrame(mixerPlayheadRaf);
  mixerPlayheadRaf = null;
}
function drawPlayheadOverlay(editRef, currentTime, duration) {
  const canvas = document.querySelector(`[data-waveform-canvas="${editRef}"]`);
  if (!canvas || !duration) return;
  renderWaveformCanvas(editRef); // redraw the base waveform+selection first, then the playhead on top — simplest way to avoid trailing line artifacts from the previous frame
  const ctx = canvas.getContext("2d");
  const x = (currentTime / duration) * canvas.width;
  ctx.strokeStyle = "#dc3545";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
}
function updateMixerPreviewButtons() {
  document.querySelectorAll("#mixerConsoleTabPane [data-mixer-preview]").forEach((btn) => {
    const isPlaying = mixerPreviewKey && btn.getAttribute("data-mixer-preview") === mixerPreviewKey;
    btn.textContent = isPlaying ? "⏸" : "▶";
  });
}
document.getElementById("mixerConsoleTabPane")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mixer-preview]");
  if (!btn) return;
  toggleMixerPreview(btn.getAttribute("data-mixer-preview"), btn.getAttribute("data-mixer-preview-src"));
});
function previewButtonHtml(item) {
  const key = `${item.type}:${item.id}`;
  return `<button type="button" class="btn btn-sm btn-outline-dark py-0 px-1" data-mixer-preview="${escapeHtml(key)}" data-mixer-preview-src="${item.audio}" title="Play">▶</button>`;
}
// ============================================================
// PER-CLIP EDITING — real, professional controls (trim, remove
// silence, fade in/out), attached independently to whichever slot a
// clip is placed in (the same song used as background AND an overlay
// can have completely different edits on each). editRef addresses
// which state reference a panel belongs to: "intro", "outro", "bg",
// "main:<index>", or "overlay:<index>" — one generic system instead of
// four separate ones for the four different lists this can appear in.
// ============================================================
function resolveEditRef(ref) {
  if (ref === "intro") return state.mixerIntro;
  if (ref === "outro") return state.mixerOutro;
  if (ref === "bg") return state.mixerBackground;
  if (ref === "revoice-region") return state.revoiceRegionItem;
  const [kind, idxStr] = ref.split(":");
  const idx = parseInt(idxStr);
  if (kind === "main") return state.mixerMainTrack[idx];
  if (kind === "overlay") return state.mixerOverlays[idx]?.item;
  return null;
}
function editButtonHtml(editRef) {
  return `<button type="button" class="btn btn-sm btn-outline-dark py-0 px-1" data-edit-toggle="${editRef}" title="Trim, remove silence, fade in/out">✏️</button>`;
}
// ============================================================
// WAVEFORM + DRAG-TO-SELECT — the real "Instagram-style" segment
// picker: decode the clip once (Web Audio API, client-side, no server
// round-trip), draw real min/max peaks per pixel column on canvas, and
// let the person drag the highlighted region to choose which part of a
// long clip (e.g. a 2-minute song) actually plays — dragging the whole
// region moves it while KEEPING ITS WIDTH FIXED (exactly the Instagram
// "slide your favorite 15 seconds" interaction), dragging either edge
// resizes it. The numeric trimStart/trimEnd fields already in the edit
// panel stay the single source of truth — this is a visual layer on
// top of them, always in sync both directions.
// ============================================================
const waveformCache = {}; // editRef -> { peaks, duration, audio }
async function loadWaveformForPanel(editRef) {
  const item = resolveEditRef(editRef);
  const statusEl = document.querySelector(`[data-waveform-status="${editRef}"]`);
  const canvas = document.querySelector(`[data-waveform-canvas="${editRef}"]`);
  if (!item?.audio || !canvas) return;
  const cached = waveformCache[editRef];
  if (cached && cached.audio === item.audio) {
    renderWaveformCanvas(editRef);
    initWaveformDrag(editRef);
    return;
  }
  if (statusEl) statusEl.textContent = "Loading waveform...";
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("This browser doesn't support Web Audio API.");
    const audioCtx = new AudioContextClass();
    const response = await fetch(item.audio);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const raw = audioBuffer.getChannelData(0);
    const targetBins = 400;
    const samplesPerBin = Math.max(1, Math.floor(raw.length / targetBins));
    const peaks = [];
    for (let i = 0; i < targetBins; i++) {
      let min = 0, max = 0;
      const start = i * samplesPerBin;
      for (let j = 0; j < samplesPerBin; j++) {
        const idx = start + j;
        if (idx >= raw.length) break;
        const v = raw[idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks.push([min, max]);
    }
    waveformCache[editRef] = { peaks, duration: audioBuffer.duration, audio: item.audio };
    audioCtx.close?.();
    if (statusEl) statusEl.textContent = `${audioBuffer.duration.toFixed(1)}s — drag the highlighted region to pick a segment, or drag its edges to resize`;
    renderWaveformCanvas(editRef);
    initWaveformDrag(editRef);
  } catch (err) {
    if (statusEl) statusEl.textContent = "Couldn't load waveform: " + err.message + " (numeric trim fields below still work normally)";
  }
}
function renderWaveformCanvas(editRef) {
  const canvas = document.querySelector(`[data-waveform-canvas="${editRef}"]`);
  const cached = waveformCache[editRef];
  const item = resolveEditRef(editRef);
  if (!canvas || !cached || !item) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(200, Math.floor(rect.width));
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const barWidth = w / cached.peaks.length;
  ctx.fillStyle = "#adb5bd";
  cached.peaks.forEach(([min, max], i) => {
    const x = i * barWidth;
    const yMin = (1 - (max + 1) / 2) * h;
    const yMax = (1 - (min + 1) / 2) * h;
    ctx.fillRect(x, yMin, Math.max(1, barWidth - 0.5), Math.max(1, yMax - yMin));
  });
  const edit = item.edit || {};
  const selStart = edit.trimStart || 0;
  const selEnd = edit.trimEnd || cached.duration;
  const x1 = (selStart / cached.duration) * w;
  const x2 = (selEnd / cached.duration) * w;
  ctx.fillStyle = "rgba(13,110,253,0.25)";
  ctx.fillRect(x1, 0, x2 - x1, h);
  ctx.strokeStyle = "#0d6efd";
  ctx.lineWidth = 2;
  ctx.strokeRect(x1, 0, Math.max(1, x2 - x1), h);
}
let waveformDragState = null;
const lastSeekPosition = {}; // editRef -> seconds, real "seeker" tracking for the boost-window shortcut
function initWaveformDrag(editRef) {
  const canvas = document.querySelector(`[data-waveform-canvas="${editRef}"]`);
  if (!canvas || canvas.dataset.dragInit) return; // wire listeners once per canvas element
  canvas.dataset.dragInit = "1";
  const getTimeFromClientX = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const cached = waveformCache[editRef];
    return cached ? (x / rect.width) * cached.duration : 0;
  };
  const handleDown = (e) => {
    const cached = waveformCache[editRef];
    const item = resolveEditRef(editRef);
    if (!cached || !item) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const t = getTimeFromClientX(clientX);
    item.edit = item.edit || {};
    const selStart = item.edit.trimStart || 0;
    const selEnd = item.edit.trimEnd || cached.duration;
    const rect = canvas.getBoundingClientRect();
    const handleZonePx = 10;
    const startPx = (selStart / cached.duration) * rect.width;
    const endPx = (selEnd / cached.duration) * rect.width;
    const xPx = clientX - rect.left;
    let mode = "move";
    if (Math.abs(xPx - startPx) < handleZonePx) mode = "left";
    else if (Math.abs(xPx - endPx) < handleZonePx) mode = "right";
    waveformDragState = { editRef, mode, startT: t, initialStart: selStart, initialEnd: selEnd, moved: false, downClientX: clientX };
    e.preventDefault();
  };
  const handleMove = (e) => {
    if (!waveformDragState || waveformDragState.editRef !== editRef) return;
    const cached = waveformCache[editRef];
    const item = resolveEditRef(editRef);
    if (!cached || !item) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    if (Math.abs(clientX - waveformDragState.downClientX) > 3) waveformDragState.moved = true; // beyond a few px is a genuine drag, not a click
    const t = getTimeFromClientX(clientX);
    item.edit = item.edit || {};
    if (waveformDragState.mode === "left") {
      item.edit.trimStart = Math.max(0, Math.min(t, (item.edit.trimEnd || cached.duration) - 0.1));
    } else if (waveformDragState.mode === "right") {
      item.edit.trimEnd = Math.min(cached.duration, Math.max(t, (item.edit.trimStart || 0) + 0.1));
    } else {
      // "move" — shifts the whole window, keeping its width FIXED — the
      // real Instagram-style interaction: pick a segment length once,
      // then slide it anywhere in the track.
      const width = waveformDragState.initialEnd - waveformDragState.initialStart;
      const delta = t - waveformDragState.startT;
      let newStart = waveformDragState.initialStart + delta;
      newStart = Math.max(0, Math.min(newStart, cached.duration - width));
      item.edit.trimStart = newStart;
      item.edit.trimEnd = newStart + width;
    }
    renderWaveformCanvas(editRef);
    syncEditPanelNumericInputs(editRef);
    e.preventDefault();
  };
  // A real click (no meaningful drag) is a SEEK, not a selection change
  // — jumps the shared preview player to that exact point on the real
  // waveform and starts it playing from there, same as clicking
  // anywhere on a real seek bar. A genuine drag (trim-selection) never
  // triggers this, since waveformDragState.moved only becomes true past
  // a few pixels of real movement.
  const handleUp = (e) => {
    const state = waveformDragState;
    waveformDragState = null;
    if (!state || state.moved || state.editRef !== editRef) return;
    const item = resolveEditRef(editRef);
    if (!item?.audio) return;
    lastSeekPosition[editRef] = state.startT; // real "seeker" position tracked for the boost-window shortcut below
    if (mixerPreviewAudio && mixerPreviewKey === `${item.type}:${item.id}`) {
      mixerPreviewAudio.currentTime = state.startT;
      if (mixerPreviewAudio.paused) mixerPreviewAudio.play();
    } else {
      toggleMixerPreview(`${item.type}:${item.id}`, item.audio);
      if (mixerPreviewAudio) mixerPreviewAudio.currentTime = state.startT;
    }
  };
  canvas.addEventListener("mousedown", handleDown);
  canvas.addEventListener("touchstart", handleDown, { passive: false });
  document.addEventListener("mousemove", handleMove);
  document.addEventListener("touchmove", handleMove, { passive: false });
  canvas.addEventListener("mouseup", handleUp);
  canvas.addEventListener("touchend", handleUp);
}
function syncEditPanelNumericInputs(editRef) {
  const item = resolveEditRef(editRef);
  const panel = document.querySelector(`[data-edit-panel="${editRef}"]`);
  if (!item || !panel) return;
  const startInput = panel.querySelector('[data-edit-field="trimStart"]');
  const endInput = panel.querySelector('[data-edit-field="trimEnd"]');
  if (startInput) startInput.value = item.edit.trimStart != null ? item.edit.trimStart.toFixed(2) : "";
  if (endInput) endInput.value = item.edit.trimEnd != null ? item.edit.trimEnd.toFixed(2) : "";
}
function editPanelHtml(editRef, edit) {
  edit = edit || {};
  return `<div class="border-top mt-1 pt-1 d-none" data-edit-panel="${editRef}">
    <div class="position-relative mb-1" data-waveform-wrap="${editRef}">
      <canvas class="w-100 bg-light rounded" height="56" data-waveform-canvas="${editRef}"></canvas>
      <div class="xx-small text-muted" data-waveform-status="${editRef}">Waveform loads when you open this panel...</div>
    </div>
    <div class="xx-small text-muted mb-1">Trim/fade times take fractions of a second for millisecond precision (e.g. 1.25 = 1250ms). Drag the highlighted region above, or type exact values below — both stay in sync.</div>
    <div class="d-flex gap-1 mb-1 flex-wrap">
      <input type="number" class="form-control form-control-sm" placeholder="trim start s" min="0" step="0.01" value="${edit.trimStart ?? ""}" data-edit-field="trimStart" style="width:100px;" title="Trim start (seconds, e.g. 1.250 = 1250ms)">
      <input type="number" class="form-control form-control-sm" placeholder="trim end s" min="0" step="0.01" value="${edit.trimEnd ?? ""}" data-edit-field="trimEnd" style="width:100px;" title="Trim end (seconds)">
      <input type="number" class="form-control form-control-sm" placeholder="fade in s" min="0" step="0.01" value="${edit.fadeIn ?? ""}" data-edit-field="fadeIn" style="width:100px;" title="Fade in duration (seconds)">
      <input type="number" class="form-control form-control-sm" placeholder="fade out s" min="0" step="0.01" value="${edit.fadeOut ?? ""}" data-edit-field="fadeOut" style="width:100px;" title="Fade out duration (seconds)">
    </div>
    <div class="d-flex gap-2 mb-1 align-items-center flex-wrap">
      <div class="form-check xx-small mb-0">
        <input class="form-check-input" type="checkbox" ${edit.removeSilence ? "checked" : ""} data-edit-field="removeSilence" id="rs-${editRef}">
        <label class="form-check-label xx-small" for="rs-${editRef}">Remove silence</label>
      </div>
      <label class="xx-small text-muted mb-0">below</label>
      <input type="number" class="form-control form-control-sm" min="-60" max="0" step="1" placeholder="-40" value="${edit.silenceThresholdDb ?? ""}" data-edit-field="silenceThresholdDb" style="width:65px;" title="Silence threshold in dB — closer to 0 catches quieter sounds too. -40dB is the real industry-standard default for speech.">
      <label class="xx-small text-muted mb-0">dB for</label>
      <input type="number" class="form-control form-control-sm" min="0.05" max="5" step="0.05" placeholder="0.5" value="${edit.silenceMinDuration ?? ""}" data-edit-field="silenceMinDuration" style="width:65px;" title="Minimum silence duration to count (seconds). 0.5s is standard — long enough to skip natural mid-sentence breathing room.">
      <label class="xx-small text-muted mb-0">s+</label>
      <div class="form-check xx-small mb-0">
        <input class="form-check-input" type="checkbox" ${edit.denoise ? "checked" : ""} data-edit-field="denoise" id="dn-${editRef}">
        <label class="form-check-label xx-small" for="dn-${editRef}" title="Real background-noise reduction (ffmpeg's afftdn filter)">🔇 Reduce noise</label>
      </div>
      <div class="form-check xx-small mb-0">
        <input class="form-check-input" type="checkbox" ${edit.reverse ? "checked" : ""} data-edit-field="reverse" id="rv-${editRef}">
        <label class="form-check-label xx-small" for="rv-${editRef}">⏪ Reverse</label>
      </div>
      <div class="form-check xx-small mb-0">
        <input class="form-check-input" type="checkbox" ${edit.normalize ? "checked" : ""} data-edit-field="normalize" id="nm-${editRef}">
        <label class="form-check-label xx-small" for="nm-${editRef}" title="One-click loudness leveling (EBU R128 standard, -16 LUFS) — the real mechanism behind 'Studio Sound' toggles">🎚️ Normalize volume</label>
      </div>
      <label class="xx-small text-muted mb-0">Boost</label>
      <input type="number" class="form-control form-control-sm" min="1" max="3" step="0.1" placeholder="1.0" value="${edit.boost ?? ""}" data-edit-field="boost" style="width:65px;" title="Amplify a too-quiet clip, 1.0-3.0x (real gain, ffmpeg's volume filter)">
      <label class="xx-small text-muted mb-0">only from</label>
      <input type="number" class="form-control form-control-sm" min="0" step="0.01" placeholder="whole clip" value="${edit.boostStart ?? ""}" data-edit-field="boostStart" style="width:80px;" title="Boost only from this second onward, not the whole clip — leave blank to boost the whole thing">
      <label class="xx-small text-muted mb-0">to</label>
      <input type="number" class="form-control form-control-sm" min="0" step="0.01" placeholder="s" value="${edit.boostEnd ?? ""}" data-edit-field="boostEnd" style="width:65px;" title="Boost stops at this second">
      <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-boost-use-playhead="${editRef}" title="Fill in the boost window from where you last clicked/sought on the waveform above">🎯 Use seek position</button>
      <div class="form-check xx-small mb-0">
        <input class="form-check-input" type="checkbox" ${edit.clarity ? "checked" : ""} data-edit-field="clarity" id="cl-${editRef}">
        <label class="form-check-label xx-small" for="cl-${editRef}" title="Real presence/clarity EQ boost (~3kHz, the standard broadcast technique for speech intelligibility) — not just louder, clearer">✨ Clarity boost</label>
      </div>
      <label class="xx-small text-muted mb-0">Speed</label>
      <input type="number" class="form-control form-control-sm" min="0.25" max="4" step="0.05" placeholder="1.0" value="${edit.speed ?? ""}" data-edit-field="speed" style="width:70px;" title="Playback speed, 0.25-4.0x — pitch stays natural (time-stretch, not resample)">
      <label class="xx-small text-muted mb-0">Loop</label>
      <input type="number" class="form-control form-control-sm" min="1" max="20" step="1" placeholder="1" value="${edit.loopCount ?? ""}" data-edit-field="loopCount" style="width:60px;" title="Repeat this clip N times">
    </div>
    <div class="d-flex align-items-center gap-2">
      <button type="button" class="btn btn-sm btn-outline-primary" data-edit-preview="${editRef}">▶ Preview edit</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" data-edit-compare="${editRef}" title="Play the original, unedited clip for a real A/B comparison">🔁 Compare original</button>
      <span class="xx-small" data-edit-preview-result="${editRef}"></span>
    </div>
  </div>`;
}
document.getElementById("mixerConsoleTabPane")?.addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest("[data-edit-toggle]");
  if (toggleBtn) {
    const ref = toggleBtn.getAttribute("data-edit-toggle");
    const panels = document.querySelectorAll(`[data-edit-panel="${CSS.escape(ref)}"]`);
    panels.forEach((panel) => panel.classList.toggle("d-none"));
    // Loads (or just re-renders, if already decoded) the waveform only
    // when the panel is actually opened — decoding audio client-side
    // isn't free, no reason to do it for every item up front.
    const nowOpen = panels[0] && !panels[0].classList.contains("d-none");
    if (nowOpen) loadWaveformForPanel(ref);
    return;
  }
  const previewBtn = e.target.closest("[data-edit-preview]");
  if (previewBtn) {
    const ref = previewBtn.getAttribute("data-edit-preview");
    const item = resolveEditRef(ref);
    if (!item) return;
    const resultEl = document.querySelector(`[data-edit-preview-result="${CSS.escape(ref)}"]`);
    const originalLabel = previewBtn.innerHTML;
    previewBtn.disabled = true;
    previewBtn.innerHTML = "Rendering...";
    try {
      const { res, data } = await fetchJson("/api/audio/mixer/edit-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: item.audio, edit: item.edit || {} }),
      });
      if (!res.ok) throw new Error(data.error || "Preview failed.");
      if (resultEl) resultEl.innerHTML = `<audio controls src="${data.downloadUrl}" style="height:28px; vertical-align:middle;"></audio>`;
    } catch (err) {
      if (resultEl) resultEl.innerHTML = `<span class="text-danger">${escapeHtml(err.message)}</span>`;
    } finally {
      previewBtn.disabled = false;
      previewBtn.innerHTML = originalLabel;
    }
    return;
  }
  const compareBtn = e.target.closest("[data-edit-compare]");
  if (compareBtn) {
    const ref = compareBtn.getAttribute("data-edit-compare");
    const item = resolveEditRef(ref);
    if (!item?.audio) return;
    // Plays the RAW, unedited source directly — real A/B comparison
    // against whatever's showing in the "Preview edit" result above,
    // using the same shared player everything else in the Mixer uses
    // (so it correctly stops whatever else was playing).
    toggleMixerPreview(`compare:${ref}`, item.audio);
    return;
  }
  const boostSeekBtn = e.target.closest("[data-boost-use-playhead]");
  if (boostSeekBtn) {
    const ref = boostSeekBtn.getAttribute("data-boost-use-playhead");
    const panel = document.querySelector(`[data-edit-panel="${ref}"]`);
    const pos = lastSeekPosition[ref];
    if (pos == null) return alert("Click somewhere on the waveform above first to set a seek position.");
    const startInput = panel?.querySelector('[data-edit-field="boostStart"]');
    const endInput = panel?.querySelector('[data-edit-field="boostEnd"]');
    const item = resolveEditRef(ref);
    if (item) {
      item.edit = item.edit || {};
      item.edit.boostStart = +pos.toFixed(2);
      item.edit.boostEnd = +Math.min(pos + 3, waveformCache[ref]?.duration || pos + 3).toFixed(2); // a real, sensible default window (3s) starting right where they sought to — always editable afterward
      if (startInput) startInput.value = item.edit.boostStart;
      if (endInput) endInput.value = item.edit.boostEnd;
    }
    return;
  }
});
document.getElementById("mixerConsoleTabPane")?.addEventListener("input", (e) => {
  const field = e.target.getAttribute("data-edit-field");
  if (!field) return;
  const panel = e.target.closest("[data-edit-panel]");
  const ref = panel?.getAttribute("data-edit-panel");
  const item = ref ? resolveEditRef(ref) : null;
  if (!item) return;
  item.edit = item.edit || {};
  if (field === "removeSilence" || field === "reverse" || field === "normalize" || field === "clarity" || field === "denoise") item.edit[field] = e.target.checked;
  else item.edit[field] = e.target.value ? parseFloat(e.target.value) : undefined;
  // Keep the visual selection in sync when the numeric fields are typed
  // directly, not just when dragging on the waveform.
  if ((field === "trimStart" || field === "trimEnd") && waveformCache[ref]) renderWaveformCanvas(ref);
});
function renderMixerIntroOutro() {
  scheduleMixerSessionSave();
  const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
  const introEl = document.getElementById("mixerIntroSlot");
  if (introEl) {
    introEl.innerHTML = state.mixerIntro
      ? `<div class="d-flex align-items-center gap-1">${previewButtonHtml(state.mixerIntro)}<span class="xx-small flex-grow-1">${typeIcon[state.mixerIntro.type] || ""} ${escapeHtml(state.mixerIntro.name)}</span>${editButtonHtml("intro")}<button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" data-mixer-action="clear-intro">✕</button></div>${editPanelHtml("intro", state.mixerIntro.edit)}`
      : `<span class="text-muted xx-small">No intro set.</span>`;
  }
  const outroEl = document.getElementById("mixerOutroSlot");
  if (outroEl) {
    outroEl.innerHTML = state.mixerOutro
      ? `<div class="d-flex align-items-center gap-1">${previewButtonHtml(state.mixerOutro)}<span class="xx-small flex-grow-1">${typeIcon[state.mixerOutro.type] || ""} ${escapeHtml(state.mixerOutro.name)}</span>${editButtonHtml("outro")}<button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" data-mixer-action="clear-outro">✕</button></div>${editPanelHtml("outro", state.mixerOutro.edit)}`
      : `<span class="text-muted xx-small">No outro set.</span>`;
  }
}
document.getElementById("mixerIntroSlot")?.addEventListener("click", (e) => {
  if (e.target.closest('[data-mixer-action="clear-intro"]')) { state.mixerIntro = null; renderMixerIntroOutro(); }
});
document.getElementById("mixerOutroSlot")?.addEventListener("click", (e) => {
  if (e.target.closest('[data-mixer-action="clear-outro"]')) { state.mixerOutro = null; renderMixerIntroOutro(); }
});
// ============================================================
// LOCAL UPLOAD — "what if we had some local audios to work around" —
// reads the file entirely client-side (FileReader, no upload-size
// limit imposed by any API), saves it into the SAME Audio Library
// every generated clip already lives in (a new real "upload" type, not
// a second separate storage system) so it shows up in the Mixer's
// library list exactly like anything else and persists across
// sessions, not just for this one render.
// ============================================================
document.getElementById("mixerUploadInput")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const label = document.querySelector('label[for="mixerUploadInput"]');
  const originalLabel = label?.innerHTML;
  if (label) label.innerHTML = "📁 Uploading...";
  try {
    const dataUri = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsDataURL(file);
    });
    const { res, data } = await fetchJson("/api/audio-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "upload", name: file.name.replace(/\.[^/.]+$/, ""), audioDataUri: dataUri }),
    });
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    await loadMixerLibrary();
  } catch (err) {
    alert("Couldn't add that file: " + err.message);
  } finally {
    if (label) label.innerHTML = originalLabel;
    e.target.value = ""; // allow re-selecting the same file later
  }
});

// ============================================================
// AUDIO TOOLS — standalone utilities, real ffmpeg-backed offline
// processing (except Re-voice, a genuine AI call). Each tool's
// "pick from library" select shares the same typeIcon convention and
// full-library fetch already used throughout the Mixer.
// ============================================================
async function populateAudioToolsLibrarySelects() {
  const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
  try {
    const { res, data } = await fetchJson("/api/audio-library");
    if (!res.ok) return;
    const items = data.items || [];
    state.audioToolsLibraryItems = items;
    const optionsHtml = items.map((it) => `<option value="${it.id}">${typeIcon[it.type] || ""} ${escapeHtml(it.name)}</option>`).join("");
    const selects = [
      { id: "toolsConvertSource", placeholder: "Pick a clip from your library..." },
      { id: "toolsRingtoneSource", placeholder: "Pick a clip from your library..." },
      { id: "toolsRevoiceSource", placeholder: "Source clip (what to convert)..." },
    ];
    selects.forEach(({ id, placeholder }) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<option value="">${placeholder}</option>${optionsHtml}`;
    });
    // REAL FIX: the target-voice picker used to show the SAME full
    // library as everything else — songs, SFX, Mixer renders, even
    // other AI-generated TTS takes, none of which make sense as a
    // voice-conversion TARGET (converting audio to sound like a
    // synthesized voice, or a song, isn't what this tool is for). Only
    // real human voice references belong here.
    //
    // SECOND REAL FIX, this round: this used to silently show NOTHING
    // for any voice cloned before the previous fix (which started
    // saving the actual reference recording alongside the clone) —
    // confusing, since your named voices (like "vemuri") would just
    // vanish with no explanation. Now every voice in state.customVoices
    // (the real, authoritative source of your saved clones) is listed
    // by name, cross-referenced against the library for its actual
    // reference audio. Found -> selectable. Not found (cloned before
    // the fix, recording genuinely never kept) -> shown anyway, but
    // disabled with a clear reason and a real next step, instead of
    // just disappearing.
    const targetSelect = document.getElementById("toolsRevoiceTarget");
    if (targetSelect) {
      const uploadItems = items.filter((it) => it.type === "upload");
      const matchedVoiceIds = new Set();
      const customVoiceOptions = (state.customVoices || []).map((cv) => {
        const ref = uploadItems.find((it) => it.name === `${cv.name} (voice reference)`);
        if (ref) matchedVoiceIds.add(ref.id);
        return ref
          ? `<option value="${ref.id}">🎙️ ${escapeHtml(cv.name)}</option>`
          : `<option value="" disabled>🎙️ ${escapeHtml(cv.name)} — no reference saved (cloned before this feature existed; re-clone or upload a sample of this voice below)</option>`;
      }).join("");
      // Anything else uploaded that ISN'T already matched to a named
      // custom voice above (a plain "upload a voice sample" you did
      // directly, not through cloning) — still real, still usable.
      const otherUploads = uploadItems.filter((it) => !matchedVoiceIds.has(it.id));
      const otherOptionsHtml = otherUploads.map((it) => `<option value="${it.id}">📁 ${escapeHtml(it.name)}</option>`).join("");
      targetSelect.innerHTML = `<option value="">Target voice (whose voice to use)...</option>${customVoiceOptions}${otherOptionsHtml}`;
    }
  } catch {} // best-effort — tools still usable via upload where applicable, just without the library shortcuts
}
function findAudioToolsLibraryItem(id) {
  return (state.audioToolsLibraryItems || []).find((it) => String(it.id) === id);
}
function renderToolResult(elId, data, filenameBase) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `<audio controls class="w-100 mb-1" src="${data.downloadUrl}"></audio><a href="${data.downloadUrl}" download class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download (${(data.sizeBytes / 1024).toFixed(0)} KB)</a>`;
  if (data.libraryItemId) el.innerHTML += `<div class="xx-small text-success mt-1">✅ Saved to your Audio Library too.</div>`;
}
// ============================================================
// TOOL UPLOADS — real "works on outside-the-app audio too, not just
// what this app generated" fix: every tool below (Convert, Ringtone,
// Re-voice's source AND target) now takes a direct file upload as a
// genuine alternative to picking from the library, not just Extract-
// from-video. An upload always takes priority over whatever's picked
// in the library dropdown for that same slot — resolveToolSource
// checks the upload first, falls back to the library selection.
// ============================================================
state.audioToolsUploads = state.audioToolsUploads || {};
function wireToolUpload(uploadInputId, statusId, selectId, stateKey) {
  document.getElementById(uploadInputId)?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    const statusEl = document.getElementById(statusId);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      state.audioToolsUploads[stateKey] = ev.target.result;
      if (statusEl) statusEl.textContent = `Using uploaded file "${file.name}" (overrides the library pick above).`;
      const selectEl = document.getElementById(selectId);
      if (selectEl) selectEl.value = ""; // visually clear the library pick so it's obvious which source will actually be used
    };
    reader.readAsDataURL(file);
  });
  // Picking from the library again after an upload should let the
  // library win back — otherwise the upload would silently and
  // permanently shadow the dropdown for the rest of the session.
  document.getElementById(selectId)?.addEventListener("change", (e) => {
    if (e.target.value) {
      delete state.audioToolsUploads[stateKey];
      const statusEl = document.getElementById(statusId);
      if (statusEl) statusEl.textContent = "";
    }
  });
}
wireToolUpload("toolsConvertUpload", "toolsConvertUploadStatus", "toolsConvertSource", "convertSource");
wireToolUpload("toolsRingtoneUpload", "toolsRingtoneUploadStatus", "toolsRingtoneSource", "ringtoneSource");
wireToolUpload("toolsRevoiceSourceUpload", "toolsRevoiceSourceUploadStatus", "toolsRevoiceSource", "revoiceSource");
wireToolUpload("toolsRevoiceTargetUpload", "toolsRevoiceTargetUploadStatus", "toolsRevoiceTarget", "revoiceTarget");
function resolveToolSource(stateKey, selectId) {
  if (state.audioToolsUploads[stateKey]) return state.audioToolsUploads[stateKey];
  const item = findAudioToolsLibraryItem(document.getElementById(selectId)?.value);
  return item ? item.audio : null;
}
// ============================================================
// REGION SELECTOR — reuses the exact waveform+drag system already
// proven in the Mixer's edit panel (resolveEditRef now recognizes a
// "revoice-region" key pointing at state.revoiceRegionItem — see
// resolveEditRef above), rather than a second parallel implementation.
// Its .edit.trimStart/trimEnd fields double as the SELECTED REGION
// markers here — never sent through applyEditsToLocalFile as real
// edits, only read directly as the region bounds for the two backend
// routes below.
// ============================================================
function loadRevoiceSourceWaveform() {
  const source = resolveToolSource("revoiceSource", "toolsRevoiceSource");
  const regionSection = document.getElementById("toolsRevoiceRegionSection");
  const regionBtn = document.getElementById("toolsRevoiceRegionBtn");
  const showCorrectBtn = document.getElementById("toolsRevoiceShowCorrectBtn");
  if (!source) {
    regionSection?.classList.add("d-none");
    regionBtn?.classList.add("d-none");
    showCorrectBtn?.classList.add("d-none");
    return;
  }
  state.revoiceRegionItem = { type: "revoice", id: "region", name: "Selected clip", audio: source, edit: {} };
  regionSection?.classList.remove("d-none");
  loadWaveformForPanel("revoice-region");
}
document.getElementById("toolsRevoiceSource")?.addEventListener("change", loadRevoiceSourceWaveform);
document.getElementById("toolsRevoiceSourceUpload")?.addEventListener("change", () => setTimeout(loadRevoiceSourceWaveform, 50)); // small delay lets the FileReader in wireToolUpload finish first
// A meaningful region selection (not just the default full range) reveals
// the region-only actions — checked whenever the waveform selection changes.
function checkRevoiceRegionSelected() {
  const item = state.revoiceRegionItem;
  const cached = waveformCache["revoice-region"];
  const hasRegion = item?.edit?.trimStart != null && item?.edit?.trimEnd != null && cached
    && (item.edit.trimStart > 0.05 || item.edit.trimEnd < cached.duration - 0.05);
  document.getElementById("toolsRevoiceRegionBtn")?.classList.toggle("d-none", !hasRegion);
  document.getElementById("toolsRevoiceShowCorrectBtn")?.classList.toggle("d-none", !hasRegion);
  if (!hasRegion) document.getElementById("toolsRevoiceCorrectSection")?.classList.add("d-none");
}
// Polls after any waveform interaction rather than hooking deep into
// the shared drag handlers — simplest way to react to a selection
// change without touching code the Mixer's edit panel also depends on.
document.getElementById("toolsRevoiceRegionSection")?.addEventListener("mouseup", () => setTimeout(checkRevoiceRegionSelected, 50));
document.getElementById("toolsRevoiceRegionSection")?.addEventListener("touchend", () => setTimeout(checkRevoiceRegionSelected, 50));

document.getElementById("toolsRevoiceShowCorrectBtn")?.addEventListener("click", async () => {
  document.getElementById("toolsRevoiceCorrectSection")?.classList.remove("d-none");
  const selectEl = document.getElementById("toolsCorrectVoiceSelect");
  if (!selectEl || selectEl.dataset.populated) return;
  selectEl.dataset.populated = "1";
  const groups = [];
  if ((state.customVoices || []).length) {
    groups.push(`<optgroup label="Your cloned voices">${state.customVoices.map((cv) => `<option value="custom:${cv.custom_voice_id}">🎙️ ${escapeHtml(cv.name)}</option>`).join("")}</optgroup>`);
  }
  const standardVoices = (state.voiceModels || []).find((m) => m.id === "fal-ai/minimax/speech-02-hd")?.confirmedVoiceIds || [];
  groups.push(`<optgroup label="Standard voices (MiniMax)">${standardVoices.map((v) => `<option value="standard:${v.id}">${escapeHtml(v.label || v.id)}</option>`).join("")}</optgroup>`);
  selectEl.innerHTML = `<option value="">Pick a voice...</option>${groups.join("")}`;
});
document.getElementById("toolsRevoiceRegionBtn")?.addEventListener("click", async () => {
  const source = resolveToolSource("revoiceSource", "toolsRevoiceSource");
  const targetVoiceAudio = resolveToolSource("revoiceTarget", "toolsRevoiceTarget");
  const region = state.revoiceRegionItem?.edit;
  if (!source || region?.trimStart == null) return;
  if (!targetVoiceAudio) return alert("Pick a target voice, or upload a sample of the voice you want.");
  const userKey = getUserKey();
  if (!userKey) return alert("This is a real paid AI call — add your Fal API key in Settings first.");
  const btn = document.getElementById("toolsRevoiceRegionBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "🔄 Re-voicing region...";
  try {
    const { res, data } = await fetchJson("/api/audio/mixer/revoice-region", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAudio: source, targetVoiceAudio, regionStart: region.trimStart || 0, regionEnd: region.trimEnd, userApiKey: userKey }),
    });
    if (!res.ok) throw new Error(data.error || "Region re-voicing failed.");
    await refreshCreditsSummary();
    renderToolResult("toolsRevoiceResult", data, "region-revoiced");
  } catch (err) {
    document.getElementById("toolsRevoiceResult").innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});
document.getElementById("toolsCorrectRegionBtn")?.addEventListener("click", async () => {
  const source = resolveToolSource("revoiceSource", "toolsRevoiceSource");
  const region = state.revoiceRegionItem?.edit;
  const correctedText = document.getElementById("toolsCorrectText")?.value?.trim();
  const voiceChoice = document.getElementById("toolsCorrectVoiceSelect")?.value;
  if (!source || region?.trimStart == null) return;
  if (!correctedText) return alert("Type the corrected text for this region.");
  if (!voiceChoice) return alert("Pick a voice for the correction.");
  const userKey = getUserKey();
  if (!userKey) return alert("This is a real paid AI call — add your Fal API key in Settings first.");
  const [voiceKind, voiceIdValue] = voiceChoice.split(":");
  const btn = document.getElementById("toolsCorrectRegionBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "✏️ Correcting region...";
  try {
    const { res, data } = await fetchJson("/api/audio/mixer/correct-region", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceAudio: source,
        correctedText,
        modelId: voiceKind === "custom" ? "fal-ai/minimax/speech-02-hd" : undefined,
        voiceId: voiceIdValue,
        regionStart: region.trimStart || 0,
        regionEnd: region.trimEnd,
        userApiKey: userKey,
      }),
    });
    if (!res.ok) throw new Error(data.error || "Region correction failed.");
    await refreshCreditsSummary();
    renderToolResult("toolsCorrectResult", data, "region-corrected");
  } catch (err) {
    document.getElementById("toolsCorrectResult").innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// --- Extract audio from video ---
let toolsVideoBase64 = null;
document.getElementById("toolsVideoUpload")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  const btn = document.getElementById("toolsExtractBtn");
  const status = document.getElementById("toolsVideoStatus");
  if (!file) { btn.disabled = true; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    toolsVideoBase64 = ev.target.result;
    if (status) status.textContent = `Ready: "${file.name}"`;
    if (btn) btn.disabled = false;
  };
  reader.readAsDataURL(file);
});
document.getElementById("toolsExtractBtn")?.addEventListener("click", async () => {
  if (!toolsVideoBase64) return;
  const btn = document.getElementById("toolsExtractBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "🎬 Extracting...";
  try {
    const { res, data } = await fetchJson("/api/audio/tools/extract-from-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: toolsVideoBase64, format: document.getElementById("toolsVideoFormat")?.value || "mp3" }),
    });
    if (!res.ok) throw new Error(data.error || "Extraction failed.");
    renderToolResult("toolsExtractResult", data, "extracted-audio");
    populateAudioToolsLibrarySelects(); // the extracted clip is now in the library too — refresh so it's immediately pickable in the other tools below
  } catch (err) {
    document.getElementById("toolsExtractResult").innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// --- Convert format ---
document.getElementById("toolsConvertBtn")?.addEventListener("click", async () => {
  const source = resolveToolSource("convertSource", "toolsConvertSource");
  if (!source) return alert("Pick a clip from your library or upload a file first.");
  const btn = document.getElementById("toolsConvertBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "🔁 Converting...";
  try {
    const { res, data } = await fetchJson("/api/audio/tools/convert-format", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, format: document.getElementById("toolsConvertFormat")?.value || "mp3" }),
    });
    if (!res.ok) throw new Error(data.error || "Conversion failed.");
    renderToolResult("toolsConvertResult", data, "converted-audio");
  } catch (err) {
    document.getElementById("toolsConvertResult").innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// --- Ringtone maker ---
document.getElementById("toolsRingtoneBtn")?.addEventListener("click", async () => {
  const source = resolveToolSource("ringtoneSource", "toolsRingtoneSource");
  if (!source) return alert("Pick a clip from your library or upload a song/file first.");
  const btn = document.getElementById("toolsRingtoneBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "📱 Making ringtone...";
  try {
    const startVal = parseFloat(document.getElementById("toolsRingtoneStart")?.value);
    const endVal = parseFloat(document.getElementById("toolsRingtoneEnd")?.value);
    const { res, data } = await fetchJson("/api/audio/tools/make-ringtone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        trimStart: isNaN(startVal) ? 0 : startVal,
        trimEnd: isNaN(endVal) ? undefined : endVal,
        platform: document.getElementById("toolsRingtonePlatform")?.value || "android",
      }),
    });
    if (!res.ok) throw new Error(data.error || "Ringtone creation failed.");
    renderToolResult("toolsRingtoneResult", data, "ringtone");
  } catch (err) {
    document.getElementById("toolsRingtoneResult").innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

// --- Re-voice (real AI voice conversion) ---
document.getElementById("toolsRevoiceBtn")?.addEventListener("click", async () => {
  const sourceAudio = resolveToolSource("revoiceSource", "toolsRevoiceSource");
  const targetVoiceAudio = resolveToolSource("revoiceTarget", "toolsRevoiceTarget");
  if (!sourceAudio) return alert("Pick the clip you want to convert, or upload one.");
  if (!targetVoiceAudio) return alert("Pick a target voice, or upload a sample of the voice you want — any person's voice, doesn't need to already be cloned in this app.");
  const userKey = getUserKey();
  if (!userKey) return alert("This is a real paid AI call — add your Fal API key in Settings first.");
  const btn = document.getElementById("toolsRevoiceBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "🔄 Re-voicing (real AI call)...";
  try {
    const { res, data } = await fetchJson("/api/audio/mixer/revoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAudio, targetVoiceAudio, userApiKey: userKey }),
    });
    if (!res.ok) throw new Error(data.error || "Re-voicing failed.");
    await refreshCreditsSummary();
    const resultEl = document.getElementById("toolsRevoiceResult");
    resultEl.innerHTML = `<audio controls class="w-100 mb-1" src="${data.audio}"></audio><a href="${data.audio}" data-download-url="${data.audio}" data-download-filename="revoiced-${Date.now()}.mp3" class="btn btn-sm btn-dark fw-bold w-100">⬇️ Download</a>`;
    saveToAudioLibrary({ type: "voice", name: `Re-voiced clip — ${new Date().toLocaleString()}`, audioDataUri: data.audio, silent: true });
  } catch (err) {
    document.getElementById("toolsRevoiceResult").innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});

async function loadMixerLibrary() {
  const listEl = document.getElementById("mixerLibraryList");
  const warningEl = document.getElementById("mixerFfmpegWarning");
  if (!listEl) return;
  try {
    const { res: ffRes, data: ffData } = await fetchJson("/api/audio/mixer/ffmpeg-status");
    const available = ffRes.ok && !!ffData.localFfmpegAvailable;
    if (warningEl) {
      warningEl.classList.toggle("d-none", available);
      // Real npm-native dependency (ffmpeg-static) — if this still
      // shows, npm install genuinely hasn't been run, not something
      // that needs a manual OS-level install step.
      if (!available) warningEl.innerHTML = `⚠️ ffmpeg isn't set up on this server yet. Run <code>npm install</code> in the project folder (it's a real npm dependency — ffmpeg-static — not a separate manual install), then restart the server. <button type="button" class="btn btn-sm btn-outline-dark mt-1" id="mixerFfmpegRecheckBtn">🔄 Recheck</button>`;
    }
  } catch {}
  const typeFilter = document.getElementById("mixerLibraryTypeFilter")?.value || "";
  try {
    const { res, data } = await fetchJson(`/api/audio-library${typeFilter ? `?type=${typeFilter}` : ""}`);
    if (!res.ok) return;
    state.mixerLibraryItems = data.items || [];
    const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
    listEl.innerHTML = state.mixerLibraryItems.length
      ? state.mixerLibraryItems.map((item) => `
        <div class="d-flex align-items-center gap-1 border rounded p-1">
          <span class="xx-small flex-grow-1 text-truncate">${typeIcon[item.type] || ""} ${escapeHtml(item.name)}</span>
          ${previewButtonHtml(item)}
          <select class="form-select form-select-sm py-0" style="width:auto; font-size:0.72rem;" data-mixer-add-select data-item-id="${item.id}">
            <option value="">Add as...</option>
            <option value="intro">⏮ Intro</option>
            <option value="main">➕ Main</option>
            <option value="outro">⏭ Outro</option>
            <option value="bg">🎧 Background</option>
            <option value="overlay">⏱ Overlay</option>
          </select>
        </div>`).join("")
      : `<span class="xx-small text-muted">Nothing in your library yet — generate a voice take, song, or SFX first.</span>`;
  } catch {}
}
function renderMixerMainTrack() {
  scheduleMixerSessionSave();
  const listEl = document.getElementById("mixerMainTrackList");
  if (!listEl) return;
  if (!state.mixerMainTrack.length) {
    listEl.innerHTML = `<span class="text-muted xx-small" id="mixerMainTrackEmpty">Add clips from your library on the left.</span>`;
    return;
  }
  const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
  listEl.innerHTML = state.mixerMainTrack.map((item, i) => `
    <div class="border rounded p-1">
    <div class="d-flex align-items-center gap-1">
      <span class="xx-small text-muted">${i + 1}.</span>
      <span class="xx-small flex-grow-1 text-truncate">${typeIcon[item.type] || ""} ${escapeHtml(item.name)}</span>
      ${previewButtonHtml(item)}
      ${editButtonHtml(`main:${i}`)}
      <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-mixer-track-action="up" data-track-index="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="btn btn-sm btn-outline-secondary py-0 px-1" data-mixer-track-action="down" data-track-index="${i}" ${i === state.mixerMainTrack.length - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" data-mixer-track-action="remove" data-track-index="${i}">✕</button>
    </div>
    ${editPanelHtml(`main:${i}`, item.edit)}
    </div>`).join("");
}
function renderMixerBackground() {
  scheduleMixerSessionSave();
  const slotEl = document.getElementById("mixerBackgroundTrackSlot");
  if (!slotEl) return;
  const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
  slotEl.innerHTML = state.mixerBackground
    ? `<div class="d-flex align-items-center gap-1"><span class="xx-small flex-grow-1">${typeIcon[state.mixerBackground.type] || ""} ${escapeHtml(state.mixerBackground.name)}</span>${previewButtonHtml(state.mixerBackground)}${editButtonHtml("bg")}<button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" data-mixer-action="clear-bg">✕</button></div>${editPanelHtml("bg", state.mixerBackground.edit)}`
    : `<span class="text-muted xx-small">No background clip set.</span>`;
}
// ============================================================
// TIMED OVERLAYS — the actual "canvas" piece: any number of clips,
// each independently placed at an exact second on top of the whole
// mix, not looped (a background loops; an overlay is a one-shot hit —
// real, different ffmpeg behavior, see audio-mixer.js's mixLayers).
// ============================================================
state.mixerOverlays = state.mixerOverlays || []; // array of { item, delaySeconds, volume }
function renderMixerOverlays() {
  scheduleMixerSessionSave();
  const listEl = document.getElementById("mixerOverlaysList");
  if (!listEl) return;
  const typeIcon = { voice: "🎙️", song: "🎵", sfx: "🔊", upload: "📁", mix: "🎛️" };
  if (!state.mixerOverlays.length) {
    listEl.innerHTML = `<span class="text-muted xx-small" id="mixerOverlaysEmpty">Click ⏱ on a library item to place it at a specific moment.</span>`;
    return;
  }
  listEl.innerHTML = state.mixerOverlays.map((ov, i) => `
    <div class="border rounded p-1" data-overlay-index="${i}">
    <div class="d-flex align-items-center gap-1">
      <span class="xx-small flex-grow-1 text-truncate">${typeIcon[ov.item.type] || ""} ${escapeHtml(ov.item.name)}</span>
      ${previewButtonHtml(ov.item)}
      ${editButtonHtml(`overlay:${i}`)}
      <label class="xx-small text-muted mb-0">at</label>
      <input type="number" class="form-control form-control-sm" style="width:60px;" min="0" step="0.5" value="${ov.delaySeconds}" data-overlay-field="delaySeconds">
      <label class="xx-small text-muted mb-0">s, vol</label>
      <input type="range" class="form-range" style="max-width:70px;" min="0" max="1" step="0.05" value="${ov.volume}" data-overlay-field="volume">
      <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1" data-mixer-overlay-remove="1">✕</button>
    </div>
    ${editPanelHtml(`overlay:${i}`, ov.item.edit)}
    </div>`).join("");
}
document.getElementById("mixerOverlaysList")?.addEventListener("input", (e) => {
  const row = e.target.closest("[data-overlay-index]");
  const field = e.target.getAttribute("data-overlay-field");
  if (!row || !field) return;
  const i = parseInt(row.getAttribute("data-overlay-index"));
  state.mixerOverlays[i][field] = parseFloat(e.target.value) || 0;
});
document.getElementById("mixerOverlaysList")?.addEventListener("click", (e) => {
  if (!e.target.closest("[data-mixer-overlay-remove]")) return;
  const row = e.target.closest("[data-overlay-index]");
  state.mixerOverlays.splice(parseInt(row.getAttribute("data-overlay-index")), 1);
  renderMixerOverlays();
});
document.getElementById("mixerLibraryTypeFilter")?.addEventListener("change", loadMixerLibrary);
state.mixerIntro = state.mixerIntro || null; // one library item object with attached edit options, or null
state.mixerOutro = state.mixerOutro || null;
document.getElementById("mixerLibraryList")?.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-mixer-add-select]");
  if (!sel || !sel.value) return;
  const itemId = sel.getAttribute("data-item-id");
  const item = (state.mixerLibraryItems || []).find((i) => String(i.id) === itemId);
  if (!item) return;
  const itemWithEdit = { ...item, edit: {} }; // each placement gets its OWN independent edit options — trimming this clip as an intro shouldn't affect the same clip used elsewhere
  if (sel.value === "main") {
    state.mixerMainTrack.push(itemWithEdit);
    renderMixerMainTrack();
  } else if (sel.value === "bg") {
    state.mixerBackground = itemWithEdit;
    renderMixerBackground();
  } else if (sel.value === "overlay") {
    state.mixerOverlays.push({ item: itemWithEdit, delaySeconds: 0, volume: 0.8 });
    renderMixerOverlays();
  } else if (sel.value === "intro") {
    state.mixerIntro = itemWithEdit;
    renderMixerIntroOutro();
  } else if (sel.value === "outro") {
    state.mixerOutro = itemWithEdit;
    renderMixerIntroOutro();
  }
  sel.value = ""; // reset so the same dropdown can be used again immediately
});
document.getElementById("mixerBackgroundTrackSlot")?.addEventListener("click", (e) => {
  if (e.target.closest('[data-mixer-action="clear-bg"]')) {
    state.mixerBackground = null;
    renderMixerBackground();
  }
});
document.getElementById("mixerMainTrackList")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mixer-track-action]");
  if (!btn) return;
  const idx = parseInt(btn.getAttribute("data-track-index"));
  const action = btn.getAttribute("data-mixer-track-action");
  if (action === "remove") state.mixerMainTrack.splice(idx, 1);
  else if (action === "up" && idx > 0) [state.mixerMainTrack[idx - 1], state.mixerMainTrack[idx]] = [state.mixerMainTrack[idx], state.mixerMainTrack[idx - 1]];
  else if (action === "down" && idx < state.mixerMainTrack.length - 1) [state.mixerMainTrack[idx + 1], state.mixerMainTrack[idx]] = [state.mixerMainTrack[idx], state.mixerMainTrack[idx + 1]];
  renderMixerMainTrack();
});
document.getElementById("mixerRenderBtn")?.addEventListener("click", async () => {
  const resultEl = document.getElementById("mixerRenderResult");
  if (!state.mixerMainTrack.length) return alert("Add at least one clip to the Main track first.");
  const btn = document.getElementById("mixerRenderBtn");
  btn.disabled = true;
  const originalLabel = btn.innerHTML;
  btn.innerHTML = "🎛️ Rendering...";
  resultEl.innerHTML = "";
  // Shapes an item (with whatever edit options were set on it in the
  // UI) into exactly what the backend's normalizeClientSource expects
  // — a bare source string when there are no real edits to apply, or
  // {source, edit} when there are, so an unedited clip isn't sent
  // through an extra no-op processing pass.
  const toSourceEntry = (item) => (item.edit && Object.keys(item.edit).length ? { source: item.audio, edit: item.edit } : item.audio);
  try {
    const { res, data } = await fetchJson("/api/audio/mixer/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        introSource: state.mixerIntro ? toSourceEntry(state.mixerIntro) : null,
        mainTrackSources: state.mixerMainTrack.map(toSourceEntry),
        outroSource: state.mixerOutro ? toSourceEntry(state.mixerOutro) : null,
        backgroundSource: state.mixerBackground ? toSourceEntry(state.mixerBackground) : null,
        backgroundVolume: parseFloat(document.getElementById("mixerBackgroundVolume")?.value) || 0.25,
        backgroundDuck: !!document.getElementById("mixerBackgroundDuck")?.checked,
        mixDuration: document.getElementById("mixerDurationMode")?.value || "matchMain",
        overlays: state.mixerOverlays.map((ov) => ({ ...toSourceEntryAsObject(ov.item), delaySeconds: ov.delaySeconds, volume: ov.volume })),
      }),
    });
    if (!res.ok) throw new Error(data.error || "Render failed.");
    // libraryItemId is deliberately stripped from what renderAudioResult
    // sees here — it's handled below instead with a richer "keep
    // editing" action, so the same result doesn't show two near-
    // identical "saved to library" messages.
    renderAudioResult(resultEl, { ...data, libraryItemId: null }, "mixer-render");
    // Real fix for "what if I want to edit the final output": the
    // render just got auto-saved to the Audio Library server-side (see
    // /api/audio/mixer/render) — refresh the library so it's right
    // there, and offer a direct one-click path to load it back in for
    // more editing (trim/reverse/speed/loop/fade) rather than leaving
    // the person to hunt for it themselves.
    if (data.libraryItemId) {
      resultEl.innerHTML += `<div class="xx-small text-success mt-1">✅ Saved to your library as a mix — <button type="button" class="btn btn-link btn-sm p-0 xx-small" id="mixerKeepEditingBtn">✏️ keep editing this result</button></div>`;
      document.getElementById("mixerKeepEditingBtn")?.addEventListener("click", async () => {
        await loadMixerLibrary();
        const newItem = (state.mixerLibraryItems || []).find((i) => String(i.id) === String(data.libraryItemId));
        if (!newItem) return alert("Couldn't find the saved mix — check the library list on the left.");
        state.mixerMainTrack = [{ ...newItem, edit: {} }];
        state.mixerIntro = null;
        state.mixerOutro = null;
        state.mixerBackground = null;
        state.mixerOverlays = [];
        renderMixerMainTrack();
        renderMixerIntroOutro();
        renderMixerBackground();
        renderMixerOverlays();
        resultEl.innerHTML = `<div class="xx-small text-muted">Loaded into the Main Track above — click ✏️ on it to trim, fade, reverse, change speed, or loop this mix, then render again.</div>`;
      });
    }
    // Same real fix as the Combine button above — a Mixer render used
    // to be a dead end for video too, only reachable indirectly later
    // via Flow Studio's Audio Library picker. This works directly from
    // the downloadUrl every Mixer render actually returns (100% local
    // ffmpeg, never a cloud base64 shape), fetched and converted the
    // same way an uploaded file is.
    resultEl.innerHTML += `<button type="button" class="btn btn-sm btn-outline-dark w-100 mt-1" id="mixerUseInFlowBtn">🎬 Use this in Flow Studio for a video</button>`;
    document.getElementById("mixerUseInFlowBtn")?.addEventListener("click", async (e) => {
      const useBtn = e.target;
      const originalUseLabel = useBtn.innerHTML;
      useBtn.disabled = true;
      useBtn.innerHTML = "Loading...";
      try {
        const blob = await (await fetch(data.downloadUrl)).blob();
        const audioBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Couldn't read the rendered mix."));
          reader.readAsDataURL(blob);
        });
        flowTalkingAudioBase64 = audioBase64;
        const preview = document.getElementById("flowTalkingAudioPreview");
        if (preview) { preview.src = audioBase64; preview.classList.remove("d-none"); }
        const audioModeSelect = document.getElementById("flowTalkingAudioMode");
        if (audioModeSelect) { audioModeSelect.value = "finished"; audioModeSelect.dispatchEvent(new Event("change")); }
        showAppMode("flow");
        const scenarioSelect = document.getElementById("flowScenario");
        if (scenarioSelect) { scenarioSelect.value = "talking"; scenarioSelect.dispatchEvent(new Event("change")); }
        logActivity("success", "Mixer render loaded into Flow Studio's talking-video section.");
      } catch (err) {
        alert("Couldn't send this to Flow Studio: " + err.message);
      } finally {
        useBtn.disabled = false;
        useBtn.innerHTML = originalUseLabel;
      }
    });
  } catch (err) {
    resultEl.innerHTML = `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});
// Overlays need {source, edit} as an object (not the string-or-object
// shorthand) since delaySeconds/volume get spread alongside it.
function toSourceEntryAsObject(item) {
  return item.edit && Object.keys(item.edit).length ? { source: item.audio, edit: item.edit } : { source: item.audio };
}
document.querySelector('#audioStudioTabs [data-bs-target="#mixerConsoleTabPane"]')?.addEventListener("shown.bs.tab", () => {
  loadMixerLibrary();
  renderMixerMainTrack();
  renderMixerBackground();
  renderMixerOverlays();
  renderMixerIntroOutro();
});
document.getElementById("voiceScriptCombineBtn")?.addEventListener("click", async () => {
  const resultEl = document.getElementById("voiceScriptCombineResult");
  const selectedTakes = state.voiceScript.lines
    .map((line) => (line.selectedVariationIndex != null ? line.variations[line.selectedVariationIndex] : null))
    .filter(Boolean);
  const missing = state.voiceScript.lines.length - selectedTakes.length;
  const songId = document.getElementById("voiceScriptSongPicker")?.value;
  const songPosition = document.getElementById("voiceScriptSongPosition")?.value || "end";
  const song = songId ? (state.songLibraryItems || []).find((s) => String(s.id) === songId) : null;
  const minRequired = song ? 1 : 2;
  if (selectedTakes.length < minRequired) return alert(song ? "Generate and select a take on at least 1 line first." : "Generate and select a take on at least 2 lines first.");
  // REAL GAP FIXED: this used to require every take to have a live Fal
  // URL, which silently blocked combining an uploaded/library-picked
  // line (only ever has base64, never a hosted URL) alongside generated
  // ones. The backend already normalizes base64 data URIs through the
  // same toFalImageUrl path proven for library songs — this just stops
  // blocking that case on the frontend too.
  if (!selectedTakes.every((v) => v.audioUrl || v.audio)) {
    return alert("One or more selected takes have no usable audio at all (an older take generated before this feature, or a take whose URL may have aged out) — regenerate or re-add that line and try again.");
  }
  const btn = document.getElementById("voiceScriptCombineBtn");
  btn.disabled = true;
  const originalLabel = btn.innerHTML;
  btn.innerHTML = "🔗 Combining...";
  resultEl.innerHTML = missing > 0 ? `<div class="xx-small text-warning mb-1">${missing} line(s) have no selected take — combining the ${selectedTakes.length} that do, in order.</div>` : "";
  try {
    // Song comes from the Audio Library as base64 only (no live Fal
    // URL was ever kept for it) — passed straight through as-is; the
    // backend normalizes it via the SAME toFalImageUrl pattern already
    // proven for BGM elsewhere in this app, no upload step needed.
    // Each take now prefers its real audioUrl but falls back to its
    // base64 audio (an uploaded/library-picked external line) — same
    // normalization handles either one correctly server-side.
    let orderedUrls = selectedTakes.map((v) => v.audioUrl || v.audio);
    if (song) orderedUrls = songPosition === "start" ? [song.audio, ...orderedUrls] : [...orderedUrls, song.audio];
    const { res, data } = await fetchJson("/api/voice/script/combine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioUrls: orderedUrls, runId: state.voiceScript.runId, userApiKey: getUserKey() }),
    });
    if (!res.ok) throw new Error(data.error || "Combine failed.");
    await refreshCreditsSummary();
    // data.audio only exists on the Fal-cloud path — the local
    // fallback returns downloadUrl instead (see renderAudioResult) and
    // has no base64 to hand the Audio Library, so only save there when
    // it's actually present rather than storing "undefined".
    if (data.audio) {
      saveToAudioLibrary({ type: "voice", name: `Combined script — ${state.voiceScript.lines.length} lines${song ? " + song" : ""}`, audioDataUri: data.audio, runId: state.voiceScript.runId, silent: true });
    }
    renderAudioResult(resultEl, data, "combined-script");
    // REAL GAP FIXED: a combine result used to be a dead end for video —
    // it was technically reachable later via Flow Studio's Audio
    // Library picker (now that both save paths actually reach the
    // library — see server.js's saveLocalRenderToLibrary), but nothing
    // here told you that, or did it for you. This works from EITHER
    // result shape (cloud base64 or the local-fallback's downloadUrl —
    // fetched and converted the same way an uploaded file is) so it's
    // real regardless of which path actually ran.
    resultEl.innerHTML += `<button type="button" class="btn btn-sm btn-outline-dark w-100 mt-1" id="voiceScriptUseInFlowBtn">🎬 Use this in Flow Studio for a video</button>`;
    document.getElementById("voiceScriptUseInFlowBtn")?.addEventListener("click", async (e) => {
      const useBtn = e.target;
      const originalUseLabel = useBtn.innerHTML;
      useBtn.disabled = true;
      useBtn.innerHTML = "Loading...";
      try {
        let audioBase64 = data.audio;
        if (!audioBase64 && data.downloadUrl) {
          const blob = await (await fetch(data.downloadUrl)).blob();
          audioBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Couldn't read the combined file."));
            reader.readAsDataURL(blob);
          });
        }
        flowTalkingAudioBase64 = audioBase64;
        const preview = document.getElementById("flowTalkingAudioPreview");
        if (preview) { preview.src = audioBase64; preview.classList.remove("d-none"); }
        const audioModeSelect = document.getElementById("flowTalkingAudioMode");
        if (audioModeSelect) { audioModeSelect.value = "finished"; audioModeSelect.dispatchEvent(new Event("change")); }
        showAppMode("flow");
        const scenarioSelect = document.getElementById("flowScenario");
        if (scenarioSelect) { scenarioSelect.value = "talking"; scenarioSelect.dispatchEvent(new Event("change")); }
        logActivity("success", "Combined audio loaded into Flow Studio's talking-video section.");
      } catch (err) {
        alert("Couldn't send this to Flow Studio: " + err.message);
      } finally {
        useBtn.disabled = false;
        useBtn.innerHTML = originalUseLabel;
      }
    });
  } catch (err) {
    resultEl.innerHTML += `<div class="alert alert-danger py-2 px-3 small">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
});
// Field edits — text/select/range inputs, delegated so it works for any
// number of lines without binding listeners individually.
document.getElementById("voiceScriptLines")?.addEventListener("input", (e) => {
  const lineEl = e.target.closest("[data-line-id]");
  const field = e.target.getAttribute("data-line-field");
  if (!lineEl || !field) return;
  const line = state.voiceScript.lines.find((l) => l.id === lineEl.getAttribute("data-line-id"));
  if (!line) return;
  if (field === "voiceSearch") {
    // Filters the sibling <select> in place, without a full
    // renderVoiceScript() — a re-render would wipe out the search box's
    // own text on every keystroke, since it isn't a persisted line
    // property. Hidden options just disappear from the open dropdown;
    // the current selection is preserved unless it's no longer visible,
    // in which case we jump to the first visible match rather than
    // silently keeping a hidden, invisible-to-the-user selection.
    const query = e.target.value.trim().toLowerCase();
    const selectEl = lineEl.querySelector('select[data-line-field="voiceId"]');
    if (selectEl) {
      let firstVisible = null;
      Array.from(selectEl.options).forEach((opt) => {
        const match = !query || (opt.getAttribute("data-search") || "").includes(query);
        opt.hidden = !match;
        if (match && !firstVisible) firstVisible = opt;
      });
      if (selectEl.selectedOptions[0]?.hidden && firstVisible) {
        selectEl.value = firstVisible.value;
        line.voiceId = firstVisible.value;
      }
    }
    return;
  }
  if (field === "speed" || field === "pitch") line[field] = parseFloat(e.target.value);
  else if (field === "variationCount") line[field] = parseInt(e.target.value);
  else if (field === "multilingualMode") line[field] = e.target.checked;
  else if (field === "targetDurationSeconds") line[field] = e.target.value ? parseFloat(e.target.value) : null;
  else line[field] = e.target.value;
  if (field === "modelId") {
    // Model changed — voice/emotion/language options are model-specific,
    // so reset to that model's own defaults and fully re-render this
    // line's controls (a partial update can't safely swap control types).
    const newModel = (state.voiceModels || []).find((m) => m.id === line.modelId);
    line.voiceId = newModel?.confirmedVoiceIds?.[0]?.id || "";
    line.emotion = "neutral";
    line.language = "";
    line.previewText = null; // stale preview belonged to the old model — clear rather than show wrong data until the new one loads
    renderVoiceScript();
    scheduleLinePreview(line);
  } else if (field === "sourceType") {
    // Swaps the entire line body between "generate from text" and
    // "use existing audio" — same full-rebuild reasoning as a model
    // change, since these aren't just different field values, they're
    // genuinely different control sets.
    renderVoiceScript();
    if (line.sourceType === "external") populateLineExternalLibrarySelect(line.id);
  } else if (field === "multilingualMode") {
    // Toggling this changes several parts of the line's own controls
    // (language row hidden, multilingual box shown, Generate button
    // label/behavior, Takes selector hidden) — needs a full re-render,
    // same reasoning as a model change above.
    renderVoiceScript();
  } else if (field === "speed" || field === "pitch") {
    // Just update the displayed number live, don't re-render the whole
    // list on every drag tick — same UX as the old single-line sliders.
    const labelEl = lineEl.querySelector(`label:has(+ [data-line-field="${field}"])`);
    if (labelEl) labelEl.textContent = `${field === "speed" ? "Speed" : "Pitch"} ${line[field]}`;
  }
  if (field === "text" || field === "speed") {
    // Live duration estimate — recomputed on every keystroke/speed drag
    // without a full re-render, same reasoning as the speed/pitch label
    // above: this needs to feel instant, not wait for a render cycle.
    const estEl = lineEl.querySelector("[data-line-duration-estimate]");
    if (estEl) estEl.textContent = `≈${estimateSpeechDurationSeconds(line.text, line.speed).toFixed(1)}s estimated (rough — actual pace varies by model/language)`;
  }
  if ((field === "text" || field === "targetDurationSeconds") && line.targetDurationSeconds) {
    // Real duration control acting: text length changed (or the target
    // itself changed) while a target is set — recompute and actually
    // APPLY the speed needed to approximate it, live, and reflect that
    // in both the speed slider itself and its label so it's never a
    // silent change the person has to go hunting for.
    const computed = computeSpeedForTargetDuration(line.text, line.targetDurationSeconds);
    if (computed != null) {
      line.speed = computed;
      const speedSlider = lineEl.querySelector('[data-line-field="speed"]');
      if (speedSlider) speedSlider.value = computed;
      const speedLabel = lineEl.querySelector('label:has(+ [data-line-field="speed"])');
      if (speedLabel) speedLabel.textContent = `Speed ${computed}`;
      const estEl2 = lineEl.querySelector("[data-line-duration-estimate]");
      if (estEl2) estEl2.textContent = `≈${estimateSpeechDurationSeconds(line.text, line.speed).toFixed(1)}s estimated (rough — actual pace varies by model/language)`;
    }
    const noteEl = lineEl.querySelector("[data-line-target-speed-note]");
    if (noteEl) noteEl.textContent = computed != null ? `→ speed set to ${computed}x` : "text too short to compute a speed for this target";
  } else if (field === "targetDurationSeconds" && !line.targetDurationSeconds) {
    // Target cleared — reset the note, leave whatever speed was last
    // computed in place rather than silently reverting it.
    const noteEl = lineEl.querySelector("[data-line-target-speed-note]");
    if (noteEl) noteEl.textContent = "sets speed automatically";
  }
  if (field === "text" || field === "targetDurationSeconds") {
    // Freeform-tag-model pacing suggestion — only the suggestion <span>
    // updates, never the number input itself, so typing a target
    // duration digit-by-digit doesn't lose focus every keystroke (that
    // would happen if the whole container got replaced instead).
    const suggestionEl = lineEl.querySelector("[data-line-pacing-suggestion]");
    if (suggestionEl) suggestionEl.innerHTML = renderPacingSuggestion(line, computePacingTag(line.text, line.targetDurationSeconds));
  }
  if (field === "text" || field === "language") {
    // Live script-mismatch check — same non-destructive-update pattern.
    // A full render here would be fine too (language is a <select>, not
    // continuous typing) but keeping it consistent with the text-typing
    // case above means one code path handles both triggers.
    renderLineMismatchWarning(lineEl, line);
  }
  if (field === "translateTargetLanguage") {
    // Enables/disables the Translate button live, without a full
    // re-render — same non-destructive-update reasoning as the search
    // filter above (a re-render mid-selection would just be jarring here
    // for no benefit).
    const btn = lineEl.querySelector('[data-line-action="translate"]');
    if (btn) btn.disabled = !line.translateTargetLanguage;
  }
  if (["text", "voiceId", "language", "speed", "pitch", "emotion", "targetDurationSeconds"].includes(field)) {
    scheduleLinePreview(line);
  }
  if (field !== "voiceSearch") scheduleSessionSave();
});
document.getElementById("voiceScriptLines")?.addEventListener("click", async (e) => {
  const lineEl = e.target.closest("[data-line-id]");
  if (!lineEl) return;
  const lineId = lineEl.getAttribute("data-line-id");
  const lineIndex = state.voiceScript.lines.findIndex((l) => l.id === lineId);
  const line = state.voiceScript.lines[lineIndex];
  if (!line) return;

  // Markup toolbar clicks — insert directly into THIS line's own
  // textarea at the cursor, never a full renderVoiceScript() (which
  // would blow away the cursor position the person just clicked into).
  const markupInsert = e.target.closest("[data-markup-insert]")?.getAttribute("data-markup-insert");
  if (markupInsert) {
    insertAtCursor(lineEl.querySelector('textarea[data-line-field="text"]'), markupInsert);
    return;
  }
  if (e.target.closest("[data-markup-custom]")) {
    const tag = prompt('Describe the delivery/tone to insert (e.g. "nervously", "with a smile", "building excitement"):');
    if (tag && tag.trim()) insertAtCursor(lineEl.querySelector('textarea[data-line-field="text"]'), `*${tag.trim()}*`);
    return;
  }
  if (e.target.closest("[data-markup-ai-suggest]")) {
    if (!line.text?.trim()) return alert("Type something for this line first.");
    const btn = e.target.closest("[data-markup-ai-suggest]");
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "🪄 Thinking...";
    try {
      const { res, data } = await fetchJson("/api/voice/suggest-markup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line.text, modelId: line.modelId, intention: line.intention || undefined, textModel: getTextModel(), userApiKey: getUserKey(), runId: state.voiceScript.runId }),
      });
      if (!res.ok) throw new Error(data.error || "Couldn't get AI suggestions.");
      line.text = data.taggedText;
      // Unified control, real per-model result: for a model with
      // confirmedEmotions (MiniMax), the intention ALSO picks the
      // closest real emotion — validated server-side against the
      // actual list, so this can't silently set something invalid.
      if (data.emotion) line.emotion = data.emotion;
      renderVoiceScript();
      scheduleLinePreview(line);
    } catch (err) {
      alert("AI markup suggestion failed: " + err.message);
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
    return;
  }

  // Translate action — real backend (/api/voice/prepare-text), reused
  // here for the first time in a reachable UI. Replaces the line's text
  // with genuinely translated (not transliterated) native-script text,
  // and — nice, honest bonus — if the target model has that exact
  // language in its own confirmedLanguages, auto-selects it there too,
  // so translation and the model's own pronunciation setting don't end
  // up pointing at two different languages by accident.
  if (e.target.closest('[data-line-action="translate"]')) {
    if (!line.text?.trim()) return alert("Type something for this line first.");
    if (!line.translateTargetLanguage) return;
    await translateLine(line, line.translateTargetLanguage);
    return;
  }
  // Quick-fix path from the mismatch warning itself — reuses the exact
  // same translateLine function, just sourcing the target language from
  // the line's already-selected model-language dropdown instead of
  // requiring a second, separate pick in the translate row.
  if (e.target.closest('[data-line-action="quick-translate"]')) {
    const baseLang = (line.language || "").replace(/\s*\(.+\)\s*$/, "").trim();
    if (!baseLang) return;
    line.translateTargetLanguage = baseLang;
    await translateLine(line, baseLang);
    return;
  }
  // Pacing tag insert — deterministic, no AI call. Inserted at the very
  // start of the line (a pacing cue applies to the whole delivery, not
  // one phrase, unlike the word-level markup toolbar tags above it).
  if (e.target.closest("[data-line-action=\"apply-pacing-tag\"]")) {
    const tag = e.target.closest("[data-line-action=\"apply-pacing-tag\"]").getAttribute("data-pacing-tag");
    line.text = `*${tag}* ${line.text}`.trim();
    renderVoiceScript();
    scheduleLinePreview(line);
    scheduleSessionSave();
    return;
  }
  // Voice preview — real backend (isPreview flag on /api/voice/generate,
  // with its own persisted server-side cache) that already existed but
  // had no reachable trigger anywhere in the active UI. Cached client-
  // side too (state.voicePreviewCache, same key convention as before)
  // so repeat previews of the same model+voice within this session are
  // instant and free, not a second billed call.
  if (e.target.closest('[data-line-action="preview-voice"]')) {
    const btn = e.target.closest('[data-line-action="preview-voice"]');
    if (!line.modelId || !line.voiceId) return alert("Pick a model and voice first.");
    const cacheKey = `${line.modelId}:${line.voiceId}`;
    if (state.voicePreviewCache[cacheKey]) {
      playAudioExclusively(state.voicePreviewCache[cacheKey]);
      return;
    }
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "...";
    try {
      const { res, data } = await fetchJson("/api/voice/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hello, this is a preview of this voice.", modelId: line.modelId, voiceId: line.voiceId,
          isPreview: true, runId: crypto.randomUUID(), userApiKey: getUserKey(),
        }),
      });
      if (!res.ok) throw new Error(data.error || "Preview failed.");
      state.voicePreviewCache[cacheKey] = data.audio;
      playAudioExclusively(data.audio);
    } catch (err) {
      alert("Voice preview failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
    return;
  }
  // only reachable from the old, now-removed single-textbox UI. Wraps
  // the parts matching the instruction in [Language]...[/Language]
  // tags, ready for the multi-language generation path below.
  if (e.target.closest('[data-line-action="auto-tag"]')) {
    if (!line.text?.trim()) return alert("Type something for this line first.");
    if (!line.multilingualAutoTagInstruction?.trim()) return;
    line.isAutoTagging = true;
    renderVoiceScript();
    try {
      const { res, data } = await fetchJson("/api/voice/auto-tag-languages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: line.text, instruction: line.multilingualAutoTagInstruction, textModel: getTextModel(), userApiKey: getUserKey(), runId: state.voiceScript.runId }),
      });
      if (!res.ok) throw new Error(data.error || "Auto-tagging failed.");
      line.text = data.taggedScript;
    } catch (err) {
      alert("Auto-tag failed: " + err.message);
    } finally {
      line.isAutoTagging = false;
      renderVoiceScript();
    }
    return;
  }

  const lineAction = e.target.closest("[data-line-action]")?.getAttribute("data-line-action");
  if (lineAction === "delete") {
    state.voiceScript.lines.splice(lineIndex, 1);
    renderVoiceScript();
    saveVoiceScriptSession();
    return;
  }
  if (lineAction === "moveUp" && lineIndex > 0) {
    [state.voiceScript.lines[lineIndex - 1], state.voiceScript.lines[lineIndex]] = [state.voiceScript.lines[lineIndex], state.voiceScript.lines[lineIndex - 1]];
    renderVoiceScript();
    return;
  }
  if (lineAction === "moveDown" && lineIndex < state.voiceScript.lines.length - 1) {
    [state.voiceScript.lines[lineIndex + 1], state.voiceScript.lines[lineIndex]] = [state.voiceScript.lines[lineIndex], state.voiceScript.lines[lineIndex + 1]];
    renderVoiceScript();
    return;
  }
  if (lineAction === "generate") {
    if (!line.text?.trim()) return alert("Type something for this line first.");
    // Real gate, not a nag: this is the exact scenario that produced
    // broken/truncated output with zero warning — don't let a real,
    // billed generation run against a known language/script mismatch
    // without at least a chance to cancel and translate first. Doesn't
    // apply in multilingual mode — mixed-language text is the whole
    // point there, so a single-language script check would be a false
    // positive by design.
    const mismatch = line.multilingualMode ? null : languageScriptMismatch(line.text, line.language);
    if (mismatch && !confirm(`This text has no ${mismatch} script in it yet, but ${mismatch} is selected as the language — the model may produce broken or truncated output. Generate anyway?`)) {
      return;
    }
    line.isGenerating = true;
    renderVoiceScript();
    try {
      if (line.multilingualMode) {
        // Multi-language path — real backend (/api/voice/generate-
        // multilingual), previously unreachable from any live UI.
        // Produces exactly ONE stitched result, not N creative-direction
        // takes — directing multiple simultaneous variations across a
        // multi-segment stitched clip isn't a coherent concept the way
        // "different takes of one voice" is for a single-language line.
        const { res, data } = await fetchJson("/api/voice/generate-multilingual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: line.text, modelId: line.modelId, voiceId: line.voiceId,
            baseLanguage: line.multilingualBaseLanguage, speed: line.speed, pitch: line.pitch, emotion: line.emotion,
            textModel: getTextModel(), runId: state.voiceScript.runId, userApiKey: getUserKey(),
          }),
        });
        if (!res.ok) throw new Error(data.error || "Multi-language generation failed.");
        line.variations = [{
          label: "Multi-language", audio: data.audio, audioUrl: data.audioUrl, durationMs: data.durationMs, modelUsed: data.modelUsed,
          error: null, segments: data.segments || [],
        }];
        line.cappedReason = null;
        line.selectedVariationIndex = 0;
      } else {
        const { res, data } = await fetchJson("/api/voice/script/generate-variations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // REAL FIX: voiceId/language/speed/pitch/emotion used to be
          // silently dropped here — the dropdowns updated `line.*` in
          // local state, but none of it ever reached the backend, so
          // picking a specific voice or language had zero effect on the
          // actual generated audio. All five now go through.
          body: JSON.stringify({
            lineText: line.text, modelId: line.modelId, count: line.variationCount,
            voiceId: line.voiceId, language: line.language || undefined,
            speed: line.speed, pitch: line.pitch, emotion: line.emotion,
            runId: state.voiceScript.runId, userApiKey: getUserKey(),
          }),
        });
        if (!res.ok) throw new Error(data.error || "Failed to generate takes.");
        line.variations = data.results || [];
        line.cappedReason = data.cappedReason || null;
        line.selectedVariationIndex = line.variations.findIndex((v) => v.audio && !v.error);
        if (line.selectedVariationIndex === -1) line.selectedVariationIndex = null;
      }
      // Auto-save every successful take to the Audio Library, matching
      // how the Video Library already auto-persists everything
      // generated — no manual "save" click required to keep it.
      await Promise.all(
        line.variations
          .filter((v) => v.audio && !v.error)
          .map((v) => saveToAudioLibrary({
            type: "voice", name: `${line.name?.trim() || `Line ${lineIndex + 1}`} — ${v.label}`, audioDataUri: v.audio,
            modelUsed: v.modelUsed, voiceUsed: v.voiceId, runId: state.voiceScript.runId,
            metadata: { emotion: v.emotion, label: v.label }, silent: true,
          })),
      );
      await refreshCreditsSummary();
      saveVoiceScriptSession();
    } catch (err) {
      alert("Couldn't generate takes: " + err.message);
    } finally {
      line.isGenerating = false;
      renderVoiceScript();
    }
    return;
  }

  const variationEl = e.target.closest("[data-variation-index]");
  const variationAction = e.target.closest("[data-variation-action]")?.getAttribute("data-variation-action");
  if (variationEl && variationAction) {
    const vIndex = parseInt(variationEl.getAttribute("data-variation-index"));
    if (variationAction === "use") {
      line.selectedVariationIndex = vIndex;
      renderVoiceScript();
      saveVoiceScriptSession();
    } else if (variationAction === "download") {
      const v = line.variations[vIndex];
      if (v?.audio) {
        const a = document.createElement("a");
        a.href = v.audio;
        a.download = `line-${lineIndex + 1}-${(v.label || "take").replace(/[^a-z0-9]+/gi, "-")}.mp3`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }
  }
});

document.getElementById("voiceStudioRunBtn")?.addEventListener("click", async () => {
  const text = document.getElementById("voiceStudioText")?.value?.trim();
  if (!text) return alert("Type something to speak first.");
  // Guaranteed failure, not a maybe — a voice name that belongs to a
  // different vendor will never work, so this stops before wasting a
  // real, billed translation step first (exactly the sequence seen in
  // production: translation succeeded, then generation failed on this).
  const freeformVisible = !document.getElementById("voiceStudioVoiceIdFreeform")?.classList.contains("d-none");
  if (freeformVisible) {
    const typed = document.getElementById("voiceStudioVoiceIdFreeform")?.value?.trim().toLowerCase();
    const currentModelId = readModelSelectEl(document.getElementById("voiceStudioModelSelect"));
    const currentModel = (state.voiceModels || []).find((m) => m.id === currentModelId);
    const matchingSavedVoice = (state.customVoices || []).find((v) => v.name.toLowerCase() === typed);
    if (matchingSavedVoice && matchingSavedVoice.model_family !== currentModel?.modelFamily) {
      return alert(`"${matchingSavedVoice.name}" only exists on MiniMax — it was cloned there and ${currentModel?.label || "this model"} has no way to recognize it. Switch to MiniMax to use it, or pick a different voice here.`);
    }
  }
  const suggestionEl = document.getElementById("voiceStudioLanguageSuggestion");
  if (suggestionEl && !suggestionEl.classList.contains("d-none")) {
    const proceed = confirm("This language isn't confirmed for the currently selected model — it may not sound right or may fail. Generate anyway with this model? (Cancel to switch to ElevenLabs instead.)");
    if (!proceed) return;
  }
  await runVoiceGeneration(text);
});
state.voiceStudioVersions = [];
async function runVoiceGeneration(text) {
  const resultEl = document.getElementById("voiceStudioResult");
  const btn = document.getElementById("voiceStudioRunBtn");
  const wantsTranslation = document.getElementById("voiceStudioTranslateToggle")?.checked;
  const isPrepared = !document.getElementById("voiceStudioPreparedRow")?.classList.contains("d-none");
  if (wantsTranslation && !isPrepared) {
    alert('Click "Prepare & Preview Text" first — that is what actually converts and lets you review it before anything is spoken.');
    return;
  }
  const translateTo = wantsTranslation ? document.getElementById("voiceStudioTranslateTarget")?.value : null;
  // Once prepared, the prepared (and possibly hand-edited) text IS the
  // real text to speak — no second, silent server-side translation on
  // top of it.
  const actualText = isPrepared ? document.getElementById("voiceStudioPreparedText")?.value?.trim() : text;
  if (!actualText) return alert("The prepared text is empty.");
  const runId = state.voiceStudioRunId || crypto.randomUUID();
  btn.disabled = true;
  toggleStatusView(true, "Generating speech...");
  startProgressPolling(runId);
  const modelId = readModelSelectEl(document.getElementById("voiceStudioModelSelect"));
  const voiceId = document.getElementById("voiceStudioVoiceIdFreeform")?.classList.contains("d-none")
    ? document.getElementById("voiceStudioVoiceId")?.value
    : document.getElementById("voiceStudioVoiceIdFreeform")?.value?.trim();
  try {
    const { res, data } = await fetchJson("/api/voice/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        text: actualText,
        modelId,
        voiceId,
        speed: parseFloat(document.getElementById("voiceStudioSpeed")?.value),
        pitch: parseInt(document.getElementById("voiceStudioPitch")?.value),
        emotion: document.getElementById("voiceStudioEmotion")?.value,
        language: document.getElementById("voiceStudioLanguage")?.value,
        textModel: getTextModel(),
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Voice generation failed.");
    // New version goes on top, older ones stay listed below — nothing
    // gets silently overwritten if you try a different voice and want
    // to compare against what you already had.
    state.voiceStudioVersions.unshift({ audio: data.audio, modelUsed: data.modelUsed, translatedText: isPrepared ? actualText : null, translateTo, finalSpokenText: data.finalSpokenText, deliveryNote: data.deliveryNote, strippedMarkersNote: data.strippedMarkersNote, ts: Date.now() });
    renderVoiceStudioResults(actualText);
    logActivity("success", `Voice generated with ${data.modelUsed}${isPrepared ? ` (prepared for ${translateTo})` : ""}.`);
  } catch (err) {
    resultEl.innerHTML = state.voiceStudioVersions.length ? resultEl.innerHTML : `<div class="alert alert-danger py-2 px-3 small">${err.message}</div>`;
    if (!state.voiceStudioVersions.length) logActivity("warning", `Voice generation failed — ${err.message}`);
    else alert("Regeneration failed: " + err.message);
    if (/voice not found|isn't recognized/i.test(err.message)) {
      const currentModel = (state.voiceModels || []).find((m) => m.id === modelId);
      if (currentModel?.confirmedVoiceIds) {
        currentModel.confirmedVoiceIds = currentModel.confirmedVoiceIds.filter((v) => v.id !== voiceId);
        updateVoiceStudioModelOptions();
        logActivity("warning", `"${voiceId}" removed from the picker — confirmed not working.`);
      }
    }
  } finally {
    btn.disabled = false;
    toggleStatusView(false);
  }
}
function renderVoiceStudioResults(sourceText) {
  const resultEl = document.getElementById("voiceStudioResult");
  resultEl.innerHTML = state.voiceStudioVersions.map((v, i) => `
    <div class="border rounded p-2 mb-2 ${i === 0 ? "border-primary" : ""}">
      ${i === 0 ? `<div class="xx-small fw-bold text-primary mb-1">Latest</div>` : `<div class="xx-small text-muted mb-1">Earlier version</div>`}
      ${v.translatedText ? `<div class="alert alert-info py-2 px-3 small mb-2"><strong>Spoken as (${escapeHtml(v.translateTo)}):</strong> ${escapeHtml(v.translatedText)}</div>` : ""}
      ${v.deliveryNote ? `<div class="xx-small text-muted mb-2">🎭 Delivery note detected and pulled out of the script: "${escapeHtml(v.deliveryNote)}"</div>` : ""}
      ${v.strippedMarkersNote ? `<div class="alert alert-warning py-2 px-3 small mb-2">⚠️ ${escapeHtml(v.strippedMarkersNote)}</div>` : ""}
      ${v.finalSpokenText ? `<p class="xx-small text-muted mb-2"><strong>Actually sent to the model</strong> (markers converted): ${escapeHtml(v.finalSpokenText)}</p>` : ""}
      <audio controls class="w-100 mb-2" src="${v.audio}"></audio>
      <div class="d-flex gap-2">
        <a href="${v.audio}" data-download-url="${v.audio}" data-download-filename="voice-${v.ts}.mp3" class="btn btn-sm btn-dark fw-bold flex-grow-1">⬇️ Download</a>
        ${i === 0 ? `<button type="button" class="btn btn-sm btn-outline-primary flex-grow-1" id="voiceStudioRegenBtn">🔄 Regenerate with current voice</button>` : ""}
      </div>
      ${i === 0 ? `<button type="button" class="btn btn-sm btn-outline-dark w-100 mt-2" id="voiceStudioUseInFlowBtn">🎬 Use this audio for a talking video in Flow Studio</button>` : ""}
      <p class="xx-small text-muted mb-0 mt-1">${escapeHtml(v.modelUsed)}</p>
    </div>`).join("");
  document.getElementById("voiceStudioRegenBtn")?.addEventListener("click", () => runVoiceGeneration(sourceText));
  document.getElementById("voiceStudioUseInFlowBtn")?.addEventListener("click", () => {
    flowTalkingAudioBase64 = state.voiceStudioVersions[0].audio;
    const preview = document.getElementById("flowTalkingAudioPreview");
    if (preview) {
      preview.src = flowTalkingAudioBase64;
      preview.classList.remove("d-none");
    }
    logActivity("success", "Audio ready in Flow Studio's talking-video section.");
    document.getElementById("flowModeNavBtn")?.click();
    document.getElementById("flowScenario").value = "talking";
    document.getElementById("flowScenario").dispatchEvent(new Event("change"));
  });
}

function getActiveBatchImage(entry) {
  if (!entry) return null;
  if (entry.useOriginal) return entry.original || entry.isolated || null;
  return entry.isolated || entry.original || null;
}
function updateBatchGenerateBtnState() {
  dom.batchGenerateBtn.disabled =
    state.batchGarments.filter((g) => getActiveBatchImage(g)).length === 0;
}
function renderBatchGarmentList() {
  dom.batchGarmentList.innerHTML = "";
  state.batchGarments.forEach((g, i) => {
    const chip = document.createElement("div");
    chip.className = "position-relative border rounded p-1 bg-white";
    chip.style.width = "112px";
    const activeSrc = getActiveBatchImage(g);
    const chokeVal = typeof g.choke === "number" ? g.choke : 3;
    chip.innerHTML = `
      <img src="${activeSrc || ""}" class="w-100 rounded" style="height: 84px; object-fit: contain; background: #f8f9fa;" alt="Product ${i + 1}">
      <button type="button" class="btn btn-sm btn-danger position-absolute top-0 end-0 p-0 d-flex align-items-center justify-content-center" style="width: 20px; height: 20px; font-size: 12px; transform: translate(30%, -30%); border-radius: 50%;" data-remove-idx="${i}" title="Remove">✕</button>
      ${g.isolated && g.original ? `<button type="button" class="btn btn-sm ${g.useOriginal ? "btn-warning" : "btn-outline-secondary"} position-absolute top-0 start-0 p-0 d-flex align-items-center justify-content-center" style="width: 20px; height: 20px; font-size: 11px; transform: translate(-30%, -30%); border-radius: 50%;" data-toggle-orig-idx="${i}" title="${g.useOriginal ? "Using original photo — click to use AI cutout instead" : "Using AI cutout — click to use original photo instead"}">${g.useOriginal ? "📷" : "✂️"}</button>` : ""}
      ${activeSrc ? `<a href="${activeSrc}" download="${(g.label || g.fileName || "product").replace(/\s+/g, "-")}.png" class="btn btn-sm btn-outline-dark position-absolute p-0 d-flex align-items-center justify-content-center" style="width: 18px; height: 18px; font-size: 10px; bottom: 2px; right: 2px; border-radius: 50%; z-index: 3; background: white;" title="Download this image">⬇️</a>` : ""}
      ${g.useOriginal ? `<span class="badge bg-warning text-dark position-absolute" style="bottom: 76px; left: 2px; font-size: 0.5rem;">ORIGINAL</span>` : ""}
      ${g.rawIsolated && !g.useOriginal ? `
        <div class="d-flex align-items-center gap-1 mt-1" title="Edge trim — shave off color halos">
          <input type="range" class="form-range form-range-sm" min="0" max="20" step="1" value="${chokeVal}" data-choke-idx="${i}" style="height: 12px;">
        </div>` : ""}
      <input type="text" class="form-control form-control-sm mt-1" placeholder="Label (optional)" value="${g.label || ""}" data-label-idx="${i}" style="font-size: 0.68rem; padding: 2px 4px;">
      <input type="text" class="form-control form-control-sm mt-1" placeholder="Dimensions (optional)" value="${g.dimensions || ""}" data-dimensions-idx="${i}" style="font-size: 0.62rem; padding: 2px 4px;">
      ${g.isolated ? "" : `<div class="small text-muted text-center" style="font-size:0.65rem;">processing...</div>`}
    `;
    dom.batchGarmentList.appendChild(chip);
  });
  dom.batchGarmentList.querySelectorAll("[data-remove-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-remove-idx"));
      state.batchGarments.splice(idx, 1);
      renderBatchGarmentList();
      updateBatchGenerateBtnState();
    });
  });
  dom.batchGarmentList.querySelectorAll("[data-label-idx]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const idx = parseInt(e.target.getAttribute("data-label-idx"));
      if (state.batchGarments[idx]) state.batchGarments[idx].label = e.target.value;
    });
  });
  dom.batchGarmentList.querySelectorAll("[data-dimensions-idx]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const idx = parseInt(e.target.getAttribute("data-dimensions-idx"));
      if (state.batchGarments[idx]) state.batchGarments[idx].dimensions = e.target.value;
    });
  });
  dom.batchGarmentList.querySelectorAll("[data-toggle-orig-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-toggle-orig-idx"));
      const entry = state.batchGarments[idx];
      if (!entry || !entry.original) return;
      entry.useOriginal = !entry.useOriginal;
      renderBatchGarmentList();
    });
  });
  dom.batchGarmentList.querySelectorAll("[data-choke-idx]").forEach((slider) => {
    slider.addEventListener("change", async (e) => {
      const idx = parseInt(e.target.getAttribute("data-choke-idx"));
      const entry = state.batchGarments[idx];
      if (!entry || !entry.rawIsolated) return;
      const val = parseInt(e.target.value);
      entry.choke = val;
      try {
        entry.isolated = await applyColorDecontamination(entry.rawIsolated, val);
        renderBatchGarmentList();
      } catch (err) {
        console.warn("Batch edge trim failed:", err.message);
      }
    });
  });
}
dom.batchImageInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const remainingSlots = 8 - state.batchGarments.length;
  const toProcess = files.slice(0, Math.max(0, remainingSlots));
  if (files.length > toProcess.length) {
    alert(`Batch mode supports up to 8 products — only the first ${toProcess.length} of ${files.length} were added.`);
  }
  if (!toProcess.length) return;
  const entries = toProcess.map((file) => ({
    rawIsolated: null, isolated: null, original: null, useOriginal: false,
    fileName: file.name, label: "", dimensions: "", choke: 3,
  }));
  entries.forEach((entry) => state.batchGarments.push(entry));
  renderBatchGarmentList();
  updateBatchGenerateBtnState();
  toggleStatusView(true, `Removing backgrounds for ${toProcess.length} image(s)...`);
  try {
    for (let i = 0; i < toProcess.length; i++) {
      const file = toProcess[i];
      const entry = entries[i];
      toggleStatusView(true, `Removing background: image ${i + 1} of ${toProcess.length}...`);
      let settled = false;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const normalized = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const MAX_DIMENSION = getDeviceCapabilities();
            let width = img.width, height = img.height;
            if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
              if (width > height) { height = Math.round((height * MAX_DIMENSION) / width); width = MAX_DIMENSION; }
              else { width = Math.round((width * MAX_DIMENSION) / height); height = MAX_DIMENSION; }
            }
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            canvas.getContext("2d").drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/png"));
          };
          img.src = dataUrl;
        });
        entry.original = normalized;
        const rawIsolated = await withTimeout(
          window.removeProductBackground(normalized, (progress) => {
            if (settled) return;
            if (progress.status === "progress") {
              toggleStatusView(true, `Loading local AI models (image ${i + 1} of ${toProcess.length}): ${progress.progress}%`);
            }
          }),
          90000,
          "Local background removal timed out after 90 seconds — the AI model download may have stalled."
        );
        settled = true;
        entry.rawIsolated = rawIsolated;
        entry.isolated = await applyColorDecontamination(rawIsolated, entry.choke);
      } catch (err) {
        settled = true;
        console.warn(`Batch garment "${file.name}" failed background removal:`, err.message);
        entry.isolated = null;
        if (entry.original) entry.useOriginal = true;
      }
      renderBatchGarmentList();
      updateBatchGenerateBtnState();
    }
  } finally {
    toggleStatusView(false);
  }
  dom.batchImageInput.value = "";
});
dom.batchModelReferenceInput.addEventListener(
  "change",
  handleBatchReferenceUpload,
);
dom.batchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const readyItems = state.batchGarments.filter((g) => getActiveBatchImage(g));
  if (readyItems.length === 0)
    return alert("Add at least one product photo and wait for background removal to finish.");
  // Reuse the run_id minted when the reference photo was analyzed (if
  // any), so this campaign's row and its pre-flight analysis/moderation
  // costs share one run_id — then clear it immediately so a LATER,
  // unrelated batch submit (without a fresh reference upload) doesn't
  // silently reuse a stale id and overwrite this campaign's saved row.
  const runId = (state.batchRunId = state.pendingBatchRunId || crypto.randomUUID());
  state.pendingBatchRunId = null;
  try {
    warnIfReliabilityIssues();
    toggleStatusView(true, `Analyzing ${readyItems.length} product(s) and planning the shoot...`);
    startProgressPolling(runId);
    dom.batchResultsSection.classList.add("d-none");
    dom.batchStage1View.classList.add("d-none");
    dom.batchPromptReviewContainer.classList.add("d-none");
    const includeHuman = dom.includeHumanToggle.checked;
    const fullResImages = readyItems.map((g) => getActiveBatchImage(g));
    const classificationImages = await Promise.all(fullResImages.map((img) => resizeImageForClassification(img)));
    const productLabels = readyItems.map((g) => g.label || "");
    const productDimensions = readyItems.map((g) => g.dimensions || "");
    const payload = {
      runId,
      brandName: document.getElementById("batchBrandName").value,
      productDescription: document.getElementById("batchProductDesc").value,
      usageContext: document.getElementById("batchUsageContext").value,
      creativeDirection: document.getElementById("batchCreativeDirection").value,
      negativeDirectives: document.getElementById("batchNegativeDirectives").value,
      productImages: fullResImages,
      productImagesForClassification: classificationImages,
      productLabels,
      productDimensions,
      includeHuman,
      modelAppearance: includeHuman ? document.getElementById("batchModelAppearance").value : "",
      modelBodyType: includeHuman ? (dom.batchModelBodyType ? dom.batchModelBodyType.value : "") : "",
      modelExpression: includeHuman ? document.getElementById("batchModelExpression").value : "",
      modelWardrobe: includeHuman ? document.getElementById("batchModelWardrobe").value : "",
      modelPose: includeHuman ? document.getElementById("batchModelPose").value : "",
      modelReferenceBase64: includeHuman ? state.batchModelReferenceBase64 : null,
      brandProfile: getBrandProfile(),
      textModel: getTextModel(),
      userApiKey: getUserKey(),
    };
    const { res, data } = await fetchJson("/api/generate-batch-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Failed to analyze batch.");
    state.batchRunId = data.runId || runId;
    saveActiveRun(state.batchRunId, "batch");
    state.batchGeneratedShared = {
      environment: data.environment, toneOfVoice: data.toneOfVoice,
      lightingStrategy: data.lightingStrategy, physicalStaging: data.physicalStaging,
      seedIdentity: data.seedIdentity,
    };
    state.batchItems = data.items || [];
    state.batchSubmittedPayload = {
      productImages: fullResImages, productLabels, productDimensions,
      includeHuman, aspectRatio: dom.batchAspectRatio.value,
    };
    renderBatchGeneratedConcepts(data, readyItems);
    if (data.moderationNote) logActivity("warning", `Batch Step 1: ${data.moderationNote}`);
    logActivity("success", `Batch Step 1 complete: ${(data.items || []).length} product(s) analyzed.`);
  } catch (err) {
    console.error("Batch Text Error:", err);
    alert("Batch analysis failed: " + err.message);
  } finally {
    toggleStatusView(false);
  }
});
function renderBatchGeneratedConcepts(data, readyItems) {
  dom.batchPlaceholderView.classList.add("d-none");
  dom.batchStage1View.classList.remove("d-none");
  dom.batchCaptionContainer.innerHTML = (data.captions || [])
    .map((cap, i) => `<div class="mb-2 p-2 bg-white rounded border small"><strong>Option ${i + 1}:</strong> ${cap}</div>`)
    .join("");
  dom.batchTagContainer.innerText = (data.tags || []).join(" ");
  dom.batchEnvironmentText.innerText = data.environment || "";
  dom.batchToneText.innerText = data.toneOfVoice || "";
  const container = dom.batchDynamicPromptList;
  container.innerHTML = "";
  dom.batchPromptCountBadge.innerText = `${state.batchItems.length} Product(s)`;
  state.batchItems.forEach((item, index) => {
    const wearBadge = item.silhouetteLockAppropriate === false
      ? `<span class="badge bg-warning text-dark ms-1">👘 draped/wrapped</span>` : "";
    const outfitBadge = item.productWornAsOutfit
      ? `<span class="badge bg-primary ms-1">👗 worn as outfit</span>` : "";
    const identityBadge = item.identityLockSafe === false
      ? `<span class="badge bg-secondary ms-1">narrative route</span>` : "";
    const tierBadge = item.modelTierRecommendation === "pro"
      ? `<span class="badge bg-dark ms-1" title="${escapeHtml(item.modelTierReasoning || "")}">🎛️ pro</span>` : "";
    const card = document.createElement("div");
    card.className = "card border-light shadow-sm p-3 bg-light";
    card.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-1">
        <span class="fw-bold text-dark small">${readyItems[index]?.label || item.productLabel || `Product ${index + 1}`}${wearBadge}${outfitBadge}${identityBadge}${tierBadge}</span>
      </div>
      <textarea class="form-control form-control-sm batch-prompt-editable-input" rows="3" data-batch-index="${index}" style="font-size: 0.85rem; line-height: 1.4;">${item.imagePromptSeed || ""}</textarea>
      ${item.modelTierRecommendation === "pro" ? `<p class="xx-small text-muted mb-0 mt-1">🎛️ AI picked pro for this one — ${escapeHtml(item.modelTierReasoning || "no reasoning given")}. Override with the dropdown below if you disagree.</p>` : ""}
      <div class="mt-2">
        <label class="form-label xx-small text-muted mb-1">Image model for this product</label>
        ${modelSelectHtml({ models: state.imageModels, dataAttr: "data-batch-frame-model-idx", index, selectedValue: state.batchFrameModels[index] || "", minReferenceImages: dom.includeHumanToggle.checked ? 2 : 1 })}
      </div>
    `;
    container.appendChild(card);
    if (item.modelTierRecommendation === "pro") {
      logActivity("info", `${item.productLabel || `Product ${index + 1}`}: AI picked pro — ${item.modelTierReasoning || "no reasoning given"}.`);
    }
  });
  dom.batchPromptReviewContainer.classList.remove("d-none");
  document.querySelectorAll(".batch-prompt-editable-input").forEach((textarea) => {
    textarea.addEventListener("input", (e) => {
      const idx = parseInt(e.target.getAttribute("data-batch-index"));
      if (state.batchItems[idx]) state.batchItems[idx].imagePromptSeed = e.target.value;
    });
  });
  dom.batchStage1View.scrollIntoView({ behavior: "smooth", block: "start" });
}
function syncBatchFrameModelsFromCards() {
  state.batchFrameModels = state.batchItems.map((_, i) => readModelSelectValue("data-batch-frame-model-idx", i));
}
async function launchBatchPhotoshoot() {
  if (!state.batchSubmittedPayload || state.batchItems.length === 0) return;
  const runId = state.batchRunId || crypto.randomUUID();
  try {
    toggleStatusView(true, `Running batch photoshoot for ${state.batchItems.length} product(s)...`);
    startProgressPolling(runId);
    syncBatchFrameModelsFromCards();
    const includeHuman = state.batchSubmittedPayload.includeHuman;
    const payload = {
      runId,
      productImages: state.batchSubmittedPayload.productImages,
      productLabels: state.batchSubmittedPayload.productLabels,
      items: state.batchItems,
      imageModel: getGlobalBatchImageModel(),
      imageResolution: getGlobalBatchImageResolution(),
      frameModels: state.batchFrameModels,
      environment: state.batchGeneratedShared?.environment,
      toneOfVoice: state.batchGeneratedShared?.toneOfVoice,
      lightingStrategy: state.batchGeneratedShared?.lightingStrategy,
      physicalStaging: state.batchGeneratedShared?.physicalStaging,
      seedIdentity: state.batchGeneratedShared?.seedIdentity,
      includeHuman,
      shotsPerItem: parseInt(dom.shotsPerGarment.value) || 1,
      backgroundConsistent: dom.backgroundConsistentToggle.checked,
      lockWardrobe: dom.batchLockWardrobe ? dom.batchLockWardrobe.checked : true,
      aspectRatio: state.batchSubmittedPayload.aspectRatio,
      modelReferenceBase64: includeHuman ? state.batchModelReferenceBase64 : null,
      matchReferenceOutfit: includeHuman ? dom.batchMatchReferenceOutfit.checked : false,
      subjectSelectionNote: includeHuman ? state.batchSubjectSelectionNote : "",
      modelTier: getBatchModelTier(),
      skipCanonicalRender: dom.batchSkipCanonicalRender ? dom.batchSkipCanonicalRender.checked : false,
      userApiKey: getUserKey(),
      seed: document.getElementById("globalBatchSeedInput")?.value ? parseInt(document.getElementById("globalBatchSeedInput").value) : null,
    };
    const { res, data } = await fetchJson("/api/generate-batch-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Batch photoshoot failed.");
    renderBatchResults(data);
    if (!data.diagnostics?.itemErrors?.length) clearActiveRun();
  } catch (err) {
    console.error("Batch Engine Error:", err);
    alert("Batch photoshoot failed: " + err.message);
  } finally {
    toggleStatusView(false);
  }
}
// THE ACTUAL FIX for "what does all this intelligence do before we
// create anything" — everything gathered so far (tier reasoning, safety
// routing, cost) was real, but scattered across cards the user had to
// notice individually while scrolling. Nothing consolidated it into one
// moment before the expensive step fired. This does: intercepts the
// button, builds one summary from data already collected, and only
// actually spends money once a person has seen it and confirmed.
function buildBatchPreflightSummary() {
  const items = state.batchItems || [];
  let proCount = 0, liteCount = 0, narrativeCount = 0, blockedCount = 0, estimatedCost = 0;
  const rows = items.map((item, i) => {
    if (item.blocked) { blockedCount++; return null; }
    const modelId = state.batchFrameModels[i] || getGlobalBatchImageModel() || DEFAULT_IMAGE_TIER_PLACEHOLDER;
    const model = state.imageModels.find((m) => m.id === modelId) || (item.modelTierRecommendation === "pro" ? state.imageModels.find((m) => m.tier === "pro") : state.imageModels.find((m) => m.tier === "lite"));
    const perImageCost = model?.costPerImage ?? 0.1; // rough fallback if the model can't be resolved yet
    const shots = parseInt(dom.shotsPerGarment?.value) || 1;
    estimatedCost += perImageCost * shots;
    if (item.modelTierRecommendation === "pro") proCount++; else liteCount++;
    if (item.identityLockSafe === false) narrativeCount++;
    return {
      label: item.productLabel || `Product ${i + 1}`,
      tier: item.modelTierRecommendation,
      reasoning: item.modelTierReasoning,
      narrative: item.identityLockSafe === false,
      modelLabel: model?.label || modelId,
    };
  }).filter(Boolean);
  return { rows, proCount, liteCount, narrativeCount, blockedCount, estimatedCost, totalItems: items.length };
}
const DEFAULT_IMAGE_TIER_PLACEHOLDER = "";
// Soft-warn banner for the preflight modals — checks the app's own
// SELF-SET budget (not the real Fal balance; that's a hard block handled
// server-side instead, see fal-client.js's withConcurrencyLimit) and
// returns a warning banner HTML string if this run's estimated cost
// would push total spend over it. Never blocks anything itself — the
// existing "confirm" click in these modals is already the natural
// soft-warn checkpoint, this just makes sure the person actually sees
// the number before clicking it.
async function buildBudgetWarningBanner(estimatedCost) {
  try {
    const { res, data } = await fetchJson("/api/credits/summary");
    if (!res.ok || data.budget == null) return "";
    const projectedRemaining = data.remaining - estimatedCost;
    if (projectedRemaining >= 0) return "";
    return `<div class="alert alert-warning py-2 px-3 small">⚠️ This run's estimated cost ($${estimatedCost.toFixed(2)}) would put you $${Math.abs(projectedRemaining).toFixed(2)} over your set budget of $${data.budget.toFixed(2)} (spent so far: $${data.totalSpent.toFixed(2)}). You can still proceed — this is just a heads up.</div>`;
  } catch (err) {
    return ""; // budget check itself failing shouldn't block seeing the preflight at all
  }
}
async function showBatchPreflight() {
  const summary = buildBatchPreflightSummary();
  const budgetBanner = await buildBudgetWarningBanner(summary.estimatedCost);
  const bodyEl = document.getElementById("preflightBody");
  bodyEl.innerHTML = `
    ${budgetBanner}
    <div class="row g-2 text-center mb-3">
      <div class="col-4"><div class="border rounded p-2 bg-light"><div class="small text-muted">Products</div><div class="fw-bold fs-5">${summary.totalItems}</div></div></div>
      <div class="col-4"><div class="border rounded p-2 bg-light"><div class="small text-muted">Est. Cost</div><div class="fw-bold fs-5">$${summary.estimatedCost.toFixed(2)}</div></div></div>
      <div class="col-4"><div class="border rounded p-2 bg-light"><div class="small text-muted">Pro / Lite</div><div class="fw-bold fs-5">${summary.proCount} / ${summary.liteCount}</div></div></div>
    </div>
    ${summary.blockedCount > 0 ? `<div class="alert alert-danger py-2 px-3 small">🚫 ${summary.blockedCount} product(s) were flagged and will be skipped entirely.</div>` : ""}
    ${summary.narrativeCount > 0 ? `<div class="alert alert-warning py-2 px-3 small">i️ ${summary.narrativeCount} product(s) will use the narrative safety route (no strict identity-lock) based on their own classification.</div>` : ""}
    <div style="max-height: 280px; overflow-y: auto;">
      ${summary.rows.map((r) => `
        <div class="d-flex justify-content-between align-items-start border-bottom py-2 small">
          <div>
            <div class="fw-semibold">${escapeHtml(r.label)} ${r.tier === "pro" ? '<span class="badge bg-dark">pro</span>' : '<span class="badge bg-success">lite</span>'} ${r.narrative ? '<span class="badge bg-secondary">narrative route</span>' : ""}</div>
            ${r.reasoning ? `<div class="text-muted xx-small mt-1">${escapeHtml(r.reasoning)}</div>` : ""}
          </div>
          <div class="text-muted xx-small text-end flex-shrink-0 ms-2">${escapeHtml(r.modelLabel)}</div>
        </div>`).join("")}
    </div>
    <p class="xx-small text-muted mt-2 mb-0">Estimate only — actual cost depends on real per-image pricing and any retries needed.</p>
  `;
  new bootstrap.Modal(document.getElementById("batchPreflightModal")).show();
}
dom.batchApproveBtn.addEventListener("click", () => {
  if (!state.batchSubmittedPayload || state.batchItems.length === 0) return;
  state.pendingPreflightAction = launchBatchPhotoshoot;
  showBatchPreflight();
});
document.getElementById("preflightConfirmBtn")?.addEventListener("click", () => {
  bootstrap.Modal.getInstance(document.getElementById("batchPreflightModal"))?.hide();
  if (state.pendingPreflightAction) state.pendingPreflightAction();
});
dom.includeHumanToggle.addEventListener("change", () => {
  dom.batchModelSection.classList.toggle(
    "d-none",
    !dom.includeHumanToggle.checked,
  );
});
function renderBatchResults(data) {
  dom.batchPlaceholderView.classList.add("d-none");
  dom.batchResultsContainer.innerHTML = "";
  dom.batchDiagnosticsNote.innerHTML = "";
  const diag = data.diagnostics || {};
  if (diag.itemsRequested && diag.itemsSucceeded < diag.itemsRequested) {
    const failed = diag.itemsRequested - diag.itemsSucceeded;
    const details = (diag.itemErrors || [])
      .map((e) => `Product ${e.item + 1}: ${e.message}`)
      .join(" | ");
    dom.batchDiagnosticsNote.innerHTML = `<div class="alert alert-warning py-2 px-3 small mb-2">⚠️ ${failed} of ${diag.itemsRequested} product(s) failed and were skipped. ${details ? `<div class="text-muted mt-1">${details}</div>` : ""}</div>`;
    logActivity("warning", `Batch: ${failed} of ${diag.itemsRequested} product(s) failed and were skipped. ${details}`);
  }
  if (diag.identityNote) {
    dom.batchDiagnosticsNote.innerHTML += `<div class="alert alert-info py-2 px-3 small mb-2">i️ ${diag.identityNote}</div>`;
    logActivity("warning", `Batch identity: ${diag.identityNote}`);
  }
  if ((diag.verificationWarnings || []).length > 0) {
    const details = diag.verificationWarnings.map((w) => `${w.productLabel || `Product ${w.item + 1}`}: ${w.message}`).join(" | ");
    dom.batchDiagnosticsNote.innerHTML += `<div class="alert alert-info py-2 px-3 small mb-2">🔍 ${diag.verificationWarnings.length} image(s) generated successfully but flagged by an automatic check for a possible mismatch — worth a look, not necessarily wrong. <div class="text-muted mt-1">${details}</div></div>`;
    logActivity("info", `Verification: ${details}`);
  }
  logActivity("success", `Batch complete: ${diag.itemsSucceeded ?? (data.items || []).length} of ${diag.itemsRequested ?? "?"} product(s) rendered.`);
  (data.items || []).forEach((item, itemIdx) => {
    const section = document.createElement("div");
    section.className = "card border-0 shadow-sm p-3";
    const wearBadge =
      item.classification?.silhouetteLockAppropriate === false
        ? `<span class="badge bg-warning text-dark ms-2" title="${(item.classification.wearInstructions || "").replace(/"/g, "&quot;")}">👘 draped/wrapped</span>`
        : "";
    const outfitBadge = item.classification?.productWornAsOutfit
      ? `<span class="badge bg-primary ms-2">👗 worn as full outfit</span>`
      : "";
    const sizeBadge = item.classification?.estimatedRealWorldSize
      ? `<span class="badge ${item.classification.dimensionsSource === "user-provided" ? "bg-success" : "bg-secondary"} ms-2" title="${item.classification.estimatedRealWorldSize.replace(/"/g, "&quot;")}">📏 ${item.classification.dimensionsSource === "user-provided" ? "confirmed size" : "estimated size"}</span>`
      : "";
    const imagesHtml = (item.images || [])
      .map((img, idx) => {
        const cardId = `img-batch-${itemIdx}-${idx}`;
        initImageHistory(cardId, img.image);
        return `
        <div class="col-6 col-md-4 col-lg-3">
          <div class="card h-100 shadow-sm border-0 overflow-hidden position-relative">
            <div class="form-check position-absolute top-0 start-0 m-2 bg-white bg-opacity-75 rounded px-2 py-1" style="z-index: 5;">
              <input class="form-check-input video-select-checkbox" type="checkbox" data-video-select-item="${itemIdx}" data-video-select-shot="${idx}" id="videoSelect-batch-${itemIdx}-${idx}" ${isVideoSelected(img.image) ? "checked" : ""}>
              <label class="form-check-label small fw-semibold" for="videoSelect-batch-${itemIdx}-${idx}" title="Mark for AI video">🎬</label>
            </div>
            <div class="position-absolute top-0 end-0 m-2" style="z-index: 5;"><span class="badge ${img.includesHuman ? "bg-primary" : "bg-secondary"}">${img.includesHuman ? "🧑 Human" : "📦 Product"}</span></div>
            <img src="${img.image}" class="card-img-top img-fluid" style="height: 260px; object-fit: cover; background:#f8f9fa;" alt="${item.label} shot ${idx + 1}" loading="lazy">
            ${carouselNavHtml(cardId)}
            <div class="card-body p-2 bg-white d-flex justify-content-between align-items-center">
              <span class="small fw-semibold text-muted">${img.shotType || `Shot ${idx + 1}`}</span>
              <button type="button" class="btn btn-sm btn-outline-primary px-2 py-1" data-download-url="${img.image}" data-download-filename="${buildDownloadFilename([document.getElementById("batchBrandName")?.value, item.label, img.shotType || `shot${idx + 1}`])}">📥</button>
            </div>
            ${regenerateControlHtml(`${itemIdx}-${idx}`, "data-regen-model-idx")}
            ${editControlHtml(`${itemIdx}-${idx}`, "data-edit-input-idx")}
          </div>
        </div>`;
      })
      .join("");
    section.innerHTML = `
      <h6 class="fw-bold mb-2">${item.label}${wearBadge}${outfitBadge}${sizeBadge}</h6>
      <div class="row g-2">${imagesHtml}</div>
    `;
    dom.batchResultsContainer.appendChild(section);
    (item.images || []).forEach((img, idx) => {
      const cb = section.querySelector(
        `[data-video-select-item="${itemIdx}"][data-video-select-shot="${idx}"]`,
      );
      if (cb) {
        cb.addEventListener("change", () => {
          // Read the LIVE img src at check-time, not the original img.image
          // closure — otherwise checking the box after an Edit/Regenerate
          // would queue the old, already-superseded image for video.
          const liveSrc = section.querySelectorAll(".card")[idx]?.querySelector("img")?.src || img.image;
          toggleVideoSelection(
            liveSrc,
            `${item.label} — ${img.shotType || `Shot ${idx + 1}`}`,
            "batch",
            !!img.includesHuman,
          );
        });
      }
      const regenBtn = section.querySelector(`[data-regenerate-idx="${itemIdx}-${idx}"]`);
      const batchCardId = `img-batch-${itemIdx}-${idx}`;
      const batchCardEl = section.querySelectorAll(".card")[idx];
      if (batchCardEl) {
        wireCarouselNav(batchCardId, batchCardEl, (currentUrl, previousUrl) => {
          batchCardEl.querySelector(`[data-download-url]`)?.setAttribute("data-download-url", currentUrl);
          migrateVideoSelectionUrl(previousUrl, currentUrl);
        });
      }
      if (regenBtn) {
        regenBtn.addEventListener("click", async () => {
          const model = section.querySelector(`[data-regen-model-idx="${itemIdx}-${idx}"]`)?.value;
          // Batch mode doesn't return the canonical/locked product render to
          // the client, only the originally-uploaded photo — so a regenerate
          // here anchors on that original photo rather than the (server-side
          // only) locked render most other frames were built from.
          const originalProductPhoto = state.batchSubmittedPayload?.productImages?.[item.index];
          const imgEl = section.querySelectorAll(".card")[idx]?.querySelector("img");
          if (!imgEl) return;
          await regenerateFrameWithModel({
            imgEl,
            prompt: item.classification?.imagePromptSeed || "The product, presented naturally and tastefully.",
            referenceImages: [originalProductPhoto].filter(Boolean),
            aspectRatio: state.batchSubmittedPayload?.aspectRatio,
            model,
            runId: state.batchRunId,
            resolution: getGlobalBatchImageResolution(),
            cardId: batchCardId,
            cardEl: batchCardEl,
            itemType: "batch_item",
            itemKey: itemIdx,
            shotIndex: idx,
          });
        });
      }
      const editBtn = section.querySelector(`[data-edit-idx="${itemIdx}-${idx}"]`);
      if (editBtn) {
        editBtn.addEventListener("click", async () => {
          const model = section.querySelector(`[data-regen-model-idx="${itemIdx}-${idx}"]`)?.value;
          const editInput = section.querySelector(`[data-edit-input-idx="${itemIdx}-${idx}"]`);
          const cardEl = section.querySelectorAll(".card")[idx];
          const imgEl = cardEl?.querySelector("img");
          if (!imgEl) return;
          const newUrl = await editFrameWithInstruction({
            imgEl,
            editInstruction: editInput?.value,
            model,
            aspectRatio: state.batchSubmittedPayload?.aspectRatio,
            runId: state.batchRunId,
            resolution: getGlobalBatchImageResolution(),
            cardId: batchCardId,
            cardEl,
            itemType: "batch_item",
            itemKey: itemIdx,
            shotIndex: idx,
          });
          if (newUrl) {
            if (editInput) editInput.value = "";
            cardEl.querySelector(`[data-download-url]`).setAttribute("data-download-url", newUrl);
          }
        });
      }
    });
  });
  dom.batchResultsSection.classList.remove("d-none");
  dom.batchResultsSection.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}
dom.studioForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.isolatedProductBase64)
    return alert("Please select a product image first.");
  const { human, nonHuman, total, overCap } = updateFrameCountTotal();
  if (overCap) return alert("Shot Mix total cannot exceed 10.");
  if (total < 1) return alert("Request at least 1 frame.");
  const apiKey = getUserKey();
  // Reuse the run_id minted when the reference photo was analyzed (if
  // any), so this campaign's row and its pre-flight analysis/moderation
  // costs share one run_id — then clear it immediately so a LATER,
  // unrelated submit (without a fresh reference upload) doesn't silently
  // reuse a stale id and overwrite this campaign's saved row.
  const runId = (state.runId = state.pendingShootRunId || crypto.randomUUID());
  state.pendingShootRunId = null;
  try {
    warnIfReliabilityIssues();
    toggleStatusView(
      true,
      "Contacting Director Models for Copy and Custom Staging...",
    );
    startProgressPolling(runId);
    state.lockedSetImage = null;
    state.lockedLookReference = null;
    state.lockedIdentityImage = null;
    document.getElementById("lockedSetView").classList.add("d-none");
    document.getElementById("photoshootResultsSection").classList.add("d-none");
    const classificationImage = state.isolatedProductBase64
      ? await resizeImageForClassification(state.isolatedProductBase64)
      : null;
    const { res: textRes, data: textData } = await fetchJson(
      "/api/generate-text",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          brandName: document.getElementById("brandName").value,
          productDescription: document.getElementById("productDesc").value,
          productDimensions: dom.productDimensions
            ? dom.productDimensions.value
            : "",
          usageContext: document.getElementById("usageContext").value,
          aspectRatio: document.getElementById("aspectRatio").value,
          humanFrameCount: human,
          nonHumanFrameCount: nonHuman,
          hasModelReference: !!state.modelReferenceBase64,
          modelAppearance: document.getElementById("modelAppearance").value,
          modelExpression: document.getElementById("modelExpression").value,
          modelWardrobe: document.getElementById("modelWardrobe").value,
          modelPose: document.getElementById("modelPose").value,
          modelBodyType: document.getElementById("modelBodyType").value,
          negativeDirectives:
            document.getElementById("negativeDirectives").value,
          creativeDirection: dom.creativeDirection.value,
          lockWardrobe: dom.lockWardrobe.checked,
          lockBackground: dom.lockBackground.checked,
          wardrobeVarietyMode:
            document.querySelector('input[name="wardrobeVarietyMode"]:checked')
              ?.value || "cohesive",
          matchReferenceOutfit: dom.matchReferenceOutfit.checked,
          autoBalanceMix: document.getElementById("autoBalanceMix")?.checked || false,
          userApiKey: apiKey,
          textModel: getTextModel(),
          productImageBase64: classificationImage,
          brandProfile: getBrandProfile(),
        }),
      },
    );
    await refreshCreditsSummary();
    if (!textRes.ok || textData.error)
      throw new Error(textData.error || "Failed to generate campaign data.");
    state.generatedText = textData;
    state.runId = textData.runId || null;
    if (state.runId) saveActiveRun(state.runId, "single");
    state.environment = textData.environment || null;
    state.classification = {
      ...(textData.classification || {
        productLabel: "Unclassified",
        confidenceScore: 50,
        identityLockSafe: false,
      }),
      lightingStrategy: textData.lightingStrategy,
      physicalStaging: textData.physicalStaging,
      injectedDirectives: textData.injectedDirectives,
      wardrobeConsistencyNote: textData.wardrobeConsistencyNote,
      toneOfVoice: textData.toneOfVoice,
      propsAndStaging: textData.propsAndStaging,
    };
    state.seedIdentity = textData.seedIdentity || null;
    state.promptTypes = textData.promptTypes || [];
    const banner = document.getElementById("classificationBanner");
    const label = document.getElementById("detectedCategoryLabel");
    const confidence = document.getElementById("detectedConfidence");
    const reasoning = document.getElementById("detectedReasoning");
    const overrideInput = document.getElementById("categoryOverride");
    banner.classList.remove("d-none");
    label.innerText = state.classification.productLabel;
    confidence.innerText = state.classification.confidenceScore;
    reasoning.innerText = state.classification.reasoning
      ? `"${state.classification.reasoning}"`
      : "";
    function ensureNote(id) {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.className = "small text-muted mt-1";
        banner.appendChild(el);
      }
      return el;
    }
    ensureNote("materialNote").innerText = state.classification
      .actualProductMaterials
      ? `🔍 Detected material: ${state.classification.actualProductMaterials}`
      : "";
    ensureNote("scopeNote").innerText =
      state.classification.productScope === "component"
        ? `🧩 Treating this as a COMPONENT product: ${state.classification.componentDescription || "a manufactured part"}.`
        : "";
    ensureNote("wearNote").innerText =
      state.classification.silhouetteLockAppropriate === false
        ? `👘 Treating this as a DRAPED/WRAPPED item: "${state.classification.wearInstructions || "no specific guidance returned"}"${state.classification.zonedPatternDescription ? ` Pattern zones: ${state.classification.zonedPatternDescription}` : ""}`
        : "";
    ensureNote("outfitNote").innerText = state.classification
      .productWornAsOutfit
      ? `👗 This product IS the outfit — human frames will dress the model in it directly, replacing their placeholder wardrobe.`
      : "";
    ensureNote("autoMixNote").innerText =
      document.getElementById("autoBalanceMix")?.checked &&
      state.classification.recommendedHumanFrameCount != null
        ? `📸 AI creative-director split: ${state.classification.recommendedHumanFrameCount} human frame(s), ${state.classification.recommendedNonHumanFrameCount} product-only frame(s).`
        : "";
    const sizeNoteEl = ensureNote("sizeNote");
    if (state.classification.estimatedRealWorldSize) {
      const isUserProvided =
        state.classification.dimensionsSource === "user-provided";
      sizeNoteEl.innerText = isUserProvided
        ? `📏 Confirmed size: ${state.classification.estimatedRealWorldSize}`
        : `📏 Estimated size: ${state.classification.estimatedRealWorldSize} — if wrong, enter exact dimensions above and regenerate.`;
    } else {
      sizeNoteEl.innerText = "";
    }
    overrideInput.value = "";
    overrideInput.onchange = (ev) => {
      const val = ev.target.value.trim();
      if (!val) return;
      state.classification.productLabel = val;
      label.innerText = val;
      reasoning.innerText =
        "Manually overridden (label only — safety routing unchanged).";
    };
    ensureNote("moderationNote").innerText = textData.moderationNote || "";
    if (textData.moderationNote) logActivity("warning", `Step 1: ${textData.moderationNote}`);
    const tier = state.classification.modelTierRecommendation || "pro";
    ensureNote("modelTierNote").innerText =
      `🎛️ AI picked the "${tier}" model for compositing${state.classification.modelTierReasoning ? ` — ${state.classification.modelTierReasoning}` : ""}.`;
    logActivity("success", `Step 1 complete: concepts generated, AI recommended the "${tier}" model.`);
    dom.placeholderView.classList.add("d-none");
    dom.stage1View.classList.remove("d-none");
    dom.captionContainer.innerHTML = state.generatedText.captions
      .map(
        (cap, i) =>
          `<div class="mb-2 p-2 bg-white rounded border small"><strong>Option ${i + 1}:</strong> ${cap}</div>`,
      )
      .join("");
    dom.tagContainer.innerText = state.generatedText.tags.join(" ");
    if (textData.imagePrompts && Array.isArray(textData.imagePrompts)) {
      renderPromptReviewCards(textData.imagePrompts, state.promptTypes);
    }
    dom.lockSetHint.textContent =
      human > 0
        ? "This previews the identity+product+background composite once, before spending on the full batch."
        : "No human frames requested — this step will skip straight through.";
  } catch (err) {
    alert(err.message);
  } finally {
    toggleStatusView(false);
  }
});
function renderPromptReviewCards(promptsArray, promptTypesArray) {
  state.generatedPrompts = [...promptsArray];
  state.promptTypes =
    promptTypesArray && promptTypesArray.length === promptsArray.length
      ? [...promptTypesArray]
      : promptsArray.map(() => "product");
  const container = dom.dynamicPromptList;
  container.innerHTML = "";
  dom.promptCountBadge.innerText = `${promptsArray.length} Setups`;
  promptsArray.forEach((promptText, index) => {
    const type = state.promptTypes[index] || "product";
    const badgeClass = type === "human" ? "bg-dark" : "bg-secondary";
    const badgeLabel = type === "human" ? "Human" : "Product";
    const card = document.createElement("div");
    card.className = "card border-light shadow-sm p-3 bg-light";
    card.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-1">
                <span class="fw-bold text-dark small">Setup ${index + 1} <span class="badge ${badgeClass} ms-1">${badgeLabel}</span></span>
                <span class="text-muted xx-small">Card #${index + 1}</span>
            </div>
            <textarea class="form-control form-control-sm prompt-editable-input" rows="3" data-index="${index}" style="font-size: 0.85rem; line-height: 1.4;">${promptText}</textarea>
            <div class="mt-2">
              <label class="form-label xx-small text-muted mb-1">Image model for this frame</label>
              ${modelSelectHtml({ models: state.imageModels, dataAttr: "data-frame-model-idx", index, selectedValue: state.frameModels[index] || "", minReferenceImages: type === "human" ? 2 : 1 })}
            </div>
        `;
    container.appendChild(card);
  });
  dom.promptReviewContainer.classList.remove("d-none");
  document.querySelectorAll(".prompt-editable-input").forEach((textarea) => {
    textarea.addEventListener("input", (e) => {
      const idx = parseInt(e.target.getAttribute("data-index"));
      state.generatedPrompts[idx] = e.target.value;
    });
  });
}
// Reads the per-frame image-model overrides set on the prompt review
// cards back into state.frameModels (index-matched to generatedPrompts),
// so a change made after rendering (but before Approve & Launch) is
// captured even without a live input listener on every select.
function syncFrameModelsFromCards() {
  state.frameModels = state.generatedPrompts.map((_, i) => readModelSelectValue("data-frame-model-idx", i));
}
async function runLockSet(forceRegenerate = false) {
  const humanFramesRequested = state.promptTypes.filter(
    (t) => t === "human",
  ).length;
  if (humanFramesRequested === 0) {
    state.lockedSetImage = null;
    dom.lockedSetImage.classList.add("d-none");
    dom.lockedSetDiagnostics.innerText =
      "No human frames in this batch — proceeding directly to the full photoshoot.";
    dom.lockedSetView.classList.remove("d-none");
    dom.lockedSetView.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  try {
    toggleStatusView(
      true,
      "Building the locked set (identity + product + background)...",
    );
    startProgressPolling(state.runId);
    const { res, data } = await fetchJson("/api/lock-set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productImage: state.isolatedProductBase64,
        modelReferenceBase64: state.modelReferenceBase64,
        sanitizedReferenceImage: state.sanitizedReferenceImage,
        environment: state.environment,
        aspectRatio: document.getElementById("aspectRatio").value,
        classification: state.classification,
        seedIdentity: state.seedIdentity,
       subjectSelectionNote: state.subjectSelectionNote,
        runId: state.runId,
        lockWardrobe: dom.lockWardrobe.checked,
        matchReferenceOutfit: dom.matchReferenceOutfit.checked,
        modelTier: getModelTier(),
        imageModel: getGlobalImageModel(),
        imageResolution: getGlobalImageResolution(),
        skipCanonicalRender: dom.skipCanonicalRender ? dom.skipCanonicalRender.checked : false,
        forceRegenerate,
        userApiKey: getUserKey(),
      }),
    });
    await refreshCreditsSummary();
    if (!res.ok)
      throw new Error(data.error || "Failed to build the locked set.");
    state.lockedSetImage = data.lockedSetImage;
    state.lockedProductImage = data.lockedProductImage || null;
    state.lockedLookReference = data.lockedLookReference || null;
    state.lockedIdentityImage = data.lockedIdentityImage || null;
    state.sanitizedReferenceImage = data.sanitizedReferenceImage || null;
    if (state.lockedSetImage) {
      dom.lockedSetImage.src = state.lockedSetImage;
      dom.lockedSetImage.classList.remove("d-none");
    } else {
      dom.lockedSetImage.classList.add("d-none");
    }
    const lockSetNote = data.reason || data.diagnostics?.fallbackReason || null;
    dom.lockedSetDiagnostics.innerText = lockSetNote ? (data.reason ? lockSetNote : `Note: ${lockSetNote}`) : "Locked set ready.";
    if (lockSetNote) logActivity("warning", `Locked set: ${lockSetNote}`);
    else logActivity("success", "Locked set ready — identity + product + environment composited successfully.");
    dom.lockedSetView.classList.remove("d-none");
    dom.lockedSetView.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    alert(err.message);
  } finally {
    toggleStatusView(false);
  }
}
dom.lockSetBtn.addEventListener("click", () => runLockSet(false));
dom.regenerateLockBtn.addEventListener("click", () => runLockSet(true));
async function launchSinglePhotoshoot() {
  if (!state.isolatedProductBase64 || state.generatedPrompts.length === 0)
    return;
  try {
    toggleStatusView(
      true,
      "Executing photoshoot rendering across all compositions...",
    );
    startProgressPolling(state.runId);
    syncFrameModelsFromCards();
    const payload = {
      productImage: state.isolatedProductBase64,
      modelReferenceBase64: state.modelReferenceBase64,
      finalPrompts: state.generatedPrompts,
      promptTypes: state.promptTypes,
      imageModel: getGlobalImageModel(),
      imageResolution: getGlobalImageResolution(),
      frameModels: state.frameModels,
      lockedSetImage: state.lockedSetImage,
      lockedProductImage: state.lockedProductImage,
      lockedLookReference: state.lockedLookReference,
      lockedIdentityImage: state.lockedIdentityImage,
      sanitizedReferenceImage: state.sanitizedReferenceImage,
      aspectRatio: document.getElementById("aspectRatio").value,
      negativeDirectives: document.getElementById("negativeDirectives").value,
      userApiKey: getUserKey(),
      classification: state.classification,
      seedIdentity: state.seedIdentity,
      environment: state.environment,
subjectSelectionNote: state.subjectSelectionNote,
      runId: state.runId,
      lockWardrobe: dom.lockWardrobe.checked,
      matchReferenceOutfit: dom.matchReferenceOutfit.checked,
      modelTier: getModelTier(),
      skipCanonicalRender: dom.skipCanonicalRender ? dom.skipCanonicalRender.checked : false,
      seed: document.getElementById("globalSeedInput")?.value ? parseInt(document.getElementById("globalSeedInput").value) : null,
    };
    const { res: imgRes, data: imgData } = await fetchJson(
      "/api/generate-images",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    await refreshCreditsSummary();
    if (!imgRes.ok)
      throw new Error(imgData.error || "Failed rendering image payload.");
    if (imgData.images && imgData.images.length > 0) {
      renderFinalImageGrid(
        imgData.images,
        imgData.diagnostics,
        imgData.modelsUsed,
      );
      if (imgData.replacementNote) logActivity("warning", `🔄 ${imgData.replacementNote}`);
      logActivity("success", `Photoshoot complete: ${imgData.diagnostics?.framesSucceeded ?? imgData.images.length} of ${imgData.diagnostics?.framesRequested ?? imgData.images.length} frame(s) rendered.`);
      if (!imgData.diagnostics?.frameErrors?.length) clearActiveRun();
    } else {
      alert("The photoshoot pipeline completed, but no images were returned.");
    }
  } catch (err) {
    console.error("Studio Engine Error:", err);
    alert("Photoshoot failed: " + err.message);
  } finally {
    toggleStatusView(false);
  }
}
async function showSinglePreflight() {
  const frameCount = state.generatedPrompts.length;
  const tier = state.classification?.modelTierRecommendation;
  const reasoning = state.classification?.modelTierReasoning;
  const modelId = getGlobalImageModel() || (tier === "pro" ? state.imageModels.find((m) => m.tier === "pro")?.id : state.imageModels.find((m) => m.tier === "lite")?.id);
  const model = state.imageModels.find((m) => m.id === modelId);
  const perImageCost = model?.costPerImage ?? 0.1;
  const estimatedCost = perImageCost * frameCount;
  const budgetBanner = await buildBudgetWarningBanner(estimatedCost);
  const bodyEl = document.getElementById("preflightBody");
  bodyEl.innerHTML = `
    ${budgetBanner}
    <div class="row g-2 text-center mb-3">
      <div class="col-4"><div class="border rounded p-2 bg-light"><div class="small text-muted">Frames</div><div class="fw-bold fs-5">${frameCount}</div></div></div>
      <div class="col-4"><div class="border rounded p-2 bg-light"><div class="small text-muted">Est. Cost</div><div class="fw-bold fs-5">$${estimatedCost.toFixed(2)}</div></div></div>
      <div class="col-4"><div class="border rounded p-2 bg-light"><div class="small text-muted">Tier</div><div class="fw-bold fs-5">${tier === "pro" ? '<span class="badge bg-dark">pro</span>' : '<span class="badge bg-success">lite</span>'}</div></div></div>
    </div>
    <div class="small"><strong>Model:</strong> ${escapeHtml(model?.label || modelId || "Auto")}</div>
    ${reasoning ? `<div class="text-muted small mt-1">🎛️ ${escapeHtml(reasoning)}</div>` : ""}
    ${state.classification?.identityLockSafe === false ? `<div class="alert alert-warning py-2 px-3 small mt-2">i️ This shoot will use the narrative safety route (no strict identity-lock) based on the AI's classification.</div>` : ""}
    <p class="xx-small text-muted mt-3 mb-0">Estimate only — actual cost depends on real per-image pricing and any retries needed.</p>
  `;
  new bootstrap.Modal(document.getElementById("batchPreflightModal")).show();
}
dom.approveLockBtn.addEventListener("click", () => {
  if (!state.isolatedProductBase64 || state.generatedPrompts.length === 0) return;
  state.pendingPreflightAction = launchSinglePhotoshoot;
  showSinglePreflight();
});
function renderFinalImageGrid(imageUrls, diagnostics, modelsUsed, { gridId = "finalImageGrid", sectionId = "photoshootResultsSection", noteBarId = "photoshootDiagnosticsNote", idPrefix = "single", brandNameEl = null } = {}) {
  const gridContainer = document.getElementById(gridId);
  const sectionWrapper = document.getElementById(sectionId);
  gridContainer.innerHTML = "";
  sectionWrapper.classList.remove("d-none");
  let noteBar = document.getElementById(noteBarId);
  if (!noteBar) {
    noteBar = document.createElement("div");
    noteBar.id = noteBarId;
    noteBar.className = "mb-3";
    gridContainer.parentElement.insertBefore(noteBar, gridContainer);
  }
  noteBar.innerHTML = "";
  if (
    diagnostics?.framesRequested &&
    diagnostics.framesSucceeded < diagnostics.framesRequested
  ) {
    const failedCount =
      diagnostics.framesRequested - diagnostics.framesSucceeded;
    const details = (diagnostics.frameErrors || [])
      .map((e) => `Frame ${e.frame}: ${e.message}`)
      .join(" | ");
    noteBar.innerHTML += `<div class="alert alert-warning py-2 px-3 small mb-2">⚠️ ${failedCount} of ${diagnostics.framesRequested} frame(s) failed. ${details ? `<div class="text-muted mt-1">${details}</div>` : ""}</div>`;
    logActivity("warning", `Photoshoot: ${failedCount} of ${diagnostics.framesRequested} frame(s) failed. ${details}`);
  }
  if (diagnostics?.anatomicalFallbackReason) {
    noteBar.innerHTML += `<div class="alert alert-info py-2 px-3 small mb-2">i️ ${diagnostics.anatomicalFallbackReason}</div>`;
    logActivity("warning", `Photoshoot identity: ${diagnostics.anatomicalFallbackReason}`);
  }
  imageUrls.forEach((url, index) => {
     const model = modelsUsed?.[index];
    const isLiteTier = model === "gemini-3.1-flash-image";
    const isReused = model === "locked-set-reuse";
    const modelBadge = model
      ? `<span class="badge ${isReused ? "bg-success" : isLiteTier ? "bg-secondary" : "bg-dark"}">${isReused ? "reused, free" : isLiteTier ? "fast" : "pro"}</span>`
      : "";
    const frameType = state.promptTypes[index];
    const typeBadge = frameType ? `<span class="badge ${frameType === "human" ? "bg-primary" : "bg-secondary"}">${frameType === "human" ? "🧑 Human" : "📦 Product"}</span>` : "";
    const label = `Frame #${index + 1}`;
    const col = document.createElement("div");
    col.className = "col-6 col-md-4 col-lg-3";
    const cardId = `img-${idPrefix}-${index}`;
    initImageHistory(cardId, url);
    const nameSourceEl = brandNameEl || document.getElementById("brandName");
    col.innerHTML = `
            <div class="card h-100 shadow-sm border-0 overflow-hidden position-relative">
                <div class="form-check position-absolute top-0 start-0 m-2 bg-white bg-opacity-75 rounded px-2 py-1" style="z-index: 5;">
                    <input class="form-check-input video-select-checkbox" type="checkbox" data-video-select-idx="${index}" id="videoSelect-${idPrefix}-${index}" ${isVideoSelected(url) ? "checked" : ""}>
                    <label class="form-check-label small fw-semibold" for="videoSelect-${idPrefix}-${index}">🎬</label>
                </div>
                <div class="position-absolute top-0 end-0 m-2" style="z-index: 5;">${typeBadge}</div>
                <img src="${url}" class="card-img-top img-fluid" style="height: 280px; object-fit: cover; background-color: #f8f9fa;" alt="Generated Asset ${index + 1}" loading="lazy">
                ${carouselNavHtml(cardId)}
                <div class="card-body p-2 bg-white d-flex justify-content-between align-items-center">
                    <span class="small fw-semibold text-muted">${label} ${modelBadge}</span>
                    <button type="button" class="btn btn-sm btn-outline-primary px-2 py-1" data-download-url="${url}" data-download-filename="${buildDownloadFilename([nameSourceEl?.value, state.classification?.productLabel, state.promptTypes[index], `frame${index + 1}`])}">📥</button>
                </div>
                ${regenerateControlHtml(index, "data-regen-model-idx")}
                ${editControlHtml(index, "data-edit-input-idx")}
            </div>
        `;
    gridContainer.appendChild(col);
    wireCarouselNav(cardId, col, (currentUrl, previousUrl) => {
      // Keep the download button and any queued video selection pointed
      // at whichever version is actually showing after stepping through
      // the carousel, not whatever was current when the card first
      // rendered or whenever it was originally checked.
      col.querySelector(`[data-download-url]`)?.setAttribute("data-download-url", currentUrl);
      migrateVideoSelectionUrl(previousUrl, currentUrl);
    });
    const checkboxEl = col.querySelector(`[data-video-select-idx="${index}"]`);
    const imgElForCheckbox = col.querySelector("img");
    // Reads img.src LIVE at the moment the box is checked, rather than
    // closing over the original `url` — otherwise checking the box after
    // an Edit/Regenerate would queue the OLD, already-superseded image for
    // video instead of whatever's actually showing on the card.
    checkboxEl.addEventListener("change", () => {
      toggleVideoSelection(imgElForCheckbox.src, label, idPrefix, state.promptTypes[index] === "human");
    });
    col.querySelector(`[data-regenerate-idx="${index}"]`).addEventListener("click", async () => {
      const model = col.querySelector(`[data-regen-model-idx="${index}"]`)?.value;
      const type = state.promptTypes[index];
      const referenceImages = [
        state.lockedProductImage || state.isolatedProductBase64,
        type === "human" ? state.lockedIdentityImage || state.lockedLookReference || state.modelReferenceBase64 : null,
      ].filter(Boolean);
      const imgEl = col.querySelector("img");
      await regenerateFrameWithModel({
        imgEl,
        prompt: state.generatedPrompts[index] || "The product, presented naturally and tastefully.",
        referenceImages,
        aspectRatio: document.getElementById("aspectRatio")?.value,
        model,
        runId: state.runId,
        resolution: getGlobalImageResolution(),
        cardId,
        cardEl: col,
        itemType: "frame",
        itemKey: index,
      });
    });
    col.querySelector(`[data-edit-idx="${index}"]`).addEventListener("click", async () => {
      const model = col.querySelector(`[data-regen-model-idx="${index}"]`)?.value;
      const editInput = col.querySelector(`[data-edit-input-idx="${index}"]`);
      const imgEl = col.querySelector("img");
      const newUrl = await editFrameWithInstruction({
        imgEl,
        editInstruction: editInput?.value,
        model,
        aspectRatio: document.getElementById("aspectRatio")?.value,
        runId: state.runId,
        resolution: getGlobalImageResolution(),
        cardId,
        cardEl: col,
        itemType: "frame",
        itemKey: index,
      });
      if (newUrl) {
        if (editInput) editInput.value = "";
        col.querySelector(`[data-download-url]`).setAttribute("data-download-url", newUrl);
      }
    });
  });
  sectionWrapper.scrollIntoView({ behavior: "smooth", block: "start" });
}
// ============================================================
// REGENERATE WITH A DIFFERENT MODEL (NEW) — backs the 🔄 control on each
// generated image card. Reuses the same reference images (locked
// product/identity where available) so a re-roll swaps the rendering
// model without silently changing the product or person.
// ============================================================
// ============================================================
// IMAGE VERSION HISTORY / CAROUSEL — every edit or regenerate used to
// just overwrite the image in place, so there was no way back to a
// previous version once you'd tried something new. This tracks every
// version per card (keyed by a stable cardId) and adds ◀ N/M ▶ nav so
// you can step back through what's already been generated instead of
// losing it the moment something new replaces it.
// ============================================================
function initImageHistory(cardId, initialUrl) {
  if (!state.imageHistory[cardId]) {
    state.imageHistory[cardId] = { versions: [initialUrl], index: 0 };
  }
}
function pushImageVersion(cardId, newUrl) {
  const h = state.imageHistory[cardId];
  if (!h) {
    state.imageHistory[cardId] = { versions: [newUrl], index: 0 };
    return;
  }
  h.versions.push(newUrl);
  h.index = h.versions.length - 1;
}
function carouselNavHtml(cardId) {
  const h = state.imageHistory[cardId];
  const count = h ? h.versions.length : 1;
  return `<div class="d-flex align-items-center justify-content-between px-2 py-1 bg-white border-top ${count > 1 ? "" : "d-none"}" data-carousel-nav="${cardId}">
    <button type="button" class="btn btn-sm btn-link p-0" data-carousel-prev="${cardId}" title="Previous version">◀</button>
    <span class="xx-small text-muted" data-carousel-count="${cardId}">${(h?.index ?? 0) + 1}/${count}</span>
    <button type="button" class="btn btn-sm btn-link p-0" data-carousel-next="${cardId}" title="Next version">▶</button>
  </div>`;
}
// Wires the prev/next buttons for one card. Called once per card after
// its HTML is inserted into the DOM — imgEl and any callback needed to
// re-sync other UI (download button, video-queue URL) that depends on
// which version is currently showing are passed in so this stays
// reusable across single-mode, batch-mode, and any future card type.
function wireCarouselNav(cardId, cardEl, onNavigate) {
  const step = (delta) => {
    const h = state.imageHistory[cardId];
    if (!h) return;
    const newIndex = Math.max(0, Math.min(h.versions.length - 1, h.index + delta));
    if (newIndex === h.index) return;
    h.index = newIndex;
    const url = h.versions[h.index];
    const imgEl = cardEl.querySelector("img");
    const previousUrl = imgEl?.src;
    if (imgEl) imgEl.src = url;
    const countEl = cardEl.querySelector(`[data-carousel-count="${cardId}"]`);
    if (countEl) countEl.textContent = `${h.index + 1}/${h.versions.length}`;
    if (onNavigate) onNavigate(url, previousUrl);
  };
  cardEl.querySelector(`[data-carousel-prev="${cardId}"]`)?.addEventListener("click", () => step(-1));
  cardEl.querySelector(`[data-carousel-next="${cardId}"]`)?.addEventListener("click", () => step(1));
}
// Refreshes an already-rendered card's carousel nav after a NEW version
// gets pushed (edit/regenerate succeeded) — shows the control if it was
// hidden (this was the card's first edit) and updates the counter.
function refreshCarouselNav(cardId, cardEl) {
  const h = state.imageHistory[cardId];
  if (!h) return;
  const navEl = cardEl.querySelector(`[data-carousel-nav="${cardId}"]`);
  if (navEl) {
    navEl.classList.toggle("d-none", h.versions.length <= 1);
    const countEl = navEl.querySelector(`[data-carousel-count="${cardId}"]`);
    if (countEl) countEl.textContent = `${h.index + 1}/${h.versions.length}`;
  }
}

async function regenerateFrameWithModel({ imgEl, prompt, referenceImages, aspectRatio, model, runId, resolution, cardId, cardEl, itemType, itemKey, shotIndex }) {
  if (!model) return alert("Pick a model from the dropdown first.");
  const originalSrc = imgEl.src;
  imgEl.style.opacity = "0.4";
  logActivity("info", `Regenerating one image with ${model}...`);
  try {
    const { res, data } = await fetchJson("/api/regenerate-frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, referenceImages, aspectRatio, imageModel: model, imageResolution: resolution, runId, itemType, itemKey, shotIndex, userApiKey: getUserKey() }),
    });
    await refreshCreditsSummary();
    if (!res.ok) throw new Error(data.error || "Regeneration failed.");
    imgEl.src = data.image;
    migrateVideoSelectionUrl(originalSrc, data.image);
    if (cardId) {
      pushImageVersion(cardId, data.image);
      if (cardEl) refreshCarouselNav(cardId, cardEl);
    }
    logActivity("success", `Regenerated successfully with ${model}.`);
    return data.image;
  } catch (err) {
    imgEl.src = originalSrc;
    alert("Regenerate failed: " + err.message);
    return null;
  } finally {
    imgEl.style.opacity = "1";
  }
}
function regenerateControlHtml(cardIndex, groupAttr) {
  return `<div class="d-flex gap-1 align-items-center px-2 pb-1 bg-white">
    <select class="form-select form-select-sm" style="font-size: 0.7rem;" ${groupAttr}="${cardIndex}">
      ${state.imageModels.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}
    </select>
    <button type="button" class="btn btn-sm btn-outline-secondary px-2 py-1" data-regenerate-idx="${cardIndex}" title="Regenerate from scratch with the selected model">🔄</button>
  </div>`;
}
// ============================================================
// EDIT AN EXISTING IMAGE (NEW) — distinct from Regenerate above.
// Regenerate re-renders from scratch using the ORIGINAL prompt/reference
// images with a (possibly different) model. Edit instead takes whatever
// image is CURRENTLY shown on the card as the sole reference and a fresh
// instruction typed by the user (e.g. "make the robe more sheer", "change
// the background to an outdoor garden"), and asks an edit-capable model to
// modify just that. Applying another edit afterward chains off the latest
// version, so edits can be layered iteratively. Uses the same
// data-regen-model-idx dropdown as Regenerate, so pick a model once.
// ============================================================
function editControlHtml(cardIndex, groupAttr) {
  return `<div class="d-flex gap-1 align-items-center px-2 pb-2 bg-white">
    <input type="text" class="form-control form-control-sm" style="font-size: 0.7rem;" ${groupAttr}="${cardIndex}" placeholder="Describe what to change (e.g. 'warmer lighting')...">
    <button type="button" class="btn btn-sm btn-outline-primary px-2 py-1" data-edit-idx="${cardIndex}" title="Edit this exact image with the instruction typed above">✏️</button>
  </div>`;
}
async function editFrameWithInstruction({ imgEl, editInstruction, model, aspectRatio, runId, resolution, cardId, cardEl, itemType, itemKey, shotIndex }) {
  if (!editInstruction || !editInstruction.trim()) return alert("Type what you'd like changed first.");
  if (!model) return alert("Pick a model from the dropdown first — edit needs a model too.");
  return regenerateFrameWithModel({
    imgEl,
    prompt: editInstruction.trim(),
    referenceImages: [imgEl.src],
    aspectRatio,
    model,
    runId,
    resolution,
    cardId,
    cardEl,
    itemType,
    itemKey,
    shotIndex,
  });
}
// ============================================================
// DOWNLOAD AS BLOB (NEW) — Fal-hosted image URLs are cross-origin, and
// browsers silently ignore the <a download> attribute for cross-origin
// resources (they just navigate/open instead of saving). Fetching the
// bytes ourselves and downloading via a blob: URL works regardless of
// origin, as long as the CDN sends permissive CORS headers (Fal's does).
// Falls back to opening in a new tab (right-click → Save Image As) if the
// fetch itself is blocked for some reason.
// ============================================================
// Builds a descriptive download filename from whatever context is
// available (brand, product, shot type/index) instead of a generic
// "photoshoot-asset-N.png" — sanitized to strip anything unsafe for a
// filesystem, capped in length, and always ending in the given extension.
function buildDownloadFilename(parts, ext = "png") {
  const sanitized = parts
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean);
  const datePart = new Date().toISOString().slice(0, 10);
  const base = [...sanitized, datePart].join("_").slice(0, 120);
  return `${base || "image"}.${ext}`;
}
async function downloadImageAsBlob(url, filename) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  } catch (err) {
    console.warn("Direct download failed, opening in a new tab instead:", err.message);
    window.open(url, "_blank");
  }
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-download-url]");
  if (!btn) return;
  e.preventDefault();
  downloadImageAsBlob(btn.getAttribute("data-download-url"), btn.getAttribute("data-download-filename") || "image.png");
});
let progressPollHandle = null;
let progressTickHandle = null;
let progressStartedAt = null;
function toggleStatusView(show, statusText = "") {
  if (show) {
    if (statusText) {
      dom.statusMessage.textContent = statusText;
      logActivity("info", statusText);
    }
    dom.statusView.classList.remove("d-none");
    document.body.style.overflow = "hidden";
    if (dom.generateBtn) dom.generateBtn.disabled = true;
    if (dom.batchGenerateBtn) dom.batchGenerateBtn.disabled = true;
  } else {
    dom.statusView.classList.add("d-none");
    document.body.style.overflow = "";
    updateFrameCountTotal();
    updateBatchGenerateBtnState();
    stopProgressPolling();
  }
}
let lastLoggedProgressDetail = null;
function startProgressPolling(runId) {
  stopProgressPolling();
  if (!runId) return;
  progressStartedAt = Date.now();
  lastLoggedProgressDetail = null;
  dom.statusDetail.textContent = "";
  dom.statusElapsed.textContent = "0s elapsed";
  progressTickHandle = setInterval(() => {
    const secs = Math.round((Date.now() - progressStartedAt) / 1000);
    dom.statusElapsed.textContent = `${secs}s elapsed`;
  }, 1000);
  const poll = async () => {
    try {
      const { res, data } = await fetchJson(
        `/api/progress/${encodeURIComponent(runId)}`,
      );
      if (!res.ok || !data.stage) return;
      if (data.detail) {
        dom.statusDetail.textContent = data.detail;
        // Only log when the detail actually changes — polling fires every
        // second, but a given stage (e.g. a long render) can hold the same
        // detail text for many polls in a row; logging every poll would
        // flood the log with identical duplicate lines.
        if (data.detail !== lastLoggedProgressDetail) {
          const isRetryOrFallback = /retry|retrying|fallback|switching to|unavailable/i.test(data.detail);
          logActivity(isRetryOrFallback ? "warning" : "info", data.detail);
          lastLoggedProgressDetail = data.detail;
        }
      }
      if (data.stage === "error" && data.error) {
        dom.statusDetail.textContent = `Hit an issue: ${data.error}`;
        logActivity("error", data.error);
      }
    } catch (err) {
    }
  };
  poll();
  progressPollHandle = setInterval(poll, 1000);
}
function stopProgressPolling() {
  if (progressPollHandle) clearInterval(progressPollHandle);
  if (progressTickHandle) clearInterval(progressTickHandle);
  progressPollHandle = null;
  progressTickHandle = null;
}
function applyColorDecontamination(base64Src, edgeDepth = 2) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const width = canvas.width;
      const height = canvas.height;
      const outData = new Uint8ClampedArray(data);
      let minX = width,
        minY = height,
        maxX = 0,
        maxY = 0;
      let hasVisiblePixels = false;
      if (edgeDepth > 0) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            if (data[idx + 3] > 25) {
              let distanceToEdge = edgeDepth + 1;
              const startY = Math.max(0, y - edgeDepth);
              const endY = Math.min(height - 1, y + edgeDepth);
              const startX = Math.max(0, x - edgeDepth);
              const endX = Math.min(width - 1, x + edgeDepth);
              searchLoop: for (let ny = startY; ny <= endY; ny++) {
                for (let nx = startX; nx <= endX; nx++) {
                  if (data[(ny * width + nx) * 4 + 3] < 10) {
                    const dist = Math.max(Math.abs(nx - x), Math.abs(ny - y));
                    if (dist < distanceToEdge) {
                      distanceToEdge = dist;
                      if (distanceToEdge === 1) break searchLoop;
                    }
                  }
                }
              }
              if (distanceToEdge <= edgeDepth) {
                const r = data[idx],
                  g = data[idx + 1],
                  b = data[idx + 2];
                let gray = r * 0.299 + g * 0.587 + b * 0.114;
                const shadowFactor =
                  0.8 + 0.2 * (distanceToEdge / (edgeDepth + 1));
                gray = gray * shadowFactor;
                const blendRatio = 1 - distanceToEdge / (edgeDepth + 1);
                const aggressiveBlend = Math.pow(blendRatio, 0.4);
                outData[idx] = r + (gray - r) * aggressiveBlend;
                outData[idx + 1] = g + (gray - g) * aggressiveBlend;
                outData[idx + 2] = b + (gray - b) * aggressiveBlend;
                if (distanceToEdge <= 2)
                  outData[idx + 3] =
                    data[idx + 3] * (distanceToEdge === 1 ? 0.85 : 0.95);
              }
            }
          }
        }
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (outData[(y * width + x) * 4 + 3] > 10) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            hasVisiblePixels = true;
          }
        }
      }
      if (hasVisiblePixels) {
        const padding = 30;
        minX = Math.max(0, minX - padding);
        minY = Math.max(0, minY - padding);
        maxX = Math.min(width - 1, maxX + padding);
        maxY = Math.min(height - 1, maxY + padding);
        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = maxX - minX + 1;
        cropCanvas.height = maxY - minY + 1;
        cropCanvas
          .getContext("2d")
          .drawImage(
            canvas,
            minX,
            minY,
            cropCanvas.width,
            cropCanvas.height,
            0,
            0,
            cropCanvas.width,
            cropCanvas.height,
          );
        resolve(cropCanvas.toDataURL("image/png"));
      } else {
        resolve(canvas.toDataURL("image/png"));
      }
    };
    img.src = base64Src;
  });
}
function resizeImageForClassification(base64Src, maxDimension = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(base64Src);
    img.src = base64Src;
  });
}
function getDeviceCapabilities() {
  const cores = navigator.hardwareConcurrency || 2;
  const ram = navigator.deviceMemory || 4;
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
  let maxDimension = 1024;
  if (!isMobile && cores >= 8 && ram > 4) maxDimension = 2048;
  else if (isMobile && (cores <= 4 || ram <= 4)) maxDimension = 720;
  return maxDimension;
}
document.getElementById("videoLibraryNavBtn")?.addEventListener("click", async () => {
  try {
    const { res, data } = await fetchJson("/api/videos?limit=50");
    if (!res.ok) throw new Error(data.error || "Failed to load video library.");
    renderVideoResults(data.videos || [], [], { append: false });
  } catch (err) {
    alert(err.message);
  }
});