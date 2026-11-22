/**
 * Veridian + Frontline - business dashboard (HQ) v1.0
 *
 * A private web app: deploy as Execute as "Me", Who has access "Anyone within Veridian Projects".
 * Google sign-in is the login, and only the emails in ALLOWED get in. It only READS the Projects register and the Frontline master sheet.
 *
 * The page design is fetched from GitHub Pages (hq.html) so it can be updated without editing this script.
 * The numbers are worked out here and handed to the page.
 */

const REGISTER_ID = '1i3U44wdBX_U6hZkELQZ1RbhmUk3D4d0Es4B8nfeuRgU'; // Projects 2026 Project/Quote List (admin@)
const MASTER_ID = '1NIoah5dnH3XCKl-8XCBvQVFsdwuO0moIaJGkC-sQKm0';   // Passive Fire Master (Frontline app)
const PAGE_URL = 'https://jeffbuilt.github.io/frontline-passive/hq.html';
const FIRST_YEAR = 2026;      // the register's first month block is in this year
const PAY_DAYS = 45;          // payment terms: end of month + 45 days
const TZ = 'Australia/Melbourne';
const ALLOWED = ['jeff@veridianprojects.com.au', 'admin@veridianprojects.com.au']; // who can open the dashboard

function allowed_() {
  const me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  return ALLOWED.indexOf(me) >= 0 ? me : '';
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function doGet(e) {
  if (!allowed_()) {
    const who = Session.getActiveUser().getEmail();
    return HtmlService.createHtmlOutput('<div style="font:18px system-ui;padding:40px;max-width:520px;margin:auto"><h2>Not available</h2><p>This dashboard is private.' +
      (who ? ' You are signed in as ' + who + '.' : '') + ' Ask Jeff for access.</p></div>').setTitle('Not available')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const fresh = e && e.parameter && e.parameter.refresh;
  const data = getData(!!fresh);
  let page = fetchPage_();
  page = page.replace('/*__DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
  return HtmlService.createHtmlOutput(page)
    .setTitle('Veridian + Frontline dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function fetchPage_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('HQ_PAGE');
  if (hit) return hit;
  const html = UrlFetchApp.fetch(PAGE_URL + '?v=' + Date.now(), { muteHttpExceptions: true }).getContentText();
  if (html.length < 90000) cache.put('HQ_PAGE', html, 300);
  return html;
}

/** Called by the page's Refresh button (google.script.run) and by doGet. */
function getData(fresh) {
  if (!allowed_()) throw new Error('Not available');
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('HQ_DATA');
    if (hit) return JSON.parse(hit);
  } else cache.remove('HQ_PAGE');
  const out = {
    ok: true, built: new Date().toISOString(), today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), payDays: PAY_DAYS,
    jobs: readRegister_(), cash: readPaymentBatches_(), frontline: readFrontline_(), rules: readRules_(),
  };
  try { if (fresh) scanInvoices(5); out.materials = materialsInfo_(); } catch (e) { out.materials = { items: [], error: String(e) }; }
  const s = JSON.stringify(out);
  if (s.length < 95000) cache.put('HQ_DATA', s, 300);
  return out;
}

/* ---------------- helpers ---------------- */

const num_ = v => Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;
const ym_ = (y, m) => y + '-' + String(m).padStart(2, '0');
function eomPlus_(y, m, days) { // end of month (y, m 1-12) + days -> yyyy-mm-dd
  const d = new Date(y, m, 0); // last day of month m
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function business_(job, loc) {
  const t = job + ' ' + loc;
  if (/\biot\b|sensor|pulse/i.test(t)) return 'Pulse';
  if (/passive|penetration|\bfire\b|fire repair|\bsit\b|interface test/i.test(t)) return 'Frontline';
  return 'Veridian';
}
function category_(job) {
  const j = String(job || '').toLowerCase();
  if (/passive|penetration/.test(j)) return 'Passive fire';
  if (/\bsit\b|interface/.test(j)) return 'SIT';
  if (/fire/.test(j)) return 'Fire repairs';
  if (/water filter/.test(j)) return 'Water filters';
  if (/filter/.test(j)) return 'Air filters';
  if (/iot|sensor/.test(j)) return 'IoT sensors';
  if (/investigate|report|inspect|assess/.test(j)) return 'Inspections and reports';
  if (/kitchen|canopy/.test(j)) return 'Kitchen';
  if (/carpark|refurb|referb|modification|project/.test(j)) return 'Projects';
  return 'Mechanical repairs';
}
function site_(loc) {
  const l = String(loc || '').toLowerCase();
  if (/florey/.test(l)) return 'Florey';
  if (/repat|\bnw\b|\bcent\b|\bcpu\b|coral|heidelberg repat/.test(l)) return 'Repat';
  if (/remote|subscription/.test(l)) return 'Remote';
  if (/austin|\bat\b|\bhsb\b|\bltb\b|\bonj\b|kitchen|tower/.test(l) || l) return 'Austin';
  return 'Unassigned';
}
function stage_(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid') return 'paid';
  if (/invoice/.test(s)) return 'invoiced';
  if (/complete/.test(s) && !/incomplete/.test(s)) return 'done';
  if (/incomplete/.test(s)) return 'approved';
  if (/quote sent|waiting on wo/.test(s)) return 'quoted';
  if (/rfq/.test(s)) return 'rfq';
  if (/lost/.test(s)) return 'lost';
  return 'planned'; // Project Pending, blank
}

/* ---------------- Projects register: WO tab ---------------- */

function readRegister_() {
  const sh = SpreadsheetApp.openById(REGISTER_ID).getSheetByName('WO');
  const rows = sh.getDataRange().getDisplayValues();
  let year = FIRST_YEAR, last = null;
  const jobs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const mi = MONTHS.indexOf(String(r[10] || '').trim().toLowerCase());
    if (mi < 0) continue;
    if (last !== null && mi < last && last - mi > 5) year++;
    last = mi;
    const price = num_(r[7]);
    const job = String(r[3] || '').trim(), loc = String(r[2] || '').trim();
    if (!price && !job) continue;
    const stage = stage_(r[5]);
    // invoice date from the IPRO column (d/m), else the end of the work month
    let inv = null;
    const m = String(r[6] || '').match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (m) {
      let iy = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
      if (!m[3] && Number(m[2]) - 1 - mi > 6) iy--; else if (!m[3] && mi - (Number(m[2]) - 1) > 6) iy++;
      inv = { y: iy, m: Number(m[2]), d: Number(m[1]) };
    }
    const due = inv ? eomPlus_(inv.y, inv.m, PAY_DAYS) : eomPlus_(year, mi + 1, PAY_DAYS);
    jobs.push({
      row: i + 1, ref: String(r[0] || '').trim(), wo: String(r[1] || '').trim(), loc: loc, job: job,
      contractor: String(r[4] || '').trim(), status: String(r[5] || '').trim() || 'Project Pending', stage: stage,
      price: price, month: ym_(year, mi + 1), invoiced: inv ? Utilities.formatDate(new Date(inv.y, inv.m - 1, inv.d), TZ, 'yyyy-MM-dd') : '',
      due: due, dueKnown: !!inv, business: business_(job, loc), category: category_(job), site: site_(loc),
      notes: String(r[9] || '').trim(), placeholder: /approx/i.test(String(r[9] || '')) || (!loc && !!job),
    });
  }
  return jobs;
}

/* ---------------- Projects register: PB tab (payment batches) ---------------- */

function readPaymentBatches_() {
  const sh = SpreadsheetApp.openById(REGISTER_ID).getSheetByName('PB');
  if (!sh) return [];
  const rows = sh.getDataRange().getDisplayValues();
  const out = [];
  let received = null, lastMi = null, year = FIRST_YEAR;
  for (const r of rows) {
    const a = String(r[0] || '');
    const h = a.match(/received in\s+([a-z]+)/i);
    if (h) {
      const mi = MONTHS.indexOf(h[1].toLowerCase());
      if (mi >= 0) {
        if (lastMi !== null && mi < lastMi && lastMi - mi > 5) year++;
        lastMi = mi;
        received = ym_(year, mi + 1);
      }
      continue;
    }
    const ref = String(r[1] || '').trim(), amt = num_(r[3]);
    if (!received || !ref || !amt || !/\d{5,}/.test(String(r[0] || '')) || /reference|total/i.test(ref)) continue;
    const pct = num_(r[5]);
    const ded = pct ? amt * pct / 100 : num_(r[6]);
    out.push({ ref: ref.split(' ')[0], month: received, amount: amt, deduction: Math.round(ded), net: Math.round(amt - ded), type: String(r[4] || '') });
  }
  return out;
}

/* ---------------- Frontline master: work in the bank (not yet on a PO) ---------------- */

function readFrontline_() {
  try {
    const ss = SpreadsheetApp.openById(MASTER_ID);
    const pens = ss.getSheetByName('Penetrations').getDataRange().getValues().slice(1);
    let bank = 0, bankN = 0, requested = 0;
    pens.forEach(r => {
      if (!r[0]) return;
      if (r[21] === 'Scouted') { bank += Number(r[17]) || 0; bankN++; }
      if (r[21] === 'Requested') requested++;
    });
    const rep = ss.getSheetByName('Repairs');
    let repOpen = 0;
    if (rep) rep.getDataRange().getValues().slice(1).forEach(r => { if (r[0] && ['Quoted', 'PO Received'].indexOf(r[12]) >= 0) repOpen += Number(r[11]) || 0; });
    return { bank: bank, bankN: bankN, requested: requested, repairsOpen: repOpen };
  } catch (e) { return { bank: 0, bankN: 0, requested: 0, repairsOpen: 0, error: String(e) }; }
}

/* ---------------- profit rules (editable from the dashboard) ---------------- */

const DEFAULT_RULES = {
  oh: 10,                          // % of the gross invoice transferred to overheads
  pb: 10,                          // Ventia PB deduction % when the payment batch isn't known yet
  flat: { 'IoT sensors': 6000 },   // recurring contract: flat amount left to split per month
  mat: {                           // estimated materials as % of the job, used until real supplier costs are entered
    'Passive fire': 15, 'Air filters': 25, 'Water filters': 25, 'SIT': 30,
    'Fire repairs': 15, 'Mechanical repairs': 15, 'Inspections and reports': 5, 'Kitchen': 15, 'Projects': 15,
  },
  notes: { 'Passive fire': 'estimate until invoices are in', 'Air filters': 'estimate until invoices are in', 'IoT sensors': '$3k each a month', 'SIT': 'gives about 60% profit' },
  split: [{ name: 'Jeff', pct: 50 }, { name: 'Dan', pct: 50 }],
};

function readRules_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('RULES_V2');
    if (!raw) return DEFAULT_RULES;
    const r = JSON.parse(raw);
    return {
      oh: r.oh != null ? r.oh : DEFAULT_RULES.oh, pb: r.pb != null ? r.pb : DEFAULT_RULES.pb,
      flat: Object.assign({}, DEFAULT_RULES.flat, r.flat), mat: Object.assign({}, DEFAULT_RULES.mat, r.mat),
      notes: Object.assign({}, DEFAULT_RULES.notes, r.notes), split: r.split || DEFAULT_RULES.split,
    };
  } catch (e) { return DEFAULT_RULES; }
}

