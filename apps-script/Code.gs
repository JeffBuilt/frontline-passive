/**
 * Frontline Compliance and Fire - passive fire backend (v1.7)
 * Bound to the "Passive Fire Master" Google Sheet (Extensions > Apps Script).
 * Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
 * Phones need a setup code (word + 4 digits) from addUser(); codes are stored only as SHA-256 hashes on the Users tab.
 * After pasting a new version: Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy.
 */

const SHEET = {
  pens: 'Penetrations', rates: 'Rates', access: 'Access', locations: 'Locations',
  settings: 'Settings', users: 'Users', pos: 'POs',
};

// Penetrations columns (1-based)
const C = {
  code: 1, scoutedAt: 2, scoutedBy: 3, site: 4, building: 5, level: 6, room: 7, location: 8,
  face: 9, type: 10, size: 11, product: 12, qty: 13, unit: 14, access: 15, loading: 16,
  extra: 17, price: 18, notes: 19, before: 20, after: 21, status: 22, month: 23, vp: 24,
  doneDate: 25, doneBy: 26, recordKey: 27, substrate: 28,
};
const NCOLS = 28;

const PRICE_EDITABLE = ['Scouted', 'Allocated'];
const OPEN_STATUSES = ['Allocated', 'Quoted', 'PO Received'];
const LOCKED = ['Invoiced'];

/* ================= web app ================= */

function doGet() {
  return json_({ ok: true, app: 'Frontline Compliance and Fire', time: new Date().toISOString() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  const user = checkKey_(body.key);
  if (!user) return json_({ ok: false, error: 'App key not recognised. Ask Jeff for a new setup code.' });
  try {
    switch (body.action) {
      case 'config': return json_(getConfig_(user));
      case 'submit': return json_(withLock_(() => submitPen_(user, body.record)));
      case 'complete': return json_(withLock_(() => completePen_(user, body.record)));
      case 'update': return json_(withLock_(() => updatePen_(user, body.record)));
      default: return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ================= auth ================= */

function checkKey_(key) {
  if (!key) return null;
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('KEY_FAILS') || 0);
  if (fails >= 50) return null; // too many wrong codes this hour: pause all logins briefly
  const hash = sha256_(String(key).trim().toLowerCase());
  const rows = rows_(SHEET.users);
  for (const r of rows) {
    if (String(r[2]) === hash && String(r[3]).toLowerCase() === 'yes') return { name: String(r[0]), email: String(r[1]) };
  }
  cache.put('KEY_FAILS', String(fails + 1), 3600);
  return null;
}

function sha256_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* ================= config ================= */

function getConfig_(user) {
  const settings = settings_();
  const rates = rows_(SHEET.rates)
    .filter(r => r[0] && String(r[4]).toLowerCase() !== 'no')
    .map(r => ({ type: String(r[0]), size: String(r[1]), product: String(r[2]), unit: Number(r[3]) || 0 }));
  const access = rows_(SHEET.access).filter(r => r[0])
    .map(r => ({ name: String(r[0]), loading: Number(r[1]) || 0, extra: Number(r[2]) || 0 }));
  const locations = rows_(SHEET.locations).filter(r => r[0])
    .map(r => ({ site: String(r[0]), building: String(r[1]), level: String(r[2]), room: String(r[3]), roomNo: Number(r[5]) || 0 }));
  const substrates = String(settings['Substrate options'] || 'Plasterboard, Block / brick, Concrete, Other')
    .split(',').map(s => s.trim()).filter(String);

  const records = rows_(SHEET.pens).filter(r => r[C.code - 1] && r[C.status - 1] !== 'Removed').map(recordOut_);

  const buildings = {};
  const bsh = SpreadsheetApp.getActive().getSheetByName('Buildings');
  if (bsh) bsh.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] && r[1]) (buildings[String(r[0])] = buildings[String(r[0])] || []).push(String(r[1]).trim());
  });

  return {
    ok: true, user: user.name, rates, access, locations, substrates, buildings,
    settings: { poMin: Number(settings['PO minimum ($ ex GST)']) || 2500, poMax: Number(settings['PO maximum ($ ex GST)']) || 3500, monthMin: Number(settings['Monthly target minimum ($ ex GST)']) || 12000 },
    records: records.slice(-3000),
    serverTime: new Date().toISOString(),
  };
}

