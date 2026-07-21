// Rendering + static event wiring. Pure-ish: render(state) reflects app state
// into the DOM; setup(handlers) binds one-time listeners.
import { fmtEuro, DEAL_TYPE_LABEL } from './model.js';
import { fmtBst, fmtDuration } from './tz.js';
import { searchRiders, allTeams } from './ridersdb.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const THREAD_URL = (id) => `https://pcmdaily.com/forum/viewthread.php?thread_id=${id}`;

let H = {};

export function setup(handlers) {
  H = handlers;
  // team datalist (alphabetical for the dropdown; allTeams() is ordered for matching)
  const dl = $('teamList');
  for (const t of [...allTeams()].sort((a, b) => a.localeCompare(b))) dl.appendChild(el('option')).value = t;

  $('teamInput').addEventListener('change', (e) => H.setTeam(e.target.value.trim()));
  $('divisionSel').addEventListener('change', (e) => H.setDivision(e.target.value));
  $('baseSalaryInput').addEventListener('change', (e) => H.setBaseSalary(e.target.value.trim()));
  $('budgetInput').addEventListener('change', (e) => H.setBudget(e.target.value.trim()));
  $('reserveInput').addEventListener('change', (e) => H.setReserve(e.target.value.trim()));
  $('refreshSel').addEventListener('change', (e) => H.setRefreshSec(+e.target.value));
  const forums = () => H.setForums(+$('faForumInput').value || 396, +$('dealForumInput').value || 397);
  $('faForumInput').addEventListener('change', forums);
  $('dealForumInput').addEventListener('change', forums);
  $('dealAdd').addEventListener('click', () => { H.addDeal($('dealInput').value.trim()); $('dealInput').value = ''; });
  $('faThreadAdd').addEventListener('click', () => { H.addFaThread($('faThreadInput').value.trim()); $('faThreadInput').value = ''; });

  // collapsible panels
  document.querySelectorAll('.panel-head').forEach((h) => {
    h.addEventListener('click', () => h.closest('.panel').classList.toggle('open'));
  });

  // rider search (debounced)
  let t;
  $('riderSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value;
    t = setTimeout(() => renderRiderResults(q), 150);
  });
}

function renderRiderResults(q) {
  const box = $('riderResults');
  box.innerHTML = '';
  const rows = searchRiders(q, 12);
  for (const r of rows) {
    const row = el('div', 'r');
    const left = el('div');
    left.append(el('span', null, r.n));
    const meta = el('div', 'meta', `${r.fa ? 'Free Agent' : r.t} · ${r.d || '?'} · ${r.c} · OVL ${r.o ?? '?'}`);
    left.append(meta);
    row.append(left);
    const btn = el('button', 'btn small', 'Add');
    btn.addEventListener('click', () => { H.addRider(r.id); $('riderSearch').value = ''; box.innerHTML = ''; });
    row.append(btn);
    box.append(row);
  }
}

export function setTeamInput(v) { if ($('teamInput').value !== v) $('teamInput').value = v || ''; }
export function setRefreshSel(v) { $('refreshSel').value = String(v); }
export function setForumInputs(fa, deal) { $('faForumInput').value = String(fa); $('dealForumInput').value = String(deal); }
export function setDivision(v) { $('divisionSel').value = v || 'auto'; }
export function setMoneyInputs(base, budget, reserve) {
  $('baseSalaryInput').value = base ?? '';
  $('budgetInput').value = budget ?? '';
  $('reserveInput').value = reserve ?? '';
}

