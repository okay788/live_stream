// server.js
// RTMP ingest -> ffmpeg (copy mode) -> HLS segments (stream.m3u8)
// Node-Media-Server serves HLS on port 8000
// Express UI + master playlist on port 8100
// ---------------------------------------------------------------

const NodeMediaServer = require("node-media-server");
const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors"); // <-- fixed typo

// ---------------- CONFIG ----------------
const RTMP_PORT = 1935;
const NMS_HTTP_PORT = 8000;
const EXPRESS_PORT = 8100;

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
    allow_origin: "*", // NodeMediaServer will add this header for its own http server
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

// ---------------- START FFMPEG (COPY MODE — NO RE-ENCODE) ----------------
function startTranscode(streamKey) {
  if (!streamKey) return;
  if (activeTranscoders.has(streamKey)) return;

  const outDir = streamOutputDir(streamKey);
  ensureDir(outDir);

  // Cleanup old segments
  try {
    fs.readdirSync(outDir).forEach((f) =>
      fs.unlinkSync(path.join(outDir, f))
    );
  } catch {}

  const input = `rtmp://127.0.0.1:${RTMP_PORT}/live/${streamKey}`;

  const args = [
    "-hide_banner",
    "-y",
    "-i",
    input,
    "-c",
    "copy", // copy codec
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "6",
    "-hls_flags",
    "delete_segments+append_list",
    "-hls_segment_filename",
    path.join(outDir, "segment_%03d.ts"),
    path.join(outDir, "stream.m3u8"),
  ];

  console.log(`[FFMPEG] Starting copy-segmentation for key=${streamKey}`);

  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  ff.stderr.on("data", (d) => {
    console.log(`[ffmpeg ${streamKey}] ${d.toString()}`);
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
    } catch {}
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

// ---------------- EXPRESS UI SERVER ----------------
const app = express();

// enable CORS for all express routes (this will add Access-Control-Allow-Origin: * )
app.use(cors());

// serve UI
app.use(express.static(PUBLIC_DIR));

// expose media folder and ensure CORS headers for static media too
// (cors() above should handle this, but this guarantees the important expose headers)
app.use("/media", (req, res, next) => {
  // allow any origin to fetch .m3u8 and .ts
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
    rtmpUrl: `rtmp://your-host-ip-or-domain:${RTMP_PORT}/live/${key}`,
  });
});

// Master playlist (simple — 1 stream only)
// NOTE: Construct URL to the Express /media route on the EXPRESS_PORT so browser requests the same origin/port we serve files from
app.get("/stream/:key/master.m3u8", (req, res) => {
  const key = req.params.key;

  // Use host header so it works behind proxies and when accessing by IP
  const host = req.get("host").split(":")[0];
  const streamUrl = `${req.protocol}://${host}:${EXPRESS_PORT}/media/${key}/stream.m3u8`;

  const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=0
${streamUrl}
`;

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  // ensure CORS on this response too
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(master);
});

// Start Express UI
app.listen(EXPRESS_PORT, () => {
  console.log(`------------------------------------------`);
  console.log(`Express UI: http://localhost:${EXPRESS_PORT}`);
  console.log(`RTMP ingest (OBS): rtmp://<SERVER_IP>:${RTMP_PORT}/live/<KEY>`);
  console.log(`HLS output (via Express): http://<SERVER_IP>:${EXPRESS_PORT}/media/<KEY>/stream.m3u8`);
  console.log(`HLS output (NMS http): http://<SERVER_IP>:${NMS_HTTP_PORT}/<KEY>/stream.m3u8`);
  console.log(`Master playlist: http://<SERVER_IP>:${EXPRESS_PORT}/stream/<KEY>/master.m3u8`);
  console.log(`------------------------------------------`);
});
