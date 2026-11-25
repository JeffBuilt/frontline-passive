/* Frontline app v3.0 - stripped back: month > jobs > before/after photos > docs > report. Offline-first. */
'use strict';

const APP_VERSION = '3.3.1';
const SERVER_URL = 'https://script.google.com/macros/s/AKfycbyZOt9Zo4c6xSaY2YV8H8NXMR4NHx77dT6tz_qEVp1bZX-rNVVZJ7nDVpnh2G2DF_wW/exec';
const MAX_PX = 1600, JPEG_Q = 0.78;
const TYPES = [['passive', 'Passive fire'], ['filters', 'Filters'], ['water', 'Water filters'], ['sit', 'SIT'], ['repairs', 'Fire repairs'], ['other', 'Other']];
const TYPE_NAME = Object.fromEntries(TYPES);
const MATERIALS = ['Collars on cables', 'Intumescent sealant', 'HPE sealant on collars', 'Metal straps', 'Fire pillows', 'Fire batt / panel', 'Lagging wrap', 'Cable tray system'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------------- storage ---------------- */

const ls = {
  get(k, d) { try { const v = localStorage.getItem('fl_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fl_' + k, JSON.stringify(v)); } catch (e) { /* full */ } },
  del(k) { localStorage.removeItem('fl_' + k); },
};

const idb = {
  _p: null,
  open() {
    return this._p || (this._p = new Promise((res, rej) => {
      const r = indexedDB.open('frontline3', 1);
      r.onupgradeneeded = () => { ['queue', 'img', 'doc', 'list'].forEach(s => r.result.createObjectStore(s, { keyPath: 'k' })); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    });
  },
  get(store, k) { return this.tx(store, 'readonly', s => s.get(k)); },
  put(store, v) { return this.tx(store, 'readwrite', s => s.put(v)); },
  del(store, k) { return this.tx(store, 'readwrite', s => s.delete(k)); },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
};

/* ---------------- state ---------------- */

const S = {
  pin: ls.get('pin', ''),
  months: ls.get('months', null),     // [{ym,label,year,jobs:[...]}]
  loadedAt: ls.get('loadedAt', 0),
  view: ls.get('view', { screen: 'months' }),   // {screen, ym, ref, wo}
  type: ls.get('type', 'all'),
  hideDone: ls.get('hideDone', false),
  q: '',
  queue: [],            // pending uploads (from idb)
  syncing: false,
  lists: {},            // `${ref}|${kind}` -> [{id,name}]
  unit: '',
  online: navigator.onLine,
  loading: false,
  error: '',
};

/* ---------------- server ---------------- */

async function api(action, data, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 60000);
  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action, pin: S.pin, v: APP_VERSION }, data || {})),
    });
    const out = await res.json();
    if (!out.ok) {
      if (/wrong pin|no pin set/i.test(out.error || '')) { S.pin = ''; ls.del('pin'); render(); }
      throw new Error(out.error || 'Server error');
    }
    return out;
  } finally { clearTimeout(t); }
}

/* ---------------- helpers ---------------- */

const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (n >= 1000 ? (Math.round(n / 100) / 10).toLocaleString('en-AU') + 'k' : Math.round(n).toLocaleString('en-AU'));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Short, readable location: building codes (AT, HSB, LTB, ONJ), no 258.4.3 prefix. */
function shortLoc(loc) {
  return String(loc || '')
    .replace(/[–—]/g, '-')
    .replace(/^\s*\d+(\.\d+)+\s*-\s*/, '')
    .replace(/\bAustin Tower\b/gi, 'AT')
    .replace(/\bAustin (ONJ|LTB|HSB)\b/gi, '$1')
    .replace(/\s+-\s+/g, ' · ')
    .replace(/\s{2,}/g, ' ').trim();
}
/** Filter units ("AHU K4-1, AHU K4-2 and AHU-L03") from the part after the room. */
function unitsOf(job) {
  if (!/filters|water/.test(job.type)) return [];
  const parts = String(job.loc || '').replace(/[–—]/g, '-').split(/\s+-\s+/);
  if (parts.length < 2) return [];
  const tail = parts.slice(1).join(' - ');
  if (/^all\b/i.test(tail)) return [];
  return tail.split(/\s*,\s*|\s+and\s+|\s*&\s*/i).map(s => s.trim()).filter(s => s && s.length < 30);
}

