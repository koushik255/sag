import './styles.css';
import { MediaPlayer } from './player.js';
import { parseSubtitle } from './subtitles.js';

const elements = {
  library: document.querySelector('#library'),
  libraryTitle: document.querySelector('#library-title'),
  libraryNote: document.querySelector('#library-note'),
  notice: document.querySelector('#notice'),
  search: document.querySelector('#search'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  serverUrl: document.querySelector('#server-url'),
  serverToken: document.querySelector('#server-token'),
  tokenNote: document.querySelector('#token-note'),
  settingsStatus: document.querySelector('#settings-status'),
  playerView: document.querySelector('#player-view'),
  playerTitle: document.querySelector('#player-title'),
  playerDetails: document.querySelector('#player-details'),
  clipButton: document.querySelector('#make-clip'),
  screenshotButton: document.querySelector('#take-screenshot'),
  subtitleButton: document.querySelector('#add-subtitle'),
  exportToast: document.querySelector('#export-toast'),
  screenshotView: document.querySelector('#screenshot-view'),
  screenshotImage: document.querySelector('#screenshot-image'),
  screenshotTitle: document.querySelector('#screenshot-title'),
  screenshotDetails: document.querySelector('#screenshot-details'),
  screenshotLoading: document.querySelector('#screenshot-loading'),
  screenshotError: document.querySelector('#screenshot-error'),
};

const player = new MediaPlayer({
  stage: document.querySelector('#stage'),
  canvas: document.querySelector('#video'),
  controls: document.querySelector('#controls'),
  playButton: document.querySelector('#play'),
  currentTime: document.querySelector('#current-time'),
  timeline: document.querySelector('#timeline'),
  duration: document.querySelector('#duration'),
  mute: document.querySelector('#mute'),
  volume: document.querySelector('#volume'),
  fullscreen: document.querySelector('#fullscreen'),
  loading: document.querySelector('#player-loading'),
  error: document.querySelector('#player-error'),
  warning: document.querySelector('#player-warning'),
  subtitle: document.querySelector('#subtitle'),
});

let currentLibrary = 'movies';
let catalog = [];
let activeItem = null;
let savedSettings = { serverUrl: '', hasToken: false, tokenPersisted: false };
let renderVersion = 0;
let toastTimer;
let screenshotObjectUrl = null;
let screenshotLoadId = 0;
const thumbnailObjectUrls = new Set();

function humanBytes(value) {
  if (!Number.isFinite(value)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${amount.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function humanDuration(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function cardMeta(item) {
  return [
    currentLibrary === 'clips' || currentLibrary === 'screenshots' ? item.created : item.year,
    humanDuration(Number(item.duration)),
    item.video_codec,
  ].filter(Boolean).join(' · ');
}

function clearThumbnailUrls() {
  for (const url of thumbnailObjectUrls) URL.revokeObjectURL(url);
  thumbnailObjectUrls.clear();
}

async function hydrateThumbnails(tasks, version) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        const result = await window.stopAndGo.readThumbnail(task.url);
        const objectUrl = URL.createObjectURL(new Blob([result.body], { type: result.contentType }));
        if (version !== renderVersion || !task.image.isConnected) {
          URL.revokeObjectURL(objectUrl);
          continue;
        }
        thumbnailObjectUrls.add(objectUrl);
        task.image.src = objectUrl;
        task.image.addEventListener('load', () => task.art.classList.add('loaded'), { once: true });
      } catch {
        task.art.classList.add('unavailable');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, worker));
}

function renderCatalog() {
  const version = ++renderVersion;
  clearThumbnailUrls();
  const query = elements.search.value.trim().toLowerCase();
  const visible = catalog.filter((item) => (
    `${item.title} ${item.name} ${item.year || ''}`.toLowerCase().includes(query)
  ));
  elements.library.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const heading = document.createElement('h2');
    heading.textContent = query ? 'No matches' : `No ${currentLibrary} yet`;
    const note = document.createElement('p');
    note.textContent = query ? 'Try a different search.' : 'Refresh after adding something to the server.';
    empty.append(heading, note);
    elements.library.append(empty);
    return;
  }

  const thumbnailTasks = [];
  for (const item of visible) {
    const card = document.createElement('button');
    card.className = 'media-card';

    const art = document.createElement('div');
    art.className = 'card-art';
    const fallback = document.createElement('div');
    fallback.className = 'art-fallback';
    fallback.textContent = (item.title || item.name || '?').slice(0, 1).toUpperCase();
    art.append(fallback);

    if (item.thumbnail_url) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      art.append(image);
      thumbnailTasks.push({ image, art, url: item.thumbnail_url });
    } else {
      art.classList.add('unavailable');
    }

    const playBadge = document.createElement('span');
    playBadge.className = 'card-play';
    playBadge.textContent = currentLibrary === 'screenshots' ? '↗' : '▶';
    art.append(playBadge);
    const badge = document.createElement('span');
    badge.className = 'duration-badge';
    badge.textContent = humanDuration(Number(item.duration));
    if (!badge.textContent) badge.hidden = true;
    art.append(badge);

    const copy = document.createElement('div');
    copy.className = 'card-copy';
    const title = document.createElement('h2');
    title.textContent = item.title || item.name;
    const meta = document.createElement('p');
    meta.textContent = cardMeta(item) || humanBytes(Number(item.size));
    copy.append(title, meta);
    card.append(art, copy);
    card.addEventListener('click', () => {
      if (currentLibrary === 'screenshots') void openScreenshot(item);
      else openPlayer(item);
    });
    elements.library.append(card);
  }
  void hydrateThumbnails(thumbnailTasks, version);
}

