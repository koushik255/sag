const libraries = {
  clips: { title: 'Clips', endpoint: '/api/clips' },
  screenshots: { title: 'Screenshots', endpoint: '/api/screenshots' },
};

const elements = {
  title: document.querySelector('#title'),
  count: document.querySelector('#count'),
  status: document.querySelector('#status'),
  library: document.querySelector('#library'),
  search: document.querySelector('#search'),
  login: document.querySelector('#login'),
  loginForm: document.querySelector('#login-form'),
  token: document.querySelector('#token'),
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
  return [item.created, duration(item.duration), item.video_codec]
    .filter(Boolean)
    .join(' · ');
}

function itemDetails(item) {
  const details = document.createElement('p');
  details.textContent = meta(item);
  return details;
}

function fileLink(item) {
  const paragraph = document.createElement('p');
  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Open file';
  paragraph.append(link);
  return paragraph;
}

function renderClip(item) {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = item.title || item.name;
  const video = document.createElement('video');
  video.src = item.url;
  video.controls = true;
  video.preload = 'none';
  video.playsInline = true;
  video.width = 640;
  if (item.thumbnail_url) video.poster = item.thumbnail_url;
  video.textContent = 'Your browser cannot play this clip.';
  article.append(
    heading,
    video,
    itemDetails(item),
    fileLink(item),
    document.createElement('hr'),
  );
  return article;
}

function renderScreenshot(item) {
  const article = document.createElement('article');
  const heading = document.createElement('h2');
  heading.textContent = item.title || item.name;
  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  const image = document.createElement('img');
  image.src = item.thumbnail_url || item.url;
  image.alt = item.title || item.name;
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  image.width = 640;
  link.append(image);
  article.append(
    heading,
    link,
    itemDetails(item),
    fileLink(item),
    document.createElement('hr'),
  );
  return article;
}

function render() {
  const query = elements.search.value.trim().toLowerCase();
  const visible = items.filter((item) => (
    `${item.title} ${item.name}`.toLowerCase().includes(query)
  ));
  elements.library.replaceChildren();
  elements.count.textContent = `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`;
  for (const item of visible) {
    elements.library.append(
      currentLibrary === 'clips' ? renderClip(item) : renderScreenshot(item),
    );
  }
  if (!visible.length) {
    elements.status.textContent = query ? 'No matches.' : 'Nothing here yet.';
  }
}

async function load() {
  const library = libraries[currentLibrary];
  elements.status.textContent = 'Loading…';
  elements.login.hidden = true;
  elements.library.replaceChildren();
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
    elements.status.textContent = result.hidden
      ? `${result.hidden} unavailable files hidden.`
      : '';
    render();
  } catch (error) {
    items = [];
    elements.status.textContent = error instanceof Error ? error.message : String(error);
  }
}

document.querySelectorAll('[data-library]').forEach((button) => {
  button.addEventListener('click', () => {
    currentLibrary = button.dataset.library;
    document.querySelectorAll('[data-library]').forEach((tab) => {
      tab.setAttribute('aria-pressed', String(tab === button));
    });
    elements.title.textContent = libraries[currentLibrary].title;
    elements.search.value = '';
    void load();
  });
});

elements.search.addEventListener('input', render);
document.querySelector('#refresh').addEventListener('click', () => load());
elements.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  token = elements.token.value;
  sessionStorage.setItem('stopandgo-token', token);
  elements.token.value = '';
  void load();
});

void load();
