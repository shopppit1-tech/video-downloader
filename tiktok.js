"use strict";

/**
 * TikTok URL helper for Video Fetch.
 * Existing yt-dlp pipeline handles extraction and downloading.
 * A clean/no-watermark stream depends on what TikTok exposes for each video.
 */
function parseTikTokUrl(input) {
  const raw = input == null ? "" : String(input).trim();
  if (!raw) throw new Error("URL TikTok kosong.");

  let url;
  try { url = new URL(raw); }
  catch { throw new Error("URL TikTok tidak valid."); }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("URL TikTok harus menggunakan HTTP atau HTTPS.");
  }

  const host = url.hostname.toLowerCase();
  const allowed = host === "tiktok.com" || host.endsWith(".tiktok.com");
  if (!allowed) return null;

  return { platform: "tiktok", url: url.toString() };
}

module.exports = { parseTikTokUrl };