async function loadCatalog() {
  elements.notice.hidden = true;
  elements.library.replaceChildren();
  elements.library.classList.add('loading-library');
  elements.libraryNote.textContent = 'Scanning your server…';
  try {
    const result = await window.stopAndGo.listCatalog(currentLibrary);
    catalog = result.files;
    const hidden = result.hidden ? ` · ${result.hidden} unavailable hidden` : '';
    elements.libraryNote.textContent = `${catalog.length} ${currentLibrary}${hidden}`;
    renderCatalog();
  } catch (error) {
    catalog = [];
    elements.libraryNote.textContent = 'Server unavailable';
    elements.notice.textContent = error instanceof Error ? error.message : String(error);
    elements.notice.hidden = false;
  } finally {
    elements.library.classList.remove('loading-library');
  }
}

function openPlayer(item) {
  elements.search.blur();
  activeItem = { ...item, library: currentLibrary };
  elements.playerTitle.textContent = item.title || item.name;
  elements.playerDetails.textContent = [
    item.year,
    item.video_codec,
    item.audio_codec,
    item.width && item.height ? `${item.width}×${item.height}` : '',
  ].filter(Boolean).join(' · ');
  const canExport = currentLibrary === 'movies';
  elements.clipButton.hidden = !canExport;
  elements.screenshotButton.hidden = !canExport;
  elements.subtitleButton.classList.remove('active');
  elements.subtitleButton.title = 'Add subtitles';
  elements.playerView.hidden = false;
  void player.open(item);
}

async function closePlayer() {
  await player.exitFullscreen();
  await player.dispose();
  elements.playerView.hidden = true;
  activeItem = null;
}

async function openScreenshot(item) {
  const loadId = ++screenshotLoadId;
  if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
  screenshotObjectUrl = null;
  elements.screenshotTitle.textContent = item.title || item.name;
  elements.screenshotDetails.textContent = [item.created, humanBytes(Number(item.size))].filter(Boolean).join(' · ');
  elements.screenshotImage.removeAttribute('src');
  elements.screenshotLoading.hidden = false;
  elements.screenshotError.hidden = true;
  elements.screenshotView.hidden = false;
  try {
    const data = await window.stopAndGo.readScreenshot(item.url);
    if (loadId !== screenshotLoadId) return;
    screenshotObjectUrl = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
    elements.screenshotImage.src = screenshotObjectUrl;
    elements.screenshotLoading.hidden = true;
  } catch (error) {
    elements.screenshotError.textContent = error instanceof Error ? error.message : String(error);
    elements.screenshotError.hidden = false;
    elements.screenshotLoading.hidden = true;
  }
}

function closeScreenshot() {
  screenshotLoadId++;
  elements.screenshotView.hidden = true;
  elements.screenshotImage.removeAttribute('src');
  if (screenshotObjectUrl) URL.revokeObjectURL(screenshotObjectUrl);
  screenshotObjectUrl = null;
}

function showToast(message, kind = 'success') {
  clearTimeout(toastTimer);
  elements.exportToast.textContent = message;
  elements.exportToast.dataset.kind = kind;
  elements.exportToast.hidden = false;
  toastTimer = setTimeout(() => { elements.exportToast.hidden = true; }, 3500);
}

async function createClip() {
  if (!activeItem || activeItem.library !== 'movies' || !player.loaded) return;
  elements.clipButton.disabled = true;
  showToast('Sending the last 15 seconds to the server…', 'working');
  try {
    await window.stopAndGo.createClip({ path: activeItem.path, end: player.getTime(), duration: 15 });
    showToast('Clip queued on the server');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    elements.clipButton.disabled = false;
  }
}

