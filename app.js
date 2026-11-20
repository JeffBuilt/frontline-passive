/* Frontline Compliance and Fire - passive fire app (offline-first PWA) */
'use strict';

const APP_VERSION = '2.1.0';
const SERVER_URL = 'https://script.google.com/macros/s/AKfycbyZOt9Zo4c6xSaY2YV8H8NXMR4NHx77dT6tz_qEVp1bZX-rNVVZJ7nDVpnh2G2DF_wW/exec';
const LS = { setup: 'pf_setup', config: 'pf_config', loc: 'pf_loc', draft: 'pf_draft', localLocs: 'pf_local_locs', area: 'pf_area', rdraft: 'pf_rdraft' };
const FACES = ['Wall', 'Floor', 'Ceiling / slab'];
const DEFAULT_BUILDINGS = { Austin: ['AT', 'HSB', 'LTB'], Repat: ['NW', 'Cent', 'CPU', 'Coral'] };
const OTHER = 'Not listed…';
const OPEN = ['Allocated', 'Quoted', 'PO Received'];
const PRICE_EDITABLE = ['Requested', 'Scouted', 'Allocated'];
const MAX_PHOTO_PX = 1600;
const JPEG_QUALITY = 0.72;

/* ---------------- storage ---------------- */

const db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('pf', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'recordKey' });
      req.onsuccess = () => { this._db = req.result; res(this._db); };
      req.onerror = () => rej(req.error);
    });
  },
  async write(fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('queue', 'readwrite');
      fn(t.objectStore('queue'));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  },
  put(item) { return this.write(s => s.put(item)); },
  del(key) { return this.write(s => s.delete(key)); },
  async all() {
    const d = await this.open();
    return new Promise((res, rej) => {
      const req = d.transaction('queue').objectStore('queue').getAll();
      req.onsuccess = () => res(req.result.sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => rej(req.error);
    });
  },
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full */ } },
  del(k) { localStorage.removeItem(k); },
};

/* ---------------- state ---------------- */

const state = {
  tab: 'home',
  screen: 'home',            // home | loc | peno | saved | jobs | browse | edit | queue
  mode: 'new',               // new | old
  setup: store.get(LS.setup, null),
  config: store.get(LS.config, null),
  loc: store.get(LS.loc, { site: 'Austin', building: '', level: '', room: '' }),
  draft: null,
  lastSaved: null,
  queue: [],
  syncing: false,
  photoTarget: null,
  doneJob: null,
  edit: null,
  search: '',
  area: store.get(LS.area, null),
};

function freshDraft(keep) {
  const today = new Date().toISOString().slice(0, 10);
  const d = { photo: '', beforePhoto: '', face: 'Wall', substrate: '', type: '', size: '', product: '', qty: 1, access: '', notes: '', customUnit: '', clientType: '', doneDate: today, vp: '' };
  return keep ? Object.assign(d, keep) : d;
}
state.draft = Object.assign(freshDraft(), store.get(LS.draft, {}));

/* ---------------- helpers ---------------- */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-AU');
const uniq = arr => [...new Set(arr.filter(Boolean))];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = s => String(s || '').trim().toLowerCase();
const fmtDate = s => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }); };

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const locKey = l => [l.site, l.building, l.level, l.room].map(norm).join('|');
const locLabel = l => `${l.building} ${l.level} - ${l.room}`;
const locReady = l => !!(l.site && l.building && l.level && l.room);
const saveDraft = () => store.set(LS.draft, state.draft);
const saveLoc = () => store.set(LS.loc, state.loc);

function buildingList(site) {
  const b = state.config && state.config.buildings && state.config.buildings[site];
  return (b && b.length) ? b : (DEFAULT_BUILDINGS[site] || []);
}
const perms = () => (state.config && state.config.perms) || { passive: state.config && state.config.role === 'client' ? 'log' : 'full', repairs: 'none', sit: 'none', dashboard: false, admin: false };
const passiveLevel = () => perms().passive;
const isClient = () => passiveLevel() === 'log';
const sitesList = () => (state.config && state.config.sites && state.config.sites.length) ? state.config.sites : ['Austin', 'Repat'];
function buildingName(site, code) { const n = state.config && state.config.buildingNames; return (n && n[site + '|' + code]) || ''; }

/* Locations are saved in one standard format: L5, B1, G, Roof; rooms in normal capitals. (Same rules as the server.) */
function normLevel(v) {
  const s = String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  let m;
  if ((m = s.match(/^(?:LEVEL|LVL|LEV|L)\s*-?\s*(\d+)$/)) || (m = s.match(/^(\d+)$/))) return 'L' + Number(m[1]);
  if ((m = s.match(/^(?:BASEMENT|BSMT|B)\s*-?\s*(\d+)$/))) return 'B' + Number(m[1]);
  if (/^(G|GF|GROUND|GROUND FLOOR|LEVEL G|L0|LEVEL 0)$/.test(s)) return 'G';
  if (/^(LG|LOWER GROUND)$/.test(s)) return 'LG';
  if (/^(UG|UPPER GROUND)$/.test(s)) return 'UG';
  if (/^(RF|ROOF|ROOFTOP)$/.test(s)) return 'Roof';
  if (/^(MEZZ|MEZZANINE)$/.test(s)) return 'Mezz';
  return s.replace(/[^A-Z0-9 ]/g, '');
}
function normRoom(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').split(' ').map(w =>
    (/^[A-Z]{2,3}$/.test(w) || /\d/.test(w)) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
function normBuildingText(v) { const r = String(v || '').trim().replace(/\s+/g, ' '); return r.length <= 6 && r.indexOf(' ') < 0 ? r.toUpperCase() : normRoom(r); }
function clientTypes() { return (state.config && state.config.clientTypes) || ['Cables', 'Cable tray', 'Metal pipe', 'Plastic pipe', 'Duct', 'Other']; }
function rates() { return (state.config && state.config.rates) || []; }
function accessOpts() { return (state.config && state.config.access && state.config.access.length) ? state.config.access : [{ name: 'Standard (floor level)', loading: 0, extra: 0 }]; }
function substrates() { return (state.config && state.config.substrates) || ['Plasterboard', 'Block / brick', 'Concrete', 'Other']; }
function records() { return (state.config && state.config.records) || []; }

function priceOf(d) {
  const rate = rates().find(r => r.type === d.type && r.size === d.size && r.product === d.product);
  const custom = !!(rate && rate.unit === 0);
  const unit = custom ? (Number(d.customUnit) || 0) : (rate ? rate.unit : (Number(d.unit) || 0));
  const acc = accessOpts().find(a => a.name === d.access) || accessOpts()[0];
  const qty = Number(d.qty) || 1;
  return { unit, custom, loading: acc.loading, extra: acc.extra, access: acc.name, total: Math.round(qty * unit * (1 + acc.loading) + acc.extra) };
}

/* ---------------- penetration codes ---------------- */

function levelCode(level) {
  const s = String(level).trim().toUpperCase().replace(/^LEVEL\s*/, 'L');
  const m = s.match(/^L\s*(\d+)$/);
  return (m ? m[1] : s).replace(/[^A-Z0-9]/g, '');
}

function allLocations() {
  return ((state.config && state.config.locations) || []).concat(store.get(LS.localLocs, []));
}

function roomNoFor(l) {
  const k = locKey(l);
  const hit = allLocations().find(x => locKey(x) === k && Number(x.roomNo) > 0);
  if (hit) return Number(hit.roomNo);
  const sameLevel = allLocations().filter(x => norm(x.site) === norm(l.site) && norm(x.building) === norm(l.building) && norm(x.level) === norm(l.level));
  const n = sameLevel.reduce((m, x) => Math.max(m, Number(x.roomNo) || 0), 0) + 1;
  const local = store.get(LS.localLocs, []);
  local.push({ site: l.site, building: l.building, level: l.level, room: l.room, roomNo: n });
  store.set(LS.localLocs, local);
  return n;
}

function usedCodes() {
  return new Set(records().map(r => r.code.toUpperCase())
    .concat(state.queue.filter(q => q.action === 'submit').map(q => String(q.record.code).toUpperCase())));
}

function makeCode(l) {
  const roomNo = roomNoFor(l);
  const prefix = `${String(l.building).toUpperCase().replace(/[^A-Z0-9]/g, '')}${levelCode(l.level)}.${roomNo}.`;
  const used = usedCodes();
  for (let i = 0; i < 500; i++) {
    const code = prefix + (100 + Math.floor(Math.random() * 900));
    if (!used.has(code)) return { code, roomNo };
  }
  return { code: prefix + Date.now().toString().slice(-4), roomNo };
}

/* ---------------- photos ---------------- */

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', JPEG_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read photo')); };
    img.src = url;
  });
}

