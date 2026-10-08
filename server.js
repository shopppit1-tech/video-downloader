"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const FILE_TTL_MINUTES = Number(
  process.env.FILE_TTL_MINUTES || 30
);

const FILE_TTL_MS =
  Math.max(1, FILE_TTL_MINUTES) * 60 * 1000;

const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2)
);

const MAX_VIDEO_DURATION_SECONDS = Math.max(
  60,
  Number(process.env.MAX_VIDEO_DURATION_SECONDS || 7200)
);

const TEMP_DIR = path.join(__dirname, "temp");
const PUBLIC_DIR = path.join(__dirname, "public");

const YOUTUBE_COOKIE_SOURCE =
  process.env.YOUTUBE_COOKIES_FILE ||
  "/etc/secrets/youtube-cookies.txt";

const YOUTUBE_COOKIE_COPY = path.join(
  TEMP_DIR,
  "youtube-cookies.txt"
);

const POT_BASE_URL =
  process.env.POT_BASE_URL ||
  "http://127.0.0.1:4416";

const jobs = new Map();

let activeDownloads = 0;

fs.mkdirSync(TEMP_DIR, {
  recursive: true
});

/* =========================================================
   EXPRESS
========================================================= */

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "64kb"
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "64kb"
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,

    message: {
      error:
        "Terlalu banyak permintaan. Coba lagi beberapa menit lagi."
    }
  })
);

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(PUBLIC_DIR, {
    index: "index.html",
    extensions: ["html"],

    maxAge:
      process.env.NODE_ENV === "production"
        ? "1h"
        : 0
  })
);

/* =========================================================
   HELPERS
========================================================= */

function safeText(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value);
}

function safeFilename(value) {
  return (
    safeText(value, "video")
      .replace(
        /[<>:"/\\|?*\x00-\x1F]/g,
        "_"
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) ||
    "video"
  );
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);

  if (
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return "00:00";
  }

  const s = Math.floor(total % 60);

  const m = Math.floor(
    (total / 60) % 60
  );

  const h = Math.floor(
    total / 3600
  );

  if (h > 0) {
    return [
      h,
      String(m).padStart(2, "0"),
      String(s).padStart(2, "0")
    ].join(":");
  }

  return [
    String(m).padStart(2, "0"),
    String(s).padStart(2, "0")
  ].join(":");
}

function makeJobId() {
  return crypto
    .randomBytes(16)
    .toString("hex");
}

/* =========================================================
   URL DETECTION
========================================================= */

function isYouTubeHostname(hostname) {
  const host =
    hostname.toLowerCase();

  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host.endsWith(".youtu.be")
  );
}

function isFacebookHostname(hostname) {
  const host =
    hostname.toLowerCase();

  return (
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch")
  );
}

function parseVideoUrl(input) {
  const raw =
    safeText(input).trim();

  if (!raw) {
    throw new Error(
      "URL video kosong."
    );
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "URL video tidak valid."
    );
  }

  if (
    !["http:", "https:"].includes(
      url.protocol
    )
  ) {
    throw new Error(
      "URL harus menggunakan HTTP atau HTTPS."
    );
  }

  const hostname =
    url.hostname.toLowerCase();

  if (
    isYouTubeHostname(hostname)
  ) {
    return {
      platform: "youtube",
      url: url.toString()
    };
  }

  if (
    isFacebookHostname(hostname)
  ) {
    return {
      platform: "facebook",
      url: url.toString()
    };
  }

  throw new Error(
    "URL tidak didukung. Gunakan YouTube atau Facebook."
  );
}

/* =========================================================
   YOUTUBE COOKIES
========================================================= */