async function takeScreenshot() {
  if (!activeItem || activeItem.library !== 'movies' || !player.loaded) return;
  elements.screenshotButton.disabled = true;
  showToast('Saving screenshot…', 'working');
  try {
    const data = await player.capturePng();
    await window.stopAndGo.uploadScreenshot({ path: activeItem.path, data });
    showToast('Screenshot saved on the server');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    elements.screenshotButton.disabled = false;
  }
}

async function addSubtitle() {
  if (!activeItem) return;
  try {
    const file = await window.stopAndGo.pickSubtitle();
    if (!file) return;
    const cues = parseSubtitle(file.text, file.extension);
    player.setSubtitles(cues);
    elements.subtitleButton.classList.add('active');
    elements.subtitleButton.title = `Replace subtitles (${file.name})`;
    showToast(`${file.name} loaded`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

function showSettings() {
  elements.serverUrl.value = savedSettings.serverUrl || '';
  elements.serverToken.value = '';
  elements.serverToken.placeholder = savedSettings.hasToken ? 'Leave blank to keep saved token' : 'Optional';
  elements.tokenNote.textContent = savedSettings.hasToken
    ? (savedSettings.tokenPersisted ? 'Your token is secured by macOS Keychain.' : 'Token is available for this session only.')
    : 'The token stays in Electron’s main process.';
  elements.settingsStatus.textContent = '';
  elements.settingsDialog.showModal();
}

function connectionValues() {
  return {
    serverUrl: elements.serverUrl.value,
    token: elements.serverToken.value,
    keepToken: !elements.serverToken.value && savedSettings.hasToken,
  };
}

document.querySelectorAll('[data-library]').forEach((button) => {
  button.addEventListener('click', () => {
    currentLibrary = button.dataset.library;
    document.querySelectorAll('[data-library]').forEach((item) => item.classList.toggle('active', item === button));
    elements.libraryTitle.textContent = currentLibrary === 'movies'
      ? 'Movies'
      : currentLibrary === 'clips' ? 'Your Clips' : 'Screenshots';
    elements.search.value = '';
    void loadCatalog();
  });
});

document.querySelector('#open-settings').addEventListener('click', showSettings);
document.querySelector('#close-settings').addEventListener('click', () => elements.settingsDialog.close());
document.querySelector('#refresh').addEventListener('click', () => loadCatalog());
document.querySelector('#close-player').addEventListener('click', () => closePlayer());
document.querySelector('#close-screenshot').addEventListener('click', closeScreenshot);
elements.clipButton.addEventListener('click', () => createClip());
elements.screenshotButton.addEventListener('click', () => takeScreenshot());
elements.subtitleButton.addEventListener('click', () => addSubtitle());
elements.search.addEventListener('input', renderCatalog);

document.querySelector('#test-connection').addEventListener('click', async () => {
  elements.settingsStatus.textContent = 'Testing…';
  try {
    await window.stopAndGo.testServer(connectionValues());
    elements.settingsStatus.textContent = 'Connected successfully.';
  } catch (error) {
    elements.settingsStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.settingsStatus.textContent = 'Saving…';
  try {
    savedSettings = await window.stopAndGo.saveSettings(connectionValues());
    elements.settingsDialog.close();
    await loadCatalog();
  } catch (error) {
    elements.settingsStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

window.addEventListener('keydown', (event) => {
  if (!elements.screenshotView.hidden) {
    if (event.code === 'Escape') closeScreenshot();
    return;
  }
  if (elements.playerView.hidden || elements.settingsDialog.open) return;
  if (event.repeat && ['KeyS', 'Digit5', 'Numpad5'].includes(event.code)) return;

  if (event.code === 'Escape') {
    void (async () => {
      if (!(await player.exitFullscreen())) await closePlayer();
    })();
    return;
  }
  if (event.code === 'Space' || event.code === 'KeyK') player.toggle();
  else if (event.code === 'ArrowLeft') void player.seek(player.getTime() - 5);
  else if (event.code === 'ArrowRight') void player.seek(player.getTime() + 5);
  else if (event.code === 'KeyF') void player.toggleFullscreen();
  else if (event.code === 'KeyS') void takeScreenshot();
  else if (event.code === 'Digit5' || event.code === 'Numpad5') void createClip();
  else return;
  event.preventDefault();
});

savedSettings = await window.stopAndGo.getSettings();
if (savedSettings.serverUrl) await loadCatalog();
else showSettings();
