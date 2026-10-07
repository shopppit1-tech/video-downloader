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
const publicDir = path.join(__dirname, "public");

const jobs = new Map();

let activeDownloads = 0;


/* =====================================================
   SERVER
===================================================== */

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "10kb"
  })
);

app.use(
  express.static(publicDir, {
    index: "index.html",
    extensions: ["html"]
  })
);


/* =====================================================
   PWA FILES
===================================================== */

app.get("/manifest.json", (req, res) => {
  res.sendFile(
    path.join(publicDir, "manifest.json")
  );
});

app.get("/sw.js", (req, res) => {
  res.setHeader(
    "Content-Type",
    "application/javascript"
  );

  res.sendFile(
    path.join(publicDir, "sw.js")
  );
});

app.get("/icon-192.png", (req, res) => {
  res.sendFile(
    path.join(publicDir, "icon-192.png")
  );
});

app.get("/icon-512.png", (req, res) => {
  res.sendFile(
    path.join(publicDir, "icon-512.png")
  );
});


/* =====================================================
   RATE LIMIT
===================================================== */

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false
  })
);


/* =====================================================
   URL PARSER
===================================================== */

function parseVideoUrl(input) {

  let url;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host =
    url.hostname
      .toLowerCase()
      .replace(/^www\./, "");

  /* =================================================
     YOUTUBE
  ================================================== */

  if (
    host === "youtu.be"
  ) {

    const id =
      url.pathname
        .slice(1)
        .split("/")[0];

    if (
      /^[A-Za-z0-9_-]{11}$/.test(id)
    ) {

      return {
        platform: "youtube",
        id,
        url: `https://www.youtube.com/watch?v=${id}`
      };

    }

    return null;
  }


  if (
    [
      "youtube.com",
      "m.youtube.com",
      "music.youtube.com"
    ].includes(host)
  ) {

    if (
      url.pathname === "/watch"
    ) {

      const id =
        url.searchParams.get("v");

      if (
        id &&
        /^[A-Za-z0-9_-]{11}$/.test(id)
      ) {

        return {
          platform: "youtube",
          id,
          url: `https://www.youtube.com/watch?v=${id}`
        };

      }

      return null;
    }


    const match =
      url.pathname.match(
        /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/
      );

    if (match) {

      return {
        platform: "youtube",
        id: match[1],
        url: `https://www.youtube.com/watch?v=${match[1]}`
      };

    }

    return null;
  }


  /* =================================================
     FACEBOOK
  ================================================== */

  if (
    host === "fb.watch"
  ) {

    const id =
      url.pathname
        .split("/")
        .filter(Boolean)[0];

    if (id) {

      return {
        platform: "facebook",
        id,
        url: input
      };

    }

    return {
      platform: "facebook",
      id: "facebook",
      url: input
    };
  }


  if (
    [
      "facebook.com",
      "m.facebook.com",
      "mbasic.facebook.com",
      "web.facebook.com"
    ].includes(host)
  ) {

    const pathname =
      url.pathname;


    /*
      Contoh:
      /watch/?v=123456
    */

    const watchId =
      url.searchParams.get("v");

    if (
      pathname === "/watch" ||
      pathname === "/watch/"
    ) {

      return {
        platform: "facebook",
        id: watchId || "facebook",
        url: input
      };

    }


    /*
      Contoh:
      /123456/videos/987654/
    */

    if (
      pathname.includes("/videos/")
    ) {

      const match =
        pathname.match(
          /\/videos\/(\d+)/
        );

      return {
        platform: "facebook",
        id:
          match
            ? match[1]
            : "facebook",
        url: input
      };

    }


    /*
      Contoh:
      /reel/123456/
    */

    if (
      pathname.includes("/reel/")
    ) {

      const match =
        pathname.match(
          /\/reel\/(\d+)/
        );

      return {
        platform: "facebook",
        id:
          match
            ? match[1]
            : "facebook",
        url: input
      };

    }


    /*
      Contoh:
      /share/v/xxxxx/
    */

    if (
      pathname.includes("/share/")
    ) {

      return {
        platform: "facebook",
        id: "facebook",
        url: input
      };

    }


    /*
      Video URL lain dari Facebook
    */

    if (
      pathname.includes("/video")
    ) {

      return {
        platform: "facebook",
        id: "facebook",
        url: input
      };

    }

    return null;
  }


  return null;
}


/* =====================================================
   COMMAND RUNNER
===================================================== */

