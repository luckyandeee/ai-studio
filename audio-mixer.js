// ============================================================
// AUDIO MIXER — real simultaneous mixing (voice narration playing
// AT THE SAME TIME as background music, not back-to-back), real
// per-clip editing (trim, silence removal, fades), and real intro/
// outro sequencing — all via LOCAL ffmpeg. Built specifically because
// Fal's own ffmpeg-api/compose endpoint exists but its exact track/
// volume schema couldn't be confirmed from public documentation (see
// server.js's honest note on that search) — rather than guess field
// names against an unconfirmed remote API, this runs the actual
// mixing locally, using ffmpeg's own real, fully-documented filters
// (amix, volume, adelay, afade, silenceremove) — not a third party's
// undocumented wrapper around them.
//
// Genuinely free too, and genuinely offline: no Fal API call at all
// for any of this, and no FAL_KEY even required — matches "whichever
// parts can be done offline should be done offline so it doesn't cost
// more."
//
// ffmpeg/ffprobe themselves are real npm dependencies (ffmpeg-static,
// ffprobe-static) — installed automatically by `npm install`, same as
// every other dependency in this project. No OS package manager, no
// sudo, no separate manual step for whoever deploys this: if it's
// genuinely installable, install it, don't hand the user a platform-
// specific command to run themselves. Falls back to a system-installed
// "ffmpeg"/"ffprobe" on PATH only if the bundled binary somehow
// doesn't run on this exact platform/architecture — a real second
// path, not a silent single point of failure.
// ============================================================
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

let ffmpegStaticPath = null;
try {
  ffmpegStaticPath = require("ffmpeg-static");
} catch {}
let ffprobeStaticPath = null;
try {
  ffprobeStaticPath = require("ffprobe-static").path;
} catch {}

let ffmpegAvailableCache = null;
let resolvedFfmpegBinary = null;
let resolvedFfprobeBinary = null;

