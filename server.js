// server.js
// RTMP ingest -> ffmpeg (transcode to 720p) -> HLS segments (stream.m3u8)
// Node-Media-Server serves RTMP and also writes files under ./media
// Express UI + HLS serving + test player on port 8100
// ---------------------------------------------------------------

const NodeMediaServer = require("node-media-server");
const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");

// ---------------- CONFIG ----------------
const RTMP_PORT = 1935;
const NMS_HTTP_PORT = 8000; // NodeMediaServer internal http (optional)
const EXPRESS_PORT = 8100;  // Express will serve UI and media

const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const MEDIA_ROOT = path.join(PROJECT_ROOT, "media");

// Ensure media root exists
if (!fs.existsSync(MEDIA_ROOT)) fs.mkdirSync(MEDIA_ROOT, { recursive: true });

// ---------------- NMS CONFIG ----------------
const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: NMS_HTTP_PORT,
    mediaroot: MEDIA_ROOT,
    allow_origin: "*", // NodeMediaServer's internal http server will add this header
  },
};

const nms = new NodeMediaServer(nmsConfig);
nms.run();

// ---------------- HELPERS ----------------
const activeTranscoders = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function streamOutputDir(key) {
  return path.join(MEDIA_ROOT, key);
}

// Extract stream key safely
function extractKey(StreamPath, args, session) {
  if (StreamPath && typeof StreamPath === "string") {
    const p = StreamPath.split("/").filter(Boolean);
    return p[p.length - 1];
  }
  if (session?.streamName) return session.streamName;
  if (session?.rtmp?.streamName) return session.rtmp.streamName;
  return null;
}

// ---------------- START FFMPEG (TRANSCODE to 720p H264 + AAC) ----------------
/*
  Notes on changes:
  - Replaced -x264-params with cross-platform flags (-g, -sc_threshold).
  - Added -pix_fmt yuv420p for wide compatibility.
  - Kept CRF / maxrate / bufsize settings; adjust as needed.
*/
function startTranscode(streamKey) {
  if (!streamKey) return;
  if (activeTranscoders.has(streamKey)) return;

  const outDir = streamOutputDir(streamKey);
  ensureDir(outDir);

  // Cleanup old segments (be careful in production)
  try {
    fs.readdirSync(outDir).forEach((f) =>
      fs.unlinkSync(path.join(outDir, f))
    );
  } catch (err) {
    // ignore
  }

  const input = `rtmp://127.0.0.1:${RTMP_PORT}/live/${streamKey}`;

  // --- IMPORTANT: adjust GOP (-g) based on input fps.
  // If your encoder sends 60 fps, consider -g 120 for ~2s GOP. If 30 fps, -g 60.
  // Here we pick -g 120 (works for 60fps input), but it's fine if slightly off.
  const gop = "120";

  const args = [
    "-hide_banner",
    "-y",
    "-i", input,

    // Video encoding
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-vf", "scale=w=1280:h=720:force_original_aspect_ratio=decrease",
    "-pix_fmt", "yuv420p",
    "-g", gop,               // GOP / keyframe interval
    "-sc_threshold", "0",    // disable scene cut so ffmpeg honors -g (like no-scenecut)
    "-crf", "23",
    "-maxrate", "3000k",
    "-bufsize", "6000k",

    // Audio encoding
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",

    // HLS muxing options
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "6",
    "-hls_flags", "delete_segments+append_list",
    "-hls_segment_filename", path.join(outDir, "segment_%03d.ts"),
    path.join(outDir, "stream.m3u8"),
  ];

  console.log(`[FFMPEG] Starting transcode->HLS for key=${streamKey}`);
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  ff.stderr.on("data", (d) => {
    process.stdout.write(`[ffmpeg ${streamKey}] ${d.toString()}`);
  });

  ff.on("close", (code) => {
    console.log(`[FFMPEG] process for ${streamKey} exited with code ${code}`);
    activeTranscoders.delete(streamKey);
  });

  activeTranscoders.set(streamKey, ff);
}

