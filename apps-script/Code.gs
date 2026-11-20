/**
 * Frontline Compliance and Fire - backend (v2.0): passive fire, fire repairs, SIT, back office
 * Bound to the "Passive Fire Master" Google Sheet (Extensions > Apps Script).
 * Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
 * Phones need a setup code (word + 4 digits) from addUser() (staff) or addClient() (clients).
 * Codes are stored only as SHA-256 hashes on the Users tab. Column F = Role (staff / client), G = Company.
 * Clients can only log penetrations (status Requested) and see their own requests. They never see prices.
 * After pasting a new version: Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy.
 */

const SHEET = {
  pens: 'Penetrations', rates: 'Rates', access: 'Access', locations: 'Locations',
  settings: 'Settings', users: 'Users', pos: 'POs', repairs: 'Repairs', sit: 'SIT',
};

// Penetrations columns (1-based)
const C = {
  code: 1, scoutedAt: 2, scoutedBy: 3, site: 4, building: 5, level: 6, room: 7, location: 8,
  face: 9, type: 10, size: 11, product: 12, qty: 13, unit: 14, access: 15, loading: 16,
  extra: 17, price: 18, notes: 19, before: 20, after: 21, status: 22, month: 23, vp: 24,
  doneDate: 25, doneBy: 26, recordKey: 27, substrate: 28, clientType: 29,
};
const NCOLS = 29;

const PRICE_EDITABLE = ['Requested', 'Scouted', 'Allocated'];
const DEFAULT_CLIENT_TYPES = 'Cables, Cable tray, Metal pipe, Plastic pipe, Lagged pipe, Duct, Conduit, Mixed services, Other';
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
    migrate_();
    const P = user.perms, a = body.action;
    const need = ok => { if (!ok) throw new Error('Your login does not have access to that. Ask Jeff.'); };
    switch (a) {
      case 'config': return json_(getConfig_(user));
      // passive fire
      case 'submit': case 'complete': case 'update': need(P.passive === 'full');
        return json_(withLock_(() => a === 'submit' ? submitPen_(user, body.record) : a === 'complete' ? completePen_(user, body.record) : updatePen_(user, body.record)));
      case 'request': need(P.passive !== 'none'); return json_(withLock_(() => requestPen_(user, body.record)));
      // fire repairs
      case 'repairLog': need(P.repairs !== 'none'); return json_(withLock_(() => repairLog_(user, body.record)));
      case 'repairUpdate': need(P.repairs === 'full'); return json_(withLock_(() => repairUpdate_(user, body.record)));
      case 'repairDone': need(P.repairs === 'full'); return json_(withLock_(() => repairDone_(user, body.record)));
      // SIT
      case 'sitSave': need(P.sit === 'edit'); return json_(withLock_(() => sitSave_(user, body.record)));
      // back office
      case 'dashboard': need(P.dashboard); return json_(dashboard_(user, body.site || ''));
      case 'plan': need(P.admin); return json_(withLock_(() => { dropDashCache_(); return planMonth(body.month || nextUnplannedMonth_()); }));
      case 'unplan': need(P.admin); return json_(withLock_(() => { dropDashCache_(); return unplanMonth(body.month); }));
      case 'users': need(P.admin); return json_(listUsers_());
      case 'userSave': need(P.admin); return json_(withLock_(() => saveUser_(user, body.user || {})));
      case 'userReset': need(P.admin); return json_(withLock_(() => resetUser_(body.name)));
      case 'locResolve': need(P.admin); return json_(withLock_(() => locResolve_(user, body.from, body.to, body.buildingName)));
      case 'buildingSave': need(P.admin); return json_(withLock_(() => buildingSave_(body.site, body.code, body.name)));
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
    if (String(r[2]) === hash && String(r[3]).toLowerCase() === 'yes') return userFromRow_(r);
  }
  cache.put('KEY_FAILS', String(fails + 1), 3600);
  return null;
}

function sha256_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* ================= config ================= */

function getPassiveFullConfig_(user) {
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

  const records = rows_(SHEET.pens).filter(r => r[C.code - 1] && r[C.status - 1] !== 'Removed' && siteOk_(user, r[C.site - 1])).map(recordOut_);

  const buildings = {};
  const bsh = SpreadsheetApp.getActive().getSheetByName('Buildings');
  if (bsh) bsh.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] && r[1]) (buildings[String(r[0])] = buildings[String(r[0])] || []).push(String(r[1]).trim());
  });

  return {
    ok: true, role: 'staff', user: user.name, rates, access, locations, substrates, buildings,
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
    doneDate: d(r[C.doneDate - 1]), doneBy: String(r[C.doneBy - 1]), clientType: String(r[C.clientType - 1] || ''),
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

  Object.assign(rec, normLoc_(rec, user));
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

  return { ok: true, code: code, changed: changed };
}

/* ================= client codes ================= */