function run(command, args) {

  return new Promise(
    (resolve, reject) => {

      const child =
        spawn(
          command,
          args,
          {
            windowsHide: true,
            env: {
              ...process.env
            }
          }
        );


      let stdout = "";

      let stderr = "";


      child.stdout?.on(
        "data",
        chunk => {
          stdout +=
            chunk.toString();
        }
      );


      child.stderr?.on(
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
            new Error(
              `${command} tidak tersedia: ${error.message}`
            )
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

          } else {

            reject(
              new Error(
                `${command} berhenti dengan kode ${code}: ${stderr.slice(-5000)}`
              )
            );

          }

        }
      );

    }
  );

}


/* =====================================================
   COOKIE YOUTUBE
===================================================== */

async function setupCookies() {

  const cookies =
    String(
      process.env.YOUTUBE_COOKIES || ""
    ).trim();


  if (!cookies) {

    console.log(
      "YOUTUBE_COOKIES tidak tersedia."
    );

    return null;
  }


  await fsp.mkdir(
    tempDir,
    {
      recursive: true
    }
  );


  const cookieFile =
    path.join(
      tempDir,
      "youtube-cookies.txt"
    );


  await fsp.writeFile(
    cookieFile,
    cookies.endsWith("\n")
      ? cookies
      : `${cookies}\n`,
    "utf8"
  );


  console.log(
    "YOUTUBE_COOKIES aktif."
  );


  return cookieFile;
}


/* =====================================================
   BASE YT-DLP ARGS
===================================================== */

async function baseYtDlpArgs(
  platform
) {

  const args = [

    "--no-playlist",

    "--no-warnings",

    "--js-runtimes",
    "node",

    "--remote-components",
    "ejs:github",

    "--no-check-certificates",

    "--geo-bypass",

    "--newline"

  ];


  /*
    Cookie hanya dipasang jika tersedia.
  */

  const cookieFile =
    await setupCookies();


  if (
    cookieFile
  ) {

    args.push(
      "--cookies",
      cookieFile
    );


    /*
      Extractor YouTube
      hanya untuk YouTube.
    */

    if (
      platform === "youtube"
    ) {

      args.push(
        "--extractor-args",
        "youtube:player_client=default,web_embedded"
      );

    }

  } else {

    if (
      platform === "youtube"
    ) {

      args.push(
        "--extractor-args",
        "youtube:player_client=tv,web_embedded"
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


  return args;
}


/* =====================================================
   PUBLIC VIDEO INFO
===================================================== */

function publicVideoInfo(
  info,
  platform
) {

  const formats =
    Array.isArray(
      info.formats
    )
      ? info.formats
      : [];


  const heights = [

    ...new Set(

      formats

        .filter(
          f =>
            f.vcodec &&
            f.vcodec !== "none" &&
            Number.isFinite(
              Number(f.height)
            )
        )

        .map(
          f =>
            Number(f.height)
        )

    )

  ]

  .sort(
    (a, b) => b - a
  )

  .slice(
    0,
    12
  );


  return {

    id:
      info.id || null,

    platform,

    title:
      info.title ||
      "video",

    thumbnail:
      info.thumbnail ||
      null,

    duration:
      Number(
        info.duration || 0
      ),

    uploader:
      info.uploader ||
      info.channel ||
      null,

    heights,

    hasAudio:
      formats.some(
        f =>
          f.acodec &&
          f.acodec !== "none"
      )

  };

}


/* =====================================================
   REMOVE FILE
===================================================== */

async function removeFile(
  filePath
) {

  if (!filePath) {
    return;
  }


  await fsp.rm(
    filePath,
    {
      force: true
    }
  ).catch(
    error => {

      console.error(
        "Gagal menghapus file:",
        error.message
      );

    }
  );

}


/* =====================================================
   DELETE JOB
===================================================== */

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

        jobs.delete(
          jobId
        );

      },
      fileTtlMs
    );


  timer.unref();

}


/* =====================================================
   INSPECT VIDEO
===================================================== */

async function inspectVideo(
  video
) {

  const baseArgs =
    await baseYtDlpArgs(
      video.platform
    );


  const args = [

    ...baseArgs,

    "--dump-single-json",

    "--skip-download",

    video.url

  ];


  const {
    stdout
  } =
    await run(
      "yt-dlp",
      args
    );


  return JSON.parse(
    stdout
  );

}


/* =====================================================
   CREATE DOWNLOAD
===================================================== */