function pending(job, kind) { return S.queue.filter(q => q.ref === job.ref && q.wo === job.wo && (!kind || q.kind === kind)); }
function counts(job) {
  return { before: (job.before || 0) + pending(job, 'before').length, after: (job.after || 0) + pending(job, 'after').length };
}
/** Green only when after photos have caught up with before photos (or someone marked it complete). */
function state(job) {
  const c = counts(job);
  if (job.done) return 'green';
  if (c.before && c.after >= c.before) return 'green';
  return (c.before || c.after) ? 'amber' : 'red';
}
function month(ym) { return (S.months || []).find(m => m.ym === ym); }
/** This month, last month (if it still has unfinished jobs) and the months ahead. Works with older cached data that has no "when". */
function thisYm() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function split() {
  const ms = S.months || [], now = thisYm();
  let i = ms.findIndex(m => m.when ? m.when === 'now' : m.ym === now);
  if (i < 0) i = ms.findIndex(m => m.ym >= now); if (i < 0) i = 0;
  const past = ms.slice(0, i).filter(m => m.jobs.some(j => state(j) !== 'green'));
  return { past: past, cur: ms[i], ahead: ms.slice(i + 1, i + 7) };
}
function findJob(ref, wo) {
  for (const m of S.months || []) { const j = m.jobs.find(x => x.ref === ref && x.wo === wo); if (j) return { job: j, month: m }; }
  return null;
}
function go(view) { S.view = view; ls.set('view', view); S.unit = ''; render(); window.scrollTo(0, 0); }

let toastT;
function toast(msg, ms) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(toastT); toastT = setTimeout(() => { el.style.display = 'none'; }, ms || 2600);
}

/* ---------------- loading jobs ---------------- */

async function loadMonths(quiet) {
  if (!S.pin) return;
  S.loading = true; if (!quiet) render();
  try {
    const out = await api('months');
    S.months = out.months; S.loadedAt = Date.now(); S.error = '';
    ls.set('months', S.months); ls.set('loadedAt', S.loadedAt);
    prefetch();
  } catch (e) {
    S.error = navigator.onLine ? e.message : '';
  }
  S.loading = false; render();
}

/** With signal, keep the current month's to-do jobs ready for no-signal plant rooms: photo lists + before photos. */
let prefetching = false;
async function prefetch() {
  if (prefetching || !navigator.onLine || !S.months) return;
  prefetching = true;
  try {
    const sp = split();
    const jobs = sp.past.concat(sp.cur ? [sp.cur] : []).flatMap(m => m.jobs).filter(j => state(j) !== 'green' && (j.before || 0) > 0);
    for (const j of jobs) {
      const list = await photoList(j, 'before', true).catch(() => []);
      for (const p of list) await image(p.id).catch(() => null);
    }
  } finally { prefetching = false; }
}

async function photoList(job, kind, fresh) {
  const k = job.ref + '|' + job.wo + '|' + kind;
  if (!fresh && S.lists[k]) return S.lists[k];
  if (navigator.onLine) {
    try {
      const out = await api('photos', { ref: job.ref, wo: job.wo, kind: kind });
      S.lists[k] = out.photos; await idb.put('list', { k: k, v: out.photos });
      if (job[kind] !== out.photos.length) { job[kind] = out.photos.length; ls.set('months', S.months); }
      return out.photos;
    } catch (e) { /* fall back to what we have */ }
  }
  const saved = await idb.get('list', k);
  S.lists[k] = saved ? saved.v : [];
  return S.lists[k];
}

const imgMem = {};
async function image(id) {
  if (imgMem[id]) return imgMem[id];
  const saved = await idb.get('img', id);
  if (saved) return (imgMem[id] = saved.v);
  if (!navigator.onLine) return '';
  const out = await api('photo', { id: id, size: 1200 });
  await idb.put('img', { k: id, v: out.img, t: Date.now() });
  return (imgMem[id] = out.img);
}

/* ---------------- photos in ---------------- */

async function shrink(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w = bmp.width, h = bmp.height, k = Math.min(1, MAX_PX / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', JPEG_Q);
}

let pickKind = 'before';
function pick(kind, camera) {
  pickKind = kind;
  const el = camera ? $('#camIn') : $('#libIn');
  el.value = ''; el.click();
}

async function addFiles(files) {
  const f = findJob(S.view.ref, S.view.wo); if (!f || !files.length) return;
  const job = f.job, kind = pickKind;
  toast(files.length > 1 ? 'Adding ' + files.length + ' photos…' : 'Adding photo…', 1500);
  for (const file of files) {
    try {
      const data = await shrink(file);
      const item = { k: uid(), ref: job.ref, wo: job.wo, loc: job.loc, unit: S.unit, kind: kind, data: data, t: Date.now() };
      await idb.put('queue', item); S.queue.push(item);
    } catch (e) { toast('One photo could not be read: ' + (file.name || '')); }
  }
  render();
  const c = counts(job);
  toast((kind === 'after' ? 'After' : 'Before') + ' photos: ' + c[kind] + (navigator.onLine ? ' · uploading' : ' · saved on phone, will upload with signal'));
  sync();
}

async function sync() {
  if (S.syncing || !navigator.onLine || !S.pin) return;
  S.syncing = true; renderSync();
  try {
    while (true) {
      const q = (await idb.all('queue')).sort((a, b) => a.t - b.t);
      S.queue = q;
      if (!q.length) break;
      const it = q[0];
      const out = await api('upload', { uid: it.k, ref: it.ref, wo: it.wo, loc: it.loc, unit: it.unit, kind: it.kind, data: it.data }, 120000);
      await idb.del('queue', it.k);
      const f = findJob(it.ref, it.wo);
      if (f) { f.job[it.kind] = out.count; ls.set('months', S.months); }
      delete S.lists[it.ref + '|' + it.wo + '|' + it.kind];
      S.queue = S.queue.filter(x => x.k !== it.k);
      renderSync();
    }
  } catch (e) {
    if (navigator.onLine) toast('Upload paused: ' + e.message + '. It will retry.');
  } finally {
    S.syncing = false; render();
  }
}

/* ---------------- docs ---------------- */

async function openDoc(d) {
  let saved = await idb.get('doc', d.id);
  if (saved && d.updated && saved.u !== d.updated && navigator.onLine) saved = null; // newer version in Drive
  if (!saved) {
    if (!navigator.onLine) { toast('No signal and this doc is not saved on the phone yet.'); return; }
    toast('Opening ' + d.name + '…', 4000);
    const out = await api('doc', { id: d.id }, 90000);
    saved = { k: d.id, v: out.data, u: d.updated || 0, name: d.name };
    try { await idb.put('doc', saved); } catch (e) { /* storage full: still open it */ }
  }
  const [head, b64] = saved.v.split(',');
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/pdf';
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: mime }));
  const w = window.open(url, '_blank');
  if (!w) location.href = url;
}

