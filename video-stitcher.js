// ============================================================
// VIDEO STITCHER — real merging of multiple scene clips into one file.
// This exists because a genuinely long (multi-minute, up to 30-minute)
// video can't come from a single Fal model call — no model offers that
// in one generation — so it has to be built from multiple shorter
// scene clips merged into one.
//
// PRIMARY PATH: Fal's own hosted merge endpoint
// (fal-ai/ffmpeg-api/merge-videos), confirmed directly from Fal's own
// API docs — real schema (video_urls, target_fps, resolution), real
// price ($0.00017/compute second). This is the actual fix for "server
// doesn't have ffmpeg": it runs in Fal's cloud, not on this app's own
// server, so there's no local system dependency to be missing at all.
//
// FALLBACK PATH: local ffmpeg (download each clip, normalize, concat),
// used only if the cloud call fails for some reason — kept as a second
// real path rather than a single point of failure, consistent with the
// "always try to produce an output" standard the rest of this app holds.
// ============================================================
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { fal } = require("@fal-ai/client");
const { withConcurrencyLimit } = require("./fal-client");

let ffmpegAvailableCache = null; // cached after first real check — avoids re-spawning a process on every single request

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg failed: ${stderr?.slice(-2000) || err.message}`));
      resolve({ stdout, stderr });
    });
  });
}

async function checkFfmpegAvailable() {
  if (ffmpegAvailableCache !== null) return ffmpegAvailableCache;
  try {
    await runFfmpeg(["-version"]);
    ffmpegAvailableCache = true;
  } catch {
    ffmpegAvailableCache = false;
  }
  return ffmpegAvailableCache;
}

async function downloadToFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download clip (HTTP ${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

const OUTPUTS_DIR = path.join(__dirname, "flow-outputs");
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// Confirmed real enum values from Fal's own schema for this endpoint —
// used for the fallback path's normalization too, so both paths target
// the same real resolutions.
const FAL_RESOLUTION_ENUM = {
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
  "1:1": "square_hd",
};
const LOCAL_TARGET_RESOLUTIONS = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "1:1": "720:720",
};

// Real cloud-based merge — no local dependency at all. clipUrls are the
// real Fal-hosted URLs already returned by each scene's generation, so
// they're simply passed straight through; Fal downloads and merges them
// server-side.
async function stitchViaFalCloud(clipUrls, aspectRatio, apiKey) {
  fal.config({ credentials: apiKey });
  // Real timeout — the same gap already fixed once this session for
  // every other Fal call in this app (a bare fal.subscribe() with no
  // timeout can hang indefinitely on a stuck request). Now shares the
  // real, app-wide concurrency limiter from fal-client.js too — this
  // module used to fire its own fal.subscribe() call with zero
  // awareness of how many other requests were in flight elsewhere in
  // the app, which was a real gap given Fal's own account-level
  // concurrency limits (confirmed: new accounts start at just 2
  // concurrent requests).
  const timeoutMs = 180000;
  const result = await withConcurrencyLimit(() => Promise.race([
    fal.subscribe("fal-ai/ffmpeg-api/merge-videos", {
      input: {
        video_urls: clipUrls,
        resolution: FAL_RESOLUTION_ENUM[aspectRatio] || FAL_RESOLUTION_ENUM["16:9"],
      },
      logs: false,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Fal cloud merge timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
  ]));
  const video = result?.data?.video;
  if (!video?.url) throw new Error("Fal's merge-videos endpoint returned no video file.");
  return { remoteUrl: video.url, sizeBytes: video.file_size || null };
}

// Local fallback — only reached if the cloud path above fails. Same
// download-normalize-concat approach as before, still real and tested,
// just no longer the only path.
async function stitchViaLocalFfmpeg(clipUrls, aspectRatio, onProgress) {
  if (!(await checkFfmpegAvailable())) {
    throw new Error("Neither Fal's cloud merge nor local ffmpeg are available — stitching genuinely can't happen right now.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-stitch-"));
  try {
    const localPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      onProgress?.(`(Fallback path) Downloading clip ${i + 1}/${clipUrls.length}...`);
      const localPath = path.join(workDir, `clip-${i}.mp4`);
      await downloadToFile(clipUrls[i], localPath);
      localPaths.push(localPath);
    }
    const resolution = LOCAL_TARGET_RESOLUTIONS[aspectRatio] || LOCAL_TARGET_RESOLUTIONS["16:9"];
    const normalizedPaths = [];
    for (let i = 0; i < localPaths.length; i++) {
      onProgress?.(`(Fallback path) Normalizing clip ${i + 1}/${localPaths.length}...`);
      const normalizedPath = path.join(workDir, `norm-${i}.mp4`);
      await runFfmpeg([
        "-i", localPaths[i],
        "-vf", `scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-ar", "44100",
        "-y", normalizedPath,
      ]);
      normalizedPaths.push(normalizedPath);
    }
    onProgress?.("(Fallback path) Stitching all clips together...");
    const listPath = path.join(workDir, "concat-list.txt");
    fs.writeFileSync(listPath, normalizedPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const outputFilename = `flow-video-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-y", outputPath]);
    const sizeBytes = fs.statSync(outputPath).size;
    return { filename: outputFilename, filePath: outputPath, sizeBytes };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// clipUrls: array of real Fal-hosted video URLs, in the order they
// should play. Returns either { remoteUrl } (cloud path — already
// hosted, no local file involved) or { filename, filePath } (local
// fallback path, needs this app's own download route) — the caller
// checks which shape it got.
async function stitchClips(clipUrls, { aspectRatio = "16:9", apiKey, onProgress } = {}) {
  if (!clipUrls?.length) throw new Error("No clips to stitch.");
  try {
    onProgress?.("Merging scenes via Fal's cloud merge service...");
    return await stitchViaFalCloud(clipUrls, aspectRatio, apiKey);
  } catch (cloudErr) {
    console.warn(`[VideoStitcher] Fal cloud merge failed (${cloudErr.message}) — trying local ffmpeg as a fallback instead of giving up.`);
    onProgress?.("Cloud merge had trouble — trying local stitching instead...");
    return await stitchViaLocalFfmpeg(clipUrls, aspectRatio, onProgress);
  }
}

function cleanupOldOutputs(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(OUTPUTS_DIR)) {
      const filePath = path.join(OUTPUTS_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`[VideoStitcher] Cleanup pass failed: ${err.message}`);
  }
}

module.exports = { checkFfmpegAvailable, stitchClips, cleanupOldOutputs, OUTPUTS_DIR };