// target: 'photo' | 'beforePhoto' (draft), 'done', 'editBefore', 'editAfter'
function takePhoto(target) {
  state.photoTarget = target;
  const cam = $('#camera'); cam.value = ''; cam.click();
}

$('#camera').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await compressImage(file);
    const t = state.photoTarget;
    if (typeof t === 'function') { t(data); return; }
    if (t === 'done' && state.doneJob) { state.doneJob.photo = data; renderDone(); return; }
    if (t === 'editBefore' && state.edit) { state.edit.newBefore = data; render(); return; }
    if (t === 'editAfter' && state.edit) { state.edit.newAfter = data; render(); return; }
    state.draft[t === 'beforePhoto' ? 'beforePhoto' : 'photo'] = data;
    saveDraft(); render();
  } catch (err) { toast(err.message); }
});

/* ---------------- server ---------------- */

async function api(action, payload) {
  if (!state.setup) throw new Error('App not set up');
  const res = await fetch(state.setup.u, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, key: state.setup.k }, payload || {})),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('Server error ' + res.status);
  const data = await res.json();
  if (!data.ok) { const err = new Error(data.error || 'Request failed'); err.server = true; throw err; }
  return data;
}

async function refreshConfig(quiet) {
  try {
    const cfg = await api('config');
    state.config = cfg;
    store.set(LS.config, cfg);
    // local room numbers now on the server can be dropped
    const known = new Set((cfg.locations || []).map(locKey));
    store.set(LS.localLocs, store.get(LS.localLocs, []).filter(l => !known.has(locKey(l))));
    if (!quiet) toast('Up to date');
    render();
    return true;
  } catch (err) {
    if (!quiet) toast(navigator.onLine ? err.message : 'No signal. Using saved lists.');
    return false;
  }
}

async function sync() {
  if (state.syncing) return;
  state.queue = await db.all();
  if (!state.queue.length) { await refreshConfig(true); updateHeader(); return; }
  state.syncing = true; updateHeader();
  let sent = 0, failed = null;
  const notes = [];
  for (const item of state.queue) {
    try {
      const res = await api(item.action, { record: item.record });
      if (res.changed) notes.push(`${item.record.code} was already used, saved as ${res.code}. Re-tag it.`);
      await db.del(item.recordKey);
      sent++;
    } catch (err) {
      if (err.server && /not found|invoiced|only be/i.test(err.message)) { notes.push(err.message); await db.del(item.recordKey); continue; }
      failed = err; break;
    }
  }
  state.syncing = false;
  state.queue = await db.all();
  if (sent) await refreshConfig(true);
  updateHeader(); render();
  if (notes.length) toast(notes.join(' '), 6000);
  else if (failed) toast(failed.server ? failed.message : `Synced ${sent}. No signal for the rest.`, 3500);
  else if (sent) toast(`All synced (${sent})`);
}

/* ---------------- header / nav ---------------- */

function updateHeader() {
  const n = state.queue.length;
  const btn = $('#syncBtn');
  btn.textContent = state.syncing ? 'Syncing…' : (n ? `Sync ${n}` : 'Synced');
  btn.className = n ? '' : 'idle';
  const b = $('#qBadge'); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
  $('#net').textContent = navigator.onLine ? '' : 'Offline';
}

function go(screen, tab) {
  state.screen = screen;
  if (tab) state.tab = tab;
  $$('nav button').forEach(x => x.classList.toggle('on', x.dataset.tab === state.tab));
  render(); window.scrollTo(0, 0);
}

$('#syncBtn').addEventListener('click', () => sync());
window.addEventListener('online', () => { updateHeader(); sync(); });
window.addEventListener('offline', updateHeader);
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab, b.dataset.tab); });
$('#areaBtn').addEventListener('click', () => { if (state.queue.length && !navigator.onLine) toast('Items still waiting to sync. They\'ll upload when you have signal.'); state.area = null; store.set(LS.area, null); render(); });

/* ---------------- render ---------------- */

/* Areas: the start screen shows the ones this login can use. Once in an area the app stays there. */
const AREAS = {
  passive: { name: 'Passive fire', sub: 'Penetrations', icon: 'wall' },
  repairs: { name: 'Fire repairs', sub: 'Doors, sprinklers, hydrants and more', icon: 'door' },
  sit: { name: 'SIT', sub: 'System interface tests', icon: 'list' },
  office: { name: 'Back office', sub: 'Dashboard, planning, locations, users', icon: 'chart' },
};
function areasAllowed() {
  const p = perms(), out = [];
  if (p.passive && p.passive !== 'none') out.push('passive');
  if (p.repairs && p.repairs !== 'none') out.push('repairs');
  if (p.sit && p.sit !== 'none') out.push('sit');
  if (p.dashboard || p.admin) out.push('office');
  return out;
}
function navFor(area) {
  if (area === 'passive') return [['home', 'Home'], ['browse', isClient() ? 'My requests' : 'Find'], ['queue', 'Waiting']];
  if (area === 'repairs') return [['rhome', 'Home'], ['rfind', perms().repairs === 'log' ? 'My repairs' : 'Find'], ['queue', 'Waiting']];
  if (area === 'sit') return [['sit', 'Tests'], ['queue', 'Waiting']];
  if (area === 'office') return [['dash', 'Dashboard'], ['plan', 'Plan'], ['locs', 'Locations'], ['users', 'Users'], ['history', 'History']].filter(t => perms().admin || t[0] === 'dash' || t[0] === 'history');
  return [];
}
function homeOf(area) { return navFor(area)[0][0]; }
function enterArea(area) {
  state.area = area; store.set(LS.area, area);
  state.screen = homeOf(area); state.tab = state.screen;
  render(); window.scrollTo(0, 0);
}

/* Every area registers its screens here: VIEWS[area][screen] = [render, bind]. 'loc' and 'queue' are shared. */
const VIEWS = {};

function render() {
  const main = $('#main');
  const nav = $('#nav'), areaBtn = $('#areaBtn');
  document.body.classList.toggle('wide', state.area === 'office');
  if (!state.setup) { nav.classList.add('hidden'); areaBtn.classList.add('hidden'); main.innerHTML = renderSetup(); bindSetup(); return; }
  if (!state.config) { nav.classList.add('hidden'); main.innerHTML = `<div class="card"><h2>Loading</h2><p>Connecting to Frontline…</p><button class="big" id="retry">Try again</button></div>`; $('#retry').onclick = () => refreshConfig(); return; }
  const allowed = areasAllowed();
  if (state.area && !allowed.includes(state.area)) state.area = null;
  if (!state.area && allowed.length === 1) { state.area = allowed[0]; state.screen = homeOf(state.area); }
  if (!state.area) {
    nav.classList.add('hidden'); areaBtn.classList.add('hidden');
    main.innerHTML = renderStart(allowed); bindStart(); updateHeader(); return;
  }
  // header: which area, tap to switch
  areaBtn.classList.toggle('hidden', allowed.length < 2);
  areaBtn.textContent = AREAS[state.area].name + ' ▾';
  areaBtn.dataset.area = state.area;
  const tabs = navFor(state.area);
  const key = tabs.map(t => t.join(':')).join('|');
  if (nav.dataset.key !== key) {
    nav.innerHTML = tabs.map(([t, l]) => `<button data-tab="${t}">${esc(l)}${t === 'queue' ? ' <span id="qBadge" class="badge hidden">0</span>' : ''}</button>`).join('');
    nav.dataset.key = key;
  }
  nav.classList.remove('hidden');
  const known = Object.assign({}, VIEWS[state.area] || {}, { loc: [renderLoc, bindLoc], queue: [renderQueue, bindQueue] });
  if (!known[state.screen]) { state.screen = homeOf(state.area); state.tab = state.screen; }
  $$('nav button').forEach(x => x.classList.toggle('on', x.dataset.tab === state.tab));
  const [r, b] = known[state.screen];
  main.innerHTML = r(); b();
  updateHeader();
}