function getPassiveLogConfig_(user) {
  const settings = settings_();
  const locations = rows_(SHEET.locations).filter(r => r[0])
    .map(r => ({ site: String(r[0]), building: String(r[1]), level: String(r[2]), room: String(r[3]), roomNo: Number(r[5]) || 0 }));
  const split = (v, d) => String(v || d).split(',').map(s => s.trim()).filter(String);
  const buildings = {};
  const bsh = SpreadsheetApp.getActive().getSheetByName('Buildings');
  if (bsh) bsh.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] && r[1]) (buildings[String(r[0])] = buildings[String(r[0])] || []).push(String(r[1]).trim());
  });
  // Only their own requests, with a plain-English status and no money.
  const plain = s => s === 'Requested' ? 'Received' : (s === 'Scouted' || s === 'Allocated') ? 'Being quoted'
    : (s === 'Quoted' || s === 'PO Received') ? 'Quoted' : (s === 'Done' || s === 'Invoiced') ? 'Fixed' : s;
  const records = rows_(SHEET.pens)
    .filter(r => r[C.code - 1] && String(r[C.scoutedBy - 1]) === user.name && r[C.status - 1] !== 'Removed')
    .map(r => ({
      code: String(r[C.code - 1]), scoutedAt: r[C.scoutedAt - 1] instanceof Date ? r[C.scoutedAt - 1].toISOString() : String(r[C.scoutedAt - 1]),
      site: String(r[C.site - 1]), building: String(r[C.building - 1]), level: String(r[C.level - 1]), room: String(r[C.room - 1]),
      location: String(r[C.location - 1]), face: String(r[C.face - 1]), substrate: String(r[C.substrate - 1]),
      clientType: String(r[C.clientType - 1] || ''), qty: Number(r[C.qty - 1]) || 1, notes: String(r[C.notes - 1]),
      status: plain(String(r[C.status - 1])),
    }));
  return {
    ok: true, role: 'client', user: user.name, company: user.company, locations, buildings,
    substrates: split(settings['Substrate options'], 'Plasterboard, Block / brick, Concrete, Other'),
    clientTypes: split(settings['Client penetration types'], DEFAULT_CLIENT_TYPES),
    records: records.slice(-1000), serverTime: new Date().toISOString(),
  };
}

/** A client logs a penetration. It lands as "Requested" with no price until we price it. */
function requestPen_(user, rec) {
  if (!rec || !rec.recordKey || !rec.code) throw new Error('Missing record');
  Object.assign(rec, normLoc_(rec, user));
  const sh = sheet_(SHEET.pens);
  const byKey = findRow_(sh, C.recordKey, rec.recordKey);
  if (byKey) return { ok: true, code: sh.getRange(byKey, C.code).getValue(), duplicate: true };

  let code = String(rec.code).toUpperCase().replace(/[^A-Z0-9.]/g, '');
  let changed = false;
  if (findRow_(sh, C.code, code)) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let i = 0; i < letters.length; i++) {
      if (!findRow_(sh, C.code, code + letters[i])) { code = code + letters[i]; changed = true; break; }
    }
  }
  const folder = locationFolder_(rec.site, rec.building, rec.level, rec.room);
  const photos = savePhotos_(folder, code, 'client', (rec.photos || []).slice(0, 3));

  const row = sh.getLastRow() + 1;
  const v = new Array(NCOLS).fill('');
  v[C.code - 1] = code;
  v[C.scoutedAt - 1] = rec.capturedAt ? new Date(rec.capturedAt) : new Date();
  v[C.scoutedBy - 1] = user.name;
  v[C.site - 1] = rec.site; v[C.building - 1] = rec.building; v[C.level - 1] = rec.level; v[C.room - 1] = rec.room;
  v[C.location - 1] = '=E' + row + '&" "&F' + row + '&" - "&G' + row;
  v[C.face - 1] = rec.face || ''; v[C.substrate - 1] = rec.substrate || '';
  v[C.qty - 1] = Math.max(1, Math.min(99, Number(rec.qty) || 1)); v[C.unit - 1] = 0;
  v[C.price - 1] = '=ROUND(M' + row + '*N' + row + '*(1+P' + row + ')+Q' + row + ',0)';
  v[C.notes - 1] = 'Client request (' + user.name + (user.company ? ', ' + user.company : '') + '). ' + String(rec.notes || '').slice(0, 500);
  v[C.before - 1] = photos.join('\n');
  v[C.status - 1] = 'Requested';
  v[C.recordKey - 1] = rec.recordKey;
  v[C.clientType - 1] = String(rec.clientType || '').slice(0, 60);
  sh.getRange(row, 1, 1, NCOLS).setValues([v]);
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
  if (rec.accept && status === 'Requested') {
    if (!sh.getRange(row, C.product).getValue()) throw new Error(rec.code + ' needs a product before it can go in the bank');
    sh.getRange(row, C.status).setValue('Scouted');
    appendLines_(sh, row, C.notes, ['Priced by ' + user.name + ' ' + Utilities.formatDate(new Date(), 'Australia/Melbourne', 'd/M/yy')]);
  }

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
  makeUser_(NAME, EMAIL, 'staff', '');
}

/**
 * Create a CLIENT login (e.g. a Ventia supervisor). Set NAME, EMAIL and COMPANY, select addClient, press Run.
 * Clients can only log penetrations and see their own requests. No prices, no other jobs.
 * To switch a client off, set Active (column D) to No on the Users tab.
 */
function addClient() {
  const NAME = 'Test Client';
  const EMAIL = 'client@example.com';
  const COMPANY = 'Ventia';
  makeUser_(NAME, EMAIL, 'client', COMPANY);
}

function makeUser_(NAME, EMAIL, ROLE, COMPANY) {
  migrate_();
  const exists = rows_(SHEET.users).some(r => norm_(r[0]) === norm_(NAME));
  const out = exists ? resetUser_(NAME) : saveUser_({ name: 'editor' }, { isNew: true, name: NAME, email: EMAIL, role: ROLE, company: COMPANY });
  Logger.log((ROLE === 'client' ? 'Client setup code for ' : 'Setup code for ') + NAME + ': ' + out.code);
}