export function render(s) {
  // top bar
  $('bstClock').textContent = fmtBst(s.nowUtc);
  const ri = $('refreshInfo');
  ri.textContent = s.refresh.nextAt ? `next update in ${Math.max(0, Math.round((s.refresh.nextAt - Date.now()) / 1000))}s` : 'next update in —';
  document.querySelector('.dot').classList.toggle('spin', !!(s.init && s.init.active));

  $('loginWarn').classList.toggle('hidden', !s.loginRequired);
  $('setupWarn').classList.toggle('hidden', !!s.config.myTeam);
  $('initBanner').classList.toggle('hidden', !(s.init && s.init.active && s.config.myTeam));
  if (s.init) $('initCount').textContent = s.init.scanned;
  $('tzInfo').textContent = s.offsetMin != null ? `Forum clock offset ${s.offsetMin >= 0 ? '+' : ''}${s.offsetMin / 60}h → normalised to BST` : '';

  renderTotals(s);
  renderUsage(s);
  renderFA(s);
  renderSacks(s);
  renderDeals(s);
}

function bar(id, value, limit) {
  const fill = $(id);
  const pct = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  fill.style.width = pct + '%';
  fill.classList.toggle('over', limit > 0 && value > limit);
}

// Signed money, no minus sign: money coming back to you (negative, or forced) is
// green; null is a greyed "n/a". Returns a <span>.
function moneyEl(v, opts = {}) {
  if (v == null) return el('span', 'na', 'n/a');
  const green = opts.forceGreen || v < 0;
  return el('span', green ? 'money-green' : '', fmtEuro(Math.abs(v)));
}
function putMoney(id, v, opts) { const e = $(id); e.textContent = ''; e.append(moneyEl(v, opts)); }
function blueEl(v) { return el('span', 'money-blue', fmtEuro(v)); }
// A stat whose value is a node (e.g. coloured money) rather than plain text.
function statNode(label, node) { const s = el('span', 'stat'); s.append(el('label', null, label)); const b = el('b'); b.append(node); s.append(b); return s; }

function renderTotals(s) {
  const { salary, budget } = s.totals;
  const rows = $('salaryRows');
  rows.innerHTML = '';
  const row = (label, v) => {
    const r = el('div', 'figrow');
    r.append(el('span', null, label));
    const b = el('b'); b.append(moneyEl(v)); r.append(b);
    rows.append(r);
  };
  row('Existing squad', salary.existing);
  row('Free agents — completed', salary.faCompleted);
  row('Free agents — pending', salary.faPending);
  row('Transfers — completed', salary.transferCompleted);
  row('Transfers — pending', salary.transferPending);
  row('Loans — completed', salary.loanCompleted);
  row('Loans — pending', salary.loanPending);
  row('Freed by sacks', salary.sackReduction ? -salary.sackReduction : 0);

  const proj = $('sProj'); proj.textContent = ''; proj.append(blueEl(salary.projected));
  $('sDiv').textContent = s.division.code + (s.division.assumed ? '?' : '');
  $('sCap').textContent = fmtEuro(salary.cap);
  bar('sBar', salary.projected, salary.cap);

  putMoney('bTransfer', budget.transfer);
  putMoney('bLoan', budget.loan);
  putMoney('bFines', budget.fines);
  putMoney('bReserve', budget.reserve);
  const spend = $('bSpend'); spend.textContent = ''; spend.append(blueEl(budget.spend));
  $('bBudget').textContent = budget.budget ? fmtEuro(budget.budget) : 'not set';
  bar('bBar', budget.spend, budget.budget);
}

function renderSacks(s) {
  const list = $('sackList');
  list.innerHTML = '';
  $('sackCount').textContent = s.sacks.length ? `(${s.sacks.length})` : '';
  $('sackEmpty').classList.toggle('hidden', s.sacks.length > 0);
  for (const k of s.sacks) {
    const card = el('div', 'fa-card');
    const l1 = el('div', 'fa-l1');
    const name = el('span', 'fa-name');
    const a = el('a', null, k.riderName); a.href = THREAD_URL(k.threadId); a.target = '_blank'; name.append(a);
    l1.append(name);
    l1.append(stat('Age', k.rider.a != null ? k.rider.a : '—'));
    l1.append(stat('OVL', k.rider.o != null ? Math.round(k.rider.o) : '—'));
    l1.append(stat('POT', k.rider.p != null ? k.rider.p : '—'));
    const right = el('span', 'fa-right');
    right.append(el('span', 'upd', k.updatedUtc ? fmtBst(k.updatedUtc).replace(' BST', '') : '—'));
    l1.append(right);
    card.append(l1);
    const l2 = el('div', 'fa-l2');
    l2.append(statNode('Wage freed', moneyEl(k.wage, { forceGreen: true })));
    l2.append(statNode('Fine (budget)', moneyEl(k.fine)));
    card.append(l2);
    list.append(card);
  }
}