async function setupCookies() {
  try {
    await fsp.access(
      YOUTUBE_COOKIE_SOURCE,
      fs.constants.R_OK
    );
  } catch {
    console.log(
      "YouTube cookies: TIDAK TERSEDIA"
    );

    return null;
  }

  try {
    await fsp.copyFile(
      YOUTUBE_COOKIE_SOURCE,
      YOUTUBE_COOKIE_COPY
    );

    try {
      await fsp.chmod(
        YOUTUBE_COOKIE_COPY,
        0o600
      );
    } catch {}

    console.log(
      "Cookie copy:",
      YOUTUBE_COOKIE_COPY
    );

    console.log(
      "Cookie source:",
      YOUTUBE_COOKIE_SOURCE
    );

    console.log(
      "YouTube cookies: TERDETEKSI -> writable copy"
    );

    return YOUTUBE_COOKIE_COPY;
  } catch (error) {
    console.error(
      "Gagal menyalin YouTube cookies:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   YT-DLP ARGUMENTS
========================================================= */

async function baseYtDlpArgs(
  platform
) {
  const args = [
    "--no-playlist",

    "--no-warnings",

    "--socket-timeout",
    "30",

    "--retries",
    "3",

    "--fragment-retries",
    "3",

    "--extractor-retries",
    "3",

    "--concurrent-fragments",
    "1"
  ];

  /*
   * YOUTUBE
   */

  if (platform === "youtube") {
    /*
     * JavaScript runtime
     */
    args.push(
      "--js-runtimes",
      "node"
    );

    /*
     * Remote EJS components
     */
    args.push(
      "--remote-components",
      "ejs:github"
    );

    /*
     * BGUTIL PO TOKEN PROVIDER
     */
    args.push(
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`
    );

    /*
     * YouTube clients.
     *
     * mweb = utama
     * tv = fallback
     * web_safari = fallback
     */
    args.push(
      "--extractor-args",
      "youtube:player_client=mweb,tv,web_safari"
    );

    /*
     * Cookies
     */
    const cookieFile =
      await setupCookies();

    if (cookieFile) {
      args.push(
        "--cookies",
        cookieFile
      );
    }

    if (
      process.env.YOUTUBE_USER_AGENT
    ) {
      args.push(
        "--user-agent",
        process.env.YOUTUBE_USER_AGENT
      );
    }
  }

  /*
   * Optional proxy
   */
  if (process.env.HTTP_PROXY) {
    args.push(
      "--proxy",
      process.env.HTTP_PROXY
    );
  }

  return args;
}

/* =========================================================
   COMMAND RUNNER
========================================================= */

function run(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child = spawn(
        command,
        args,
        {
          cwd:
            options.cwd ||
            process.cwd(),

          env: {
            ...process.env,
            ...(options.env || {})
          },

          stdio: [
            "ignore",
            "pipe",
            "pipe"
          ]
        }
      );

      let stdout = "";
      let stderr = "";

      const maxOutput =
        Number(
          options.maxOutput ||
            30 * 1024 * 1024
        );

      function append(
        current,
        chunk
      ) {
        const text =
          chunk.toString();

        if (
          current.length >=
          maxOutput
        ) {
          return current;
        }

        return (
          current +
          text.slice(
            0,
            maxOutput -
              current.length
          )
        );
      }

      child.stdout.on(
        "data",
        chunk => {
          stdout =
            append(
              stdout,
              chunk
            );
        }
      );

      child.stderr.on(
        "data",
        chunk => {
          stderr =
            append(
              stderr,
              chunk
            );
        }
      );

      let timer = null;

      if (
        options.timeoutMs
      ) {
        timer = setTimeout(
          () => {
            try {
              child.kill(
                "SIGKILL"
              );
            } catch {}

            reject(
              Object.assign(
                new Error(
                  `${command} timeout setelah ${options.timeoutMs}ms`
                ),
                {
                  code: "TIMEOUT",
                  stdout,
                  stderr
                }
              )
            );
          },
          options.timeoutMs
        );
      }

      child.on(
        "error",
        error => {
          if (timer) {
            clearTimeout(
              timer
            );
          }

          reject(
            Object.assign(
              error,
              {
                stdout,
                stderr
              }
            )
          );
        }
      );

      child.on(
        "close",
        code => {
          if (timer) {
            clearTimeout(
              timer
            );
          }

          if (code === 0) {
            resolve({
              stdout,
              stderr
            });

            return;
          }

          const error =
            new Error(
              `${command} berhenti dengan kode ${code}: ${
                stderr.trim() ||
                stdout.trim() ||
                "unknown error"
              }`
            );

          error.code =
            code;

          error.stdout =
            stdout;

          error.stderr =
            stderr;

          reject(error);
        }
      );
    }
  );
}

/* =========================================================
   VIDEO INFO
========================================================= */

function getThumbnail(info) {
  if (info.thumbnail) {
    return info.thumbnail;
  }

  if (
    info.id &&
    info.extractor_key &&
    String(
      info.extractor_key
    )
      .toLowerCase()
      .includes("youtube")
  ) {
    return `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
  }

  return null;
}

function collectQualities(info) {
  const set =
    new Set();

  if (
    Array.isArray(
      info.formats
    )
  ) {
    for (
      const format of info.formats
    ) {
      const height =
        Number(
          format.height
        );

      if (
        Number.isFinite(
          height
        ) &&
        height >= 144 &&
        height <= 2160
      ) {
        set.add(height);
      }
    }
  }

  const common = [
    144,
    240,
    360,
    480,
    720,
    1080,
    1440,
    2160
  ];

  for (
    const height of common
  ) {
    if (set.has(height)) {
      continue;
    }

    if (
      Number(
        info.height || 0
      ) >= height
    ) {
      set.add(height);
    }
  }

  return [
    ...set
  ].sort(
    (a, b) => a - b
  );
}

function publicVideoInfo(
  info,
  platform
) {
  return {
    platform,

    id: safeText(
      info.id
    ),

    title: safeText(
      info.title,
      "Video"
    ),

    uploader: safeText(
      info.uploader ||
        info.channel ||
        info.creator,
      ""
    ),

    duration: Number(
      info.duration || 0
    ),

    durationText:
      formatDuration(
        info.duration
      ),

    thumbnail:
      getThumbnail(info),

    width: Number(
      info.width || 0
    ),

    height: Number(
      info.height || 0
    ),

    webpageUrl: safeText(
      info.webpage_url ||
        info.original_url,
      ""
    ),

    qualities:
      collectQualities(info)
  };
}

async function inspectVideo(
  video
) {
  const args =
    await baseYtDlpArgs(
      video.platform
    );

  args.push(
    "--dump-single-json",
    "--skip-download",
    video.url
  );

  try {
    const result =
      await run(
        "yt-dlp",
        args,
        {
          timeoutMs:
            120000,

          maxOutput:
            40 *
            1024 *
            1024
        }
      );

    const lines =
      result.stdout
        .split(/\r?\n/)
        .map(
          line =>
            line.trim()
        )
        .filter(Boolean);

    const jsonLine =
      [...lines]
        .reverse()
        .find(
          line =>
            line.startsWith(
              "{"
            ) &&
            line.endsWith(
              "}"
            )
        );

    if (!jsonLine) {
      throw new Error(
        "yt-dlp tidak mengembalikan data JSON video."
      );
    }

    return JSON.parse(
      jsonLine
    );
  } catch (error) {
    console.error(
      `[INFO FAILED] ${video.platform}`
    );

    if (error.stderr) {
      console.error(
        error.stderr.slice(
          -12000
        )
      );
    }

    throw error;
  }
}

/* =========================================================
   DOWNLOAD FORMAT
========================================================= */

function getRequestedHeight(
  value
) {
  const height =
    Number(value);

  if (
    !Number.isFinite(
      height
    )
  ) {
    return 720;
  }

  return Math.min(
    2160,
    Math.max(
      144,
      Math.round(height)
    )
  );
}

async function downloadSource(
  video,
  outputTemplate,
  height
) {
  const args =
    await baseYtDlpArgs(
      video.platform
    );

  const format = [
    `bv*[height<=${height}][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]`,

    `bv*[height<=${height}][vcodec^=avc1][ext=mp4]+ba[ext=m4a]`,

    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,

    `bv*[height<=${height}]+ba`,

    `b[height<=${height}]`,

    "b"
  ].join("/");

  args.push(
    "--format-sort",
    "res,ext:mp4:m4a,vcodec:h264,acodec:aac",

    "--format",
    format,

    "--merge-output-format",
    "mp4",

    "--no-part",

    "--restrict-filenames",

    "--output",
    outputTemplate,

    "--print",
    "after_move:filepath",

    video.url
  );

  return run(
    "yt-dlp",
    args,
    {
      timeoutMs:
        30 * 60 * 1000,

      maxOutput:
        30 *
        1024 *
        1024
    }
  );
}

/* =========================================================
   FFMPEG
========================================================= */

async function convertToAndroidMp4(
  inputFile,
  outputFile
) {
  const args = [
    "-y",

    "-hide_banner",

    "-loglevel",
    "error",

    "-i",
    inputFile,

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

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

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-movflags",
    "+faststart",

    "-vsync",
    "cfr",

    outputFile
  ];

  return run(
    "ffmpeg",
    args,
    {
      timeoutMs:
        45 * 60 * 1000,

      maxOutput:
        20 *
        1024 *
        1024
    }
  );
}

/* =========================================================
   CLEANUP
========================================================= */

async function removeFile(
  file
) {
  if (!file) {
    return;
  }

  try {
    await fsp.unlink(
      file
    );
  } catch {}
}

async function cleanupJob(
  job
) {
  if (!job) {
    return;
  }

  await removeFile(
    job.sourceFile
  );

  await removeFile(
    job.filePath
  );

  try {
    await fsp.rm(
      path.dirname(
        job.filePath
      ),
      {
        recursive: true,
        force: true
      }
    );
  } catch {}
}

async function cleanupExpiredJobs() {
  const now =
    Date.now();

  for (
    const [
      jobId,
      job
    ] of jobs.entries()
  ) {
    if (
      job.createdAt +
        FILE_TTL_MS <=
      now
    ) {
      jobs.delete(
        jobId
      );

      await cleanupJob(
        job
      );
    }
  }
}

setInterval(
  cleanupExpiredJobs,
  Math.min(
    FILE_TTL_MS,
    5 * 60 * 1000
  )
).unref();

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "video-fetch",

      uptime:
        Math.floor(
          process.uptime()
        ),

      activeDownloads,

      jobs:
        jobs.size,

      potServer:
        POT_BASE_URL
    });
  }
);