function stopTranscode(streamKey) {
  const ff = activeTranscoders.get(streamKey);
  if (ff) {
    try {
      ff.kill("SIGINT");
    } catch (err) { /* ignore */ }
    activeTranscoders.delete(streamKey);
  }
}

// ---------------- NMS HOOKS ----------------
nms.on("postPublish", (id, StreamPath, args) => {
  const streamKey = extractKey(StreamPath, args, id);
  console.log("[NMS] Stream started:", streamKey);

  if (!streamKey) return console.log("[NMS] Could not detect key.");
  startTranscode(streamKey);
});

nms.on("donePublish", (id, StreamPath, args) => {
  const streamKey = extractKey(StreamPath, args, id);
  console.log("[NMS] Stream stopped:", streamKey);

  if (!streamKey) return;
  stopTranscode(streamKey);
});

// ---------------- EXPRESS UI & MEDIA SERVER ----------------
const app = express();

// enable CORS for all express routes (adds Access-Control-Allow-Origin: *)
app.use(cors());

// serve static UI (if you have files in /public)
app.use(express.static(PUBLIC_DIR));

// explicit CORS and range headers for /media (important for .m3u8 and .ts)
app.use("/media", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
  res.header("Access-Control-Expose-Headers", "Content-Length, Accept-Ranges");
  res.header("Accept-Ranges", "bytes");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/media", express.static(MEDIA_ROOT));

// Generate random key
app.get("/api/generate", (_, res) => {
  const key = crypto.randomBytes(6).toString("hex");
  res.json({
    streamKey: key,
    rtmpUrl: `rtmp://<SERVER_IP_OR_DOMAIN>:${RTMP_PORT}/live/${key}`,
    hlsUrl: `http://<SERVER_IP_OR_DOMAIN>:${EXPRESS_PORT}/media/${key}/stream.m3u8`
  });
});

// Master playlist (optional) — points to the per-stream playlist served by Express
app.get("/stream/:key/master.m3u8", (req, res) => {
  const key = req.params.key;
  const host = req.get("host").split(":")[0];
  const streamUrl = `${req.protocol}://${host}:${EXPRESS_PORT}/media/${key}/stream.m3u8`;
  const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=3000000
${streamUrl}
`;
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(master);
});

// Simple test player (uses hls.js for browsers that need MSE)
app.get("/player/:key", (req, res) => {
  const key = req.params.key;
  const hlsUrl = `${req.protocol}://${req.get("host")}/media/${key}/stream.m3u8`;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>HLS Player - ${key}</title>
  <style>body{background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}video{width:80%;max-width:960px}</style>
</head>
<body>
  <video id="video" controls crossorigin="anonymous"></video>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script>
    const video = document.getElementById('video');
    const url = '${hlsUrl}';
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        console.log('manifest parsed');
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error', event, data);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    } else {
      document.body.innerHTML = '<p style="color:#f88">Your browser does not support HLS playback.</p>';
    }
  </script>
</body>
</html>`;
  res.send(html);
});

// helper to show current active keys
app.get("/status", (req, res) => {
  const keys = fs.readdirSync(MEDIA_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  res.json({ activeStreamDirs: keys, transcoding: Array.from(activeTranscoders.keys()) });
});

// Start Express
app.listen(EXPRESS_PORT, () => {
  console.log(`------------------------------------------`);
  console.log(`Express UI: http://localhost:${EXPRESS_PORT}`);
  console.log(`RTMP ingest (OBS): rtmp://<SERVER_IP>:${RTMP_PORT}/live/<KEY>`);
  console.log(`HLS output (via Express): http://<SERVER_IP>:${EXPRESS_PORT}/media/<KEY>/stream.m3u8`);
  console.log(`Test player: http://<SERVER_IP>:${EXPRESS_PORT}/player/<KEY>`);
  console.log(`------------------------------------------`);
});
