FROM python:3.11-slim

# Bring in the deno binary. yt-dlp needs a real JS runtime to solve YouTube's
# signature/n-challenges — without it you get "Signature/n challenge solving
# failed" warnings and end up with no usable audio/video formats.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# ffmpeg is required to merge separate video+audio streams (used by the
# /download?type=video endpoint).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -U -r requirements.txt

COPY . .

ENV PORT=8080
EXPOSE 8080
EXPOSE 3000

# gthread (not sync) is required: /live holds the connection open for the whole
# song, so long-running streams must not occupy (and block) a whole worker.
CMD ["sh", "-c", "gunicorn --timeout 150 --workers 2 --threads 16 --worker-class gthread --bind 0.0.0.0:${PORT:-8080} app:app"]
