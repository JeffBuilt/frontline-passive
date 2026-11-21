/**
 * Veridian + Frontline - business dashboard (HQ) v1.0
 *
 * A private web app: deploy as Execute as "Me", Who has access "Only myself".
 * Google sign-in is the login. It only READS the Projects register and the Frontline master sheet.
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
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function doGet(e) {
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
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('HQ_DATA');
    if (hit) return JSON.parse(hit);
  } else cache.remove('HQ_PAGE');
  const out = {
    ok: true, built: new Date().toISOString(), today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), payDays: PAY_DAYS,
    jobs: readRegister_(), cash: readPaymentBatches_(), frontline: readFrontline_(), rules: readRules_(),
  };
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
  flat: { 'IoT sensors': 6000 },  // flat profit per month when there is sensor income that month
  pct: {                          // profit as % of revenue
    'Passive fire': 75,           // minus 10% overhead, minus 15% material
    'Air filters': 75,            // minus 25% material
    'SIT': 60,
    'Fire repairs': 75, 'Mechanical repairs': 75, 'Inspections and reports': 75, 'Kitchen': 75, 'Water filters': 75, 'Projects': 75,
  },
  notes: { 'Passive fire': 'minus 10% overhead, minus 15% material', 'Air filters': 'minus 25% material', 'IoT sensors': 'flat per month', 'SIT': 'about 60%' },
  split: [{ name: 'Jeff', pct: 50 }, { name: 'Dan', pct: 50 }],
};

function readRules_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('PROFIT_RULES');
    if (!raw) return DEFAULT_RULES;
    const r = JSON.parse(raw);
    return { flat: Object.assign({}, DEFAULT_RULES.flat, r.flat), pct: Object.assign({}, DEFAULT_RULES.pct, r.pct), notes: Object.assign({}, DEFAULT_RULES.notes, r.notes), split: r.split || DEFAULT_RULES.split };
  } catch (e) { return DEFAULT_RULES; }
}

/** Called from the dashboard's Profit rules panel. */
function saveRules(r) {
  const clean = { flat: {}, pct: {}, notes: (r && r.notes) || {}, split: [] };
  Object.keys((r && r.flat) || {}).forEach(k => { clean.flat[k] = Math.max(0, num_(r.flat[k])); });
  Object.keys((r && r.pct) || {}).forEach(k => { clean.pct[k] = Math.max(0, Math.min(100, num_(r.pct[k]))); });
  ((r && r.split) || []).forEach(p => { if (p && p.name) clean.split.push({ name: String(p.name).slice(0, 30), pct: Math.max(0, Math.min(100, num_(p.pct))) }); });
  if (!clean.split.length) clean.split = DEFAULT_RULES.split;
  PropertiesService.getScriptProperties().setProperty('PROFIT_RULES', JSON.stringify(clean));
  CacheService.getScriptCache().remove('HQ_DATA');
  return readRules_();
}

/** Run once from the editor to approve access (Sheets, fetching the page). */
function authorise() {
  getData(true);
  fetchPage_();
}
