"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const rateLimit = require("express-rate-limit");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const publicDir =
  path.join(__dirname, "public");

const tempDir =
  path.join(os.tmpdir(), "video-fetch");

fs.mkdirSync(
  tempDir,
  {
    recursive: true
  }
);


/* =====================================================
   LIMIT
===================================================== */

const MAX_CONCURRENT_DOWNLOADS =
  Number(
    process.env.MAX_CONCURRENT_DOWNLOADS || 2
  );

const MAX_VIDEO_DURATION_SECONDS =
  Number(
    process.env.MAX_VIDEO_DURATION_SECONDS || 7200
  );

const MAX_HEIGHT =
  Number(
    process.env.MAX_HEIGHT || 2160
  );

const MIN_HEIGHT =
  Number(
    process.env.MIN_HEIGHT || 144
  );

const FILE_TTL_MS =
  30 * 60 * 1000;


/* =====================================================
   STATE
===================================================== */

const jobs =
  new Map();

let activeDownloads = 0;


/* =====================================================
   EXPRESS
===================================================== */

app.set(
  "trust proxy",
  1
);

app.use(
  express.json({
    limit: "1mb"
  })
);


/* =====================================================
   STATIC
===================================================== */

app.use(
  express.static(
    publicDir,
    {
      index: "index.html",
      extensions: ["html"]
    }
  )
);


/* =====================================================
   RATE LIMIT API
===================================================== */

const apiLimiter =
  rateLimit({
    windowMs:
      15 * 60 * 1000,

    max:
      30,

    standardHeaders:
      true,

    legacyHeaders:
      false,

    message: {
      error:
        "Terlalu banyak permintaan. Coba lagi beberapa menit."
    }
  });


app.use(
  "/api",
  apiLimiter
);


/* =====================================================
   PWA FILES
===================================================== */

app.get(
  "/manifest.json",
  (req, res) => {

    res.sendFile(
      path.join(
        publicDir,
        "manifest.json"
      )
    );

  }
);


app.get(
  "/sw.js",
  (req, res) => {

    res.sendFile(
      path.join(
        publicDir,
        "sw.js"
      )
    );

  }
);


app.get(
  "/icon-192.png",
  (req, res) => {

    res.sendFile(
      path.join(
        publicDir,
        "icon-192.png"
      )
    );

  }
);


app.get(
  "/icon-512.png",
  (req, res) => {

    res.sendFile(
      path.join(
        publicDir,
        "icon-512.png"
      )
    );

  }
);


/* =====================================================
   YOUTUBE ID
===================================================== */

function extractYouTubeId(
  input
) {

  const text =
    String(
      input || ""
    ).trim();


  if (
    /^[A-Za-z0-9_-]{11}$/.test(
      text
    )
  ) {

    return text;

  }


  let url;

  try {

    url =
      new URL(text);

  } catch {

    return null;

  }


  const host =
    url.hostname
      .toLowerCase()
      .replace(
        /^www\./,
        ""
      );


  /* youtu.be */

  if (
    host ===
    "youtu.be"
  ) {

    const id =
      url.pathname
        .split("/")
        .filter(Boolean)[0];


    return /^[A-Za-z0-9_-]{11}$/.test(
      id || ""
    )
      ? id
      : null;

  }


  /* YouTube */

  if (
    ![
      "youtube.com",
      "m.youtube.com",
      "music.youtube.com"
    ].includes(
      host
    )
  ) {

    return null;

  }


  /* watch?v= */

  if (
    url.pathname ===
    "/watch"
  ) {

    const id =
      url.searchParams.get(
        "v"
      );


    return id &&
      /^[A-Za-z0-9_-]{11}$/.test(
        id
      )
      ? id
      : null;

  }


  /* shorts / embed / live */

  const match =
    url.pathname.match(
      /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/
    );


  return match
    ? match[1]
    : null;

}


/* =====================================================
   NUMBER
===================================================== */

function cleanNumber(
  value,
  fallback
) {

  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
    : fallback;

}


/* =====================================================
   YT-DLP BASE ARGS
===================================================== */

