/* Frontline - SIT (placeholder register) and the back office (dashboard, planning, locations, users, history) */
'use strict';

/* ================= SIT ================= */

const SIT_STATUSES = ['Planned', 'In progress', 'Report due', 'Complete'];
const sitCfg = () => (state.config && state.config.sit) || { level: 'none', tests: [] };

function renderSit() {
  const tests = sitCfg().tests.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const edit = sitCfg().level === 'edit';
  if (state.sitEdit) return renderSitForm();
  return `<div class="bank s"><p class="hello">System interface tests</p><div class="amount">${tests.filter(t => t.status !== 'Complete').length}</div>
      <p class="sub">open test${tests.length === 1 ? '' : 's'} · ${tests.length} on the register</p></div>
    ${edit ? `<button class="tile primary" id="sitNew"><span class="ico">${ICONS.plus}</span><span><strong>Add a test</strong><span class="d">Building, date, engineer</span></span></button>` : ''}
    ${tests.length ? tests.map(t => `<button class="card item btn" data-sit="${esc(t.id)}" ${edit ? '' : 'disabled'}><div class="grow"><div class="title">${esc(t.building)}${buildingName(t.site, t.building) ? ' · ' + esc(buildingName(t.site, t.building)) : ''}</div>
      <div class="muted">${esc(t.site)} · ${t.date ? fmtDate(t.date) : 'no date'}${t.engineer ? ' · ' + esc(t.engineer) : ''}${t.notes ? '<br>' + esc(t.notes) : ''}</div>
      ${t.report ? `<a class="muted" href="${esc(t.report)}" target="_blank" rel="noopener">Report</a>` : ''}</div><span class="pill">${esc(t.status)}</span></button>`).join('')
      : `<div class="card"><p>No tests yet. The full SIT report and matrix will be built in here after the first test.</p></div>`}
    <p class="muted center">Coming next: the SIT report and test matrix, filled in on site.</p>`;
}
function bindSit() {
  if (state.sitEdit) return bindSitForm();
  const n = $('#sitNew'); if (n) n.onclick = () => { state.sitEdit = { site: sitesList()[0], building: '', date: new Date().toISOString().slice(0, 10), engineer: '', status: 'Planned', report: '', notes: '' }; render(); };
  $$('[data-sit]').forEach(b => b.onclick = e => { if (e.target.tagName === 'A') return; state.sitEdit = Object.assign({}, sitCfg().tests.find(t => t.id === b.dataset.sit)); render(); });
}
function renderSitForm() {
  const t = state.sitEdit;
  return `<button class="ghost" id="back">‹ Back</button><div class="card" style="margin-top:10px"><h2>${t.id ? esc(t.id) : 'New test'}</h2>
    ${sitesList().length > 1 ? `<div class="chips">${sitesList().map(x => `<button class="chip ${t.site === x ? 'on' : ''}" data-ssite="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
    <label>Building</label><select id="s_b"><option value="">Choose…</option>${buildingList(t.site).map(b => `<option value="${esc(b)}" ${b === t.building ? 'selected' : ''}>${esc(b)}${buildingName(t.site, b) ? ' · ' + esc(buildingName(t.site, b)) : ''}</option>`).join('')}</select>
    <div class="row"><div><label>Test date</label><input id="s_d" type="date" value="${esc(t.date)}"></div><div><label>Engineer</label><input id="s_e" value="${esc(t.engineer)}"></div></div>
    <label>Status</label><div class="chips">${SIT_STATUSES.map(x => `<button class="chip ${t.status === x ? 'on' : ''}" data-sst="${x}">${x}</button>`).join('')}</div>
    <label>Report link <span class="muted">(Drive link, for now)</span></label><input id="s_r" value="${esc(t.report)}" placeholder="https://drive.google.com/…">
    <label>Notes</label><textarea id="s_n">${esc(t.notes)}</textarea>
    <button class="big" id="s_save" style="margin-top:12px">Save test</button></div>`;
}
function bindSitForm() {
  const t = state.sitEdit;
  const read = () => { t.building = $('#s_b').value; t.date = $('#s_d').value; t.engineer = $('#s_e').value.trim(); t.report = $('#s_r').value.trim(); t.notes = $('#s_n').value; };
  $('#back').onclick = () => { state.sitEdit = null; render(); };
  $$('[data-ssite]').forEach(b => b.onclick = () => { read(); t.site = b.dataset.ssite; t.building = ''; render(); });
  $$('[data-sst]').forEach(b => b.onclick = () => { read(); t.status = b.dataset.sst; render(); });
  $('#s_save').onclick = async () => {
    read();
    if (!t.building) { toast('Pick the building'); return; }
    const recordKey = uid();
    if (!t.id) t.id = 'SIT-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + (10 + Math.floor(Math.random() * 90));
    await db.put({ recordKey, action: 'sitSave', createdAt: Date.now(), price: 0, label: `SIT · ${t.building} · ${t.date}`, record: Object.assign({}, t) });
    const list = sitCfg().tests, i = list.findIndex(x => x.id === t.id);
    if (i >= 0) list[i] = Object.assign({}, t); else list.push(Object.assign({}, t));
    store.set(LS.config, state.config);
    state.queue = await db.all(); state.sitEdit = null; toast('Test saved'); render();
    if (navigator.onLine) sync();
  };
}
VIEWS.sit = { sit: [renderSit, bindSit] };

/* ================= back office ================= */

const office = { dash: null, site: '', view: 'passive', users: null, loading: false, err: '', newCode: null, userEdit: null };

async function loadDash(force) {
  if (office.loading) return;
  if (office.dash && !force && office.dash.site === office.site) return;
  office.loading = true; office.err = ''; render();
  try { office.dash = await api('dashboard', { site: office.site }); }
  catch (e) { office.err = navigator.onLine ? e.message : 'The back office needs signal.'; }
  office.loading = false; render();
}
const k$ = n => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : money(n);

function officeHead(title, extra) {
  return `<div class="ohead"><h2>${title}</h2><div class="chips">${['', ...sitesList()].map(x => `<button class="chip ${office.site === x ? 'on' : ''}" data-osite="${esc(x)}">${x || 'All sites'}</button>`).join('')}
    <button class="ghost" id="oref">Refresh</button></div>${extra || ''}</div>`;
}
function bindOfficeHead() {
  $$('[data-osite]').forEach(b => b.onclick = () => { office.site = b.dataset.osite; loadDash(true); });
  const r = $('#oref'); if (r) r.onclick = () => { if (state.screen === 'users') { office.users = null; loadUsers(); } else { refreshConfig(true); loadDash(true); } };
}
function officeWait() {
  if (office.err) return `<div class="card"><p class="err">${esc(office.err)}</p><button class="ghost" id="oretry">Try again</button></div>`;
  return `<div class="card"><p class="muted">Loading the numbers…</p></div>`;
}
function bindOfficeWait() { const r = $('#oretry'); if (r) r.onclick = () => loadDash(true); }

function bars(items, max, fmt) {
  return `<div class="bars">${items.map(i => `<div class="barrow"><span class="bl">${esc(i.label)}</span><span class="bt"><span class="bf ${i.cls || ''}" style="width:${max ? Math.max(1, Math.round(i.value / max * 100)) : 0}%"></span></span><span class="bv">${fmt(i)}</span></div>`).join('')}</div>`;
}

function monthChart(months, thisMonth, bank, monthMin) {
  const recent = months.filter(m => m.month >= shiftMonth(thisMonth, -8) && (m.done + m.open > 0 || m.month <= thisMonth)).slice(0, 18);
  if (!recent.length) return '<p class="muted">No months yet.</p>';
  const max = Math.max(monthMin, ...recent.map(m => m.done + m.open));
  const H = 160, W = Math.max(recent.length * 46, 300);
  const y = v => H - Math.round(v / max * (H - 10));
  const bw = 30;
  const target = y(monthMin);
  return `<div class="chartwrap"><svg viewBox="0 0 ${W} ${H + 34}" role="img" aria-label="Work by month: invoiced and planned">
    <line x1="0" x2="${W}" y1="${target}" y2="${target}" class="tgt"/><text x="4" y="${target - 4}" class="tl">target ${k$(monthMin)}</text>
    ${recent.map((m, i) => {
      const x = i * 46 + 8, d = y(m.done), o = y(m.done + m.open);
      return `<g><title>${m.month}: ${money(m.done)} done/invoiced, ${money(m.open)} planned or open</title>
        ${m.done ? `<rect x="${x}" y="${d}" width="${bw}" height="${H - d}" class="bdone"/>` : ''}
        ${m.open ? `<rect x="${x}" y="${o}" width="${bw}" height="${d - o}" class="bopen"/>` : ''}
        <text x="${x + bw / 2}" y="${H + 14}" text-anchor="middle" class="tl ${m.month === thisMonth ? 'now' : ''}">${monthShort(m.month)}</text>
        <text x="${x + bw / 2}" y="${H + 28}" text-anchor="middle" class="tl">${k$(m.done + m.open)}</text></g>`;
    }).join('')}</svg></div>
    <p class="legend"><span class="sw bdone"></span> Done or invoiced <span class="sw bopen"></span> Planned or open · plus ${money(bank)} in the bank not on a PO yet</p>`;
}
function shiftMonth(m, n) { const [Y, M] = m.split('-').map(Number); const d = new Date(Y, M - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function monthShort(m) { const [Y, M] = m.split('-').map(Number); return new Date(Y, M - 1, 1).toLocaleDateString('en-AU', { month: 'short' }) + (M === 1 ? ' ' + String(Y).slice(2) : ''); }

function renderDash() {
  const D = office.dash;
  if (!D || office.loading) return officeHead('Dashboard') + officeWait();
  const v = office.view, P = D.passive, Rp = D.repairs;
  const tabs = `<div class="chips">${[['passive', 'Passive fire'], ['repairs', 'Fire repairs']].map(([k, l]) => `<button class="chip ${v === k ? 'on' : ''}" data-oview="${k}">${l}</button>`).join('')}</div>`;
  const todo = [];
  if (D.todo.requested) todo.push(`<button class="todo" data-go2="passive:requests">${D.todo.requested} client penetration request${D.todo.requested === 1 ? '' : 's'} to price</button>`);
  if (D.todo.repairsToPrice) todo.push(`<button class="todo" data-go2="repairs:rfind">${D.todo.repairsToPrice} repair${D.todo.repairsToPrice === 1 ? '' : 's'} with no price</button>`);
  if (D.todo.unconfirmed && perms().admin) todo.push(`<button class="todo" data-go2="office:locs">${D.todo.unconfirmed} unconfirmed location${D.todo.unconfirmed === 1 ? '' : 's'} to tidy</button>`);
  let body;
  if (v === 'passive') {
    const order = ['Requested', 'Scouted', 'Allocated', 'Quoted', 'PO Received', 'Done', 'Invoiced'];
    const pipe = order.map(st => {
      const pen = P.penStatus[st] || { n: 0, v: 0 }, po = P.poStatus[st];
      const val = (st === 'Requested' || st === 'Scouted') ? pen.v : (po ? po.v : pen.v);
      const n = (st === 'Requested' || st === 'Scouted') ? pen.n : (po ? po.n : 0);
      return { label: st, value: val, n, unit: (st === 'Requested' || st === 'Scouted') ? 'penetration' : 'PO' };
    });
    const maxPipe = Math.max(...pipe.map(p => p.value), 1);
    const bmax = Math.max(...P.buildings.map(b => b.bank + b.open + b.done), 1);
    body = `<div class="metrics">
      <div class="metric big"><span>Months of work ahead</span><strong>${P.monthsAhead.toFixed(1)}</strong><em>${P.plannedMonths} planned + ${P.bankMonths.toFixed(1)} in the bank</em></div>
      <div class="metric"><span>In the bank</span><strong>${k$(P.bank)}</strong><em>${P.bankN} penetrations not on a PO</em></div>
      <div class="metric"><span>Planned, not done</span><strong>${k$(P.plannedValue)}</strong><em>from ${monthShort(D.thisMonth)} on</em></div>
      <div class="metric"><span>Monthly target</span><strong>${k$(D.monthMin)}–${k$(D.monthMax)}</strong><em>${D.site || 'all sites'}</em></div></div>
      <div class="ogrid"><div class="card"><h3>Work by month</h3>${monthChart(P.months, D.thisMonth, P.bank, D.monthMin)}</div>
      <div class="card"><h3>Pipeline</h3>${bars(pipe.map(p => ({ label: p.label, value: p.value, cls: p.label === 'Scouted' ? 'hot' : '' , n: p.n, unit: p.unit })), maxPipe, i => `${money(i.value)} <small>${i.n} ${i.unit}${i.n === 1 ? '' : 's'}</small>`)}</div></div>
      <div class="card"><h3>By building</h3>
        <table class="otable"><thead><tr><th>Building</th><th>In the bank</th><th>Open POs</th><th>Done</th><th class="w40"></th></tr></thead><tbody>
        ${P.buildings.map(b => `<tr><td><strong>${esc(b.building)}</strong> <span class="muted">${esc(buildingName(b.site, b.building) || b.site)}</span></td><td>${money(b.bank)}</td><td>${money(b.open)}</td><td>${money(b.done)}</td>
          <td><span class="stack"><span class="hot" style="width:${b.bank / bmax * 100}%"></span><span class="op" style="width:${b.open / bmax * 100}%"></span><span class="dn" style="width:${b.done / bmax * 100}%"></span></span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No penetrations yet.</td></tr>'}
        </tbody></table><p class="muted">Only penetrations logged in the app. Past jobs imported from the register are in History and the month chart.</p></div>`;
  } else {
    const order = ['Logged', 'Quoted', 'PO Received', 'Done', 'Invoiced'];
    const items = order.map(st => ({ label: st, value: (Rp.status[st] || {}).v || 0, n: (Rp.status[st] || {}).n || 0 }));
    const mx = Math.max(...items.map(i => i.value), 1);
    const open = (Rp.status['Quoted'] || {}).v || 0, po = (Rp.status['PO Received'] || {}).v || 0;
    body = `<div class="metrics">
      <div class="metric big"><span>Quoted, waiting on a PO</span><strong>${k$(open)}</strong><em>${(Rp.status['Quoted'] || {}).n || 0} repairs</em></div>
      <div class="metric"><span>PO received, to do</span><strong>${k$(po)}</strong><em>${(Rp.status['PO Received'] || {}).n || 0} repairs</em></div>
      <div class="metric"><span>Logged to quote</span><strong>${(Rp.status['Logged'] || {}).n || 0}</strong><em>${Rp.toPrice} with no price</em></div>
      <div class="metric"><span>Total repairs</span><strong>${Rp.n}</strong><em>${D.site || 'all sites'}</em></div></div>
      <div class="card"><h3>Pipeline</h3>${bars(items, mx, i => `${money(i.value)} <small>${i.n} repair${i.n === 1 ? '' : 's'}</small>`)}</div>`;
  }
  return officeHead('Dashboard') + tabs + (todo.length ? `<div class="todos">${todo.join('')}</div>` : '') + body +
    `<p class="muted center">Updated ${new Date(D.serverTime).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })}</p>`;
}
function bindDash() {
  bindOfficeHead(); bindOfficeWait();
  if (!office.dash && !office.loading && !office.err) loadDash();
  $$('[data-oview]').forEach(b => b.onclick = () => { office.view = b.dataset.oview; render(); });
  $$('[data-go2]').forEach(b => b.onclick = () => {
    const [area, screen] = b.dataset.go2.split(':');
    if (area === 'office') { go(screen, screen); return; }
    state.area = area; store.set(LS.area, area); state.screen = screen; state.tab = homeOf(area); render();
  });
}

/* ---- plan months ---- */

function renderPlan() {
  const D = office.dash;
  if (!D || office.loading) return officeHead('Plan months') + officeWait();
  const rows = D.planRows || [];
  const head = rows[0] || [];
  const posBy = {};
  D.pos.forEach(p => (posBy[p.month] = posBy[p.month] || []).push(p));
  return officeHead('Plan months') + `<div class="card"><p>Planning takes scouted penetrations from the bank and bundles them into POs: one room per PO, $2.5–3.5k each, until the month reaches the target. The site alternates as set on the Monthly Plan tab.</p>
    ${D.nextMonth ? `<button class="big" id="planNext">Plan ${monthShort(D.nextMonth)} ${D.nextMonth.slice(0, 4)}</button>` : '<p class="muted">Every month on the Monthly Plan tab already has POs.</p>'}
    <div id="planOut"></div></div>
    <div class="card"><table class="otable"><thead><tr>${head.slice(0, 7).map(h => `<th>${esc(h)}</th>`).join('')}<th></th></tr></thead><tbody>
    ${rows.slice(1).filter(r => r[0]).map(r => `<tr class="${r[0] === D.thisMonth ? 'now' : ''}">${r.slice(0, 7).map(c => `<td>${esc(c)}</td>`).join('')}
      <td>${(posBy[r[0]] || []).some(p => p.status === 'Allocated') ? `<button class="ghost small" data-unplan="${esc(r[0])}">Undo</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}
function bindPlan() {
  bindOfficeHead(); bindOfficeWait();
  if (!office.dash && !office.loading && !office.err) loadDash();
  const p = $('#planNext');
  if (p) p.onclick = async () => {
    p.disabled = true; p.textContent = 'Planning…';
    try { const out = await api('plan', { month: office.dash.nextMonth }); office.lastPlan = out.summary; await loadDash(true); refreshConfig(true); }
    catch (e) { toast(e.message, 5000); p.disabled = false; }
  };
  if (office.lastPlan && $('#planOut')) $('#planOut').innerHTML = `<pre class="summary">${esc(office.lastPlan)}</pre>`;
  $$('[data-unplan]').forEach(b => b.onclick = async () => {
    if (b.textContent !== 'Sure?') { b.textContent = 'Sure?'; return; }
    try { const out = await api('unplan', { month: b.dataset.unplan }); toast(out.summary, 4000); await loadDash(true); refreshConfig(true); } catch (e) { toast(e.message); }
  });
}

/* ---- tidy locations ---- */

function renderLocs() {
  const locs = (state.config.locations || []).filter(l => !office.site || l.site === office.site);
  const unconf = locs.filter(l => l.status === 'Unconfirmed');
  const conf = locs.filter(l => l.status !== 'Unconfirmed');
  const sites = office.site ? [office.site] : sitesList();
  const t = state.locTidy;
  return officeHead('Locations') + `<div class="card"><h3>To tidy · ${unconf.length}</h3>
    <p class="muted">Anything typed in that isn't on our list. Match it to an existing location, or fix the spelling and add it as new. Every job there moves with it. Tag codes on the wall don't change.</p>
    ${unconf.length ? unconf.map((l, i) => {
      const open = t && t.i === i;
      return `<div class="tidy ${open ? 'open' : ''}"><div class="item"><div class="grow"><div class="title">${esc(l.building)} · ${esc(l.level)} · ${esc(l.room)}</div>
        <div class="muted">${esc(l.site)} · added by ${esc(l.addedBy || 'unknown')}</div></div>${open ? '' : `<button class="ghost" data-tidy="${i}">Sort it</button>`}</div>
        ${open ? `<div class="row3">
          <div><label>Match to existing</label><select id="t_match"><option value="">Choose…</option>${conf.filter(c => c.site === l.site).map((c, j) => `<option value="${j}">${esc(c.building)} · ${esc(c.level)} · ${esc(c.room)}</option>`).join('')}</select>
            <button class="big" id="t_merge" style="margin-top:8px">Match</button></div>
          <div><label>Or add as new</label>
            <div class="row"><input id="t_b" value="${esc(l.building)}" placeholder="Code"><input id="t_bn" value="${esc(buildingName(l.site, l.building))}" placeholder="Full building name"></div>
            <div class="row"><input id="t_l" value="${esc(normLevel(l.level))}" placeholder="Level"><input id="t_r" value="${esc(normRoom(l.room))}" placeholder="Room"></div>
            <button class="big secondary" id="t_new" style="margin-top:8px">Add as new location</button></div></div>
          <button class="ghost" id="t_cancel">Cancel</button>` : ''}</div>`;
    }).join('') : '<p>All tidy.</p>'}</div>
  <div class="card"><h3>Buildings</h3><p class="muted">Codes show in the app's dropdown. Add the full name so reports read properly.</p>
    <table class="otable"><thead><tr><th>Site</th><th>Code</th><th>Full name</th><th>Rooms</th></tr></thead><tbody>
    ${sites.map(s => buildingList(s).map(b => `<tr><td>${esc(s)}</td><td><strong>${esc(b)}</strong></td><td><input class="bname" data-bs="${esc(s)}" data-bc="${esc(b)}" value="${esc(buildingName(s, b))}" placeholder="Add full name"></td>
      <td>${conf.filter(c => c.site === s && c.building === b).length}</td></tr>`).join('')).join('')}
    </tbody></table>
    <div class="row3" style="margin-top:10px"><select id="nb_s">${sitesList().map(s => `<option>${esc(s)}</option>`).join('')}</select><input id="nb_c" placeholder="New code, e.g. ONJ"><input id="nb_n" placeholder="Full name"><button class="ghost" id="nb_add">Add building</button></div></div>
  <div class="card"><h3>All rooms · ${conf.length}</h3><table class="otable"><thead><tr><th>Site</th><th>Building</th><th>Level</th><th>Room</th><th>Added by</th></tr></thead><tbody>
    ${conf.slice().sort((a, b) => (a.site + a.building + a.level + a.room).localeCompare(b.site + b.building + b.level + b.room)).map(c => `<tr><td>${esc(c.site)}</td><td>${esc(c.building)}</td><td>${esc(c.level)}</td><td>${esc(c.room)}</td><td class="muted">${esc(c.addedBy)}</td></tr>`).join('')}
    </tbody></table></div>`;
}
function bindLocs() {
  bindOfficeHead();
  const locs = (state.config.locations || []).filter(l => !office.site || l.site === office.site);
  const unconf = locs.filter(l => l.status === 'Unconfirmed'), conf = locs.filter(l => l.status !== 'Unconfirmed');
  $$('[data-tidy]').forEach(b => b.onclick = () => { state.locTidy = { i: Number(b.dataset.tidy) }; render(); });
  const c = $('#t_cancel'); if (c) c.onclick = () => { state.locTidy = null; render(); };
  const run = async (from, to, bname) => {
    try {
      const out = await api('locResolve', { from, to, buildingName: bname });
      toast(`Done. ${out.moved} job${out.moved === 1 ? '' : 's'} moved to ${out.to.building} · ${out.to.level} · ${out.to.room}`, 4000);
      state.locTidy = null; office.dash = null; await refreshConfig(true);
    } catch (e) { toast(e.message, 4000); }
  };
  const m = $('#t_merge');
  if (m) m.onclick = () => {
    const from = unconf[state.locTidy.i], j = $('#t_match').value;
    if (j === '') { toast('Pick a location to match to'); return; }
    const to = conf.filter(x => x.site === from.site)[Number(j)];
    run(from, to);
  };
  const n = $('#t_new');
  if (n) n.onclick = () => {
    const from = unconf[state.locTidy.i];
    run(from, { site: from.site, building: normBuildingText($('#t_b').value), level: normLevel($('#t_l').value), room: normRoom($('#t_r').value) }, $('#t_bn').value.trim());
  };
  $$('.bname').forEach(inp => inp.onchange = async () => {
    try { await api('buildingSave', { site: inp.dataset.bs, code: inp.dataset.bc, name: inp.value.trim() }); toast('Saved'); refreshConfig(true); } catch (e) { toast(e.message); }
  });
  $('#nb_add').onclick = async () => {
    const code = normBuildingText($('#nb_c').value);
    if (!code) { toast('Enter the building code'); return; }
    try { await api('buildingSave', { site: $('#nb_s').value, code, name: $('#nb_n').value.trim() }); toast(`${code} added`); refreshConfig(); } catch (e) { toast(e.message); }
  };
}

/* ---- users and permissions ---- */

const ROLE_PRESETS = {
  admin: { passive: 'full', repairs: 'full', sit: 'edit', dashboard: true, note: 'Everything, including users and planning' },
  staff: { passive: 'full', repairs: 'full', sit: 'edit', dashboard: true, note: 'Your team: scouting, pricing, jobs' },
  client: { passive: 'log', repairs: 'none', sit: 'none', dashboard: false, note: 'Logs items and never sees prices' },
  engineer: { passive: 'none', repairs: 'log', sit: 'edit', dashboard: false, note: 'SIT tests, can log repairs they spot' },
};
const LEVEL_LABEL = { none: 'No access', log: 'Log only (no prices)', full: 'Full (prices, edit)', view: 'View', edit: 'Add and edit' };

async function loadUsers() {
  office.loading = true; office.err = ''; render();
  try { const out = await api('users'); office.users = out.users; }
  catch (e) { office.err = navigator.onLine ? e.message : 'The back office needs signal.'; }
  office.loading = false; render();
}

function renderUsers() {
  if (office.newCode) return `<div class="card codecard"><h2>Login code for ${esc(office.newCode.name)}</h2><div class="bigcode">${esc(office.newCode.code)}</div>
    <p>Send them this code and the app link: <strong>jeffbuilt.github.io/frontline-passive</strong></p>
    <p class="muted">This is the only time the code is shown. If it's lost, reset it.</p>
    <div class="row"><button class="big" id="copyCode">Copy message</button><button class="ghost" id="codeDone">Done</button></div></div>`;
  if (office.userEdit) return renderUserForm();
  if (!office.users) return officeHead('Users') + officeWait();
  return officeHead('Users') + `<button class="tile primary" id="userNew"><span class="ico">${ICONS.plus}</span><span><strong>Add a login</strong><span class="d">Team, client or engineer</span></span></button>
    <div class="card"><table class="otable"><thead><tr><th>Name</th><th>Role</th><th>Passive fire</th><th>Repairs</th><th>SIT</th><th>Sites</th><th></th></tr></thead><tbody>
    ${office.users.map((u, i) => `<tr class="${u.active ? '' : 'off'}"><td><strong>${esc(u.name)}</strong><br><span class="muted">${esc(u.company || u.email)}</span></td><td>${esc(u.role)}${u.active ? '' : ' · off'}</td>
      <td>${esc(u.passive)}</td><td>${esc(u.repairs)}</td><td>${esc(u.sit)}</td><td>${esc(u.sites.join(', '))}</td>
      <td class="nowrap"><button class="ghost small" data-uedit="${i}">Edit</button> <button class="ghost small" data-ureset="${i}">New code</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
function bindUsers() {
  if (office.newCode) {
    $('#copyCode').onclick = () => {
      const msg = `Hi ${office.newCode.name}, here's your login for the Frontline app.\nOpen: https://jeffbuilt.github.io/frontline-passive/\nCode: ${office.newCode.code}\nOn a phone, add it to your home screen after you sign in.`;
      (navigator.clipboard ? navigator.clipboard.writeText(msg) : Promise.reject()).then(() => toast('Copied'), () => toast('Copy it by hand'));
    };
    $('#codeDone').onclick = () => { office.newCode = null; render(); };
    return;
  }
  if (office.userEdit) return bindUserForm();
  bindOfficeHead(); bindOfficeWait();
  if (!office.users && !office.loading && !office.err) loadUsers();
  const n = $('#userNew'); if (n) n.onclick = () => { office.userEdit = Object.assign({ isNew: true, name: '', email: '', company: '', role: 'client', active: true, sites: sitesList().slice() }, ROLE_PRESETS.client); render(); };
  $$('[data-uedit]').forEach(b => b.onclick = () => { office.userEdit = Object.assign({ isNew: false }, office.users[Number(b.dataset.uedit)]); render(); });
  $$('[data-ureset]').forEach(b => b.onclick = async () => {
    if (b.textContent !== 'Sure?') { b.textContent = 'Sure?'; return; }
    const u = office.users[Number(b.dataset.ureset)];
    try { const out = await api('userReset', { name: u.name }); office.newCode = { name: out.name, code: out.code }; render(); } catch (e) { toast(e.message); }
  });
}
function renderUserForm() {
  const u = office.userEdit;
  const sel = (k, lv) => `<select data-uk="${k}">${lv.map(x => `<option value="${x}" ${u[k] === x ? 'selected' : ''}>${LEVEL_LABEL[x]}</option>`).join('')}</select>`;
  return `<button class="ghost" id="back">‹ Users</button><div class="card" style="margin-top:10px"><h2>${u.isNew ? 'Add a login' : esc(u.name)}</h2>
    <div class="row3">${u.isNew ? `<div><label>Name</label><input id="u_name" value="${esc(u.name)}" placeholder="Sam Smith"></div>` : ''}
      <div><label>Email</label><input id="u_email" type="email" value="${esc(u.email)}" placeholder="sam@ventia.com"></div>
      <div><label>Company</label><input id="u_company" value="${esc(u.company)}" placeholder="Ventia"></div></div>
    <label>Role</label><div class="chips">${Object.keys(ROLE_PRESETS).map(r => `<button class="chip ${u.role === r ? 'on' : ''}" data-role="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}</div>
    <p class="muted">${esc(ROLE_PRESETS[u.role].note)}. Fine-tune below.</p>
    <div class="row3"><div><label>Passive fire</label>${sel('passive', ['none', 'log', 'full'])}</div>
      <div><label>Fire repairs</label>${sel('repairs', ['none', 'log', 'full'])}</div>
      <div><label>SIT</label>${sel('sit', ['none', 'view', 'edit'])}</div></div>
    <label>Sites</label><div class="chips">${sitesList().map(s => `<button class="chip ${u.sites.includes(s) ? 'on' : ''}" data-usite="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    ${u.role === 'staff' ? `<label><input type="checkbox" id="u_dash" ${u.dashboard ? 'checked' : ''}> Can see the dashboard (shows money)</label>` : ''}
    ${u.isNew ? '' : `<label><input type="checkbox" id="u_active" ${u.active ? 'checked' : ''}> Login switched on</label>`}
    <button class="big" id="u_save" style="margin-top:14px">${u.isNew ? 'Create login and show code' : 'Save'}</button></div>`;
}
function bindUserForm() {
  const u = office.userEdit;
  const read = () => {
    const g = id => $('#' + id);
    if (g('u_name')) u.name = g('u_name').value.trim();
    u.email = g('u_email').value.trim(); u.company = g('u_company').value.trim();
    $$('[data-uk]').forEach(s => u[s.dataset.uk] = s.value);
    if (g('u_dash')) u.dashboard = g('u_dash').checked;
    if (g('u_active')) u.active = g('u_active').checked;
  };
  $('#back').onclick = () => { office.userEdit = null; render(); };
  $$('[data-role]').forEach(b => b.onclick = () => { read(); u.role = b.dataset.role; Object.assign(u, ROLE_PRESETS[u.role]); render(); });
  $$('[data-usite]').forEach(b => b.onclick = () => { read(); const s = b.dataset.usite; u.sites = u.sites.includes(s) ? u.sites.filter(x => x !== s) : u.sites.concat(s); render(); });
  $('#u_save').onclick = async () => {
    read();
    if (u.isNew && !u.name) { toast('Enter a name'); return; }
    if (!u.sites.length) { toast('Pick at least one site'); return; }
    try {
      const out = await api('userSave', { user: u });
      office.userEdit = null; office.users = null;
      if (out.code) office.newCode = { name: out.name, code: out.code }; else toast('Saved');
      render(); if (!out.code) loadUsers();
    } catch (e) { toast(e.message, 4000); }
  };
}

/* ---- history ---- */

function renderHistory() {
  const D = office.dash;
  if (!D || office.loading) return officeHead('History') + officeWait();
  const q = norm(office.hq || '');
  const list = D.pos.filter(p => !q || [p.month, p.location, p.vp, p.status, p.wo].some(v => norm(v).includes(q))).slice().reverse();
  const total = list.reduce((t, p) => t + p.value, 0);
  return officeHead('History', `<input id="hq" type="search" placeholder="Search month, location, VP, status" value="${esc(office.hq || '')}">`) +
    `<div class="card"><p class="muted">${list.length} POs · ${money(total)}</p><table class="otable"><thead><tr><th>Month</th><th>Site</th><th>Location</th><th>VP</th><th>Value</th><th>Status</th><th>WO / PO</th></tr></thead><tbody>
    ${list.map(p => `<tr><td>${esc(p.month)}</td><td>${esc(p.site)}</td><td>${esc(p.location)}</td><td>${esc(p.vp)}</td><td>${money(p.value)}</td><td>${esc(p.status)}</td><td>${esc(p.wo)}</td></tr>`).join('')}
    </tbody></table></div>`;
}
function bindHistory() {
  bindOfficeHead(); bindOfficeWait();
  if (!office.dash && !office.loading && !office.err) loadDash();
  const h = $('#hq');
  if (h) h.oninput = () => { office.hq = h.value; clearTimeout(bindHistory._t); bindHistory._t = setTimeout(() => { render(); const n = $('#hq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
}

VIEWS.office = {
  dash: [renderDash, bindDash], plan: [renderPlan, bindPlan], locs: [renderLocs, bindLocs],
  users: [renderUsers, bindUsers], history: [renderHistory, bindHistory],
};