/** Run once from the editor to approve Drive, Docs and Sheets permissions. */
function authorise() {
  DriveApp.getFolderById(String(settings_()['Photos folder ID'])).getName();
  DocumentApp.getActiveDocument; // Docs scope for service reports
  ScriptApp.getProjectTriggers(); // lets reports build in the background
  MailApp.getRemainingDailyQuota(); // report-ready emails
  Logger.log('Authorised.');
}


/* =====================================================================
 * v2.0: users and permissions
 * Users tab: A Name, B Email, C Code hash, D Active, E Created, F Role, G Company,
 *            H Passive fire, I Repairs, J SIT, K Sites, L Dashboard
 * Blank permission cells fall back to the role's preset.
 * ===================================================================== */

const ROLES = {
  admin:    { passive: 'full', repairs: 'full', sit: 'edit', dashboard: true },
  staff:    { passive: 'full', repairs: 'full', sit: 'edit', dashboard: true },
  client:   { passive: 'log',  repairs: 'none', sit: 'none', dashboard: false },
  engineer: { passive: 'none', repairs: 'log',  sit: 'edit', dashboard: false },
};
const LEVELS = { passive: ['none', 'log', 'full'], repairs: ['none', 'log', 'full'], sit: ['none', 'view', 'edit'] };
const U = { name: 0, email: 1, hash: 2, active: 3, created: 4, role: 5, company: 6, passive: 7, repairs: 8, sit: 9, sites: 10, dashboard: 11 };

function norm_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function allSites_() {
  const out = [];
  rows_('Buildings').forEach(r => { const s = String(r[0]).trim(); if (s && out.indexOf(s) < 0) out.push(s); });
  return out.length ? out : ['Austin', 'Repat'];
}

function userFromRow_(r) {
  let role = norm_(r[U.role]) || 'admin'; // the first login (Jeff) was made before roles existed
  if (!ROLES[role]) role = 'staff';
  const pre = ROLES[role];
  const lvl = (k) => { const v = norm_(r[U[k]]); return LEVELS[k].indexOf(v) >= 0 ? v : pre[k]; };
  const all = allSites_();
  const sitesRaw = String(r[U.sites] || '').split(',').map(x => x.trim()).filter(String);
  const sites = sitesRaw.length ? all.filter(x => sitesRaw.some(y => norm_(y) === norm_(x))) : all;
  const dash = norm_(r[U.dashboard]);
  const admin = role === 'admin';
  return {
    name: String(r[U.name]), email: String(r[U.email]), role: role, company: String(r[U.company] || ''),
    perms: {
      passive: lvl('passive'), repairs: lvl('repairs'), sit: lvl('sit'), sites: sites, admin: admin,
      // the dashboard shows money, so only admin and staff can ever have it
      dashboard: admin || (role === 'staff' && (dash ? dash === 'yes' : pre.dashboard)),
    },
  };
}

function siteOk_(user, site) { return user.perms.sites.some(s => norm_(s) === norm_(site)); }

function newCode_() {
  const WORDS = 'ant apple arrow aspen badge banjo basin bear bee birch bison blaze bolt brick cabin cargo cedar chalk cod comet coral crane creek crow dawn deer delta denim dingo dove drift duck eagle echo elk ember emu fern fig flint fox frog galah gecko grove gull gum hare hawk hazel heron honey husky iron ivory ivy jay jetty kayak kelp kite kiwi koala lark laser lemon lilac lime lion lotus lynx mango maple mesa mint moose moss moth nova oak ocean olive onyx opal orbit orca otter owl panda pine pixel plum polar puma quill radar ram raven ray reef ridge river robin ruby sage scout seal shark slate stone storm swan swift tango tiger toad topaz torch tulip turbo umber wolf wren yak yarra zinc'.split(' ');
  const taken = rows_(SHEET.users).map(r => String(r[U.hash]));
  for (let i = 0; i < 50; i++) {
    const key = WORDS[Math.floor(Math.random() * WORDS.length)] + String(1000 + Math.floor(Math.random() * 9000));
    if (taken.indexOf(sha256_(key)) < 0) return key;
  }
  throw new Error('Could not make a unique code. Try again.');
}

function listUsers_() {
  const users = rows_(SHEET.users).filter(r => r[0]).map(r => {
    const u = userFromRow_(r);
    return { name: u.name, email: u.email, role: u.role, company: u.company, active: norm_(r[U.active]) === 'yes',
      created: r[U.created] instanceof Date ? r[U.created].toISOString() : String(r[U.created] || ''),
      passive: u.perms.passive, repairs: u.perms.repairs, sit: u.perms.sit, sites: u.perms.sites, dashboard: u.perms.dashboard };
  });
  return { ok: true, users: users, sites: allSites_() };
}