/** Called from the dashboard's Rules panel. */
function saveRules(r) {
  if (!allowed_()) throw new Error('Not available');
  const pct = v => Math.max(0, Math.min(100, num_(v)));
  const clean = { oh: pct(r && r.oh), pb: pct(r && r.pb), flat: {}, mat: {}, notes: (r && r.notes) || {}, split: [] };
  Object.keys((r && r.flat) || {}).forEach(k => { clean.flat[k] = Math.max(0, num_(r.flat[k])); });
  Object.keys((r && r.mat) || {}).forEach(k => { clean.mat[k] = pct(r.mat[k]); });
  ((r && r.split) || []).forEach(p => { if (p && p.name) clean.split.push({ name: String(p.name).slice(0, 30), pct: pct(p.pct) }); });
  if (!clean.split.length) clean.split = DEFAULT_RULES.split;
  PropertiesService.getScriptProperties().setProperty('RULES_V2', JSON.stringify(clean));
  CacheService.getScriptCache().remove('HQ_DATA');
  return readRules_();
}

/* ---------------- materials: sheet, Drive folder, invoice reading ---------------- */

const SHARE_WITH = ['admin@veridianprojects.com.au'];
const MAT_HEADERS = ['Date', 'Job ref', 'Supplier', 'Amount ex GST', 'Status', 'File', 'File ID', 'Notes', 'Added by', 'Added at'];

