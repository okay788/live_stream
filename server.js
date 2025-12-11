// server.js
// Node-Media-Server + Express example with persistent media folder.
// - Serves UI on port 8100 (Express).
// - Node-Media-Server RTMP on 1935 and HTTP on 8000 (serves HLS files from MEDIA_ROOT).
// - Spawns ffmpeg per stream to generate HLS variants into MEDIA_ROOT/<streamKey>.

const NodeMediaServer = require('node-media-server');
const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const RTMP_PORT = 1935;
const NMS_HTTP_PORT = 8000; // Node-Media-Server HTTP (serves HLS)
const EXPRESS_PORT = 8100;  // UI express port

const PROJECT_ROOT = __dirname;
const PUBLIC_SRC = path.join(PROJECT_ROOT, 'public'); // your UI files (index.html, live.html)
const MEDIA_ROOT = path.join(PROJECT_ROOT, 'media');  // persistent media directory (inspect segments here)

// ensure dir exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(MEDIA_ROOT);

// copy UI into media/public so it is served by NMS HTTP if needed
try {
  copyDirSync(PUBLIC_SRC, path.join(MEDIA_ROOT, 'public'));
  console.log(`[Setup] copied UI -> ${path.join(MEDIA_ROOT, 'public')}`);
} catch (e) {
  console.warn('[Setup] copy error', e);
}

// Node-Media-Server config
const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: NMS_HTTP_PORT,
    mediaroot: MEDIA_ROOT,
    allow_origin: '*'
  }
};

const nms = new NodeMediaServer(nmsConfig);
nms.run();

const activeTranscoders = new Map();

function outDirForKey(key) {
  return path.join(MEDIA_ROOT, String(key));
}

// start ffmpeg transcode for given key (writes HLS to MEDIA_ROOT/<key>)
function startTranscode(streamKey) {
  if (!streamKey) return;
  if (activeTranscoders.has(streamKey)) return;

  const outDir = outDirForKey(streamKey);
  ensureDir(outDir);

  // Optionally remove old files in outDir
  try {
    for (const f of fs.readdirSync(outDir)) {
      try { fs.unlinkSync(path.join(outDir, f)); } catch (e) {}
    }
  } catch (e) {}

  const input = `rtmp://127.0.0.1:${RTMP_PORT}/live/${streamKey}`;

  // We spawn separate HLS outputs for 480/720/1080 in separate outputs
  // (ffmpeg command constructs three hls outputs). Adjust bitrates as needed.
  const args = [
    '-hide_banner', '-y',
    '-i', input,

    // 480p
    '-map', '0:v', '-map', '0:a?',
    '-s:v:0', '852x480', '-c:v:0', 'libx264', '-preset', 'veryfast',
    '-b:v:0', '1000k', '-maxrate:v:0', '1200k', '-bufsize:v:0', '2000k',
    '-c:a:0', 'aac', '-b:a:0', '96k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '3', '-hls_flags', 'delete_segments',
    path.join(outDir, '480.m3u8'),

    // 720p
    '-map', '0:v', '-map', '0:a?',
    '-s:v:1', '1280x720', '-c:v:1', 'libx264', '-preset', 'veryfast',
    '-b:v:1', '2500k', '-maxrate:v:1', '3000k', '-bufsize:v:1', '5000k',
    '-c:a:1', 'aac', '-b:a:1', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '3', '-hls_flags', 'delete_segments',
    path.join(outDir, '720.m3u8'),

    // 1080p
    '-map', '0:v', '-map', '0:a?',
    '-s:v:2', '1920x1080', '-c:v:2', 'libx264', '-preset', 'veryfast',
    '-b:v:2', '5000k', '-maxrate:v:2', '6000k', '-bufsize:v:2', '10000k',
    '-c:a:2', 'aac', '-b:a:2', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '3', '-hls_flags', 'delete_segments',
    path.join(outDir, '1080.m3u8')
  ];

  console.log(`[Transcode] starting ffmpeg for '${streamKey}' -> ${outDir}`);
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stdout.on('data', d => {
    console.log(`[ffmpeg ${streamKey}] stdout: ${String(d).slice(0, 300)}`);
  });
  ff.stderr.on('data', d => {
    console.log(`[ffmpeg ${streamKey}] stderr: ${String(d).slice(0, 800)}`);
  });

  ff.on('close', (code, sig) => {
    console.log(`[Transcode] ffmpeg for ${streamKey} exited code=${code} sig=${sig}`);
    activeTranscoders.delete(streamKey);
  });

  activeTranscoders.set(streamKey, ff);
}

function stopTranscode(streamKey) {
  const ff = activeTranscoders.get(streamKey);
  if (ff) {
    try { ff.kill('SIGINT'); } catch (e) { /* ignore */ }
    activeTranscoders.delete(streamKey);
  }
}

