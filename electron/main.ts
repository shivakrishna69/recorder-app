import { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { spawn } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;

const DATA_DIR = path.join(app.getPath('userData'), 'focusrec_v2');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
const DB_FILE = path.join(DATA_DIR, 'data.json');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { recordings: [] }; }
}

function writeDB(data: any) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Local HTTP server: video files + REST API ──────────────────────────────
const SERVER_PORT = 5201;

ipcMain.handle('get-recording-server-port', () => SERVER_PORT);

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function startRecordingServer() {
  const server = http.createServer(async (req, res) => {
    try {
      // CORS headers on every response
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

      if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

      const url = decodeURIComponent(req.url || '/').split('?')[0].split('#')[0];

      // ── REST API ───────────────────────────────────────────────────────────
      if (url.startsWith('/api/')) {

        // GET /api/recordings
        if (req.method === 'GET' && url === '/api/recordings') {
          const data = readDB();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data.recordings));
          return;
        }

        // /api/recordings/:id  or  /api/recordings/:id/file
        const m = url.match(/^\/api\/recordings\/(\d+)(\/file)?$/);
        if (m) {
          const id = parseInt(m[1]);
          const isFile = !!m[2];
          const db = readDB();
          const recording = db.recordings.find((r: any) => r.id === id);

          if (!recording) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }

          // GET /api/recordings/:id/file — serve file as download
          if (isFile && req.method === 'GET') {
            if (!fs.existsSync(recording.filePath)) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'File not found on disk' }));
              return;
            }
            const ext = path.extname(recording.filePath).slice(1) || 'webm';
            const contentType = ext === 'mp4' ? 'video/mp4' : 'video/webm';
            const safeName = recording.title.replace(/[/\\?%*:|"<>]/g, '-');
            const fileSize = fs.statSync(recording.filePath).size;
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Disposition': `attachment; filename="${safeName}.${ext}"`,
              'Content-Length': fileSize,
            });
            fs.createReadStream(recording.filePath).pipe(res);
            return;
          }

          // PUT /api/recordings/:id — update fields
          if (!isFile && req.method === 'PUT') {
            const fields = await parseBody(req);
            const idx = db.recordings.findIndex((r: any) => r.id === id);
            if (idx !== -1) {
              db.recordings[idx] = { ...db.recordings[idx], ...fields };
              writeDB(db);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // DELETE /api/recordings/:id
          if (!isFile && req.method === 'DELETE') {
            if (recording.filePath && fs.existsSync(recording.filePath)) {
              fs.unlinkSync(recording.filePath);
            }
            db.recordings = db.recordings.filter((r: any) => r.id !== id);
            writeDB(db);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        }

        res.writeHead(404); res.end('Not found');
        return;
      }

      // ── Video file streaming (range-request safe) ─────────────────────────
      const filename = path.basename(url);
      if (!filename) { res.writeHead(404); res.end(); return; }

      const filePath = path.join(RECORDINGS_DIR, filename);
      if (!fs.existsSync(filePath)) {
        console.error('[rec-server] not found:', filePath);
        res.writeHead(404); res.end('Not found'); return;
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const rangeHeader = req.headers['range'];

      const ext = path.extname(filename).toLowerCase();
      const contentType = ext === '.mp4' ? 'video/mp4' : 'video/webm';

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);

      if (rangeHeader) {
        const rm = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (rm) {
          const start = parseInt(rm[1]);
          const end = rm[2] ? parseInt(rm[2]) : fileSize - 1;
          const chunkSize = end - start + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunkSize,
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }

      res.writeHead(200, { 'Content-Length': fileSize });
      fs.createReadStream(filePath).pipe(res);

    } catch (err: any) {
      console.error('[rec-server] error:', err.message);
      res.writeHead(500); res.end();
    }
  });

  server.on('error', (err: any) => {
    console.error('[rec-server] failed to start on port', SERVER_PORT, err.message);
  });

  server.listen(SERVER_PORT, '127.0.0.1', () => {
    console.log('[rec-server] listening on http://127.0.0.1:' + SERVER_PORT);
  });
}
// ──────────────────────────────────────────────────────────────────────────

function createMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createWidgetWindow() {
  if (widgetWindow) return;

  widgetWindow = new BrowserWindow({
    width: 200,
    height: 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  widgetWindow.setPosition(width - 220, 50);

  if (process.env.VITE_DEV_SERVER_URL) {
    widgetWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#widget`);
  } else {
    widgetWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'widget' });
  }

  widgetWindow.on('closed', () => { widgetWindow = null; });
}

// IPC Handlers
ipcMain.handle('get-sources', async () => {
  console.log('IPC: get-sources');
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 400, height: 225 }
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL()
  }));
});

ipcMain.on('close-app', () => app.quit());
ipcMain.on('minimize-app', () => mainWindow?.minimize());
ipcMain.on('maximize-app', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});

ipcMain.on('open-dashboard', () => {
  if (!mainWindow) createMainWindow();
  else mainWindow.show();
});

const MAX_RECORDINGS = 100;

// Remux the recorded file so it is fully seekable:
//   MP4 → moves moov atom to the front (faststart)
//   WebM → ffmpeg adds Cue points so the seek bar works
// Silently skips if ffmpeg is not installed on the system.
async function makeSeekable(filePath: string): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  const tmpPath = path.join(dir, `${base}_tmp${ext}`);

  const args = ext === '.mp4'
    ? ['-i', filePath, '-movflags', '+faststart', '-c', 'copy', tmpPath, '-y']
    : ['-i', filePath, '-c', 'copy', tmpPath, '-y'];

  return new Promise<void>((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(filePath);
          fs.renameSync(tmpPath, filePath);
          console.log('[makeSeekable] remuxed for seeking:', filePath);
        } catch {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } else {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      resolve();
    });
    proc.on('error', () => resolve()); // ffmpeg not installed — silent skip
  });
}

