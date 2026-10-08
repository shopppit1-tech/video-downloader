"use strict";

const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const BASE_URL = (
  process.env.BASE_URL ||
  "https://video-downloader-soj1.onrender.com"
).replace(/\/+$/, "");

const TEMP_DIR =
  path.join(__dirname, "temp");

const PUBLIC_DIR =
  path.join(__dirname, "public");

const POT_BASE_URL =
  process.env.POT_BASE_URL ||
  "http://127.0.0.1:4416";

const COOKIE_SOURCE =
  process.env.YOUTUBE_COOKIES_FILE ||
  "/etc/secrets/youtube-cookies.txt";

const COOKIE_COPY =
  path.join(
    TEMP_DIR,
    "youtube-cookies.txt"
  );

const FILE_TTL_MINUTES = Math.max(
  5,
  Number(
    process.env.FILE_TTL_MINUTES || 30
  )
);

const FILE_TTL_MS =
  FILE_TTL_MINUTES *
  60 *
  1000;

const MAX_CONCURRENT_DOWNLOADS =
  Math.max(
    1,
    Number(
      process.env.MAX_CONCURRENT_DOWNLOADS || 2
    )
  );

const MAX_VIDEO_DURATION_SECONDS =
  Math.max(
    60,
    Number(
      process.env.MAX_VIDEO_DURATION_SECONDS || 7200
    )
  );

const jobs = new Map();

let activeDownloads = 0;

fs.mkdirSync(
  TEMP_DIR,
  {
    recursive: true
  }
);

/* =========================================================
   EXPRESS
========================================================= */

app.disable(
  "x-powered-by"
);

app.set(
  "trust proxy",
  1
);

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

app.use(
  (req, res, next) => {
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

    if (
      req.method === "OPTIONS"
    ) {
      return res
        .status(204)
        .end();
    }

    next();
  }
);

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

function str(
  value,
  fallback = ""
) {
  return value == null
    ? fallback
    : String(value);
}

function cleanFilename(
  value
) {
  return str(
    value,
    "Video"
  )
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .replace(
      /[.\s]+$/,
      ""
    )
    .slice(
      0,
      100
    ) || "Video";
}

function makeShortId() {
  return crypto
    .randomBytes(5)
    .toString("hex");
}

function makeJobId() {
  return crypto
    .randomBytes(16)
    .toString("hex");
}

/*
 * NAMA FILE:
 *
 * Video Fatch_a83f91c2d1.mp4
 * Video Fatch_7b29e04f51.mp4
 *
 * Tidak memakai nama video.
 */
function makeFilename() {
  return `Video Fatch_${makeShortId()}.mp4`;
}

function formatDuration(
  seconds
) {
  const n =
    Number(
      seconds || 0
    );

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return "00:00";
  }

  const h =
    Math.floor(
      n / 3600
    );

  const m =
    Math.floor(
      (n % 3600) / 60
    );

  const s =
    Math.floor(
      n % 60
    );

  return h
    ? `${h}:${String(m).padStart(
        2,
        "0"
      )}:${String(s).padStart(
        2,
        "0"
      )}`
    : `${String(m).padStart(
        2,
        "0"
      )}:${String(s).padStart(
        2,
        "0"
      )}`;
}

/* =========================================================
   URL
========================================================= */

