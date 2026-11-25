/**
 * Frontline app - backend v3.0 (stripped back: jobs by month, before/after photos, service report)
 *
 * Lives in the Apps Script project bound to the "Passive Fire Master" sheet (same project and deployment URL as v2).
 * Works off the Projects register (WO + Folders tabs) and each job's Drive folder:
 *   <job folder>/Before Photos, /After Photos, /Docs
 *
 * Setup (once):
 *   1. Paste this file over Code.gs and save.
 *   2. Reload the Passive Fire Master sheet > menu "Frontline" > "Set app PIN". Both phones use that PIN.
 *   3. Run authorise() once from the editor and approve Google's prompt (Drive, Sheets, external requests).
 *   4. Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy.
 *      (Execute as: Me. Who has access: Anyone.)
 *
 * The previous v2 backend is in the GitHub repo under archive/v2/apps-script/Code.gs.
 */

const REGISTER_ID = '1i3U44wdBX_U6hZkELQZ1RbhmUk3D4d0Es4B8nfeuRgU';  // Projects 2026 Project/Quote List
const MASTER_ID = '1NIoah5dnH3XCKl-8XCBvQVFsdwuO0moIaJGkC-sQKm0';     // Passive Fire Master (holds the hidden "App log" tab)
const JOBS_ROOT_ID = '1z3V08ibtgtZdXUkiPvClSJyiON2pRAUS';            // parent of "2026-11 November" etc.
const LOGO_ID = '1JyEHzwk8WvUt-eDbWYfBa7TLa1yuCkJ7';                 // Frontline app assets/SR logo.jpg
const SIGNOFF_ID = '1a7wBpkngOUQ9B2LapHDca03sVklsWS19';              // Frontline app assets/SR sign-off.png
const FIRST_YEAR = 2026;   // the WO tab's first month block is in this year
const TZ = 'Australia/Melbourne';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SUB = { before: 'Before Photos', after: 'After Photos', docs: 'Docs' };
const ARCHIVE = 'Archived (removed in app)';   // inside Before Photos / After Photos; never in counts or reports

// WO tab columns (0-based). G "PO Received" was added in Nov 2026, so everything from G on moved one to the right.
const W = { ref: 0, wo: 1, loc: 2, job: 3, status: 5, price: 8, month: 11 };
// Folders tab columns (1-based)
const F = { key: 1, ref: 2, wo: 3, url: 4, invoice: 5, sr: 6, before: 9, after: 10, name: 11, docs: 12 };  // M = Before ID, N = After ID
const DONE_HEADER = 'Marked complete';   // app override column, found by its header (added after the last column if missing)

/* ================= web app ================= */

function doGet() {
  return ContentService.createTextOutput('Frontline app backend v3.0').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.action === 'claimPin') return json_(claimPin_(body));
    if (body.action === 'pinStatus') return json_({ ok: true, open: PEOPLE.filter(n => !pins_()[n]) });
    const who = checkPin_(body.pin);
    body.by = who;
    switch (body.action) {
      case 'hello': return json_({ ok: true, who: who });
      case 'months': return json_({ ok: true, months: months_() });
      case 'photos': return json_({ ok: true, photos: listPhotos_(body.ref, body.wo, body.kind) });
      case 'photo': return json_({ ok: true, id: body.id, img: thumb_(body.id, body.size || 1200) });
      case 'docs': return json_({ ok: true, docs: listDocs_(body.ref, body.wo) });
      case 'doc': return json_({ ok: true, id: body.id, data: docData_(body.id) });
      case 'markDone': return json_(withLock_(() => markDone_(body)));
      case 'archive': return json_(withLock_(() => archive_(body)));
      case 'upload': return json_(withLock_(() => upload_(body)));
      case 'finish': return json_(withLock_(() => finish_(body)));
      default: throw new Error('Unknown action');
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ================= hidden activity log ================= */

/** One row per app action, on a hidden "App log" tab in Passive Fire Master. Never shown in the app. */
function log_(who, action, ref, wo, kind, name, fileId, takenAt) {
  try {
    const ss = SpreadsheetApp.openById(MASTER_ID);
    let sh = ss.getSheetByName('App log');
    if (!sh) {
      sh = ss.insertSheet('App log');
      sh.appendRow(['Logged', 'Who', 'Action', 'Job', 'WO', 'Before/After', 'File name', 'Taken on phone', 'Drive file']);
      sh.setFrozenRows(1);
      sh.hideSheet();
    }
    sh.appendRow([new Date(), who || '', action, ref || '', wo || '', kind || '', name || '',
      takenAt ? new Date(Number(takenAt)) : '', fileId ? 'https://drive.google.com/file/d/' + fileId + '/view' : '']);
  } catch (e) { /* logging must never block the app */ }
}

/* ================= PIN ================= */

/** Each person has their own PIN (Script property PIN_HASHES = {"Jeff": hash, "Dan": hash}). Returns whose PIN it was. */
function pins_() {
  const p = PropertiesService.getScriptProperties();
  let map = {};
  try { map = JSON.parse(p.getProperty('PIN_HASHES') || '{}'); } catch (e) { map = {}; }
  const old = p.getProperty('PIN_HASH');
  if (old && !Object.keys(map).length) map = { Shared: old };
  return map;
}

function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('PIN_FAILS') || 0);
  if (fails >= 10) throw new Error('Too many wrong PINs. Try again in 15 minutes.');
  const map = pins_();
  if (!Object.keys(map).length) throw new Error('No PIN set yet. Jeff: Passive Fire Master sheet > Frontline > Set Jeff\'s PIN.');
  const h = sha256_(String(pin || ''));
  const who = Object.keys(map).find(k => map[k] === h);
  if (!who) {
    cache.put('PIN_FAILS', String(fails + 1), 900);
    throw new Error('Wrong PIN');
  }
  return who;
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Frontline')
    .addItem("Set Jeff's PIN", 'setPinJeff')
    .addItem("Set Dan's PIN", 'setPinDan')
    .addSeparator()
    .addItem('Turn on nightly photo tidy', 'setupSweep')
    .addItem('Run photo tidy now', 'nightlySweep')
    .addToUi();
}