/* ---------------- render ---------------- */

function render() {
  const app = $('#app');
  if (!S.pin) { app.innerHTML = pinView(); bindPin(); return; }
  const v = S.view;
  if (v.screen === 'job' && findJob(v.ref, v.wo)) app.innerHTML = jobView();
  else if (v.screen === 'month' && month(v.ym)) app.innerHTML = monthView();
  else app.innerHTML = monthsView();
  if (S.view.screen === 'job') fillThumbs();
}

function syncText() {
  const n = S.queue.length;
  if (n) return { cls: S.syncing ? 'busy' : 'off', txt: (S.syncing ? '⬆ ' : '⏸ ') + n + ' to upload' };
  if (!navigator.onLine) return { cls: 'off', txt: 'No signal' };
  return { cls: '', txt: S.loading ? 'Loading…' : '✓ Up to date' };
}
function renderSync() { const el = $('.sync'); if (el) { const s = syncText(); el.className = 'sync ' + s.cls; el.textContent = s.txt; } }
function syncChip() { const s = syncText(); return '<button class="sync ' + s.cls + '" data-act="refresh">' + s.txt + '</button>'; }

function progress(jobs) {
  let tot = 0, done = 0, half = 0, nDone = 0;
  jobs.forEach(j => { const st = state(j); tot += j.price || 0; if (st === 'green') { done += j.price || 0; nDone++; } else if (st === 'amber') half += j.price || 0; });
  return { tot, done, half, nDone, n: jobs.length };
}
function bar(p) {
  const g = p.tot ? p.done / p.tot * 100 : (p.n ? p.nDone / p.n * 100 : 0), a = p.tot ? p.half / p.tot * 100 : 0;
  return '<div class="bar"><i class="g" style="width:' + g + '%"></i><i class="a" style="width:' + a + '%"></i></div>';
}

function monthsView() {
  if (!S.months) {
    return '<div class="top"><h1>Frontline</h1>' + syncChip() + '</div>' +
      (S.error ? '<div class="err">' + esc(S.error) + '</div>' : '<div class="empty">Loading jobs…</div>');
  }
  const sp = split(), cur = sp.cur, p0 = progress(cur.jobs);
  const bigTile = (m, late) => {
    const p = progress(m.jobs), left = p.n - p.nDone;
    return '<button class="month' + (late ? ' late' : '') + '" data-act="month" data-ym="' + m.ym + '">' +
      (late ? '<div class="latetag">Last month · still to finish</div>' : '') +
      '<div><span class="mn">' + esc(m.label) + '</span><span class="yr">' + m.year + '</span></div>' +
      '<div class="money"><b>' + money(p.done) + '</b> of ' + money(p.tot) + ' done</div>' + bar(p) +
      '<div class="legend"><span><span class="dot" style="background:var(--green)"></span>' + p.nDone + ' of ' + p.n + ' jobs</span>' +
      (left ? '<span><span class="dot" style="background:var(--red)"></span>' + left + (late ? ' jobs still need photos' : ' to finish') + '</span>' : '') + '</div></button>';
  };
  const tile = sp.past.map(m => bigTile(m, true)).join('') + bigTile(cur, false);
  const ahead = sp.ahead;
  const tots = ahead.map(m => m.jobs.reduce((a, j) => a + (j.price || 0), 0));
  const top = Math.max(1, p0.tot, ...tots);
  const avg = tots.reduce((a, b) => a + b, 0) / (tots.length || 1);
  const minis = ahead.map((m, i) => {
    const t = tots[i], low = t < avg * 0.6;
    return '<button class="mini' + (low ? ' low' : '') + '" data-act="month" data-ym="' + m.ym + '">' +
      '<span class="mm">' + esc(m.label.slice(0, 3)) + (m.ym.slice(5) === '01' ? ' ' + m.year.slice(2) : '') + '</span>' +
      '<span class="mbar"><i style="width:' + (t / top * 100) + '%"></i></span>' +
      '<span class="mv">' + money(t) + '</span><span class="lt">' + (low ? '<span class="lowtag">Low</span>' : '') + '</span></button>';
  }).join('');
  const tiles = tile + (ahead.length ? '<div class="ahead"><div class="ah">Coming up · work booked</div>' + minis + '</div>' : '');
  const when = S.loadedAt ? new Date(S.loadedAt).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  return '<div class="top"><h1>Frontline</h1>' + syncChip() + '</div>' + tiles +
    (S.error ? '<div class="err">' + esc(S.error) + '</div>' : '') +
    '<div class="small">Jobs from the Projects register' + (when ? ' · updated ' + when : '') + ' · v' + APP_VERSION + '</div>';
}