function parseVideoUrl(
  input
) {
  const raw =
    str(input).trim();

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

  const youtube =
    host === "youtube.com" ||
    host.endsWith(
      ".youtube.com"
    ) ||
    host === "youtu.be" ||
    host.endsWith(
      ".youtu.be"
    );

  const facebook =
    host === "facebook.com" ||
    host.endsWith(
      ".facebook.com"
    ) ||
    host === "fb.watch" ||
    host.endsWith(
      ".fb.watch"
    );

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
   COOKIE
========================================================= */

async function setupCookies() {
  try {
    await fsp.access(
      COOKIE_SOURCE,
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
      COOKIE_SOURCE,
      COOKIE_COPY
    );

    try {
      await fsp.chmod(
        COOKIE_COPY,
        0o600
      );
    } catch {}

    console.log(
      "YouTube cookies: TERDETEKSI"
    );

    console.log(
      "Cookie source:",
      COOKIE_SOURCE
    );

    console.log(
      "Cookie copy:",
      COOKIE_COPY
    );

    return COOKIE_COPY;
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

async function ytdlpArgs(
  platform,
  client = "mweb"
) {
  const args = [
    "--no-playlist",
    "--no-warnings",

    "--socket-timeout",
    "30",

    "--retries",
    "2",

    "--fragment-retries",
    "2",

    "--extractor-retries",
    "2",

    /*
     * Download lebih cepat.
     */
    "--concurrent-fragments",
    "4",

    "--buffer-size",
    "16K"
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
      `youtube:player_client=${client}`
    );

    /*
     * mweb tanpa cookies.
     *
     * Kalau mweb gagal,
     * otomatis fallback ke
     * web_embedded + cookies.
     */
    if (
      client !== "mweb"
    ) {
      const cookie =
        await setupCookies();

      if (cookie) {
        args.push(
          "--cookies",
          cookie
        );
      }
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

      const max =
        options.maxOutput ||
        40 * 1024 * 1024;

      child.stdout.on(
        "data",
        data => {
          stdout +=
            data.toString();

          if (
            stdout.length >
            max
          ) {
            stdout =
              stdout.slice(
                -max
              );
          }
        }
      );

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            max
          ) {
            stderr =
              stderr.slice(
                -max
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

              error.stdout =
                stdout;

              error.stderr =
                stderr;

              error.code =
                "TIMEOUT";

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

          error.stdout =
            stdout;

          error.stderr =
            stderr;

          error.code =
            code;

          reject(error);
        }
      );
    }
  );
}

/* =========================================================
   YOUTUBE FALLBACK
========================================================= */

async function youtubeRun(
  mode,
  extraArgs,
  options = {}
) {
  let lastError =
    null;

  /*
   * 1. mweb + PO Token
   * 2. web_embedded + cookies
   */
  for (
    const client of [
      "mweb",
      "web_embedded"
    ]
  ) {
    try {
      console.log(
        `[YT ${mode}] mencoba client: ${client}`
      );

      const args =
        await ytdlpArgs(
          "youtube",
          client
        );

      args.push(
        ...extraArgs
      );

      const result =
        await run(
          "yt-dlp",
          args,
          options
        );

      console.log(
        `[YT ${mode}] sukses dengan client: ${client}`
      );

      return result;
    } catch (error) {
      lastError =
        error;

      console.error(
        `[YT ${mode}] ${client} gagal`
      );

      console.error(
        (
          error.stderr ||
          error.message ||
          ""
        ).slice(
          -8000
        )
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "YouTube gagal diproses."
    )
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
      .includes(
        "youtube"
      )
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
  const set =
    new Set();

  for (
    const format of
      Array.isArray(
        info.formats
      )
        ? info.formats
        : []
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
      set.add(
        height
      );
    }
  }

  return [
    ...set
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
      str(info.id),

    title:
      str(
        info.title,
        "Video"
      ),

    uploader:
      str(
        info.uploader ||
        info.channel ||
        info.creator,
        ""
      ),

    duration:
      Number(
        info.duration ||
        0
      ),

    durationText:
      formatDuration(
        info.duration
      ),

    thumbnail:
      getThumbnail(
        info
      ),

    width:
      Number(
        info.width ||
        0
      ),

    height:
      Number(
        info.height ||
        0
      ),

    qualities:
      collectQualities(
        info
      ),

    webpageUrl:
      str(
        info.webpage_url ||
        info.original_url,
        ""
      )
  };
}

async function inspectVideo(
  video
) {
  console.log(
    `[INFO] ${video.platform}: ${video.url}`
  );

  const extra = [
    "--dump-single-json",
    "--skip-download",
    video.url
  ];

  try {
    const result =
      video.platform ===
      "youtube"
        ? await youtubeRun(
            "INFO",
            extra,
            {
              timeoutMs:
                120000,

              maxOutput:
                40 * 1024 * 1024
            }
          )
        : await run(
            "yt-dlp",
            [
              ...(await ytdlpArgs(
                video.platform
              )),
              ...extra
            ],
            {
              timeoutMs:
                120000,

              maxOutput:
                40 * 1024 * 1024
            }
          );

    const jsonLine =
      result.stdout
        .split(
          /\r?\n/
        )
        .map(
          x => x.trim()
        )
        .filter(Boolean)
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
      ).slice(
        -12000
      )
    );

    throw error;
  }
}

/* =========================================================
   QUALITY
========================================================= */

function requestedHeight(
  value
) {
  const n =
    Number(value);

  if (
    !Number.isFinite(
      n
    )
  ) {
    return 720;
  }

  return Math.min(
    2160,
    Math.max(
      144,
      Math.round(n)
    )
  );
}

/* =========================================================
   DOWNLOAD SOURCE
========================================================= */

