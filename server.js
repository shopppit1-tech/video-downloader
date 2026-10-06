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

app.disable("x-powered-by");

/*
 * Render berada di belakang reverse proxy.
 * Ini wajib agar express-rate-limit tidak error
 * karena X-Forwarded-For.
 */
app.set("trust proxy", 1);

app.use(express.json({ limit: "10kb" }));

app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* =========================
   YOUTUBE URL
========================= */

function extractYouTubeId(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return /^[\w-]{11}$/.test(id) ? id : null;
  }

  if (
    ![
      "youtube.com",
      "m.youtube.com",
      "music.youtube.com",
    ].includes(host)
  ) {
    return null;
  }

  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");

    return id && /^[\w-]{11}$/.test(id)
      ? id
      : null;
  }

  const match = url.pathname.match(
    /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/
  );

  return match ? match[1] : null;
}

function youtubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/* =========================
   COMMAND RUNNER
========================= */

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
    });

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
          stderr,
        });
      } else {
        reject(
          new Error(
            `${command} berhenti dengan kode ${code}: ${stderr.slice(
              -4000
            )}`
          )
        );
      }
    });
  });
}

/* =========================
   COOKIES
========================= */

async function setupCookies() {
  const cookies = String(
    process.env.YOUTUBE_COOKIES || ""
  ).trim();

  if (!cookies) {
    return null;
  }

  const cookieFile = path.join(
    tempDir,
    "youtube-cookies.txt"
  );

  await fsp.writeFile(
    cookieFile,
    cookies,
    "utf8"
  );

  return cookieFile;
}

/* =========================
   YT-DLP BASE ARGS
========================= */

async function baseYtDlpArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",

    /*
     * YouTube sekarang membutuhkan JS runtime
     * untuk beberapa extraction flow.
     */
    "--js-runtimes",
    "node",

    /*
     * Ambil EJS dari GitHub.
     */
    "--remote-components",
    "ejs:github",
  ];

  const cookieFile = await setupCookies();

  /*
   * Jika cookies tersedia, gunakan player client
   * yang menghindari masalah tv_downgraded.
   */
  if (cookieFile) {
    args.push(
      "--cookies",
      cookieFile,
      "--extractor-args",
      "youtube:player_client=default,web_embedded"
    );
  }

  if (process.env.YOUTUBE_USER_AGENT) {
    args.push(
      "--user-agent",
      process.env.YOUTUBE_USER_AGENT
    );
  }

  return args;
}

/* =========================
   PUBLIC VIDEO INFO
========================= */

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
        .map((f) => f.height)
    ),
  ]
    .sort((a, b) => b - a)
    .slice(0, 12);

  return {
    id: info.id,
    title: info.title || "video",
    thumbnail: info.thumbnail || null,
    duration: Number(info.duration || 0),
    uploader: info.uploader || null,
    heights,
    hasAudio: formats.some(
      (f) =>
        f.acodec &&
        f.acodec !== "none"
    ),
  };
}

/* =========================
   FILE CLEANUP
========================= */

async function removeFile(filePath) {
  if (!filePath) return;

  await fsp
    .rm(filePath, {
      force: true,
    })
    .catch((error) => {
      console.error(
        "Gagal menghapus file:",
        error.message
      );
    });
}

function scheduleDeletion(jobId, filePath) {
  const timer = setTimeout(async () => {
    await removeFile(filePath);
    jobs.delete(jobId);
  }, fileTtlMs);

  timer.unref();
}

/* =========================
   VIDEO INFO
========================= */

async function inspectVideo(videoId) {
  const baseArgs = await baseYtDlpArgs();

  const args = [
    ...baseArgs,
    "--dump-single-json",
    youtubeUrl(videoId),
  ];

  const { stdout } = await run(
    "yt-dlp",
    args
  );

  return JSON.parse(stdout);
}

/* =========================
   DOWNLOAD
========================= */

