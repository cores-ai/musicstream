# ========================================================
# Beats Stream — Audio & Video Demuxing Engine
# dev by iq4u8
# ========================================================

from flask import Flask, request, jsonify, send_file, render_template, Response, stream_with_context
import yt_dlp
import os
import time
import uuid
import threading
import requests
import hashlib
import glob
import shutil
import tempfile
import concurrent.futures
from datetime import datetime, timezone

# Initialize Flask Application - Beats Stream (dev by iq4u8)
app = Flask(__name__)

# Auto-load variables from .env file if present
def _load_dotenv():
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_file):
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k and k not in os.environ:
                            os.environ[k] = v
        except Exception as e:
            print(f"[Beats Stream] Notice loading .env: {e}")

_load_dotenv()

# Project root: works cross-platform on Windows, Linux and cloud (Render / Railway / Docker)
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# Base directory: Works cross-platform on Windows, Linux, and Cloud (Render / Railway / Vercel / Docker)
BASE_TEMP_DIR = os.environ.get("TEMP_DIR") or ("/tmp" if os.name != "nt" else os.path.join(PROJECT_ROOT, "tmp"))

# Directory for temporary downloads (cleared after each request)
TEMP_DOWNLOAD_DIR = os.path.join(BASE_TEMP_DIR, "download")
os.makedirs(TEMP_DOWNLOAD_DIR, exist_ok=True)

# Directory for cached audio files
CACHE_DIR = os.path.join(BASE_TEMP_DIR, "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# Directory for cached video files
CACHE_VIDEO_DIR = os.path.join(BASE_TEMP_DIR, "cache_video")
os.makedirs(CACHE_VIDEO_DIR, exist_ok=True)

# Directory where D1 cookie rows are materialised as Netscape jars (kept out of the repo)
COOKIE_DIR = os.path.join(BASE_TEMP_DIR, "cookies")
os.makedirs(COOKIE_DIR, exist_ok=True)

# Maximum cache size in bytes (2GB)
MAX_CACHE_SIZE = 2 * 1024 * 1024 * 1024

# External Search API URL (used for searches and Spotify link resolution)
SEARCH_API_URL = "https://odd-block-a945.tenopno.workers.dev/search?title="

# Optional Proxy URL
PROXY_URL = os.environ.get("PROXY_URL")

# Direct Running & Access Control - Beats Stream (dev by iq4u8)
# By default, REQUIRE_API_KEY is False for direct running without any barrier.
REQUIRE_API_KEY = os.environ.get("REQUIRE_API_KEY", "false").lower() in ("true", "1", "yes")
API_KEY = os.environ.get("API_KEY", "")


def get_js_runtimes_config():
    """
    Detects available JS runtimes (Deno, Node.js) for yt-dlp signature challenge solving.
    Beats Stream (dev by iq4u8)
    """
    runtimes = {}
    deno_path = shutil.which("deno")
    if deno_path:
        runtimes["deno"] = {"path": deno_path}
    node_path = shutil.which("node")
    if node_path:
        runtimes["node"] = {"path": node_path}
    return runtimes if runtimes else {"deno": {}, "node": {}}


def resolve_title_to_video_info(title):
    """
    Search for a video by title.
    Fast direct yt-dlp YouTube search with instant fallback.
    dev by iq4u8
    """
    # 1. Primary: Direct yt-dlp search (fast, reliable, no external dependencies)
    try:
        ydl_opts = {
            'quiet': True,
            'extract_flat': True,
            'noplaylist': True,
            'socket_timeout': 10,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch1:{title}", download=False)
            if info and 'entries' in info and len(info['entries']) > 0:
                entry = info['entries'][0]
                url = entry.get('url')
                if url and not url.startswith('http'):
                    url = f"https://www.youtube.com/watch?v={url}"
                elif not url and entry.get('id'):
                    url = f"https://www.youtube.com/watch?v={entry.get('id')}"
                return {
                    'title': entry.get('title', title),
                    'url': url,
                    'duration': entry.get('duration')
                }
    except Exception as e:
        print(f"[Beats Stream] Direct search note: {e}")

    # 2. Secondary fallback via external worker if configured
    if SEARCH_API_URL and SEARCH_API_URL.startswith("http"):
        try:
            encoded_title = requests.utils.quote(title)
            res = requests.get(SEARCH_API_URL + encoded_title, timeout=3)
            if res.status_code == 200:
                data = res.json()
                if data and 'link' in data:
                    return {
                        'title': data.get('title', title),
                        'url': data['link'],
                        'duration': data.get('duration')
                    }
        except Exception:
            pass

    return None


# ------------------------------------------------------------------
# Cookie pool: Cloudflare D1 (bulk, multiline) + env fallbacks.
# Every credential comes from the environment only - nothing hardcoded.
# ------------------------------------------------------------------
CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
CF_DB_ID = os.environ.get("CLOUDFLARE_DATABASE_ID", "")
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")

# How many valid D1 rows to pull per sync, and how often to refresh the pool.
try:
    D1_COOKIE_LIMIT = max(1, int(os.environ.get("D1_COOKIE_LIMIT", "200")))
except ValueError:
    D1_COOKIE_LIMIT = 200
D1_SYNC_INTERVAL = 600  # seconds

_d1_cookies_pool = []
_d1_cookie_idx = 0
_d1_last_sync = 0.0
_d1_lock = threading.Lock()


def clean_netscape_cookie(raw):
    """Normalise a raw cookie blob (CRLF or LF, multiline) into a valid Netscape jar."""
    out = ["# Netscape HTTP Cookie File", "# https://curl.se/docs/http-cookies.html", ""]
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#") or "\t" in line:
            out.append(line)
        else:
            out.append(f"# {line}")
    return "\n".join(out) + "\n"


def sync_cookies_from_d1(force=False):
    """Load the whole valid cookie pool from D1. Re-syncs at most every D1_SYNC_INTERVAL."""
    global _d1_cookies_pool, _d1_last_sync
    if not (CF_ACCOUNT_ID and CF_DB_ID and CF_TOKEN):
        return False

    now = time.time()
    with _d1_lock:
        if not force and _d1_cookies_pool and (now - _d1_last_sync) < D1_SYNC_INTERVAL:
            return True

    try:
        url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_DB_ID}/query"
        payload = {
            "sql": (
                "SELECT id, filename, cookie_content FROM youtube_cookies "
                "WHERE is_valid = 1 AND length(cookie_content) > 0 "
                f"ORDER BY last_used ASC LIMIT {D1_COOKIE_LIMIT};"
            )
        }
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"},
            json=payload,
            timeout=8,
        )
        if r.status_code != 200:
            print(f"[D1Sync] HTTP {r.status_code}")
            return False
        data = r.json()
        if not data.get("success"):
            print("[D1Sync] Query rejected by D1")
            return False
        result_sets = data.get("result") or []
        results = result_sets[0].get("results", []) if result_sets else []
        results = [row for row in results if (row.get("cookie_content") or "").strip()]
        if not results:
            print("[D1Sync] No valid cookies found in D1")
            return False
        with _d1_lock:
            _d1_cookies_pool = results
            _d1_last_sync = now
        print(f"[D1Sync] Loaded {len(results)} valid cookies from D1 Database!")
        return True
    except Exception as e:
        print(f"[D1Sync] Cookie sync note: {e}")
        return False


