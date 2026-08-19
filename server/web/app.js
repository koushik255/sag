const libraries = {
  clips: { title: 'Clips', endpoint: '/api/clips', kind: 'video' },
  screenshots: { title: 'Screenshots', endpoint: '/api/screenshots', kind: 'image' },
  movies: { title: 'Movies', endpoint: '/api/files', kind: 'video' },
};

const elements = {
  title: document.querySelector('#title'),
  count: document.querySelector('#count'),
  status: document.querySelector('#status'),
  grid: document.querySelector('#grid'),
  search: document.querySelector('#search'),
  login: document.querySelector('#login'),
  loginForm: document.querySelector('#login-form'),
  token: document.querySelector('#token'),
  viewer: document.querySelector('#viewer'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerBody: document.querySelector('#viewer-body'),
  viewerError: document.querySelector('#viewer-error'),
  original: document.querySelector('#original'),
};

let currentLibrary = 'clips';
let items = [];
let token = sessionStorage.getItem('stopandgo-token') || '';

const suppliedToken = new URLSearchParams(location.search).get('token');
if (suppliedToken) {
  token = suppliedToken;
  sessionStorage.setItem('stopandgo-token', token);
  history.replaceState(null, '', location.pathname);
}

function duration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${Math.max(1, minutes)}m`;
}

function meta(item) {
  return [item.created || item.year, duration(item.duration), item.video_codec]
    .filter(Boolean)
    .join(' · ');
}

function render() {
  const query = elements.search.value.trim().toLowerCase();
  const visible = items.filter((item) => `${item.title} ${item.name}`.toLowerCase().includes(query));
  elements.grid.replaceChildren();
  elements.count.textContent = `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`;

  for (const item of visible) {
    const card = document.createElement('button');
    card.className = 'item';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.thumbnail_url) {
      const image = document.createElement('img');
      image.src = item.thumbnail_url;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.replaceWith(fallback(item)));
      thumb.append(image);
    } else {
      thumb.append(fallback(item));
    }
    const copy = document.createElement('div');
    copy.className = 'copy';
    const title = document.createElement('strong');
    title.textContent = item.title || item.name;
    const detail = document.createElement('span');
    detail.textContent = meta(item);
    copy.append(title, detail);
    card.append(thumb, copy);
    card.addEventListener('click', () => openItem(item));
    elements.grid.append(card);
  }

  if (!visible.length) elements.status.textContent = query ? 'No matches.' : 'Nothing here yet.';
}

function fallback(item) {
  const element = document.createElement('div');
  element.className = 'fallback';
  element.textContent = (item.title || item.name || '?').slice(0, 1).toUpperCase();
  return element;
}

async function load() {
  const library = libraries[currentLibrary];
  elements.status.textContent = 'Loading…';
  elements.login.hidden = true;
  elements.grid.replaceChildren();
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(library.endpoint, { headers, cache: 'no-store' });
    if (response.status === 401) {
      elements.login.hidden = false;
      elements.status.textContent = 'Enter the StopAndGo server token.';
      elements.token.focus();
      return;
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const result = await response.json();
    items = Array.isArray(result.files) ? result.files : [];
    elements.status.textContent = result.hidden ? `${result.hidden} unavailable files hidden.` : '';
    render();
  } catch (error) {
    items = [];
    elements.status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function openItem(item) {
  const library = libraries[currentLibrary];
  elements.viewerTitle.textContent = item.title || item.name;
  elements.original.href = item.url;
  elements.viewerBody.replaceChildren();
  elements.viewerError.hidden = true;
  if (library.kind === 'image') {
    const image = document.createElement('img');
    image.src = item.url;
    image.alt = item.title || item.name;
    image.referrerPolicy = 'no-referrer';
    elements.viewerBody.append(image);
  } else {
    const video = document.createElement('video');
    video.src = item.url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener('error', () => {
      elements.viewerError.textContent = currentLibrary === 'movies'
        ? 'This movie codec is not supported by the browser. Use the MPV library.'
        : 'This clip could not be played by the browser.';
      elements.viewerError.hidden = false;
    });
    elements.viewerBody.append(video);
  }
  elements.viewer.showModal();
}

function closeViewer() {
  const video = elements.viewerBody.querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  if (elements.viewer.open) elements.viewer.close();
  elements.viewerBody.replaceChildren();
}

document.querySelectorAll('[data-library]').forEach((button) => {
  button.addEventListener('click', () => {
    currentLibrary = button.dataset.library;
    document.querySelectorAll('[data-library]').forEach((tab) => tab.classList.toggle('active', tab === button));
    elements.title.textContent = libraries[currentLibrary].title;
    elements.search.value = '';
    void load();
  });
});

elements.search.addEventListener('input', render);
document.querySelector('#refresh').addEventListener('click', () => load());
document.querySelector('#close-viewer').addEventListener('click', closeViewer);
elements.viewer.addEventListener('click', (event) => {
  if (event.target === elements.viewer) closeViewer();
});
elements.viewer.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeViewer();
});
elements.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  token = elements.token.value;
  sessionStorage.setItem('stopandgo-token', token);
  elements.token.value = '';
  void load();
});
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && elements.viewer.open) closeViewer();
});

void load();
