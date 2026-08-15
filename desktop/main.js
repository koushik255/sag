import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const allowedMediaUrls = new Set();

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

function sanitizeCatalog(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const cleanFiles = files.map((file) => {
    const url = new URL(file.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('The server returned a media URL with an unsupported protocol.');
    }
    url.searchParams.delete('token');
    url.hash = '';
    const cleanUrl = url.toString();
    allowedMediaUrls.add(cleanUrl);
    return { ...file, url: cleanUrl };
  });
  return { files: cleanFiles, hidden: Number(payload?.hidden) || 0 };
}

async function loadCatalog(kind) {
  if (!['movies', 'clips'].includes(kind)) {
    throw new Error('Unknown library.');
  }
  const endpoint = kind === 'clips' ? '/api/clips' : '/api/files';
  allowedMediaUrls.clear();
  return sanitizeCatalog(await fetchJson(endpoint));
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
