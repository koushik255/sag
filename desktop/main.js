import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const allowedMediaUrls = new Set();
const allowedThumbnailUrls = new Set();
const allowedMoviePaths = new Set();
const allowedScreenshotUrls = new Set();

let mainWindow;
let settings = {
  serverUrl: '',
  encryptedToken: '',
  sessionToken: '',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeServerUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Server URL must begin with http:// or https://');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function publicSettings() {
  return {
    serverUrl: settings.serverUrl,
    hasToken: Boolean(settings.encryptedToken || settings.sessionToken),
    tokenPersisted: Boolean(settings.encryptedToken),
  };
}

function getToken() {
  if (settings.sessionToken) {
    return settings.sessionToken;
  }
  if (!settings.encryptedToken) {
    return '';
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The system credential store is unavailable. Enter the token again.');
  }
  return safeStorage.decryptString(Buffer.from(settings.encryptedToken, 'base64'));
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8'));
    settings.serverUrl = typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '';
    settings.encryptedToken = typeof parsed.encryptedToken === 'string' ? parsed.encryptedToken : '';
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Could not read desktop settings:', error);
    }
  }
}

async function saveSettings({ serverUrl, token, keepToken = false }) {
  const normalized = normalizeServerUrl(serverUrl);
  let encryptedToken = keepToken ? settings.encryptedToken : '';
  let sessionToken = keepToken ? settings.sessionToken : '';
  let tokenPersisted = Boolean(encryptedToken);

  if (typeof token === 'string' && token.length > 0) {
    sessionToken = token;
    if (safeStorage.isEncryptionAvailable()) {
      encryptedToken = safeStorage.encryptString(token).toString('base64');
      sessionToken = '';
      tokenPersisted = true;
    } else {
      encryptedToken = '';
      tokenPersisted = false;
    }
  }

  settings = { serverUrl: normalized, encryptedToken, sessionToken };
  allowedMediaUrls.clear();
  allowedThumbnailUrls.clear();
  allowedMoviePaths.clear();
  allowedScreenshotUrls.clear();
  await writeFile(
    settingsPath(),
    `${JSON.stringify({ serverUrl: normalized, encryptedToken }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { ...publicSettings(), tokenPersisted };
}

function authHeaders(extra = {}) {
  const headers = new Headers(extra);
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

async function fetchJson(pathname) {
  if (!settings.serverUrl) {
    throw new Error('Connect to a StopAndGo server first.');
  }
  const response = await fetch(`${settings.serverUrl}${pathname}`, {
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    const detail = response.status === 401 ? 'token was rejected' : `${response.status} ${response.statusText}`;
    throw new Error(`StopAndGo server error: ${detail}`);
  }
  return response.json();
}

function sanitizeCatalog(payload, kind) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const cleanFiles = files.map((file) => {
    const url = new URL(file.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('The server returned a media URL with an unsupported protocol.');
    }
    url.searchParams.delete('token');
    url.hash = '';
    const cleanUrl = url.toString();
    if (kind === 'screenshots') {
      allowedScreenshotUrls.add(cleanUrl);
    } else {
      allowedMediaUrls.add(cleanUrl);
    }
    let thumbnailUrl = null;
    if (file.thumbnail_url) {
      const thumbnail = new URL(file.thumbnail_url);
      if (!['http:', 'https:'].includes(thumbnail.protocol)) {
        throw new Error('The server returned a thumbnail URL with an unsupported protocol.');
      }
      thumbnail.searchParams.delete('token');
      thumbnail.hash = '';
      thumbnailUrl = thumbnail.toString();
      allowedThumbnailUrls.add(thumbnailUrl);
    }
    if (kind === 'movies' && typeof file.path === 'string') {
      allowedMoviePaths.add(file.path);
    }
    return { ...file, url: cleanUrl, thumbnail_url: thumbnailUrl };
  });
  return { files: cleanFiles, hidden: Number(payload?.hidden) || 0 };
}

async function loadCatalog(kind) {
  if (!['movies', 'clips', 'screenshots'].includes(kind)) {
    throw new Error('Unknown library.');
  }
  const endpoint = kind === 'clips'
    ? '/api/clips'
    : kind === 'screenshots' ? '/api/screenshots' : '/api/files';
  allowedMediaUrls.clear();
  allowedThumbnailUrls.clear();
  allowedScreenshotUrls.clear();
  if (kind === 'movies') {
    allowedMoviePaths.clear();
  }
  return sanitizeCatalog(await fetchJson(endpoint), kind);
}

function validatedMediaUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('token');
  url.hash = '';
  const cleanUrl = url.toString();
  if (!allowedMediaUrls.has(cleanUrl)) {
    throw new Error('The requested media URL is not in the current library.');
  }
  return cleanUrl;
}

async function readMedia({ url, start, end }) {
  const cleanUrl = validatedMediaUrl(url);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error('Invalid media byte range.');
  }
  const expectedLength = end - start;
  if (expectedLength > 32 * 1024 * 1024) {
    throw new Error('Media byte range exceeds the 32 MiB safety limit.');
  }

  const response = await fetch(cleanUrl, {
    headers: authHeaders({ Range: `bytes=${start}-${end - 1}` }),
  });
  const responseLength = Number(response.headers.get('content-length'));
  if (response.status !== 206 || responseLength !== expectedLength) {
    await response.body?.cancel();
    throw new Error(`Media server did not return the exact requested range (${response.status}).`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength !== expectedLength) {
    throw new Error(`Media range was truncated: expected ${expectedLength} bytes, received ${body.byteLength}.`);
  }
  return body;
}

async function readThumbnail(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('token');
  url.hash = '';
  const cleanUrl = url.toString();
  if (!allowedThumbnailUrls.has(cleanUrl)) {
    throw new Error('The requested thumbnail is not in the current library.');
  }
  const response = await fetch(cleanUrl, { headers: authHeaders({ Accept: 'image/*' }) });
  const contentType = response.headers.get('content-type') || '';
  const contentLength = Number(response.headers.get('content-length'));
  if (!response.ok || !contentType.startsWith('image/') || contentLength > 5 * 1024 * 1024) {
    await response.body?.cancel();
    throw new Error(`Could not load thumbnail (${response.status}).`);
  }
  return {
    contentType,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

async function readScreenshot(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete('token');
  url.hash = '';
  const cleanUrl = url.toString();
  if (!allowedScreenshotUrls.has(cleanUrl)) {
    throw new Error('The requested screenshot is not in the current library.');
  }
  const response = await fetch(cleanUrl, { headers: authHeaders({ Accept: 'image/png' }) });
  const contentLength = Number(response.headers.get('content-length'));
  if (!response.ok || response.headers.get('content-type') !== 'image/png' || contentLength > 50 * 1024 * 1024) {
    await response.body?.cancel();
    throw new Error(`Could not load screenshot (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function validateMoviePath(value) {
  if (typeof value !== 'string' || !allowedMoviePaths.has(value)) {
    throw new Error('The movie is not in the current server catalog.');
  }
  return value;
}

async function postJson(pathname, value) {
  const response = await fetch(`${settings.serverUrl}${pathname}`, {
    method: 'POST',
    headers: authHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(value),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `StopAndGo server error: ${response.status}`);
  }
  return result;
}

async function createClip({ path: moviePath, end, duration = 15 }) {
  const path = validateMoviePath(moviePath);
  if (!Number.isFinite(end) || end < 0 || !Number.isFinite(duration) || duration < 1 || duration > 60) {
    throw new Error('Invalid clip time.');
  }
  return postJson('/api/export/clip', { path, end, duration });
}

async function uploadScreenshot({ path: moviePath, data }) {
  const path = validateMoviePath(moviePath);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 8 || bytes.byteLength > 50 * 1024 * 1024) {
    throw new Error('Invalid screenshot size.');
  }
  const response = await fetch(
    `${settings.serverUrl}/api/export/screenshot?${new URLSearchParams({ path })}`,
    {
      method: 'POST',
      headers: authHeaders({
        Accept: 'application/json',
        'Content-Type': 'image/png',
      }),
      body: bytes,
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `StopAndGo server error: ${response.status}`);
  }
  return result;
}

async function pickSubtitle() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose subtitles',
    properties: ['openFile'],
    filters: [
      { name: 'Subtitle files', extensions: ['srt', 'vtt', 'ass', 'ssa'] },
    ],
  });
  if (result.canceled || result.filePaths.length !== 1) return null;

  const filePath = result.filePaths[0];
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (!['srt', 'vtt', 'ass', 'ssa'].includes(extension)) {
    throw new Error('Choose an SRT, VTT, ASS, or SSA subtitle file.');
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) {
    throw new Error('The subtitle file must be smaller than 10 MB.');
  }
  return {
    name: path.basename(filePath),
    extension,
    text: await readFile(filePath, 'utf8'),
  };
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:save', (_event, value) => saveSettings(value));
  ipcMain.handle('server:test', async (_event, value) => {
    const previous = settings;
    const previousToken = value.keepToken ? getToken() : '';
    try {
      settings = {
        serverUrl: normalizeServerUrl(value.serverUrl),
        encryptedToken: '',
        sessionToken: value.token || previousToken,
      };
      await fetchJson('/api/files');
      return { ok: true };
    } finally {
      settings = previous;
    }
  });
  ipcMain.handle('catalog:list', (_event, kind) => loadCatalog(kind));
  ipcMain.handle('media:read', (_event, request) => readMedia(request));
  ipcMain.handle('thumbnail:read', (_event, url) => readThumbnail(url));
  ipcMain.handle('screenshot:read', (_event, url) => readScreenshot(url));
  ipcMain.handle('export:clip', (_event, request) => createClip(request));
  ipcMain.handle('export:screenshot', (_event, request) => uploadScreenshot(request));
  ipcMain.handle('subtitle:pick', () => pickSubtitle());
  ipcMain.handle('window:toggle-fullscreen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('The player window is unavailable.');
    const fullscreen = !window.isFullScreen();
    window.setFullScreen(fullscreen);
    return fullscreen;
  });
  ipcMain.handle('window:is-fullscreen', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 580,
    backgroundColor: '#101010',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(appDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.STOPANDGO_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(appDirectory, 'dist', 'index.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

app.whenReady().then(async () => {
  await loadSettings();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