/* ---- start screen ---- */

const AREA_ICONS = {
  wall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9.5h18M3 15h18M9 4v5.5M15 9.5V15M9 15v5"/><circle cx="15" cy="17.5" r="1.3" fill="currentColor"/></svg>',
  door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="15.5" cy="12.5" r="1.2" fill="currentColor"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.2 1.2L7 4.8M3.5 12l1.2 1.2L7 10.8M3.5 18l1.2 1.2L7 16.8"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
};

function areaStat(a) {
  const c = state.config;
  if (a === 'passive') {
    if (isClient()) { const n = records().filter(r => r.status !== 'Fixed').length; return n ? `${n} open request${n === 1 ? '' : 's'}` : AREAS[a].sub; }
    const bank = records().filter(r => r.status === 'Scouted').reduce((t, r) => t + r.price, 0);
    const req = records().filter(r => r.status === 'Requested').length;
    return `${money(bank)} in the bank${req ? ` · ${req} client request${req === 1 ? '' : 's'}` : ''}`;
  }
  if (a === 'repairs' && c.repairs) {
    const recs = c.repairs.records;
    if (c.repairs.level === 'log') { const n = recs.filter(r => r.status !== 'Fixed').length; return n ? `${n} open` : AREAS[a].sub; }
    const toQuote = recs.filter(r => r.status === 'Logged').length, jobs = recs.filter(r => r.status === 'PO Received').length;
    return (toQuote || jobs) ? `${toQuote} to quote · ${jobs} to do` : AREAS[a].sub;
  }
  if (a === 'sit' && c.sit) { const n = c.sit.tests.filter(t => t.status !== 'Complete').length; return n ? `${n} open test${n === 1 ? '' : 's'}` : AREAS[a].sub; }
  return AREAS[a].sub;
}

function renderStart(allowed) {
  return `<div class="hero"><img src="logo-header.png" alt="Frontline Compliance and Fire"></div>
    <p class="hello-line">Hi ${esc(state.config.user)}${state.config.company ? ', ' + esc(state.config.company) : ''}. What are you working on?</p>
    ${allowed.map((a, i) => `<button class="tile area ${i === 0 ? 'primary' : ''} a-${a}" data-area="${a}"><span class="ico">${AREA_ICONS[AREAS[a].icon]}</span>
      <span><strong>${AREAS[a].name}</strong><span class="d">${esc(areaStat(a))}</span></span></button>`).join('')}
    ${allowed.length ? '' : '<div class="card"><p>This login has no areas switched on yet. Ask Jeff.</p></div>'}
    <p class="muted center">Frontline Compliance and Fire · v${APP_VERSION}</p>`;
}
function bindStart() { $$('[data-area]').forEach(b => b.onclick = () => enterArea(b.dataset.area)); }

/* ---- setup ---- */

function renderSetup() {
  return `<div class="hero"><img src="logo-header.png" alt="Frontline Compliance and Fire"></div><div class="card"><h2>Set up this device</h2>
    <p>Type the login code Frontline gave you, e.g. fox4821. You only do this once per phone or computer.</p>
    <input id="code" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Setup code" style="font-size:22px;letter-spacing:.04em">
    <p id="setupErr" class="err"></p>
    <button class="big" id="saveSetup" style="margin-top:6px">Connect</button>
    <p class="muted">Version ${APP_VERSION}</p></div>`;
}

function parseSetup(raw) {
  const s = raw.trim();
  if (/^[a-z]+\s*-?\s*\d{4}$/i.test(s)) return { u: SERVER_URL, k: s.replace(/[\s-]/g, '').toLowerCase() };
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const obj = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
  if (!obj.u || !obj.k) throw new Error();
  return obj;
}

function bindSetup() {
  const go_ = async () => {
    let obj;
    try { obj = parseSetup($('#code').value); } catch (e) { $('#setupErr').textContent = 'That code doesn\'t look right. It should be a word and 4 numbers.'; return; }
    state.setup = obj; store.set(LS.setup, obj);
    $('#saveSetup').textContent = 'Connecting…';
    if (!(await refreshConfig(true))) {
      state.setup = null; store.del(LS.setup);
      $('#setupErr').textContent = 'Could not connect. Check the code and that you have signal.';
      $('#saveSetup').textContent = 'Connect'; return;
    }
    toast(`Welcome ${state.config.user}`); state.area = null; store.set(LS.area, null); render();
  };
  $('#saveSetup').onclick = go_;
  $('#code').onkeydown = e => { if (e.key === 'Enter') go_(); };
}

/* ---- home ---- */

const ICONS = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
};

function renderHome() {
  const recs = records();
  const scouted = recs.filter(r => r.status === 'Scouted');
  const open = recs.filter(r => OPEN.includes(r.status));
  const reqs = recs.filter(r => r.status === 'Requested');
  const queuedNew = state.queue.filter(q => q.action === 'submit' && q.record.mode !== 'old');
  const bank = scouted.reduce((s, r) => s + r.price, 0) + queuedNew.reduce((s, q) => s + q.price, 0);
  const n = scouted.length + queuedNew.length;
  const months = bank ? bank / (state.config.settings.monthMin || 12000) : 0;
  return `
  <div class="bank"><p class="hello">Hi ${esc(state.config.user)}, work in the bank</p>
    <div class="amount">${money(bank)}</div>
    <p class="sub">${n} penetration${n === 1 ? '' : 's'} scouted, not yet on a PO${months >= 0.1 ? `. About ${months.toFixed(1)} months of work.` : ''}</p></div>
  <button class="tile primary" data-go="new"><span class="ico">${ICONS.plus}</span><span><strong>Add new</strong><span class="d">Scout penetrations to quote</span></span></button>
  <button class="tile" data-go="old"><span class="ico">${ICONS.history}</span><span><strong>Add old</strong><span class="d">Log work already done</span></span></button>
  <button class="tile" data-go="jobs"><span class="ico">${ICONS.check}</span><span><strong>Completed</strong><span class="d">Mark jobs done with an after photo</span></span>${open.length ? `<span class="count">${open.length}</span>` : ''}</button>
  ${reqs.length ? `<button class="tile" data-go="requests"><span class="ico">${ICONS.inbox}</span><span><strong>Client requests</strong><span class="d">Logged by the client. Price them into the bank.</span></span><span class="count">${reqs.length}</span></button>` : ''}
  <button class="tile" data-go="browse"><span class="ico">${ICONS.search}</span><span><strong>Find and edit</strong><span class="d">Search by code, location or quote</span></span></button>`;
}

function bindHome() {
  $$('[data-go]').forEach(b => b.onclick = () => {
    const g = b.dataset.go;
    if (g === 'new' || g === 'old') {
      state.mode = g;
      state.draft = freshDraft({ face: state.draft.face, access: state.draft.access });
      saveDraft();
      go(locReady(state.loc) ? 'peno' : 'loc');
    } else go(g, g === 'browse' ? 'browse' : 'home');
  });
}

/* ---- location ---- */

function roomStats(l) {
  const k = locKey(l);
  const recs = records().filter(r => locKey(r) === k && r.status === 'Scouted');
  const q = state.queue.filter(x => x.action === 'submit' && x.record.mode !== 'old' && locKey(x.record) === k);
  return { n: recs.length + q.length, v: recs.reduce((s, r) => s + r.price, 0) + q.reduce((s, x) => s + x.price, 0) };
}