const PEOPLE = ['Jeff', 'Dan'];

/** First login on a phone: a person with no PIN yet picks their own. Once set, only the sheet menu can change it. */
function claimPin_(b) {
  const name = PEOPLE.find(n => n.toLowerCase() === String(b.name || '').toLowerCase());
  const pin = String(b.newPin || '').trim();
  if (!name) throw new Error('Unknown name');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Use 4 to 8 digits');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const map = pins_();
    if (map[name]) throw new Error(name + ' already has a PIN. Ask Jeff to reset it from the sheet if it\'s forgotten.');
    const h = sha256_(pin);
    if (Object.keys(map).some(k => map[k] === h)) throw new Error('Pick a different PIN');
    delete map.Shared;
    map[name] = h;
    PropertiesService.getScriptProperties().setProperty('PIN_HASHES', JSON.stringify(map));
    log_(name, 'Set own PIN on first login');
    return { ok: true, who: name };
  } finally { lock.releaseLock(); }
}

function setPinJeff() { setPinFor_('Jeff'); }
function setPinDan() { setPinFor_('Dan'); }

function setPinFor_(name) {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt(name + "'s Frontline app PIN", 'Type a 4–8 digit PIN for ' + name + '. Their phone will ask for it once.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const pin = r.getResponseText().trim();
  if (!/^\d{4,8}$/.test(pin)) { ui.alert('Use 4 to 8 digits.'); return; }
  const h = sha256_(pin);
  const map = pins_();
  delete map.Shared;
  const clash = Object.keys(map).find(k => k !== name && map[k] === h);
  if (clash) { ui.alert('That PIN is already ' + clash + "'s. Pick a different one."); return; }
  map[name] = h;
  const p = PropertiesService.getScriptProperties();
  p.setProperty('PIN_HASHES', JSON.stringify(map));
  p.deleteProperty('PIN_HASH');
  CacheService.getScriptCache().remove('PIN_FAILS');
  ui.alert(name + "'s PIN is saved.");
}

/** Run once from the editor so Google asks for every permission the app needs. */
function authorise() {
  DriveApp.getFolderById(JOBS_ROOT_ID).getName();
  SpreadsheetApp.openById(REGISTER_ID).getName();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: auth_() });
  Logger.log('All good');
}

/* ================= jobs ================= */

/** Every WO row with its calendar month worked out (the tab has no year column, so it follows the row order). */
function readWO_() {
  const rows = SpreadsheetApp.openById(REGISTER_ID).getSheetByName('WO').getDataRange().getDisplayValues();
  let year = FIRST_YEAR, last = null;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const mi = MONTHS.map(m => m.toLowerCase()).indexOf(String(r[W.month] || '').trim().toLowerCase());
    if (mi < 0) continue;
    if (last !== null && mi < last && last - mi > 5) year++;
    last = mi;
    out.push({
      row: i + 1, ym: year + '-' + String(mi + 1).padStart(2, '0'),
      ref: s_(r[W.ref]), wo: s_(r[W.wo]), loc: s_(r[W.loc]), job: s_(r[W.job]), status: s_(r[W.status]), price: s_(r[W.price]),
    });
  }
  return out;
}