function recordOut_(r) {
  const first = v => String(v || '').split('\n')[0];
  const d = v => (v instanceof Date ? v.toISOString() : String(v || ''));
  return {
    code: String(r[C.code - 1]), scoutedAt: d(r[C.scoutedAt - 1]), scoutedBy: String(r[C.scoutedBy - 1]),
    site: String(r[C.site - 1]), building: String(r[C.building - 1]), level: String(r[C.level - 1]), room: String(r[C.room - 1]),
    location: String(r[C.location - 1]), face: String(r[C.face - 1]), substrate: String(r[C.substrate - 1]),
    type: String(r[C.type - 1]), size: String(r[C.size - 1]), product: String(r[C.product - 1]),
    qty: Number(r[C.qty - 1]) || 1, unit: Number(r[C.unit - 1]) || 0, access: String(r[C.access - 1]),
    loading: Number(r[C.loading - 1]) || 0, extra: Number(r[C.extra - 1]) || 0, price: Number(r[C.price - 1]) || 0,
    notes: String(r[C.notes - 1]), status: String(r[C.status - 1]), month: String(r[C.month - 1]), vp: String(r[C.vp - 1]),
    doneDate: d(r[C.doneDate - 1]), doneBy: String(r[C.doneBy - 1]),
    before: first(r[C.before - 1]), after: first(r[C.after - 1]),
    beforeCount: String(r[C.before - 1] || '').split('\n').filter(String).length,
    afterCount: String(r[C.after - 1] || '').split('\n').filter(String).length,
  };
}

/* ================= new penetration (new or old work) ================= */

function submitPen_(user, rec) {
  if (!rec || !rec.recordKey || !rec.code) throw new Error('Missing record');
  const sh = sheet_(SHEET.pens);
  const byKey = findRow_(sh, C.recordKey, rec.recordKey);
  if (byKey) return { ok: true, code: sh.getRange(byKey, C.code).getValue(), duplicate: true };

  // Codes are made on the phone. If two phones made the same one, add a letter and flag it.
  let code = String(rec.code).toUpperCase();
  let changed = false;
  if (findRow_(sh, C.code, code)) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let i = 0; i < letters.length; i++) {
      if (!findRow_(sh, C.code, code + letters[i])) { code = code + letters[i]; changed = true; break; }
    }
  }

  const folder = locationFolder_(rec.site, rec.building, rec.level, rec.room);
  const before = savePhotos_(folder, code, 'before', rec.photos || []);
  const after = savePhotos_(folder, code, 'after', rec.afterPhotos || []);
  const old = rec.mode === 'old';

  const row = sh.getLastRow() + 1;
  const v = new Array(NCOLS).fill('');
  v[C.code - 1] = code;
  v[C.scoutedAt - 1] = rec.capturedAt ? new Date(rec.capturedAt) : new Date();
  v[C.scoutedBy - 1] = user.name;
  v[C.site - 1] = rec.site; v[C.building - 1] = rec.building; v[C.level - 1] = rec.level; v[C.room - 1] = rec.room;
  v[C.location - 1] = '=E' + row + '&" "&F' + row + '&" - "&G' + row;
  v[C.face - 1] = rec.face || ''; v[C.substrate - 1] = rec.substrate || '';
  v[C.type - 1] = rec.type; v[C.size - 1] = rec.size; v[C.product - 1] = rec.product;
  v[C.qty - 1] = Number(rec.qty) || 1; v[C.unit - 1] = Number(rec.unit) || 0;
  v[C.access - 1] = rec.access || ''; v[C.loading - 1] = Number(rec.loading) || 0; v[C.extra - 1] = Number(rec.extra) || 0;
  v[C.price - 1] = '=ROUND(M' + row + '*N' + row + '*(1+P' + row + ')+Q' + row + ',0)';
  v[C.notes - 1] = (changed ? 'Code changed from ' + rec.code + ' (duplicate). ' : '') + (rec.notes || '');
  v[C.before - 1] = before.join('\n'); v[C.after - 1] = after.join('\n');
  v[C.status - 1] = old ? 'Done' : 'Scouted';
  v[C.vp - 1] = old ? (rec.vp || '') : '';
  v[C.doneDate - 1] = old && rec.doneDate ? new Date(rec.doneDate) : '';
  v[C.doneBy - 1] = old ? (rec.doneBy || user.name) : '';
  v[C.recordKey - 1] = rec.recordKey;
  sh.getRange(row, 1, 1, NCOLS).setValues([v]);

  addLocationIfNew_(rec, user);
  return { ok: true, code: code, changed: changed };
}

