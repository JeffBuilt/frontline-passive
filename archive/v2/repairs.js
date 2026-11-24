/* Frontline - fire repairs (separate from passive fire; own tab, own revenue) */
'use strict';

const PRIORITIES = ['Urgent', 'Soon', 'Routine'];
const REPAIR_STATUSES = ['Logged', 'Quoted', 'PO Received', 'Done', 'Invoiced'];
const repairsCfg = () => (state.config && state.config.repairs) || { level: 'none', records: [], assets: [] };
const repairsFull = () => repairsCfg().level === 'full';
const repairRecs = () => repairsCfg().records || [];

function freshRepair(keep) {
  return Object.assign({ photo: '', asset: '', assetOther: '', defect: '', priority: 'Routine', qty: 1, price: '', notes: '' }, keep || {});
}
state.rdraft = Object.assign(freshRepair(), store.get(LS.rdraft, {}));
const saveRdraft = () => store.set(LS.rdraft, state.rdraft);

function makeRepairCode(l) {
  const used = new Set(repairRecs().map(r => r.code).concat(state.queue.filter(q => q.action === 'repairLog').map(q => q.record.code)));
  const prefix = `R${String(l.building).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5)}${levelCode(l.level)}.`;
  for (let i = 0; i < 500; i++) { const c = prefix + (100 + Math.floor(Math.random() * 900)); if (!used.has(c)) return c; }
  return prefix + Date.now().toString().slice(-4);
}

/* ---- home ---- */

function renderRHome() {
  const recs = repairRecs();
  const queued = state.queue.filter(q => q.action === 'repairLog').length;
  if (!repairsFull()) {
    const open = recs.filter(r => r.status !== 'Fixed').length + queued;
    return `<div class="bank r"><p class="hello">Hi ${esc(state.config.user)}</p><div class="amount">${open}</div>
      <p class="sub">open repair${open === 1 ? '' : 's'} with Frontline${queued ? ` (${queued} still to upload)` : ''}</p></div>
      <button class="tile primary" data-r="new"><span class="ico">${ICONS.plus}</span><span><strong>Log a repair</strong><span class="d">Fire door, sprinkler, hydrant, exit light…</span></span></button>
      <button class="tile" data-r="find"><span class="ico">${ICONS.search}</span><span><strong>My repairs</strong><span class="d">See what you've logged and where it's up to</span></span></button>`;
  }
  const toQuote = recs.filter(r => r.status === 'Logged');
  const quoted = recs.filter(r => r.status === 'Quoted');
  const jobs = recs.filter(r => r.status === 'PO Received');
  const unpriced = toQuote.filter(r => !r.price).length;
  return `<div class="bank r"><p class="hello">Fire repairs</p><div class="amount">${money(quoted.reduce((t, r) => t + r.price, 0))}</div>
      <p class="sub">quoted, waiting on a PO · ${toQuote.length} logged to quote${unpriced ? ` (${unpriced} need a price)` : ''}</p></div>
    <button class="tile primary" data-r="new"><span class="ico">${ICONS.plus}</span><span><strong>Log a repair</strong><span class="d">Photo, item, fault, priority</span></span></button>
    <button class="tile" data-r="jobs"><span class="ico">${ICONS.check}</span><span><strong>Jobs to do</strong><span class="d">PO received. Mark done with an after photo.</span></span>${jobs.length ? `<span class="count">${jobs.length}</span>` : ''}</button>
    <button class="tile" data-r="find"><span class="ico">${ICONS.search}</span><span><strong>Find and edit</strong><span class="d">Price, quote number, status</span></span></button>`;
}
function bindRHome() {
  $$('[data-r]').forEach(b => b.onclick = () => {
    const g = b.dataset.r;
    if (g === 'new') { state.rdraft = freshRepair({ priority: state.rdraft.priority }); saveRdraft(); go(locReady(state.loc) ? 'rlog' : 'loc'); }
    else if (g === 'jobs') go('rjobs', 'rhome');
    else go('rfind', 'rfind');
  });
}

/* ---- log a repair ---- */