function s_(v) { return String(v == null ? '' : v).trim(); }

function type_(job, ref) {
  const j = String(job || '').toLowerCase();
  if (/^iot|sensor/.test(j) || /^(AH|FL)_/i.test(ref)) return 'sensors';
  if (/passive|penetration/.test(j)) return 'passive';
  if (/water filter/.test(j)) return 'water';
  if (/filter/.test(j)) return 'filters';
  if (/\bsit\b|interface/.test(j)) return 'sit';
  if (/fire/.test(j)) return 'repairs';
  return 'other';
}

function months_() {
  const now = new Date();
  const want = [-1, 0, 1, 2, 3, 4, 5, 6].map(k => {   // last month (shown only while it has unfinished jobs) + this month + the next 6
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    return Utilities.formatDate(d, TZ, 'yyyy-MM');
  });
  const folders = foldersIndex_();
  const by = {};
  want.forEach(ym => by[ym] = []);
  readWO_().forEach(r => {
    if (!by[r.ym]) return;
    const type = type_(r.job, r.ref);
    if (type === 'sensors' || /lost/i.test(r.status)) return;
    if (!r.ref && !r.loc) return; // empty placeholder rows
    const f = findFolder_(folders, r.ref, r.wo);
    by[r.ym].push({
      ref: r.ref, wo: r.wo, loc: r.loc, job: r.job, type: type, status: r.status, price: money_(r.price),
      before: f ? num_(f.before) : 0, after: f ? num_(f.after) : 0, sr: !!(f && /✓/.test(f.sr)), hasFolder: !!f, done: f ? f.done : '',
    });
  });
  return want.map((ym, i) => {
    const m = Number(ym.slice(5)) - 1;
    return { ym: ym, label: MONTHS[m], year: ym.slice(0, 4), jobs: by[ym], when: i === 0 ? 'past' : i === 1 ? 'now' : 'ahead' };
  });
}

function money_(v) { return Number(String(v || '').replace(/[^0-9.\-]/g, '')) || 0; }
function num_(v) { return Number(String(v || '').replace(/[^0-9]/g, '')) || 0; }

/* ================= folders ================= */

function foldersSheet_() { return SpreadsheetApp.openById(REGISTER_ID).getSheetByName('Folders'); }

/** 1-based column of the "Marked complete" header on the Folders tab, or 0 if it hasn't been made yet. */
function doneCol_(header) { return header.findIndex(h => String(h).trim() === DONE_HEADER) + 1; }

function foldersIndex_() {
  const rows = foldersSheet_().getDataRange().getDisplayValues();
  const dc = doneCol_(rows[0] || []);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[F.url - 1]) continue;
    out.push({ row: i + 1, ref: s_(r[F.ref - 1]), wo: s_(r[F.wo - 1]), url: r[F.url - 1], sr: r[F.sr - 1], before: r[F.before - 1], after: r[F.after - 1], docs: s_(r[F.docs - 1]), done: dc ? s_(r[dc - 1]) : '' });
  }
  return out;
}

function findFolder_(index, ref, wo) {
  return index.find(f => ref && f.ref === ref && (!wo || !f.wo || f.wo === wo)) ||
    index.find(f => ref && f.ref === ref) ||
    index.find(f => wo && f.wo === wo) || null;
}

function idFromUrl_(url) { const m = String(url).match(/[-\w]{25,}/); return m ? m[0] : ''; }

function child_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** The job's Drive folder; made (with Before/After/Docs) and added to the Folders tab if it doesn't exist yet. */
function jobFolder_(ref, wo) {
  const index = foldersIndex_();
  const f = findFolder_(index, ref, wo);
  if (f) return { folder: DriveApp.getFolderById(idFromUrl_(f.url)), row: f.row };
  const job = readWO_().find(r => r.ref === ref && (!wo || r.wo === wo));
  if (!job) throw new Error('Job ' + ref + ' is not on the WO tab');
  const m = Number(job.ym.slice(5)) - 1;
  const month = child_(DriveApp.getFolderById(JOBS_ROOT_ID), job.ym + ' ' + MONTHS[m]);
  const name = [job.ref, [job.loc, job.job].filter(String).join(' - '), job.wo].filter(String).join(' · ');
  const folder = month.createFolder(name);
  const docs = folder.createFolder(SUB.docs);
  folder.createFolder(SUB.before); folder.createFolder(SUB.after);
  const sh = foldersSheet_();
  const row = sh.getLastRow() + 1;
  const line = new Array(12).fill('');
  line[F.key - 1] = job.ref + (job.wo ? '|' + job.wo : ''); line[F.ref - 1] = job.ref; line[F.wo - 1] = job.wo;
  line[F.url - 1] = folder.getUrl(); line[F.before - 1] = 0; line[F.after - 1] = 0; line[F.name - 1] = name; line[F.docs - 1] = docs.getId();
  sh.getRange(row, 1, 1, 12).setValues([line]);
  return { folder: folder, row: row };
}