function saveUser_(me, u) {
  const name = String(u.name || '').trim();
  if (!name) throw new Error('Enter a name');
  const role = ROLES[norm_(u.role)] ? norm_(u.role) : 'client';
  const sh = sheet_(SHEET.users);
  const data = sh.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < data.length; i++) if (norm_(data[i][0]) === norm_(name)) { row = i + 1; break; }
  if (u.isNew && row > 0) throw new Error('There is already a login called ' + name + '. Use a different name or edit that one.');
  if (!u.isNew && row < 0) throw new Error(name + ' not found');
  if (!u.isNew && norm_(name) === norm_(me.name) && (role !== 'admin' || u.active === false)) throw new Error('You cannot remove your own admin access');
  const pick = (k) => LEVELS[k].indexOf(norm_(u[k])) >= 0 ? norm_(u[k]) : ROLES[role][k];
  const all = allSites_();
  const sites = Array.isArray(u.sites) ? all.filter(x => u.sites.some(y => norm_(y) === norm_(x))) : all;
  const vals = [role, String(u.company || ''), pick('passive'), pick('repairs'), pick('sit'),
    sites.length === all.length ? '' : sites.join(', '), role === 'staff' ? (u.dashboard === false ? 'No' : 'Yes') : ''];
  let code = '';
  if (u.isNew) {
    code = newCode_();
    sh.appendRow([name, String(u.email || ''), sha256_(code), 'Yes', new Date()].concat(vals));
  } else {
    sh.getRange(row, U.email + 1).setValue(String(u.email || ''));
    sh.getRange(row, U.active + 1).setValue(u.active === false ? 'No' : 'Yes');
    sh.getRange(row, U.role + 1, 1, vals.length).setValues([vals]);
  }
  return { ok: true, name: name, code: code };
}

function resetUser_(name) {
  const sh = sheet_(SHEET.users);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(name)) {
      const code = newCode_();
      sh.getRange(i + 1, U.hash + 1).setValue(sha256_(code));
      sh.getRange(i + 1, U.active + 1).setValue('Yes');
      return { ok: true, name: String(data[i][0]), code: code };
    }
  }
  throw new Error(name + ' not found');
}

/* =====================================================================
 * Config: one call, shaped by what the login is allowed to see
 * ===================================================================== */

function getConfig_(user) {
  const P = user.perms;
  let cfg = { ok: true };
  if (P.passive === 'full') cfg = getPassiveFullConfig_(user);
  else if (P.passive === 'log') cfg = getPassiveLogConfig_(user);
  const settings = settings_();
  const split = (v, d) => String(v || d).split(',').map(x => x.trim()).filter(String);
  const b = buildingsInfo_();
  Object.assign(cfg, {
    ok: true, user: user.name, role: user.role, company: user.company, perms: P, sites: P.sites,
    buildings: b.codes, buildingNames: b.names,
    locations: locationsOut_().filter(l => siteOk_(user, l.site)),
    substrates: split(settings['Substrate options'], 'Plasterboard, Block / brick, Concrete, Other'),
    clientTypes: split(settings['Client penetration types'], DEFAULT_CLIENT_TYPES),
    serverTime: new Date().toISOString(),
  });
  if (P.passive !== 'full') { delete cfg.rates; delete cfg.access; }
  if (P.repairs !== 'none') {
    const full = P.repairs === 'full';
    cfg.repairs = {
      level: P.repairs,
      assets: split(settings['Repair asset types'], DEFAULT_ASSETS),
      records: rows_(SHEET.repairs).filter(r => r[R.code - 1] && r[R.status - 1] !== 'Removed' && siteOk_(user, r[R.site - 1])
        && (full || String(r[R.loggedBy - 1]) === user.name)).map(r => repairOut_(r, full)).slice(-2000),
    };
  }
  if (P.sit !== 'none') {
    cfg.sit = { level: P.sit, tests: rows_(SHEET.sit).filter(r => r[0] && siteOk_(user, r[1])).map(sitOut_) };
  }
  return cfg;
}

/* =====================================================================
 * Locations: one standard format, with an Unconfirmed flag for anything new
 * Locations tab: A Site, B Building, C Level, D Room, E Added by, F Room no, G Status
 * Buildings tab: A Site, B Code, C Notes, D Full name
 * ===================================================================== */

function buildingsInfo_() {
  const codes = {}, names = {};
  rows_('Buildings').forEach(r => {
    const site = String(r[0]).trim(), code = String(r[1]).trim();
    if (!site || !code) return;
    (codes[site] = codes[site] || []).push(code);
    if (r[3]) names[site + '|' + code] = String(r[3]).trim();
  });
  return { codes: codes, names: names };
}

function locationsOut_() {
  return rows_(SHEET.locations).filter(r => r[0]).map(r => ({
    site: String(r[0]), building: String(r[1]), level: String(r[2]), room: String(r[3]),
    addedBy: String(r[4] || ''), roomNo: Number(r[5]) || 0, status: String(r[6] || 'Confirmed'),
  }));
}