def _materialise_cookie_file(row):
    """Write one D1 row to a Netscape jar on disk, atomically and outside the repo."""
    target_path = os.path.join(COOKIE_DIR, f"d1_cookie_{row.get('id', 0)}.txt")
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return target_path
    tmp_path = f"{target_path}.{uuid.uuid4().hex}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(clean_netscape_cookie(row.get("cookie_content", "")))
    os.replace(tmp_path, target_path)
    return target_path


def _configured_cookie_file():
    configured_file = os.environ.get("COOKIES_FILE", "cookies.txt")
    return configured_file if os.path.isabs(configured_file) else os.path.join(PROJECT_ROOT, configured_file)


def get_active_cookie_file():
    """
    Resolve the cookie jar for a real download.
    Rotates across the entire D1 pool and refreshes the pool periodically.
    """
    global _d1_cookie_idx

    sync_cookies_from_d1()

    if _d1_cookies_pool:
        with _d1_lock:
            row = _d1_cookies_pool[_d1_cookie_idx % len(_d1_cookies_pool)]
            _d1_cookie_idx += 1
        try:
            return _materialise_cookie_file(row)
        except Exception as e:
            print(f"[Cookie] Write err: {e}")
            return None

    target_path = _configured_cookie_file()

    env_cookies = os.environ.get("YOUTUBE_COOKIES") or os.environ.get("COOKIES")
    if env_cookies and env_cookies.strip():
        try:
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(clean_netscape_cookie(env_cookies.strip()))
            return target_path
        except Exception as e:
            print(f"[Beats Stream] Failed to write cookies from environment: {e}")

    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return target_path

    return None


