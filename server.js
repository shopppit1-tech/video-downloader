const express = require("express");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

require("dotenv").config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TEMP_DIR = path.join(__dirname, "temp");

const FILE_TTL =
  Number(process.env.FILE_TTL_MINUTES || 30) *
  60 *
  1000;

const MAX_CONCURRENT =
  Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2);

const MAX_DURATION =
  Number(process.env.MAX_VIDEO_DURATION_SECONDS || 7200);

let activeDownloads = 0;

const jobs = new Map();

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "10kb" }));

app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);


/* =========================
   YOUTUBE URL
========================= */

function getVideoId(input) {
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
    const id = url.pathname
      .slice(1)
      .split("/")[0];

    return /^[A-Za-z0-9_-]{11}$/.test(id)
      ? id
      : null;
  }

  if (
    host !== "youtube.com" &&
    host !== "m.youtube.com" &&
    host !== "music.youtube.com"
  ) {
    return null;
  }

  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");

    return id &&
      /^[A-Za-z0-9_-]{11}$/.test(id)
      ? id
      : null;
  }

  const match = url.pathname.match(
    /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/
  );

  return match ? match[1] : null;
}


function youtubeUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}


/* =========================
   COOKIES
========================= */

async function setupCookies() {
  const cookies = process.env.YOUTUBE_COOKIES;

  if (!cookies || !cookies.trim()) {
    return null;
  }

  await fsp.mkdir(TEMP_DIR, {
    recursive: true
  });

  const file = path.join(
    TEMP_DIR,
    "youtube-cookies.txt"
  );

  await fsp.writeFile(
    file,
    cookies,
    "utf8"
  );

  return file;
}


/* =========================
   RUN COMMAND
========================= */

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", data => {
      stdout += data.toString();
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      reject(error);
    });

    child.on("close", code => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
        return;
      }

      reject(
        new Error(
          `${command} exited ${code}: ${stderr.slice(-5000)}`
        )
      );
    });
  });
}


/* =========================
   YT-DLP ARGUMENTS
========================= */