function roomBanner(l) {
  if (isClient() || state.area !== 'passive') return '';
  const t = roomStats(l);
  const min = state.config.settings.poMin, max = state.config.settings.poMax;
  const cls = t.v < min ? 'low' : t.v > max ? 'high' : 'good';
  const hint = t.v < min ? `${money(min - t.v)} to a full PO` : t.v > max ? 'More than one PO, will be split' : 'PO-sized';
  return `<div class="roomtotal ${cls}"><strong>${esc(locLabel(l))}</strong>: ${t.n} unallocated, ${money(t.v)} · <span class="muted">${hint}</span></div>`;
}

function locLists(L) {
  const locs = allLocations().filter(l => norm(l.site) === norm(L.site));
  return {
    buildings: uniq(locs.map(l => l.building)),
    levels: uniq(locs.filter(l => norm(l.building) === norm(L.building)).map(l => l.level)),
    rooms: uniq(locs.filter(l => norm(l.building) === norm(L.building) && norm(l.level) === norm(L.level)).map(l => l.room)),
  };
}
const opts = arr => arr.map(b => `<option value="${esc(b)}">`).join('');

function locPreview(L) {
  if (!locReady(L)) return '';
  const known = buildingList(L.site).some(b => norm(b) === norm(L.building));
  const exists = allLocations().some(x => locKey(x) === locKey(L));
  const label = `${L.building}${buildingName(L.site, L.building) ? ' (' + buildingName(L.site, L.building) + ')' : ''} · ${L.level} · ${L.room}`;
  const note = !known ? 'New building. Frontline will check it and add it to the list.' : exists ? '' : 'New room on our list.';
  return `<p class="muted" style="margin-top:10px">Saves as <strong>${esc(label)}</strong>${note ? '<br>' + esc(note) : ''}</p>`;
}

function locNextScreen() { return state.area === 'repairs' ? 'rlog' : 'peno'; }