function baseYtDlpArgs() {

  const args = [

    "--no-playlist",

    "--no-warnings",

    "--js-runtimes",
    "node",

    "--remote-components",
    "ejs:github",

    "--newline",

    "--extractor-args",
    "youtube:player_client=mweb,tv,web_safari;youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"

  ];


  if (
    process.env.YOUTUBE_COOKIES
  ) {

    args.push(
      "--cookies",
      process.env.YOUTUBE_COOKIES
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


  return args;

}


/* =====================================================
   RUN COMMAND
===================================================== */

function runCommand(
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

            env:
              process.env,

            stdio:
              [
                "ignore",
                "pipe",
                "pipe"
              ]
          }
        );


      let stdout = "";
      let stderr = "";


      child.stdout.on(
        "data",
        chunk => {

          stdout +=
            chunk.toString();

        }
      );


      child.stderr.on(
        "data",
        chunk => {

          stderr +=
            chunk.toString();

        }
      );


      child.on(
        "error",
        error => {

          reject(
            error
          );

        }
      );


      child.on(
        "close",
        code => {

          if (
            code === 0
          ) {

            resolve({
              stdout,
              stderr
            });

            return;

          }


          const error =
            new Error(
              `${command} berhenti dengan kode ${code}:\n${stderr || stdout}`
            );


          error.code =
            code;


          reject(
            error
          );

        }
      );

    }
  );

}


/* =====================================================
   GET VIDEO INFO
===================================================== */

async function getVideoInfo(
  videoId
) {

  const url =
    "https://www.youtube.com/watch?v=" +
    videoId;


  const args = [
    ...baseYtDlpArgs(),

    "--dump-single-json",

    "--skip-download",

    url
  ];


  const result =
    await runCommand(
      "yt-dlp",
      args
    );


  let info;


  try {

    info =
      JSON.parse(
        result.stdout
      );

  } catch {

    throw new Error(
      "Data video dari YouTube tidak dapat dibaca."
    );

  }


  const duration =
    Number(
      info.duration || 0
    );


  if (
    duration >
    MAX_VIDEO_DURATION_SECONDS
  ) {

    throw new Error(
      `Durasi video terlalu panjang. Maksimal ${Math.floor(MAX_VIDEO_DURATION_SECONDS / 3600)} jam.`
    );

  }


  const formats =
    Array.isArray(
      info.formats
    )
      ? info.formats
      : [];


  const heights =
    [
      ...new Set(
        formats
          .map(
            format =>
              Number(
                format.height
              )
          )
          .filter(
            height =>
              Number.isFinite(
                height
              ) &&
              height >=
                MIN_HEIGHT &&
              height <=
                MAX_HEIGHT
          )
      )
    ]
    .sort(
      (a, b) =>
        a - b
    );


  return {

    id:
      videoId,

    title:
      info.title ||
      "Video YouTube",

    thumbnail:
      info.thumbnail ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,

    duration,

    uploader:
      info.uploader ||
      info.channel ||
      "",

    heights,

    hasAudio:
      formats.some(
        format =>
          format.acodec &&
          format.acodec !==
            "none"
      )

  };

}


/* =====================================================
   API INFO
===================================================== */

app.post(
  "/api/info",
  async (
    req,
    res
  ) => {

    try {

      const body =
        req.body ||
        {};


      const input =
        body.url ||
        body.videoUrl ||
        body.videoId ||
        body.id ||
        "";


      const videoId =
        extractYouTubeId(
          input
        );


      if (!videoId) {

        return res
          .status(400)
          .json({
            error:
              "ID video tidak valid."
          });

      }


      console.log(
        "INFO REQUEST:",
        videoId
      );


      const info =
        await getVideoInfo(
          videoId
        );


      return res.json(
        info
      );


    } catch (
      error
    ) {

      console.error(
        "INFO ERROR:",
        error
      );


      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Gagal mengambil informasi video."
        });

    }

  }
);


/* =====================================================
   UNIQUE FILENAME
===================================================== */

function makeDownloadFilename(
  videoId,
  height
) {

  /*
   * PENTING:
   * Jangan gunakan video.mp4 lagi.
   *
   * Timestamp membuat setiap download
   * mempunyai nama file berbeda.
   */

  const safeId =
    String(
      videoId || "video"
    )
    .replace(
      /[^A-Za-z0-9_-]/g,
      "_"
    );


  const safeHeight =
    Number.isFinite(
      Number(height)
    )
      ? Number(height)
      : 0;


  const timestamp =
    Date.now();


  return (
    "VideoFetch_" +
    safeId +
    "_" +
    safeHeight +
    "p_" +
    timestamp +
    ".mp4"
  );

}