/* ================= mark done ================= */

function completePen_(user, rec) {
  if (!rec || !rec.code) throw new Error('Missing penetration code');
  const sh = sheet_(SHEET.pens);
  const row = findRow_(sh, C.code, rec.code);
  if (!row) throw new Error('Penetration ' + rec.code + ' not found');
  const status = sh.getRange(row, C.status).getValue();
  if (status === 'Done' || status === 'Invoiced') return { ok: true, code: rec.code, duplicate: true };

  const r = sh.getRange(row, 1, 1, NCOLS).getValues()[0];
  const folder = locationFolder_(r[C.site - 1], r[C.building - 1], r[C.level - 1], r[C.room - 1]);
  const urls = savePhotos_(folder, rec.code, 'after', rec.photos || []);
  appendLines_(sh, row, C.after, urls);
  sh.getRange(row, C.status).setValue('Done');
  sh.getRange(row, C.doneDate).setValue(rec.capturedAt ? new Date(rec.capturedAt) : new Date());
  sh.getRange(row, C.doneBy).setValue(user.name);
  if (rec.notes) appendLines_(sh, row, C.notes, ['Done: ' + rec.notes]);
  queueReportIfComplete_(String(r[C.vp - 1]));
  return { ok: true, code: rec.code };
}

/* ================= automatic service reports ================= */

// When every penetration on a quote number is Done, build its report a minute later
// (in the background, so the phone's sync isn't held up).
function queueReportIfComplete_(vp) {
  if (!vp) return;
  const items = rows_(SHEET.pens).filter(r => String(r[C.vp - 1]) === vp && r[C.status - 1] !== 'Removed');
  if (!items.length || items.some(r => ['Done', 'Invoiced'].indexOf(String(r[C.status - 1])) < 0)) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('REPORT_' + vp)) return; // already built or queued
  props.setProperty('REPORT_' + vp, 'queued');
  const hasTrigger = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'runQueuedReports');
  if (!hasTrigger) ScriptApp.newTrigger('runQueuedReports').timeBased().after(60 * 1000).create();
}

function runQueuedReports() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runQueuedReports').forEach(t => ScriptApp.deleteTrigger(t));
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).filter(k => k.indexOf('REPORT_') === 0 && all[k] === 'queued').forEach(k => {
    const vp = k.slice(7);
    try {
      const out = buildReport(vp);
      props.setProperty(k, out.pdfUrl);
      recordReportLink_(vp, out.pdfUrl);
      notifyReport_(vp, out);
    } catch (err) {
      props.deleteProperty(k); // let it try again next time something on this job is marked done
      Logger.log('Report failed for ' + vp + ': ' + err);
    }
  });
}

function recordReportLink_(vp, url) {
  const sh = sheet_(SHEET.pos);
  if (sh.getRange(1, 10).getValue() !== 'Service Report') sh.getRange(1, 10).setValue('Service Report');
  const row = findRow_(sh, 4, vp);
  if (row) {
    sh.getRange(row, 10).setValue(url);
    if (['Allocated', 'Quoted', 'PO Received', ''].indexOf(String(sh.getRange(row, 7).getValue())) >= 0) sh.getRange(row, 7).setValue('Done');
  }
}

function notifyReport_(vp, out) {
  const to = String(settings_()['Report email'] || '').trim();
  if (!to) return;
  const loc = (rows_(SHEET.pens).find(r => String(r[C.vp - 1]) === vp) || [])[C.location - 1] || '';
  MailApp.sendEmail({
    to: to,
    subject: 'Service report ready: ' + vp + ' ' + loc,
    htmlBody: 'All penetrations on <b>' + vp + '</b> (' + loc + ') are marked done.<br><br>' +
      '<a href="' + out.pdfUrl + '">Open the PDF</a> &nbsp;|&nbsp; <a href="' + out.docUrl + '">Edit the Google Doc</a><br><br>' +
      'Check it, then send it with the invoice.',
  });
}