function renderLoc() {
  const L = state.loc, o = locLists(L);
  const sites = sitesList();
  if (!sites.includes(L.site)) { L.site = sites[0]; L.building = ''; L.level = ''; L.room = ''; }
  const list = buildingList(L.site);
  const isOther = !!L.building && !list.some(b => norm(b) === norm(L.building));
  const other = state.otherBuilding || isOther;
  const title = state.area === 'repairs' ? 'Where is the fault?' : isClient() ? 'Where is it?' : state.mode === 'old' ? 'Where was the work done?' : 'Where are you scouting?';
  return `<div class="card"><h2>${title}</h2>
    ${sites.length > 1 ? `<div class="chips">${sites.map(x => `<button class="chip ${L.site === x ? 'on' : ''}" data-site="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
    <label>Building</label>
    <select id="buildingSel"><option value="">Choose…</option>${list.map(b => `<option value="${esc(b)}" ${!other && norm(b) === norm(L.building) ? 'selected' : ''}>${esc(b)}${buildingName(L.site, b) ? ' · ' + esc(buildingName(L.site, b)) : ''}</option>`).join('')}<option value="${OTHER}" ${other ? 'selected' : ''}>${OTHER}</option></select>
    ${other ? `<input id="building" style="margin-top:8px" value="${esc(L.building)}" placeholder="Building name or code">` : ''}
    <div class="row">
      <div><label>Level</label><input id="level" list="dlL" value="${esc(L.level)}" placeholder="L5, G, B1, Roof"></div>
      <div><label>Room / area</label><input id="room" list="dlR" value="${esc(L.room)}" placeholder="Plant Room"></div>
    </div>
    <datalist id="dlL">${opts(o.levels)}</datalist>
    <datalist id="dlR">${opts(o.rooms)}</datalist>
    <div id="locPrev">${locPreview(L)}</div>
    <div id="locBanner">${locReady(L) ? roomBanner(L) : ''}</div>
    <button class="big" id="locNext" style="margin-top:14px" ${locReady(L) ? '' : 'disabled'}>Start adding here</button>
  </div>`;
}

function bindLoc() {
  const L = state.loc;
  $$('[data-site]').forEach(b => b.onclick = () => {
    if (L.site !== b.dataset.site) { L.site = b.dataset.site; L.building = ''; L.level = ''; L.room = ''; state.otherBuilding = false; }
    saveLoc(); render();
  });
  const fix = { building: normBuildingText, level: normLevel, room: normRoom };
  const refresh = () => {
    const o = locLists(L);
    $('#dlL').innerHTML = opts(o.levels); $('#dlR').innerHTML = opts(o.rooms);
    $('#locBanner').innerHTML = locReady(L) ? roomBanner(L) : '';
    $('#locPrev').innerHTML = locPreview(L);
    $('#locNext').disabled = !locReady(L);
  };
  $('#buildingSel').onchange = e => {
    const v = e.target.value;
    if (v === OTHER) { state.otherBuilding = true; L.building = ''; saveLoc(); render(); const i = $('#building'); if (i) i.focus(); return; }
    state.otherBuilding = false; L.building = v; saveLoc(); render();
  };
  ['building', 'level', 'room'].forEach(f => {
    const el = $('#' + f);
    if (!el) return;
    el.oninput = () => { L[f] = el.value.trim(); saveLoc(); $('#locNext').disabled = !locReady(L); };
    el.onchange = () => {
      let v = fix[f](el.value);
      // match a room/level already on our list, ignoring case, so the same place is always spelled the same
      const pool = f === 'room' ? locLists(L).rooms : f === 'level' ? locLists(L).levels : buildingList(L.site);
      const hit = pool.find(x => norm(x) === norm(v));
      if (hit) v = hit;
      L[f] = v; el.value = v; saveLoc(); refresh();
    };
  });
  $('#locNext').onclick = () => {
    ['building', 'level', 'room'].forEach(f => { const el = $('#' + f); if (el) L[f] = fix[f](el.value); });
    if (!L.building || !L.level || !L.room) return;
    state.otherBuilding = false;
    saveLoc(); go(locNextScreen());
  };
}

/* ---- penetration form ---- */

function penoFields(d, opts) {
  const all = rates();
  const types = uniq(all.map(r => r.type));
  const sizes = uniq(all.filter(r => r.type === d.type).map(r => r.size));
  const products = all.filter(r => r.type === d.type && r.size === d.size);
  const p = priceOf(d);
  const lockPrice = opts && opts.lockPrice;
  return `
    <label>Face</label>
    <div class="chips">${FACES.map(f => `<button class="chip ${d.face === f ? 'on' : ''}" data-face="${f}">${f}</button>`).join('')}</div>
    <label>Wall / slab type <span class="muted">(internal only)</span></label>
    <div class="chips">${substrates().map(s => `<button class="chip ${d.substrate === s ? 'on' : ''}" data-sub="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    ${lockPrice ? `<p class="muted" style="margin-top:12px">${esc(d.type)} · ${esc(d.size)} · ${esc(d.product)} × ${d.qty} · ${esc(d.access)}. Pricing is locked at this status; change it in the sheet.</p>` : `
    <label>Type</label>
    <div class="chips">${types.map(x => `<button class="chip ${d.type === x ? 'on' : ''}" data-type="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    ${d.type ? `<label>Size</label><div class="chips">${sizes.map(x => `<button class="chip ${d.size === x ? 'on' : ''}" data-size="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
    ${d.size ? `<label>Product</label><div class="chips">${products.map(r => `<button class="chip ${d.product === r.product ? 'on' : ''}" data-product="${esc(r.product)}">${esc(r.product)}<small>${r.unit ? money(r.unit) + ' each' : 'Enter price'}</small></button>`).join('')}</div>` : ''}
    ${p.custom && d.product ? `<label>Price each ($ ex GST)</label><input id="customUnit" type="number" inputmode="decimal" value="${esc(d.customUnit)}">` : ''}
    <label>Quantity</label>
    <div class="stepper"><button id="qMinus">−</button><span>${d.qty}</span><button id="qPlus">+</button></div>
    <label>Access</label>
    <select id="access">${accessOpts().map(a => `<option ${a.name === (d.access || accessOpts()[0].name) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`}
    <label>Notes</label>
    <textarea id="notes" placeholder="Anything the installer needs to know">${esc(d.notes)}</textarea>`;
}

function bindPenoFields(d, onChange) {
  $$('[data-face]').forEach(b => b.onclick = () => { d.face = b.dataset.face; onChange(); });
  $$('[data-sub]').forEach(b => b.onclick = () => { d.substrate = d.substrate === b.dataset.sub ? '' : b.dataset.sub; onChange(); });
  $$('[data-type]').forEach(b => b.onclick = () => {
    d.type = b.dataset.type; d.size = ''; d.product = '';
    const sizes = uniq(rates().filter(r => r.type === d.type).map(r => r.size));
    if (sizes.length === 1) d.size = sizes[0];
    const prods = rates().filter(r => r.type === d.type && r.size === d.size);
    if (d.size && prods.length === 1) d.product = prods[0].product;
    onChange();
  });
  $$('[data-size]').forEach(b => b.onclick = () => {
    d.size = b.dataset.size;
    const prods = rates().filter(r => r.type === d.type && r.size === d.size);
    d.product = prods.length === 1 ? prods[0].product : '';
    onChange();
  });
  $$('[data-product]').forEach(b => b.onclick = () => { d.product = b.dataset.product; onChange(); });
  const cu = $('#customUnit'); if (cu) cu.onchange = () => { d.customUnit = cu.value; onChange(); };
  const qm = $('#qMinus'); if (qm) qm.onclick = () => { d.qty = Math.max(1, d.qty - 1); onChange(); };
  const qp = $('#qPlus'); if (qp) qp.onclick = () => { d.qty += 1; onChange(); };
  const ac = $('#access'); if (ac) ac.onchange = e => { d.access = e.target.value; onChange(); };
  $('#notes').oninput = e => { d.notes = e.target.value; };
}

function renderPeno() {
  const d = state.draft, L = state.loc, old = state.mode === 'old';
  const p = priceOf(d);
  const photoOk = !!d.photo;
  const ready = photoOk && d.type && d.size && d.product && (!p.custom || Number(d.customUnit) > 0);
  return `
  <div class="locbar"><div><strong>${esc(locLabel(L))}</strong><br><span class="muted">${esc(L.site)}, ${old ? 'logging old work' : 'scouting'}</span></div>
    <button class="ghost" id="chLoc">Change</button></div>
  ${old ? '' : roomBanner(L)}

  <div class="card"><h2>${old ? 'Photos' : 'Photo'}</h2>
    ${old ? `<div class="row">
        <div>${photoBlock(d.beforePhoto, 'beforePhoto', 'Before (optional)')}</div>
        <div>${photoBlock(d.photo, 'photo', 'After')}</div></div>`
      : photoBlock(d.photo, 'photo', 'Take photo')}
  </div>

  <div class="card"><h2>What is it?</h2>${penoFields(d)}
    ${old ? `<div class="row"><div><label>Date done</label><input id="doneDate" type="date" value="${esc(d.doneDate)}"></div>
      <div><label>Quote number (optional)</label><input id="vp" value="${esc(d.vp)}" placeholder="VP26125" autocapitalize="characters"></div></div>` : ''}
  </div>

  <div class="card">
    <div class="price"><span>Price (ex GST)</span><strong>${money(p.total)}</strong></div>
    <p class="muted">${d.qty} × ${money(p.unit)}${p.loading ? ` + ${Math.round(p.loading * 100)}% access` : ''}${p.extra ? ` + ${money(p.extra)}` : ''}</p>
    <button class="big" id="saveBtn" ${ready ? '' : 'disabled'}>Save penetration</button>
    ${!ready ? `<p class="muted">${!photoOk ? (old ? 'Add the after photo. ' : 'Take the photo. ') : ''}${!d.product ? 'Pick type, size and product.' : ''}</p>` : ''}
  </div>`;
}

function photoBlock(src, target, label) {
  return src
    ? `<div class="thumb wide"><img src="${src}"><button data-retake="${target}">Retake</button></div>`
    : `<button class="big secondary" data-shoot="${target}">📷 ${esc(label)}</button>`;
}

function bindPeno() {
  const d = state.draft;
  $('#chLoc').onclick = () => go('loc');
  $$('[data-shoot]').forEach(b => b.onclick = () => takePhoto(b.dataset.shoot));
  $$('[data-retake]').forEach(b => b.onclick = () => takePhoto(b.dataset.retake));
  bindPenoFields(d, () => { saveDraft(); render(); });
  const dd = $('#doneDate'); if (dd) dd.onchange = () => { d.doneDate = dd.value; saveDraft(); };
  const vp = $('#vp'); if (vp) vp.oninput = () => { d.vp = vp.value.trim().toUpperCase(); saveDraft(); };
  $('#saveBtn').onclick = savePeno;
}

async function savePeno() {
  const L = state.loc, d = state.draft, p = priceOf(d), old = state.mode === 'old';
  d.notes = $('#notes').value;
  const { code, roomNo } = makeCode(L);
  const recordKey = uid();
  const record = {
    recordKey, code, roomNo, mode: state.mode, capturedAt: new Date().toISOString(),
    site: L.site, building: L.building, level: L.level, room: L.room,
    face: d.face, substrate: d.substrate, type: d.type, size: d.size, product: d.product, qty: d.qty,
    unit: p.unit, access: p.access, loading: p.loading, extra: p.extra, notes: d.notes,
    photos: old ? (d.beforePhoto ? [d.beforePhoto] : []) : [d.photo],
    afterPhotos: old ? [d.photo] : [],
    doneDate: old ? d.doneDate : '', vp: old ? d.vp : '',
  };
  await db.put({ recordKey, action: 'submit', record, createdAt: Date.now(), price: p.total, label: `${code} · ${locLabel(L)} · ${d.type}` });
  state.queue = await db.all();
  state.lastSaved = { code, price: p.total, keep: { face: d.face, substrate: d.substrate, type: d.type, size: d.size, product: d.product, qty: d.qty, access: d.access, customUnit: d.customUnit, doneDate: d.doneDate, vp: d.vp } };
  state.draft = freshDraft({ face: d.face, substrate: d.substrate, access: d.access, doneDate: d.doneDate, vp: d.vp });
  saveDraft();
  go('saved');
  if (navigator.onLine) sync();
}

/* ---- saved: show code, fast add ---- */

function renderSaved() {
  const s = state.lastSaved || {};
  return `<div class="card saved"><h2>Saved. Write this on the tag.</h2>
    <span class="tag xl">${esc(s.code)}</span>
    <p class="muted">${money(s.price)}, ${esc(locLabel(state.loc))}</p></div>
    ${state.mode === 'old' ? '' : roomBanner(state.loc)}
    <button class="big" id="sameAgain" style="margin-top:12px">Same again, new photo</button>
    <button class="big secondary" id="another" style="margin-top:10px">Add another here</button>
    <div class="row" style="margin-top:10px"><button class="ghost" id="newLoc">New location</button><button class="ghost" id="home">Home</button></div>`;
}

function bindSaved() {
  $('#sameAgain').onclick = () => { state.draft = freshDraft(state.lastSaved.keep); saveDraft(); go('peno'); takePhoto('photo'); };
  $('#another').onclick = () => { go('peno'); };
  $('#newLoc').onclick = () => go('loc');
  $('#home').onclick = () => go('home', 'home');
}

/* ---- completed (mark done) ---- */

function renderJobs() {
  const queuedDone = new Set(state.queue.filter(q => q.action === 'complete').map(q => q.record.code));
  const jobs = records().filter(r => OPEN.includes(r.status) && !queuedDone.has(r.code));
  if (!jobs.length) return `<div class="card"><h2>Completed</h2><p>No open jobs. Penetrations appear here once they're allocated to a month.</p><button class="ghost" id="refresh">Refresh</button></div>`;
  const groups = {};
  jobs.forEach(j => { const g = `${j.vp || 'No quote number'} · ${j.location}`; (groups[g] = groups[g] || []).push(j); });
  return Object.keys(groups).sort().map(g => {
    const list = groups[g];
    return `<div class="card"><div class="group">${esc(g)}</div><p class="muted">${esc(list[0].month)} · ${list.length} penetration${list.length === 1 ? "" : "s"} · ${money(list.reduce((s, j) => s + j.price, 0))}</p>
      ${list.map(j => `<div class="item"><div class="grow"><div class="title"><span class="tag">${esc(j.code)}</span> ${esc(j.type)}</div>
        <div class="muted">${esc(j.face)} · ${esc(j.size)} · ${esc(j.product)} × ${j.qty}${j.notes ? ' · ' + esc(j.notes) : ''}</div>
        ${j.before ? `<a class="muted" href="${esc(j.before)}" target="_blank" rel="noopener">Before photo</a>` : ''}</div>
        <button class="ghost" data-done="${esc(j.code)}">Done</button></div>`).join('')}</div>`;
  }).join('') + `<button class="ghost" id="refresh">Refresh</button>`;
}

function bindJobs() {
  const r = $('#refresh'); if (r) r.onclick = () => refreshConfig();
  $$('[data-done]').forEach(b => b.onclick = () => {
    state.doneJob = { job: records().find(j => j.code === b.dataset.done), photo: '', notes: '' };
    renderDone();
  });
}

function renderDone() {
  let m = $('#doneModal');
  if (!m) { m = document.createElement('div'); m.id = 'doneModal'; m.className = 'modal'; document.body.appendChild(m); }
  const dj = state.doneJob;
  if (!dj) { m.remove(); return; }
  m.innerHTML = `<div class="sheet"><div class="card"><h2>Mark done</h2>
    <span class="tag md">${esc(dj.job.code)}</span>
    <p class="muted">${esc(dj.job.location)} · ${esc(dj.job.type)} · ${esc(dj.job.product)} × ${dj.job.qty}</p>
    ${dj.photo ? `<div class="thumb wide"><img src="${dj.photo}"><button id="afterPhoto">Retake</button></div>` : `<button class="big secondary" id="afterPhoto">📷 Take after photo</button>`}
    <label>Notes (optional)</label><textarea id="doneNotes">${esc(dj.notes)}</textarea>
    <div class="row" style="margin-top:12px"><button class="ghost" id="cancelDone">Cancel</button>
    <button class="big" id="saveDone" ${dj.photo ? '' : 'disabled'}>Save as done</button></div></div></div>`;
  $('#afterPhoto').onclick = () => { dj.notes = $('#doneNotes').value; takePhoto('done'); };
  $('#cancelDone').onclick = () => { state.doneJob = null; renderDone(); };
  $('#saveDone').onclick = async () => {
    const recordKey = uid();
    await db.put({ recordKey, action: 'complete', createdAt: Date.now(), price: 0, label: `Done · ${dj.job.code} · ${dj.job.location}`,
      record: { recordKey, code: dj.job.code, photos: [dj.photo], notes: $('#doneNotes').value, capturedAt: new Date().toISOString() } });
    state.queue = await db.all();
    const code = dj.job.code;
    state.doneJob = null; renderDone(); render();
    toast(`${code} marked done`);
    if (navigator.onLine) sync();
  };
}

/* ---- find / edit ---- */

function renderBrowse() {
  const q = norm(state.search);
  const list = records().filter(r => !q || norm(r.code).includes(q) || norm(r.location).includes(q) || norm(r.vp).includes(q) || norm(r.site) === q);
  const groups = {};
  list.slice().reverse().slice(0, 400).forEach(r => { const g = `${r.site} · ${r.location}`; (groups[g] = groups[g] || []).push(r); });
  const waiting = state.queue.filter(x => x.action === 'submit').length;
  return `<div class="card"><h2>Find and edit</h2>
    <input id="search" type="search" placeholder="Code, location or quote number" value="${esc(state.search)}">
    <p class="muted">${list.length} found${waiting ? ` · ${waiting} new ones still waiting to sync (see Waiting)` : ''}</p></div>
    ${Object.keys(groups).map(g => `<div class="card"><div class="group">${esc(g)}</div>
      ${groups[g].map(r => `<button class="item btn" data-edit="${esc(r.code)}"><div class="grow"><div class="title"><span class="tag">${esc(r.code)}</span> ${esc(r.type)}</div>
        <div class="muted">${esc(r.status)}${r.vp ? ' · ' + esc(r.vp) : ''} · ${money(r.price)} · ${esc(r.face)}</div></div><span class="muted">›</span></button>`).join('')}
    </div>`).join('')}`;
}

function bindBrowse() {
  const s = $('#search');
  s.oninput = () => { state.search = s.value; clearTimeout(bindBrowse._t); bindBrowse._t = setTimeout(() => { render(); const n = $('#search'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  $$('[data-edit]').forEach(b => b.onclick = () => openEdit(b.dataset.edit, 'browse'));
}

function openEdit(code, from) {
    const r = records().find(x => x.code === code);
    state.edit = { from, orig: r, d: { face: r.face, substrate: r.substrate, type: r.type, size: r.size, product: r.product, qty: r.qty, access: r.access, notes: r.notes, unit: r.unit, customUnit: r.unit, vp: r.vp, doneDate: (r.doneDate || '').slice(0, 10) }, newBefore: '', newAfter: '', confirmRemove: false };
    go('edit', from === 'requests' ? 'home' : 'browse');
}

function renderEdit() {
  const e = state.edit; if (!e) return renderBrowse();
  const r = e.orig, d = e.d;
  const locked = r.status === 'Invoiced';
  const priceLocked = !PRICE_EDITABLE.includes(r.status);
  const p = priceOf(d);
  return `<button class="ghost" id="back">‹ Back</button>
  <div class="card" style="margin-top:10px"><span class="tag md">${esc(r.code)}</span>
    <p class="muted">${esc(r.site)} · ${esc(r.location)}<br>Status: <strong>${esc(r.status)}</strong>${r.vp ? ' · ' + esc(r.vp) : ''}${r.month ? ' · ' + esc(r.month) : ''}<br>
    ${r.status === 'Requested' ? `Client says: <strong>${esc(r.clientType || 'not given')}</strong> × ${r.qty}<br>` : ''}Scouted ${fmtDate(r.scoutedAt)} by ${esc(r.scoutedBy)}${r.doneDate ? ` · done ${fmtDate(r.doneDate)} by ${esc(r.doneBy)}` : ''}</p>
    <div class="row">${r.before ? `<a class="ghost" href="${esc(r.before)}" target="_blank" rel="noopener">Before photo${r.beforeCount > 1 ? 's' : ''} (${r.beforeCount})</a>` : ''}
      ${r.after ? `<a class="ghost" href="${esc(r.after)}" target="_blank" rel="noopener">After photo${r.afterCount > 1 ? 's' : ''} (${r.afterCount})</a>` : ''}</div>
  </div>
  ${locked ? `<div class="card"><p>Invoiced. Changes can only be made in the sheet.</p></div>` : `
  <div class="card"><h2>Add photos</h2><div class="row">
    <div>${e.newBefore ? `<div class="thumb wide"><img src="${e.newBefore}"></div>` : `<button class="ghost wide" data-shot="editBefore">+ Before photo</button>`}</div>
    <div>${e.newAfter ? `<div class="thumb wide"><img src="${e.newAfter}"></div>` : `<button class="ghost wide" data-shot="editAfter">+ After photo</button>`}</div></div></div>
  <div class="card"><h2>Details</h2>${penoFields(d, { lockPrice: priceLocked })}
    ${r.status === 'Done' ? `<div class="row"><div><label>Date done</label><input id="doneDate" type="date" value="${esc(d.doneDate)}"></div>
      <div><label>Quote number</label><input id="vp" value="${esc(d.vp)}" autocapitalize="characters"></div></div>` : ''}
  </div>
  <div class="card">${priceLocked ? '' : `<div class="price"><span>Price (ex GST)</span><strong>${money(p.total)}</strong></div>`}
    <button class="big" id="saveEdit">${r.status === 'Requested' ? 'Price it and add to the bank' : 'Save changes'}</button>
    ${PRICE_EDITABLE.includes(r.status) ? `<button class="ghost danger" id="remove" style="margin-top:10px;width:100%">${e.confirmRemove ? 'Tap again to remove' : 'Remove this penetration'}</button>` : ''}
  </div>`}`;
}

function bindEdit() {
  const e = state.edit; if (!e) return bindBrowse();
  $('#back').onclick = () => { const back = state.edit.from || 'browse'; state.edit = null; go(back, back === 'requests' ? 'home' : 'browse'); };
  if (e.orig.status === 'Invoiced') return;
  $$('[data-shot]').forEach(b => b.onclick = () => takePhoto(b.dataset.shot));
  bindPenoFields(e.d, () => render());
  const dd = $('#doneDate'); if (dd) dd.onchange = () => { e.d.doneDate = dd.value; };
  const vp = $('#vp'); if (vp) vp.oninput = () => { e.d.vp = vp.value.trim().toUpperCase(); };
  $('#saveEdit').onclick = async () => {
    e.d.notes = $('#notes').value;
    const r = e.orig, d = e.d, fields = {};
    ['face', 'substrate', 'notes'].forEach(k => { if ((d[k] || '') !== (r[k] || '')) fields[k] = d[k]; });
    if (PRICE_EDITABLE.includes(r.status)) {
      const p = priceOf(d);
      ['type', 'size', 'product'].forEach(k => { if (d[k] !== r[k]) fields[k] = d[k]; });
      if (Number(d.qty) !== Number(r.qty)) fields.qty = d.qty;
      if (p.unit !== r.unit) fields.unit = p.unit;
      if (p.access !== r.access) { fields.access = p.access; fields.loading = p.loading; fields.extra = p.extra; }
      if (!d.product) { toast('Pick a product first'); return; }
    }
    if (r.status === 'Done') { if (d.vp !== r.vp) fields.vp = d.vp; if (d.doneDate && d.doneDate !== (r.doneDate || '').slice(0, 10)) fields.doneDate = d.doneDate; }
    const accept = r.status === 'Requested';
    if (!accept && !Object.keys(fields).length && !e.newBefore && !e.newAfter) { toast('No changes'); return; }
    const recordKey = uid();
    await db.put({ recordKey, action: 'update', createdAt: Date.now(), price: 0, label: `${accept ? 'Price' : 'Edit'} · ${r.code}`,
      record: { recordKey, code: r.code, fields, accept, photos: e.newBefore ? [e.newBefore] : [], afterPhotos: e.newAfter ? [e.newAfter] : [] } });
    Object.assign(r, fields);
    if (accept) r.status = 'Scouted';
    if (fields.unit !== undefined || fields.qty !== undefined || fields.access !== undefined) r.price = priceOf(Object.assign({}, r, { customUnit: r.unit })).total;
    store.set(LS.config, state.config);
    state.queue = await db.all();
    const back = e.from || 'browse';
    state.edit = null; toast(accept ? `${r.code} added to the bank` : `${r.code} updated`); go(back, back === 'requests' ? 'home' : 'browse');
    if (navigator.onLine) sync();
  };
  const rm = $('#remove');
  if (rm) rm.onclick = async () => {
    if (!e.confirmRemove) { e.confirmRemove = true; render(); return; }
    const r = e.orig, recordKey = uid();
    await db.put({ recordKey, action: 'update', createdAt: Date.now(), price: 0, label: `Remove · ${r.code}`, record: { recordKey, code: r.code, remove: true } });
    state.config.records = records().filter(x => x.code !== r.code);
    store.set(LS.config, state.config);
    state.queue = await db.all();
    state.edit = null; toast(`${r.code} removed`); go('browse', 'browse');
    if (navigator.onLine) sync();
  };
}

/* ---- staff: client requests to price ---- */

function renderRequests() {
  const list = records().filter(r => r.status === 'Requested');
  if (!list.length) return `<button class="ghost" id="back">‹ Home</button><div class="card" style="margin-top:10px"><h2>Client requests</h2><p>Nothing waiting. New ones show up here when a client logs a penetration.</p></div>`;
  const groups = {};
  list.forEach(r => { const g = `${r.site} · ${r.location}`; (groups[g] = groups[g] || []).push(r); });
  return `<button class="ghost" id="back">‹ Home</button>
    <div class="card" style="margin-top:10px"><h2>Client requests</h2><p class="muted">${list.length} to price. Tap one, pick the product and access, then add it to the bank. It's then planned into POs like anything we scout.</p></div>
    ${Object.keys(groups).sort().map(g => `<div class="card"><div class="group">${esc(g)}</div>
      ${groups[g].map(r => `<button class="item btn" data-req="${esc(r.code)}"><div class="grow"><div class="title"><span class="tag">${esc(r.code)}</span> ${esc(r.clientType || 'Penetration')} × ${r.qty}</div>
        <div class="muted">${esc(r.face)}${r.substrate ? ' · ' + esc(r.substrate) : ''} · from ${esc(r.scoutedBy)} ${fmtDate(r.scoutedAt)}${r.before ? ' · photo' : ''}</div></div><span class="muted">›</span></button>`).join('')}</div>`).join('')}`;
}

function bindRequests() {
  $('#back').onclick = () => go('home', 'home');
  $$('[data-req]').forEach(b => b.onclick = () => openEdit(b.dataset.req, 'requests'));
}

/* ---- client screens (no prices, own requests only) ---- */

function renderClientHome() {
  const mine = records();
  const waiting = state.queue.filter(q => q.action === 'request').length;
  const open = mine.filter(r => r.status !== 'Fixed').length;
  return `
  <div class="bank"><p class="hello">Hi ${esc(state.config.user)}${state.config.company ? ', ' + esc(state.config.company) : ''}</p>
    <div class="amount">${open + waiting}</div>
    <p class="sub">open penetration request${open + waiting === 1 ? '' : 's'} with Frontline${waiting ? ` (${waiting} still to upload)` : ''}</p></div>
  <button class="tile primary" data-go="new"><span class="ico">${ICONS.plus}</span><span><strong>Log a penetration</strong><span class="d">Location, wall or ceiling, and what's going through it</span></span></button>
  <button class="tile" data-go="browse"><span class="ico">${ICONS.search}</span><span><strong>My requests</strong><span class="d">See what you've logged and where it's up to</span></span></button>`;
}

function bindClientHome() {
  $$('[data-go]').forEach(b => b.onclick = () => {
    if (b.dataset.go === 'new') {
      state.mode = 'new';
      state.draft = freshDraft({ face: state.draft.face, substrate: state.draft.substrate });
      saveDraft(); go(locReady(state.loc) ? 'peno' : 'loc');
    } else go('browse', 'browse');
  });
}

function renderClientPeno() {
  const d = state.draft, L = state.loc;
  const ready = d.face && d.clientType;
  return `
  <div class="locbar"><div><strong>${esc(locLabel(L))}</strong><br><span class="muted">${esc(L.site)}</span></div>
    <button class="ghost" id="chLoc">Change</button></div>
  <div class="card"><h2>Photo <span class="muted">(optional, helps us quote)</span></h2>${photoBlock(d.photo, 'photo', 'Take photo')}</div>
  <div class="card"><h2>What is it?</h2>
    <label>Where is it?</label>
    <div class="chips">${FACES.map(f => `<button class="chip ${d.face === f ? 'on' : ''}" data-face="${f}">${f}</button>`).join('')}</div>
    <label>Wall / ceiling type <span class="muted">(if you know)</span></label>
    <div class="chips">${substrates().map(x => `<button class="chip ${d.substrate === x ? 'on' : ''}" data-sub="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <label>What's going through it?</label>
    <div class="chips">${clientTypes().map(x => `<button class="chip ${d.clientType === x ? 'on' : ''}" data-ct="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <label>How many?</label>
    <div class="stepper"><button id="qMinus">−</button><span>${d.qty}</span><button id="qPlus">+</button></div>
    <label>Notes</label>
    <textarea id="notes" placeholder="e.g. above ceiling tile near door, needs ladder">${esc(d.notes)}</textarea>
  </div>
  <div class="card"><button class="big" id="saveBtn" ${ready ? '' : 'disabled'}>Send to Frontline</button>
    ${ready ? '' : `<p class="muted">Pick where it is and what's going through it.</p>`}</div>`;
}

function bindClientPeno() {
  const d = state.draft;
  const ch = () => { d.notes = $('#notes').value; saveDraft(); render(); };
  $('#chLoc').onclick = () => go('loc');
  $$('[data-shoot]').forEach(b => b.onclick = () => takePhoto(b.dataset.shoot));
  $$('[data-retake]').forEach(b => b.onclick = () => takePhoto(b.dataset.retake));
  $$('[data-face]').forEach(b => b.onclick = () => { d.face = b.dataset.face; ch(); });
  $$('[data-sub]').forEach(b => b.onclick = () => { d.substrate = d.substrate === b.dataset.sub ? '' : b.dataset.sub; ch(); });
  $$('[data-ct]').forEach(b => b.onclick = () => { d.clientType = b.dataset.ct; ch(); });
  $('#qMinus').onclick = () => { d.qty = Math.max(1, d.qty - 1); ch(); };
  $('#qPlus').onclick = () => { d.qty = Math.min(99, d.qty + 1); ch(); };
  $('#notes').oninput = e => { d.notes = e.target.value; saveDraft(); };
  $('#saveBtn').onclick = async () => {
    const L = state.loc;
    d.notes = $('#notes').value;
    const { code, roomNo } = makeCode(L);
    const recordKey = uid();
    const record = { recordKey, code, roomNo, capturedAt: new Date().toISOString(),
      site: L.site, building: L.building, level: L.level, room: L.room,
      face: d.face, substrate: d.substrate, clientType: d.clientType, qty: d.qty, notes: d.notes, photos: d.photo ? [d.photo] : [] };
    await db.put({ recordKey, action: 'request', record, createdAt: Date.now(), price: 0, label: `${code} · ${locLabel(L)} · ${d.clientType} × ${d.qty}` });
    state.queue = await db.all();
    state.lastSaved = { code, keep: { face: d.face, substrate: d.substrate, clientType: d.clientType, qty: d.qty } };
    state.draft = freshDraft({ face: d.face, substrate: d.substrate });
    saveDraft(); go('saved');
    if (navigator.onLine) sync();
  };
}

function renderClientSaved() {
  const s = state.lastSaved || {};
  return `<div class="card saved"><h2>Sent. Thanks.</h2>
    <p>Your reference is</p><span class="tag xl">${esc(s.code)}</span>
    <p class="muted">${esc(locLabel(state.loc))}. If there's no signal it uploads when you're back in range.</p></div>
    <button class="big" id="sameAgain" style="margin-top:12px">Same again, new photo</button>
    <button class="big secondary" id="another" style="margin-top:10px">Log another here</button>
    <div class="row" style="margin-top:10px"><button class="ghost" id="newLoc">New location</button><button class="ghost" id="home">Home</button></div>`;
}

function bindClientSaved() {
  $('#sameAgain').onclick = () => { state.draft = freshDraft(state.lastSaved.keep); saveDraft(); go('peno'); takePhoto('photo'); };
  $('#another').onclick = () => go('peno');
  $('#newLoc').onclick = () => go('loc');
  $('#home').onclick = () => go('home', 'home');
}

function renderClientList() {
  const list = records().slice().reverse();
  const waiting = state.queue.filter(q => q.action === 'request');
  return `<div class="card"><h2>My requests</h2>
    <p class="muted">${list.length} logged${waiting.length ? ` · ${waiting.length} waiting to upload` : ''}. Received → Being quoted → Quoted → Fixed.</p>
    <button class="ghost" id="refresh">Refresh</button></div>
    ${list.map(r => `<div class="card item"><div class="grow"><div class="title"><span class="tag">${esc(r.code)}</span> ${esc(r.clientType || 'Penetration')} × ${r.qty}</div>
      <div class="muted">${esc(r.site)} · ${esc(r.location)} · ${esc(r.face)} · ${fmtDate(r.scoutedAt)}</div></div>
      <span class="pill">${esc(r.status)}</span></div>`).join('')}`;
}

function bindClientList() { $('#refresh').onclick = () => refreshConfig(); }

/* ---- waiting ---- */

function renderQueue() {
  const q = state.queue;
  const total = q.filter(x => x.action === 'submit' && x.record.mode !== 'old').reduce((s, x) => s + x.price, 0);
  const thumb = x => (x.record.photos && x.record.photos[0]) || (x.record.afterPhotos && x.record.afterPhotos[0]) || '';
  return `<div class="card"><h2>Waiting to sync</h2>
    ${q.length ? `<p class="muted">${q.length} item${q.length === 1 ? '' : 's'} on this device${total ? ', ' + money(total) + ' of new work' : ''}. They upload when you have signal.</p>
      ${q.map(x => `<div class="item">${thumb(x) ? `<img src="${thumb(x)}">` : ''}
        <div class="grow"><div class="title">${esc(x.label)}</div><div class="muted">${x.price ? money(x.price) + ' · ' : ''}${new Date(x.createdAt).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })}</div></div>
        <button class="ghost" data-del="${esc(x.recordKey)}">Delete</button></div>`).join('')}
      <button class="big" id="syncNow" style="margin-top:10px">Sync now</button>`
      : `<p>Everything is synced to the master sheet.</p>`}
  </div>
  <div class="card"><h2>App</h2>
    <p class="muted">Signed in as ${esc(state.config.user)} · updated ${state.config.serverTime ? new Date(state.config.serverTime).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' }) : 'never'} · v${APP_VERSION}</p>
    <div class="row"><button class="ghost" id="refresh">Refresh lists</button><button class="ghost" id="reset">Disconnect device</button></div>
  </div>`;
}

function bindQueue() {
  const s = $('#syncNow'); if (s) s.onclick = () => sync();
  $('#refresh').onclick = () => refreshConfig();
  $('#reset').onclick = () => {
    if (state.queue.length) { toast('Sync or delete waiting items first'); return; }
    state.setup = null; state.config = null; store.del(LS.setup); store.del(LS.config); render();
  };
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (b.textContent !== 'Sure?') { b.textContent = 'Sure?'; return; }
    await db.del(b.dataset.del);
    state.queue = await db.all(); render();
  });
}

/* ---- passive fire screens ---- */

VIEWS.passive = new Proxy({}, { get(_, k) {
  const client = { home: [renderClientHome, bindClientHome], peno: [renderClientPeno, bindClientPeno], saved: [renderClientSaved, bindClientSaved], browse: [renderClientList, bindClientList] };
  const staff = { requests: [renderRequests, bindRequests], home: [renderHome, bindHome], peno: [renderPeno, bindPeno], saved: [renderSaved, bindSaved],
    jobs: [renderJobs, bindJobs], browse: [renderBrowse, bindBrowse], edit: [renderEdit, bindEdit] };
  return (isClient() ? client : staff)[k];
}, ownKeys() { return ['home', 'peno', 'saved', 'browse', 'requests', 'jobs', 'edit']; },
   getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; } });

/* ---------------- start ---------------- */

window.addEventListener('DOMContentLoaded', async function start() {
  try { state.queue = await db.all(); } catch (e) { toast('Storage unavailable on this browser'); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
  if (state.setup) { if (state.queue.length && navigator.onLine) sync(); else refreshConfig(true); }
});