/* =====================================================
   CREATE DOWNLOAD
===================================================== */

async function createDownload(
  job
) {

  const outputDir =
    path.join(
      tempDir,
      job.id
    );


  fs.mkdirSync(
    outputDir,
    {
      recursive: true
    }
  );


  const outputTemplate =
    path.join(
      outputDir,
      "video.%(ext)s"
    );


  const height =
    Math.min(
      MAX_HEIGHT,
      Math.max(
        MIN_HEIGHT,
        Number(
          job.height || 360
        )
      )
    );


  const url =
    "https://www.youtube.com/watch?v=" +
    job.videoId;


  const args = [

    ...baseYtDlpArgs(),

    "-f",

    `bv*[height<=${height}]+ba/b[height<=${height}]/b`,

    "--merge-output-format",
    "mp4",

    "--remux-video",
    "mp4",

    "-o",
    outputTemplate,

    url

  ];


  console.log(
    "DOWNLOAD BODY:",
    {
      videoId:
        job.videoId,

      height
    }
  );


  console.log(
    "YOUTUBE_COOKIES:",
    process.env.YOUTUBE_COOKIES
      ? "aktif"
      : "tidak tersedia."
  );


  const result =
    await runCommand(
      "yt-dlp",
      args
    );


  console.log(
    "YT-DLP SELESAI:",
    result.stdout
  );


  const files =
    fs.readdirSync(
      outputDir
    );


  const mp4File =
    files.find(
      file =>
        file
          .toLowerCase()
          .endsWith(
            ".mp4"
          )
    );


  if (!mp4File) {

    throw new Error(
      "File MP4 tidak ditemukan setelah proses download."
    );

  }


  const filePath =
    path.join(
      outputDir,
      mp4File
    );


  job.filePath =
    filePath;


  job.filename =
    makeDownloadFilename(
      job.videoId,
      height
    );


  return filePath;

}


/* =====================================================
   START JOB
===================================================== */

async function processJob(
  job
) {

  if (
    activeDownloads >=
    MAX_CONCURRENT_DOWNLOADS
  ) {

    job.status =
      "queued";


    const wait =
      setInterval(
        async () => {

          if (
            job.status ===
            "cancelled"
          ) {

            clearInterval(
              wait
            );

            return;

          }


          if (
            activeDownloads <
            MAX_CONCURRENT_DOWNLOADS
          ) {

            clearInterval(
              wait
            );

            await startDownload(
              job
            );

          }

        },
        1000
      );


    return;

  }


  await startDownload(
    job
  );

}


/* =====================================================
   START DOWNLOAD
===================================================== */

async function startDownload(
  job
) {

  if (
    job.status ===
    "processing"
  ) {

    return;

  }


  activeDownloads++;


  job.status =
    "processing";


  job.startedAt =
    Date.now();


  try {

    await createDownload(
      job
    );


    job.status =
      "ready";


    job.finishedAt =
      Date.now();


  } catch (
    error
  ) {

    console.error(
      "DOWNLOAD ERROR:",
      error
    );


    job.status =
      "failed";


    job.error =
      error.message ||
      "Download gagal.";


    job.finishedAt =
      Date.now();

  } finally {

    activeDownloads--;

  }

}


/* =====================================================
   API DOWNLOAD
===================================================== */

app.post(
  "/api/download",
  async (
    req,
    res
  ) => {

    try {

      const body =
        req.body ||
        {};


      console.log(
        "DOWNLOAD BODY:",
        body
      );


      const input =
        body.url ||
        body.videoUrl ||
        body.videoId ||
        body.id ||
        "";


      const videoId =
        extractYouTubeId(
          input
        );


      if (!videoId) {

        return res
          .status(400)
          .json({
            error:
              "ID video tidak valid."
          });

      }


      let height =
        cleanNumber(
          body.height ??
          body.quality,
          360
        );


      height =
        Math.round(
          height
        );


      if (
        height <
        MIN_HEIGHT
      ) {

        height =
          MIN_HEIGHT;

      }


      if (
        height >
        MAX_HEIGHT
      ) {

        height =
          MAX_HEIGHT;

      }


      const jobId =
        crypto
          .randomBytes(
            12
          )
          .toString(
            "hex"
          );


      const job = {

        id:
          jobId,

        videoId,

        height,

        status:
          "queued",

        filePath:
          null,

        filename:
          null,

        error:
          null,

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


      processJob(
        job
      ).catch(
        error => {

          console.error(
            "JOB ERROR:",
            error
          );

          job.status =
            "failed";

          job.error =
            error.message ||
            "Download gagal.";

          activeDownloads =
            Math.max(
              0,
              activeDownloads - 1
            );

        }
      );


      return res.json({

        jobId

      });


    } catch (
      error
    ) {

      console.error(
        "DOWNLOAD API ERROR:",
        error
      );


      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Download gagal."
        });

    }

  }
);