/* ================= edit after sync ================= */

function updatePen_(user, rec) {
  if (!rec || !rec.code) throw new Error('Missing penetration code');
  const sh = sheet_(SHEET.pens);
  const row = findRow_(sh, C.code, rec.code);
  if (!row) throw new Error('Penetration ' + rec.code + ' not found');
  const status = String(sh.getRange(row, C.status).getValue());
  if (LOCKED.indexOf(status) >= 0) throw new Error(rec.code + ' is invoiced and can only be changed in the sheet');

  if (rec.remove) {
    if (PRICE_EDITABLE.indexOf(status) < 0) throw new Error(rec.code + ' is ' + status + ' and can only be removed in the sheet');
    sh.getRange(row, C.status).setValue('Removed');
    appendLines_(sh, row, C.notes, ['Removed by ' + user.name + ' ' + Utilities.formatDate(new Date(), 'Australia/Melbourne', 'd/M/yy')]);
    return { ok: true, code: rec.code, removed: true };
  }

  const f = rec.fields || {};
  const set = (col, val) => { if (val !== undefined) sh.getRange(row, col).setValue(val); };
  set(C.face, f.face); set(C.substrate, f.substrate); set(C.notes, f.notes);
  if (PRICE_EDITABLE.indexOf(status) >= 0) {
    set(C.type, f.type); set(C.size, f.size); set(C.product, f.product);
    if (f.qty !== undefined) set(C.qty, Number(f.qty) || 1);
    if (f.unit !== undefined) set(C.unit, Number(f.unit) || 0);
    set(C.access, f.access);
    if (f.loading !== undefined) set(C.loading, Number(f.loading) || 0);
    if (f.extra !== undefined) set(C.extra, Number(f.extra) || 0);
  }
  if (status === 'Done') { set(C.vp, f.vp); if (f.doneDate) set(C.doneDate, new Date(f.doneDate)); }

  const r = sh.getRange(row, 1, 1, NCOLS).getValues()[0];
  const folder = locationFolder_(r[C.site - 1], r[C.building - 1], r[C.level - 1], r[C.room - 1]);
  if (rec.photos && rec.photos.length) appendLines_(sh, row, C.before, savePhotos_(folder, rec.code, 'before', rec.photos));
  if (rec.afterPhotos && rec.afterPhotos.length) appendLines_(sh, row, C.after, savePhotos_(folder, rec.code, 'after', rec.afterPhotos));
  return { ok: true, code: rec.code };
}

/* ================= service report ================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Passive Fire')
    .addItem('Plan POs for a month', 'planMonthPrompt')
    .addItem('Undo plan for a month', 'unplanMonthPrompt')
    .addSeparator()
    .addItem('Build service report for selected VP number', 'buildReportForSelection')
    .addToUi();
}

/* ================= monthly PO planning ================= */
/*
 * Rules (Jeff, 20 Nov 2026):
 * - One location (room) per PO. Rooms are never combined.
 * - Fill a PO up to the PO maximum (aim for the minimum or more). Anything left in that room stays
 *   Scouted and rolls into a later month.
 * - A small room is still its own PO. Keep adding POs until the month reaches the monthly minimum,
 *   without going over the monthly maximum.
 * - Use the site set for that month on the Monthly Plan tab. Oldest scouted work first,
 *   spread across different buildings and levels.
 */

function planMonthPrompt() {
  const ui = SpreadsheetApp.getUi();
  const next = nextUnplannedMonth_();
  const res = ui.prompt('Plan POs', 'Month to plan (YYYY-MM):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const month = res.getResponseText().trim() || next;
  const out = withLock_(() => planMonth(month));
  ui.alert('Planned ' + month, out.summary, ui.ButtonSet.OK);
}

function unplanMonthPrompt() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Undo plan', 'Month to undo (YYYY-MM). Only POs still at Allocated are undone:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const out = withLock_(() => unplanMonth(res.getResponseText().trim()));
  ui.alert('Undone', out.summary, ui.ButtonSet.OK);
}

function nextUnplannedMonth_() {
  const plan = rows_('Monthly Plan');
  const pos = rows_(SHEET.pos).map(r => String(r[0]));
  const hit = plan.find(r => r[0] && pos.indexOf(String(r[0])) < 0);
  return hit ? String(hit[0]) : '';
}

function planMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Month must look like 2027-01');
  const s = settings_();
  const planRow = rows_('Monthly Plan').find(r => String(r[0]) === month);
  if (!planRow) throw new Error(month + ' is not on the Monthly Plan tab');
  const opts = {
    site: String(planRow[1]),
    poMin: Number(s['PO minimum ($ ex GST)']) || 2500,
    poMax: Number(s['PO maximum ($ ex GST)']) || 3500,
    monthMin: Number(s['Monthly target minimum ($ ex GST)']) || 12000,
    monthMax: Number(s['Monthly target maximum ($ ex GST)']) || 13000,
    month: month,
  };

  const sh = sheet_(SHEET.pens);
  const data = sh.getDataRange().getValues();
  const pool = [];
  let already = 0;
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[C.code - 1]) continue;
    if (String(r[C.month - 1]) === month && r[C.status - 1] !== 'Removed') already += Number(r[C.price - 1]) || 0;
    if (r[C.status - 1] !== 'Scouted' || String(r[C.site - 1]) !== opts.site) continue;
    pool.push({ row: i + 1, code: String(r[C.code - 1]), building: String(r[C.building - 1]), level: String(r[C.level - 1]),
      room: String(r[C.room - 1]), location: String(r[C.location - 1]), price: Number(r[C.price - 1]) || 0,
      at: r[C.scoutedAt - 1] instanceof Date ? r[C.scoutedAt - 1].getTime() : 0 });
  }

  const posSh = sheet_(SHEET.pos);
  const existing = rows_(SHEET.pos).filter(r => String(r[0]) === month).length;
  const pos = bundle_(pool, opts, already, existing);

  pos.forEach(po => {
    po.items.forEach(it => {
      sh.getRange(it.row, C.month).setValue("'" + month);
      sh.getRange(it.row, C.vp).setValue(po.ref);
      sh.getRange(it.row, C.status).setValue('Allocated');
    });
    const row = posSh.getLastRow() + 1;
    posSh.getRange(row, 1, 1, 7).setValues([["'" + month, opts.site, po.location, po.ref,
      '=COUNTIFS(Penetrations!$X:$X,D' + row + ')', '=SUMIFS(Penetrations!$R:$R,Penetrations!$X:$X,D' + row + ')', 'Allocated']]);
  });

  const total = already + pos.reduce((a, p) => a + p.value, 0);
  const left = pool.length - pos.reduce((a, p) => a + p.items.length, 0);
  const lines = pos.map(p => p.ref + ': ' + p.location + ', ' + p.items.length + ' penetrations, $' + Math.round(p.value).toLocaleString());
  let summary = (lines.length ? lines.join('\n') : 'No new POs added.') + '\n\nMonth total: $' + Math.round(total).toLocaleString() +
    ' (target $' + opts.monthMin.toLocaleString() + '-$' + opts.monthMax.toLocaleString() + ').\n' + left + ' scouted ' + opts.site + ' penetrations left for later months.';
  if (total < opts.monthMin) summary += '\nShort of the target: scout more ' + opts.site + ' work, then run this again.';
  return { ok: true, pos: pos.map(p => ({ ref: p.ref, location: p.location, value: p.value, count: p.items.length })), total, summary };
}

// Pure bundling logic (no sheet access) so it can be tested on its own.
function bundle_(pool, opts, already, existingCount) {
  const groups = {};
  pool.slice().sort((a, b) => a.at - b.at).forEach(it => {
    const k = [it.building, it.level, it.room].join('|').toLowerCase();
    (groups[k] = groups[k] || { key: k, building: it.building, level: it.level, location: it.location, items: [], oldest: it.at }).items.push(it);
  });
  let remaining = Object.keys(groups).map(k => groups[k]).sort((a, b) => a.oldest - b.oldest);
  const out = [];
  let total = already || 0, n = existingCount || 0;
  const usedB = {}, usedL = {};
  while (total < opts.monthMin && remaining.length) {
    // spread: prefer a building not used yet this month, then a level not used yet, then the oldest
    const score = g => (usedB[g.building] ? 2 : 0) + (usedL[g.building + '|' + g.level] ? 1 : 0);
    remaining.sort((a, b) => score(a) - score(b) || a.oldest - b.oldest);
    const g = remaining.shift();
    const items = []; let value = 0;
    for (const it of g.items) {
      const fitsPo = value + it.price <= opts.poMax || items.length === 0;
      // stay under the monthly maximum, unless this PO hasn't reached the PO minimum yet
      const fitsMonth = total + value + it.price <= opts.monthMax || value < opts.poMin;
      if (fitsPo && fitsMonth) { items.push(it); value += it.price; }
      if (value >= opts.poMax) break;
    }
    if (!items.length) continue;
    n += 1;
    out.push({ ref: '', location: g.location, items, value });
    total += value;
    usedB[g.building] = true; usedL[g.building + '|' + g.level] = true;
  }
  out.forEach((p, i) => { p.ref = (opts.month || '') + ' PO' + String((existingCount || 0) + i + 1); });
  return out;
}

