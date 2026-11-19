const DEFAULTS = { enabled: true, sharpness: 0.5, maxRes: 2880 };
const $ = (id) => document.getElementById(id);

const LABELS = {
  active: ['Upscaling', 'ok'],
  native: ['Already sharp (screen ≤ video resolution)', 'muted'],
  drm: ['Protected video (DRM) — browsers block processing', 'warn'],
  'cross-origin': ['Blocked by site security — can’t process', 'warn'],
  'no-webgl': ['WebGL2 unavailable — turn on hardware acceleration', 'warn'],
  waiting: ['Waiting for video to play', 'muted'],
  off: ['Turned off', 'muted'],
};

function sharpLabel(v) {
  return v === 0 ? 'Off (upscale only)' : `${Math.round(v * 100)}%`;
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = s.enabled;
  $('sharpness').value = Math.round(s.sharpness * 100);
  $('sharpVal').textContent = sharpLabel(s.sharpness);
  $('maxRes').value = String(s.maxRes);
});

$('enabled').addEventListener('change', (e) => {
  chrome.storage.sync.set({ enabled: e.target.checked });
  setTimeout(refreshStatus, 300);
});
$('sharpness').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 100;
  $('sharpVal').textContent = sharpLabel(v);
  chrome.storage.sync.set({ sharpness: v });
});
$('maxRes').addEventListener('change', (e) => {
  chrome.storage.sync.set({ maxRes: Number(e.target.value) });
});

function refreshStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    const box = $('status');
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'upscaler-status' }, (res) => {
      void chrome.runtime.lastError;
      if (!res || !res.videos || !res.videos.length) {
        box.className = 'muted';
        box.textContent = 'No video found on this tab yet. Start playing one (reload the page if it was already open before installing).';
        return;
      }
      box.className = '';
      box.innerHTML = '';
      for (const v of res.videos) {
        const [text, cls] = LABELS[v.status] || [v.status, 'muted'];
        const row = document.createElement('div');
        row.className = 'vid';
        const a = document.createElement('span');
        a.className = cls;
        a.textContent = text;
        const b = document.createElement('span');
        b.className = 'muted';
        b.textContent = v.out ? `${v.src} → ${v.out}` : v.src;
        row.append(a, b);
        box.append(row);
      }
    });
  });
}
refreshStatus();
setInterval(refreshStatus, 1500);