function prop_(k, v) { const p = PropertiesService.getScriptProperties(); if (v === undefined) return p.getProperty(k); p.setProperty(k, v); return v; }
function shareEdit_(item) { SHARE_WITH.forEach(e => { try { item.addEditor(e); } catch (err) {} }); }

function hqFolder_() {
  let id = prop_('HQ_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Veridian HQ');
  shareEdit_(f);
  prop_('HQ_FOLDER_ID', f.getId());
  return f;
}
function invoiceFolder_() {
  let id = prop_('INV_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = hqFolder_().createFolder('Supplier invoices');
  shareEdit_(f);
  prop_('INV_FOLDER_ID', f.getId());
  return f;
}
function matSheet_() {
  let id = prop_('MAT_SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id).getSheets()[0]; } catch (e) {} }
  const ss = SpreadsheetApp.create('Veridian HQ - Materials');
  const sh = ss.getSheets()[0];
  sh.setName('Materials');
  sh.getRange(1, 1, 1, MAT_HEADERS.length).setValues([MAT_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(hqFolder_());
  shareEdit_(file);
  prop_('MAT_SHEET_ID', ss.getId());
  return sh;
}

function readMaterials_() {
  const sh = matSheet_();
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] && !r[3] && !r[6]) continue;
    out.push({
      row: i + 1, date: r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0] || ''),
      ref: String(r[1] || '').trim(), supplier: String(r[2] || ''), amount: num_(r[3]), status: String(r[4] || 'OK'),
      file: String(r[5] || ''), notes: String(r[7] || ''), by: String(r[8] || ''),
    });
  }
  return out;
}