function unplanMonth(month) {
  const sh = sheet_(SHEET.pens);
  const data = sh.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][C.month - 1]) === month && data[i][C.status - 1] === 'Allocated') {
      sh.getRange(i + 1, C.month).setValue('');
      sh.getRange(i + 1, C.vp).setValue('');
      sh.getRange(i + 1, C.status).setValue('Scouted');
      n++;
    }
  }
  const posSh = sheet_(SHEET.pos);
  const pr = posSh.getDataRange().getValues();
  for (let i = pr.length - 1; i >= 1; i--) {
    if (String(pr[i][0]) === month && String(pr[i][6]) === 'Allocated') posSh.deleteRow(i + 1);
  }
  return { ok: true, summary: n + ' penetrations moved back to Scouted for ' + month + '.' };
}

function buildReportForSelection() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const row = sh.getActiveRange().getRow();
  let vp = '';
  if (sh.getName() === SHEET.pens) vp = String(sh.getRange(row, C.vp).getValue());
  else if (sh.getName() === SHEET.pos) vp = String(sh.getRange(row, 4).getValue());
  if (!vp) {
    const res = ui.prompt('Service report', 'VP number (e.g. VP270101):', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return;
    vp = res.getResponseText().trim();
  }
  const out = buildReport(vp);
  PropertiesService.getScriptProperties().setProperty('REPORT_' + vp, out.pdfUrl);
  recordReportLink_(vp, out.pdfUrl);
  ui.alert('Service report ready', out.pdfUrl, ui.ButtonSet.OK);
}

