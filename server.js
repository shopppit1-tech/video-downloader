const express = require("express");
const rateLimit = require("express-rate-limit");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);
const fileTtlMs = Number(process.env.FILE_TTL_MINUTES || 30) * 60 * 1000;
const maxConcurrentDownloads = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2);
const maxVideoDuration = Number(process.env.MAX_VIDEO_DURATION_SECONDS || 7200);
const tempDir = path.join(__dirname, "temp");
const jobs = new Map();
let activeDownloads = 0;

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Melayani file statis dari folder public jika ada
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

/* =========================
   HELPER FUNCTIONS
========================= */

// Validasi URL secara umum (Mendukung link apa saja)
function isValidUrl(input) {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`${command} tidak tersedia: ${error.message}`)));
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} berhenti dengan kode ${code}: ${stderr.slice(-2000)}`)));
  });
}

function publicVideoInfo(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = [...new Set(formats.filter((f) => f.vcodec && f.vcodec !== "none" && Number.isFinite(f.height)).map((f) => f.height))].sort((a, b) => b - a).slice(0, 12);
  return {
    id: info.id,
    title: info.title || "video",
    thumbnail: info.thumbnail || null,
    duration: Number(info.duration || 0),
    uploader: info.uploader || info.extractor_key || null,
    heights,
    hasAudio: formats.some((f) => f.acodec && f.acodec !== "none")
  };
}

async function removeFile(filePath) { 
  if (filePath) await fsp.rm(filePath, { force: true }).catch((error) => console.error("Gagal menghapus file:", error.message)); 
}

function scheduleDeletion(jobId, filePath) {
  const timer = setTimeout(async () => { await removeFile(filePath); jobs.delete(jobId); }, fileTtlMs);
  timer.unref();
}

async function inspectVideo(targetUrl) {
  const { stdout } = await run("yt-dlp", ["--dump-single-json", "--no-playlist", "--no-warnings", targetUrl]);
  return JSON.parse(stdout);
}

async function createDownload(jobId, targetUrl, requestedHeight) {
  const job = jobs.get(jobId);
  try {
    const height = Math.min(Math.max(Number(requestedHeight) || 1080, 144), 2160);
    const outputTemplate = path.join(tempDir, `${jobId}.%(ext)s`);
    const format = [`bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`, `bv*[height<=${height}]+ba`, `b[height<=${height}]`, "b"].join("/");
    
    await run("yt-dlp", ["--no-playlist", "--no-part", "--restrict-filenames", "--format", format, "--merge-output-format", "mp4", "--remux-video", "mp4", "--output", outputTemplate, targetUrl]);
    
    const candidates = await fsp.readdir(tempDir);
    const generatedName = candidates.find((name) => name.startsWith(`${jobId}.`) && !name.endsWith(".part"));
    if (!generatedName) throw new Error("File hasil pemrosesan tidak ditemukan.");
    
    const filePath = path.join(tempDir, generatedName);
    const stats = await fsp.stat(filePath);
    
    job.status = "ready"; 
    job.filePath = filePath; 
    job.size = stats.size; 
    job.expiresAt = Date.now() + fileTtlMs;
    scheduleDeletion(jobId, filePath);
  } catch (error) {
    job.status = "failed"; 
    job.error = "Video tidak dapat diproses. Pastikan URL dapat diakses dan yt-dlp/FFmpeg terpasang."; 
    console.error(error.message);
  } finally { 
    activeDownloads -= 1; 
  }
}

/* =========================
   ROUTES & ENDPOINTS
========================= */

// Rute Halaman Utama (Mencegah eror "Cannot GET /")
app.get("/", (req, res) => {
  const indexPath = path.join(publicPath, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.send("<h1>Universal Video Downloader API</h1><p>Server aktif. Gunakan endpoint API untuk memproses unduhan.</p>");
});

// Endpoint untuk cek info/metadata video
app.post("/api/info", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!isValidUrl(url)) return res.status(400).json({ error: "URL tidak valid." });
  
  try {
    const info = await inspectVideo(url);
    if (info.is_live) return res.status(400).json({ error: "Siaran langsung yang belum selesai tidak didukung." });
    if (info.duration && info.duration > maxVideoDuration) return res.status(413).json({ error: `Durasi video melebihi batas ${Math.round(maxVideoDuration / 60)} menit.` });
    
    return res.json(publicVideoInfo(info));
  } catch (error) { 
    console.error(error.message); 
    return res.status(422).json({ error: "Informasi video tidak dapat diambil. Video mungkin privat, dibatasi, atau tidak tersedia." }); 
  }
});

// Endpoint untuk memulai unduhan (menerima `url` dan `height`)
app.post("/api/download", (req, res) => {
  if (activeDownloads >= maxConcurrentDownloads) return res.status(429).json({ error: "Server sedang sibuk. Coba lagi setelah proses lain selesai." });
  
  const url = String(req.body?.url || "").trim();
  const height = Number(req.body?.height || 1080);
  
  if (!isValidUrl(url)) return res.status(400).json({ error: "URL tidak valid." });
  
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "processing", url, createdAt: Date.now(), filePath: null });
  
  activeDownloads += 1; 
  void createDownload(jobId, url, height);
  
  return res.status(202).json({ jobId });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Proses tidak ditemukan atau file sudah dihapus." });
  
  return res.json({ 
    status: job.status, 
    size: job.size || null, 
    expiresAt: job.expiresAt || null, 
    error: job.error || null, 
    downloadUrl: job.status === "ready" ? `/api/jobs/${req.params.jobId}/file` : null 
  });
});

app.get("/api/jobs/:jobId/file", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "ready" || !job.filePath) return res.status(404).json({ error: "File belum siap atau sudah dihapus." });
  if (!fs.existsSync(job.filePath)) { jobs.delete(req.params.jobId); return res.status(410).json({ error: "File sudah kedaluwarsa." }); }
  
  res.setHeader("Cache-Control", "private, no-store");
  res.download(job.filePath, "video.mp4", async (error) => { 
    if (error && !res.headersSent) res.status(500).json({ error: "Pengiriman file gagal." }); 
    await removeFile(job.filePath); 
    jobs.delete(req.params.jobId); 
  });
});

/* =========================
   CLEANUP & START SERVER
========================= */

setInterval(async () => { 
  const now = Date.now(); 
  for (const [jobId, job] of jobs) {
    if (now - job.createdAt > fileTtlMs || (job.expiresAt && now > job.expiresAt)) { 
      await removeFile(job.filePath); 
      jobs.delete(jobId); 
    } 
  }
}, 5 * 60 * 1000).unref();

async function start() { 
  await fsp.mkdir(tempDir, { recursive: true }); 
  app.listen(port, "0.0.0.0", () => console.log(`Server aktif di http://localhost:${port}`)); 
}

start().catch((error) => { 
  console.error(error); 
  process.exit(1); 
});