function normLevel_(v) {
  let s = String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
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

function normRoom_(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').split(' ').map(w => {
    if (/^[A-Z]{2,3}$/.test(w) || /\d/.test(w)) return w.toUpperCase(); // ICU, MRI, 4B stay as written
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function normBuilding_(site, v) {
  const raw = String(v || '').trim().replace(/\s+/g, ' ');
  const info = buildingsInfo_();
  const codes = info.codes[site] || [];
  const hit = codes.find(c => norm_(c) === norm_(raw) || norm_(info.names[site + '|' + c]) === norm_(raw));
  if (hit) return { building: hit, known: true };
  return { building: raw.length <= 6 && raw.indexOf(' ') < 0 ? raw.toUpperCase() : normRoom_(raw), known: false };
}

/** Standardise a submitted location, add it to the Locations tab if new, and say whether it is confirmed. */
function normLoc_(rec, user) {
  const sites = allSites_();
  const site = sites.find(x => norm_(x) === norm_(rec.site));
  if (!site) throw new Error('Unknown site ' + rec.site);
  if (!siteOk_(user, site)) throw new Error('Your login is not set up for ' + site);
  const b = normBuilding_(site, rec.building);
  const loc = { site: site, building: b.building, level: normLevel_(rec.level), room: normRoom_(rec.room) };
  if (!loc.building || !loc.level || !loc.room) throw new Error('Location is incomplete');
  const key = l => [l.site, l.building, l.level, l.room].map(norm_).join('|');
  const existing = locationsOut_().find(l => key(l) === key(loc));
  if (existing) return { site: existing.site, building: existing.building, level: existing.level, room: existing.room, locStatus: existing.status };
  const trusted = user.perms.admin || user.role === 'staff';
  const status = b.known && trusted ? 'Confirmed' : 'Unconfirmed';
  ensureCols_(sheet_(SHEET.locations), 7);
  sheet_(SHEET.locations).appendRow([loc.site, loc.building, loc.level, loc.room, user.name, Number(rec.roomNo) || '', status]);
  loc.locStatus = status;
  return loc;
}

/**
 * Tidy a location: every job at `from` is moved to `to`, `from` disappears from the list,
 * and `to` becomes a confirmed location (created if new). Tag codes never change.
 */
function locResolve_(user, from, to, buildingName) {
  if (!from || !to) throw new Error('Missing location');
  const site = allSites_().find(x => norm_(x) === norm_(to.site));
  if (!site) throw new Error('Unknown site');
  const b = normBuilding_(site, to.building);
  const t = { site: site, building: b.building, level: normLevel_(to.level), room: normRoom_(to.room) };
  if (!t.building || !t.level || !t.room) throw new Error('Fill in building, level and room');
  if (!b.known) buildingSave_(site, t.building, buildingName || '');
  const same = (r, i) => norm_(r[i]) === norm_(from.site) && norm_(r[i + 1]) === norm_(from.building) && norm_(r[i + 2]) === norm_(from.level) && norm_(r[i + 3]) === norm_(from.room);
  let moved = 0;
  [[SHEET.pens, C.site], [SHEET.repairs, R.site]].forEach(([name, col]) => {
    const sh = sheet_(name);
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (same(data[i], col - 1)) { sh.getRange(i + 1, col, 1, 4).setValues([[t.site, t.building, t.level, t.room]]); moved++; }
    }
  });
  const sh = sheet_(SHEET.locations);
  ensureCols_(sh, 7);
  const data = sh.getDataRange().getValues();
  let target = -1;
  for (let i = data.length - 1; i >= 1; i--) {
    const r = data[i];
    if (same(r, 0) && !(norm_(r[1]) === norm_(t.building) && norm_(r[2]) === norm_(t.level) && norm_(r[3]) === norm_(t.room))) { sh.deleteRow(i + 1); continue; }
    if (norm_(r[0]) === norm_(t.site) && norm_(r[1]) === norm_(t.building) && norm_(r[2]) === norm_(t.level) && norm_(r[3]) === norm_(t.room)) target = i + 1;
  }
  if (target > 0) sh.getRange(target, 1, 1, 4).setValues([[t.site, t.building, t.level, t.room]]);
  if (target > 0) sh.getRange(target, 7).setValue('Confirmed');
  else sh.appendRow([t.site, t.building, t.level, t.room, user.name, '', 'Confirmed']);
  dropDashCache_();
  return { ok: true, moved: moved, to: t };
}

function buildingSave_(site, code, name) {
  site = allSites_().find(x => norm_(x) === norm_(site)) || String(site || '').trim();
  code = String(code || '').trim();
  if (!site || !code) throw new Error('Enter the site and building code');
  const sh = sheet_('Buildings');
  ensureCols_(sh, 4);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (norm_(data[i][0]) === norm_(site) && norm_(data[i][1]) === norm_(code)) {
      if (name !== undefined && name !== null) sh.getRange(i + 1, 4).setValue(String(name).trim());
      return { ok: true };
    }
  }
  sh.appendRow([site, code, '', String(name || '').trim()]);
  return { ok: true };
}

/* =====================================================================
 * Fire repairs (separate tab, separate revenue)
 * ===================================================================== */

const R = { code: 1, loggedAt: 2, loggedBy: 3, site: 4, building: 5, level: 6, room: 7, location: 8, asset: 9, defect: 10,
  priority: 11, price: 12, status: 13, vp: 14, before: 15, after: 16, doneDate: 17, doneBy: 18, notes: 19, recordKey: 20, qty: 21 };
const RCOLS = 21;
const REPAIR_STATUSES = ['Logged', 'Quoted', 'PO Received', 'Done', 'Invoiced'];
const DEFAULT_ASSETS = 'Fire door, Door hardware / closer, Sprinkler, Hydrant, Hose reel, Extinguisher, Exit / emergency light, Fire damper, Detector, Fire panel, Other';

function plainRepairStatus_(s) {
  return s === 'Logged' ? 'Received' : s === 'Quoted' ? 'Quoted' : s === 'PO Received' ? 'Approved' : (s === 'Done' || s === 'Invoiced') ? 'Fixed' : s;
}