/* =========================================================
   DIAGNOSTICS
========================================================= */

app.get(
  "/api/diagnostics",
  async (req, res) => {
    const result = {
      ok: true,

      node:
        process.version,

      platform:
        process.platform,

      arch:
        process.arch,

      potBaseUrl:
        POT_BASE_URL,

      youtubeCookiesConfigured:
        false,

      ytDlp:
        null,

      ffmpeg:
        null
    };

    try {
      await fsp.access(
        YOUTUBE_COOKIE_SOURCE,
        fs.constants.R_OK
      );

      result.youtubeCookiesConfigured =
        true;
    } catch {}

    try {
      const r =
        await run(
          "yt-dlp",
          ["--version"],
          {
            timeoutMs:
              15000
          }
        );

      result.ytDlp =
        r.stdout.trim();
    } catch (error) {
      result.ytDlp =
        error.message;
    }

    try {
      const r =
        await run(
          "ffmpeg",
          ["-version"],
          {
            timeoutMs:
              15000
          }
        );

      result.ffmpeg =
        r.stdout
          .split(/\r?\n/)[0] ||
        "available";
    } catch (error) {
      result.ffmpeg =
        error.message;
    }

    res.json(
      result
    );
  }
);

/* =========================================================
   API INFO
========================================================= */