function renderRLog() {
  const d = state.rdraft, L = state.loc, full = repairsFull();
  const assets = repairsCfg().assets || [];
  const asset = d.asset === 'Other' ? d.assetOther.trim() : d.asset;
  const ready = asset && d.defect.trim() && (!full || d.photo);
  return `<div class="locbar"><div><strong>${esc(locLabel(L))}</strong><br><span class="muted">${esc(L.site)} · fire repair</span></div><button class="ghost" id="chLoc">Change</button></div>
  <div class="card"><h2>Photo ${full ? '' : '<span class="muted">(helps us quote)</span>'}</h2>${photoBlock(d.photo, 'photo', 'Take photo')}</div>
  <div class="card"><h2>What's wrong?</h2>
    <label>Item</label>
    <div class="chips">${assets.map(x => `<button class="chip ${d.asset === x ? 'on' : ''}" data-asset="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    ${d.asset === 'Other' ? `<input id="assetOther" value="${esc(d.assetOther)}" placeholder="What is it?">` : ''}
    <label>Fault</label>
    <textarea id="defect" placeholder="Door doesn't self-close, closer leaking">${esc(d.defect)}</textarea>
    <label>How many?</label>
    <div class="stepper"><button id="qMinus">−</button><span>${d.qty}</span><button id="qPlus">+</button></div>
    <label>Priority</label>
    <div class="chips">${PRIORITIES.map(x => `<button class="chip ${d.priority === x ? 'on' : ''}" data-pri="${x}">${x}</button>`).join('')}</div>
    ${full ? `<label>Price ($ ex GST) <span class="muted">(optional, can price later)</span></label><input id="rprice" type="number" inputmode="decimal" value="${esc(d.price)}">` : ''}
    <label>Notes</label><textarea id="rnotes" placeholder="Access, parts, who reported it">${esc(d.notes)}</textarea>
  </div>
  <div class="card"><button class="big" id="saveR" ${ready ? '' : 'disabled'}>${full ? 'Save repair' : 'Send to Frontline'}</button>
    ${ready ? '' : `<p class="muted">${full && !d.photo ? 'Take the photo. ' : ''}Pick the item and describe the fault.</p>`}</div>`;
}
function bindRLog() {
  const d = state.rdraft;
  const keepText = () => {
    const ids = { defect: 'defect', rnotes: 'notes', rprice: 'price', assetOther: 'assetOther' };
    Object.keys(ids).forEach(id => { const el = $('#' + id); if (el) d[ids[id]] = el.value; });
  };
  const ch = () => { keepText(); saveRdraft(); render(); };
  $('#chLoc').onclick = () => { keepText(); saveRdraft(); go('loc'); };
  $$('[data-shoot],[data-retake]').forEach(b => b.onclick = () => { keepText(); saveRdraft(); takePhoto(data => { d.photo = data; saveRdraft(); render(); }); });
  $$('[data-asset]').forEach(b => b.onclick = () => { d.asset = b.dataset.asset; ch(); });
  $$('[data-pri]').forEach(b => b.onclick = () => { d.priority = b.dataset.pri; ch(); });
  $('#qMinus').onclick = () => { d.qty = Math.max(1, d.qty - 1); ch(); };
  $('#qPlus').onclick = () => { d.qty = Math.min(99, d.qty + 1); ch(); };
  ['defect', 'assetOther'].forEach(id => { const el = $('#' + id); if (el) el.oninput = () => { keepText(); saveRdraft(); const a = d.asset === 'Other' ? d.assetOther.trim() : d.asset; $('#saveR').disabled = !(a && d.defect.trim() && (!repairsFull() || d.photo)); }; });
  ['rnotes', 'rprice'].forEach(id => { const el = $('#' + id); if (el) el.oninput = () => { keepText(); saveRdraft(); }; });
  $('#saveR').onclick = async () => {
    keepText();
    const L = state.loc, code = makeRepairCode(L), recordKey = uid();
    const asset = d.asset === 'Other' ? d.assetOther.trim() : d.asset;
    const record = { recordKey, code, capturedAt: new Date().toISOString(), site: L.site, building: L.building, level: L.level, room: L.room,
      asset, defect: d.defect.trim(), priority: d.priority, qty: d.qty, price: repairsFull() ? Number(d.price) || 0 : 0, notes: d.notes, photos: d.photo ? [d.photo] : [] };
    await db.put({ recordKey, action: 'repairLog', record, createdAt: Date.now(), price: 0, label: `${code} · ${locLabel(L)} · ${asset}` });
    state.queue = await db.all();
    state.lastRepair = { code, keep: { asset: d.asset, assetOther: d.assetOther, priority: d.priority } };
    state.rdraft = freshRepair({ priority: d.priority }); saveRdraft();
    go('rsaved');
    if (navigator.onLine) sync();
  };
}

function renderRSaved() {
  const s = state.lastRepair || {};
  return `<div class="card saved"><h2>${repairsFull() ? 'Saved' : 'Sent. Thanks.'}</h2><p>Reference</p><span class="tag xl">${esc(s.code)}</span>
    <p class="muted">${esc(locLabel(state.loc))}. If there's no signal it uploads when you're back in range.</p></div>
    <button class="big" id="another" style="margin-top:12px">Log another here</button>
    <div class="row" style="margin-top:10px"><button class="ghost" id="newLoc">New location</button><button class="ghost" id="home">Home</button></div>`;
}
function bindRSaved() {
  $('#another').onclick = () => { state.rdraft = freshRepair(state.lastRepair && state.lastRepair.keep); saveRdraft(); go('rlog'); };
  $('#newLoc').onclick = () => go('loc');
  $('#home').onclick = () => go('rhome', 'rhome');
}

/* ---- find / my repairs ---- */

function renderRFind() {
  const q = norm(state.rsearch || '');
  const waiting = state.queue.filter(x => x.action === 'repairLog').length;
  const list = repairRecs().filter(r => !q || [r.code, r.location, r.asset, r.defect, r.vp, r.status].some(v => norm(v).includes(q))).slice().reverse();
  const head = `<div class="card"><h2>${repairsFull() ? 'Find and edit' : 'My repairs'}</h2>
    <input id="rsearch" type="search" placeholder="Code, location, item or quote number" value="${esc(state.rsearch || '')}">
    <p class="muted">${list.length} found${waiting ? ` · ${waiting} waiting to upload` : ''}${repairsFull() ? '' : '. Received → Quoted → Approved → Fixed.'}</p></div>`;
  if (!repairsFull()) return head + list.map(r => `<div class="card item"><div class="grow"><div class="title"><span class="tag">${esc(r.code)}</span> ${esc(r.asset)}${r.qty > 1 ? ' × ' + r.qty : ''}</div>
    <div class="muted">${esc(r.site)} · ${esc(r.location)} · ${fmtDate(r.loggedAt)}<br>${esc(r.defect)}</div></div><span class="pill">${esc(r.status)}</span></div>`).join('');
  const groups = {};
  list.forEach(r => (groups[r.status] = groups[r.status] || []).push(r));
  return head + REPAIR_STATUSES.filter(st => groups[st]).map(st => `<div class="card"><div class="group">${esc(st)} · ${groups[st].length}${groups[st].some(r => r.price) ? ' · ' + money(groups[st].reduce((t, r) => t + r.price, 0)) : ''}</div>
    ${groups[st].map(r => `<button class="item btn" data-redit="${esc(r.code)}"><div class="grow"><div class="title"><span class="tag">${esc(r.code)}</span> ${esc(r.asset)}${r.qty > 1 ? ' × ' + r.qty : ''}</div>
      <div class="muted">${esc(r.location)} · ${esc(r.priority)}${r.price ? ' · ' + money(r.price) : ' · no price'}${r.vp ? ' · ' + esc(r.vp) : ''}</div></div><span class="muted">›</span></button>`).join('')}</div>`).join('');
}
function bindRFind() {
  const s = $('#rsearch');
  s.oninput = () => { state.rsearch = s.value; clearTimeout(bindRFind._t); bindRFind._t = setTimeout(() => { render(); const n = $('#rsearch'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  $$('[data-redit]').forEach(b => b.onclick = () => openREdit(b.dataset.redit, 'rfind'));
}

function openREdit(code, from) {
  const r = repairRecs().find(x => x.code === code);
  if (!r) return;
  state.redit = { from, orig: r, d: { asset: r.asset, defect: r.defect, priority: r.priority, qty: r.qty, price: r.price || '', status: r.status, vp: r.vp, notes: r.notes }, newBefore: '', newAfter: '', confirmRemove: false };
  go('redit', from === 'rjobs' ? 'rhome' : 'rfind');
}

function renderREdit() {
  const e = state.redit; if (!e) return renderRFind();
  const r = e.orig, d = e.d;
  if (r.status === 'Invoiced') return `<button class="ghost" id="back">‹ Back</button><div class="card" style="margin-top:10px"><span class="tag md">${esc(r.code)}</span><p>Invoiced. Changes can only be made in the sheet.</p></div>`;
  return `<button class="ghost" id="back">‹ Back</button>
  <div class="card" style="margin-top:10px"><span class="tag md">${esc(r.code)}</span>
    <p class="muted">${esc(r.site)} · ${esc(r.location)}<br>Logged ${fmtDate(r.loggedAt)} by ${esc(r.loggedBy)}${r.doneDate ? ` · done ${fmtDate(r.doneDate)} by ${esc(r.doneBy)}` : ''}</p>
    <div class="row">${r.before ? `<a class="ghost" href="${esc(r.before)}" target="_blank" rel="noopener">Photo</a>` : ''}${r.after ? `<a class="ghost" href="${esc(r.after)}" target="_blank" rel="noopener">After photo</a>` : ''}</div></div>
  <div class="card"><h2>Add photos</h2><div class="row">
    <div>${e.newBefore ? `<div class="thumb wide"><img src="${e.newBefore}"></div>` : `<button class="ghost wide" data-rshot="newBefore">+ Photo</button>`}</div>
    <div>${e.newAfter ? `<div class="thumb wide"><img src="${e.newAfter}"></div>` : `<button class="ghost wide" data-rshot="newAfter">+ After photo</button>`}</div></div></div>
  <div class="card"><h2>Details</h2>
    <label>Item</label><input id="e_asset" value="${esc(d.asset)}">
    <label>Fault</label><textarea id="e_defect">${esc(d.defect)}</textarea>
    <div class="row"><div><label>Qty</label><input id="e_qty" type="number" inputmode="numeric" value="${esc(d.qty)}"></div>
      <div><label>Priority</label><select id="e_priority">${PRIORITIES.map(x => `<option ${x === d.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    <div class="row"><div><label>Price ($ ex GST)</label><input id="e_price" type="number" inputmode="decimal" value="${esc(d.price)}"></div>
      <div><label>Quote / VP</label><input id="e_vp" value="${esc(d.vp)}" autocapitalize="characters" placeholder="VP26125"></div></div>
    <label>Status</label><div class="chips">${REPAIR_STATUSES.map(x => `<button class="chip ${d.status === x ? 'on' : ''}" data-st="${x}">${x}</button>`).join('')}</div>
    <label>Notes</label><textarea id="e_notes">${esc(d.notes)}</textarea></div>
  <div class="card"><button class="big" id="saveRE">Save changes</button>
    <button class="ghost danger" id="removeR" style="margin-top:10px;width:100%">${e.confirmRemove ? 'Tap again to remove' : 'Remove this repair'}</button></div>`;
}
function bindREdit() {
  const e = state.redit; if (!e) return bindRFind();
  const back = () => { const f = e.from || 'rfind'; state.redit = null; go(f, f === 'rjobs' ? 'rhome' : 'rfind'); };
  $('#back').onclick = back;
  if (e.orig.status === 'Invoiced') return;
  const read = () => {
    const d = e.d;
    d.asset = $('#e_asset').value.trim(); d.defect = $('#e_defect').value.trim(); d.qty = Number($('#e_qty').value) || 1;
    d.priority = $('#e_priority').value; d.price = $('#e_price').value; d.vp = $('#e_vp').value.trim().toUpperCase(); d.notes = $('#e_notes').value;
  };
  $$('[data-rshot]').forEach(b => b.onclick = () => { read(); takePhoto(data => { e[b.dataset.rshot] = data; render(); }); });
  $$('[data-st]').forEach(b => b.onclick = () => { read(); e.d.status = b.dataset.st; render(); });
  $('#saveRE').onclick = async () => {
    read();
    const r = e.orig, d = e.d, fields = {};
    ['asset', 'defect', 'priority', 'status', 'vp', 'notes'].forEach(k => { if ((d[k] || '') !== (r[k] || '')) fields[k] = d[k]; });
    if (Number(d.qty) !== Number(r.qty)) fields.qty = d.qty;
    if ((Number(d.price) || 0) !== (r.price || 0)) fields.price = Number(d.price) || 0;
    if (fields.status === 'Done' && !e.newAfter && !r.after) { toast('Add an after photo to mark it done'); return; }
    if (!Object.keys(fields).length && !e.newBefore && !e.newAfter) { toast('No changes'); return; }
    const recordKey = uid();
    await db.put({ recordKey, action: 'repairUpdate', createdAt: Date.now(), price: 0, label: `Edit · ${r.code}`,
      record: { recordKey, code: r.code, fields, photos: e.newBefore ? [e.newBefore] : [], afterPhotos: e.newAfter ? [e.newAfter] : [] } });
    Object.assign(r, fields); store.set(LS.config, state.config);
    state.queue = await db.all(); toast(`${r.code} updated`); back();
    if (navigator.onLine) sync();
  };
  $('#removeR').onclick = async () => {
    if (!e.confirmRemove) { read(); e.confirmRemove = true; render(); return; }
    const r = e.orig, recordKey = uid();
    await db.put({ recordKey, action: 'repairUpdate', createdAt: Date.now(), price: 0, label: `Remove · ${r.code}`, record: { recordKey, code: r.code, remove: true } });
    state.config.repairs.records = repairRecs().filter(x => x.code !== r.code); store.set(LS.config, state.config);
    state.queue = await db.all(); toast(`${r.code} removed`); back();
    if (navigator.onLine) sync();
  };
}

/* ---- jobs to do (PO received) ---- */

function renderRJobs() {
  const done = new Set(state.queue.filter(q => q.action === 'repairDone').map(q => q.record.code));
  const jobs = repairRecs().filter(r => r.status === 'PO Received' && !done.has(r.code));
  return `<button class="ghost" id="back">‹ Home</button>` + (jobs.length ? jobs.map(j => `<div class="card item"><div class="grow"><div class="title"><span class="tag">${esc(j.code)}</span> ${esc(j.asset)}${j.qty > 1 ? ' × ' + j.qty : ''}</div>
      <div class="muted">${esc(j.location)} · ${esc(j.vp || 'no quote number')} · ${esc(j.priority)}<br>${esc(j.defect)}</div>
      ${j.before ? `<a class="muted" href="${esc(j.before)}" target="_blank" rel="noopener">Photo</a>` : ''}</div>
      <button class="ghost" data-rdone="${esc(j.code)}">Done</button></div>`).join('')
    : `<div class="card" style="margin-top:10px"><h2>Jobs to do</h2><p>Nothing with a PO yet. Set a repair to PO Received in Find and it shows up here.</p></div>`);
}
function bindRJobs() {
  $('#back').onclick = () => go('rhome', 'rhome');
  $$('[data-rdone]').forEach(b => b.onclick = () => {
    const job = repairRecs().find(j => j.code === b.dataset.rdone);
    takePhoto(async photo => {
      const recordKey = uid();
      await db.put({ recordKey, action: 'repairDone', createdAt: Date.now(), price: 0, label: `Done · ${job.code} · ${job.location}`,
        record: { recordKey, code: job.code, photos: [photo], capturedAt: new Date().toISOString() } });
      state.queue = await db.all(); render(); toast(`${job.code} marked done`);
      if (navigator.onLine) sync();
    });
  });
}

VIEWS.repairs = {
  rhome: [renderRHome, bindRHome], rlog: [renderRLog, bindRLog], rsaved: [renderRSaved, bindRSaved],
  rfind: [renderRFind, bindRFind], redit: [renderREdit, bindREdit], rjobs: [renderRJobs, bindRJobs],
};