function monthView() {
  const m = month(S.view.ym);
  const present = TYPES.filter(([t]) => m.jobs.some(j => j.type === t));
  if (S.type !== 'all' && !present.some(([t]) => t === S.type)) S.type = 'all';
  const left = t => m.jobs.filter(j => (t === 'all' || j.type === t) && state(j) !== 'green').length;
  const chips = [['all', 'All']].concat(present).map(([t, name]) =>
    '<button class="chip' + (S.type === t ? ' on' : '') + '" data-act="type" data-t="' + t + '">' + name + '<small>' + left(t) + '</small></button>').join('');
  const q = S.q.toLowerCase();
  let jobs = m.jobs.filter(j => S.type === 'all' || j.type === S.type);
  const p = progress(jobs);
  if (S.hideDone) jobs = jobs.filter(j => state(j) !== 'green');
  if (q) jobs = jobs.filter(j => (j.ref + ' ' + j.wo + ' ' + j.loc + ' ' + shortLoc(j.loc) + ' ' + j.job).toLowerCase().includes(q));
  const rank = { amber: 0, red: 1, green: 2 };
  jobs.sort((a, b) => rank[state(a)] - rank[state(b)] || shortLoc(a.loc).localeCompare(shortLoc(b.loc)));
  const cards = jobs.map(jobCard).join('') || '<div class="empty">' + (S.hideDone ? 'All done here 🎉' : 'No jobs') + '</div>';
  return '<div class="top"><button class="back" data-act="home">‹</button><h1>' + esc(m.label) + '</h1>' + syncChip() + '</div>' +
    '<div class="money" style="margin:0 2px"><b>' + money(p.done) + '</b> of ' + money(p.tot) + ' · ' + p.nDone + '/' + p.n + ' jobs</div>' + bar(p) +
    '<div class="chips">' + chips + '</div>' +
    '<div class="row"><button class="toggle' + (S.hideDone ? ' on' : '') + '" data-act="hide">' + (S.hideDone ? '✓ Hiding finished' : 'Hide finished') + '</button>' +
    '<input class="search" placeholder="🔍 VP, WO, room" value="' + esc(S.q) + '" data-act="search"></div>' + cards;
}

function jobCard(j) {
  const c = counts(j), st = state(j);
  return '<button class="job ' + st + '" data-act="job" data-ref="' + esc(j.ref) + '" data-wo="' + esc(j.wo) + '">' +
    '<div class="vp">' + esc(j.ref || '—') + '<small>' + esc(TYPE_NAME[j.type] || j.job) + '</small></div>' +
    '<div class="loc">' + esc(shortLoc(j.loc) || j.job) + '</div>' +
    '<div class="pills"><span class="pill ' + (c.before ? 'ok' : 'no') + '">Before ' + c.before + '</span>' +
    '<span class="pill ' + (c.after && c.after >= c.before ? 'ok' : c.after ? 'part' : 'no') + '">After ' + c.after + (c.before ? '/' + c.before : '') + '</span></div>' +
    (j.done && !(c.before && c.after >= c.before) ? '<div class="ovr">Marked complete</div>' : '') + '</button>';
}

const ICON = {
  cam: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  img: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
};