def cookies_loaded():
    """Status only - never rotates the pool and never writes to disk."""
    if _d1_cookies_pool:
        return True
    if (os.environ.get("YOUTUBE_COOKIES") or os.environ.get("COOKIES") or "").strip():
        return True
    target_path = _configured_cookie_file()
    return os.path.exists(target_path) and os.path.getsize(target_path) > 0


def d1_pool_size():
    with _d1_lock:
        return len(_d1_cookies_pool)


sync_cookies_from_d1(force=True)


# ------------------------------------------------------------------
# Live pass-through streaming.
# Resolves the upstream audio URL once (no download, no transcode) and
# reverse-proxies it with Range support so playback starts in ~1s.
# ------------------------------------------------------------------
LIVE_URL_TTL = int(os.environ.get("LIVE_URL_TTL", "14400"))  # upstream links live ~6h

_live_cache = {}
_live_lock = threading.Lock()
LIVE_CACHE_MAX = int(os.environ.get("LIVE_CACHE_MAX", "500"))

# One shared, bounded pool for the racing extraction strategies. Building a fresh
# executor per resolve leaked threads (yt-dlp extraction cannot be interrupted, so a
# cancelled future keeps running) and burned CPU on the losers.
_live_executor = concurrent.futures.ThreadPoolExecutor(max_workers=6, thread_name_prefix="live_resolve")

# Reused HTTP session: keeps TCP/TLS connections to the CDN alive, which is what
# takes the warm pass-through latency from ~2s down to a few hundred ms.
_upstream_session = requests.Session()
_upstream_adapter = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=64, max_retries=0)
_upstream_session.mount("https://", _upstream_adapter)
_upstream_session.mount("http://", _upstream_adapter)


def _live_cache_key(video_url):
    return hashlib.md5(("live_" + video_url).encode("utf-8")).hexdigest()


def _live_cache_get(key):
    with _live_lock:
        entry = _live_cache.get(key)
        if not entry:
            return None
        if time.time() >= entry["expires"]:
            _live_cache.pop(key, None)
            return None
        return entry


def _live_cache_put(key, entry):
    with _live_lock:
        _live_cache[key] = entry
        if len(_live_cache) > LIVE_CACHE_MAX:
            now = time.time()
            for k in [k for k, v in _live_cache.items() if now >= v["expires"]]:
                _live_cache.pop(k, None)
            while len(_live_cache) > LIVE_CACHE_MAX:
                _live_cache.pop(next(iter(_live_cache)), None)


def _live_cache_drop(key):
    with _live_lock:
        _live_cache.pop(key, None)


def _extract_live_entry(video_url, strategy):
    """
    Single extraction attempt (one player_client variant) - no download, no transcode.
    Beats Stream (dev by iq4u8)
    """
    opts = {
        # Audio-only on purpose: falling back to 'best' would silently stream a
        # full video file (3-7x the bytes) for an audio-only request.
        'format': 'bestaudio[ext=m4a]/bestaudio',
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'noplaylist': True,
        'socket_timeout': 10,
        'js_runtimes': get_js_runtimes_config(),
    }
    if 'player_client' in strategy:
        opts['extractor_args'] = {'youtube': {'player_client': strategy['player_client']}}
    if PROXY_URL:
        opts['proxy'] = PROXY_URL

    # yt-dlp writes the cookie jar back on exit, and several strategy workers share
    # one jar while running in parallel. Concurrent writes truncate the file, after
    # which every later extraction fails auth with a bot-check - that is what made
    # the live endpoint drift from ~1s to a timeout. Give each worker its own copy.
    cookie_temp = None
    if 'cookiefile' in strategy:
        try:
            fd, cookie_temp = tempfile.mkstemp(prefix="live_cookie_", suffix=".txt")
            with os.fdopen(fd, "wb") as dst, open(strategy['cookiefile'], "rb") as src:
                shutil.copyfileobj(src, dst)
            opts['cookiefile'] = cookie_temp
        except Exception:
            if cookie_temp:
                try:
                    os.remove(cookie_temp)
                except Exception:
                    pass
            cookie_temp = None

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
        if info.get('entries'):
            info = info['entries'][0]
        direct = info.get('url')
        if not direct or not str(direct).startswith('http'):
            raise Exception("extraction returned no direct upstream url")
        return {
            'url': direct,
            'headers': dict(info.get('http_headers') or {}),
            'title': info.get('title'),
            'duration': info.get('duration'),
            'id': info.get('id'),
        }
    finally:
        if cookie_temp:
            try:
                os.remove(cookie_temp)
            except Exception:
                pass