async function createDownload(
  jobId,
  video,
  requestedHeight
) {

  const job =
    jobs.get(
      jobId
    );


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


    const outputTemplate =
      path.join(
        tempDir,
        `${jobId}.%(ext)s`
      );


    const format = [

      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,

      `bv*[height<=${height}]+ba`,

      `b[height<=${height}]`,

      "b"

    ].join("/");


    const baseArgs =
      await baseYtDlpArgs(
        video.platform
      );


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

      video.url

    ];


    console.log(
      `DOWNLOAD ${video.platform}: ${video.url}`
    );


    await run(
      "yt-dlp",
      args
    );


    const candidates =
      await fsp.readdir(
        tempDir
      );


    const generatedName =
      candidates.find(
        name =>
          name.startsWith(
            `${jobId}.`
          ) &&
          !name.endsWith(
            ".part"
          ) &&
          !name.endsWith(
            ".ytdl"
          )
      );


    if (!generatedName) {

      throw new Error(
        "File hasil pemrosesan tidak ditemukan."
      );

    }


    const filePath =
      path.join(
        tempDir,
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
      fileTtlMs;


    scheduleDeletion(
      jobId,
      filePath
    );


  } catch (
    error
  ) {

    job.status =
      "failed";


    if (
      video.platform ===
      "facebook"
    ) {

      job.error =
        "Video Facebook tidak dapat diproses. Pastikan URL publik dan video dapat diakses tanpa login.";

    } else {

      job.error =
        "Video tidak dapat diproses. YouTube mungkin meminta autentikasi atau memblokir server.";

    }


    console.error(
      `[${video.platform}] ${video.url}`,
      error.message
    );


  } finally {

    activeDownloads -= 1;

  }

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

    const input =
      String(
        req.body?.url || ""
      ).trim();


    const video =
      parseVideoUrl(
        input
      );


    if (!video) {

      return res
        .status(400)
        .json({
          error:
            "URL YouTube atau Facebook tidak valid."
        });

    }


    console.log(
      `INFO ${video.platform}: ${video.url}`
    );


    try {

      const info =
        await inspectVideo(
          video
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
              `Durasi video melebihi batas ${Math.round(maxVideoDuration / 60)} menit.`
          });

      }


      return res.json(
        publicVideoInfo(
          info,
          video.platform
        )
      );


    } catch (
      error
    ) {

      console.error(
        `ERROR [${video.platform}]: ${error.message}`
      );


      if (
        video.platform ===
        "facebook"
      ) {

        return res
          .status(422)
          .json({
            error:
              "Video Facebook tidak dapat diambil. Pastikan video bersifat publik dan URL masih aktif."
          });

      }


      return res
        .status(422)
        .json({
          error:
            "Informasi video tidak dapat diambil. YouTube mungkin memblokir server atau meminta autentikasi."
        });

    }

  }
);


/* =====================================================
   API DOWNLOAD
===================================================== */

app.post(
  "/api/download",
  (
    req,
    res
  ) => {

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


    const input =
      String(
        req.body?.url || ""
      ).trim();


    const video =
      parseVideoUrl(
        input
      );


    if (!video) {

      return res
        .status(400)
        .json({
          error:
            "URL YouTube atau Facebook tidak valid."
        });

    }


    const height =
      Number(
        req.body?.height ||
        1080
      );


    const jobId =
      crypto.randomUUID();


    jobs.set(
      jobId,
      {
        status:
          "processing",

        platform:
          video.platform,

        videoId:
          video.id,

        url:
          video.url,

        createdAt:
          Date.now(),

        filePath:
          null
      }
    );


    activeDownloads += 1;


    void createDownload(
      jobId,
      video,
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

      downloadUrl:
        job.status === "ready"
          ? `/api/jobs/${req.params.jobId}/file`
          : null

    });

  }
);


/* =====================================================
   FILE DOWNLOAD
===================================================== */

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


    if (
      !job ||
      job.status !== "ready" ||
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


    const prefix =
      job.platform === "facebook"
        ? "VideoFetch_FB"
        : "VideoFetch_YT";


    res.download(

      job.filePath,

      `${prefix}_${job.videoId}_${job.jobId || req.params.jobId}.mp4`,

      async error => {

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
      ]
      of jobs
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
   START
===================================================== */

async function start() {

  await fsp.mkdir(
    tempDir,
    {
      recursive: true
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
  error => {

    console.error(
      error
    );

    process.exit(1);

  }
);