function jobView() {
  const { job } = findJob(S.view.ref, S.view.wo);
  const c = counts(job), st = state(job);
  const units = unitsOf(job);
  const matched = c.before && c.after >= c.before;
  const stTxt = st === 'green' ? (matched ? 'Photos done' : 'Marked complete') :
    st === 'amber' ? (c.before ? 'After photos ' + c.after + ' of ' + c.before : 'Needs before photos') : 'No photos yet';
  const sect = (kind, label) => {
    const n = c[kind];
    return '<div class="sect"><div class="sh"><span class="st">' + label + '</span>' +
      (kind === 'after' && c.before && n < c.before
        ? '<span class="cnt ' + (n ? 'part' : 'no') + '">' + n + ' of ' + c.before + '</span></div>'
        : '<span class="cnt ' + (n ? 'ok' : 'no') + '">' + (n ? ICON.check.replace(/26/g, '18') : '') + n + ' photo' + (n === 1 ? '' : 's') + '</span></div>') +
      '<div class="thumbs" id="th-' + kind + '">' + (n ? '' : '<div class="none">No ' + label.toLowerCase() + ' photos yet</div>') + '</div>' +
      '<div class="acts"><button class="pbtn" data-act="cam" data-k="' + kind + '">' + ICON.cam + '<span>Take photo</span></button>' +
      '<button class="sbtn" data-act="lib" data-k="' + kind + '">' + ICON.img + '<span>Upload</span></button></div></div>';
  };
  return '<div class="top"><button class="back" data-act="back">‹</button><h1>' + esc(job.ref) + '</h1>' + syncChip() + '</div>' +
    '<div class="jh"><div class="badge ' + st + '">' + (st === 'green' ? ICON.check.replace(/26/g, '18') : ICON.warn) + '<span>' + stTxt + '</span></div>' +
    '<div class="jl">' + esc(shortLoc(job.loc) || job.job) + '</div>' +
    '<div class="meta"><span class="tag">' + esc(TYPE_NAME[job.type] || job.job) + '</span>' + (job.wo ? '<span>WO ' + esc(job.wo) + '</span>' : '') + '</div>' +
    (units.length ? '<div class="ul">Unit you are on <span>(optional, names the photos)</span></div><div class="units">' +
      units.map(u => '<button class="unit' + (S.unit === u ? ' on' : '') + '" data-act="unit" data-u="' + esc(u) + '">' + esc(u) + '</button>').join('') + '</div>' : '') +
    '</div>' + sect('before', 'Before') + sect('after', 'After') +
    '<button class="rowbtn" data-act="docs"><span class="ri">' + ICON.doc + '</span><span class="rt">Documents<small>SWMS, ATW, report</small></span>' + ICON.chev + '</button>' +
    (st === 'amber' ? '<button class="ovbtn" data-act="markdone">Mark complete anyway</button>' : '') +
    (job.done && !matched ? '<button class="ovbtn undo" data-act="undone">Undo "marked complete"</button>' : '') +
    '<button class="fin" data-act="finish"' + (c.after ? '' : ' disabled') + '>' + ICON.check + '<span>' + (job.sr ? 'Remake service report' : 'Finish job') + '</span></button>' +
    (c.after ? '' : '<div class="hint">Finish unlocks once there is at least one after photo</div>');
}

async function fillThumbs() {
  const f = findJob(S.view.ref, S.view.wo); if (!f) return;
  const job = f.job;
  for (const kind of ['before', 'after']) {
    const box = $('#th-' + kind); if (!box) continue;
    const local = pending(job, kind).map(q => '<button data-act="viewq" data-k="' + kind + '" data-id="' + q.k + '"><img src="' + q.data + '"><span class="q">Uploading</span></button>').join('');
    if (local) box.innerHTML = local;
    const list = await photoList(job, kind, navigator.onLine);
    if (S.view.screen !== 'job' || S.view.ref !== job.ref) return;
    const el = $('#th-' + kind); if (!el) return;
    if (!list.length && !local) continue;
    el.innerHTML = list.map((p, i) => '<button data-act="view" data-k="' + kind + '" data-i="' + i + '"><img data-id="' + p.id + '" alt=""></button>').join('') + local;
    for (const img of el.querySelectorAll('img[data-id]')) {
      image(img.dataset.id).then(src => { if (src) img.src = src; }).catch(() => {});
    }
  }
}

/* ---------------- viewer ---------------- */

async function viewer(kind, start) {
  const f = findJob(S.view.ref, S.view.wo); if (!f) return;
  const job = f.job;
  const build = async () => (await photoList(job, kind)).map(p => ({ id: p.id, name: p.name }))
    .concat(pending(job, kind).map(q => ({ local: q.data, name: 'Waiting to upload', qk: q.k })));
  let list = await build();
  if (!list.length) return;
  let i = typeof start === 'string' ? Math.max(0, list.findIndex(x => x.qk === start)) : Math.min(start || 0, list.length - 1);
  let zoom = false;
  const el = document.createElement('div'); el.className = 'viewer';
  el.innerHTML = '<div class="vbar"><button class="vx" data-v="x">✕</button><span class="vc"></span><button class="vdel" data-v="del">' +
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>Remove</button></div>' +
    '<div class="im"><img alt=""></div><div class="vname"></div>' +
    '<div class="nav"><button data-v="p">‹ Prev</button><button data-v="n">Next ›</button></div>';
  document.body.appendChild(el);
  const img = el.querySelector('img'), cap = el.querySelector('.vc'), nm = el.querySelector('.vname'), box = el.querySelector('.im');
  const big = {};   // full-size versions, memory only
  const show = async () => {
    const it = list[i]; zoom = false; box.classList.remove('z');
    cap.textContent = (kind === 'before' ? 'Before' : 'After') + ' · ' + (i + 1) + ' of ' + list.length;
    nm.textContent = it.name.replace(/\.[a-z]+$/i, '');
    el.querySelector('.vdel').style.visibility = it.local ? 'hidden' : 'visible';
    if (it.local) { img.src = it.local; return; }
    img.src = imgMem[it.id] || (await image(it.id).catch(() => '')) || '';
    if (navigator.onLine && !big[it.id]) {      // swap in a sharper copy for zooming
      const id = it.id;
      api('photo', { id: id, size: 2400 }, 60000).then(o => { big[id] = o.img; if (list[i] && list[i].id === id) img.src = o.img; }).catch(() => {});
    } else if (big[it.id]) img.src = big[it.id];
  };
  const close = () => { el.remove(); render(); };
  el.addEventListener('click', e => {
    const v = e.target.closest('[data-v]'); if (!v) return;
    if (v.dataset.v === 'x') close();
    if (v.dataset.v === 'p') { i = (i - 1 + list.length) % list.length; show(); }
    if (v.dataset.v === 'n') { i = (i + 1) % list.length; show(); }
    if (v.dataset.v === 'del') removeFlow(job, kind, list[i]).then(async gone => {
      if (!gone) return;
      list = await build();
      if (!list.length) { close(); return; }
      i = Math.min(i, list.length - 1); show();
    });
  });
  // double-tap to zoom, drag to pan while zoomed, swipe to change photo when not
  let lastTap = 0, x0 = null;
  box.addEventListener('click', e => {
    const now = Date.now();
    if (now - lastTap < 320) {
      zoom = !zoom; box.classList.toggle('z', zoom);
      if (zoom) { const r = box.getBoundingClientRect(); box.scrollLeft = (e.clientX - r.left) * 1.5; box.scrollTop = (e.clientY - r.top) * 1.5; }
    }
    lastTap = now;
  });
  box.addEventListener('touchstart', e => { x0 = zoom ? null : e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', e => {
    if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 60) { i = (i + (dx < 0 ? 1 : -1) + list.length) % list.length; show(); }
  });
  show();
}