function renderUsage(s) {
  const u = s.usage;
  $('uRiders').textContent = u.ridersToday;
  $('uBids').textContent = u.bidsToday;
  $('uRidersLeft').textContent = u.ridersLeft;
  $('uBidsLeft').textContent = u.bidsLeft;
  if (s.nowUtc < s.firstWindowUtc) {
    $('windowLabel').textContent = 'Transfers open in';
    $('uWindow').textContent = fmtDuration(s.firstWindowUtc - s.nowUtc);
  } else {
    $('windowLabel').textContent = 'Next window (00:00 BST) in';
    $('uWindow').textContent = fmtDuration(u.nextWindowUtc - s.nowUtc);
  }
  $('uClose').textContent = s.nowUtc >= s.transferCloseUtc ? 'closed' : fmtDuration(s.transferCloseUtc - s.nowUtc);
}

function stat(label, val) {
  const s = el('span', 'stat');
  s.append(el('label', null, label));
  const b = el('b', null, val); s.append(b);
  return s;
}

function renderFA(s) {
  const list = $('faList');
  list.innerHTML = '';
  $('faCount').textContent = s.fa.length ? `(${s.fa.length})` : '';
  $('faEmpty').classList.toggle('hidden', s.fa.length > 0);

  for (const f of s.fa) {
    const card = el('div', 'fa-card' + (f.a.amILeading ? ' lead' : ''));

    // ---- top line: identity · evaluation · status · updated ----
    const l1 = el('div', 'fa-l1');
    const name = el('span', 'fa-name');
    if (f.threadId) {
      const a = el('a', null, f.rider.n); a.href = THREAD_URL(f.threadId); a.target = '_blank'; name.append(a);
    } else {
      name.append(el('span', null, f.rider.n));
    }
    if (f.junior) { const j = el('span', 'jr', 'Jr'); j.title = 'Junior / stagiaire (min bid €20k)'; name.append(document.createTextNode(' ')); name.append(j); }
    if (f.kind === 'sack') { const sk = el('span', 'jr sack', 'Sacked'); sk.title = 'Sacked rider — now a free agent'; name.append(document.createTextNode(' ')); name.append(sk); }
    if (!f.threadId) name.append(el('span', 'sub', f.locating ? ' · locating thread…' : ' · no thread found'));
    l1.append(name);

    l1.append(stat('Age', f.rider.a != null ? f.rider.a : '—'));
    l1.append(stat('OVL', f.rider.o != null ? Math.round(f.rider.o) : '—'));
    l1.append(stat('POT', f.rider.p != null ? f.rider.p : '—'));

    // Active → "closes in <countdown>"; once the 48h passes → "Signed to …".
    const stWrap = el('span', 'fa-status');
    const closed = f.status && (f.status.key === 'won' || f.status.key === 'gone');
    if (closed) {
      stWrap.append(badge(f.status.key, f.status.label));
    } else if (f.a.winUtcMs) {
      const cd = el('span', 'cd'); cd.dataset.win = f.a.winUtcMs; cd.textContent = 'closes in ' + fmtDuration(f.a.winUtcMs - s.nowUtc);
      stWrap.append(cd);
    } else if (f.status) {
      stWrap.append(badge(f.status.key, f.status.label));
    }
    l1.append(stWrap);

    const right = el('span', 'fa-right');
    right.append(el('span', 'upd', f.updatedUtc ? fmtBst(f.updatedUtc).replace(' BST', '') : '—'));
    const x = el('span', 'x', '✕'); x.title = 'Remove'; x.onclick = () => H.removeFaRow(f.riderId ?? null, f.threadId ?? null);
    right.append(x);
    l1.append(right);
    card.append(l1);

    // ---- second line: bid economics ----
    const l2 = el('div', 'fa-l2');
    l2.append(stat('Your bid', f.a.myHighest ? fmtEuro(f.a.myHighest) : '—'));
    l2.append(stat('Leading', f.a.leadingAmount ? fmtEuro(f.a.leadingAmount) : '—'));
    const leadFig = el('span', 'stat'); leadFig.append(el('label', null, 'Leader'));
    if (f.a.leadingTeam) leadFig.append(badge(f.a.amILeading ? 'you' : 'other', f.a.amILeading ? 'YOU' : f.a.leadingTeam));
    else leadFig.append(el('b', null, '—'));
    l2.append(leadFig);
    l2.append(stat('Current band', f.band));
    l2.append(stat('Min next', fmtEuro(f.a.minNextBid)));
    card.append(l2);

    list.append(card);
  }
}