const activeSessions = new Map<string, { filePath: string; writeStream: fs.WriteStream; timestamp: number }>();

ipcMain.handle('init-recording', async (_event, mimeType?: string) => {
  const timestamp = new Date().getTime();
  const sessionId = String(timestamp);
  const ext = (mimeType && mimeType.includes('mp4')) ? 'mp4' : 'webm';
  const filename = `recording_${timestamp}.${ext}`;
  const filePath = path.join(RECORDINGS_DIR, filename);
  const writeStream = fs.createWriteStream(filePath);
  activeSessions.set(sessionId, { filePath, writeStream, timestamp });
  console.log('IPC: init-recording', sessionId, mimeType);
  return sessionId;
});

ipcMain.handle('append-chunk', async (_event, sessionId: string, chunk: ArrayBuffer) => {
  const session = activeSessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
  const buf = Buffer.from(chunk);
  console.log('[append-chunk]', sessionId, 'bytes:', buf.byteLength);
  await new Promise<void>((resolve, reject) => {
    session.writeStream.write(buf, (err) => err ? reject(err) : resolve());
  });
  return { ok: true };
});

ipcMain.handle('finalize-recording', async (_event, { sessionId, title, duration }) => {
  const session = activeSessions.get(sessionId);
  if (!session) return { error: 'Session not found' };
  activeSessions.delete(sessionId);

  await new Promise<void>((resolve) => session.writeStream.end(resolve));
  await makeSeekable(session.filePath);

  const db = readDB();
  const newRecording = {
    id: session.timestamp,
    title: title || `Recording ${new Date().toLocaleString()}`,
    date: new Date().toISOString(),
    duration,
    filePath: session.filePath,
    status: 'idle',
  };

  db.recordings.unshift(newRecording);
  while (db.recordings.length > MAX_RECORDINGS) {
    const oldest = db.recordings.pop();
    if (oldest && fs.existsSync(oldest.filePath)) fs.unlinkSync(oldest.filePath);
  }

  writeDB(db);
  console.log('IPC: finalize-recording', sessionId, title);
  return newRecording;
});

ipcMain.handle('save-recording', async (_event, { title, duration, data }) => {
  console.log('IPC: save-recording (legacy)', title);
  const timestamp = new Date().getTime();
  const filename = `recording_${timestamp}.webm`;
  const filePath = path.join(RECORDINGS_DIR, filename);

  fs.writeFileSync(filePath, Buffer.from(data as Uint8Array));

  const db = readDB();
  const newRecording = {
    id: timestamp,
    title: title || `Recording ${new Date().toLocaleString()}`,
    date: new Date().toISOString(),
    duration,
    filePath,
    status: 'idle'
  };

  db.recordings.unshift(newRecording);
  while (db.recordings.length > MAX_RECORDINGS) {
    const oldest = db.recordings.pop();
    if (oldest && fs.existsSync(oldest.filePath)) fs.unlinkSync(oldest.filePath);
  }

  writeDB(db);
  return newRecording;
});

ipcMain.handle('download-recording', async (_event, id) => {
  try {
    const db = readDB();
    const recording = db.recordings.find((r: any) => r.id === id);
    if (!recording) return { error: 'Recording not found in database' };
    if (!fs.existsSync(recording.filePath)) return { error: `File not found on disk: ${recording.filePath}` };

    const safeName = recording.title.replace(/[/\\?%*:|"<>]/g, '-');
    const actualExt = path.extname(recording.filePath).slice(1) || 'webm';
    const filterName = actualExt === 'mp4' ? 'MP4 Video' : 'WebM Video';
    const { canceled, filePath: destPath } = await dialog.showSaveDialog({
      title: 'Save Recording',
      defaultPath: path.join(app.getPath('downloads'), `${safeName}.${actualExt}`),
      filters: [{ name: filterName, extensions: [actualExt] }],
    });
    if (canceled || !destPath) return { cancelled: true };

    fs.copyFileSync(recording.filePath, destPath);
    shell.showItemInFolder(destPath);
    return { success: true, path: destPath };
  } catch (err: any) {
    console.error('[download-recording] error:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('get-recordings', () => {
  console.log('IPC: get-recordings');
  return readDB().recordings;
});

ipcMain.handle('update-recording', (_event, { id, fields }) => {
  const db = readDB();
  const index = db.recordings.findIndex((r: any) => r.id === id);
  if (index !== -1) {
    db.recordings[index] = { ...db.recordings[index], ...fields };
    writeDB(db);
  }
  return true;
});

ipcMain.handle('delete-recording', (_event, id) => {
  const db = readDB();
  const recording = db.recordings.find((r: any) => r.id === id);
  if (recording && fs.existsSync(recording.filePath)) {
    fs.unlinkSync(recording.filePath);
  }
  db.recordings = db.recordings.filter((r: any) => r.id !== id);
  writeDB(db);
  return true;
});

ipcMain.on('recording-started', () => {
  console.log('IPC: recording-started');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-started');
  }
});

ipcMain.on('recording-stopped', () => {
  console.log('IPC: recording-stopped');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-stopped');
  }
});

ipcMain.on('resize-widget', (_event, { width, height }) => {
  console.log('IPC: resize-widget', width, height);
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setSize(width, height);
  }
});

app.whenReady().then(() => {
  ensureDirs();
  startRecordingServer();

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });

  createWidgetWindow();
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
