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
  try { office.dash = await api('dashboard', { site: office.site }); office.animated = false; }
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

function shiftMonth(m, n) { const [Y, M] = m.split('-').map(Number); const d = new Date(Y, M - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function monthShort(m) { const [Y, M] = m.split('-').map(Number); return new Date(Y, M - 1, 1).toLocaleDateString('en-AU', { month: 'short' }) + (M === 1 ? ' ' + String(Y).slice(2) : ''); }
function monthLong(m) { const [Y, M] = m.split('-').map(Number); return new Date(Y, M - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }); }
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* The runway: each month from now on, filled by POs already planned (solid) and then by the bank (striped),
   at the monthly target. Past months show what was done. This is the one number that matters: how far ahead are we. */
function runwayModel(D) {
  const P = D.passive, now = D.thisMonth, target = D.monthMin;
  const byM = {}; P.months.forEach(m => byM[m.month] = m);
  let bankLeft = P.bank;
  const cells = [];
  for (let i = -5; i <= 12; i++) {
    const m = shiftMonth(now, i), rec = byM[m] || { done: 0, open: 0 };
    const c = { month: m, past: i < 0, now: i === 0, done: rec.done, open: rec.open, bank: 0 };
    if (i >= 0) {
      const room = Math.max(0, target - rec.done - rec.open);
      const lastPlanned = P.months.filter(x => x.month >= now && x.open > 0).map(x => x.month).sort().pop() || now;
      if (m >= lastPlanned || rec.open === 0) { c.bank = Math.min(room, bankLeft); bankLeft -= c.bank; }
    }
    c.total = c.done + c.open + c.bank;
    c.fill = Math.min(1, c.total / target);
    cells.push(c);
  }
  const future = cells.filter(c => !c.past);
  const ahead = future.reduce((t, c) => t + c.fill, 0) + Math.max(0, bankLeft) / target;
  let through = '';
  for (const c of future) { if (c.fill >= 0.98) through = c.month; else break; }
  return { cells, ahead, through, overflow: Math.max(0, bankLeft) };
}

function renderRunway(D) {
  const R = runwayModel(D);
  const k = n => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : n ? money(n) : '–';
  return `<section class="runway" aria-label="Months of work ahead">
    <div class="rw-head">
      <div><p class="rw-kicker">Work runway${D.site ? ' · ' + esc(D.site) : ''}</p>
        <p class="rw-big"><span class="countup" data-to="${R.ahead.toFixed(1)}" data-dec="1">${R.ahead.toFixed(1)}</span><small>months of passive fire work ahead</small></p>
        <p class="rw-sub">${R.through ? `Fully booked through <strong>${monthLong(R.through)}</strong> at ${k$(D.monthMin)} a month.` : `This month isn't full yet. ${money(Math.max(0, D.monthMin - (R.cells[5].total)))} to go.`}${R.overflow ? ` Plus ${money(R.overflow)} more in the bank beyond the strip.` : ''}</p></div>
      <img src="logo-header.png" alt="" class="rw-logo">
    </div>
    <div class="rw-strip">${R.cells.map((c, i) => {
      const seg = v => (v / D.monthMin * 100).toFixed(1);
      return `<div class="rw-cell ${c.past ? 'past' : ''} ${c.now ? 'now' : ''}" style="--i:${i}" data-tip="${esc(monthLong(c.month))}|${c.done ? 'Done or invoiced ' + money(c.done) : ''}|${c.open ? 'Planned or open ' + money(c.open) : ''}|${c.bank ? 'From the bank ' + money(c.bank) : ''}|${!c.past ? Math.round(c.fill * 100) + '% of target' : ''}">
        <div class="rw-bar"><span class="f-done" style="height:${Math.min(100, seg(c.done))}%"></span><span class="f-open" style="height:${Math.min(100, seg(c.open))}%"></span><span class="f-bank" style="height:${Math.min(100, seg(c.bank))}%"></span></div>
        <span class="rw-m">${monthShort(c.month)}</span><span class="rw-v">${k(c.total)}</span></div>`;
    }).join('')}</div>
    <p class="rw-key"><span class="sw done"></span>Done or invoiced <span class="sw open"></span>Planned POs <span class="sw sw-bank"></span>In the bank, not on a PO yet <span class="tick"></span>Today</p>
  </section>`;
}

/* Revenue by month: last 12 months and what's booked ahead, against the target band. */
function revenueChart(D) {
  const P = D.passive, now = D.thisMonth, R = runwayModel(D);
  const rw = {}; R.cells.forEach(c => rw[c.month] = c);
  const byM = {}; P.months.forEach(m => byM[m.month] = m);
  const months = [];
  for (let i = -11; i <= 6; i++) {
    const m = shiftMonth(now, i), rec = byM[m] || { done: 0, open: 0 };
    months.push({ month: m, done: rec.done, open: rec.open, bank: rw[m] ? rw[m].bank : 0, future: i > 0, now: i === 0 });
  }
  const W = 900, H = 260, padL = 46, padB = 36, padT = 14;
  const max = Math.max(D.monthMax * 1.25, ...months.map(m => m.done + m.open + m.bank)) * 1.05;
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  const step = (W - padL - 8) / months.length, bw = Math.min(34, step * 0.62);
  const stepV = [2500, 5000, 10000, 20000, 25000, 50000].find(v => max / v <= 5) || 100000;
  const ticks = []; for (let t = 0; t <= max; t += stepV) ticks.push(t);
  const past12 = months.filter(m => !m.future && !m.now);
  const done12 = past12.reduce((t, m) => t + m.done + m.open, 0);
  const hit = past12.filter(m => m.done + m.open >= D.monthMin).length;
  return `<div class="panel chart-panel"><div class="p-head"><h3>Revenue by month</h3>
      <p class="p-note">${money(done12)} over the last ${past12.length} months · target hit ${hit} of ${past12.length} months</p></div>
    <div class="chartbox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue by month against the monthly target">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#fbd9cb"/><rect width="2.4" height="6" fill="#e8572a"/></pattern></defs>
      ${ticks.map(t => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" class="ax">${t ? '$' + (t / 1000) + 'k' : '0'}</text>`).join('')}
      <rect x="${padL}" y="${y(D.monthMax)}" width="${W - padL}" height="${y(D.monthMin) - y(D.monthMax)}" class="band"/>
      <text x="${W - 4}" y="${y(D.monthMax) - 5}" text-anchor="end" class="ax band-l">Target ${k$(D.monthMin)}–${k$(D.monthMax)}</text>
      ${months.map((m, i) => {
        const x = padL + i * step + (step - bw) / 2;
        const yd = y(m.done), yo = y(m.done + m.open), yb = y(m.done + m.open + m.bank), base = y(0);
        return `<g class="mbar ${m.now ? 'now' : ''}" style="--i:${i}" data-tip="${esc(monthLong(m.month))}|${m.done ? 'Done or invoiced ' + money(m.done) : ''}|${m.open ? 'Planned or open ' + money(m.open) : ''}|${m.bank ? 'Bank, not on a PO ' + money(m.bank) : ''}|Total ${money(m.done + m.open + m.bank)}">
          <rect x="${x - (step - bw) / 2}" y="${padT}" width="${step}" height="${base - padT}" class="hitbox"/>
          ${m.bank ? `<rect x="${x}" y="${yb}" width="${bw}" height="${yo - yb}" fill="url(#hatch)" class="grow"/>` : ''}
          ${m.open ? `<rect x="${x}" y="${yo}" width="${bw}" height="${yd - yo}" class="b-open grow"/>` : ''}
          ${m.done ? `<rect x="${x}" y="${yd}" width="${bw}" height="${base - yd}" class="b-done grow"/>` : ''}
          <text x="${x + bw / 2}" y="${H - 14}" text-anchor="middle" class="ax ${m.now ? 'ax-now' : ''}">${monthShort(m.month)}</text>
        </g>`;
      }).join('')}
      <line x1="${padL + 11.5 * step}" x2="${padL + 11.5 * step}" y1="${padT}" y2="${y(0)}" class="today"/>
    </svg></div></div>`;
}

function pipelineChain(stages) {
  const max = Math.max(...stages.map(s => s.v), 1);
  return `<div class="chain">${stages.map((s, i) => `<div class="link ${s.hot ? 'hot' : ''}" style="--i:${i}">
      <span class="l-name">${esc(s.label)}</span><span class="l-val">${s.v ? k$(s.v) : s.n ? s.n : '–'}</span>
      <span class="l-n">${s.n} ${esc(s.unit)}${s.n === 1 ? '' : 's'}</span>
      <span class="l-bar"><span style="width:${Math.max(s.v ? 4 : 0, s.v / max * 100)}%"></span></span></div>`).join('')}</div>`;
}

function kpi(label, value, note, cls) {
  return `<div class="kpi ${cls || ''}"><span class="k-l">${label}</span><span class="k-v">${value}</span><span class="k-n">${note}</span></div>`;
}

function renderDash() {
  const D = office.dash;
  if (!D || office.loading) return officeHead('Dashboard') + officeWait();
  const v = office.view, P = D.passive, Rp = D.repairs;
  const now = D.thisMonth;
  const past12 = P.months.filter(m => m.month < now && m.month >= shiftMonth(now, -12));
  const rev12 = past12.reduce((t, m) => t + m.done + m.open, 0);
  const avg = past12.length ? rev12 / past12.length : 0;
  const planned = P.months.filter(m => m.month >= now).reduce((t, m) => t + m.open, 0);
  const tabs = `<div class="seg" role="tablist">${[['passive', 'Passive fire'], ['repairs', 'Fire repairs']].map(([k, l]) => `<button role="tab" aria-selected="${v === k}" class="${v === k ? 'on' : ''}" data-oview="${k}">${l}</button>`).join('')}</div>`;
  const todo = [];
  if (D.todo.requested) todo.push(`<button class="todo" data-go2="passive:requests"><b>${D.todo.requested}</b> client request${D.todo.requested === 1 ? '' : 's'} to price</button>`);
  if (D.todo.repairsToPrice) todo.push(`<button class="todo" data-go2="repairs:rfind"><b>${D.todo.repairsToPrice}</b> repair${D.todo.repairsToPrice === 1 ? '' : 's'} to price</button>`);
  if (D.todo.unconfirmed && perms().admin) todo.push(`<button class="todo" data-go2="office:locs"><b>${D.todo.unconfirmed}</b> location${D.todo.unconfirmed === 1 ? '' : 's'} to tidy</button>`);
  const top = `<div class="dash-top"><div><p class="dash-date">${new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}</p><h2 class="dash-title">Dashboard</h2></div>
    <div class="dash-ctl">${tabs}<div class="seg">${['', ...sitesList()].map(x => `<button class="${office.site === x ? 'on' : ''}" data-osite="${esc(x)}">${x || 'All sites'}</button>`).join('')}</div>
    <button class="ghost small" id="oref" aria-label="Refresh">↻ Refresh</button></div></div>
    ${todo.length ? `<div class="todos"><span class="todo-l">Needs you</span>${todo.join('')}</div>` : ''}`;
  let body;
  if (v === 'passive') {
    const st = (k) => P.penStatus[k] || { n: 0, v: 0 }, po = (k) => P.poStatus[k] || { n: 0, v: 0 };
    const chain = [
      { label: 'Client requests', v: 0, n: st('Requested').n, unit: 'item' },
      { label: 'In the bank', v: st('Scouted').v, n: st('Scouted').n, unit: 'penetration', hot: true },
      { label: 'Allocated', v: po('Allocated').v, n: po('Allocated').n, unit: 'PO' },
      { label: 'Quoted', v: po('Quoted').v, n: po('Quoted').n, unit: 'PO' },
      { label: 'PO received', v: po('PO Received').v, n: po('PO Received').n, unit: 'PO' },
      { label: 'Done', v: po('Done').v, n: po('Done').n, unit: 'PO' },
      { label: 'Invoiced', v: po('Invoiced').v, n: po('Invoiced').n, unit: 'PO' },
    ];
    const bl = P.buildings.map(b => Object.assign({ total: b.bank + b.open + b.done }, b)).sort((a, b) => b.total - a.total);
    const bmax = Math.max(...bl.map(b => b.total), 1);
    body = renderRunway(D) + `<div class="kpis">
        ${kpi('In the bank', `<span class="countup" data-to="${P.bank}" data-money="1">${money(P.bank)}</span>`, `${P.bankN} penetrations ready to plan`, 'accent')}
        ${kpi('Booked ahead', money(planned), `planned POs from ${monthShort(now)}`)}
        ${kpi('Last 12 months', money(rev12), `${money(avg)} a month on average`)}
        ${kpi('Against target', avg ? Math.round(avg / D.monthMin * 100) + '%' : '–', `of ${k$(D.monthMin)} a month, on average`)}
      </div>
      ${revenueChart(D)}
      <div class="panel"><div class="p-head"><h3>Pipeline</h3><p class="p-note">From client request to invoice</p></div>${pipelineChain(chain)}</div>
      <div class="panel"><div class="p-head"><h3>By building</h3><p class="p-note">Penetrations logged in the app. Imported history is in History.</p></div>
        ${bl.length ? `<div class="bld">${bl.map(b => `<div class="b-row"><div class="b-name"><strong>${esc(b.building)}</strong><span>${esc(buildingName(b.site, b.building) || b.site)}</span></div>
          <div class="b-bar"><span class="s-bank" style="width:${b.bank / bmax * 100}%"></span><span class="s-open" style="width:${b.open / bmax * 100}%"></span><span class="s-done" style="width:${b.done / bmax * 100}%"></span></div>
          <div class="b-val">${money(b.total)}<span>${b.n} pens</span></div></div>`).join('')}</div>
          <p class="rw-key light"><span class="sw sw-bank"></span>In the bank <span class="sw open2"></span>On a PO <span class="sw done"></span>Done</p>`
        : `<p class="empty">Nothing scouted in the app yet. Buildings appear here as soon as you start.</p>`}</div>`;
  } else {
    const st = k => Rp.status[k] || { n: 0, v: 0 };
    const chain = [
      { label: 'Logged', v: st('Logged').v, n: st('Logged').n, unit: 'repair' },
      { label: 'Quoted', v: st('Quoted').v, n: st('Quoted').n, unit: 'repair', hot: true },
      { label: 'PO received', v: st('PO Received').v, n: st('PO Received').n, unit: 'repair' },
      { label: 'Done', v: st('Done').v, n: st('Done').n, unit: 'repair' },
      { label: 'Invoiced', v: st('Invoiced').v, n: st('Invoiced').n, unit: 'repair' },
    ];
    body = `<section class="runway rep"><div class="rw-head"><div><p class="rw-kicker">Fire repairs${D.site ? ' · ' + esc(D.site) : ''}</p>
        <p class="rw-big"><span class="countup" data-to="${st('Quoted').v + st('PO Received').v}" data-money="1">${money(st('Quoted').v + st('PO Received').v)}</span><small>quoted or approved, not yet done</small></p>
        <p class="rw-sub">${Rp.n} repairs logged · ${Rp.toPrice} waiting on a price</p></div><img src="logo-header.png" alt="" class="rw-logo"></div></section>
      <div class="kpis">
        ${kpi('Waiting on a PO', money(st('Quoted').v), `${st('Quoted').n} quoted`, 'accent')}
        ${kpi('Approved, to do', money(st('PO Received').v), `${st('PO Received').n} with a PO`)}
        ${kpi('To quote', String(st('Logged').n), `${Rp.toPrice} with no price yet`)}
        ${kpi('Done and invoiced', money(st('Done').v + st('Invoiced').v), `${st('Done').n + st('Invoiced').n} repairs`)}
      </div>
      <div class="panel"><div class="p-head"><h3>Pipeline</h3><p class="p-note">Separate from passive fire</p></div>${pipelineChain(chain)}</div>`;
  }
  return `<div class="dash">${top}${body}<p class="dash-foot"><img src="logo-header.png" alt="Frontline Compliance and Fire"> Live from the master sheet · updated ${new Date(D.serverTime).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}</p></div><div id="tip" role="tooltip"></div>`;
}

function bindDash() {
  bindOfficeHead(); bindOfficeWait();
  if (!office.dash && !office.loading && !office.err) loadDash();
  $$('[data-oview]').forEach(b => b.onclick = () => { office.view = b.dataset.oview; office.animated = false; render(); });
  $$('[data-go2]').forEach(b => b.onclick = () => {
    const [area, screen] = b.dataset.go2.split(':');
    if (area === 'office') { go(screen, screen); return; }
    state.area = area; store.set(LS.area, area); state.screen = screen; state.tab = homeOf(area); render();
  });
  // hover / tap details for the runway and chart
  const tip = $('#tip');
  if (tip) {
    const show = (el, ev) => {
      const parts = el.dataset.tip.split('|').filter(Boolean);
      tip.innerHTML = `<strong>${esc(parts[0])}</strong>${parts.slice(1).map(p => `<span>${esc(p)}</span>`).join('')}`;
      tip.classList.add('on');
      const r = el.getBoundingClientRect();
      const x = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2));
      tip.style.left = x + 'px'; tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 10) + 'px';
    };
    $$('[data-tip]').forEach(el => {
      el.addEventListener('mouseenter', e => show(el, e));
      el.addEventListener('mouseleave', () => tip.classList.remove('on'));
      el.addEventListener('click', e => show(el, e));
    });
  }
  // on narrow screens, start the runway and chart at this month rather than six months ago
  const strip = $('.rw-strip'), nowCell = $('.rw-cell.now');
  if (strip && nowCell && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = nowCell.offsetLeft - strip.offsetLeft - 60;
  const cb = $('.chartbox'); if (cb && cb.scrollWidth > cb.clientWidth) cb.scrollLeft = cb.scrollWidth;
  // one orchestrated entrance the first time the numbers load
  const dash = $('.dash');
  if (dash && office.dash && !office.loading) {
    if (!office.animated && !reduceMotion()) {
      dash.classList.add('enter');
      $$('.countup').forEach(el => {
        const to = Number(el.dataset.to), dec = Number(el.dataset.dec || 0), isMoney = !!el.dataset.money, t0 = performance.now(), dur = 1100;
        const tick = t => {
          const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3), v = to * e;
          el.textContent = isMoney ? money(v) : v.toFixed(dec);
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
    office.animated = true;
  }
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