function materialsInfo_() {
  return { items: readMaterials_(), sheetUrl: SpreadsheetApp.openById(prop_('MAT_SHEET_ID')).getUrl(), folderUrl: invoiceFolder_().getUrl() };
}

/** Reads text from a PDF or photo by letting Drive OCR it into a temporary Google Doc. Needs the Drive advanced service. */
function ocrText_(file) {
  try {
    const tmp = Drive.Files.copy({ name: 'hq-ocr-tmp', mimeType: 'application/vnd.google-apps.document' }, file.getId(), { ocrLanguage: 'en' });
    const text = DocumentApp.openById(tmp.id).getBody().getText();
    DriveApp.getFileById(tmp.id).setTrashed(true);
    return text;
  } catch (e) { return ''; }
}

function parseInvoice_(text, name) {
  const t = String(text || ''), all = t + ' ' + name;
  const ref = (all.match(/\b(VP\d{5}|VENT\d{3}|VP[0-9]{2}[0-9]{3})\b/i) || [])[1] || '';
  const money = s => num_(String(s).replace(/,/g, ''));
  let ex = 0;
  const lines = t.split(/\n/);
  const findAfter = re => { for (const l of lines) { if (re.test(l)) { const m = l.match(/\$?\s*([0-9][0-9,]*\.\d{2})/g); if (m) return money(m[m.length - 1]); } } return 0; };
  ex = findAfter(/sub\s*-?total|total\s*(ex|excl|excluding)/i);
  if (!ex) { const inc = findAfter(/total\s*(inc|incl|including)?|amount\s*due|balance\s*due/i); if (inc) ex = Math.round(inc / 1.1 * 100) / 100; }
  if (!ex) { const m = t.match(/\$\s*([0-9][0-9,]*\.\d{2})/g); if (m) ex = Math.round(Math.max.apply(null, m.map(money)) / 1.1 * 100) / 100; }
  const d = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  let date = '';
  if (d) { const y = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]); date = y + '-' + String(d[2]).padStart(2, '0') + '-' + String(d[1]).padStart(2, '0'); }
  const firstLine = (lines.find(l => l.trim().length > 2) || '').trim();
  const supplier = (firstLine && !/tax invoice|invoice/i.test(firstLine) ? firstLine : name.replace(/\.[a-z0-9]+$/i, '')).slice(0, 60);
  return { ref: ref.toUpperCase(), amount: ex, date: date, supplier: supplier };
}