function buildReport(vp) {
  if (!vp) throw new Error('No VP number');
  const settings = settings_();
  const items = rows_(SHEET.pens).filter(r => String(r[C.vp - 1]) === vp && r[C.status - 1] !== 'Removed');
  if (!items.length) throw new Error('No penetrations found for ' + vp);
  const notDone = items.filter(r => ['Done', 'Invoiced'].indexOf(String(r[C.status - 1])) < 0);

  let ventiaRef = '';
  rows_(SHEET.pos).forEach(r => { if (String(r[3]) === vp) ventiaRef = String(r[7] || ''); });
  const month = String(items[0][C.month - 1] || 'Unallocated');
  const locations = [...new Set(items.map(r => String(r[C.location - 1])))];
  const fmt = d => (d instanceof Date ? Utilities.formatDate(d, 'Australia/Melbourne', 'd MMMM yyyy') : String(d || ''));
  const doneDates = items.map(r => r[C.doneDate - 1]).filter(d => d instanceof Date).sort((a, b) => a - b);

  const root = DriveApp.getFolderById(String(settings['Monthly POs folder ID']));
  const folder = childFolder_(root, month);
  const name = vp + ' Passive Fire Service Report - ' + locations[0] + (locations.length > 1 ? ' and others' : '');
  const doc = DocumentApp.create(name);
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  const body = doc.getBody();
  body.setMarginLeft(42).setMarginRight(42).setMarginTop(42).setMarginBottom(42);

  const logoId = String(settings['Logo file ID'] || '').trim();
  let logoDone = false;
  if (logoId) {
    try {
      const img = body.appendParagraph('').appendInlineImage(DriveApp.getFileById(logoId).getBlob());
      const w = 220; img.setHeight(Math.round(w * img.getHeight() / img.getWidth())).setWidth(w);
      logoDone = true;
    } catch (e) { /* fall back to the name */ }
  }
  if (!logoDone) body.appendParagraph(String(settings['Report company name'] || 'Frontline')).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('Passive Fire Penetration Sealing: Service Report').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  const meta = [
    ['Quote / job number', vp],
    ['Ventia work order', ventiaRef || '-'],
    ['Site', String(items[0][C.site - 1]) === 'Repat' ? 'Austin Health, Heidelberg Repatriation Hospital' : 'Austin Health, Austin Hospital'],
    ['Location(s)', locations.join('\n')],
    ['Works completed', doneDates.length ? fmt(doneDates[0]) + (doneDates.length > 1 && fmt(doneDates[doneDates.length - 1]) !== fmt(doneDates[0]) ? ' to ' + fmt(doneDates[doneDates.length - 1]) : '') : '-'],
    ['Penetrations', String(items.length)],
  ];
  const mt = body.appendTable(meta);
  mt.setBorderWidth(0);
  for (let i = 0; i < meta.length; i++) mt.getCell(i, 0).editAsText().setBold(true);

  if (notDone.length) {
    body.appendParagraph('Note: ' + notDone.length + ' penetration(s) under this job number are not yet marked as completed: ' +
      notDone.map(r => r[C.code - 1]).join(', ') + '.').editAsText().setForegroundColor('#c0392b');
  }

  body.appendParagraph('Penetration register').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  const reg = [['Code', 'Location', 'Face', 'Service', 'Treatment', 'Qty', 'Completed']];
  items.forEach(r => reg.push([
    String(r[C.code - 1]), String(r[C.location - 1]), String(r[C.face - 1]),
    String(r[C.type - 1]) + ', ' + String(r[C.size - 1]), String(r[C.product - 1]), String(r[C.qty - 1]), fmt(r[C.doneDate - 1]),
  ]));
  const rt = body.appendTable(reg);
  rt.getRow(0).editAsText().setBold(true);
  rt.editAsText().setFontSize(9);

  body.appendParagraph('Photographic record').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  items.forEach(r => {
    body.appendParagraph(String(r[C.code - 1]) + ': ' + String(r[C.location - 1]) + ', ' + String(r[C.face - 1]))
      .setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph(String(r[C.type - 1]) + ', ' + String(r[C.size - 1]) + '. Treatment: ' + String(r[C.product - 1]) +
      ' x ' + String(r[C.qty - 1]) + '.');
    const t = body.appendTable([['Before', 'After'], ['', '']]);
    t.getRow(0).editAsText().setBold(true);
    putImage_(t.getCell(1, 0), String(r[C.before - 1]).split('\n')[0]);
    putImage_(t.getCell(1, 1), String(r[C.after - 1]).split('\n')[0]);
  });

  body.appendParagraph('');
  body.appendParagraph('This report is a record of the works carried out by ' + String(settings['Report company name'] || 'Frontline Compliance and Fire') + ' at the locations listed and the ' +
    'photographs taken at the time. It is provided for information only and is subject to the terms of the quotation ' +
    'under which the works were performed.').editAsText().setFontSize(8).setForegroundColor('#677487');

  doc.saveAndClose();
  const pdf = folder.createFile(DriveApp.getFileById(doc.getId()).getAs('application/pdf').setName(name + '.pdf'));
  return { docUrl: doc.getUrl(), pdfUrl: pdf.getUrl() };
}

function putImage_(cell, url) {
  const id = fileIdFromUrl_(url);
  if (!id) { cell.setText('No photo'); return; }
  try {
    const img = cell.insertImage(0, DriveApp.getFileById(id).getBlob());
    const w = 240, ratio = img.getHeight() / img.getWidth();
    img.setWidth(w).setHeight(Math.round(w * ratio));
  } catch (e) { cell.setText('Photo unavailable'); }
}

function fileIdFromUrl_(url) {
  const m = String(url || '').match(/\/d\/([\w-]+)/) || String(url || '').match(/[?&]id=([\w-]+)/);
  return m ? m[1] : '';
}

/* ================= helpers ================= */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function rows_(name) { return sheet_(name).getDataRange().getValues().slice(1); }

function settings_() {
  const out = {};
  rows_(SHEET.settings).forEach(r => { if (r[0]) out[String(r[0])] = r[1]; });
  return out;
}