function repairOut_(r, full) {
  const d = v => (v instanceof Date ? v.toISOString() : String(v || ''));
  const first = v => String(v || '').split('\n')[0];
  const o = {
    code: String(r[R.code - 1]), loggedAt: d(r[R.loggedAt - 1]), loggedBy: String(r[R.loggedBy - 1]),
    site: String(r[R.site - 1]), building: String(r[R.building - 1]), level: String(r[R.level - 1]), room: String(r[R.room - 1]),
    location: String(r[R.location - 1]), asset: String(r[R.asset - 1]), defect: String(r[R.defect - 1]), priority: String(r[R.priority - 1]),
    qty: Number(r[R.qty - 1]) || 1, before: first(r[R.before - 1]), after: first(r[R.after - 1]),
    doneDate: d(r[R.doneDate - 1]),
  };
  if (full) Object.assign(o, { price: Number(r[R.price - 1]) || 0, status: String(r[R.status - 1]), vp: String(r[R.vp - 1]), notes: String(r[R.notes - 1]), doneBy: String(r[R.doneBy - 1]) });
  else o.status = plainRepairStatus_(String(r[R.status - 1]));
  return o;
}

function repairLog_(user, rec) {
  if (!rec || !rec.recordKey || !rec.code) throw new Error('Missing record');
  if (!rec.asset || !String(rec.defect || '').trim()) throw new Error('Pick the item and describe the fault');
  Object.assign(rec, normLoc_(rec, user));
  const sh = sheet_(SHEET.repairs);
  const byKey = findRow_(sh, R.recordKey, rec.recordKey);
  if (byKey) return { ok: true, code: sh.getRange(byKey, R.code).getValue(), duplicate: true };
  let code = String(rec.code).toUpperCase().replace(/[^A-Z0-9.\-]/g, ''), changed = false;
  if (findRow_(sh, R.code, code)) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let i = 0; i < letters.length; i++) if (!findRow_(sh, R.code, code + letters[i])) { code += letters[i]; changed = true; break; }
  }
  const folder = locationFolder_(rec.site, rec.building, rec.level, rec.room);
  const photos = savePhotos_(folder, code, 'repair', (rec.photos || []).slice(0, 3));
  const full = user.perms.repairs === 'full';
  const row = sh.getLastRow() + 1;
  const v = new Array(RCOLS).fill('');
  v[R.code - 1] = code; v[R.loggedAt - 1] = rec.capturedAt ? new Date(rec.capturedAt) : new Date(); v[R.loggedBy - 1] = user.name;
  v[R.site - 1] = rec.site; v[R.building - 1] = rec.building; v[R.level - 1] = rec.level; v[R.room - 1] = rec.room;
  v[R.location - 1] = '=E' + row + '&" "&F' + row + '&" - "&G' + row;
  v[R.asset - 1] = String(rec.asset).slice(0, 60); v[R.defect - 1] = String(rec.defect).slice(0, 1000);
  v[R.priority - 1] = ['Urgent', 'Soon', 'Routine'].indexOf(rec.priority) >= 0 ? rec.priority : 'Routine';
  v[R.qty - 1] = Math.max(1, Math.min(99, Number(rec.qty) || 1));
  v[R.price - 1] = full && Number(rec.price) > 0 ? Number(rec.price) : '';
  v[R.status - 1] = 'Logged';
  v[R.before - 1] = photos.join('\n');
  v[R.notes - 1] = (full ? '' : 'Logged by ' + user.name + (user.company ? ' (' + user.company + ')' : '') + '. ') + String(rec.notes || '').slice(0, 500);
  v[R.recordKey - 1] = rec.recordKey;
  sh.getRange(row, 1, 1, RCOLS).setValues([v]);
  dropDashCache_();
  return { ok: true, code: code, changed: changed };
}

function repairUpdate_(user, rec) {
  const sh = sheet_(SHEET.repairs);
  const row = findRow_(sh, R.code, rec && rec.code);
  if (!row) throw new Error('Repair ' + (rec && rec.code) + ' not found');
  const status = String(sh.getRange(row, R.status).getValue());
  if (status === 'Invoiced') throw new Error(rec.code + ' is invoiced and can only be changed in the sheet');
  if (rec.remove) {
    sh.getRange(row, R.status).setValue('Removed');
    appendLines_(sh, row, R.notes, ['Removed by ' + user.name + ' ' + Utilities.formatDate(new Date(), 'Australia/Melbourne', 'd/M/yy')]);
    dropDashCache_();
    return { ok: true, code: rec.code, removed: true };
  }
  const f = rec.fields || {};
  const set = (col, val) => { if (val !== undefined) sh.getRange(row, col).setValue(val); };
  set(R.asset, f.asset); set(R.defect, f.defect); set(R.priority, f.priority); set(R.notes, f.notes); set(R.vp, f.vp);
  if (f.qty !== undefined) set(R.qty, Math.max(1, Number(f.qty) || 1));
  if (f.price !== undefined) set(R.price, Number(f.price) || '');
  if (f.status !== undefined && REPAIR_STATUSES.indexOf(f.status) >= 0) set(R.status, f.status);
  const r = sh.getRange(row, 1, 1, RCOLS).getValues()[0];
  const folder = locationFolder_(r[R.site - 1], r[R.building - 1], r[R.level - 1], r[R.room - 1]);
  if (rec.photos && rec.photos.length) appendLines_(sh, row, R.before, savePhotos_(folder, rec.code, 'repair', rec.photos));
  if (rec.afterPhotos && rec.afterPhotos.length) appendLines_(sh, row, R.after, savePhotos_(folder, rec.code, 'after', rec.afterPhotos));
  dropDashCache_();
  return { ok: true, code: rec.code };
}

