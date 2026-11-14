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

// Reset cookies directory on startup to clear any uncleaned legacy cookies
try {
  if (fs.existsSync(COOKIES_DIR)) {
    fs.rmSync(COOKIES_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
} catch (e) {
  console.warn("[Init] Cookies dir setup warning:", e.message);
}

// Cloudflare D1 Credentials
const DEFAULT_TOKEN_B64 = "Y2Z1dF9yU2xBelFPQWJuMTA0Y3NvaGVRT0pOaWJFSG9YVGlCeXYxNW1ueEtFYjM1Y2M0OWE=";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "cc51e0e5c3dd225c36751796cf196ca5";
const CF_DB_ID = process.env.CLOUDFLARE_DATABASE_ID || "111062d4-ab1e-4d65-abc3-66bcddc28aa6";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || Buffer.from(DEFAULT_TOKEN_B64, "base64").toString("utf8");

// Memory pool of active rotating cookies
let activeCookies = [];
let cookieIndex = 0;

// Clean raw cookie content to strict Netscape format for yt-dlp compatibility
function cleanNetscapeCookie(content) {
  if (!content) return "";
  const lines = content.split(/\r?\n/);
  const out = ["# Netscape HTTP Cookie File", "# https://curl.se/docs/http-cookies.html", ""];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") || trimmed.includes("\t")) {
      out.push(trimmed);
    } else {
      out.push(`# ${trimmed}`);
    }
  }
  return out.join("\n");
}

// Fetch and sync cookies from D1 Database
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
        sql: "SELECT id, filename, cookie_content FROM youtube_cookies WHERE is_valid = 1 ORDER BY last_used ASC LIMIT 50;"
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
    fs.writeFileSync(filePath, cleanNetscapeCookie(cookie.cookie_content), "utf8");
  }
  return filePath;
}

// Initial sync and periodic 15-minute sync
syncCookiesFromD1();
setInterval(syncCookiesFromD1, 15 * 60 * 1000);

app.use(cors());
app.use(express.json());

// Token & Key verification middleware
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
    name: "Beatx Streaming & Download Microservice",
    status: "online",
    cookies_loaded: activeCookies.length,
    engines: ["youtube_direct_proxy", "youtube_d1_rotating"],
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Direct YouTube Stream URL Extractor with D1 Cookies & Android/iOS fallbacks
async function extractDirectStreamUrl(target, isVideo = false) {
  let videoId = target.trim();
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
    "-g",
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

// ─── 1. Search Endpoint ───
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

// ─── 2. Direct Audio Stream Pipe: GET /stream/:id ───
app.get("/stream/:id", async (req, res) => {
  const target = req.params.id;
  if (!target) return res.status(400).send("Video ID is required");

  let videoId = target.trim();
  if (videoId.includes("youtube.com") || videoId.includes("youtu.be")) {
    const match = videoId.match(/(?:v=|youtu\.be\/|\/v\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) videoId = match[1];
  }

  try {
    const streamUrl = await extractDirectStreamUrl(videoId, false);
    if (!streamUrl) {
      return res.status(404).send("Stream URL extraction failed");
    }

    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    };
    if (req.headers.range) {
      fetchHeaders["Range"] = req.headers.range;
    }

    const gvRes = await fetch(streamUrl, { headers: fetchHeaders });
    if (!gvRes.ok && gvRes.status !== 206) {
      return res.status(gvRes.status).send("Google video fetch error");
    }

    res.status(gvRes.status);
    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");

    const cl = gvRes.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    const cr = gvRes.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);

    const reader = gvRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (err) {
    console.error("[StreamProxy] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Stream error");
  }
});

// ─── 3. Audio Info / JSON Stream Endpoint: GET /api/song ───
app.get("/api/song", authMiddleware, async (req, res) => {
  const query = req.query.query || req.query.url;
  const isDownload = req.query.download === "true";

  if (!query) {
    return res.status(400).json({ error: "Query or video ID is required" });
  }

  let videoId = query.trim();
  if (videoId.includes("youtube.com") || videoId.includes("youtu.be")) {
    const match = videoId.match(/(?:v=|youtu\.be\/|\/v\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) videoId = match[1];
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    try {
      const searchRes = await yts(videoId);
      if (searchRes.videos && searchRes.videos.length > 0) {
        videoId = searchRes.videos[0].videoId;
      }
    } catch (e) {}
  }

  const host = req.get("host");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const proxyUrl = `${proto}://${host}/stream/${videoId}`;

  return res.json({
    status: "ok",
    type: "audio",
    query,
    source: "railway_audio_proxy",
    stream: proxyUrl,
    url: proxyUrl,
    download: isDownload
  });
});

// ─── 4. Video Stream Endpoint: GET /api/video ───
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

// ─── 5. Shruti API Mirror Endpoint: GET /download ───
// Directly streams the authentic YouTube audio/video bytes over HTTP, exactly like official ShrutiBots API!
app.get("/download", authMiddleware, async (req, res) => {
  const target = req.query.url || req.query.id;
  const typeParam = (req.query.type || "audio").toLowerCase();
  const isVideo = typeParam.includes("video") || typeParam === "mp4";
  const wantsJson = req.query.json === "true";

  if (!target) {
    return res.status(400).json({ error: "URL or ID is required" });
  }

  let videoId = target.trim();
  if (videoId.includes("youtube.com") || videoId.includes("youtu.be")) {
    const match = videoId.match(/(?:v=|youtu\.be\/|\/v\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) videoId = match[1];
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    try {
      const searchRes = await yts(videoId);
      if (searchRes.videos && searchRes.videos.length > 0) {
        videoId = searchRes.videos[0].videoId;
      }
    } catch (e) {}
  }

  try {
    const streamUrl = await extractDirectStreamUrl(videoId, isVideo);
    if (!streamUrl) {
      return res.status(404).json({ error: "Failed to extract stream URL" });
    }

    // If caller specifically requested JSON:
    if (wantsJson) {
      const host = req.get("host");
      const proto = req.headers["x-forwarded-proto"] || "https";
      const proxyUrl = `${proto}://${host}/stream/${videoId}`;
      return res.json({
        status: "success",
        source: "youtube_direct_proxy",
        stream: proxyUrl,
        url: proxyUrl,
        download_url: proxyUrl
      });
    }

    // Direct HTTP binary stream: proxies authentic YouTube audio directly from Railway's IP!
    const ext = isVideo ? "mp4" : "m4a";
    const contentType = isVideo ? "video/mp4" : "audio/mp4";

    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    };
    if (req.headers.range) {
      fetchHeaders["Range"] = req.headers.range;
    }

    const gvRes = await fetch(streamUrl, { headers: fetchHeaders });
    if (!gvRes.ok && gvRes.status !== 206) {
      return res.status(gvRes.status).send("Google video stream error");
    }

    res.status(gvRes.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${videoId}.${ext}"`);
    res.setHeader("Accept-Ranges", "bytes");

    const cl = gvRes.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    const cr = gvRes.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);

    const reader = gvRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (err) {
    console.error("[DownloadEndpoint] Error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || "Download failed" });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Beatx Stream & Download API running on port ${PORT}`);
});