async function createDownload(
  jobId,
  videoId,
  requestedHeight
) {
  const job = jobs.get(jobId);

  try {
    const height = Math.min(
      Math.max(
        Number(requestedHeight) || 1080,
        144
      ),
      2160
    );

    const outputTemplate = path.join(
      tempDir,
      `${jobId}.%(ext)s`
    );

    const format = [
      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
      `bv*[height<=${height}]+ba`,
      `b[height<=${height}]`,
      "b",
    ].join("/");

    const baseArgs = await baseYtDlpArgs();

    const args = [
      ...baseArgs,

      "--no-part",
      "--restrict-filenames",

      "--format",
      format,

      "--merge-output-format",
      "mp4",

      "--remux-video",
      "mp4",

      "--output",
      outputTemplate,

      youtubeUrl(videoId),
    ];

    await run(
      "yt-dlp",
      args
    );

    const candidates =
      await fsp.readdir(tempDir);

    const generatedName =
      candidates.find(
        (name) =>
          name.startsWith(`${jobId}.`) &&
          !name.endsWith(".part")
      );

    if (!generatedName) {
      throw new Error(
        "File hasil pemrosesan tidak ditemukan."
      );
    }

    const filePath = path.join(
      tempDir,
      generatedName
    );

    const stats =
      await fsp.stat(filePath);

    job.status = "ready";
    job.filePath = filePath;
    job.size = stats.size;
    job.expiresAt =
      Date.now() + fileTtlMs;

    scheduleDeletion(
      jobId,
      filePath
    );
  } catch (error) {
    job.status = "failed";

    job.error =
      "Video tidak dapat diproses. Pastikan URL dapat diakses dan yt-dlp/FFmpeg terpasang.";

    console.error(
      `[${videoId}] ${error.message}`
    );
  } finally {
    activeDownloads -= 1;
  }
}

/* =========================
   API INFO
========================= */

app.post(
  "/api/info",
  async (req, res) => {
    const videoId =
      extractYouTubeId(
        String(
          req.body?.url || ""
        ).trim()
      );

    if (!videoId) {
      return res.status(400).json({
        error:
          "URL YouTube tidak valid.",
      });
    }

    console.log(
      `REQUEST: ${videoId}`
    );

    try {
      const info =
        await inspectVideo(videoId);

      if (info.is_live) {
        return res.status(400).json({
          error:
            "Siaran langsung yang belum selesai tidak didukung.",
        });
      }

      if (
        info.duration &&
        info.duration >
          maxVideoDuration
      ) {
        return res.status(413).json({
          error: `Durasi video melebihi batas ${Math.round(
            maxVideoDuration / 60
          )} menit.`,
        });
      }

      return res.json(
        publicVideoInfo(info)
      );
    } catch (error) {
      console.error(
        `ERROR [${videoId}]: ${error.message}`
      );

      return res.status(422).json({
        error:
          "Informasi video tidak dapat diambil. Video mungkin privat, dibatasi, atau tidak tersedia.",
      });
    }
  }
);

/* =========================
   API DOWNLOAD
========================= */

app.post(
  "/api/download",
  (req, res) => {
    if (
      activeDownloads >=
      maxConcurrentDownloads
    ) {
      return res.status(429).json({
        error:
          "Server sedang sibuk. Coba lagi setelah proses lain selesai.",
      });
    }

    const videoId =
      String(
        req.body?.videoId || ""
      );

    const height =
      Number(
        req.body?.height || 1080
      );

    if (
      !/^[\w-]{11}$/.test(
        videoId
      )
    ) {
      return res.status(400).json({
        error:
          "ID video tidak valid.",
      });
    }

    const jobId =
      crypto.randomUUID();

    jobs.set(jobId, {
      status: "processing",
      videoId,
      createdAt: Date.now(),
      filePath: null,
    });

    activeDownloads += 1;

    void createDownload(
      jobId,
      videoId,
      height
    );

    return res.status(202).json({
      jobId,
    });
  }
);

/* =========================
   API JOB STATUS
========================= */

app.get(
  "/api/jobs/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        error:
          "Proses tidak ditemukan atau file sudah dihapus.",
      });
    }

    return res.json({
      status: job.status,
      size: job.size || null,
      expiresAt:
        job.expiresAt || null,
      error:
        job.error || null,
      downloadUrl:
        job.status === "ready"
          ? `/api/jobs/${req.params.jobId}/file`
          : null,
    });
  }
);

/* =========================
   FILE DOWNLOAD
========================= */

app.get(
  "/api/jobs/:jobId/file",
  async (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (
      !job ||
      job.status !== "ready" ||
      !job.filePath
    ) {
      return res.status(404).json({
        error:
          "File belum siap atau sudah dihapus.",
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

      return res.status(410).json({
        error:
          "File sudah kedaluwarsa.",
      });
    }

    res.setHeader(
      "Cache-Control",
      "private, no-store"
    );

    res.download(
      job.filePath,
      "video.mp4",
      async (error) => {
        if (
          error &&
          !res.headersSent
        ) {
          res.status(500).json({
            error:
              "Pengiriman file gagal.",
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

/* =========================
   PERIODIC CLEANUP
========================= */

setInterval(
  async () => {
    const now =
      Date.now();

    for (
      const [jobId, job]
      of jobs
    ) {
      if (
        now - job.createdAt >
          fileTtlMs ||
        (
          job.expiresAt &&
          now > job.expiresAt
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

/* =========================
   START SERVER
========================= */

async function start() {
  await fsp.mkdir(
    tempDir,
    {
      recursive: true,
    }
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
    console.error(error);
    process.exit(1);
  }
);