function repairDone_(user, rec) {
  const sh = sheet_(SHEET.repairs);
  const row = findRow_(sh, R.code, rec && rec.code);
  if (!row) throw new Error('Repair ' + (rec && rec.code) + ' not found');
  const status = String(sh.getRange(row, R.status).getValue());
  if (status === 'Done' || status === 'Invoiced') return { ok: true, duplicate: true };
  const r = sh.getRange(row, 1, 1, RCOLS).getValues()[0];
  const folder = locationFolder_(r[R.site - 1], r[R.building - 1], r[R.level - 1], r[R.room - 1]);
  appendLines_(sh, row, R.after, savePhotos_(folder, rec.code, 'after', rec.photos || []));
  sh.getRange(row, R.status).setValue('Done');
  sh.getRange(row, R.doneDate).setValue(rec.capturedAt ? new Date(rec.capturedAt) : new Date());
  sh.getRange(row, R.doneBy).setValue(user.name);
  if (rec.notes) appendLines_(sh, row, R.notes, ['Done: ' + rec.notes]);
  dropDashCache_();
  return { ok: true, code: rec.code };
}

/* =====================================================================
 * SIT (system interface tests). Placeholder: a register of tests.
 * Full report and matrix come after the first test.
 * ===================================================================== */

const SIT_COLS = ['ID', 'Site', 'Building', 'Test date', 'Engineer', 'Status', 'Report link', 'Notes', 'Created by', 'Updated'];
const SIT_STATUSES = ['Planned', 'In progress', 'Report due', 'Complete'];

function sitOut_(r) {
  return { id: String(r[0]), site: String(r[1]), building: String(r[2]),
    date: r[3] instanceof Date ? Utilities.formatDate(r[3], 'Australia/Melbourne', 'yyyy-MM-dd') : String(r[3] || ''),
    engineer: String(r[4]), status: String(r[5] || 'Planned'), report: String(r[6] || ''), notes: String(r[7] || ''), createdBy: String(r[8] || '') };
}

function sitSave_(user, t) {
  if (!t || !t.site || !t.building) throw new Error('Pick the site and building');
  if (!siteOk_(user, t.site)) throw new Error('Your login is not set up for ' + t.site);
  const sh = sheet_(SHEET.sit);
  const vals = [t.site, normBuilding_(t.site, t.building).building, t.date ? new Date(t.date) : '', String(t.engineer || ''),
    SIT_STATUSES.indexOf(t.status) >= 0 ? t.status : 'Planned', String(t.report || ''), String(t.notes || '').slice(0, 1000)];
  const row = t.id ? findRow_(sh, 1, t.id) : 0;
  if (row) {
    sh.getRange(row, 2, 1, vals.length).setValues([vals]);
    sh.getRange(row, 10).setValue(new Date());
    return { ok: true, id: t.id };
  }
  const id = t.id || ('SIT-' + Utilities.formatDate(new Date(), 'Australia/Melbourne', 'yyMMdd') + '-' + (10 + Math.floor(Math.random() * 90)));
  sh.appendRow([id].concat(vals).concat([user.name, new Date()]));
  return { ok: true, id: id };
}

/* =====================================================================
 * Dashboard (back office). Cached for 2 minutes; changes clear the cache.
 * ===================================================================== */

function dropDashCache_() {
  const c = CacheService.getScriptCache();
  c.removeAll(['DASH_'].concat(allSites_().map(s => 'DASH_' + s)));
}

function money_(v) { return typeof v === 'number' ? v : Number(String(v || '').replace(/[^0-9.\-]/g, '')) || 0; }