async function downloadSource(
  video,
  outputTemplate,
  height
) {
  const format = [
    `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
    "b"
  ].join("/");

  const extra = [
    "--format",
    format,

    "--merge-output-format",
    "mp4",

    "--no-part",

    "--restrict-filenames",

    "--output",
    outputTemplate,

    video.url
  ];

  if (
    video.platform ===
    "youtube"
  ) {
    return youtubeRun(
      "DOWNLOAD",
      extra,
      {
        timeoutMs:
          30 * 60 * 1000,

        maxOutput:
          40 * 1024 * 1024
      }
    );
  }

  return run(
    "yt-dlp",
    [
      ...(await ytdlpArgs(
        video.platform
      )),
      ...extra
    ],
    {
      timeoutMs:
        30 * 60 * 1000,

      maxOutput:
        40 * 1024 * 1024
    }
  );
}

/* =========================================================
   FILE HELPERS
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

/* =========================================================
   FFMPEG
========================================================= */

async function convertToMp4(
  input,
  output
) {
  let videoCodec = "";
  let audioCodec = "";

  /*
   * CEK VIDEO CODEC
   */
  try {
    const v =
      await run(
        "ffprobe",
        [
          "-v",
          "error",

          "-select_streams",
          "v:0",

          "-show_entries",
          "stream=codec_name",

          "-of",
          "default=noprint_wrappers=1:nokey=1",

          input
        ],
        {
          timeoutMs:
            30000
        }
      );

    videoCodec =
      v.stdout
        .trim()
        .toLowerCase();

    /*
     * CEK AUDIO CODEC
     */
    try {
      const a =
        await run(
          "ffprobe",
          [
            "-v",
            "error",

            "-select_streams",
            "a:0",

            "-show_entries",
            "stream=codec_name",

            "-of",
            "default=noprint_wrappers=1:nokey=1",

            input
          ],
          {
            timeoutMs:
              30000
          }
        );

      audioCodec =
        a.stdout
          .trim()
          .toLowerCase();
    } catch {}
  } catch {
    console.log(
      "[CODEC] ffprobe gagal, encode aman."
    );
  }

  console.log(
    `[CODEC] video=${videoCodec || "none"} audio=${audioCodec || "none"}`
  );

  /*
   * KALAU SUDAH H264 + AAC
   * COBA REMUX CEPAT
   */
  if (
    videoCodec ===
      "h264" &&
    (
      audioCodec ===
        "aac" ||
      audioCodec ===
        ""
    )
  ) {
    try {
      console.log(
        "[FFMPEG FAST] remux..."
      );

      await run(
        "ffmpeg",
        [
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

          "-c",
          "copy",

          "-movflags",
          "+faststart",

          output
        ],
        {
          timeoutMs:
            15 * 60 * 1000
        }
      );

      /*
       * VALIDASI DURASI
       */
      const check =
        await run(
          "ffprobe",
          [
            "-v",
            "error",

            "-show_entries",
            "format=duration",

            "-of",
            "default=noprint_wrappers=1:nokey=1",

            output
          ],
          {
            timeoutMs:
              30000
          }
        );

      const duration =
        Number(
          check.stdout.trim()
        );

      if (
        Number.isFinite(
          duration
        ) &&
        duration > 0
      ) {
        console.log(
          `[FFMPEG FAST] valid ${duration}s`
        );

        return;
      }
    } catch {}

    await removeFile(
      output
    );

    console.log(
      "[FFMPEG FAST] remux gagal, encode ulang..."
    );
  }

  /*
   * ENCODE AMAN ANDROID
   *
   * H264
   * AAC
   * yuv420p
   * faststart
   */
  console.log(
    "[FFMPEG] encode H264 + AAC..."
  );

  await run(
    "ffmpeg",
    [
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

      "-profile:v",
      "main",

      "-level",
      "4.0",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      "-ar",
      "48000",

      "-ac",
      "2",

      "-movflags",
      "+faststart",

      output
    ],
    {
      timeoutMs:
        45 * 60 * 1000,

      maxOutput:
        20 * 1024 * 1024
    }
  );

  /*
   * VALIDASI FINAL
   */
  const check =
    await run(
      "ffprobe",
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration",

        "-of",
        "default=noprint_wrappers=1:nokey=1",

        output
      ],
      {
        timeoutMs:
          30000
      }
    );

  const duration =
    Number(
      check.stdout.trim()
    );

  if (
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {
    await removeFile(
      output
    );

    throw new Error(
      "MP4 hasil akhir tidak valid."
    );
  }

  console.log(
    `[FFMPEG] final valid: ${duration}s`
  );
}

/* =========================================================
   FIND FILE
========================================================= */

async function findDownloadedFile(
  dir,
  finalPath
) {
  const names =
    await fsp.readdir(
      dir
    );

  const finalName =
    path.basename(
      finalPath
    );

  const candidates =
    names
      .filter(
        name =>
          name !==
          finalName
      )
      .filter(
        name =>
          /\.(mp4|mkv|webm|mov)$/i.test(
            name
          )
      )
      .map(
        name =>
          path.join(
            dir,
            name
          )
      );

  let best =
    null;

  let bestSize =
    -1;

  for (
    const file of
      candidates
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

      ffprobe:
        null,

      potServer:
        POT_BASE_URL,

      cookies:
        false,

      potPing:
        false
    };

    try {
      await fsp.access(
        COOKIE_SOURCE,
        fs.constants.R_OK
      );

      result.cookies =
        true;
    } catch {}

    try {
      result.ytDlp =
        (
          await run(
            "yt-dlp",
            [
              "--version"
            ],
            {
              timeoutMs:
                15000
            }
          )
        )
          .stdout
          .trim();
    } catch (error) {
      result.ytDlp =
        error.message;
    }

    try {
      result.ffmpeg =
        (
          await run(
            "ffmpeg",
            [
              "-version"
            ],
            {
              timeoutMs:
                15000
            }
          )
        )
          .stdout
          .split(
            /\r?\n/
          )[0];
    } catch (error) {
      result.ffmpeg =
        error.message;
    }

    try {
      result.ffprobe =
        (
          await run(
            "ffprobe",
            [
              "-version"
            ],
            {
              timeoutMs:
                15000
            }
          )
        )
          .stdout
          .split(
            /\r?\n/
          )[0];
    } catch (error) {
      result.ffprobe =
        error.message;
    }

    try {
      result.potPing =
        (
          await fetch(
            `${POT_BASE_URL}/ping`
          )
        ).status;
    } catch {}

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
          info.duration ||
            0
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

    const id =
      makeJobId();

    const dir =
      path.join(
        TEMP_DIR,
        id
      );

    let title =
      cleanFilename(
        req.body?.title ||
          ""
      );

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
      } catch {
        title =
          "Video";
      }
    }

    /*
     * Nama file TIDAK menggunakan title.
     */
    const filename =
      makeFilename();

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
      id,

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
      id,
      job
    );

    const downloadUrl =
      `${BASE_URL}/api/jobs/${id}/file`;

    console.log(
      "========================================"
    );

    console.log(
      `[JOB CREATED] ${id}`
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
      "========================================"
    );

    res.json({
      ok: true,

      jobId:
        id,

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
          `[JOB FATAL] ${id}`,
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
    const template =
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

      template,

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
      `[FILENAME] ${job.filename}`
    );

    console.log(
      `[SIZE] ${job.size} bytes`
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

    res.json({
      ok: true,

      jobId:
        job.id,

      status:
        job.status,

      completed:
        job.status ===
        "ready",

      ready:
        job.status ===
        "ready",

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

      /*
       * Header aman untuk Android/Chrome.
       */
      const asciiFilename =
        job.filename
          .replace(
            /[^\x20-\x7E]/g,
            "_"
          )
          .replace(
            /["\\]/g,
            "_"
          );

      const encodedFilename =
        encodeURIComponent(
          job.filename
        );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`
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

        return fs
          .createReadStream(
            job.filePath
          )
          .pipe(
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

      const size =
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
          size
        )
      );

      return fs
        .createReadStream(
          job.filePath,
          {
            start,
            end
          }
        )
        .pipe(
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
    "POT server:",
    POT_BASE_URL
  );

  console.log(
    "Cookie source:",
    COOKIE_SOURCE
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
    "YouTube clients: mweb -> web_embedded"
  );

  console.log(
    "Concurrent fragments: 4"
  );

  console.log(
    "FFmpeg: fast remux + Android-safe H264/AAC fallback"
  );

  console.log(
    "API RATE LIMIT: DISABLED"
  );

  console.log(
    "========================================"
  );

  /*
   * YT-DLP
   */
  try {
    const result =
      await run(
        "yt-dlp",
        [
          "--version"
        ],
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

  /*
   * FFMPEG
   */
  try {
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

    console.log(
      "FFmpeg tersedia."
    );
  } catch (error) {
    console.error(
      "FFmpeg error:",
      error.message
    );
  }

  /*
   * FFPROBE
   */
  try {
    await run(
      "ffprobe",
      [
        "-version"
      ],
      {
        timeoutMs:
          15000
      }
    );

    console.log(
      "FFprobe tersedia."
    );
  } catch (error) {
    console.error(
      "FFprobe error:",
      error.message
    );
  }

  await setupCookies();

  /*
   * CEK BGUTIL
   */
  let potOk =
    false;

  for (
    let i = 1;
    i <= 10;
    i++
  ) {
    try {
      const response =
        await fetch(
          `${POT_BASE_URL}/ping`
        );

      if (
        response.ok
      ) {
        potOk =
          true;

        console.log(
          `[POT] provider aktif (${response.status})`
        );

        break;
      }
    } catch {}

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          500
        )
    );
  }

  if (!potOk) {
    console.error(
      "[POT] provider tidak merespons /ping"
    );
  }

  /*
   * START SERVER
   */
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

    process.exit(
      0
    );
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "SIGINT received."
    );

    process.exit(
      0
    );
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

    process.exit(
      1
    );
  }
);