function renderDeals(s) {
  const body = $('dealBody');
  body.innerHTML = '';
  $('dealCount').textContent = s.deals.length ? `(${s.deals.length})` : '';
  $('dealEmpty').classList.toggle('hidden', s.deals.length > 0);
  $('dealTable').closest('.tablewrap').classList.toggle('hidden', s.deals.length === 0);

  for (const d of s.deals) {
    const tr = el('tr');
    if (d.involvesMe && !d.voided) tr.classList.add('lead'); // green highlight for your live deals
    const th = el('td', 'thread');
    const a = el('a', null, d.title || `Thread ${d.threadId}`); a.href = THREAD_URL(d.threadId); a.target = '_blank';
    th.append(a);
    if (d.teams && d.teams.length === 2) {
      const sub = el('div', 'sub');
      d.teams.forEach((tm, i) => {
        if (i) sub.append(document.createTextNode(' ↔ '));
        sub.append(el('span', tm === d.mySide ? 'you-team' : '', tm)); // green = your team
      });
      th.append(sub);
    }
    tr.append(th);

    // coloured deal-type label (distinct from the thread name)
    const typeTd = el('td'); typeTd.append(badge('type-' + d.type, DEAL_TYPE_LABEL[d.type] || 'Deal')); tr.append(typeTd);

    // read-only, from the thread/DB (green = money/cap back to you; n/a unknown)
    tr.append(moneyCell(d.display.transferFee));
    tr.append(moneyCell(d.display.loanFee));
    tr.append(moneyCell(d.display.salaryAdd));

    // status: voided → completed → "closes in" countdown
    const stTd = el('td');
    if (d.voided) stTd.append(badge('voided', 'Voided'));
    else if (d.completed) stTd.append(badge('done', 'Completed'));
    else if (d.closeUtc) { const cd = el('span', 'cd'); cd.dataset.win = d.closeUtc; cd.textContent = 'closes in ' + fmtDuration(d.closeUtc - s.nowUtc); stTd.append(cd); }
    else stTd.textContent = '—';
    if (d.voided) tr.classList.add('voided-row');
    tr.append(stTd);

    const ts = el('td', 'subtle right', d.lastPostUtc ? fmtBst(d.lastPostUtc).replace(' BST', '') : '—');
    tr.append(ts);
    const rm = el('td'); const x = el('span', 'x', '✕'); x.title = 'Stop tracking'; x.onclick = () => H.removeDeal(d.threadId); rm.append(x);
    tr.append(rm);
    body.append(tr);
  }
}

// Read-only money cell: coloured value (green = back to you), or greyed "n/a".
function moneyCell(v) {
  const td = el('td', 'num');
  td.append(moneyEl(v));
  return td;
}

function tdNum(txt) { const td = el('td', 'num'); td.textContent = txt; return td; }
function badge(key, txt) { const b = el('span', 'badge ' + key, txt); return b; }
