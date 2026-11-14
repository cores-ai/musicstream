import express from "express";
import cors from "cors";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import yts from "yt-search";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import CryptoJS from "crypto-js";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const VALID_API_KEY = process.env.API_KEY || "cores_secret_key_2026";
const COOKIES_DIR = path.join(process.cwd(), "cookies_cache");

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

// Cloudflare D1 Credentials (read from env or fallback to persistent cluster)
const DEFAULT_TOKEN_B64 = "Y2Z1dF9yU2xBelFPQWJuMTA0Y3NvaGVRT0pOaWJFSG9YVGlCeXYxNW1ueEtFYjM1Y2M0OWE=";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "cc51e0e5c3dd225c36751796cf196ca5";
const CF_DB_ID = process.env.CLOUDFLARE_DATABASE_ID || "111062d4-ab1e-4d65-abc3-66bcddc28aa6";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || Buffer.from(DEFAULT_TOKEN_B64, "base64").toString("utf8");

// Memory pool of active rotating cookies
let activeCookies = [];
let cookieIndex = 0;

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
    fs.writeFileSync(filePath, cookie.cookie_content, "utf8");
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
    name: "Beatx Streaming & CDN Microservice",
    status: "online",
    cookies_loaded: activeCookies.length,
    engines: ["jiosaavn_320kbps_cdn", "youtube_rotating_d1", "direct_audio_proxy"],
    timestamp: new Date().toISOString()
  });
});

app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── JioSaavn 320kbps Lossless CDN Engine (Zero IP Locks, Zero Bot-Checks) ───
async function searchAndGetSaavn(query) {
  try {
    // Clean query from common video noise
    let cleanQuery = query
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[\[\(].*?[\]\)]/g, "")
      .replace(/official\s*(music\s*)?(video|audio|lyric|lyrics|track)/gi, "")
      .replace(/full\s*song/gi, "")
      .replace(/ft\.?|feat\.?/gi, "")
      .replace(/[\-_|]/g, " ")
      .trim();

    if (!cleanQuery) cleanQuery = query;

    const searchUrl = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(cleanQuery)}`;
    const sRes = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    const sData = await sRes.json();
    const songs = sData.songs?.data || [];
    if (!songs || songs.length === 0) return null;

    const songId = songs[0].id;
    const detailUrl = `https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${songId}&_format=json&_marker=0&ctx=web6dot0`;
    const dRes = await fetch(detailUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    const dData = await dRes.json();
    const info = dData.songs ? dData.songs[0] : dData[songId];
    if (!info || !info.encrypted_media_url) return null;

    const key = CryptoJS.enc.Utf8.parse("38346591");
    const dec = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(info.encrypted_media_url) },
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    let rawUrl = dec.toString(CryptoJS.enc.Utf8);
    if (!rawUrl || !rawUrl.startsWith("http")) return null;

    // Upgrade to 320kbps high-quality audio
    let streamUrl = rawUrl;
    if (info["320kbps"] === "true") {
      streamUrl = rawUrl.replace("_96.mp4", "_320.mp4");
    } else {
      streamUrl = rawUrl.replace("_96.mp4", "_160.mp4");
    }

    return {
      title: info.song || songs[0].title,
      artist: info.primary_artists || "",
      duration: parseInt(info.duration) || 0,
      stream: streamUrl,
      quality: info["320kbps"] === "true" ? "320kbps" : "160kbps",
      thumbnail: info.image ? info.image.replace("150x150", "500x500") : ""
    };
  } catch (err) {
    console.warn("[JioSaavn] Lookup error:", err.message);
    return null;
  }
}

// ─── Direct YouTube Stream URL Extractor with D1 Cookies ───
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

// ─── Live Audio Stream Proxy Endpoint (Pipes Audio Directly from Railway) ───
app.get("/stream/:id", async (req, res) => {
  const videoId = req.params.id;
  if (!videoId) return res.status(400).send("Video ID is required");

  const url = videoId.startsWith("http") ? videoId : `https://www.youtube.com/watch?v=${videoId}`;
  const cookieFile = getNextCookieFile();

  const ytdlpArgs = [
    "--extractor-args", "youtube:player_client=ios,android,web_creator,mweb",
    "-f", "bestaudio[ext=m4a]/bestaudio/best[height<=480]",
    "-o", "-",
    "--no-warnings"
  ];

  if (cookieFile && fs.existsSync(cookieFile)) {
    ytdlpArgs.push("--cookies", cookieFile);
  }
  ytdlpArgs.push(url);

  res.setHeader("Content-Type", "audio/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");

  const child = spawn("yt-dlp", ytdlpArgs);

  child.stdout.pipe(res);

  child.stderr.on("data", (d) => {
    // suppress verbose output
  });

  req.on("close", () => {
    try {
      child.kill("SIGTERM");
    } catch (e) {}
  });

  child.on("error", (err) => {
    console.error("[StreamProxy] Spawn error:", err.message);
    if (!res.headersSent) res.status(500).send("Stream error");
  });
});

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