/** Three separate yes's, buttons swap sides and wait a moment each step, so it can't happen by a stray tap. */
function removeFlow(job, kind, photo) {
  return new Promise(resolve => {
    if (!photo || photo.local) { resolve(false); return; }
    if (!navigator.onLine) { toast('Needs signal to remove a photo.'); resolve(false); return; }
    const label = kind === 'before' ? 'before' : 'after';
    const steps = [
      { t: 'Remove this photo?', d: 'From the ' + label + ' photos of ' + job.ref + '.', yes: 'Yes, remove', yesLeft: false },
      { t: 'Are you sure?', d: 'It won\'t be counted and won\'t go in the service report.', yes: 'Yes, I\'m sure', yesLeft: true },
      { t: 'Last check', d: 'It moves to an Archived folder in Drive, so it can be got back if this was a mistake.', yes: 'Remove photo', yesLeft: false, red: true },
    ];
    const el = document.createElement('div'); el.className = 'confirm';
    document.body.appendChild(el);
    let k = 0;
    const draw = () => {
      const st = steps[k];
      const yes = '<button class="cy' + (st.red ? ' red' : '') + '" data-c="y" disabled>' + st.yes + '</button>';
      const no = '<button class="cn" data-c="n" disabled>' + (k ? 'No, keep it' : 'Cancel') + '</button>';
      el.innerHTML = '<div class="cbox"><div class="cstep">Step ' + (k + 1) + ' of 3</div>' +
        (photo.id && imgMem[photo.id] ? '<img src="' + imgMem[photo.id] + '" alt="">' : '') +
        '<h3>' + st.t + '</h3><p>' + esc(st.d) + '</p><div class="cbtns">' + (st.yesLeft ? yes + no : no + yes) + '</div></div>';
      setTimeout(() => el.querySelectorAll('button').forEach(b => { b.disabled = false; }), 600);
    };
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-c]'); if (!b || b.disabled) return;
      if (b.dataset.c === 'n') { el.remove(); resolve(false); return; }
      if (k < steps.length - 1) { k++; draw(); return; }
      b.disabled = true; b.textContent = 'Removing…';
      try {
        const out = await api('archive', { ref: job.ref, wo: job.wo, kind: kind, id: photo.id });
        job[kind] = out.count; ls.set('months', S.months);
        delete S.lists[job.ref + '|' + job.wo + '|' + kind];
        await photoList(job, kind, true);
        el.remove(); toast('Photo removed · kept in the Archived folder in Drive'); resolve(true);
      } catch (err) { el.remove(); toast('Could not remove: ' + err.message, 4500); resolve(false); }
    });
    draw();
  });
}

