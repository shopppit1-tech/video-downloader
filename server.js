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

const fileTtlMs =
  Number(process.env.FILE_TTL_MINUTES || 30) * 60 * 1000;

const maxConcurrentDownloads =
  Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2);

const maxVideoDuration =
  Number(process.env.MAX_VIDEO_DURATION_SECONDS || 7200);

const tempDir = path.join(__dirname, "temp");

const jobs = new Map();

let activeDownloads = 0;

/* =====================================================
   APP
===================================================== */

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "10kb"
  })
);

/* =====================================================
   STATIC FILES
===================================================== */

const publicPath = path.join(__dirname, "public");

app.use(
  express.static(publicPath, {
    index: "index.html",
    extensions: ["html"]
  })
);

/* =====================================================
   RATE LIMIT
===================================================== */

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,

    handler: (req, res) => {
      return res.status(429).json({
        error:
          "Terlalu banyak permintaan. Tunggu beberapa menit lalu coba lagi."
      });
    }
  })
);

/* =====================================================
   HELPER
===================================================== */

function isValidUrl(input) {
  try {
    const url = new URL(input);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

/* =====================================================
   DETECT PLATFORM
===================================================== */

function detectPlatform(input) {
  try {
    const url = new URL(input);

    const host = url.hostname
      .toLowerCase()
      .replace(/^www\./, "");

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtu.be"
    ) {
      return "youtube";
    }

    if (
      host === "facebook.com" ||
      host === "m.facebook.com" ||
      host === "mbasic.facebook.com" ||
      host === "web.facebook.com" ||
      host === "fb.watch"
    ) {
      return "facebook";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

/* =====================================================
   YOUTUBE COOKIE
===================================================== */

function getYoutubeCookieFile() {
  const configured =
    process.env.YOUTUBE_COOKIES_FILE ||
    "/etc/secrets/youtube-cookies.txt";

  try {
    if (fs.existsSync(configured)) {
      return configured;
    }
  } catch {}

  return null;
}

/* =====================================================
   BUILD YT-DLP ARGUMENTS
===================================================== */

function buildBaseYtDlpArgs(targetUrl) {
  const platform = detectPlatform(targetUrl);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--ignore-config",
    "--no-check-certificates",
    "--geo-bypass",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--file-access-retries",
    "3",
    "--extractor-retries",
    "3"
  ];

  /*
   * COOKIE HANYA UNTUK YOUTUBE
   */
  if (platform === "youtube") {
    const cookieFile = getYoutubeCookieFile();

    if (cookieFile) {
      args.push(
        "--cookies",
        cookieFile
      );
    }
  }

  return args;
}

/* =====================================================
   RUN COMMAND
===================================================== */

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      args,
      {
        windowsHide: true,
        ...options
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `${command} tidak tersedia: ${error.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });

        return;
      }

      reject(
        new Error(
          `${command} berhenti dengan kode ${code}: ${stderr.slice(
            -5000
          )}`
        )
      );
    });
  });
}

/* =====================================================
   PUBLIC VIDEO INFO
===================================================== */

function publicVideoInfo(info) {
  const formats = Array.isArray(info.formats)
    ? info.formats
    : [];

  const heights = [
    ...new Set(
      formats
        .filter(
          (f) =>
            f.vcodec &&
            f.vcodec !== "none" &&
            Number.isFinite(f.height)
        )
        .map((f) => Number(f.height))
    )
  ]
    .filter((height) => height > 0)
    .sort((a, b) => b - a)
    .slice(0, 12);

  return {
    id: info.id || null,

    title:
      info.title ||
      "video",

    thumbnail:
      info.thumbnail ||
      null,

    duration:
      Number(info.duration || 0),

    uploader:
      info.uploader ||
      info.channel ||
      info.extractor_key ||
      null,

    heights,

    hasAudio:
      formats.some(
        (f) =>
          f.acodec &&
          f.acodec !== "none"
      )
  };
}

/* =====================================================
   FILE
===================================================== */

async function removeFile(filePath) {
  if (!filePath) {
    return;
  }

  await fsp
    .rm(filePath, {
      force: true
    })
    .catch((error) => {
      console.error(
        "Gagal menghapus file:",
        error.message
      );
    });
}

/* =====================================================
   DELETE JOB
===================================================== */

function scheduleDeletion(jobId, filePath) {
  const timer = setTimeout(
    async () => {
      await removeFile(filePath);

      jobs.delete(jobId);
    },
    fileTtlMs
  );

  timer.unref();
}

/* =====================================================
   INSPECT VIDEO
===================================================== */

async function inspectVideo(targetUrl) {
  const args = buildBaseYtDlpArgs(
    targetUrl
  );

  args.push(
    "--dump-single-json",
    targetUrl
  );

  const result = await run(
    "yt-dlp",
    args
  );

  return JSON.parse(
    result.stdout
  );
}

/* =====================================================
   FIND SOURCE FILE
===================================================== */

async function findSourceFile(jobId) {
  const files = await fsp.readdir(
    tempDir
  );

  const prefix =
    `${jobId}.source.`;

  const candidates =
    files.filter(
      (name) =>
        name.startsWith(prefix) &&
        !name.endsWith(".part") &&
        !name.endsWith(".ytdl")
    );

  if (!candidates.length) {
    return null;
  }

  /*
   * Pilih file terbesar.
   * Ini membantu jika ada file sementara
   * yang tertinggal.
   */

  let selected = null;
  let selectedSize = -1;

  for (const name of candidates) {
    try {
      const fullPath =
        path.join(
          tempDir,
          name
        );

      const stat =
        await fsp.stat(
          fullPath
        );

      if (
        stat.isFile() &&
        stat.size > selectedSize
      ) {
        selected = fullPath;
        selectedSize = stat.size;
      }
    } catch {}
  }

  return selected;
}

/* =====================================================
   FFMPEG CONVERT
===================================================== */

async function convertToAndroidMp4(
  sourcePath,
  outputPath
) {
  const args = [
    "-y",

    "-hide_banner",

    "-loglevel",
    "error",

    "-i",
    sourcePath,

    /*
     * Video
     */
    "-map",
    "0:v:0",

    /*
     * Audio jika tersedia
     */
    "-map",
    "0:a:0?",

    /*
     * Android-compatible H.264
     */
    "-c:v",
    "libx264",

    "-preset",
    process.env.FFMPEG_PRESET ||
      "veryfast",

    "-crf",
    process.env.FFMPEG_CRF ||
      "23",

    "-pix_fmt",
    "yuv420p",

    /*
     * Audio AAC
     */
    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-ar",
    "48000",

    /*
     * MP4 streaming/fast start
     */
    "-movflags",
    "+faststart",

    /*
     * Hindari masalah timestamp
     */
    "-vsync",
    "cfr",

    outputPath
  ];

  await run(
    "ffmpeg",
    args
  );
}

/* =====================================================
   CREATE DOWNLOAD
===================================================== */

async function createDownload(
  jobId,
  targetUrl,
  requestedHeight
) {
  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  try {
    const height = Math.min(
      Math.max(
        Number(requestedHeight) ||
          720,
        144
      ),
      2160
    );

    /*
     * File sumber.
     */
    const sourceTemplate =
      path.join(
        tempDir,
        `${jobId}.source.%(ext)s`
      );

    /*
     * File hasil final.
     */
    const finalPath =
      path.join(
        tempDir,
        `${jobId}.mp4`
      );

    const platform =
      detectPlatform(
        targetUrl
      );

    /*
     * Ambil format video + audio.
     *
     * Prioritas:
     * H.264 / AVC
     * AAC
     *
     * Jika H.264 tidak tersedia,
     * fallback ke format terbaik.
     */
    const format =
      [
        `bv*[height<=${height}]+ba/b[height<=${height}]`,
        `bv*[height<=${height}]/b[height<=${height}]`,
        "b"
      ].join("/");

    const args =
      buildBaseYtDlpArgs(
        targetUrl
      );

    args.push(
      "--format",
      format,

      /*
       * Prioritaskan codec yang
       * kompatibel dengan Android.
       *
       * yt-dlp mendukung format sorting
       * berdasarkan vcodec/acodec.
       */
      "--format-sort",
      "vcodec:h264,res,fps,acodec:aac",

      /*
       * Jangan pilih HDR jika tidak perlu.
       */
      "--format-sort-force",

      /*
       * Jika video + audio terpisah,
       * gabungkan sementara sebagai MKV.
       * Nanti kita encode ulang ke MP4.
       */
      "--merge-output-format",
      "mkv",

      "--no-part",

      "--restrict-filenames",

      "--output",
      sourceTemplate,

      targetUrl
    );

    console.log(
      `[DOWNLOAD] ${platform} ${targetUrl}`
    );

    console.log(
      `[DOWNLOAD] target height: ${height}`
    );

    /*
     * Download sumber.
     */
    await run(
      "yt-dlp",
      args
    );

    /*
     * Cari hasil sumber.
     */
    const sourcePath =
      await findSourceFile(
        jobId
      );

    if (!sourcePath) {
      throw new Error(
        "File sumber hasil yt-dlp tidak ditemukan."
      );
    }

    console.log(
      `[FFMPEG] Converting ${sourcePath} -> ${finalPath}`
    );

    /*
     * Encode ulang agar:
     *
     * H.264
     * AAC
     * yuv420p
     * MP4
     * faststart
     *
     * kompatibel dengan
     * mayoritas Galeri Android.
     */
    await convertToAndroidMp4(
      sourcePath,
      finalPath
    );

    /*
     * Hapus source setelah
     * conversion sukses.
     */
    await removeFile(
      sourcePath
    );

    /*
     * Pastikan final benar-benar ada.
     */
    if (
      !fs.existsSync(
        finalPath
      )
    ) {
      throw new Error(
        "File MP4 final tidak ditemukan."
      );
    }

    const stats =
      await fsp.stat(
        finalPath
      );

    if (stats.size < 10000) {
      throw new Error(
        "File MP4 hasil terlalu kecil atau rusak."
      );
    }

    /*
     * Validasi menggunakan ffprobe.
     */
    try {
      const probe =
        await run(
          "ffprobe",
          [
            "-v",
            "error",

            "-select_streams",
            "v:0",

            "-show_entries",
            "stream=codec_name,width,height,pix_fmt",

            "-of",
            "json",

            finalPath
          ]
        );

      console.log(
        "[FFPROBE]",
        probe.stdout
      );
    } catch (probeError) {
      console.error(
        "[FFPROBE] gagal:",
        probeError.message
      );
    }

    job.status =
      "ready";

    job.filePath =
      finalPath;

    job.size =
      stats.size;

    job.expiresAt =
      Date.now() +
      fileTtlMs;

    scheduleDeletion(
      jobId,
      finalPath
    );

    console.log(
      `[SUCCESS] ${jobId} ${stats.size} bytes`
    );
  } catch (error) {
    job.status =
      "failed";

    job.error =
      "Video tidak dapat diproses. Coba video lain atau ulangi beberapa saat lagi.";

    console.error(
      `[FAILED] ${jobId}`
    );

    console.error(
      error.message
    );
  } finally {
    activeDownloads -= 1;
  }
}

/* =====================================================
   HOME
===================================================== */

app.get(
  "/",
  (req, res) => {
    const indexPath =
      path.join(
        publicPath,
        "index.html"
      );

    if (
      fs.existsSync(
        indexPath
      )
    ) {
      return res.sendFile(
        indexPath
      );
    }

    res.send(
      `
      <h1>Video Fetch API</h1>
      <p>Server aktif.</p>
      `
    );
  }
);

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      activeDownloads,
      maxConcurrentDownloads,
      uptime: process.uptime()
    });
  }
);

/* =====================================================
   VIDEO INFO
===================================================== */

app.post(
  "/api/info",
  async (req, res) => {
    const url =
      String(
        req.body?.url || ""
      ).trim();

    if (
      !isValidUrl(url)
    ) {
      return res
        .status(400)
        .json({
          error:
            "URL tidak valid."
        });
    }

    const platform =
      detectPlatform(url);

    if (
      platform === "unknown"
    ) {
      return res
        .status(400)
        .json({
          error:
            "URL YouTube atau Facebook tidak dikenali."
        });
    }

    try {
      console.log(
        `[INFO] ${platform}: ${url}`
      );

      const info =
        await inspectVideo(
          url
        );

      if (
        info.is_live
      ) {
        return res
          .status(400)
          .json({
            error:
              "Siaran langsung yang belum selesai tidak didukung."
          });
      }

      if (
        info.duration &&
        info.duration >
          maxVideoDuration
      ) {
        return res
          .status(413)
          .json({
            error:
              `Durasi video melebihi batas ${Math.round(
                maxVideoDuration / 60
              )} menit.`
          });
      }

      return res.json({
        ...publicVideoInfo(
          info
        ),

        platform
      });
    } catch (error) {
      console.error(
        `[INFO FAILED] ${platform}`
      );

      console.error(
        error.message
      );

      return res
        .status(422)
        .json({
          error:
            "Informasi video tidak dapat diambil. Video mungkin privat, dibatasi, atau YouTube/Facebook sedang menolak permintaan server."
        });
    }
  }
);

/* =====================================================
   START DOWNLOAD
===================================================== */

app.post(
  "/api/download",
  (req, res) => {
    if (
      activeDownloads >=
      maxConcurrentDownloads
    ) {
      return res
        .status(429)
        .json({
          error:
            "Server sedang sibuk. Coba lagi setelah proses lain selesai."
        });
    }

    const url =
      String(
        req.body?.url || ""
      ).trim();

    const height =
      Number(
        req.body?.height ||
          720
      );

    if (
      !isValidUrl(url)
    ) {
      return res
        .status(400)
        .json({
          error:
            "URL tidak valid."
        });
    }

    const platform =
      detectPlatform(url);

    if (
      platform === "unknown"
    ) {
      return res
        .status(400)
        .json({
          error:
            "URL YouTube atau Facebook tidak dikenali."
        });
    }

    const jobId =
      crypto.randomUUID();

    jobs.set(
      jobId,
      {
        status:
          "processing",

        url,

        platform,

        height,

        createdAt:
          Date.now(),

        filePath:
          null,

        size:
          null,

        expiresAt:
          null,

        error:
          null
      }
    );

    activeDownloads += 1;

    void createDownload(
      jobId,
      url,
      height
    );

    return res
      .status(202)
      .json({
        jobId
      });
  }
);

/* =====================================================
   JOB STATUS
===================================================== */

app.get(
  "/api/jobs/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Proses tidak ditemukan atau file sudah dihapus."
        });
    }

    return res.json({
      status:
        job.status,

      size:
        job.size ||
        null,

      expiresAt:
        job.expiresAt ||
        null,

      error:
        job.error ||
        null,

      platform:
        job.platform ||
        null,

      downloadUrl:
        job.status ===
        "ready"
          ? `/api/jobs/${req.params.jobId}/file`
          : null
    });
  }
);

/* =====================================================
   DOWNLOAD FILE
===================================================== */

app.get(
  "/api/jobs/:jobId/file",
  async (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (
      !job ||
      job.status !==
        "ready" ||
      !job.filePath
    ) {
      return res
        .status(404)
        .json({
          error:
            "File belum siap atau sudah dihapus."
        });
    }

    if (
      !fs.existsSync(
        job.filePath
      )
    ) {
      jobs.delete(
        req.params.jobId
      );

      return res
        .status(410)
        .json({
          error:
            "File sudah kedaluwarsa."
        });
    }

    res.setHeader(
      "Cache-Control",
      "private, no-store"
    );

    res.setHeader(
      "Content-Type",
      "video/mp4"
    );

    res.download(
      job.filePath,
      "video.mp4",
      async (error) => {
        if (
          error &&
          !res.headersSent
        ) {
          res
            .status(500)
            .json({
              error:
                "Pengiriman file gagal."
            });
        }

        await removeFile(
          job.filePath
        );

        jobs.delete(
          req.params.jobId
        );
      }
    );
  }
);

/* =====================================================
   CLEANUP
===================================================== */

setInterval(
  async () => {
    const now =
      Date.now();

    for (
      const [
        jobId,
        job
      ] of jobs
    ) {
      if (
        now -
          job.createdAt >
          fileTtlMs ||
        (
          job.expiresAt &&
          now >
            job.expiresAt
        )
      ) {
        await removeFile(
          job.filePath
        );

        jobs.delete(
          jobId
        );
      }
    }
  },
  5 * 60 * 1000
).unref();

/* =====================================================
   START SERVER
===================================================== */

async function start() {
  await fsp.mkdir(
    tempDir,
    {
      recursive: true
    }
  );

  /*
   * Cek dependency saat startup.
   */
  try {
    const version =
      await run(
        "yt-dlp",
        ["--version"]
      );

    console.log(
      `yt-dlp version: ${version.stdout.trim()}`
    );
  } catch (error) {
    console.error(
      "yt-dlp tidak tersedia:",
      error.message
    );
  }

  try {
    const version =
      await run(
        "ffmpeg",
        ["-version"]
      );

    console.log(
      "FFmpeg tersedia."
    );
  } catch (error) {
    console.error(
      "FFmpeg tidak tersedia:",
      error.message
    );
  }

  const cookieFile =
    getYoutubeCookieFile();

  console.log(
    "YouTube cookies:",
    cookieFile
      ? "TERDETEKSI"
      : "TIDAK ADA"
  );

  app.listen(
    port,
    "0.0.0.0",
    () => {
      console.log(
        `Server aktif di port ${port}`
      );
    }
  );
}

start().catch(
  (error) => {
    console.error(
      error
    );

    process.exit(1);
  }
);
