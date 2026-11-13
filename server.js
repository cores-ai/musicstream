import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import yts from "yt-search";
import dotenv from "dotenv";

dotenv.config();

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 8080;
const VALID_API_KEY = process.env.API_KEY || "cores_secret_key_2026";

app.use(cors());
app.use(express.json());

// Token & Key verification middleware
function authMiddleware(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api || req.query.api_key;
  if (!VALID_API_KEY || key === VALID_API_KEY) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized: Invalid or missing API key" });
}

// Health check
app.get("/", (req, res) => {
  res.json({
    name: "Beatx Streaming API",
    status: "online",
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

// Helper: Resolve direct media stream via yt-dlp
async function extractDirectStreamUrl(target, isVideo = false) {
  const format = isVideo
    ? "best[ext=mp4]/best"
    : "bestaudio[ext=m4a]/bestaudio/best[height<=480]";

  const url = target.startsWith("http")
    ? target
    : `https://www.youtube.com/watch?v=${target}`;

  const { stdout } = await execFileAsync("yt-dlp", [
    "-f", format,
    "-g", // print direct stream url
    "--no-warnings",
    "--no-check-certificates",
    url
  ]);

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

    // Direct audio stream URL compatible with BeatxMusic Go client
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
// Allows 100% drop-in compatibility with the bot's existing downloadWithShruti handler!
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