function findRow_(sh, col, value) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const vals = sh.getRange(2, col, last - 1, 1).getValues();
  const target = String(value).toUpperCase();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]).toUpperCase() === target) return i + 2;
  return 0;
}

function appendLines_(sh, row, col, lines) {
  if (!lines || !lines.length) return;
  const cur = String(sh.getRange(row, col).getValue() || '');
  sh.getRange(row, col).setValue((cur ? cur + '\n' : '') + lines.join('\n'));
}

function childFolder_(parent, name) {
  const clean = String(name || 'Unknown').replace(/[\/\\]/g, '-').trim() || 'Unknown';
  const it = parent.getFoldersByName(clean);
  return it.hasNext() ? it.next() : parent.createFolder(clean);
}

function locationFolder_(site, building, level, room) {
  const root = DriveApp.getFolderById(String(settings_()['Photos folder ID']));
  return childFolder_(childFolder_(childFolder_(root, site), building), level + ' - ' + room);
}

function savePhotos_(folder, code, kind, photos) {
  const urls = [];
  photos.forEach((p, i) => {
    const b64 = String(p).replace(/^data:image\/\w+;base64,/, '');
    const stamp = Utilities.formatDate(new Date(), 'Australia/Melbourne', 'yyMMdd-HHmmss');
    const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', code + '_' + kind + '_' + stamp + '_' + (i + 1) + '.jpg');
    urls.push(folder.createFile(blob).getUrl());
  });
  return urls;
}

function addLocationIfNew_(rec, user) {
  const sh = sheet_(SHEET.locations);
  const key = [rec.site, rec.building, rec.level, rec.room].map(s => String(s).trim().toLowerCase()).join('|');
  const exists = rows_(SHEET.locations).some(r =>
    [r[0], r[1], r[2], r[3]].map(s => String(s).trim().toLowerCase()).join('|') === key);
  if (!exists) sh.appendRow([rec.site, rec.building, rec.level, rec.room, user.name, Number(rec.roomNo) || '']);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= setup (run from the editor) ================= */

/**
 * Create an app login. Set NAME and EMAIL, select addUser, press Run.
 * The setup code appears in the Execution log. Run again for the same name to replace their code.
 */
function addUser() {
  const NAME = 'Jeff';
  const EMAIL = 'jeff@veridianprojects.com.au';

  const url = String(settings_()['Web app URL'] || '').trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    throw new Error('Paste the Web app URL (ends in /exec) into the Settings tab, row "Web app URL", then run addUser again.');
  }
  const WORDS = 'ant apple arrow aspen badge banjo basin bear bee birch bison blaze bolt brick cabin cargo cedar chalk cod comet coral crane creek crow dawn deer delta denim dingo dove drift duck eagle echo elk ember emu fern fig flint fox frog galah gecko grove gull gum hare hawk hazel heron honey husky iron ivory ivy jay jetty kayak kelp kite kiwi koala lark laser lemon lilac lime lion lotus lynx mango maple mesa mint moose moss moth nova oak ocean olive onyx opal orbit orca otter owl panda pine pixel plum polar puma quill radar ram raven ray reef ridge river robin ruby sage scout seal shark slate stone storm swan swift tango tiger toad topaz torch tulip turbo umber wolf wren yak yarra zinc'.split(' ');
  const key = WORDS[Math.floor(Math.random() * WORDS.length)] + String(1000 + Math.floor(Math.random() * 9000));
  const sh = sheet_(SHEET.users);
  const data = sh.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < data.length; i++) if (String(data[i][0]).toLowerCase() === NAME.toLowerCase()) { row = i + 1; break; }
  const values = [[NAME, EMAIL, sha256_(key), 'Yes', new Date()]];
  if (row > 0) sh.getRange(row, 1, 1, 5).setValues(values); else sh.appendRow(values[0]);

  Logger.log('Setup code for ' + NAME + ': ' + key);
}

/** Run once from the editor to approve Drive, Docs and Sheets permissions. */
function authorise() {
  DriveApp.getFolderById(String(settings_()['Photos folder ID'])).getName();
  DocumentApp.getActiveDocument; // Docs scope for service reports
  ScriptApp.getProjectTriggers(); // lets reports build in the background
  MailApp.getRemainingDailyQuota(); // report-ready emails
  Logger.log('Authorised.');
}