app.post(
  "/api/info",
  async (req, res) => {
    try {
      const parsed =
        parseVideoUrl(
          req.body?.url
        );

      console.log(
        `[INFO] ${parsed.platform}: ${parsed.url}`
      );

      const info =
        await inspectVideo(
          parsed
        );

      if (
        Number(
          info.duration || 0
        ) >
        MAX_VIDEO_DURATION_SECONDS
      ) {
        return res
          .status(400)
          .json({
            error:
              `Video terlalu panjang. Maksimal ${formatDuration(
                MAX_VIDEO_DURATION_SECONDS
              )}.`
          });
      }

      res.json(
        publicVideoInfo(
          info,
          parsed.platform
        )
      );
    } catch (error) {
      console.error(
        "[API INFO ERROR]",
        error.message
      );

      res.status(400).json({
        error:
          "Informasi video tidak dapat diambil.",

        detail:
          process.env.NODE_ENV ===
          "production"
            ? undefined
            : error.message
      });
    }
  }
);

/* =========================================================
   API DOWNLOAD
========================================================= */

app.post(
  "/api/download",
  async (req, res) => {
    let parsed;

    try {
      parsed =
        parseVideoUrl(
          req.body?.url
        );
    } catch (error) {
      return res
        .status(400)
        .json({
          error:
            error.message
        });
    }

    if (
      activeDownloads >=
      MAX_CONCURRENT_DOWNLOADS
    ) {
      return res
        .status(429)
        .json({
          error:
            "Server sedang penuh. Tunggu download sebelumnya selesai."
        });
    }

    const height =
      getRequestedHeight(
        req.body?.height
      );

    const jobId =
      makeJobId();

    const jobDir =
      path.join(
        TEMP_DIR,
        jobId
      );

    const baseName =
      safeFilename(
        req.body?.title ||
          `VideoFetch_${parsed.platform}`
      );

    const finalFile =
      path.join(
        jobDir,
        `${baseName}.mp4`
      );

    try {
      await fsp.mkdir(
        jobDir,
        {
          recursive: true
        }
      );
    } catch {
      return res
        .status(500)
        .json({
          error:
            "Tidak dapat membuat folder download."
        });
    }

    const job = {
      id: jobId,

      platform:
        parsed.platform,

      url:
        parsed.url,

      height,

      title:
        baseName,

      status:
        "queued",

      createdAt:
        Date.now(),

      sourceFile:
        null,

      filePath:
        finalFile,

      filename:
        `${baseName}.mp4`,

      error:
        null
    };

    jobs.set(
      jobId,
      job
    );

    res.json({
      ok: true,

      jobId,

      status:
        "queued",

      platform:
        parsed.platform,

      quality:
        height,

      filename:
        job.filename,

      downloadUrl:
        `/api/jobs/${jobId}/file`
    });

    processDownloadJob(
      job
    ).catch(error => {
      console.error(
        `[JOB ${jobId}] FATAL:`,
        error.message
      );
    });
  }
);

