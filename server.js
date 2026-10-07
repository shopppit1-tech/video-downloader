const express = require("express");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   KONFIGURASI & STATE
========================= */
const PORT = process.env.PORT || 3000;
const tempDir = path.join(__dirname, "temp");
const fileTtlMs = 60 * 60 * 1000; // File dihapus otomatis setelah 1 jam
const maxVideoDuration = 3600; // Batas durasi: 60 menit (dalam detik)
const jobs = new Map();

let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 2; // Maksimal unduhan bersamaan

/* =========================
   HELPER / FUNGSI PENDUKUNG
========================= */

// Validasi URL sederhana
function isValidUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Inspeksi info video menggunakan yt-dlp CLI
async function inspectVideo(url) {
  // Option --dump-json mengambil metadata tanpa mengunduh file
  const { stdout } = await execPromise(`yt-dlp --dump-json "${url}"`);
  const info = JSON.parse(stdout);
  return {
    title: info.title || "Untitled Video",
    duration: info.duration || 0,
    is_live: info.is_live || false,
    extractor: info.extractor_key || "Unknown Platform",
  };
}

// Jadwalkan penghapusan file dari penyimpanan & memori
function scheduleDeletion(jobId, filePath) {
  setTimeout(async () => {
    try {
      await fsp.unlink(filePath);
      console.log(`[CLEANUP] File untuk Job ${jobId} berhasil dihapus.`);
    } catch (e) {
      // Abaikan jika file sudah dihapus manual
    }
    jobs.delete(jobId);
  }, fileTtlMs);
}

/* =========================
   PEMROSES ANTREAN (QUEUE)
========================= */

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  activeDownloads += 1;
  job.status = "processing";

  try {
    await fsp.mkdir(tempDir, { recursive: true });
    const outputPattern = path.join(tempDir, `${jobId}.%(ext)s`);

    // Perintah yt-dlp sesuai format yang dipilih (MP4 / MP3)
    let command = `yt-dlp -o "${outputPattern}" "${job.url}"`;
    if (job.format === "mp3") {
      command += ` -x --audio-format mp3`;
    } else {
      command += ` -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"`;
    }

    await execPromise(command);

    // Cari file hasil ekstraksi di folder temp
    const files = await fsp.readdir(tempDir);
    const downloadedFile = files.find((f) => f.startsWith(jobId));

    if (!downloadedFile) {
      throw new Error("File hasil unduhan tidak ditemukan di server.");
    }

    const filePath = path.join(tempDir, downloadedFile);
    const stats = await fsp.stat(filePath);

    job.status = "ready";
    job.filePath = filePath;
    job.size = stats.size;
    job.expiresAt = Date.now() + fileTtlMs;

    scheduleDeletion(jobId, filePath);
  } catch (error) {
    job.status = "failed";
    job.error = "Gagal memproses video. URL mungkin tidak didukung, bersifat privat, atau server diblokir.";
    console.error(`[Job ${jobId}] Error: ${error.message}`);
  } finally {
    activeDownloads -= 1;
    processQueue(); // Jalankan antrean berikutnya
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
   HALAMAN UTAMA (UI)
========================= */

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Universal Video Downloader API</title>
      <style>
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 40px 20px; text-align: center; }
        .card { background: white; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        h1 { color: #333; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
        .endpoint { background: #eef2f5; padding: 8px 12px; border-radius: 6px; font-family: monospace; display: inline-block; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Server Downloader Aktif 🚀</h1>
        <p>Backend API pengunduh video & audio otomatis siap digunakan.</p>
        <p>Mendukung link dari <strong>YouTube, Facebook, Instagram, TikTok, Twitter/X</strong>, dan lainnya.</p>
        <hr style="border:0; border-top:1px solid #eee; margin:20px 0;">
        <p><strong>Endpoint Utama:</strong></p>
        <p><span class="endpoint">POST /api/info</span> - Cek metadata video</p><br>
        <p><span class="endpoint">POST /api/download</span> - Masukkan tugas ke antrean</p><br>
        <p><span class="endpoint">GET /api/status/:jobId</span> - Cek status unduhan</p>
      </div>
    </body>
    </html>
  `);
});

/* =========================
   API ENDPOINTS
========================= */

// 1. Cek Informasi Video
app.post("/api/info", async (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "URL tidak valid. Masukkan link yang benar." });
  }

  console.log(`[INFO REQUEST] ${url}`);

  try {
    const info = await inspectVideo(url);

    if (info.is_live) {
      return res.status(400).json({
        error: "Siaran langsung (Live Stream) yang belum selesai tidak dapat diunduh.",
      });
    }

    if (info.duration && info.duration > maxVideoDuration) {
      return res.status(413).json({
        error: `Durasi video melebihi batas maksimal ${Math.round(maxVideoDuration / 60)} menit.`,
      });
    }

    return res.json({
      title: info.title,
      duration: info.duration,
      platform: info.extractor,
    });
  } catch (error) {
    console.error(`[INFO ERROR]: ${error.message}`);
    return res.status(422).json({
      error: "Informasi video tidak dapat diambil. Link mungkin privat atau tidak didukung.",
    });
  }
});

// 2. Minta Unduhan Video/Audio
app.post("/api/download", (req, res) => {
  const url = String(req.body?.url || "").trim();
  const format = String(req.body?.format || "mp4").toLowerCase();

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: "URL tidak valid." });
  }

  if (!["mp4", "mp3"].includes(format)) {
    return res.status(400).json({ error: "Format tidak didukung. Gunakan 'mp4' atau 'mp3'." });
  }

  const jobId = crypto.randomBytes(16).toString("hex");

  const job = {
    id: jobId,
    url,
    format,
    status: "queued",
    createdAt: Date.now(),
  };

  jobs.set(jobId, job);
  processQueue();

  return res.status(202).json({
    jobId,
    status: job.status,
    message: "Proses unduhan telah ditambahkan ke antrean.",
  });
});

// 3. Cek Status Pekerjaan (Job)
app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Pekerjaan tidak ditemukan atau file sudah kadaluwarsa." });
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

// 4. Unduh File Hasil Ekstraksi
app.get("/api/file/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job || job.status !== "ready" || !job.filePath) {
    return res.status(404).json({ error: "File belum siap atau tidak ditemukan." });
  }

  try {
    await fsp.access(job.filePath);
    return res.download(job.filePath);
  } catch {
    return res.status(404).json({ error: "File sudah dihapus dari server." });
  }
});

/* =========================
   MEMULAI SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Server downloader berjalan di http://localhost:${PORT}`);
});