async function baseYtDlpArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:npm"
  ];

  const cookieFile =
    await setupCookies();

  if (cookieFile) {
    args.push(
      "--cookies",
      cookieFile
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
   VIDEO INFO
========================= */

function cleanInfo(info) {
  const formats =
    Array.isArray(info.formats)
      ? info.formats
      : [];

  const heights = [
    ...new Set(
      formats
        .filter(
          f =>
            f.vcodec &&
            f.vcodec !== "none" &&
            Number.isFinite(f.height)
        )
        .map(f => f.height)
    )
  ]
    .sort((a, b) => b - a)
    .slice(0, 12);

  return {
    id: info.id,
    title: info.title || "Video",
    thumbnail: info.thumbnail || null,
    duration: Number(info.duration || 0),
    uploader: info.uploader || null,
    heights,
    hasAudio: formats.some(
      f =>
        f.acodec &&
        f.acodec !== "none"
    )
  };
}


async function getInfo(videoId) {
  const args =
    await baseYtDlpArgs();

  args.push(
    "--dump-single-json",
    youtubeUrl(videoId)
  );

  const result =
    await run("yt-dlp", args);

  return JSON.parse(
    result.stdout
  );
}


/* =========================
   DELETE FILE
========================= */

async function deleteFile(file) {
  if (!file) return;

  await fsp.rm(file, {
    force: true
  }).catch(() => {});
}


function expireJob(jobId, file) {
  const timer = setTimeout(
    async () => {
      await deleteFile(file);
      jobs.delete(jobId);
    },
    FILE_TTL
  );

  timer.unref();
}


/* =========================
   DOWNLOAD
========================= */

async function downloadVideo(
  jobId,
  videoId,
  requestedHeight
) {
  const job = jobs.get(jobId);

  try {
    await fsp.mkdir(TEMP_DIR, {
      recursive: true
    });

    const height = Math.min(
      Math.max(
        Number(requestedHeight) || 1080,
        144
      ),
      2160
    );

    const output =
      path.join(
        TEMP_DIR,
        `${jobId}.%(ext)s`
      );

    const format = [
      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
      `bv*[height<=${height}]+ba`,
      `b[height<=${height}]`,
      "b"
    ].join("/");

    const args =
      await baseYtDlpArgs();

    args.push(
      "--format",
      format,
      "--merge-output-format",
      "mp4",
      "--remux-video",
      "mp4",
      "--restrict-filenames",
      "--output",
      output,
      youtubeUrl(videoId)
    );

    console.log(
      `DOWNLOAD ${videoId} ${height}p`
    );

    await run(
      "yt-dlp",
      args
    );

    const files =
      await fsp.readdir(TEMP_DIR);

    const name =
      files.find(
        f =>
          f.startsWith(jobId + ".") &&
          !f.endsWith(".part") &&
          !f.endsWith(".ytdl")
      );

    if (!name) {
      throw new Error(
        "File hasil tidak ditemukan"
      );
    }

    const file =
      path.join(
        TEMP_DIR,
        name
      );

    const stat =
      await fsp.stat(file);

    job.status = "ready";
    job.filePath = file;
    job.size = stat.size;
    job.expiresAt =
      Date.now() + FILE_TTL;

    expireJob(
      jobId,
      file
    );

    console.log(
      `READY ${videoId}`
    );

  } catch (error) {
    job.status = "failed";
    job.error =
      "Video gagal diproses.";

    console.error(
      "DOWNLOAD ERROR:",
      error.message
    );

  } finally {
    activeDownloads--;
  }
}


/* =========================
   INFO API
========================= */

app.post(
  "/api/info",
  async (req, res) => {
    const videoId =
      getVideoId(
        String(
          req.body?.url || ""
        ).trim()
      );

    if (!videoId) {
      return res.status(400).json({
        error:
          "URL YouTube tidak valid."
      });
    }

    try {
      console.log(
        "INFO REQUEST:",
        videoId
      );

      const info =
        await getInfo(videoId);

      if (info.is_live) {
        return res.status(400).json({
          error:
            "Siaran langsung tidak didukung."
        });
      }

      if (
        info.duration &&
        info.duration > MAX_DURATION
      ) {
        return res.status(413).json({
          error:
            "Durasi video terlalu panjang."
        });
      }

      return res.json(
        cleanInfo(info)
      );

    } catch (error) {
      console.error(
        "INFO ERROR:",
        error.message
      );

      const msg =
        error.message || "";

      if (
        /sign in to confirm/i.test(msg) ||
        /not a bot/i.test(msg) ||
        /captcha/i.test(msg)
      ) {
        return res.status(429).json({
          error:
            "YouTube menolak permintaan dari server."
        });
      }

      return res.status(422).json({
        error:
          "Informasi video tidak dapat diambil."
      });
    }
  }
);


/* =========================
   DOWNLOAD API
========================= */

app.post(
  "/api/download",
  (req, res) => {
    if (
      activeDownloads >=
      MAX_CONCURRENT
    ) {
      return res.status(429).json({
        error:
          "Server sedang sibuk."
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
      !/^[A-Za-z0-9_-]{11}$/.test(
        videoId
      )
    ) {
      return res.status(400).json({
        error:
          "ID video tidak valid."
      });
    }

    const jobId =
      crypto.randomUUID();

    jobs.set(jobId, {
      status: "processing",
      videoId,
      createdAt: Date.now(),
      filePath: null
    });

    activeDownloads++;

    downloadVideo(
      jobId,
      videoId,
      height
    );

    return res.status(202).json({
      jobId
    });
  }
);


/* =========================
   JOB STATUS
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
          "Proses tidak ditemukan."
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
          : null
    });
  }
);


/* =========================
   FILE API
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
          "File belum siap."
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
          "File sudah kedaluwarsa."
      });
    }

    res.setHeader(
      "Cache-Control",
      "private, no-store"
    );

    res.download(
      job.filePath,
      "video.mp4",
      async error => {
        if (
          error &&
          !res.headersSent
        ) {
          res.status(500).json({
            error:
              "Pengiriman file gagal."
          });
        }

        await deleteFile(
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
   CLEANUP
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
        FILE_TTL
      ) {
        await deleteFile(
          job.filePath
        );

        jobs.delete(jobId);
      }
    }
  },
  5 * 60 * 1000
).unref();


/* =========================
   START
========================= */

async function start() {
  await fsp.mkdir(
    TEMP_DIR,
    {
      recursive: true
    }
  );

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Server aktif di port ${PORT}`
      );
    }
  );
}

start().catch(error => {
  console.error(
    "SERVER ERROR:",
    error
  );

  process.exit(1);
});