/* =====================================================
   JOB STATUS
===================================================== */

app.get(
  "/api/jobs/:jobId",
  (
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
        .json({
          error:
            "Job tidak ditemukan."
        });

    }


    const response = {

      jobId:
        job.id,

      status:
        job.status

    };


    if (
      job.status ===
      "ready"
    ) {

      response.downloadUrl =
        "/api/jobs/" +
        encodeURIComponent(
          job.id
        ) +
        "/file";

    }


    if (
      job.status ===
      "failed"
    ) {

      response.error =
        job.error ||
        "Download gagal.";

    }


    return res.json(
      response
    );

  }
);


/* =====================================================
   DOWNLOAD FILE
===================================================== */

app.get(
  "/api/jobs/:jobId/file",
  (
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
          "Job tidak ditemukan."
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


    if (
      !job.filePath ||
      !fs.existsSync(
        job.filePath
      )
    ) {

      return res
        .status(404)
        .send(
          "File sudah tidak tersedia."
        );

    }


    /*
     * NAMA FILE BARU
     *
     * Tidak lagi:
     * video.mp4
     *
     * Sekarang:
     * VideoFetch_ID_640p_TIMESTAMP.mp4
     */

    const downloadName =
      job.filename ||
      makeDownloadFilename(
        job.videoId,
        job.height
      );


    res.download(
      job.filePath,
      downloadName,
      {
        headers: {
          "Cache-Control":
            "no-store, no-cache, must-revalidate"
        }
      },
      error => {

        if (error) {

          console.error(
            "FILE DOWNLOAD ERROR:",
            error
          );

        }

      }
    );

  }
);


/* =====================================================
   CLEANUP
===================================================== */

function cleanupJobs() {

  const now =
    Date.now();


  for (
    const [
      jobId,
      job
    ]
    of jobs
  ) {

    if (
      !job.finishedAt
    ) {

      continue;

    }


    if (
      now -
      job.finishedAt <
      FILE_TTL_MS
    ) {

      continue;

    }


    if (
      job.filePath
    ) {

      try {

        const dir =
          path.dirname(
            job.filePath
          );


        if (
          fs.existsSync(
            dir
          )
        ) {

          fs.rmSync(
            dir,
            {
              recursive:
                true,
              force:
                true
            }
          );

        }

      } catch (
        error
      ) {

        console.error(
          "CLEANUP ERROR:",
          error
        );

      }

    }


    jobs.delete(
      jobId
    );

  }

}


setInterval(
  cleanupJobs,
  5 * 60 * 1000
);


/* =====================================================
   HOME
===================================================== */

app.get(
  "*",
  (
    req,
    res,
    next
  ) => {

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {

      return next();

    }


    res.sendFile(
      path.join(
        publicDir,
        "index.html"
      )
    );

  }
);


/* =====================================================
   ERROR HANDLER
===================================================== */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "SERVER ERROR:",
      error
    );


    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }


    res
      .status(500)
      .json({
        error:
          "Terjadi kesalahan pada server."
      });

  }
);


/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Video Fetch berjalan di port ${PORT}`
    );

    console.log(
      "MAX_CONCURRENT_DOWNLOADS:",
      MAX_CONCURRENT_DOWNLOADS
    );

    console.log(
      "MAX_VIDEO_DURATION_SECONDS:",
      MAX_VIDEO_DURATION_SECONDS
    );

    console.log(
      "MAX_HEIGHT:",
      MAX_HEIGHT
    );

    console.log(
      "YOUTUBE_COOKIES:",
      process.env.YOUTUBE_COOKIES
        ? "aktif"
        : "tidak tersedia."
    );

  }
);
