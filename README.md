# Beatx Stream API (Self-Hosted Music & Video Backend)

Yeh API service Railway par deploy hone ke liye tayar hai. Isse aapke bot ko third-party API limit se azadi mil jayegi.

## Endpoints Expose Kiye Gaye Hain:

1. **Audio Download/Stream**:
   - `GET /api/song?query={video_id}&api={API_KEY}`
   - `GET /download?url={video_id}&type=audio&api_key={API_KEY}`
2. **Video Download/Stream**:
   - `GET /api/video?query={video_id}&api={API_KEY}`
   - `GET /download?url={video_id}&type=video&api_key={API_KEY}`
3. **YouTube Search**:
   - `POST /api/search` (`{"query": "song name"}`)

## Railway Par Deploy Kaise Karein:

1. Ek new GitHub repo banayein (ya is `stream-api` folder ko push karein).
2. Railway me **New Project** -> **Deploy from GitHub repo** select karein.
3. Railway automatic `Dockerfile` detect karke service deploy kar dega.
4. Railway dashboard me **Variables** me jayein:
   - `API_KEY`: Aapki custom secret key (jaise: `my_super_secret_music_key`)
5. **Settings** me jakar **Generate Domain** par click karein (jaise: `beatx-stream.up.railway.app`).

## Music Bot me Update Karna:

Apne bot ke `.env` ya Railway environment variables me ye set karein:
```env
BASE_URL=https://beatx-stream.up.railway.app
BASE_API_KEY=my_super_secret_music_key
API_URL=https://beatx-stream.up.railway.app
API_KEY=my_super_secret_music_key
```