/* =========================================================
   PROCESS DOWNLOAD
========================================================= */

async function processDownloadJob(
  job
) {
  if (!job) {
    return;
  }

  if (
    activeDownloads >=
    MAX_CONCURRENT_DOWNLOADS
  ) {
    job.status =
      "failed";

    job.error =
      "Server sedang penuh.";

    return;
  }

  activeDownloads++;

  job.status =
    "processing";

  console.log(
    `[DOWNLOAD] ${job.platform} ${job.id} ${job.height}p`
  );

  try {
    const sourceDir =
      path.dirname(
        job.filePath
      );

    const sourceTemplate =
      path.join(
        sourceDir,
        "%(title).120B.%(ext)s"
      );

    await downloadSource(
      {
        platform:
          job.platform,

        url:
          job.url
      },

      sourceTemplate,

      job.height
    );

    const files =
      await fsp.readdir(
        sourceDir
      );

    const sourceCandidates =
      files
        .map(name =>
          path.join(
            sourceDir,
            name
          )
        )
        .filter(file => {
          const lower =
            file.toLowerCase();

          return (
            lower.endsWith(
              ".mp4"
            ) ||
            lower.endsWith(
              ".mkv"
            ) ||
            lower.endsWith(
              ".webm"
            )
          );
        })
        .filter(file =>
          !file.endsWith(
            path.basename(
              job.filePath
            )
          )
        )
        .sort();

    if (
      !sourceCandidates.length
    ) {
      throw new Error(
        "File hasil yt-dlp tidak ditemukan."
      );
    }

    const actualSource =
      sourceCandidates[0];

    job.sourceFile =
      actualSource;

    job.status =
      "converting";

    console.log(
      `[FFMPEG] ${job.id}: ${actualSource}`
    );

    await convertToAndroidMp4(
      actualSource,
      job.filePath
    );

    const stat =
      await fsp.stat(
        job.filePath
      );

    if (
      !stat.size
    ) {
      throw new Error(
        "File MP4 hasil konversi kosong."
      );
    }

    job.status =
      "ready";

    job.readyAt =
      Date.now();

    job.size =
      stat.size;

    console.log(
      `[READY] ${job.id}: ${job.filePath}`
    );

    await removeFile(
      actualSource
    );

    job.sourceFile =
      null;
  } catch (error) {
    job.status =
      "failed";

    job.error =
      error.stderr?.slice(
        -5000
      ) ||
      error.message ||
      "Download gagal.";

    console.error(
      `[DOWNLOAD FAILED] ${job.platform} ${job.id}`
    );

    console.error(
      job.error
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
   JOB STATUS
========================================================= */

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
            "Job tidak ditemukan."
        });
    }

    res.json({
      ok: true,

      jobId:
        job.id,

      status:
        job.status,

      platform:
        job.platform,

      quality:
        job.height,

      filename:
        job.filename,

      size:
        job.size || 0,

      error:
        job.status ===
        "failed"
          ? job.error
          : null,

      downloadUrl:
        job.status ===
        "ready"
          ? `/api/jobs/${job.id}/file`
          : null
    });
  }
);