/** Two yes's to push a job through to green without matching photo counts. Shared with the other phone. */
function markDone(on) {
  const f = findJob(S.view.ref, S.view.wo); if (!f) return;
  const job = f.job, c = counts(job);
  if (!navigator.onLine) { toast('Needs signal so it shows on both phones.'); return; }
  const steps = on ? [
    { t: 'Mark ' + job.ref + ' complete?', d: 'It has ' + c.before + ' before and ' + c.after + ' after photos. Only do this if the rest of the work isn\'t happening.', yes: 'Yes, complete', yesLeft: false },
    { t: 'Sure?', d: 'It turns green on both phones, even without matching photos.', yes: 'Yes, mark it', yesLeft: true },
  ] : [{ t: 'Undo marked complete?', d: 'It goes back to amber until the photos match.', yes: 'Yes, undo', yesLeft: false }];
  const el = document.createElement('div'); el.className = 'confirm'; document.body.appendChild(el);
  let k = 0;
  const draw = () => {
    const st = steps[k];
    const yes = '<button class="cy" data-c="y" disabled>' + st.yes + '</button>', no = '<button class="cn" data-c="n" disabled>Cancel</button>';
    el.innerHTML = '<div class="cbox">' + (steps.length > 1 ? '<div class="cstep">Step ' + (k + 1) + ' of ' + steps.length + '</div>' : '') +
      '<h3>' + esc(st.t) + '</h3><p>' + esc(st.d) + '</p><div class="cbtns">' + (st.yesLeft ? yes + no : no + yes) + '</div></div>';
    setTimeout(() => el.querySelectorAll('button').forEach(b => { b.disabled = false; }), 500);
  };
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-c]'); if (!b || b.disabled) return;
    if (b.dataset.c === 'n') { el.remove(); return; }
    if (k < steps.length - 1) { k++; draw(); return; }
    b.disabled = true; b.textContent = 'Saving…';
    try {
      const out = await api('markDone', { ref: job.ref, wo: job.wo, done: on, by: ls.get('who', '') });
      job.done = out.done; ls.set('months', S.months); el.remove(); render();
      toast(on ? job.ref + ' marked complete' : 'Undone');
    } catch (err) { el.remove(); toast('Could not save: ' + err.message); }
  });
  draw();
}

/* ---------------- docs + finish sheets ---------------- */

async function docsSheet() {
  const f = findJob(S.view.ref, S.view.wo); if (!f) return;
  const job = f.job, k = job.ref + '|' + job.wo + '|docs';
  const el = document.createElement('div'); el.className = 'sheet';
  el.innerHTML = '<div class="top"><button class="back" data-d="x">‹</button><h1>Docs · ' + esc(job.ref) + '</h1></div><div id="docl" class="empty">Loading…</div>';
  document.body.appendChild(el);
  let docs = null;
  if (navigator.onLine) { try { docs = (await api('docs', { ref: job.ref, wo: job.wo })).docs; await idb.put('list', { k: k, v: docs }); } catch (e) { /* use saved */ } }
  if (!docs) { const s = await idb.get('list', k); docs = s ? s.v : []; }
  const saved = new Set((await idb.all('doc')).map(d => d.k));
  const icon = n => /swms/i.test(n) ? '🦺' : /atw/i.test(n) ? '✅' : /invoice/i.test(n) ? '💲' : / sr\b/i.test(n) ? '📋' : '📄';
  el.querySelector('#docl').outerHTML = docs.length ? docs.map(d =>
    '<button class="doc" data-id="' + d.id + '"><span class="ic">' + icon(d.name) + '</span><span>' + esc(d.name.replace(/\.pdf$/i, '')) +
    '<small>' + (saved.has(d.id) ? 'Saved on phone' : 'Needs signal the first time') + '</small></span></button>').join('')
    : '<div class="empty">No docs in this job\'s Docs folder yet.</div>';
  el.addEventListener('click', e => {
    if (e.target.closest('[data-d="x"]')) { el.remove(); return; }
    const b = e.target.closest('.doc'); if (!b) return;
    const d = docs.find(x => x.id === b.dataset.id);
    openDoc(d).then(() => { const s = b.querySelector('small'); if (s) s.textContent = 'Saved on phone'; }).catch(err => toast(err.message));
  });
  // keep SWMS + ATW on the phone for no-signal plant rooms
  if (navigator.onLine) for (const d of docs.filter(d => /swms|atw/i.test(d.name) && !saved.has(d.id))) {
    try { const out = await api('doc', { id: d.id }, 90000); await idb.put('doc', { k: d.id, v: out.data, u: d.updated || 0, name: d.name }); } catch (e) { break; }
    const b = el.querySelector('[data-id="' + d.id + '"] small'); if (b) b.textContent = 'Saved on phone';
  }
}