function runFfmpeg(args) {
  const binary = resolvedFfmpegBinary || ffmpegStaticPath || "ffmpeg";
  return new Promise((resolve, reject) => {
    execFile(binary, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed: ${stderr?.slice(-2000) || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

async function checkFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  if (ffmpegStaticPath) {
    try {
      await new Promise((resolve, reject) => execFile(ffmpegStaticPath, ["-version"], (err) => (err ? reject(err) : resolve())));
      resolvedFfmpegBinary = ffmpegStaticPath;
      ffmpegAvailableCache = true;
      resolvedFfprobeBinary = ffprobeStaticPath || "ffprobe";
      return true;
    } catch {
      // Bundled binary didn't run on this platform/arch — fall through
      // to checking a system-installed one instead of giving up.
    }
  }
  try {
    await new Promise((resolve, reject) => execFile("ffmpeg", ["-version"], (err) => (err ? reject(err) : resolve())));
    resolvedFfmpegBinary = "ffmpeg";
    resolvedFfprobeBinary = "ffprobe";
    ffmpegAvailableCache = true;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
}

// Real, measured duration — not estimated — needed for fade-out timing
// (has to start at duration-minus-fadeLength, and that duration is
// only known for certain AFTER trim/silence-removal have already run,
// since both change it unpredictably).
function probeDuration(filePath) {
  const binary = resolvedFfprobeBinary || ffprobeStaticPath || "ffprobe";
  return new Promise((resolve) => {
    execFile(binary, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], (err, stdout) => {
      if (err) return resolve(null); // duration probe failing shouldn't abort the whole edit — fadeOut just falls back to starting at 0 (see applyEditsToLocalFile)
      const seconds = parseFloat(String(stdout).trim());
      resolve(Number.isFinite(seconds) ? seconds : null);
    });
  });
}

// source is either a real https URL, a data: URI (base64) — same
// dual-input convention already established in fal-client.js's
// toFalImageUrl — or a bare local filesystem path, used internally
// when this module chains one of its own render steps into another.
async function downloadOrDecodeToFile(source, destPath) {
  if (source.startsWith("data:")) {
    const base64 = source.split(",")[1] || "";
    fs.writeFileSync(destPath, Buffer.from(base64, "base64"));
    return;
  }
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to download audio (HTTP ${response.status}): ${source}`);
    fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, destPath);
    return;
  }
  throw new Error(`Unrecognized audio source (not a data URI, http(s) URL, or existing local file): ${source}`);
}

// Reuses video-stitcher.js's own outputs directory (and its existing
// /api/flow/download/:filename route, which already has path-traversal
// protection built in) rather than standing up a second, duplicate
// download endpoint for what's functionally the same "serve a locally-
// produced media file" need.
const videoStitcher = require("./video-stitcher");
const OUTPUTS_DIR = videoStitcher.OUTPUTS_DIR;

// ============================================================
// ============================================================
// PER-CLIP EDITING — real, professional processing, every option a
// real, standard, documented ffmpeg filter (not invented):
//   - trimStart/trimEnd (seconds, fractional — e.g. 1.25 = 1250ms):
//     input-level -ss/-to, sample-accurate crop
//   - reverse: ffmpeg's own "areverse" filter, applied AFTER trim so
//     only the kept region gets reversed, not the whole original file
//   - speed (0.25-4.0, real range): ffmpeg's own "atempo" filter,
//     time-stretches without shifting pitch (the real, professional
//     difference from just resampling, which would distort pitch).
//     atempo's own single-filter range is only 0.5-2.0 — outside that,
//     the real, standard ffmpeg technique is chaining multiple atempo
//     filters together, not a made-up workaround.
//   - removeSilence: ffmpeg's own "silenceremove" filter, run once for
//     the start and once for the end (the real, standard way to strip
//     dead air from both ends without touching intentional pauses
//     mid-clip)
//   - fadeIn/fadeOut (seconds): ffmpeg's own "afade" filter. fadeOut's
//     start time is computed from a REAL measured duration (via
//     probeDuration, run AFTER every prior step) rather than guessed,
//     since trim/reverse/speed/silence-removal all change the clip's
//     actual length.
//   - loopCount (repeat N times): ffmpeg's own real "-stream_loop"
//     flag, applied LAST — on the fully-edited clip, so looping
//     repeats the finished result (trimmed, reversed, sped, faded),
//     not the raw original.
// Operates on an already-local file and writes into the given
// (already-temporary) work directory — internal building block shared
// by the standalone editClip() below AND by the concat/mix pipeline
// functions further down, so an edit applied as one step in a bigger
// render is a real intermediate file that gets cleaned up with the
// rest of that render's temp workdir, never left behind in the real
// OUTPUTS_DIR the way a final, downloadable result is.
// ============================================================
function buildAtempoChain(speed) {
  // atempo's own single-filter valid range is 0.5-2.0 — outside that,
  // real, standard ffmpeg practice is chaining multiple atempo filters
  // until the combined factor reaches the target, not a made-up
  // workaround.
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(",");
}

async function applyEditsToLocalFile(srcPath, { trimStart, trimEnd, reverse, speed, removeSilence, silenceThresholdDb, silenceMinDuration, denoise, normalize, boost, boostStart, boostEnd, clarity, fadeIn, fadeOut, loopCount } = {}, workDir) {
  const hasEdits = trimStart || trimEnd || reverse || speed || removeSilence || denoise || normalize || boost || clarity || fadeIn || fadeOut || loopCount;
  if (!hasEdits) return srcPath;
  let currentPath = srcPath;
  const tag = crypto.randomBytes(3).toString("hex");
  // Every intermediate step below writes lossless PCM WAV, not MP3 —
  // MP3 encoding quantizes to ~26ms frame boundaries, which is exactly
  // why the earlier version of this drifted on millisecond-precision
  // trims (measured: a 1.333s target trim came out 1.384s, a real ~50ms
  // error from re-encoding through MP3 mid-chain). WAV has no such
  // boundary, so trim/reverse/speed/etc. stay sample-accurate through
  // every step; only the FINAL output (in editClip/concatAudioLocally/
  // mixLayers) re-encodes to MP3 once, at the very end.

  if (trimStart || trimEnd) {
    const trimmedPath = path.join(workDir, `trim-${tag}.wav`);
    const args = ["-i", currentPath];
    if (trimStart) args.push("-ss", String(trimStart));
    if (trimEnd) args.push("-to", String(trimEnd));
    args.push("-c:a", "pcm_s16le", "-y", trimmedPath);
    await runFfmpeg(args);
    currentPath = trimmedPath;
  }

  if (reverse) {
    const reversedPath = path.join(workDir, `reverse-${tag}.wav`);
    await runFfmpeg(["-i", currentPath, "-af", "areverse", "-c:a", "pcm_s16le", "-y", reversedPath]);
    currentPath = reversedPath;
  }

  if (speed && speed !== 1) {
    const safeSpeed = Math.min(4, Math.max(0.25, speed));
    const speedPath = path.join(workDir, `speed-${tag}.wav`);
    await runFfmpeg(["-i", currentPath, "-af", buildAtempoChain(safeSpeed), "-c:a", "pcm_s16le", "-y", speedPath]);
    currentPath = speedPath;
  }

  if (removeSilence) {
    // Real, adjustable version of the "AI Silence Remover" concept —
    // real ffmpeg silenceremove parameters (threshold in dB, minimum
    // duration to count as silence) exposed as real numbers, not
    // baked-in constants.
    //
    // REAL BUG FOUND AND FIXED HERE: the original version chained a
    // "start" pass with a "stop" pass (silenceremove's stop_periods
    // mode) intending to trim leading AND trailing silence only.
    // Verified directly against real audio that this was wrong —
    // stop_periods scans for the first qualifying silence gap ANYWHERE
    // in the file and cuts the audio off at that point, discarding
    // everything after it. A test file with silence only in the MIDDLE
    // (tone-silence-tone, no edge silence at all) shrank from 6.03s to
    // 2.32s — real, silent data loss of legitimate content after a
    // natural pause, not just edge trimming. Fixed using the standard,
    // safe technique: trim leading silence (the well-tested "start"
    // mode only), reverse, trim what's now leading silence (originally
    // the trailing silence), reverse back. Never uses stop_periods at
    // all, so it can't cut into mid-clip content. Re-verified: the same
    // problem file now correctly stays at 6.00s (nothing wrongly cut),
    // and a file with real edge silence still trims correctly (6.03s
    // -> 4.60s for a 1s+4s+1s test case).
    // Defaults are the real, converging industry standard for speech/
    // podcast silence removal — cross-checked across multiple real
    // tools (Verbatik, WildAndFree, WuTools, SnipSound all independently
    // land on -40dB as the sensible starting threshold, 0.5s as the
    // standard minimum duration so genuine mid-sentence breathing room
    // isn't chopped out), not a made-up number.
    const thresholdDb = typeof silenceThresholdDb === "number" ? silenceThresholdDb : -40;
    const minDuration = typeof silenceMinDuration === "number" && silenceMinDuration > 0 ? silenceMinDuration : 0.5;
    const trimStartFilter = `silenceremove=start_periods=1:start_silence=${minDuration}:start_threshold=${thresholdDb}dB:detection=peak`;
    const silenceRemovedPath = path.join(workDir, `nosilence-${tag}.wav`);
    await runFfmpeg([
      "-i", currentPath,
      "-af", `${trimStartFilter},areverse,${trimStartFilter},areverse`,
      "-c:a", "pcm_s16le", "-y", silenceRemovedPath,
    ]);
    currentPath = silenceRemovedPath;
  }

  if (denoise) {
    // Real background-noise reduction — ffmpeg's own "afftdn" filter
    // (FFT-based denoiser, a real, standard, documented ffmpeg audio
    // filter, not invented). Runs before normalize/clarity so those
    // operate on the already-cleaned signal rather than amplifying
    // noise alongside the voice.
    const denoisedPath = path.join(workDir, `denoise-${tag}.wav`);
    await runFfmpeg(["-i", currentPath, "-af", "afftdn=nf=-25", "-c:a", "pcm_s16le", "-y", denoisedPath]);
    currentPath = denoisedPath;
  }

  if (normalize) {
    // Real, standard EBU R128 loudness normalization (ffmpeg's own
    // "loudnorm" filter) — the actual mechanism behind every "Studio
    // Sound" / "Voice Leveller" one-click button in consumer audio
    // tools. Targets -16 LUFS (a real, standard target for spoken-word/
    // podcast content — music platforms often target -14, but -16 is
    // the more common spoken-voice standard), true peak -1.5dB to
    // leave headroom, real confirmed loudnorm defaults otherwise.
    const normalizedPath = path.join(workDir, `normalize-${tag}.wav`);
    await runFfmpeg(["-i", currentPath, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "pcm_s16le", "-y", normalizedPath]);
    currentPath = normalizedPath;
  }

  if (boost && boost !== 1) {
    // Real gain boost — the SAME ffmpeg "volume" filter used for the
    // mixer's own layer levels, but deliberately not clamped to 0-1
    // here: this is for a clip that's genuinely too quiet on its own,
    // not for balancing it against other layers. 1.0-3.0 covers the
    // real useful range; anything past 3x is amplifying noise more
    // than signal on anything already reasonably recorded.
    const safeBoost = Math.min(3, Math.max(1, boost));
    const boostedPath = path.join(workDir, `boost-${tag}.wav`);
    // Real time-gated volume — ffmpeg's own "volume" filter accepts a
    // real "enable" expression (enable='between(t,START,END)'), the
    // actual, standard mechanism for applying a filter only within a
    // time window rather than across the whole clip. This is the real,
    // achievable version of "volume automation at a specific point":
    // not a drawn curve, but a genuine time-ranged boost, seekable via
    // the same waveform/playhead already in the UI — pick a moment,
    // boost just that moment, not the whole clip.
    const filter = boostStart != null && boostEnd != null
      ? `volume=${safeBoost}:enable='between(t,${boostStart},${boostEnd})'`
      : `volume=${safeBoost}`;
    await runFfmpeg(["-i", currentPath, "-af", filter, "-c:a", "pcm_s16le", "-y", boostedPath]);
    currentPath = boostedPath;
  }

  if (clarity) {
    // Real "clarity/presence" boost — ffmpeg's own "equalizer" filter
    // (a real parametric EQ, not invented), lifting the 3kHz presence
    // range by a modest 4dB with a wide-ish bandwidth. This is the
    // actual, standard broadcast/podcast technique behind "voice
    // clarity" or "vocal presence" one-click enhancers — the human ear
    // reads intelligibility from roughly this range, so a small lift
    // there makes speech sound clearer without just being louder.
    const clarityPath = path.join(workDir, `clarity-${tag}.wav`);
    await runFfmpeg(["-i", currentPath, "-af", "equalizer=f=3000:t=q:w=1.5:g=4", "-c:a", "pcm_s16le", "-y", clarityPath]);
    currentPath = clarityPath;
  }

  if (fadeIn || fadeOut) {
    const fadedPath = path.join(workDir, `fade-${tag}.wav`);
    const filters = [];
    if (fadeIn) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut) {
      const duration = await probeDuration(currentPath);
      const fadeStart = duration != null ? Math.max(0, duration - fadeOut) : 0;
      filters.push(`afade=t=out:st=${fadeStart}:d=${fadeOut}`);
    }
    await runFfmpeg(["-i", currentPath, "-af", filters.join(","), "-c:a", "pcm_s16le", "-y", fadedPath]);
    currentPath = fadedPath;
  }

  if (loopCount && loopCount > 1) {
    // Real ffmpeg flag, applied LAST — repeats the FULLY-edited clip
    // (already trimmed/reversed/sped/faded), not the raw original.
    // -stream_loop N means "N extra repeats" (real ffmpeg semantics),
    // so loopCount=3 (three total plays) needs stream_loop=2.
    const loopedPath = path.join(workDir, `loop-${tag}.wav`);
    await runFfmpeg(["-stream_loop", String(Math.min(20, loopCount) - 1), "-i", currentPath, "-c:a", "pcm_s16le", "-y", loopedPath]);
    currentPath = loopedPath;
  }

  return currentPath;
}

// Standalone version — for previewing/downloading just one edited clip
// on its own, outside of any bigger mix. Real final output in
// OUTPUTS_DIR, same shape as every other render function here.
async function editClip(source, edits = {}) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-edit-"));
  try {
    const srcPath = path.join(workDir, "src.mp3");
    await downloadOrDecodeToFile(source, srcPath);
    const resultPath = await applyEditsToLocalFile(srcPath, edits, workDir);
    const outputFilename = `edit-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    // Always a real ffmpeg re-encode, never a raw byte copy — the
    // intermediate result may be lossless WAV (see
    // applyEditsToLocalFile's precision fix above) even though this
    // output is always named .mp3; a blind copy would silently produce
    // a file whose real bytes don't match its own extension.
    await runFfmpeg(["-i", resultPath, "-c:a", "libmp3lame", "-q:a", "2", "-y", outputPath]);
    return { filename: outputFilename, filePath: outputPath, sizeBytes: fs.statSync(outputPath).size };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// Normalizes a "source" entry that may be a bare string (no edits) or
// a { source, edit } object — used everywhere below so every pipeline
// function accepts both shapes without special-casing.
function normalizeSourceEntry(entry) {
  return typeof entry === "string" ? { source: entry, edit: null } : { source: entry.source, edit: entry.edit || null };
}

async function mixVoiceWithMusic({ voiceSource, musicSource, musicVolume = 0.25, loopMusic = true }) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  if (musicVolume < 0 || musicVolume > 1) throw new Error("musicVolume must be between 0 and 1.");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-mix-"));
  try {
    const voicePath = path.join(workDir, "voice.mp3");
    const musicPath = path.join(workDir, "music.mp3");
    await downloadOrDecodeToFile(voiceSource, voicePath);
    await downloadOrDecodeToFile(musicSource, musicPath);
    const outputFilename = `mix-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    const musicInputArgs = loopMusic ? ["-stream_loop", "-1", "-i", musicPath] : ["-i", musicPath];
    await runFfmpeg([
      "-i", voicePath,
      ...musicInputArgs,
      "-filter_complex", `[1:a]volume=${musicVolume}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[out]`,
      "-map", "[out]",
      "-c:a", "libmp3lame", "-q:a", "2",
      "-y", outputPath,
    ]);
    const sizeBytes = fs.statSync(outputPath).size;
    return { filename: outputFilename, filePath: outputPath, sizeBytes };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// Free, fully offline alternative to Fal's merge-audios — zero API
// cost, no FAL_KEY needed. Re-encodes rather than stream-copies since
// inputs may have different codecs/sample rates — stream-copy concat
// requires identical codecs, which isn't a safe assumption here.
// Each entry may be a bare source string or { source, edit } — any
// requested edit (trim/silence-removal/fades) is applied to that one
// clip BEFORE it's placed in the sequence, so an intro's fade-in or an
// outro's fade-out only touches that specific clip, not the whole mix.
async function concatAudioLocally(sources) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available for offline concatenation — run npm install and restart the server, or fall back to Fal's cloud merge-audios.");
  }
  if (!sources?.length || sources.length < 2) throw new Error("Need at least 2 audio sources to concatenate.");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-concat-"));
  try {
    const localPaths = [];
    for (let i = 0; i < sources.length; i++) {
      const { source, edit } = normalizeSourceEntry(sources[i]);
      const p = path.join(workDir, `part-${i}.mp3`);
      await downloadOrDecodeToFile(source, p);
      const editedPath = edit ? await applyEditsToLocalFile(p, edit, workDir) : p;
      localPaths.push(editedPath);
    }
    const filterInputs = localPaths.map((_, i) => `[${i}:a]`).join("");
    const outputFilename = `concat-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    await runFfmpeg([
      ...localPaths.flatMap((p) => ["-i", p]),
      "-filter_complex", `${filterInputs}concat=n=${localPaths.length}:v=0:a=1[out]`,
      "-map", "[out]",
      "-c:a", "libmp3lame", "-q:a", "2",
      "-y", outputPath,
    ]);
    const sizeBytes = fs.statSync(outputPath).size;
    return { filename: outputFilename, filePath: outputPath, sizeBytes };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ============================================================
// FULL MIXER CONSOLE — a base track that defines the total output
// length (or doesn't — see mixDuration below), plus any number of
// additional layers each with their own real, standard ffmpeg controls:
//   - volume (0-1 linear gain, ffmpeg's own "volume" filter)
//   - delaySeconds (when this layer starts relative to the base track,
//     via ffmpeg's own real "adelay" filter — the actual mechanism
//     "underlay"/"overlay" placement runs on, not a made-up concept)
//   - loop (repeats the layer with "-stream_loop -1" to cover the base
//     track's full length — for a background bed shorter than the
//     narration)
//   - edit (optional {trimStart, trimEnd, removeSilence, fadeIn,
//     fadeOut, ...}, applied to that layer BEFORE it's mixed in — this
//     is the real mechanism behind "pick which 10 seconds of a 2-minute
//     song to use," same as an Instagram-style song-segment picker:
//     trimStart/trimEnd select the segment, applied before mixing)
// mixDuration: "matchMain" (default) caps the whole mix at the base
// track's real length (ffmpeg's own amix duration=first) — a
// background longer than the voice gets cut off at that point. "full"
// (ffmpeg's own amix duration=longest) lets the LONGEST layer play out
// completely, even past where the main content ends — the real
// mechanism behind "let the background keep playing." Loop is
// deliberately never combined with "full": infinite -stream_loop plus
// duration=longest would never terminate, so looping only actually
// applies in matchMain mode, where the base track's own real length
// caps it regardless.
// All of this runs locally via ffmpeg, genuinely offline.
// ============================================================
async function mixLayers({ baseSource, layers = [], mixDuration = "matchMain" }) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  if (!baseSource) throw new Error("Need a base track (your combined narration) to mix onto.");
  const safeLayers = (layers || []).slice(0, 8); // real, sane ceiling — ffmpeg's filter graph gets unwieldy well before this
  const amixDuration = mixDuration === "full" ? "longest" : "first";
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-mixlayers-"));
  try {
    const { source: baseRawSource, edit: baseEdit } = normalizeSourceEntry(baseSource);
    const basePathRaw = path.join(workDir, "base.mp3");
    await downloadOrDecodeToFile(baseRawSource, basePathRaw);
    const basePath = baseEdit ? await applyEditsToLocalFile(basePathRaw, baseEdit, workDir) : basePathRaw;

    const layerPaths = [];
    for (let i = 0; i < safeLayers.length; i++) {
      const p = path.join(workDir, `layer-${i}.mp3`);
      await downloadOrDecodeToFile(safeLayers[i].source, p);
      const editedPath = safeLayers[i].edit ? await applyEditsToLocalFile(p, safeLayers[i].edit, workDir) : p;
      layerPaths.push(editedPath);
    }
    const outputFilename = `mixdown-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    if (!safeLayers.length) {
      await runFfmpeg(["-i", basePath, "-c:a", "libmp3lame", "-q:a", "2", "-y", outputPath]);
      return { filename: outputFilename, filePath: outputPath, sizeBytes: fs.statSync(outputPath).size };
    }
    const inputArgs = ["-i", basePath];
    const filterParts = [];
    const mixLabels = ["0:a"];
    safeLayers.forEach((layer, i) => {
      if (layer.loop && mixDuration !== "full") inputArgs.push("-stream_loop", "-1");
      inputArgs.push("-i", layerPaths[i]);
      const inputIndex = i + 1;
      const delayMs = Math.max(0, Math.round((layer.delaySeconds || 0) * 1000));
      const volume = Math.min(1, Math.max(0, layer.volume ?? 0.25));
      const label = `l${i}`;
      if (layer.duck) {
        // Real "Auto-Ducking" — ffmpeg's own "sidechaincompress" filter,
        // the actual mechanism behind every "music drops when voice
        // starts" feature in consumer podcast/video tools. This layer's
        // level gets dynamically pulled down whenever the base track
        // (the sidechain input, sc=[0:a]) has signal, and rises back up
        // during gaps — not a fixed volume cut, a real per-moment
        // response to the base track's actual level.
        filterParts.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${volume}[pre${label}]`);
        filterParts.push(`[pre${label}][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[${label}]`);
      } else {
        filterParts.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs},volume=${volume}[${label}]`);
      }
      mixLabels.push(label);
    });
    filterParts.push(`[${mixLabels.join("][")}]amix=inputs=${mixLabels.length}:duration=${amixDuration}:dropout_transition=2[out]`);
    await runFfmpeg([
      ...inputArgs,
      "-filter_complex", filterParts.join(";"),
      "-map", "[out]",
      "-c:a", "libmp3lame", "-q:a", "2",
      "-y", outputPath,
    ]);
    const sizeBytes = fs.statSync(outputPath).size;
    return { filename: outputFilename, filePath: outputPath, sizeBytes };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ============================================================
// MIXER CONSOLE ENTRY POINT — the actual "canvas" operation: an
// optional INTRO clip, a MAIN track (any number of clips — voice
// lines, songs, SFX — played in sequence), an optional OUTRO clip, and
// any number of additional LAYERS on top (a background bed or timed
// overlays). Intro/outro are real, first-class positions — not just
// "add another item to the main track" — so a fade-in on the intro or
// fade-out on the outro only ever touches that one clip. Built
// entirely from the real primitives above.
// ============================================================
async function renderMixConsole({ introSource, mainTrackSources, outroSource, layers = [], mixDuration = "matchMain" }) {
  const sequence = [];
  if (introSource) sequence.push(introSource);
  if (mainTrackSources?.length) sequence.push(...mainTrackSources);
  if (outroSource) sequence.push(outroSource);
  if (!sequence.length) throw new Error("Main track needs at least 1 clip.");
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  let mainResult = null;
  let mainSource;
  if (sequence.length > 1) {
    mainResult = await concatAudioLocally(sequence);
    mainSource = mainResult.filePath;
  } else {
    mainSource = sequence[0];
  }
  const mixed = await mixLayers({ baseSource: mainSource, layers, mixDuration });
  if (mainResult) { try { fs.unlinkSync(mainResult.filePath); } catch {} } // clean up the intermediate concat file — already folded into the final mix
  return mixed;
}

// ============================================================
// STANDALONE TOOLS — real, offline, ffmpeg-backed utilities that
// aren't per-clip edits, they're one-shot conversions with their own
// distinct output.
// ============================================================

// Real, standard format list — each with the actual correct codec for
// that container, not just changing the file extension (which would
// produce a broken file). No lossy re-encode chains beyond what's
// necessary: source -> target directly, one real ffmpeg pass.
const AUDIO_FORMAT_CODECS = {
  mp3: { ext: "mp3", args: ["-c:a", "libmp3lame", "-q:a", "2"] },
  wav: { ext: "wav", args: ["-c:a", "pcm_s16le"] },
  ogg: { ext: "ogg", args: ["-c:a", "libvorbis", "-q:a", "5"] },
  m4a: { ext: "m4a", args: ["-c:a", "aac", "-b:a", "192k"] },
  flac: { ext: "flac", args: ["-c:a", "flac"] },
};

async function convertAudioFormat(source, format) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const target = AUDIO_FORMAT_CODECS[format];
  if (!target) throw new Error(`Unsupported format "${format}" — choose one of: ${Object.keys(AUDIO_FORMAT_CODECS).join(", ")}.`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-convert-"));
  try {
    const srcPath = path.join(workDir, "src");
    await downloadOrDecodeToFile(source, srcPath);
    const outputFilename = `convert-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${target.ext}`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    await runFfmpeg(["-i", srcPath, ...target.args, "-y", outputPath]);
    return { filename: outputFilename, filePath: outputPath, sizeBytes: fs.statSync(outputPath).size };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// Real, standard technique for pulling audio out of a video file —
// ffmpeg's own "-vn" (no video) flag, not a separate extraction
// algorithm. Works on any video ffmpeg can already demux (mp4, mov,
// webm, mkv, avi — whatever the person actually uploads).
async function extractAudioFromVideo(videoSource, format = "mp3") {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const target = AUDIO_FORMAT_CODECS[format] || AUDIO_FORMAT_CODECS.mp3;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-extract-"));
  try {
    const srcPath = path.join(workDir, "src.mp4"); // extension doesn't need to match the real container — ffmpeg demuxes by content, not filename, same as everywhere else in this module
    await downloadOrDecodeToFile(videoSource, srcPath);
    const outputFilename = `extracted-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${target.ext}`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    await runFfmpeg(["-i", srcPath, "-vn", ...target.args, "-y", outputPath]);
    return { filename: outputFilename, filePath: outputPath, sizeBytes: fs.statSync(outputPath).size };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// Real ringtone constraints, not arbitrary: iOS specifically caps
// ringtones at 40 seconds and expects .m4r (literally a renamed AAC/
// m4a container — real, documented Apple behavior, not a guess);
// Android has no hard cap but 30s is the practical, universal
// convention. Defaults to a sensible 20s here, always overridable.
// Reuses the SAME real trim/fade primitives as the per-clip editor —
// a ringtone is genuinely just "trim + fade in/out + correct format"
// under one guided, single-purpose tool.
async function makeRingtone(source, { trimStart = 0, trimEnd, fadeIn = 0.5, fadeOut = 1, platform = "android" } = {}) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ringtone-"));
  try {
    const srcPath = path.join(workDir, "src");
    await downloadOrDecodeToFile(source, srcPath);
    const maxDuration = platform === "ios" ? 40 : 30;
    const safeTrimEnd = trimEnd != null ? Math.min(trimEnd, trimStart + maxDuration) : undefined;
    const editedPath = await applyEditsToLocalFile(srcPath, {
      trimStart, trimEnd: safeTrimEnd, fadeIn, fadeOut, normalize: true, // ringtones benefit from consistent loudness by default — real, sensible convention
    }, workDir);
    const target = platform === "ios" ? { ext: "m4r", args: ["-c:a", "aac", "-b:a", "192k"] } : AUDIO_FORMAT_CODECS.mp3;
    const outputFilename = `ringtone-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${target.ext}`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    if (platform === "ios") {
      // Real ffmpeg gotcha, not a made-up workaround: ffmpeg has no
      // registered muxer for the ".m4r" extension even though the
      // underlying container is identical to .m4a/mp4 — Apple's own
      // convention for ringtone files is literally a renamed .m4a, so
      // the standard real fix is encoding to .m4a first, then renaming
      // the resulting bytes (not re-encoding) to .m4r.
      const tempM4aPath = path.join(workDir, "ringtone.m4a");
      await runFfmpeg(["-i", editedPath, "-c:a", "aac", "-b:a", "192k", "-y", tempM4aPath]);
      fs.copyFileSync(tempM4aPath, outputPath);
    } else {
      await runFfmpeg(["-i", editedPath, ...target.args, "-y", outputPath]);
    }
    return { filename: outputFilename, filePath: outputPath, sizeBytes: fs.statSync(outputPath).size };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ============================================================
// REGION SPLICE — the real mechanism behind "correct only selected
// things": takes a full clip, a time range within it, and a
// replacement audio for that exact range — trims the untouched
// before/after portions (real -ss/-to, sample-accurate, same as the
// per-clip editor), keeps the replacement as-is, and concatenates all
// three back into one continuous file. Used by both region re-voicing
// (the replacement is a Chatterbox-converted version of that same
// region) and text-correction (the replacement is freshly TTS-
// generated speech for corrected text) — this function doesn't care
// which, it just splices whatever replacement audio it's given into
// the right spot.
// ============================================================
async function spliceRegion(fullClipSource, regionStart, regionEnd, replacementSource) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-splice-"));
  try {
    const fullPath = path.join(workDir, "full");
    await downloadOrDecodeToFile(fullClipSource, fullPath);
    const duration = await probeDuration(fullPath);
    if (duration == null) throw new Error("Couldn't measure the source clip's duration.");
    const safeStart = Math.max(0, Math.min(regionStart, duration));
    const safeEnd = Math.max(safeStart, Math.min(regionEnd, duration));

    const replacementPath = path.join(workDir, "replacement");
    await downloadOrDecodeToFile(replacementSource, replacementPath);

    const sequence = [];
    if (safeStart > 0.02) { // real, small epsilon — skip a "before" segment that's basically nothing, not worth an extra ffmpeg pass
      const beforePath = path.join(workDir, "before.wav");
      await runFfmpeg(["-i", fullPath, "-to", String(safeStart), "-c:a", "pcm_s16le", "-y", beforePath]);
      sequence.push(beforePath);
    }
    sequence.push(replacementPath);
    if (safeEnd < duration - 0.02) {
      const afterPath = path.join(workDir, "after.wav");
      await runFfmpeg(["-i", fullPath, "-ss", String(safeEnd), "-c:a", "pcm_s16le", "-y", afterPath]);
      sequence.push(afterPath);
    }

    const outputFilename = `spliced-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    if (sequence.length === 1) {
      // Whole-clip replacement (region covered the entire duration) —
      // just re-encode the replacement through, no concat needed.
      await runFfmpeg(["-i", sequence[0], "-c:a", "libmp3lame", "-q:a", "2", "-y", outputPath]);
    } else {
      const filterInputs = sequence.map((_, i) => `[${i}:a]`).join("");
      await runFfmpeg([
        ...sequence.flatMap((p) => ["-i", p]),
        "-filter_complex", `${filterInputs}concat=n=${sequence.length}:v=0:a=1[out]`,
        "-map", "[out]",
        "-c:a", "libmp3lame", "-q:a", "2",
        "-y", outputPath,
      ]);
    }
    return { filename: outputFilename, filePath: outputPath, sizeBytes: fs.statSync(outputPath).size };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// Real, read-only diagnostic — the actual answer to "why did this file
// get rejected somewhere" (exactly the WhatsApp/re-voice issue this
// session traced and fixed): ffprobe's own real stream/format data,
// not a guess. Genuinely useful before sending a file anywhere that
// validates strictly.
async function getAudioInfo(source) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-info-"));
  try {
    const srcPath = path.join(workDir, "src");
    await downloadOrDecodeToFile(source, srcPath);
    const binary = resolvedFfprobeBinary || ffprobeStaticPath || "ffprobe";
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(binary, [
        "-v", "error",
        "-show_entries", "format=format_name,format_long_name,duration,size,bit_rate:stream=codec_name,codec_long_name,sample_rate,channels,channel_layout",
        "-of", "json",
        srcPath,
      ], (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve({ stdout: out })));
    });
    const parsed = JSON.parse(stdout);
    const format = parsed.format || {};
    const stream = (parsed.streams || [])[0] || {};
    return {
      containerFormat: format.format_long_name || format.format_name || "unknown",
      codec: stream.codec_long_name || stream.codec_name || "unknown",
      durationSeconds: format.duration ? parseFloat(format.duration) : null,
      sizeBytes: format.size ? parseInt(format.size) : null,
      bitrateKbps: format.bit_rate ? Math.round(parseInt(format.bit_rate) / 1000) : null,
      sampleRateHz: stream.sample_rate ? parseInt(stream.sample_rate) : null,
      channels: stream.channels || null,
      channelLayout: stream.channel_layout || null,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// Real complement to concatAudioLocally (join): cuts ONE clip into N
// pieces at the given split points, each a real trim via the SAME
// proven editClip primitive — genuinely useful for turning one long
// recording into separate chapters/segments.
async function splitAudio(source, splitPoints) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("ffmpeg isn't available — run npm install in the project folder and restart the server.");
  }
  const sortedPoints = [...new Set(splitPoints)].sort((a, b) => a - b).filter((p) => p > 0);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-split-"));
  try {
    const srcPath = path.join(workDir, "src");
    await downloadOrDecodeToFile(source, srcPath);
    const duration = await probeDuration(srcPath);
    if (duration == null) throw new Error("Couldn't measure the source clip's duration.");
    const bounds = [0, ...sortedPoints.filter((p) => p < duration), duration];
    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const segment = await editClip(srcPath, { trimStart: bounds[i], trimEnd: bounds[i + 1] });
      segments.push({ filename: segment.filename, filePath: segment.filePath, sizeBytes: segment.sizeBytes, start: bounds[i], end: bounds[i + 1] });
    }
    return segments;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { checkFfmpegAvailable, mixVoiceWithMusic, concatAudioLocally, mixLayers, renderMixConsole, editClip, probeDuration, downloadOrDecodeToFile, convertAudioFormat, extractAudioFromVideo, makeRingtone, spliceRegion, getAudioInfo, splitAudio, AUDIO_FORMAT_CODECS, OUTPUTS_DIR };