/* =========================================================
   FILE DOWNLOAD
========================================================= */

app.get(
  "/api/jobs/:jobId/file",
  async (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .send(
          "File tidak ditemukan atau sudah kedaluwarsa."
        );
    }

    if (
      job.status !==
      "ready"
    ) {
      return res
        .status(409)
        .send(
          "File belum siap."
        );
    }

    try {
      await fsp.access(
        job.filePath,
        fs.constants.R_OK
      );
    } catch {
      job.status =
        "failed";

      job.error =
        "File sudah tidak tersedia.";

      return res
        .status(404)
        .send(
          "File sudah tidak tersedia."
        );
    }

    res.setHeader(
      "Content-Type",
      "video/mp4"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${job.filename.replace(
        /"/g,
        ""
      )}"`
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    const stream =
      fs.createReadStream(
        job.filePath
      );

    stream.on(
      "error",
      error => {
        console.error(
          `[FILE ERROR] ${job.id}`,
          error.message
        );

        if (
          !res.headersSent
        ) {
          res
            .status(500)
            .end();
        } else {
          res.end();
        }
      }
    );

    stream.pipe(res);
  }
);

/* =========================================================
   API 404
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res
      .status(404)
      .json({
        error:
          "API endpoint tidak ditemukan."
      });
  }
);

/* =========================================================
   STARTUP
========================================================= */

async function startup() {
  console.log(
    "========================================"
  );

  console.log(
    "Video Fetch starting..."
  );

  console.log(
    "Node:",
    process.version
  );

  console.log(
    "Platform:",
    process.platform
  );

  console.log(
    "Arch:",
    process.arch
  );

  console.log(
    "POT server:",
    POT_BASE_URL
  );

  console.log(
    "Cookie source:",
    YOUTUBE_COOKIE_SOURCE
  );

  console.log(
    "Max downloads:",
    MAX_CONCURRENT_DOWNLOADS
  );

  console.log(
    "Max duration:",
    MAX_VIDEO_DURATION_SECONDS,
    "seconds"
  );

  console.log(
    "========================================"
  );

  try {
    const yt =
      await run(
        "yt-dlp",
        ["--version"],
        {
          timeoutMs:
            15000
        }
      );

    console.log(
      "yt-dlp version:",
      yt.stdout.trim()
    );
  } catch (error) {
    console.error(
      "yt-dlp tidak tersedia:",
      error.message
    );
  }

  try {
    await run(
      "ffmpeg",
      ["-version"],
      {
        timeoutMs:
          15000
      }
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

  try {
    await setupCookies();
  } catch {}

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `Server aktif di ${HOST}:${PORT}`
      );
    }
  );
}

/* =========================================================
   SHUTDOWN
========================================================= */

process.on(
  "SIGTERM",
  async () => {
    console.log(
      "SIGTERM diterima."
    );

    for (
      const job of jobs.values()
    ) {
      if (
        job.status ===
          "queued" ||
        job.status ===
          "processing" ||
        job.status ===
          "converting"
      ) {
        job.status =
          "failed";

        job.error =
          "Server sedang restart.";
      }
    }

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "SIGINT diterima."
    );

    process.exit(0);
  }
);

startup().catch(
  error => {
    console.error(
      "Startup gagal:",
      error
    );

    process.exit(1);
  }
);