/** Manual "complete anyway" (e.g. fewer after photos than before). Shared by both phones via the Folders tab, column M. */
function markDone_(b) {
  const jf = jobFolder_(s_(b.ref), s_(b.wo));
  const sh = foldersSheet_();
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  let col = doneCol_(header);
  if (!col) { col = sh.getLastColumn() + 1; sh.getRange(1, col).setValue(DONE_HEADER); }
  const val = b.done ? 'Yes · ' + s_(b.by || 'app') + ' · ' + Utilities.formatDate(new Date(), TZ, 'd MMM') : '';
  sh.getRange(jf.row, col).setValue(val);
  log_(b.by, b.done ? 'Marked complete' : 'Undid marked complete', b.ref, b.wo);
  return { ok: true, done: val };
}

/* ================= photos ================= */

function images_(folder) {
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (/^image\//.test(f.getMimeType())) out.push({ id: f.getId(), name: f.getName(), t: f.getDateCreated().getTime() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.t - b.t);
}

function listPhotos_(ref, wo, kind) {
  const f = findFolder_(foldersIndex_(), ref, wo);
  if (!f) return [];
  const sub = DriveApp.getFolderById(idFromUrl_(f.url)).getFoldersByName(SUB[kind] || SUB.before);
  return sub.hasNext() ? images_(sub.next()).map(p => ({ id: p.id, name: p.name })) : [];
}

/* ================= docs (SWMS, ATW, SR, invoice) ================= */

function listDocs_(ref, wo) {
  const f = findFolder_(foldersIndex_(), ref, wo);
  if (!f) return [];
  const it = DriveApp.getFolderById(idFromUrl_(f.url)).getFoldersByName(SUB.docs);
  if (!it.hasNext()) return [];
  const out = [];
  const files = it.next().getFiles();
  while (files.hasNext()) {
    const x = files.next();
    if (/\(old /.test(x.getName())) continue;
    out.push({ id: x.getId(), name: x.getName(), mime: x.getMimeType(), size: x.getSize(), updated: x.getLastUpdated().getTime() });
  }
  const rank = n => /swms/i.test(n) ? 0 : /atw/i.test(n) ? 1 : / sr\b/i.test(n) ? 2 : /invoice/i.test(n) ? 4 : 3;
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** A doc's bytes as a data URL, so it opens on a phone that isn't signed in to Google (and can be kept offline). */
function docData_(id) {
  const file = DriveApp.getFileById(id);
  const blob = /^application\/vnd\.google-apps\./.test(file.getMimeType()) ? file.getAs('application/pdf') : file.getBlob();
  if (blob.getBytes().length > 20 * 1024 * 1024) throw new Error('File too big to open in the app');
  return 'data:' + (blob.getContentType() || 'application/pdf') + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function auth_() { return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }; }

/** A resized JPEG of a Drive image as a data URL (Drive's own thumbnailer does the resizing). */
function thumb_(id, size) {
  const meta = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?fields=thumbnailLink,mimeType', { headers: auth_() }).getContentText());
  let blob;
  if (meta.thumbnailLink) {
    const res = UrlFetchApp.fetch(meta.thumbnailLink.replace(/=s\d+$/, '=s' + size), { headers: auth_(), muteHttpExceptions: true });
    if (res.getResponseCode() === 200) blob = res.getBlob();
  }
  if (!blob) blob = DriveApp.getFileById(id).getBlob(); // thumbnail not ready yet (just uploaded): send the original
  return 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

function upload_(b) {
  const kind = b.kind === 'after' ? 'after' : 'before';
  const cache = CacheService.getScriptCache();
  if (b.uid) { const done = cache.get('UP_' + b.uid); if (done) return JSON.parse(done); } // retry of an upload that already landed
  const jf = jobFolder_(s_(b.ref), s_(b.wo));
  const sub = child_(jf.folder, SUB[kind]);
  const label = kind === 'after' ? 'After' : 'Before';
  const n = nextNumber_(sub, label);
  const name = [s_(b.ref), short_(b.loc), s_(b.unit), label + ' ' + n].filter(String).join(' - ').replace(/[\/\\:*?"<>|]/g, '-') + '.jpg';
  const data = String(b.data || '').replace(/^data:[^,]+,/, '');
  if (!data) throw new Error('No photo data');
  const created = sub.createFile(Utilities.newBlob(Utilities.base64Decode(data), 'image/jpeg', name));
  const takenAt = b.t ? new Date(Number(b.t)) : new Date();
  try { created.setDescription('Taken by ' + s_(b.by || 'unknown') + ' · ' + Utilities.formatDate(takenAt, TZ, 'd MMM yyyy h:mm a') + ' (Frontline app)'); } catch (e) {}
  log_(b.by, 'Photo added', b.ref, b.wo, kind, name, created.getId(), b.t);
  const count = images_(sub).length;
  foldersSheet_().getRange(jf.row, kind === 'after' ? F.after : F.before).setValue(count);
  const out = { ok: true, name: name, count: count, kind: kind };
  if (b.uid) cache.put('UP_' + b.uid, JSON.stringify(out), 21600);
  return out;
}

/** Next free photo number, counting archived ones too so names never repeat. */
function nextNumber_(sub, label) {
  const re = new RegExp('\\b' + label + ' (\\d+)\\b', 'i');
  let max = 0;
  const scan = folder => { const it = folder.getFiles(); while (it.hasNext()) { const m = it.next().getName().match(re); if (m) max = Math.max(max, Number(m[1])); } };
  scan(sub);
  const a = sub.getFoldersByName(ARCHIVE); if (a.hasNext()) scan(a.next());
  return Math.max(max, images_(sub).length) + 1;
}

/** "Delete" from the app: moves the photo into an Archived folder beside it. Nothing is ever trashed. */
function archive_(b) {
  const kind = b.kind === 'after' ? 'after' : 'before';
  const jf = jobFolder_(s_(b.ref), s_(b.wo));
  const sub = child_(jf.folder, SUB[kind]);
  const file = DriveApp.getFileById(String(b.id));
  const parents = file.getParents(); let inside = false;
  while (parents.hasNext()) if (parents.next().getId() === sub.getId()) inside = true;
  if (!inside) throw new Error('That photo is not in this job\'s ' + SUB[kind] + ' folder');
  file.moveTo(child_(sub, ARCHIVE));
  file.setDescription(String(file.getDescription() || '') + ' · Removed by ' + s_(b.by || 'unknown') + ' ' + Utilities.formatDate(new Date(), TZ, 'd MMM yyyy h:mm a'));
  log_(b.by, 'Photo removed (archived)', b.ref, b.wo, kind, file.getName(), file.getId());
  const count = images_(sub).length;
  foldersSheet_().getRange(jf.row, kind === 'after' ? F.after : F.before).setValue(count);
  return { ok: true, count: count, kind: kind };
}

/** "HSB L3.5 External Plant Room - Air Intake" -> "HSB L3.5" (building + level), as in the existing photo names. */
function short_(loc) {
  const p = parseLoc_(loc);
  const lvl = (String(p.location).match(/\b(L\d+(?:\.\d+)?|Roof|Basement|B\d)\b/i) || [''])[0];
  return [p.buildingCode, lvl].filter(String).join(' ');
}

/* ================= location parsing ================= */

const BUILDINGS = [
  [/^(austin\s+)?tower\b|^AT\b/i, 'AT', 'Austin Tower'],
  [/^HSB\b/i, 'HSB', 'HSB'],
  [/^LTB\b/i, 'LTB', 'LTB'],
  [/^(austin\s+)?ONJ\b/i, 'ONJ', 'ONJ'],
  [/^bioresources\b/i, 'Bioresources', 'Bioresources'],
  [/^florey\b/i, 'Florey', 'Florey'],
  [/^(repat|repatriation)\b/i, 'Repat', 'Repatriation'],
];

function parseLoc_(loc) {
  let parts = String(loc || '').replace(/[–—]/g, '-').split(/\s+-\s+/).map(s => s.trim()).filter(String);
  if (parts.length && /^\d+(\.\d+)+$/.test(parts[0])) parts.shift();      // "258.4.3 - ..."
  let first = parts.shift() || '';
  first = first.replace(/^Austin\s+(?=ONJ|Tower)/i, '');
  let code = '', building = '';
  for (const [re, c, name] of BUILDINGS) {
    const m = first.match(re);
    if (m) { code = c; building = name; first = first.slice(m[0].length).trim(); break; }
  }
  let location = first, asset = '';
  if (!location) { location = parts.shift() || ''; }
  asset = parts.join(' - ');
  const site = /florey/i.test(loc) ? 'Florey Institute' : /repat|\bCPU\b|coral|\bNW\b/i.test(loc) ? 'Heidelberg Repatriation Hospital' : 'Austin Hospital';
  return { site: site, building: building || code, buildingCode: code, location: location, asset: asset };
}

/* ================= service report ================= */

const SR = {
  filters: {
    title: 'HVAC Filter Replacement', workType: 'Planned Maintenance',
    desc: p => 'Filter replacement works were carried out to the ' + (p.asset || 'unit(s)') + ' located in the ' + where_(p) + '. Works included isolating the unit(s), safely removing and disposing of existing HVAC filters, supplying and installing new filters of the specified type and size, and returning the unit(s) to normal service.',
    findings: 'Existing filters were found to be at end of service life and were removed and replaced as part of planned maintenance scope.',
    actions: () => ['Access, permits, and site inductions confirmed prior to commencement', 'Unit(s) isolated in accordance with site procedures and made safe for works', 'Filter type, quantity, and location verified on site', 'Approved replacement filters supplied to site', 'Existing filters removed safely and disposed of in accordance with site requirements', 'New filters installed correctly', 'Unit(s) reinstated and returned to service', 'Visual check completed to confirm correct filter fitment and operation'],
    outcome: 'The unit(s) were successfully returned to standard operating condition following filter replacement. Correct fitment was confirmed and unit operation verified at completion of works.',
    notes: 'Filters were disposed of in accordance with site requirements. All works were carried out by qualified technicians in accordance with industry best practices.',
    recs: 'Inspect filters in 6 months and schedule maintenance as required.',
  },
  water: {
    title: 'Water Filter Replacement', workType: 'Planned Maintenance',
    desc: p => 'Water filter replacement works were carried out to the ' + (p.asset || 'unit(s)') + ' located in the ' + where_(p) + '. Works included isolating the supply, removing the existing filter cartridges, installing new cartridges of the specified type and returning the system to service.',
    findings: 'Existing filter cartridges were at end of service life and were replaced as part of planned maintenance scope.',
    actions: () => ['Access, permits, and site inductions confirmed prior to commencement', 'Supply isolated in accordance with site procedures', 'Existing cartridges removed and disposed of in accordance with site requirements', 'New cartridges installed and housings checked for leaks', 'Supply reinstated and system returned to service'],
    outcome: 'The system was returned to normal operation with no leaks found at completion of works.',
    notes: 'All works were carried out by qualified technicians in accordance with industry best practices.',
    recs: 'Replace cartridges at the next scheduled service.',
  },
  passive: {
    title: 'Passive Fire Penetration Sealing', workType: 'Compliance / Corrective',
    desc: p => 'Passive fire penetration sealing works were carried out to service penetrations in the ' + where_(p) + (p.asset ? ' (' + p.asset + ')' : '') + '. Works included sealing non-compliant penetrations through fire-rated elements using approved fire-stopping systems to reinstate the fire resistance level of the wall/floor/ceiling.',
    findings: 'Unsealed and non-compliant service penetrations were identified through fire-rated construction during scouting, compromising the fire resistance level of the element.',
    actions: mats => ['Access, ATW and site inductions confirmed prior to commencement', 'Fire isolation arranged with Ventia where detectors were in the work area', 'Work area barricaded and protected']
      .concat((mats && mats.length ? mats : ['Approved fire-stopping systems']).map(m => m + ' installed / applied to penetrations'))
      .concat(['Area cleaned and isolations reinstated with Ventia on completion']),
    outcome: 'All penetrations within scope were sealed with approved fire-stopping systems, reinstating the fire resistance level of the element. Work area left clean and tidy.',
    notes: "All works carried out by qualified technicians in accordance with the manufacturers' tested systems, AS 1530.4 / AS 4072.1 and site requirements.",
    recs: 'Any new services installed through this element should be sealed with an approved system at the time of installation.',
  },
  other: {
    title: null, workType: 'Corrective',
    desc: p => (p.job || 'Works') + ' were carried out at the ' + where_(p) + (p.asset ? ' (' + p.asset + ')' : '') + '.',
    findings: 'Works were completed to the scope of the work order.',
    actions: () => ['Access, permits, and site inductions confirmed prior to commencement', 'Work area made safe and protected', 'Works completed to scope', 'Area cleaned and left tidy on completion'],
    outcome: 'Works were completed to scope and the area was left clean and tidy.',
    notes: 'All works were carried out by qualified technicians in accordance with industry best practices and site requirements.',
    recs: 'No further action required.',
  },
};

function where_(p) { return [p.location, p.building, p.site].filter(String).join(', '); }

function finish_(b) {
  const ref = s_(b.ref), wo = s_(b.wo);
  const job = readWO_().find(r => r.ref === ref && (!wo || r.wo === wo)) || {};
  const loc = job.loc || s_(b.loc), jobName = job.job || s_(b.job);
  const type = type_(jobName, ref);
  const t = SR[type] || SR.other;
  const p = parseLoc_(loc); p.job = jobName;
  const jf = jobFolder_(ref, wo);
  const docs = child_(jf.folder, SUB.docs);
  const photos = k => { const it = jf.folder.getFoldersByName(SUB[k]); return it.hasNext() ? images_(it.next()) : []; };
  const before = photos('before'), after = photos('after');
  const date = b.date ? new Date(b.date + 'T12:00:00') : new Date();

  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const img = id => { try { return thumb_(id, 900); } catch (e) { return ''; } };
  const fileImg = id => { try { const bl = DriveApp.getFileById(id).getBlob(); return 'data:' + bl.getContentType() + ';base64,' + Utilities.base64Encode(bl.getBytes()); } catch (e) { return ''; } };
  const cell = (k, v) => '<td class="k">' + k + '</td><td>' + esc(v) + '</td>';
  const notes = [t.notes, s_(b.notes)].filter(String).join(' ');
  const gallery = (title, list) => !list.length ? '' :
    '<div class="pb"></div><h2>' + title + '</h2><div class="g">' +
    list.map(ph => { const src = img(ph.id); return src ? '<div class="ph"><img src="' + src + '"><div class="cap">' + esc(ph.name.replace(/\.[a-z]+$/i, '')) + '</div></div>' : ''; }).join('') + '</div>';

  const html = '<html><head><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;color:#222;margin:0}' +
    '.hd{display:table;width:100%;margin-bottom:18px}.hd>div{display:table-cell;vertical-align:middle}' +
    '.logo img{height:62px}.title{background:#1f1f1f;color:#fff;text-align:right;padding:16px 18px;width:55%}' +
    '.title b{font-size:20pt;letter-spacing:.5px;display:block}.title span{color:#5fb89a;font-size:10pt}' +
    'h2{color:#2e7d64;font-size:12pt;margin:14px 0 5px;border-bottom:1px solid #2e7d64;padding-bottom:3px}' +
    'h3{color:#2e7d64;font-size:11pt;margin:12px 0 3px}p{margin:0 0 4px}ul{margin:2px 0 4px 18px;padding:0}li{margin:1px 0}' +
    'table{width:100%;border-collapse:collapse}td{border:1px solid #9bbcb0;padding:5px 7px;font-size:9.5pt}' +
    'td.k{background:#4a8f78;color:#fff;font-weight:bold;width:17%}' +
    '.so{border:1px solid #9bbcb0;width:45%;margin-top:14px}.so div{background:#4a8f78;color:#fff;font-weight:bold;padding:5px 8px}.so img{height:64px;margin:6px 8px}' +
    '.pb{page-break-before:always}.g{text-align:left}.ph{display:inline-block;width:47%;margin:0 2% 10px 0;vertical-align:top}' +
    '.ph img{width:100%;max-height:330px;object-fit:contain}.cap{font-size:8pt;color:#555}' +
    '</style></head><body>' +
    '<div class="hd"><div class="logo"><img src="' + fileImg(LOGO_ID) + '"></div><div class="title"><b>SERVICE REPORT</b><span>' + esc(t.title || jobName) + '</span></div></div>' +
    '<h2>Job Details</h2><table>' +
    '<tr>' + cell('Quote / Job No.', [ref, wo].filter(String).join(' / ')) + cell('Date', Utilities.formatDate(date, TZ, 'd MMMM yyyy')) + '</tr>' +
    '<tr>' + cell('Site', p.site) + cell('Building', p.building) + '</tr>' +
    '<tr>' + cell('Location', p.location) + cell('Asset(s)', p.asset || jobName) + '</tr>' +
    '<tr>' + cell('Technicians', s_(b.techs) || 'Jeffrey Park') + cell('Work Type', t.workType) + '</tr></table>' +
    '<h3>Description of Work</h3><p>' + esc(t.desc(p)) + '</p>' +
    '<h3>Findings</h3><p>' + esc(t.findings) + '</p>' +
    '<h3>Actions Completed</h3><ul>' + t.actions(b.materials || []).map(a => '<li>' + esc(a) + '</li>').join('') + '</ul>' +
    '<h3>Outcome</h3><p>' + esc(t.outcome) + '</p>' +
    '<h3>Notes</h3><p>' + esc(notes) + '</p>' +
    '<h3>Recommendations</h3><p>' + esc(t.recs) + '</p>' +
    '<div class="so"><div>Supervisor Sign-Off</div><img src="' + fileImg(SIGNOFF_ID) + '"></div>' +
    gallery('Before Photos', before) + gallery('After Photos', after) +
    '</body></html>';

  const name = ref + ' - SR.pdf';
  const old = docs.getFilesByName(name);
  while (old.hasNext()) { const o = old.next(); try { o.setTrashed(true); } catch (e) { o.setName(ref + ' - SR (old ' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm') + ').pdf'); } }
  const pdf = docs.createFile(Utilities.newBlob(html, 'text/html', 'sr.html').getAs('application/pdf').setName(name));
  foldersSheet_().getRange(jf.row, F.sr).setValue('✓');
  log_(b.by, 'Service report made', ref, wo, '', name, pdf.getId());
  return { ok: true, url: pdf.getUrl(), name: name, before: before.length, after: after.length };
}

/** Editor test: builds the SR for one job without the app. */
function testReport() { Logger.log(finish_({ ref: 'VP26150', wo: '501259087', techs: 'Jeffrey, Harrison & Stephan' })); }

/* ================= nightly photo tidy ================= */

/**
 * For photos put straight into Drive (not through the app): renames anything in a job's Before/After Photos folder
 * that isn't in the standard "VP26155 - HSB L4 - Before 3.jpg" form, and brings the photo counts on the Folders tab up to date.
 * Covers last month, this month and next month. Archived folders are left alone.
 */
function nightlySweep() {
  const started = Date.now();
  const now = new Date();
  const want = [-1, 0, 1].map(k => Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() + k, 1), TZ, 'yyyy-MM'));
  const index = foldersIndex_();
  const sheet = foldersSheet_();
  const seen = {};
  let renamed = 0, recounted = 0;
  for (const job of readWO_()) {
    if (want.indexOf(job.ym) < 0 || !job.ref || type_(job.job, job.ref) === 'sensors') continue;
    const f = findFolder_(index, job.ref, job.wo);
    if (!f || seen[f.row]) continue;
    seen[f.row] = true;
    if (Date.now() - started > 5 * 60 * 1000) { Logger.log('Stopped early (time limit); the rest is picked up next run'); break; }
    let folder;
    try { folder = DriveApp.getFolderById(idFromUrl_(f.url)); } catch (e) { continue; }
    for (const kind of ['before', 'after']) {
      const it = folder.getFoldersByName(SUB[kind]);
      if (!it.hasNext()) continue;
      const sub = it.next();
      const label = kind === 'after' ? 'After' : 'Before';
      const ok = new RegExp('^' + job.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b.*\\b(Before|After) \\d+', 'i');
      const loose = [];
      const files = sub.getFiles();
      while (files.hasNext()) {
        const x = files.next();
        if (/^image\//.test(x.getMimeType()) && !ok.test(x.getName())) loose.push(x);
      }
      loose.sort((a, b) => a.getDateCreated() - b.getDateCreated());
      for (const x of loose) {
        const ext = (x.getName().match(/\.(\w{2,4})$/) || [, 'jpg'])[1].toLowerCase();
        const n = nextNumber_(sub, label);
        const name = [job.ref, short_(job.loc), label + ' ' + n].filter(String).join(' - ').replace(/[\/\\:*?"<>|]/g, '-') + '.' + ext;
        x.setDescription('Original name: ' + x.getName());
        x.setName(name);
        renamed++;
      }
      const count = images_(sub).length;
      const col = kind === 'after' ? F.after : F.before;
      if (Number(sheet.getRange(f.row, col).getValue() || 0) !== count) { sheet.getRange(f.row, col).setValue(count); recounted++; }
    }
  }
  Logger.log('Photo tidy: ' + renamed + ' renamed, ' + recounted + ' counts fixed');
  return { renamed: renamed, recounted: recounted };
}

/** Run once (sheet menu Frontline > Turn on nightly photo tidy). Runs every night around 2am. */
function setupSweep() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'nightlySweep').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('nightlySweep').timeBased().atHour(2).everyDays(1).inTimezone(TZ).create();
  try { SpreadsheetApp.getUi().alert('Nightly photo tidy is on. It runs around 2am every night.'); } catch (e) { Logger.log('Nightly photo tidy is on'); }
}
