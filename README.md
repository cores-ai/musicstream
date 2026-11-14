# ⚡ Beats Stream API

> **Engine:** Beats Stream • **Author:** dev by iq4u8  
> **Direct Running Mode** • **Zero Database** • **Plug & Play Cookies** • **Telegram Bot Ready**

A high-performance media demuxing API to **search YouTube** and **stream audio & video** at ultra-low latency — powered by [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`.

---

## ✨ Features

- ⚡ **Direct Running**: No database or login required. Instant out-of-the-box operation.
- 🤖 **Telegram Bot Native**: Zero-transcoding stream pipeline compatible with `libntgcalls` / PyTgCalls.
- 🍪 **Plug & Play Cookies**: Safely share the repository without cookies. Simply add your own `cookies.txt` or set `YOUTUBE_COOKIES` in `.env` to work instantly.
- 🔍 **Search**: Search YouTube videos by song title.
- 🎧 **Audio Stream & Download**: Extracts high-fidelity audio (320kbps Opus / M4A).
- 🎬 **Video Download**: Configurable max quality (`144p`–`1080p`/`2160p`), auto-merged with audio via FFmpeg.
- 🎵 **Spotify Support**: Spotify track links are automatically resolved to YouTube matches.
- 🌐 **Multi-Strategy Fallback**: Gracefully falls back across YouTube clients (`android`, `visionos`, `web_embedded`) if blocked.
- ⚡ **Disk Caching**: Previously downloaded audio and video files are cached and served instantly.

---

## 🍪 How to Add Cookies (1-Step Setup)

When sharing or receiving this codebase, YouTube cookies can be added in either of two easy ways:

### Method 1: Drop `cookies.txt` (Recommended for Local & Docker)
1. Export your YouTube cookies in Netscape format using browser extensions like **Get cookies.txt LOCALLY**.
2. Save the file as `cookies.txt` in the root folder of the project.

### Method 2: Set `YOUTUBE_COOKIES` in `.env` (Recommended for Cloud / Railway)
Open `.env` and paste your raw cookies content directly:
```env
YOUTUBE_COOKIES="your_raw_netscape_cookies_here"
```
The server will automatically detect and load your cookies! If no cookies are provided, it seamlessly operates using public clients (`android`, `visionos`).

---

## 📡 API Endpoints

### 1. `GET /search`
Search for a YouTube video by song title.

| Param | Required | Description |
|---|---|---|
| `title` | ✅ | Search query (e.g. `Shape of You`) |

```bash
GET /search?title=Shape%20of%20You
```

### 2. `GET /download`
Universal stream & download endpoint.

| Param | Required | Default | Description |
|---|---|---|---|
| `title` | Conditional | - | Search query to download |
| `url` | Conditional | - | Full YouTube/Spotify URL or 11-char Video ID |
| `type` | ❌ | `audio` | `audio` or `video` |
| `stream` | ❌ | `false` | `1` or `true` for live streaming header (no attachment download) |
| `quality` | ❌ | `360` | Max video resolution (e.g. `360`, `720`, `1080`) |

---

## 🤖 Telegram Bot Integration (PyTgCalls)

```python
# Beats Stream - dev by iq4u8
from pytgcalls import PyTgCalls
from pytgcalls.types import AudioPiped

async def play_music(chat_id, song_query):
    stream_url = f"https://musicstream-production-e72ae948.up.railway.app/download?title={song_query}&type=audio&stream=1"
    await pytgcalls.join_group_call(chat_id, AudioPiped(stream_url))
```

---

## 💬 Credits & Reference

- **Author**: dev by iq4u8
- **Telegram**: [@iq4u8](https://t.me/iq4u8)
- **Instagram**: [@iq4u8](https://instagram.com/iq4u8)
- **Twitter / X**: [@me_iq4u8](https://x.com/me_iq4u8)