function dashboard_(user, site) {
  if (site && !siteOk_(user, site)) site = '';
  const allowed = s => (site ? norm_(s) === norm_(site) : siteOk_(user, s));
  const key = 'DASH_' + site;
  const cache = CacheService.getScriptCache();
  const hit = user.perms.sites.length === allSites_().length ? cache.get(key) : null;
  if (hit) return JSON.parse(hit);

  const s = settings_();
  const monthMin = Number(s['Monthly target minimum ($ ex GST)']) || 12000;
  const monthMax = Number(s['Monthly target maximum ($ ex GST)']) || 13000;
  const thisMonth = Utilities.formatDate(new Date(), 'Australia/Melbourne', 'yyyy-MM');

  // passive fire penetrations
  const pens = rows_(SHEET.pens).filter(r => r[C.code - 1] && r[C.status - 1] !== 'Removed' && allowed(r[C.site - 1]));
  const pStatus = {}, byBuilding = {};
  let bank = 0, bankN = 0, requested = 0;
  pens.forEach(r => {
    const st = String(r[C.status - 1]), v = Number(r[C.price - 1]) || 0;
    (pStatus[st] = pStatus[st] || { n: 0, v: 0 }).n++; pStatus[st].v += v;
    if (st === 'Scouted') { bank += v; bankN++; }
    if (st === 'Requested') requested++;
    const bk = r[C.site - 1] + ' · ' + r[C.building - 1];
    const b = (byBuilding[bk] = byBuilding[bk] || { site: String(r[C.site - 1]), building: String(r[C.building - 1]), bank: 0, open: 0, done: 0, n: 0 });
    b.n++;
    if (st === 'Scouted') b.bank += v; else if (OPEN_STATUSES.indexOf(st) >= 0) b.open += v; else if (st === 'Done' || st === 'Invoiced') b.done += v;
  });

  // POs (history and planned months)
  const pos = rows_(SHEET.pos).filter(r => r[0] && allowed(r[1])).map(r => ({
    month: String(r[0]).replace(/^'/, ''), site: String(r[1]), location: String(r[2]), vp: String(r[3]),
    value: money_(r[5]), status: String(r[6] || ''), wo: String(r[7] || ''),
  }));
  const months = {};
  pos.forEach(p => {
    const m = (months[p.month] = months[p.month] || { month: p.month, done: 0, open: 0, n: 0 });
    m.n++;
    if (p.status === 'Done' || p.status === 'Invoiced') m.done += p.value; else m.open += p.value;
  });
  const monthList = Object.keys(months).sort().map(k => months[k]);
  const plannedAhead = monthList.filter(m => m.month >= thisMonth && m.open > 0);
  const poStatus = {};
  pos.forEach(p => { (poStatus[p.status] = poStatus[p.status] || { n: 0, v: 0 }).n++; poStatus[p.status].v += p.value; });

  // repairs
  const reps = rows_(SHEET.repairs).filter(r => r[R.code - 1] && r[R.status - 1] !== 'Removed' && allowed(r[R.site - 1]));
  const rStatus = {};
  let toPrice = 0;
  reps.forEach(r => {
    const st = String(r[R.status - 1]), v = Number(r[R.price - 1]) || 0;
    (rStatus[st] = rStatus[st] || { n: 0, v: 0 }).n++; rStatus[st].v += v;
    if (st === 'Logged' && !v) toPrice++;
  });

  const unconfirmed = locationsOut_().filter(l => l.status === 'Unconfirmed' && allowed(l.site)).length;
  const plan = SpreadsheetApp.getActive().getSheetByName('Monthly Plan');
  const planRows = plan ? plan.getDataRange().getDisplayValues() : [];

  const out = {
    ok: true, site: site, thisMonth: thisMonth, monthMin: monthMin, monthMax: monthMax,
    passive: {
      bank: bank, bankN: bankN, bankMonths: bank / monthMin, plannedMonths: plannedAhead.length,
      plannedValue: plannedAhead.reduce((a, m) => a + m.open, 0),
      monthsAhead: plannedAhead.length + bank / monthMin,
      penStatus: pStatus, poStatus: poStatus, months: monthList,
      buildings: Object.keys(byBuilding).sort().map(k => byBuilding[k]),
    },
    repairs: { status: rStatus, toPrice: toPrice, n: reps.length },
    todo: { requested: requested, unconfirmed: unconfirmed, repairsToPrice: toPrice },
    pos: pos, planRows: planRows, nextMonth: nextUnplannedMonth_(), serverTime: new Date().toISOString(),
  };
  if (!hit && user.perms.sites.length === allSites_().length) {
    const str = JSON.stringify(out);
    if (str.length < 90000) cache.put(key, str, 120);
  }
  return out;
}

/* =====================================================================
 * One-off upgrade of the sheet for v2. Runs itself on the first request.
 * ===================================================================== */

function ensureCols_(sh, n) { if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns()); }

function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  ensureCols_(sh, headers.length);
  return sh;
}

function migrate_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA') === '2') return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (props.getProperty('SCHEMA') === '2') return;
    const users = sheet_(SHEET.users);
    ensureCols_(users, 12);
    users.getRange(1, 6, 1, 7).setValues([['Role', 'Company', 'Passive fire', 'Repairs', 'SIT', 'Sites', 'Dashboard']]).setFontWeight('bold');
    const ud = users.getDataRange().getValues();
    for (let i = 1; i < ud.length; i++) if (ud[i][0] && !String(ud[i][5]).trim()) users.getRange(i + 1, 6).setValue('admin');

    const pens = sheet_(SHEET.pens);
    ensureCols_(pens, 29);
    if (!pens.getRange(1, 29).getValue()) pens.getRange(1, 29).setValue('Client pen type').setFontWeight('bold');

    const locs = sheet_(SHEET.locations);
    ensureCols_(locs, 7);
    locs.getRange(1, 7).setValue('Status').setFontWeight('bold');
    const ld = locs.getDataRange().getValues();
    for (let i = 1; i < ld.length; i++) if (ld[i][0] && !String(ld[i][6]).trim()) locs.getRange(i + 1, 7).setValue('Confirmed');

    const bsh = sheet_('Buildings');
    ensureCols_(bsh, 4);
    bsh.getRange(1, 4).setValue('Full name').setFontWeight('bold');
    const known = rows_('Buildings').map(r => norm_(r[0]) + '|' + norm_(r[1]));
    rows_(SHEET.locations).forEach(r => {
      const k = norm_(r[0]) + '|' + norm_(r[1]);
      if (r[0] && r[1] && known.indexOf(k) < 0) { bsh.appendRow([String(r[0]), String(r[1]), '', '']); known.push(k); }
    });

    ensureSheet_(SHEET.repairs, ['Code', 'Logged at', 'Logged by', 'Site', 'Building', 'Level', 'Room / Area', 'Location', 'Item',
      'Fault', 'Priority', 'Price ($ ex GST)', 'Status', 'Quote / VP', 'Before photos', 'After photos', 'Done date', 'Done by', 'Notes', 'Record key', 'Qty']);
    ensureSheet_(SHEET.sit, SIT_COLS);
    props.setProperty('SCHEMA', '2');
  } finally { lock.releaseLock(); }
}
