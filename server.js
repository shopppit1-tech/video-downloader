"use strict";

require("dotenv").config();

const express = require("express");
const rateLimit = require("express-rate-limit");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const FILE_TTL_MINUTES = positiveNumber(
  process.env.FILE_TTL_MINUTES,
  30
);

const FILE_TTL_MS = FILE_TTL_MINUTES * 60 * 1000;

const MAX_CONCURRENT_DOWNLOADS = positiveNumber(
  process.env.MAX_CONCURRENT_DOWNLOADS,
  2
);

const MAX_VIDEO_DURATION_SECONDS = positiveNumber(
  process.env.MAX_VIDEO_DURATION_SECONDS,
  7200
);

const YTDLP_TIMEOUT_MS =
  positiveNumber(process.env.YTDLP_TIMEOUT_SECONDS, 900) * 1000;

const TEMP_DIR = path.join(os.tmpdir(), "video-downloader");
const APP_DIR = __dirname;

const JOBS = new Map();

let activeDownloads = 0;
let cookieFilePromise = null;

/* =========================================================
   UTIL
========================================================= */

function positiveNumber(value, fallback) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

/* =========================================================
   EXPRESS
========================================================= */

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "10kb",
  })
);

app.use(
  express.static(
    path.join(APP_DIR, "public")
  )
);

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* =========================================================
   YOUTUBE URL
========================================================= */

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

    return /^[\w-]{11}$/.test(id)
      ? id
      : null;
  }

  const allowedHosts = [
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
  ];

  if (!allowedHosts.includes(host)) {
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

/* =========================================================
   PROCESS RUNNER
========================================================= */

function appendLimited(
  current,
  chunk,
  maxLength = 2_000_000
) {
  const next = current + chunk.toString();

  return next.length > maxLength
    ? next.slice(-maxLength)
    : next;
}

function run(
  command,
  args,
  timeoutMs = YTDLP_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    });

    const timeout = setTimeout(() => {
      timedOut = true;

      child.kill("SIGTERM");

      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);

      killTimer.unref();
    }, timeoutMs);

    timeout.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(
        stdout,
        chunk
      );
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(
        stderr,
        chunk
      );
    });

    child.on("error", (error) => {
      if (settled) return;

      settled = true;

      clearTimeout(timeout);

      if (killTimer) {
        clearTimeout(killTimer);
      }

      reject(
        new Error(
          `${command} tidak dapat dijalankan: ${error.message}`
        )
      );
    });

    child.on("close", (code, signal) => {
      if (settled) return;

      settled = true;

      clearTimeout(timeout);

      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (timedOut) {
        reject(
          new Error(
            `yt-dlp melewati batas waktu ${Math.round(
              timeoutMs / 1000
            )} detik.`
          )
        );

        return;
      }

      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });

        return;
      }

      reject(
        new Error(
          `${command} berhenti dengan kode ${code}${
            signal ? ` (${signal})` : ""
          }: ${stderr.slice(-5000)}`
        )
      );
    });
  });
}

/* =========================================================
   COOKIE VALIDATION
========================================================= */

function looksLikeNetscapeCookieFile(text) {
  if (!text || !text.trim()) {
    return false;
  }

  const lines = text.split(/\r?\n/);

  let validCookieLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const parts = line.split("\t");

    if (parts.length < 7) {
      continue;
    }

    const domain = parts[0];
    const includeSubdomains = parts[1];
    const cookiePath = parts[2];
    const secure = parts[3];
    const expiry = parts[4];
    const name = parts[5];

    if (
      domain &&
      (includeSubdomains === "TRUE" ||
        includeSubdomains === "FALSE") &&
      cookiePath &&
      (secure === "TRUE" ||
        secure === "FALSE") &&
      /^\d+$/.test(expiry) &&
      name
    ) {
      validCookieLines++;
    }
  }

  return validCookieLines > 0;
}

async function validateCookieFile(filePath) {
  let text;

  try {
    text = await fsp.readFile(
      filePath,
      "utf8"
    );
  } catch {
    return {
      ok: false,
      reason: "file tidak dapat dibaca",
    };
  }

  if (!looksLikeNetscapeCookieFile(text)) {
    return {
      ok: false,
      reason:
        "isi file bukan format Netscape cookie yang valid",
    };
  }

  return {
    ok: true,
  };
}

/* =========================================================
   COOKIE
   Render Secret File = READ ONLY.
   Jadi Secret File SELALU disalin ke /tmp.
========================================================= */

