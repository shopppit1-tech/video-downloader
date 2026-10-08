"use strict";

const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const BASE_URL = (
  process.env.BASE_URL ||
  "https://video-downloader-soj1.onrender.com"
).replace(/\/+$/, "");

const FILE_TTL_MINUTES = Math.max(
  5,
  Number(process.env.FILE_TTL_MINUTES || 30)
);

const FILE_TTL_MS =
  FILE_TTL_MINUTES * 60 * 1000;

const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2)
);

const MAX_VIDEO_DURATION_SECONDS = Math.max(
  60,
  Number(process.env.MAX_VIDEO_DURATION_SECONDS || 7200)
);

const TEMP_DIR =
  path.join(__dirname, "temp");

const PUBLIC_DIR =
  path.join(__dirname, "public");

const YOUTUBE_COOKIE_SOURCE =
  process.env.YOUTUBE_COOKIES_FILE ||
  "/etc/secrets/youtube-cookies.txt";

const YOUTUBE_COOKIE_COPY =
  path.join(
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

/* =========================================================
   CORS
   Supaya GitHub Pages -> Render bisa akses API
========================================================= */

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length,Content-Disposition,Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

/* =========================================================
   SIMPLE RATE LIMIT
   HANYA UNTUK API YANG MEMBUAT BEBAN
========================================================= */

const requestMap = new Map();

function apiRateLimit(
  windowMs,
  max
) {
  return (req, res, next) => {
    const ip =
      req.ip ||
      req.socket.remoteAddress ||
      "unknown";

    const key =
      `${req.path}:${ip}`;

    const now =
      Date.now();

    let item =
      requestMap.get(key);

    if (
      !item ||
      item.resetAt <= now
    ) {
      item = {
        count: 0,
        resetAt:
          now + windowMs
      };

      requestMap.set(
        key,
        item
      );
    }

    item.count++;

    if (
      item.count > max
    ) {
      return res
        .status(429)
        .json({
          error:
            "Terlalu banyak permintaan. Tunggu sebentar."
        });
    }

    next();
  };
}

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(
    PUBLIC_DIR,
    {
      index: "index.html",
      extensions: ["html"]
    }
  )
);

/* =========================================================
   HELPERS
========================================================= */

function text(
  value,
  fallback = ""
) {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value);
}