def resolve_live_audio(video_url, force=False):
    """
    Resolve the direct upstream audio URL without downloading anything.

    All player-client strategies are raced in parallel and the first successful
    extraction wins, so a cold resolve only costs as long as the fastest
    successful strategy (~1-3s) instead of the sum of every attempt.
    Result is cached in memory; force=True re-resolves after a signature expires.
    Beats Stream (dev by iq4u8)
    """
    key = _live_cache_key(video_url)
    if not force:
        cached = _live_cache_get(key)
        if cached:
            return cached

    cookie_file = get_active_cookie_file()
    strategies = [
        {'player_client': ['android']},
        {},
        {'player_client': ['visionos', 'ios']},
    ]
    if cookie_file and os.path.exists(cookie_file) and os.path.getsize(cookie_file) > 0:
        strategies.extend([
            {'player_client': ['web_embedded'], 'cookiefile': cookie_file},
            {'player_client': ['mweb'], 'cookiefile': cookie_file},
        ])

    last_error = None
    futures = [_live_executor.submit(_extract_live_entry, video_url, s) for s in strategies]
    try:
        for future in concurrent.futures.as_completed(futures):
            try:
                entry = future.result()
            except Exception as e:
                last_error = e
                continue
            entry['expires'] = time.time() + LIVE_URL_TTL
            _live_cache_put(key, entry)
            print(f"[Live] Resolved direct audio URL for {entry.get('id', video_url)}")
            return entry
    finally:
        for f in futures:
            f.cancel()

    raise last_error if last_error else Exception("live resolution failed across all strategies")


def verify_api_key(provided_key):
    """
    Validates API key if REQUIRE_API_KEY is set to True.
    By default (direct running), all requests are allowed immediately.
    Reference: Beats Stream (dev by iq4u8)
    """
    if not provided_key:
        provided_key = request.args.get('api') or request.args.get('api_key') or request.headers.get('x-api-key')
    # 1. Always allow direct live stream requests (browser audio player, PyTgCalls voice chat)
    if request.args.get('stream', 'false').lower() in ('true', '1', 'yes'):
        return True, "Direct streaming mode enabled"

    # 2. Allow internal web interface preview requests
    referer = request.headers.get('Referer', '')
    host = request.headers.get('Host', '')
    if host and host in referer:
        return True, "Direct web dashboard access"

    # 3. Direct running mode without key requirement
    if not REQUIRE_API_KEY:
        return True, "Direct running mode (no key required)"

    if not provided_key:
        return False, "Missing api_key parameter"

    if API_KEY and provided_key == API_KEY:
        return True, "Valid API key"

    return False, "Invalid API key"


def get_cache_key(video_url):
    """Generate cache key from video URL. Beats Stream (dev by iq4u8)."""
    return hashlib.md5(video_url.encode('utf-8')).hexdigest()


def get_directory_size(directory):
    total_size = 0
    if not os.path.exists(directory):
        return 0
    for dirpath, _, filenames in os.walk(directory):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if os.path.isfile(fp):
                total_size += os.path.getsize(fp)
    return total_size


def cleanup_expired_temp_files(max_age_seconds=1500):
    """
    Auto-purge cached test tracks older than 20-30 minutes (dev by iq4u8).
    Keeps test files strictly ephemeral and prevents disk bloat.
    """
    now = time.time()
    for directory in [CACHE_DIR, CACHE_VIDEO_DIR, TEMP_DOWNLOAD_DIR]:
        if not os.path.exists(directory):
            continue
        try:
            for fname in os.listdir(directory):
                fpath = os.path.join(directory, fname)
                if os.path.isfile(fpath):
                    try:
                        mtime = os.path.getmtime(fpath)
                        if (now - mtime) > max_age_seconds:
                            os.remove(fpath)
                    except Exception:
                        pass
        except Exception:
            pass

def _start_background_cache_cleaner():
    def cleaner_worker():
        while True:
            try:
                time.sleep(300)  # Check every 5 minutes
                cleanup_expired_temp_files(max_age_seconds=1500)  # 25-minute TTL
            except Exception:
                pass
    t = threading.Thread(target=cleaner_worker, daemon=True)
    t.start()

_start_background_cache_cleaner()