async function getCookieFile() {
  if (cookieFilePromise) {
    return cookieFilePromise;
  }

  cookieFilePromise = (async () => {
    await fsp.mkdir(
      TEMP_DIR,
      {
        recursive: true,
        mode: 0o700,
      }
    );

    const configuredPath =
      String(
        process.env.YOUTUBE_COOKIES_FILE || ""
      ).trim();

    const candidates = [
      configuredPath,
      "/etc/secrets/youtube-cookies.txt",
    ].filter(Boolean);

    const uniqueCandidates = [
      ...new Set(candidates),
    ];

    /*
      Cari Secret File Render.
    */

    for (const candidate of uniqueCandidates) {
      const sourcePath =
        path.resolve(candidate);

      try {
        const stat =
          await fsp.stat(sourcePath);

        if (!stat.isFile()) {
          continue;
        }

        const validation =
          await validateCookieFile(
            sourcePath
          );

        if (!validation.ok) {
          console.error(
            `Cookie ditemukan tetapi tidak valid: ${sourcePath}`
          );

          continue;
        }

        /*
          PENTING:
          Jangan berikan /etc/secrets langsung
          kepada yt-dlp karena read-only.

          Salin dulu ke /tmp.
        */

        const runtimeCookieFile =
          path.join(
            TEMP_DIR,
            "youtube-cookies-runtime.txt"
          );

        await fsp.copyFile(
          sourcePath,
          runtimeCookieFile
        );

        await fsp.chmod(
          runtimeCookieFile,
          0o600
        ).catch(() => {});

        const runtimeValidation =
          await validateCookieFile(
            runtimeCookieFile
          );

        if (!runtimeValidation.ok) {
          throw new Error(
            "Salinan cookie runtime tidak valid."
          );
        }

        console.log(
          "Cookie YouTube: valid"
        );

        console.log(
          "Cookie YouTube: disalin ke /tmp agar dapat ditulis yt-dlp"
        );

        return runtimeCookieFile;
      } catch (error) {
        if (
          error.message ===
          "Salinan cookie runtime tidak valid."
        ) {
          throw error;
        }
      }
    }

    /*
      Fallback:
      YOUTUBE_COOKIES langsung dari environment.
    */

    const cookieText =
      String(
        process.env.YOUTUBE_COOKIES || ""
      ).trim();

    if (cookieText) {
      if (
        !looksLikeNetscapeCookieFile(
          cookieText
        )
      ) {
        throw new Error(
          "YOUTUBE_COOKIES bukan format Netscape yang valid."
        );
      }

      const runtimeCookieFile =
        path.join(
          TEMP_DIR,
          "youtube-cookies-runtime.txt"
        );

      await fsp.writeFile(
        runtimeCookieFile,
        `${cookieText}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        }
      );

      await fsp.chmod(
        runtimeCookieFile,
        0o600
      ).catch(() => {});

      console.log(
        "Cookie YouTube: valid dari environment"
      );

      return runtimeCookieFile;
    }

    throw new Error(
      "Cookie YouTube tidak ditemukan. Pastikan Secret File youtube-cookies.txt tersedia."
    );
  })();

  try {
    return await cookieFilePromise;
  } catch (error) {
    cookieFilePromise = null;
    throw error;
  }
}

/* =========================================================
   YT-DLP
========================================================= */

async function baseYtDlpArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
  ];

  const cookieFile =
    await getCookieFile();

  if (cookieFile) {
    args.push(
      "--cookies",
      cookieFile
    );
  }

  const userAgent =
    String(
      process.env.YOUTUBE_USER_AGENT || ""
    ).trim();

  if (userAgent) {
    args.push(
      "--user-agent",
      userAgent
    );
  }

  return args;
}

/* =========================================================
   VIDEO INFO
========================================================= */

function publicVideoInfo(info) {
  const formats =
    Array.isArray(info.formats)
      ? info.formats
      : [];

  const heights = [
    ...new Set(
      formats
        .filter(
          (format) =>
            format.vcodec &&
            format.vcodec !== "none" &&
            Number.isFinite(
              format.height
            )
        )
        .map(
          (format) =>
            format.height
        )
    ),
  ]
    .sort((a, b) => b - a)
    .slice(0, 12);

  return {
    id: info.id,

    title:
      info.title ||
      "video",

    thumbnail:
      info.thumbnail ||
      null,

    duration:
      Number(
        info.duration ||
        0
      ),

    uploader:
      info.uploader ||
      null,

    heights,

    hasAudio:
      formats.some(
        (format) =>
          format.acodec &&
          format.acodec !== "none"
      ),
  };
}

/* =========================================================
   ERROR MESSAGE
========================================================= */

function clientErrorMessage(error) {
  const message =
    String(
      error?.message ||
      error
    );

  if (
    /cookie.*tidak ditemukan|cookie.*tidak valid|YOUTUBE_COOKIES/i.test(
      message
    )
  ) {
    return (
      "Cookie YouTube belum terbaca dengan benar. " +
      "Periksa Secret File youtube-cookies.txt."
    );
  }

  if (
    /sign in to confirm|not a bot|confirm you're not a bot/i.test(
      message
    )
  ) {
    return (
      "YouTube meminta verifikasi. " +
      "Cookie sudah terbaca server tetapi ditolak oleh YouTube."
    );
  }

  if (
    /private video|video is private|members-only/i.test(
      message
    )
  ) {
    return (
      "Video privat atau terbatas dan tidak dapat diakses."
    );
  }

  if (
    /age-restricted|confirm your age|age restricted/i.test(
      message
    )
  ) {
    return (
      "Video dibatasi berdasarkan usia."
    );
  }

  if (
    /timed out|melewati batas waktu/i.test(
      message
    )
  ) {
    return (
      "Proses mengambil video melewati batas waktu."
    );
  }

  return (
    "Video tidak dapat diproses. Periksa log server."
  );
}

/* =========================================================
   INSPECT
========================================================= */

async function inspectVideo(videoId) {
  const args = [
    ...(await baseYtDlpArgs()),

    "--dump-single-json",

    youtubeUrl(videoId),
  ];

  const {
    stdout,
  } = await run(
    "yt-dlp",
    args
  );

  return JSON.parse(
    stdout
  );
}

/* =========================================================
   FILE
========================================================= */

async function removeFile(filePath) {
  if (!filePath) {
    return;
  }

  await fsp.rm(
    filePath,
    {
      force: true,
    }
  ).catch((error) => {
    console.error(
      "Gagal menghapus file sementara:",
      error.message
    );
  });
}

function scheduleDeletion(
  jobId,
  filePath
) {
  const timer =
    setTimeout(
      async () => {
        await removeFile(
          filePath
        );

        JOBS.delete(
          jobId
        );
      },
      FILE_TTL_MS
    );

  timer.unref();
}

/* =========================================================
   CREATE DOWNLOAD
========================================================= */

async function createDownload(
  jobId,
  videoId,
  requestedHeight
) {
  const job =
    JOBS.get(jobId);

  if (!job) {
    activeDownloads =
      Math.max(
        0,
        activeDownloads - 1
      );

    return;
  }

  try {
    const height =
      Math.min(
        Math.max(
          Number(
            requestedHeight
          ) || 1080,
          144
        ),
        2160
      );

    await fsp.mkdir(
      TEMP_DIR,
      {
        recursive: true,
        mode: 0o700,
      }
    );

    const outputTemplate =
      path.join(
        TEMP_DIR,
        `${jobId}.%(ext)s`
      );

    const format = [
      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
      `bv*[height<=${height}]+ba`,
      `b[height<=${height}]`,
      "b",
    ].join("/");

    const args = [
      ...(await baseYtDlpArgs()),

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

    const names =
      await fsp.readdir(
        TEMP_DIR
      );

    const generatedName =
      names.find(
        (name) =>
          name.startsWith(
            `${jobId}.`
          ) &&
          !name.endsWith(
            ".part"
          ) &&
          !name.endsWith(
            ".ytdl"
          ) &&
          !name.includes(
            "youtube-cookies"
          )
      );

    if (!generatedName) {
      throw new Error(
        "File hasil pemrosesan tidak ditemukan."
      );
    }

    const filePath =
      path.join(
        TEMP_DIR,
        generatedName
      );

    const stats =
      await fsp.stat(
        filePath
      );

    job.status =
      "ready";

    job.filePath =
      filePath;

    job.size =
      stats.size;

    job.expiresAt =
      Date.now() +
      FILE_TTL_MS;

    scheduleDeletion(
      jobId,
      filePath
    );
  } catch (error) {
    job.status =
      "failed";

    job.error =
      clientErrorMessage(
        error
      );

    console.error(
      `DOWNLOAD ERROR [${videoId}]:`,
      error.message
    );
  } finally {
    activeDownloads =
      Math.max(
        0,
        activeDownloads - 1
      );
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/healthz",
  (_req, res) => {
    res.status(200).json({
      ok: true,
    });
  }
);

/* =========================================================
   INFO
========================================================= */

app.post(
  "/api/info",
  async (req, res) => {
    const videoId =
      extractYouTubeId(
        String(
          req.body?.url ||
          ""
        ).trim()
      );

    if (!videoId) {
      return res
        .status(400)
        .json({
          error:
            "URL YouTube tidak valid.",
        });
    }

    console.log(
      `INFO REQUEST: ${videoId}`
    );

    try {
      const info =
        await inspectVideo(
          videoId
        );

      if (info.is_live) {
        return res
          .status(400)
          .json({
            error:
              "Siaran langsung yang belum selesai tidak didukung.",
          });
      }

      if (
        info.duration &&
        info.duration >
          MAX_VIDEO_DURATION_SECONDS
      ) {
        return res
          .status(413)
          .json({
            error:
              `Durasi video melebihi batas ${Math.round(
                MAX_VIDEO_DURATION_SECONDS /
                60
              )} menit.`,
          });
      }

      return res.json(
        publicVideoInfo(
          info
        )
      );
    } catch (error) {
      console.error(
        `INFO ERROR [${videoId}]:`,
        error.message
      );

      return res
        .status(422)
        .json({
          error:
            clientErrorMessage(
              error
            ),
        });
    }
  }
);

/* =========================================================
   DOWNLOAD
========================================================= */

app.post(
  "/api/download",
  (req, res) => {
    if (
      activeDownloads >=
      MAX_CONCURRENT_DOWNLOADS
    ) {
      return res
        .status(429)
        .json({
          error:
            "Server sedang sibuk. Coba lagi setelah proses lain selesai.",
        });
    }

    const videoId =
      String(
        req.body?.videoId ||
        ""
      );

    const height =
      Number(
        req.body?.height ||
        1080
      );

    if (
      !/^[\w-]{11}$/.test(
        videoId
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "ID video tidak valid.",
        });
    }

    const jobId =
      crypto.randomUUID();

    JOBS.set(
      jobId,
      {
        status:
          "processing",

        videoId,

        createdAt:
          Date.now(),

        filePath:
          null,
      }
    );

    activeDownloads++;

    void createDownload(
      jobId,
      videoId,
      height
    );

    return res
      .status(202)
      .json({
        jobId,
      });
  }
);

/* =========================================================
   JOB STATUS
========================================================= */

app.get(
  "/api/jobs/:jobId",
  (req, res) => {
    const job =
      JOBS.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          error:
            "Proses tidak ditemukan atau file sudah dihapus.",
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

      downloadUrl:
        job.status ===
        "ready"
          ? `/api/jobs/${req.params.jobId}/file`
          : null,
    });
  }
);

/* =========================================================
   DOWNLOAD FILE
========================================================= */

app.get(
  "/api/jobs/:jobId/file",
  (req, res) => {
    const job =
      JOBS.get(
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
            "File belum siap atau sudah dihapus.",
        });
    }

    if (
      !fs.existsSync(
        job.filePath
      )
    ) {
      JOBS.delete(
        req.params.jobId
      );

      return res
        .status(410)
        .json({
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
          res
            .status(500)
            .json({
              error:
                "Pengiriman file gagal.",
            });
        }

        await removeFile(
          job.filePath
        );

        JOBS.delete(
          req.params.jobId
        );
      }
    );
  }
);

/* =========================================================
   CLEANUP
========================================================= */

const cleanupTimer =
  setInterval(
    async () => {
      const now =
        Date.now();

      for (
        const [
          jobId,
          job,
        ] of JOBS
      ) {
        if (
          job.status ===
          "processing"
        ) {
          continue;
        }

        if (
          now -
            job.createdAt >
            FILE_TTL_MS ||
          (
            job.expiresAt &&
            now >
              job.expiresAt
          )
        ) {
          await removeFile(
            job.filePath
          );

          JOBS.delete(
            jobId
          );
        }
      }
    },
    5 * 60 * 1000
  );

cleanupTimer.unref();

/* =========================================================
   START
========================================================= */

async function start() {
  await fsp.mkdir(
    TEMP_DIR,
    {
      recursive: true,
      mode: 0o700,
    }
  );

  /*
    Validasi cookie ketika server mulai.
  */

  try {
    const cookieFile =
      await getCookieFile();

    console.log(
      "Cookie YouTube: SIAP"
    );

    console.log(
      `Cookie runtime: ${cookieFile}`
    );
  } catch (error) {
    console.error(
      "Cookie YouTube ERROR:",
      error.message
    );
  }

  const server =
    app.listen(
      PORT,
      HOST,
      () => {
        console.log(
          `Server aktif di ${HOST}:${PORT}`
        );

        console.log(
          `YOUTUBE_COOKIES_FILE: ${
            process.env
              .YOUTUBE_COOKIES_FILE
              ? "diatur"
              : "tidak diatur"
          }`
        );
      }
    );

  const shutdown =
    (signal) => {
      console.log(
        `${signal} diterima, menutup server...`
      );

      server.close(() => {
        process.exit(0);
      });

      setTimeout(() => {
        process.exit(1);
      }, 10_000).unref();
    };

  process.once(
    "SIGTERM",
    () =>
      shutdown(
        "SIGTERM"
      )
  );

  process.once(
    "SIGINT",
    () =>
      shutdown(
        "SIGINT"
      )
  );
}

start().catch(
  (error) => {
    console.error(
      "Gagal memulai server:",
      error
    );

    process.exit(1);
  }
);