function finishSheet() {
  const f = findJob(S.view.ref, S.view.wo); if (!f) return;
  const job = f.job;
  if (S.queue.some(q => q.ref === job.ref)) { toast('Photos are still uploading. Finish once they are up.'); sync(); return; }
  if (!navigator.onLine) { toast('Needs signal to make the report. Your photos are safe.'); return; }
  const mats = new Set(ls.get('mats', []));
  const el = document.createElement('div'); el.className = 'sheet';
  el.innerHTML = '<div class="top"><button class="back" data-f="x">‹</button><h1>Finish ' + esc(job.ref) + '</h1></div>' +
    '<label class="f">Date of work</label><input class="in" type="date" id="fDate" value="' + new Date().toLocaleDateString('en-CA') + '">' +
    '<label class="f">Technicians</label><input class="in" id="fTech" value="' + esc(ls.get('techs', 'Jeffrey, Harrison & Stephan')) + '">' +
    (job.type === 'passive' ? '<label class="f">Materials used</label><div class="units" id="fMats">' +
      MATERIALS.map(m => '<button class="unit' + (mats.has(m) ? ' on' : '') + '" data-m="' + esc(m) + '">' + esc(m) + '</button>').join('') + '</div>' : '') +
    '<label class="f">Extra notes (optional)</label><textarea class="in" id="fNotes"></textarea>' +
    '<div style="height:16px"></div><button class="btn wide green" data-f="go"><span class="ic">📋</span>Make service report</button>' +
    '<div class="small">The PDF goes into the job\'s Docs folder with all before and after photos.</div>';
  document.body.appendChild(el);
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-f="x"]')) { el.remove(); return; }
    const m = e.target.closest('[data-m]');
    if (m) { m.classList.toggle('on'); return; }
    const goBtn = e.target.closest('[data-f="go"]'); if (!goBtn) return;
    const chosen = [...el.querySelectorAll('[data-m].on')].map(b => b.dataset.m);
    const techs = $('#fTech').value.trim();
    ls.set('techs', techs); if (job.type === 'passive') ls.set('mats', chosen);
    goBtn.disabled = true; goBtn.lastChild.textContent = 'Making report… (up to a minute)';
    try {
      const out = await api('finish', { ref: job.ref, wo: job.wo, loc: job.loc, job: job.job, date: $('#fDate').value, techs: techs, materials: chosen, notes: $('#fNotes').value.trim() }, 180000);
      job.sr = true; ls.set('months', S.months);
      el.remove(); render(); toast('✓ ' + out.name + ' saved to Docs (' + out.before + ' before, ' + out.after + ' after)', 4500);
    } catch (err) { goBtn.disabled = false; goBtn.lastChild.textContent = 'Make service report'; toast('Report failed: ' + err.message, 5000); }
  });
}

/* ---------------- PIN ---------------- */

function pinView() {
  return '<div class="pin"><img src="icon-192.png" alt=""><h1 style="font:700 30px BarlowC,Barlow">Frontline</h1>' +
    '<input class="in" id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN">' +
    '<button class="btn wide cam" id="pinGo">Log in</button><div class="err" id="pinErr">' + esc(S.error) + '</div></div>';
}
function bindPin() {
  const go2 = async () => {
    const pin = $('#pin').value.trim(); if (!pin) return;
    $('#pinGo').disabled = true; $('#pinErr').textContent = '';
    S.pin = pin;
    try { const hi = await api('hello'); ls.set('pin', pin); if (hi.who) ls.set('who', hi.who); S.error = ''; render(); loadMonths(); sync(); }
    catch (e) { S.pin = ''; $('#pinGo').disabled = false; $('#pinErr').textContent = navigator.onLine ? e.message : 'Needs signal to log in the first time.'; }
  };
  $('#pinGo').onclick = go2;
  $('#pin').onkeydown = e => { if (e.key === 'Enter') go2(); };
  $('#pin').focus();
}

/* ---------------- events ---------------- */

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.closest('.sheet,.viewer')) return;
  const a = b.dataset.act;
  if (a === 'month') go({ screen: 'month', ym: b.dataset.ym });
  else if (a === 'home') go({ screen: 'months' });
  else if (a === 'back') { const f = findJob(S.view.ref, S.view.wo); go(f || S.view.ym ? { screen: 'month', ym: f ? f.month.ym : S.view.ym } : { screen: 'months' }); }
  else if (a === 'job') go({ screen: 'job', ref: b.dataset.ref, wo: b.dataset.wo, ym: S.view.ym });
  else if (a === 'type') { S.type = b.dataset.t; ls.set('type', S.type); render(); }
  else if (a === 'hide') { S.hideDone = !S.hideDone; ls.set('hideDone', S.hideDone); render(); }
  else if (a === 'refresh') { loadMonths(); sync(); }
  else if (a === 'cam') pick(b.dataset.k, true);
  else if (a === 'lib') pick(b.dataset.k, false);
  else if (a === 'unit') { S.unit = S.unit === b.dataset.u ? '' : b.dataset.u; render(); }
  else if (a === 'view') viewer(b.dataset.k, Number(b.dataset.i));
  else if (a === 'viewq') viewer(b.dataset.k, b.dataset.id);
  else if (a === 'docs') docsSheet().catch(err => toast(err.message));
  else if (a === 'finish') finishSheet();
  else if (a === 'markdone') markDone(true);
  else if (a === 'undone') markDone(false);
});
document.addEventListener('input', e => {
  if (e.target.dataset.act === 'search') {
    S.q = e.target.value; const pos = e.target.selectionStart; render();
    const el = $('.search'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  }
});
$('#camIn').addEventListener('change', e => addFiles([...e.target.files]));
$('#libIn').addEventListener('change', e => addFiles([...e.target.files]));
window.addEventListener('online', () => { S.online = true; renderSync(); sync(); loadMonths(true); });
window.addEventListener('offline', () => { S.online = false; renderSync(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) { sync(); if (Date.now() - S.loadedAt > 5 * 60000) loadMonths(true); } });

/* ---------------- start ---------------- */

(async function start() {
  try { S.queue = await idb.all('queue'); } catch (e) { S.queue = []; }
  render();
  if (S.pin) { loadMonths(!!S.months); sync(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