def check_cache_size_and_cleanup(preserve_paths=None):
    """Trim caches without deleting files needed by current response. Beats Stream (dev by iq4u8)."""
    cleanup_expired_temp_files(max_age_seconds=1500)
    preserve_paths = {
        os.path.abspath(path) for path in (preserve_paths or set())
    }
    total_size = get_directory_size(CACHE_DIR) + get_directory_size(CACHE_VIDEO_DIR)
    if total_size > MAX_CACHE_SIZE:
        for cache_dir in [CACHE_DIR, CACHE_VIDEO_DIR]:
            if not os.path.exists(cache_dir):
                continue
            for file in os.listdir(cache_dir):
                file_path = os.path.join(cache_dir, file)
                if os.path.abspath(file_path) in preserve_paths:
                    continue
                try:
                    os.remove(file_path)
                except Exception as e:
                    print(f"[Beats Stream] Error deleting file {file_path}: {e}")


import re

def normalize_video_url(url):
    """
    Accepts full YouTube URL, bare 11-char video ID, or search query.
    If it's not a direct URL and not an 11-character ID, auto-resolve via search!
    """
    if not url:
        return url
    url = url.strip()
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if re.match(r'^[a-zA-Z0-9_-]{11}$', url):
        return f"https://www.youtube.com/watch?v={url}"
    
    # Auto-resolve search query if query string passed in url param (e.g. manohari-telugu-hindi)
    cleaned_query = url.replace("-", " ").replace("_", " ")
    resolved = resolve_title_to_video_info(cleaned_query)
    if resolved and 'url' in resolved:
        return resolved['url']
    return f"https://www.youtube.com/watch?v={url}"


def _extract_and_download(video_url, base_opts):
    """
    Robust Multi-Strategy Downloader - Beats Stream (dev by iq4u8)
    
    Tries native extraction clients (visionos, ios, web) first to bypass bot checks.
    Only falls back to cookie-bound strategies if necessary.
    """
    cookie_file = get_active_cookie_file()

    # Prioritize strategies that succeed on datacenter IPs without triggering bot challenges
    strategies = [
        # Strategy 1: Native yt-dlp auto-resolver (visionos + ios + web naturally, no bot check)
        {},
        # Strategy 2: visionos & ios clients explicitly
        {'player_client': ['visionos', 'ios']},
        # Strategy 3: Android client without cookies
        {'player_client': ['android']},
    ]

    if cookie_file and os.path.exists(cookie_file) and os.path.getsize(cookie_file) > 0:
        strategies.extend([
            # Strategy 4: Web embedded with cookies
            {'player_client': ['web_embedded'], 'cookiefile': cookie_file},
            # Strategy 5: Mobile web with cookies
            {'player_client': ['mweb'], 'cookiefile': cookie_file},
            # Strategy 6: Android with cookies
            {'player_client': ['android'], 'cookiefile': cookie_file},
        ])

    strategies.append({'player_client': ['web_creator']})

    last_error = None
    for strategy in strategies:
        opts = dict(base_opts)
        if 'player_client' in strategy:
            opts['extractor_args'] = {'youtube': {'player_client': strategy['player_client']}}
        if 'cookiefile' in strategy:
            opts['cookiefile'] = strategy['cookiefile']
        if PROXY_URL:
            opts['proxy'] = PROXY_URL

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                downloaded_file = ydl.prepare_filename(info)
                return info, downloaded_file
        except Exception as e:
            last_error = e
            continue

    raise last_error if last_error else Exception("Extraction failed across all strategies.")