// Helpers to resolve streamKey from callbacks (StreamPath, args, session id)
function extractKeyFromStreamPath(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}
function extractKeyFromSession(obj) {
  try {
    if (!obj) return null;
    if (typeof obj.streamPath === 'string' && obj.streamPath) return extractKeyFromStreamPath(obj.streamPath);
    if (typeof obj.streamName === 'string' && obj.streamName) return obj.streamName;
    if (obj.rtmp && typeof obj.rtmp.streamName === 'string') return obj.rtmp.streamName;
  } catch (e) {}
  return null;
}
function determineKey(StreamPath, args, id) {
  let k = extractKeyFromStreamPath(StreamPath);
  if (k) return k;
  if (args && typeof args === 'object') {
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.length > 5) return v;
      const m = typeof v === 'string' && v.match(/\/live\/([0-9A-Za-z_-]{6,})/);
      if (m) return m[1];
    }
  }
  k = extractKeyFromSession(id);
  return k;
}

// NMS event handlers
nms.on('prePublish', (id, StreamPath, args) => {
  console.log('[NMS] prePublish', {
    gotStreamPath: StreamPath !== undefined,
    StreamPath,
    args,
    idSummary: id && { streamApp: id.streamApp, streamName: id.streamName, streamPath: id.streamPath }
  });
});

nms.on('postPublish', (id, StreamPath, args) => {
  console.log('[NMS] postPublish', {
    gotStreamPath: StreamPath !== undefined,
    StreamPath,
    args,
    idSummary: id && { streamApp: id.streamApp, streamName: id.streamName, streamPath: id.streamPath }
  });

  const key = determineKey(StreamPath, args, id);
  if (!key) {
    console.warn('[NMS] postPublish: could not resolve streamKey. Skipping transcode.');
    return;
  }
  console.log(`[NMS] starting transcode for key=${key}`);
  startTranscode(key);
});

nms.on('donePublish', (id, StreamPath, args) => {
  console.log('[NMS] donePublish', {
    gotStreamPath: StreamPath !== undefined,
    StreamPath,
    args,
    idSummary: id && { streamApp: id.streamApp, streamName: id.streamName, streamPath: id.streamPath }
  });

  const key = determineKey(StreamPath, args, id);
  if (!key) {
    console.warn('[NMS] donePublish: could not resolve streamKey.');
    return;
  }
  console.log(`[NMS] stopping transcode for key=${key}`);
  stopTranscode(key);
});

// Express UI server
const app = express();
app.use(express.static(PUBLIC_SRC)); // project public UI at http://localhost:8100/
app.use('/media/public', express.static(path.join(MEDIA_ROOT, 'public'))); // optional: expose UI under NMS media
// Expose the entire media folder via Express so files are accessible at http://<host>:8100/media/
app.use('/media', express.static(MEDIA_ROOT));

// API: generate random key
app.get('/api/generate', (req, res) => {
  const key = crypto.randomBytes(6).toString('hex');
  const host = req.hostname || 'localhost';
  res.json({ streamKey: key, rtmpUrl: `rtmp://${host}:${RTMP_PORT}/live/${key}` });
});

// API: list active stream directories (folders under MEDIA_ROOT)
app.get('/api/streams', (req, res) => {
  let list = [];
  try {
    list = fs.readdirSync(MEDIA_ROOT).filter(f => fs.statSync(path.join(MEDIA_ROOT, f)).isDirectory());
  } catch (e) {}
  const base = `${req.protocol}://${req.hostname}:${NMS_HTTP_PORT}`;
  const streams = list.map(k => ({
    key: k,
    urls: {
      master: `${req.protocol}://${req.hostname}:${EXPRESS_PORT}/stream/${k}/master.m3u8`,
      '480': `${base}/${k}/480.m3u8`,
      '720': `${base}/${k}/720.m3u8`,
      '1080': `${base}/${k}/1080.m3u8`
    }
  }));
  res.json(streams);
});

// Master playlist (served by Express at :8100/stream/:key/master.m3u8)
// Master references the NMS HTTP port (8000) where ffmpeg / NMS output is hosted.
app.get('/stream/:key/master.m3u8', (req, res) => {
  const key = req.params.key;
  const hostHeader = req.headers.host || req.hostname || 'localhost';
  console.log(`[master-request] hostHeader="${hostHeader}" url="${req.originalUrl}" from=${req.ip}`);
  const hostOnly = hostHeader.split(':')[0];
  const base = `${req.protocol}://${hostOnly}:${EXPRESS_PORT}/${key}`;

  const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480
${base}/480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720
${base}/720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=1920x1080
${base}/1080.m3u8
`;
    res.setHeader('Content-Type', 'application/x-mpegURL');
    console.log(base)
  res.send(master);
});

// Start express UI
app.listen(EXPRESS_PORT, () => {
  console.log(`Express UI: http://0.0.0.0:${EXPRESS_PORT}/`);
  console.log(`RTMP ingest (OBS): rtmp://<SERVER_IP>:${RTMP_PORT}/live/<STREAM_KEY>`);
  console.log(`NMS HTTP (HLS served from media/): http://0.0.0.0:${NMS_HTTP_PORT}/`);
  console.log(`Master playlist endpoint: http://0.0.0.0:${EXPRESS_PORT}/stream/<streamKey>/master.m3u8`);
});
