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
   STATIC
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

function text(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value);
}

/*
 * Bersihkan judul video untuk nama file.
 */
function cleanFilename(value) {
  let name = text(
    value,
    "Video"
  );

  name = name
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      ""
    )
    .replace(
      /[\u0000-\u001F]/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

  /*
   * Hilangkan titik/spasi di akhir
   * karena Windows tidak menyukainya.
   */
  name = name.replace(
    /[.\s]+$/,
    ""
  );

  /*
   * Maksimal 100 karakter judul.
   */
  name = name.slice(
    0,
    100
  );

  return (
    name ||
    "Video"
  );
}

function makeShortId() {
  return crypto
    .randomBytes(5)
    .toString("hex");
}

function makeFilename(
  platform,
  title
) {
  const platformName =
    platform === "facebook"
      ? "Facebook"
      : "YouTube";

  const cleanTitle =
    cleanFilename(title);

  const shortId =
    makeShortId();

  return (
    `${platformName}_${cleanTitle}_${shortId}.mp4`
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

/* =========================================================
   URL
========================================================= */

function parseVideoUrl(input) {
  const raw =
    text(input).trim();

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

  const isYouTube =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host.endsWith(".youtu.be");

  const isFacebook =
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".fb.watch");

  if (isYouTube) {
    return {
      platform: "youtube",
      url: url.toString()
    };
  }

  if (isFacebook) {
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
   COOKIE
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

    args.push(
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`
    );

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
        40 * 1024 * 1024;

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

      let timer = null;

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
   INFO
========================================================= */

function getThumbnail(info) {
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

function collectQualities(info) {
  const values =
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
        values.add(
          height
        );
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
            40 * 1024 * 1024
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
        "yt-dlp tidak menghasilkan JSON."
      );
    }

    return JSON.parse(
      jsonLine
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
   DOWNLOAD
========================================================= */

function requestedHeight(
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
        40 * 1024 * 1024
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
        20 * 1024 * 1024
    }
  );
}

/* =========================================================
   FIND FILE
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
      jobs.delete(
        id
      );

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
  async (
    req,
    res
  ) => {
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
          .split(/\r?\n/)[0];
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
   TANPA RATE LIMIT
========================================================= */

app.post(
  "/api/info",
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
    } catch (error) {
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
   API DOWNLOAD
========================================================= */

app.post(
  "/api/download",
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
    } catch (error) {
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

    /*
     * Kalau frontend mengirim title,
     * pakai title tersebut.
     *
     * Kalau tidak, sementara gunakan
     * "Video" dan nanti diganti
     * setelah info didapat.
     */
    let title =
      cleanFilename(
        req.body?.title ||
        ""
      );

    /*
     * Kalau title tidak dikirim,
     * ambil judul video dari yt-dlp.
     */
    if (
      !title ||
      title === "Video"
    ) {
      try {
        const info =
          await inspectVideo(
            video
          );

        title =
          cleanFilename(
            info.title ||
            "Video"
          );
      } catch (error) {
        console.log(
          "Tidak bisa mengambil judul awal:",
          error.message
        );

        title =
          "Video";
      }
    }

    const filename =
      makeFilename(
        video.platform,
        title
      );

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
      id:
        jobId,

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

    const downloadUrl =
      `${BASE_URL}/api/jobs/${jobId}/file`;

    console.log(
      "========================================"
    );

    console.log(
      `[JOB CREATED] ${jobId}`
    );

    console.log(
      `[PLATFORM] ${video.platform}`
    );

    console.log(
      `[TITLE] ${title}`
    );

    console.log(
      `[FILENAME] ${filename}`
    );

    console.log(
      `[QUALITY] ${height}p`
    );

    console.log(
      `[DOWNLOAD URL] ${downloadUrl}`
    );

    console.log(
      "========================================"
    );

    res.json({
      ok: true,

      jobId,

      status:
        "queued",

      platform:
        video.platform,

      quality:
        height,

      title,

      filename,

      downloadUrl
    });

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

    job.status =
      "converting";

    console.log(
      `[FFMPEG] ${source}`
    );

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

    await removeFile(
      source
    );

    job.sourceFile =
      null;

    console.log(
      "========================================"
    );

    console.log(
      `[SUCCESS] ${job.id}`
    );

    console.log(
      `[TITLE] ${job.title}`
    );

    console.log(
      `[FILENAME] ${job.filename}`
    );

    console.log(
      `[SIZE] ${job.size} bytes`
    );

    console.log(
      `[DOWNLOAD] ${BASE_URL}/api/jobs/${job.id}/file`
    );

    console.log(
      "========================================"
    );
  } catch (error) {
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

    /*
     * status dibuat tetap "ready"
     * ketika file selesai.
     *
     * Ditambahkan juga completed
     * agar frontend dengan nama status
     * berbeda tetap bisa membaca.
     */
    res.json({
      ok: true,

      jobId:
        job.id,

      status:
        job.status,

      completed:
        job.status === "ready",

      ready:
        job.status === "ready",

      platform:
        job.platform,

      quality:
        job.height,

      title:
        job.title,

      filename:
        job.filename,

      size:
        job.size,

      error:
        job.status ===
        "failed"
          ? job.error
          : null,

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
        `[FILE] sending ${job.filename} (${stat.size} bytes)`
      );

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
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      const range =
        req.headers.range;

      /*
       * DOWNLOAD NORMAL
       */
      if (!range) {
        res.setHeader(
          "Content-Length",
          String(
            stat.size
          )
        );

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

            res.end();
          }
        );

        return stream.pipe(
          res
        );
      }

      /*
       * RANGE DOWNLOAD
       */
      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (!match) {
        res.status(
          416
        );

        res.setHeader(
          "Content-Range",
          `bytes */${stat.size}`
        );

        return res.end();
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
        res.status(
          416
        );

        res.setHeader(
          "Content-Range",
          `bytes */${stat.size}`
        );

        return res.end();
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
    } catch (error) {
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
    MAX_VIDEO_DURATION_SECONDS
  );

  console.log(
    "Max concurrent downloads:",
    MAX_CONCURRENT_DOWNLOADS
  );

  console.log(
    "File TTL:",
    FILE_TTL_MINUTES,
    "minutes"
  );

  console.log(
    "Base URL:",
    BASE_URL
  );

  console.log(
    "API RATE LIMIT: DISABLED"
  );

  console.log(
    "========================================"
  );

  try {
    const result =
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
      result.stdout.trim()
    );
  } catch (error) {
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
  } catch (error) {
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
        `Download base URL: ${BASE_URL}`
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