def download_audio(video_url):
    """
    Download audio with caching and custom metadata tags.
    All artist & comment metadata tags are set to: Beats Stream (dev by iq4u8)
    """
    cache_key = hashlib.md5((video_url + "_audio_beats_stream").encode('utf-8')).hexdigest()
    cached_files = glob.glob(os.path.join(CACHE_DIR, f"{cache_key}.*"))
    cached_file = next(
        (path for path in cached_files if os.path.isfile(path) and os.path.getsize(path) > 0),
        None,
    )
    if cached_file:
        return cached_file

    unique_id = str(uuid.uuid4())
    output_template = os.path.join(TEMP_DOWNLOAD_DIR, f"{unique_id}.%(ext)s")
    base_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best',
        'outtmpl': output_template,
        'noplaylist': True,
        'quiet': True,
        'socket_timeout': 60,
        'max_memory': 450000,
        'js_runtimes': get_js_runtimes_config(),
    }

    # Embed metadata so that artist and comment tag are 'Beats Stream (dev by iq4u8)'
    if shutil.which('ffmpeg'):
        base_opts['postprocessors'] = [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': 'm4a'},
            {'key': 'FFmpegMetadata', 'add_metadata': True},
        ]
        base_opts['postprocessor_args'] = {
            'ffmpeg': [
                '-metadata', 'artist=Beats Stream (dev by iq4u8)',
                '-metadata', 'album_artist=Beats Stream (dev by iq4u8)',
                '-metadata', 'composer=Beats Stream (dev by iq4u8)',
                '-metadata', 'comment=Beats Stream (dev by iq4u8)',
                '-metadata', 'description=Beats Stream (dev by iq4u8)',
                '-metadata', 'author=Beats Stream (dev by iq4u8)',
            ]
        }

    try:
        info, downloaded_file = _extract_and_download(video_url, base_opts)
        downloaded_candidates = glob.glob(
            os.path.join(TEMP_DOWNLOAD_DIR, f"{unique_id}.*")
        )
        final_file = next(
            (path for path in downloaded_candidates if os.path.isfile(path)),
            downloaded_file,
        )
        ext = os.path.splitext(final_file)[1].lstrip(".") or info.get("ext", "m4a")
        cached_file_path = os.path.join(CACHE_DIR, f"{cache_key}.{ext}")
        shutil.move(final_file, cached_file_path)
        check_cache_size_and_cleanup(preserve_paths={cached_file_path})
        return cached_file_path
    except Exception as e:
        raise Exception(f"Error downloading audio: {e}")


def download_video(video_url, quality=360):
    """
    Download video with audio merged at the requested quality.
    Reference: Beats Stream (dev by iq4u8)
    """
    cache_key = hashlib.md5(
        (f"{video_url}_video_quality_{quality}_beats_stream").encode('utf-8')
    ).hexdigest()
    cached_files = glob.glob(os.path.join(CACHE_VIDEO_DIR, f"{cache_key}.*"))
    cached_file = next(
        (path for path in cached_files if os.path.isfile(path) and os.path.getsize(path) > 0),
        None,
    )
    if cached_file:
        return cached_file

    unique_id = str(uuid.uuid4())
    output_template = os.path.join(TEMP_DOWNLOAD_DIR, f"{unique_id}.%(ext)s")
    has_ffmpeg = bool(shutil.which('ffmpeg'))
    base_opts = {
        'format': (
            f'bestvideo[height<={quality}]+bestaudio/best[height<={quality}]/best'
            if has_ffmpeg
            else f'best[height<={quality}][vcodec!=none][acodec!=none]/best[height<={quality}]/best'
        ),
        'outtmpl': output_template,
        'noplaylist': True,
        'quiet': True,
        'socket_timeout': 60,
        'max_memory': 300000,
        'http_chunk_size': 10 * 1024 * 1024,
        'retries': 3,
        'fragment_retries': 3,
        'js_runtimes': get_js_runtimes_config(),
    }
    if has_ffmpeg:
        base_opts['merge_output_format'] = 'mp4'

    if shutil.which('ffmpeg'):
        base_opts['postprocessors'] = [
            {'key': 'FFmpegMetadata', 'add_metadata': True},
        ]
        base_opts['postprocessor_args'] = {
            'ffmpeg': [
                '-metadata', 'artist=Beats Stream (dev by iq4u8)',
                '-metadata', 'comment=Beats Stream (dev by iq4u8)',
                '-metadata', 'author=Beats Stream (dev by iq4u8)',
            ]
        }

    try:
        info, downloaded_file = _extract_and_download(video_url, base_opts)
        downloaded_candidates = glob.glob(
            os.path.join(TEMP_DOWNLOAD_DIR, f"{unique_id}.*")
        )
        merged_file = next(
            (
                path for path in downloaded_candidates
                if os.path.splitext(path)[1].lower() == ".mp4"
            ),
            downloaded_file,
        )
        cached_file_path = os.path.join(CACHE_VIDEO_DIR, f"{cache_key}.mp4")
        shutil.move(merged_file, cached_file_path)
        check_cache_size_and_cleanup(preserve_paths={cached_file_path})
        return cached_file_path
    except Exception as e:
        raise Exception(f"Error downloading video: {e}")