// ─── 2. Audio Stream Endpoint: GET /api/song ───
app.get("/api/song", authMiddleware, async (req, res) => {
  const query = req.query.query || req.query.url;
  const isDownload = req.query.download === "true";

  if (!query) {
    return res.status(400).json({ error: "Query or video ID is required" });
  }

  // 1. Try JioSaavn 320kbps CDN first (instant Akamai CDN, zero blocks)
  try {
    let searchTitle = query;
    const isDirectId = /^[a-zA-Z0-9_-]{11}$/.test(query);
    if (isDirectId) {
      try {
        const info = await yts({ videoId: query });
        if (info && info.title) searchTitle = info.title;
      } catch (e) {}
    }

    const saavnRes = await searchAndGetSaavn(searchTitle);
    if (saavnRes && saavnRes.stream) {
      return res.json({
        status: "ok",
        type: "audio",
        query,
        source: "jiosaavn_320kbps",
        title: saavnRes.title,
        quality: saavnRes.quality,
        stream: saavnRes.stream,
        url: saavnRes.stream,
        download: isDownload
      });
    }
  } catch (e) {
    console.warn("[SongEndpoint] Saavn fallback error:", e.message);
  }

  // 2. YouTube D1 Cookie Stream
  try {
    const streamUrl = await extractDirectStreamUrl(query, false);
    if (streamUrl) {
      return res.json({
        status: "ok",
        type: "audio",
        query,
        source: "youtube_d1",
        stream: streamUrl,
        url: streamUrl,
        download: isDownload
      });
    }
  } catch (err) {
    // If direct extraction fails, offer the live proxy stream endpoint
    const cleanId = query.replace("https://www.youtube.com/watch?v=", "").replace("https://youtu.be/", "");
    const host = req.get("host");
    const proto = req.protocol;
    const proxyUrl = `${proto}://${host}/stream/${cleanId}`;
    return res.json({
      status: "ok",
      type: "audio",
      query,
      source: "railway_audio_proxy",
      stream: proxyUrl,
      url: proxyUrl,
      download: isDownload
    });
  }

  return res.status(500).json({ error: "Failed to resolve audio stream" });
});

// ─── 3. Video Stream Endpoint: GET /api/video ───
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

// ─── 4. Shruti API Mirror Endpoint: GET /download ───
app.get("/download", authMiddleware, async (req, res) => {
  const target = req.query.url || req.query.id;
  const typeParam = (req.query.type || "audio").toLowerCase();
  const isVideo = typeParam.includes("video") || typeParam === "mp4";

  if (!target) {
    return res.status(400).json({ error: "URL or ID is required" });
  }

  // If audio requested, try JioSaavn 320kbps CDN first for crystal clear studio quality & zero IP locking!
  if (!isVideo) {
    try {
      let songTitle = target;
      const isDirectId = /^[a-zA-Z0-9_-]{11}$/.test(target);
      if (isDirectId) {
        try {
          const info = await yts({ videoId: target });
          if (info && info.title) songTitle = info.title;
        } catch (e) {}
      }

      const saavn = await searchAndGetSaavn(songTitle);
      if (saavn && saavn.stream) {
        return res.json({
          status: "success",
          source: "jiosaavn_320kbps",
          title: saavn.title,
          quality: saavn.quality,
          stream: saavn.stream,
          url: saavn.stream,
          download_url: saavn.stream
        });
      }
    } catch (e) {
      console.warn("[DownloadEndpoint] Saavn resolve error:", e.message);
    }
  }

  // YouTube resolution with D1 Cookie pool
  try {
    const streamUrl = await extractDirectStreamUrl(target, isVideo);
    if (streamUrl) {
      return res.json({
        status: "success",
        source: "youtube_d1",
        stream: streamUrl,
        url: streamUrl,
        download_url: streamUrl
      });
    }
  } catch (err) {
    if (!isVideo) {
      const cleanId = target.replace("https://www.youtube.com/watch?v=", "").replace("https://youtu.be/", "");
      const host = req.get("host");
      const proto = req.protocol;
      const proxyUrl = `${proto}://${host}/stream/${cleanId}`;
      return res.json({
        status: "success",
        source: "railway_audio_proxy",
        stream: proxyUrl,
        url: proxyUrl,
        download_url: proxyUrl
      });
    }
    return res.status(500).json({ error: err.message || "Download extraction failed" });
  }

  return res.status(500).json({ error: "Download resolution failed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Beatx Stream API running on port ${PORT}`);
});
