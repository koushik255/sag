import './styles.css';
import { MediaPlayer } from './player.js';

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
});

let currentLibrary = 'movies';
let catalog = [];
let savedSettings = { serverUrl: '', hasToken: false, tokenPersisted: false };

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
  if (!Number.isFinite(value) || value <= 0) return 'unknown length';
  const hours = Math.floor(value / 3600);
  const minutes = Math.round((value % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderCatalog() {
  const query = elements.search.value.trim().toLowerCase();
  const visible = catalog.filter((item) => `${item.title} ${item.name} ${item.year || ''}`.toLowerCase().includes(query));
  elements.library.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = query ? 'nothing matches that filter' : `no ${currentLibrary} found`;
    elements.library.append(empty);
    return;
  }

  for (const item of visible) {
    const row = document.createElement('button');
    row.className = 'media-row';
    const title = document.createElement('div');
    const primary = document.createElement('div');
    primary.className = 'media-title';
    primary.textContent = item.title || item.name;
    const secondary = document.createElement('div');
    secondary.className = 'media-subtitle';
    secondary.textContent = currentLibrary === 'clips' ? (item.created || item.name) : (item.year || item.name);
    title.append(primary, secondary);

    const codec = document.createElement('div');
    codec.className = 'media-meta';
    codec.textContent = [item.video_codec, item.audio_codec].filter(Boolean).join(' / ') || 'unprobed';
    if (['AV1', 'HEVC', 'AC3', 'EAC3'].some((name) => codec.textContent.includes(name))) codec.classList.add('codec-warning');
    const length = document.createElement('div');
    length.className = 'media-meta';
    length.textContent = humanDuration(Number(item.duration));
    const size = document.createElement('div');
    size.className = 'media-meta media-size';
    size.textContent = humanBytes(Number(item.size));
    row.append(title, codec, length, size);
    row.addEventListener('click', () => openPlayer(item));
    elements.library.append(row);
  }
}

async function loadCatalog() {
  elements.notice.hidden = true;
  elements.library.replaceChildren();
  elements.libraryNote.textContent = 'scanning…';
  try {
    const result = await window.stopAndGo.listCatalog(currentLibrary);
    catalog = result.files;
    const hidden = result.hidden ? ` · ${result.hidden} unplayable hidden by server` : '';
    elements.libraryNote.textContent = `${catalog.length} files${hidden}`;
    renderCatalog();
  } catch (error) {
    catalog = [];
    elements.libraryNote.textContent = 'offline';
    elements.notice.textContent = error instanceof Error ? error.message : String(error);
    elements.notice.hidden = false;
  }
}

function openPlayer(item) {
  elements.playerTitle.textContent = item.title || item.name;
  elements.playerDetails.textContent = [item.year, item.video_codec, item.audio_codec, item.width && item.height ? `${item.width}×${item.height}` : ''].filter(Boolean).join(' · ');
  elements.playerView.hidden = false;
  void player.open(item);
}

async function closePlayer() {
  await player.dispose();
  elements.playerView.hidden = true;
}

function showSettings() {
  elements.serverUrl.value = savedSettings.serverUrl || '';
  elements.serverToken.value = '';
  elements.serverToken.placeholder = savedSettings.hasToken ? 'leave blank to keep saved token' : 'optional';
  elements.tokenNote.textContent = savedSettings.hasToken
    ? (savedSettings.tokenPersisted ? 'token is encrypted with the system credential store' : 'token is available for this session only')
    : 'token stays in Electron and is never sent to the renderer';
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
    elements.libraryTitle.textContent = currentLibrary;
    void loadCatalog();
  });
});

document.querySelector('#open-settings').addEventListener('click', showSettings);
document.querySelector('#close-settings').addEventListener('click', () => elements.settingsDialog.close());
document.querySelector('#refresh').addEventListener('click', () => loadCatalog());
document.querySelector('#close-player').addEventListener('click', () => closePlayer());
elements.search.addEventListener('input', renderCatalog);

document.querySelector('#test-connection').addEventListener('click', async () => {
  elements.settingsStatus.textContent = 'testing…';
  try {
    await window.stopAndGo.testServer(connectionValues());
    elements.settingsStatus.textContent = 'server answered';
  } catch (error) {
    elements.settingsStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.settingsStatus.textContent = 'saving…';
  try {
    savedSettings = await window.stopAndGo.saveSettings(connectionValues());
    elements.settingsDialog.close();
    await loadCatalog();
  } catch (error) {
    elements.settingsStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

window.addEventListener('keydown', (event) => {
  if (elements.playerView.hidden) return;
  if (event.code === 'Escape') void closePlayer();
  else if (event.code === 'Space' || event.code === 'KeyK') player.toggle();
  else if (event.code === 'ArrowLeft') void player.seek(player.getTime() - 5);
  else if (event.code === 'ArrowRight') void player.seek(player.getTime() + 5);
  else return;
  event.preventDefault();
});

savedSettings = await window.stopAndGo.getSettings();
if (savedSettings.serverUrl) await loadCatalog();
else showSettings();
