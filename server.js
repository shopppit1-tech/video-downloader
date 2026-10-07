const express = require("express");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());

/* =========================
   KONFIGURASI & STATE
========================= */
const tempDir = path.join(__dirname, "temp");
const fileTtlMs = 60 * 60 * 1000; // 1 jam
const maxVideoDuration = 1800; // 30 menit
const jobs = new Map();

let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 2;

/* =========================
   HELPER PLATFORM DETECTOR
========================= */

// Mengecek apakah URL berasal dari YouTube atau Facebook
function isValidUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    
    const isYouTube = host.includes("youtube.com") || host.includes("youtu.be");
    const isFacebook = host.includes("facebook.com") || host.includes("fb.watch") || host.includes("fb.com");

    if (isYouTube) return { valid: true, platform: "YouTube" };
    if (isFacebook) return { valid: true, platform: "Facebook" };
    
    return { valid: false, platform: null };
  } catch {
    return { valid: false, platform: null };
  }
}

// Mengambil info video menggunakan yt-dlp CLI
async function inspectVideo(url) {
  const { stdout } = await execPromise(`yt-dlp --dump-json "${url}"`);
  const info = JSON.parse(stdout);
  return {
    title: info.title || "Video",
    duration: info.duration || 0,
    is_live: info.is_live || false,
  };
}

function scheduleDeletion(jobId, filePath) {
  setTimeout(async () => {
    try {
      await fsp.unlink(filePath);
    } catch (e) {}
    jobs.delete(jobId);
  }, fileTtlMs);
}

/* =========================
   PROCESSOR ANTREAN
========================= */

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  activeDownloads += 1;
  job.status = "processing";

  try {
    await fsp.mkdir(tempDir, { recursive: true });
    const outputPattern = path.join(tempDir, `${jobId}.%(ext)s`);

    // Command yt-dlp untuk unduh file (MP4 atau MP3)
    let command = `yt-dlp -o "${outputPattern}" "${job.url}"`;
    if (job.format === "mp3") {
      command += ` -x --audio-format mp3`;
    } else {
      command += ` -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"`;
    }

    await execPromise(command);

    // Cari file hasil download
    const files = await fsp.readdir(tempDir);
    const downloadedFile = files.find((f) => f.startsWith(jobId));
    
    if (!downloadedFile) throw new Error("File hasil unduhan tidak ditemukan.");

    const filePath = path.join(tempDir, downloadedFile);
    const stats = await fsp.stat(filePath);

    job.status = "ready";
    job.filePath = filePath;
    job.size = stats.size;
    job.expiresAt = Date.now() + fileTtlMs;

    scheduleDeletion(jobId, filePath);
  } catch (error) {
    job.status = "failed";
    job.error = "Gagal memproses video. Pastikan URL valid/publik atau server tidak diblokir.";
    console.error(`[Job ${jobId}] Error: ${error.message}`);
  } finally {
    activeDownloads -= 1;
    processQueue();
  }
}

function processQueue() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) return;

  for (const [jobId, job] of jobs.entries()) {
    if (job.status === "queued") {
      processJob(jobId);
      break;
    }
  }
}

/* =========================
   API ENDPOINTS
========================= */

app.post("/api/info", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const check = isValidUrl(url);

  if (!check.valid) {
    return res.status(400).json({
      error: "URL tidak valid. Masukkan link YouTube atau Facebook yang sah.",
    });
  }

  try {
    const info = await inspectVideo(url);

    if (info.is_live) {
      return res.status(400).json({
        error: "Siaran langsung yang belum selesai tidak didukung.",
      });
    }

    if (info.duration && info.duration > maxVideoDuration) {
      return res.status(413).json({
        error: `Durasi video melebihi batas ${Math.round(maxVideoDuration / 60)} menit.`,
      });
    }

    return res.json({
      platform: check.platform,
      title: info.title,
      duration: info.duration,
    });
  } catch (error) {
    return res.status(422).json({
      error: "Gagal mengambil informasi video. Video mungkin bersifat privat atau dibatasi.",
    });
  }
});

app.post("/api/download", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const format = String(req.body?.format || "mp4").toLowerCase();
  const check = isValidUrl(url);

  if (!check.valid) {
    return res.status(400).json({ error: "URL YouTube atau Facebook tidak valid." });
  }

  const jobId = crypto.randomBytes(16).toString("hex");

  const job = {
    id: jobId,
    url,
    platform: check.platform,
    format,
    status: "queued",
    createdAt: Date.now(),
  };

  jobs.set(jobId, job);
  processQueue();

  return res.status(202).json({
    jobId,
    status: job.status,
    message: `Proses unduhan video ${check.platform} ditambahkan ke antrean.`,
  });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Pekerjaan tidak ditemukan." });
  }

  return res.json({
    status: job.status,
    ...(job.status === "ready" && {
      downloadUrl: `/api/file/${job.id}`,
      size: job.size,
      expiresAt: job.expiresAt,
    }),
    ...(job.status === "failed" && { error: job.error }),
  });
});

app.get("/api/file/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job || job.status !== "ready" || !job.filePath) {
    return res.status(404).json({ error: "File tidak ditemukan." });
  }

  return res.download(job.filePath);
});

app.listen(3000, () => console.log("Server berjalan di port 3000"));
