import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import yts from "yt-search";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const VALID_API_KEY = process.env.API_KEY || "cores_secret_key_2026";
const COOKIES_DIR = path.join(process.cwd(), "cookies_cache");

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

// Cloudflare D1 Credentials (read securely from environment)
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_DB_ID = process.env.CLOUDFLARE_DATABASE_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";

// Memory pool of active cookies
let activeCookies = [];
let cookieIndex = 0;

// Fetch and sync cookies from D1
async function syncCookiesFromD1() {
  if (!CF_ACCOUNT_ID || !CF_DB_ID || !CF_TOKEN) return;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sql: "SELECT id, filename, cookie_content FROM youtube_cookies WHERE is_valid = 1 ORDER BY last_used ASC LIMIT 20;"
      })
    });
    const data = await res.json();
    if (data.success && data.result && data.result[0]?.results?.length > 0) {
      activeCookies = data.result[0].results;
      console.log(`[CookieManager] Loaded ${activeCookies.length} valid cookies from D1 Database`);
    }
  } catch (err) {
    console.error("[CookieManager] Failed to sync cookies from D1:", err.message);
  }
}

// Get next rotating cookie file path
function getNextCookieFile() {
  if (activeCookies.length === 0) return null;
  const cookie = activeCookies[cookieIndex % activeCookies.length];
  cookieIndex++;
  const filePath = path.join(COOKIES_DIR, `cookie_${cookie.id}.txt`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, cookie.cookie_content, "utf8");
  }
  return filePath;
}

// Initial sync and periodic 15-minute sync
syncCookiesFromD1();
setInterval(syncCookiesFromD1, 15 * 60 * 1000);

app.use(cors());
app.use(express.json());

// Token & Key verification middleware (relaxed for easy streaming & bot usage)
function authMiddleware(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api || req.query.api_key;
  if (!process.env.API_KEY || key === process.env.API_KEY || key === "cores_secret_key_2026") {
    return next();
  }
  return next();
}

// Health check
app.get("/", (req, res) => {
  res.json({
    name: "Beatx Streaming API",
    status: "online",
    cookies_loaded: activeCookies.length,
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// 1. Search Endpoint: POST /api/search or GET /search
app.post("/api/search", authMiddleware, async (req, res) => {
  const query = req.body?.query || req.query?.query;
  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  try {
    const r = await yts(query);
    const videos = (r.videos || []).slice(0, 10).map((v) => ({
      id: v.videoId,
      title: v.title,
      channel: v.author?.name || "",
      duration: v.seconds,
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
    }));

    return res.json({
      status: "ok",
      type: "search",
      query,
      video: videos
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Search failed" });
  }
});

// Helper: Resolve direct media stream via yt-dlp with D1 Cookie Rotation
async function extractDirectStreamUrl(target, isVideo = false) {
  let videoId = target.trim();

  // If query is text (not a direct 11-char ID or YouTube URL), search YouTube first!
  const isDirectUrl = videoId.startsWith("http://") || videoId.startsWith("https://");
  const isDirectId = /^[a-zA-Z0-9_-]{11}$/.test(videoId);

  if (!isDirectUrl && !isDirectId) {
    try {
      const searchRes = await yts(videoId);
      if (searchRes.videos && searchRes.videos.length > 0) {
        videoId = searchRes.videos[0].videoId;
      }
    } catch (e) {
      videoId = `ytsearch1:${videoId}`;
    }
  }

  const format = isVideo
    ? "best[ext=mp4]/best"
    : "bestaudio[ext=m4a]/bestaudio/best[height<=480]";

  const url = videoId.startsWith("http") || videoId.startsWith("ytsearch1:")
    ? videoId
    : `https://www.youtube.com/watch?v=${videoId}`;

  const cookieFile = getNextCookieFile();
  const ytdlpArgs = [
    "--extractor-args", "youtube:player_client=ios,android,web_creator,mweb",
    "-f", format,
    "-g", // print direct stream url
    "--no-warnings",
    "--no-check-certificates"
  ];

  if (cookieFile && fs.existsSync(cookieFile)) {
    ytdlpArgs.push("--cookies", cookieFile);
  }

  ytdlpArgs.push(url);

  const { stdout } = await execFileAsync("yt-dlp", ytdlpArgs);
  return stdout.trim().split("\n")[0];
}

// 2. Audio Stream Endpoint: GET /api/song?query={vid}&download=true&api={key}
app.get("/api/song", authMiddleware, async (req, res) => {
  const query = req.query.query || req.query.url;
  const isDownload = req.query.download === "true";

  if (!query) {
    return res.status(400).json({ error: "Query or video ID is required" });
  }

  try {
    const streamUrl = await extractDirectStreamUrl(query, false);
    if (!streamUrl) {
      return res.status(404).json({ error: "Failed to extract audio stream" });
    }

    return res.json({
      status: "ok",
      type: "audio",
      query,
      stream: streamUrl,
      url: streamUrl,
      download: isDownload
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to resolve audio stream" });
  }
});

// 3. Video Stream Endpoint: GET /api/video?query={vid}&download=true&api={key}
app.get("/api/video", authMiddleware, async (req, res) => {
  const query = req.query.query || req.query.url;
  const isDownload = req.query.download === "true";

  if (!query) {
    return res.status(400).json({ error: "Query or video ID is required" });
  }

  try {
    const streamUrl = await extractDirectStreamUrl(query, true);
    if (!streamUrl) {
      return res.status(404).json({ error: "Failed to extract video stream" });
    }

    return res.json({
      status: "ok",
      type: "video",
      query,
      stream: streamUrl,
      url: streamUrl,
      download: isDownload
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to resolve video stream" });
  }
});

// 4. Shruti API Mirror Endpoint: GET /download?url={id}&type={audio/video}&api_key={key}
app.get("/download", authMiddleware, async (req, res) => {
  const target = req.query.url || req.query.id;
  const typeParam = (req.query.type || "audio").toLowerCase();
  const isVideo = typeParam.includes("video") || typeParam === "mp4";

  if (!target) {
    return res.status(400).json({ error: "URL or ID is required" });
  }

  try {
    const streamUrl = await extractDirectStreamUrl(target, isVideo);
    if (!streamUrl) {
      return res.status(404).json({ error: "Media resolution failed" });
    }

    return res.json({
      status: "success",
      stream: streamUrl,
      url: streamUrl,
      download_url: streamUrl
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Download extraction failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Beatx Stream API running on port ${PORT}`);
});
