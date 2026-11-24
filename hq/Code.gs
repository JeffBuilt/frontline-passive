/**
 * HQ - one-screen revenue by company (Veridian / Frontline / Pulse), v2.0
 *
 * Standalone Apps Script project (same project as before). Deploy as a web app:
 *   Execute as "Me", Who has access "Anyone within Veridian Projects". Only the emails in ALLOWED get in.
 * Reads the WO tab of the Projects register, live. Nothing is written anywhere.
 * The page design comes from GitHub Pages (hq.html) so it can change without editing this script.
 *
 * Revenue month = the WO tab's Month column (when the work is done). Lost jobs are left out.
 * The old v1 (splits, materials, cash flow, invoice scanning) is in the repo under archive/v2/hq/Code.gs.
 */

const REGISTER_ID = '1i3U44wdBX_U6hZkELQZ1RbhmUk3D4d0Es4B8nfeuRgU';
const PAGE_URL = 'https://jeffbuilt.github.io/frontline-passive/hq.html';
const FIRST_YEAR = 2026;    // the WO tab's first month block is in this year
const MONTHS_BACK = 3, MONTHS_AHEAD = 12;   // 15 months: 3 behind, this month + 11 ahead
const PULSE_FLAT = 0;       // 0 = Pulse revenue from the register's sensor rows (AH_/FL_). Set e.g. 6000 to show a flat amount every month instead.
const TZ = 'Australia/Melbourne';
const ALLOWED = ['jeff@veridianprojects.com.au', 'admin@veridianprojects.com.au'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// WO columns (0-based). "PO Received" was added at G in Nov 2026.
const W = { ref: 0, loc: 2, job: 3, status: 5, price: 8, month: 11 };

function allowed_() {
  const me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  return ALLOWED.indexOf(me) >= 0 ? me : '';
}

function doGet(e) {
  if (!allowed_()) {
    const who = Session.getActiveUser().getEmail();
    return HtmlService.createHtmlOutput('<div style="font:18px system-ui;padding:40px;max-width:520px;margin:auto"><h2>Not available</h2><p>This dashboard is private.' +
      (who ? ' You are signed in as ' + who + '.' : '') + ' Ask Jeff for access.</p></div>').setTitle('Not available')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  let page = fetchPage_(e && e.parameter && e.parameter.refresh);
  page = page.replace('/*__DATA__*/null', JSON.stringify(getData()).replace(/</g, '\\u003c'));
  return HtmlService.createHtmlOutput(page).setTitle('HQ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function fetchPage_(fresh) {
  const cache = CacheService.getScriptCache();
  const hit = !fresh && cache.get('HQ2_PAGE');
  if (hit) return hit;
  const html = UrlFetchApp.fetch(PAGE_URL + '?v=' + Date.now(), { muteHttpExceptions: true }).getContentText();
  if (html.length < 90000) cache.put('HQ2_PAGE', html, 300);
  return html;
}

/** Called by doGet and the page's Refresh button. Always live (no data cache). */
function getData() {
  if (!allowed_()) throw new Error('Not available');
  const now = new Date();
  const ym = d => Utilities.formatDate(d, TZ, 'yyyy-MM');
  const thisYm = ym(now);
  const months = [];
  for (let k = -MONTHS_BACK; k < MONTHS_AHEAD; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    months.push({ ym: ym(d), Veridian: 0, Frontline: 0, Pulse: 0, jobs: 0 });
  }
  const byYm = {}; months.forEach(m => byYm[m.ym] = m);

  const rows = SpreadsheetApp.openById(REGISTER_ID).getSheetByName('WO').getDataRange().getDisplayValues();
  let year = FIRST_YEAR, last = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const mi = MONTHS.indexOf(String(r[W.month] || '').trim().toLowerCase());
    if (mi < 0) continue;
    if (last !== null && mi < last && last - mi > 5) year++;
    last = mi;
    const m = byYm[year + '-' + String(mi + 1).padStart(2, '0')];
    if (!m || /lost/i.test(r[W.status])) continue;
    const price = Number(String(r[W.price] || '').replace(/[^0-9.\-]/g, '')) || 0;
    if (!price) continue;
    const co = company_(r[W.job], r[W.ref]);
    if (co === 'Pulse' && PULSE_FLAT) continue;
    m[co] += price; m.jobs++;
  }
  if (PULSE_FLAT) months.forEach(m => { m.Pulse = PULSE_FLAT; });
  return { ok: true, built: new Date().toISOString(), thisYm: thisYm, pulseFlat: PULSE_FLAT, months: months };
}

function company_(job, ref) {
  const j = String(job || '');
  if (/^iot|sensor|pulse/i.test(j) || /^(AH|FL)_/i.test(String(ref || ''))) return 'Pulse';
  if (/passive|penetration|\bsit\b|interface|fire/i.test(j)) return 'Frontline';
  return 'Veridian';
}