/** Looks for new files in the Supplier invoices folder and adds them to the sheet as "Check". */
function scanInvoices(limit) {
  const sh = matSheet_();
  const known = {};
  sh.getDataRange().getValues().slice(1).forEach(r => { if (r[6]) known[String(r[6])] = 1; });
  const it = invoiceFolder_().getFiles();
  let n = 0;
  while (it.hasNext() && n < (limit || 15)) {
    const f = it.next();
    if (known[f.getId()]) continue;
    const mt = f.getMimeType();
    if (!/pdf|image\//.test(mt)) continue;
    const p = parseInvoice_(ocrText_(f), f.getName());
    sh.appendRow([p.date ? new Date(p.date) : f.getDateCreated(), p.ref, p.supplier, p.amount || '', 'Check', f.getUrl(), f.getId(), 'Read from the invoice. Check the job and amount.', 'Folder', new Date()]);
    n++;
  }
  if (n) CacheService.getScriptCache().remove('HQ_DATA');
  return n;
}

/** "Add material" from the dashboard: optional receipt photo or PDF, one or more job lines. */
function addMaterial(m) {
  const who = allowed_();
  if (!who) throw new Error('Not available');
  const lines = ((m && m.lines) || []).filter(l => num_(l.amount) > 0);
  if (!lines.length) throw new Error('Enter an amount');
  const sh = matSheet_();
  let url = '', id = '';
  if (m.file && m.file.data) {
    const bytes = Utilities.base64Decode(String(m.file.data).split(',').pop());
    const blob = Utilities.newBlob(bytes, m.file.type || 'image/jpeg', (m.supplier || 'receipt') + ' ' + (m.date || '') + (/pdf/.test(m.file.type) ? '.pdf' : '.jpg'));
    const f = invoiceFolder_().createFile(blob);
    url = f.getUrl(); id = f.getId();
  }
  lines.forEach((l, i) => sh.appendRow([m.date ? new Date(m.date) : new Date(), String(l.ref || '').toUpperCase(), String(m.supplier || ''), num_(l.amount), 'OK', url, i === 0 ? id : '', String(m.notes || ''), who, new Date()]));
  CacheService.getScriptCache().remove('HQ_DATA');
  return materialsInfo_();
}

/** Confirm, fix or ignore a row from the dashboard. */
function updateMaterial(u) {
  if (!allowed_()) throw new Error('Not available');
  const sh = matSheet_();
  const row = Number(u && u.row);
  if (!row || row < 2 || row > sh.getLastRow()) throw new Error('Row not found');
  if (u.ref !== undefined) sh.getRange(row, 2).setValue(String(u.ref).toUpperCase());
  if (u.supplier !== undefined) sh.getRange(row, 3).setValue(String(u.supplier));
  if (u.amount !== undefined) sh.getRange(row, 4).setValue(num_(u.amount));
  if (u.status) sh.getRange(row, 5).setValue(u.status === 'Ignore' ? 'Ignore' : 'OK');
  CacheService.getScriptCache().remove('HQ_DATA');
  return materialsInfo_();
}

function ensureTrigger_() {
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'hourlyScan')) {
    ScriptApp.newTrigger('hourlyScan').timeBased().everyHours(1).create();
  }
}
function hourlyScan() { scanInvoices(15); }

/** Run once from the editor to approve access (Sheets, fetching the page). */
function authorise() {
  matSheet_(); invoiceFolder_(); ensureTrigger_();
  getData(true);
  fetchPage_();
}