function safeFilename(
  value
) {
  return (
    text(
      value,
      "video"
    )
      .replace(
        /[<>:"/\\|?*\x00-\x1F]/g,
        "_"
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
      .slice(
        0,
        120
      ) ||
    "video"
  );
}

function formatDuration(
  seconds
) {
  const total =
    Number(seconds || 0);

  if (
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return "00:00";
  }

  const h =
    Math.floor(
      total / 3600
    );

  const m =
    Math.floor(
      (total % 3600) / 60
    );

  const s =
    Math.floor(
      total % 60
    );

  if (h > 0) {
    return (
      `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    );
  }

  return (
    `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  );
}

function makeJobId() {
  return crypto
    .randomBytes(16)
    .toString("hex");
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

/* =========================================================
   URL PARSER
========================================================= */

function parseVideoUrl(
  input
) {
  const raw =
    text(input).trim();

  if (!raw) {
    throw new Error(
      "URL video kosong."
    );
  }

  let url;

  try {
    url =
      new URL(raw);
  } catch {
    throw new Error(
      "URL video tidak valid."
    );
  }

  if (
    ![
      "http:",
      "https:"
    ].includes(
      url.protocol
    )
  ) {
    throw new Error(
      "URL harus menggunakan HTTP atau HTTPS."
    );
  }

  const host =
    url.hostname.toLowerCase();

  const youtube =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host.endsWith(".youtu.be");

  const facebook =
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch");

  if (youtube) {
    return {
      platform: "youtube",
      url: url.toString()
    };
  }

  if (facebook) {
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
      "Cookie source:",
      YOUTUBE_COOKIE_SOURCE
    );

    console.log(
      "Cookie copy:",
      YOUTUBE_COOKIE_COPY
    );

    console.log(
      "YouTube cookies: TERDETEKSI"
    );

    return YOUTUBE_COOKIE_COPY;
  } catch (error) {
    console.error(
      "Cookie copy gagal:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   YT-DLP ARGS
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

  if (
    platform === "youtube"
  ) {
    args.push(
      "--js-runtimes",
      "node"
    );

    args.push(
      "--remote-components",
      "ejs:github"
    );

    /*
     * BGUTIL PO TOKEN
     */
    args.push(
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`
    );

    /*
     * YouTube client.
     *
     * default,mweb memberi yt-dlp
     * beberapa jalur ekstraksi.
     */
    args.push(
      "--extractor-args",
      "youtube:player_client=default,mweb"
    );

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

  if (
    process.env.HTTP_PROXY
  ) {
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
      const child =
        spawn(
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
        options.maxOutput ||
        30 * 1024 * 1024;

      child.stdout.on(
        "data",
        chunk => {
          stdout +=
            chunk.toString();

          if (
            stdout.length >
            maxOutput
          ) {
            stdout =
              stdout.slice(
                -maxOutput
              );
          }
        }
      );

      child.stderr.on(
        "data",
        chunk => {
          stderr +=
            chunk.toString();

          if (
            stderr.length >
            maxOutput
          ) {
            stderr =
              stderr.slice(
                -maxOutput
              );
          }
        }
      );

      let timer;

      if (
        options.timeoutMs
      ) {
        timer =
          setTimeout(
            () => {
              try {
                child.kill(
                  "SIGKILL"
                );
              } catch {}

              const error =
                new Error(
                  `${command} timeout`
                );

              error.code =
                "TIMEOUT";

              error.stdout =
                stdout;

              error.stderr =
                stderr;

              reject(error);
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

          error.stdout =
            stdout;

          error.stderr =
            stderr;

          reject(error);
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

          if (
            code === 0
          ) {
            return resolve({
              stdout,
              stderr
            });
          }

          const error =
            new Error(
              `${command} berhenti dengan kode ${code}`
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

function getThumbnail(
  info
) {
  if (
    info.thumbnail
  ) {
    return info.thumbnail;
  }

  if (
    info.id &&
    String(
      info.extractor_key ||
      ""
    )
      .toLowerCase()
      .includes("youtube")
  ) {
    return (
      `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`
    );
  }

  return null;
}

function collectQualities(
  info
) {
  const values =
    new Set();

  if (
    Array.isArray(
      info.formats
    )
  ) {
    for (
      const f of info.formats
    ) {
      const h =
        Number(
          f.height
        );

      if (
        Number.isFinite(h) &&
        h >= 144 &&
        h <= 2160
      ) {
        values.add(h);
      }
    }
  }

  return [
    ...values
  ].sort(
    (a, b) =>
      a - b
  );
}

function publicVideoInfo(
  info,
  platform
) {
  return {
    platform,

    id:
      text(info.id),

    title:
      text(
        info.title,
        "Video"
      ),

    uploader:
      text(
        info.uploader ||
        info.channel ||
        info.creator,
        ""
      ),

    duration:
      Number(
        info.duration || 0
      ),

    durationText:
      formatDuration(
        info.duration
      ),

    thumbnail:
      getThumbnail(info),

    width:
      Number(
        info.width || 0
      ),

    height:
      Number(
        info.height || 0
      ),

    qualities:
      collectQualities(info),

    webpageUrl:
      text(
        info.webpage_url ||
        info.original_url,
        ""
      )
  };
}

/* =========================================================
   INSPECT VIDEO
========================================================= */

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

  console.log(
    `[INFO] ${video.platform}: ${video.url}`
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
          x =>
            x.trim()
        )
        .filter(Boolean);

    const line =
      [...lines]
        .reverse()
        .find(
          x =>
            x.startsWith(
              "{"
            ) &&
            x.endsWith(
              "}"
            )
        );

    if (!line) {
      throw new Error(
        "yt-dlp tidak menghasilkan JSON."
      );
    }

    return JSON.parse(
      line
    );
  } catch (error) {
    console.error(
      `[INFO FAILED] ${video.platform}`
    );

    console.error(
      (
        error.stderr ||
        error.message ||
        ""
      ).slice(-12000)
    );

    throw error;
  }
}

/* =========================================================
   DOWNLOAD SOURCE
========================================================= */

function requestedHeight(
  value
) {
  const h =
    Number(value);

  if (
    !Number.isFinite(h)
  ) {
    return 720;
  }

  return Math.min(
    2160,
    Math.max(
      144,
      Math.round(h)
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

  /*
   * MP4/H264/AAC diprioritaskan.
   */
  const format =
    [
      `bv*[height<=${height}][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]`,

      `bv*[height<=${height}][vcodec^=avc1][ext=mp4]+ba[ext=m4a]`,

      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,

      `bv*[height<=${height}]+ba`,

      `b[height<=${height}]`,

      "b"
    ].join("/");

  args.push(
    "--format",
    format,

    "--merge-output-format",
    "mp4",

    "--no-part",

    "--restrict-filenames",

    "--output",
    outputTemplate,

    video.url
  );

  return run(
    "yt-dlp",
    args,
    {
      timeoutMs:
        30 * 60 * 1000,

      maxOutput:
        40 *
        1024 *
        1024
    }
  );
}

/* =========================================================
   FFMPEG
========================================================= */

async function convertToMp4(
  input,
  output
) {
  const args = [
    "-y",

    "-hide_banner",

    "-loglevel",
    "error",

    "-i",
    input,

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
    String(
      process.env.FFMPEG_CRF ||
      "23"
    ),

    "-pix_fmt",
    "yuv420p",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-movflags",
    "+faststart",

    output
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
   FILE FINDER
========================================================= */

async function findDownloadedFile(
  dir,
  finalPath
) {
  const files =
    await fsp.readdir(
      dir
    );

  const finalName =
    path.basename(
      finalPath
    );

  const candidates =
    files
      .filter(
        name =>
          name !==
          finalName
      )
      .filter(
        name => {
          const lower =
            name.toLowerCase();

          return (
            lower.endsWith(
              ".mp4"
            ) ||
            lower.endsWith(
              ".mkv"
            ) ||
            lower.endsWith(
              ".webm"
            ) ||
            lower.endsWith(
              ".mov"
            )
          );
        }
      )
      .map(
        name =>
          path.join(
            dir,
            name
          )
      );

  if (
    !candidates.length
  ) {
    return null;
  }

  let best =
    null;

  let bestSize =
    -1;

  for (
    const file of candidates
  ) {
    try {
      const stat =
        await fsp.stat(
          file
        );

      if (
        stat.isFile() &&
        stat.size >
        bestSize
      ) {
        best =
          file;

        bestSize =
          stat.size;
      }
    } catch {}
  }

  return best;
}

/* =========================================================
   JOB CLEANUP
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
      job.dir,
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
      id,
      job
    ] of jobs
  ) {
    if (
      now -
        job.createdAt >
      FILE_TTL_MS
    ) {
      jobs.delete(id);

      console.log(
        `[CLEANUP] ${id}`
      );

      await cleanupJob(
        job
      );
    }
  }
}

setInterval(
  cleanupExpiredJobs,
  5 * 60 * 1000
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

      ytDlp:
        null,

      ffmpeg:
        null,

      potServer:
        POT_BASE_URL,

      cookies:
        false
    };

    try {
      await fsp.access(
        YOUTUBE_COOKIE_SOURCE,
        fs.constants.R_OK
      );

      result.cookies =
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
    } catch (
      error
    ) {
      result.ytDlp =
        error.message;
    }

    try {
      const r =
        await run(
          "ffmpeg",
          [
            "-version"
          ],
          {
            timeoutMs:
              15000
          }
        );

      result.ffmpeg =
        r.stdout
          .split(/\r?\n/)[0];
    } catch (
      error
    ) {
      result.ffmpeg =
        error.message;
    }

    res.json(
      result
    );
  }
);

/* =========================================================
   INFO
========================================================= */

app.post(
  "/api/info",

  apiRateLimit(
    15 * 60 * 1000,
    30
  ),

  async (
    req,
    res
  ) => {
    try {
      const video =
        parseVideoUrl(
          req.body?.url
        );

      const info =
        await inspectVideo(
          video
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
          video.platform
        )
      );
    } catch (
      error
    ) {
      console.error(
        "[INFO ERROR]",
        error.message
      );

      res
        .status(400)
        .json({
          error:
            "Informasi video tidak dapat diambil."
        });
    }
  }
);

/* =========================================================
   CREATE DOWNLOAD JOB
========================================================= */

app.post(
  "/api/download",

  apiRateLimit(
    15 * 60 * 1000,
    20
  ),

  async (
    req,
    res
  ) => {
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

    let video;

    try {
      video =
        parseVideoUrl(
          req.body?.url
        );
    } catch (
      error
    ) {
      return res
        .status(400)
        .json({
          error:
            error.message
        });
    }

    const height =
      requestedHeight(
        req.body?.height
      );

    const jobId =
      makeJobId();

    const dir =
      path.join(
        TEMP_DIR,
        jobId
      );

    const title =
      safeFilename(
        req.body?.title ||
        `VideoFetch_${video.platform}`
      );

    const filename =
      `${title}.mp4`;

    const filePath =
      path.join(
        dir,
        filename
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    const job = {
      id: jobId,

      platform:
        video.platform,

      url:
        video.url,

      height,

      title,

      filename,

      dir,

      filePath,

      sourceFile:
        null,

      status:
        "queued",

      error:
        null,

      size:
        0,

      createdAt:
        Date.now(),

      startedAt:
        null,

      finishedAt:
        null
    };

    jobs.set(
      jobId,
      job
    );

    /*
     * URL ABSOLUT Render.
     * Ini penting kalau frontend berada
     * di GitHub Pages.
     */
    const downloadUrl =
      `${BASE_URL}/api/jobs/${jobId}/file`;

    console.log(
      `[JOB CREATED] ${jobId}`
    );

    console.log(
      `[DOWNLOAD] ${video.platform}`
    );

    console.log(
      `[DOWNLOAD] ${video.url}`
    );

    console.log(
      `[DOWNLOAD] height: ${height}`
    );

    /*
     * Balikkan job langsung.
     */
    res.json({
      ok: true,

      jobId,

      status:
        "queued",

      platform:
        video.platform,

      quality:
        height,

      filename,

      downloadUrl
    });

    /*
     * Kerjakan di background.
     */
    processDownloadJob(
      job
    ).catch(
      error => {
        console.error(
          `[JOB FATAL] ${jobId}`,
          error.message
        );
      }
    );
  }
);

/* =========================================================
   PROCESS DOWNLOAD
========================================================= */

async function processDownloadJob(
  job
) {
  activeDownloads++;

  job.status =
    "processing";

  job.startedAt =
    Date.now();

  try {
    const sourceTemplate =
      path.join(
        job.dir,
        "%(title).100B.%(ext)s"
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

    const source =
      await findDownloadedFile(
        job.dir,
        job.filePath
      );

    if (!source) {
      throw new Error(
        "File hasil yt-dlp tidak ditemukan."
      );
    }

    job.sourceFile =
      source;

    console.log(
      `[FFMPEG] ${source}`
    );

    job.status =
      "converting";

    await convertToMp4(
      source,
      job.filePath
    );

    const stat =
      await fsp.stat(
        job.filePath
      );

    if (
      !stat.isFile() ||
      stat.size <= 0
    ) {
      throw new Error(
        "File MP4 hasil FFmpeg kosong."
      );
    }

    job.size =
      stat.size;

    job.status =
      "ready";

    job.finishedAt =
      Date.now();

    /*
     * Hapus file sumber.
     */
    await removeFile(
      source
    );

    job.sourceFile =
      null;

    console.log(
      `[SUCCESS] size: ${job.size} bytes`
    );

    console.log(
      `[SUCCESS] ${job.id}`
    );
  } catch (
    error
  ) {
    job.status =
      "failed";

    job.finishedAt =
      Date.now();

    job.error =
      (
        error.stderr ||
        error.message ||
        "Download gagal."
      ).slice(
        -10000
      );

    console.error(
      `[FAILED] ${job.id}`
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
   TIDAK diberi rate limit
   supaya polling tidak berhenti.
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
          ok: false,

          error:
            "Job tidak ditemukan atau sudah kedaluwarsa."
        });
    }

    const downloadUrl =
      `${BASE_URL}/api/jobs/${job.id}/file`;

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

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
        job.size,

      error:
        job.status ===
        "failed"
          ? job.error
          : null,

      ready:
        job.status ===
        "ready",

      downloadUrl:
        job.status ===
        "ready"
          ? downloadUrl
          : null
    });
  }
);

/* =========================================================
   FILE DOWNLOAD
========================================================= */

app.get(
  "/api/jobs/:jobId/file",
  async (
    req,
    res
  ) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .send(
          "File tidak ditemukan."
        );
    }

    if (
      job.status !==
      "ready"
    ) {
      return res
        .status(409)
        .json({
          error:
            "File belum siap.",
          status:
            job.status
        });
    }

    try {
      const stat =
        await fsp.stat(
          job.filePath
        );

      if (
        !stat.isFile() ||
        stat.size <= 0
      ) {
        throw new Error(
          "File kosong."
        );
      }

      console.log(
        `[FILE] sending ${job.id} ${stat.size} bytes`
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        String(
          stat.size
        )
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
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      /*
       * Dukungan Range request.
       * Lebih aman untuk download besar
       * di Android/browser.
       */
      const range =
        req.headers.range;

      if (!range) {
        const stream =
          fs.createReadStream(
            job.filePath
          );

        stream.on(
          "error",
          error => {
            console.error(
              "[FILE STREAM ERROR]",
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

        return stream.pipe(
          res
        );
      }

      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (!match) {
        return res
          .status(416)
          .setHeader(
            "Content-Range",
            `bytes */${stat.size}`
          )
          .end();
      }

      let start =
        match[1]
          ? Number(
              match[1]
            )
          : 0;

      let end =
        match[2]
          ? Number(
              match[2]
            )
          : stat.size - 1;

      if (
        !Number.isFinite(
          start
        ) ||
        !Number.isFinite(
          end
        ) ||
        start < 0 ||
        end < start ||
        start >= stat.size
      ) {
        return res
          .status(416)
          .setHeader(
            "Content-Range",
            `bytes */${stat.size}`
          )
          .end();
      }

      end =
        Math.min(
          end,
          stat.size - 1
        );

      const chunkSize =
        end -
        start +
        1;

      res.status(
        206
      );

      res.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${stat.size}`
      );

      res.setHeader(
        "Content-Length",
        String(
          chunkSize
        )
      );

      const stream =
        fs.createReadStream(
          job.filePath,
          {
            start,
            end
          }
        );

      stream.on(
        "error",
        error => {
          console.error(
            "[RANGE ERROR]",
            error.message
          );

          res.end();
        }
      );

      return stream.pipe(
        res
      );
    } catch (
      error
    ) {
      console.error(
        `[FILE ERROR] ${job.id}`,
        error.message
      );

      return res
        .status(404)
        .json({
          error:
            "File sudah tidak tersedia."
        });
    }
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
    "Max duration:",
    MAX_VIDEO_DURATION_SECONDS,
    "seconds"
  );

  console.log(
    "Max downloads:",
    MAX_CONCURRENT_DOWNLOADS
  );

  console.log(
    "Base URL:",
    BASE_URL
  );

  console.log(
    "========================================"
  );

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

    console.log(
      "yt-dlp version:",
      r.stdout.trim()
    );
  } catch (
    error
  ) {
    console.error(
      "yt-dlp error:",
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
  } catch (
    error
  ) {
    console.error(
      "FFmpeg error:",
      error.message
    );
  }

  await setupCookies();

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `Server aktif di port ${PORT}`
      );

      console.log(
        `Download URL base: ${BASE_URL}`
      );
    }
  );
}

/* =========================================================
   SHUTDOWN
========================================================= */

process.on(
  "SIGTERM",
  () => {
    console.log(
      "SIGTERM received."
    );

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "SIGINT received."
    );

    process.exit(0);
  }
);

/* =========================================================
   START
========================================================= */

startup().catch(
  error => {
    console.error(
      "Startup gagal:",
      error
    );

    process.exit(1);
  }
);