def resolve_spotify_link(url):
    """
    Resolve Spotify track URL to matching YouTube link.
    Beats Stream (dev by iq4u8)
    """
    if "spotify.com" in url:
        info = resolve_title_to_video_info(url)
        if not info or 'url' not in info:
            raise Exception("No YouTube link found for the given Spotify link")
        return info['url']
    return url


@app.route('/search', methods=['GET'])
def search_video():
    """
    Search for a YouTube video with resilient fallback.
    Artist & reference returned as: Beats Stream (dev by iq4u8)
    """
    try:
        query = request.args.get('title')
        if not query:
            return jsonify({"error": "The 'title' parameter is required"}), 400

        result = resolve_title_to_video_info(query)
        if not result or 'url' not in result:
            return jsonify({"error": "No videos found for the given query"}), 404

        return jsonify({
            "title": result.get("title", query),
            "url": result["url"],
            "duration": result.get("duration"),
            "artist": "Beats Stream",
            "dev_by": "iq4u8"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/download', methods=['GET', 'HEAD'])
def download_endpoint():
    """
    Unified Direct Download Endpoint.
    Direct running: works immediately without login or database.

    GET /download?url=VIDEO_ID&type=audio
    GET /download?title=SONG_NAME&type=audio
    GET /download?url=VIDEO_ID&type=video&quality=720

    Reference: Beats Stream (dev by iq4u8)
    """
    try:
        # Validate API key if explicitly required
        api_key = request.args.get('api_key') or request.headers.get('x-api-key')
        is_valid, reason = verify_api_key(api_key)
        if not is_valid:
            return jsonify({"error": reason}), 401

        video_url = request.args.get('url')
        video_title = request.args.get('title')
        download_type = (request.args.get('type') or 'audio').lower()
        quality_value = request.args.get('quality', '360')

        if download_type not in ('audio', 'video'):
            return jsonify({"error": "'type' must be either 'audio' or 'video'"}), 400

        try:
            quality = int(quality_value)
            if quality < 144:
                raise ValueError
        except (TypeError, ValueError):
            return jsonify({
                "error": "'quality' must be a whole number of at least 144"
            }), 400

        if not video_url and not video_title:
            return jsonify({"error": "Either 'url' or 'title' parameter is required"}), 400

        if video_title and not video_url:
            resolved = resolve_title_to_video_info(video_title)
            if not resolved or 'url' not in resolved:
                return jsonify({"error": "No videos found for the given query"}), 404
            video_url = resolved['url']

        video_url = normalize_video_url(video_url)

        if video_url and "spotify.com" in video_url:
            video_url = resolve_spotify_link(video_url)

        if download_type == 'video':
            cached_file_path = download_video(video_url, quality)
        else:
            cached_file_path = download_audio(video_url)

        # Streaming vs Download attachment support - Beats Stream (dev by iq4u8)
        is_stream = request.args.get('stream', 'false').lower() in ('true', '1', 'yes')
        as_attachment = not is_stream and (request.args.get('download', 'true').lower() not in ('false', '0', 'no'))

        # Determine precise MIME type so HTML5 audio elements stream smoothly
        ext = os.path.splitext(cached_file_path)[1].lower()
        mime_map = {
            '.m4a': 'audio/mp4',
            '.mp3': 'audio/mpeg',
            '.ogg': 'audio/ogg',
            '.opus': 'audio/ogg',
            '.webm': 'audio/webm',
            '.mp4': 'video/mp4',
        }
        content_type = mime_map.get(ext) or 'audio/mp4' if download_type == 'audio' else 'video/mp4'

        return send_file(
            cached_file_path,
            mimetype=content_type,
            as_attachment=as_attachment,
            download_name=os.path.basename(cached_file_path),
            conditional=True
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        # Clean up temporary download directory
        if os.path.exists(TEMP_DOWNLOAD_DIR):
            for file in os.listdir(TEMP_DOWNLOAD_DIR):
                file_path = os.path.join(TEMP_DOWNLOAD_DIR, file)
                try:
                    os.remove(file_path)
                except Exception as cleanup_error:
                    print(f"[Beats Stream] Cleanup note {file_path}: {cleanup_error}")


@app.route('/stream/<path:video_id>', methods=['GET'])
def stream_proxy_endpoint(video_id):
    """Direct stream alias endpoint for zero-error audio pipeline"""
    download_url = normalize_video_url(video_id)
    cached_file_path = download_audio(download_url)
    ext = os.path.splitext(cached_file_path)[1].lower()
    content_type = 'audio/mp4' if ext == '.m4a' else 'audio/mpeg'
    return send_file(
        cached_file_path,
        mimetype=content_type,
        as_attachment=False,
        conditional=True
    )


@app.route('/live/<path:video_id>', methods=['GET'])
def live_stream_endpoint(video_id):
    """
    Zero-wait pass-through audio stream.

    Resolves the direct upstream audio URL (cached, no download, no transcode)
    and reverse-proxies it with Range support, so playback starts in about a
    second instead of waiting for a full download plus ffmpeg transcode.
    Beats Stream (dev by iq4u8)
    """
    api_key = request.args.get('api_key') or request.headers.get('x-api-key')
    is_valid, reason = verify_api_key(api_key)
    if not is_valid:
        return jsonify({"error": reason}), 401

    try:
        video_url = normalize_video_url(request.args.get('url') or video_id)
        if "spotify.com" in video_url:
            video_url = resolve_spotify_link(video_url)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    key = _live_cache_key(video_url)
    upstream = None
    for attempt in (False, True):
        try:
            resolved = resolve_live_audio(video_url, force=attempt)
        except Exception as e:
            return jsonify({"error": f"live resolve failed: {e}"}), 502

        upstream_headers = dict(resolved.get('headers') or {})
        client_range = request.headers.get('Range')
        if client_range:
            upstream_headers['Range'] = client_range

        try:
            upstream = _upstream_session.get(
                resolved['url'],
                headers=upstream_headers,
                stream=True,
                timeout=(6, 30),
                allow_redirects=True,
            )
        except Exception:
            upstream = None
            continue

        if upstream.status_code in (200, 206):
            break

        # Most likely an expired signature: drop the cache entry and re-resolve once
        _live_cache_drop(key)
        upstream.close()
        upstream = None

    if upstream is None:
        return jsonify({"error": "upstream audio unavailable"}), 502

    passthrough = {}
    for header in ('Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'):
        value = upstream.headers.get(header)
        if value:
            passthrough[header] = value
    passthrough.setdefault('Accept-Ranges', 'bytes')
    passthrough['Cache-Control'] = 'no-store'

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=passthrough,
    )


@app.route('/api/song', methods=['GET'])
def api_song_endpoint():
    """BabyAPI and Song URL alias endpoint"""
    target = request.args.get('query') or request.args.get('url') or request.args.get('title')
    if not target:
        return jsonify({"error": "Missing query or url parameter"}), 400
    
    # Map query parameter to url or title for unified download handler
    download_url = normalize_video_url(target)
    request.args = request.args.copy()
    request.args['url'] = download_url
    if 'type' not in request.args:
        request.args['type'] = 'audio'
    return download_endpoint()


@app.route('/api/video', methods=['GET'])
def api_video_endpoint():
    """BabyAPI Video URL alias endpoint"""
    target = request.args.get('query') or request.args.get('url') or request.args.get('title')
    if not target:
        return jsonify({"error": "Missing query or url parameter"}), 400

    download_url = normalize_video_url(target)
    request.args = request.args.copy()
    request.args['url'] = download_url
    if 'type' not in request.args:
        request.args['type'] = 'video'
    return download_endpoint()


@app.route('/')
def home():
    """
    Developer Portal & Direct Playground.
    No login page or database required - Direct running.
    Reference: Beats Stream (dev by iq4u8)
    """
    has_cookies = cookies_loaded()
    return render_template(
        'index.html',
        made_by="dev by iq4u8",
        cookies_available=has_cookies,
        require_api_key=REQUIRE_API_KEY,
        client_api_key=API_KEY if REQUIRE_API_KEY else ""
    )


@app.route('/health', methods=['GET'])
def health():
    """
    Service health check endpoint.
    Reference: Beats Stream (dev by iq4u8)
    """
    return jsonify({
        "status": "healthy",
        "service": "YouTube Music API",
        "version": "2026.11.14-mobile-bypass-v1",
        "dev_by": "iq4u8",
        "direct_running": not REQUIRE_API_KEY,
        "cookies_loaded": cookies_loaded(),
        "d1_pool_size": d1_pool_size()
    })


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    cookie_status = "Loaded" if cookies_loaded() else "None (Add cookies.txt or YOUTUBE_COOKIES in .env)"
    print("=" * 60)
    print("⚡ Beats Stream Audio Engine — dev by iq4u8")
    print("✨ Author: iq4u8 (@iq4u8)")
    print(f"🍪 Cookies: {cookie_status}")
    print(f"🚀 Running on http://0.0.0.0:{port}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=port)
