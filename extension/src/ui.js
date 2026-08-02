// Rendering + static event wiring. Pure-ish: render(state) reflects app state
// into the DOM; setup(handlers) binds one-time listeners.
import { fmtEuro, DEAL_TYPE_LABEL, faSection, dealSection } from './model.js';
import { fmtBst, fmtDuration } from './tz.js';
import { searchRiders, allTeams } from './ridersdb.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const THREAD_URL = (id) => `https://pcmdaily.com/forum/viewthread.php?thread_id=${id}`;

let H = {};
let dragging = false; // true while a card is being dragged (pauses the 30s rebuild)

// Edge auto-scroll: while dragging near the top/bottom of the viewport, scroll the
// page. Driven by a rAF loop (not dragover) because dragover stops firing when the
// pointer is held still at an edge. dragPointerY is updated by a document-level
// dragover so it keeps tracking even past the dragged list's bounds.
let dragPointerY = 0;
let scrollRAF = null;
const SCROLL_EDGE = 70;   // px from the top/bottom edge that triggers scrolling
const SCROLL_MAX = 18;    // px/frame at the very edge (eases to 0 at the zone's inner edge)
function autoScrollTick() {
  if (!dragging) { scrollRAF = null; return; }
  const h = window.innerHeight, y = dragPointerY;
  let dy = 0;
  if (y < SCROLL_EDGE) dy = -Math.ceil(SCROLL_MAX * (1 - y / SCROLL_EDGE));
  else if (y > h - SCROLL_EDGE) dy = Math.ceil(SCROLL_MAX * (1 - (h - y) / SCROLL_EDGE));
  if (dy) window.scrollBy(0, dy);
  scrollRAF = requestAnimationFrame(autoScrollTick);
}
function startAutoScroll() { if (!scrollRAF) scrollRAF = requestAnimationFrame(autoScrollTick); }
function stopAutoScroll() { if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null; } }

// Wire drag-to-reorder on a container via event delegation, so it survives the
// innerHTML rebuild each render. Cards must be draggable with a data-key set.
// On drop we read the DOM order and hand the key sequence back to persist.
function setupDrag(container, kind, itemSel) {
  let dragEl = null;
  const after = (y) => {
    let best = { off: -Infinity, el: null };
    for (const node of container.querySelectorAll(`${itemSel}:not(.dragging)`)) {
      const box = node.getBoundingClientRect();
      const off = y - box.top - box.height / 2;
      if (off < 0 && off > best.off) best = { off, el: node };
    }
    return best.el;
  };
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSel);
    if (!item || !container.contains(item)) return;
    dragEl = item; dragging = true;
    dragPointerY = e.clientY;
    item.classList.add('dragging');
    startAutoScroll();
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', item.dataset.key || ''); } catch (_) {} }
  });
  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const ref = after(e.clientY);
    if (ref == null) container.appendChild(dragEl);
    else if (ref !== dragEl) container.insertBefore(dragEl, ref);
  });
  container.addEventListener('drop', (e) => { if (dragEl) e.preventDefault(); });
  container.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl = null; dragging = false;
    stopAutoScroll();
    const keys = [...container.querySelectorAll(itemSel)].map((n) => n.dataset.key).filter(Boolean);
    if (H.reorder) H.reorder(kind, keys);
  });
}

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

  // light / dark theme toggle (theme-init.js applies the saved class pre-paint)
  const themeToggle = $('themeToggle');
  if (themeToggle) {
    themeToggle.checked = document.documentElement.classList.contains('light');
    themeToggle.addEventListener('change', () => {
      const light = themeToggle.checked;
      document.documentElement.classList.toggle('light', light);
      try { localStorage.setItem('theme', light ? 'light' : 'dark'); } catch (e) {}
    });
  }

  // collapsible panels
  document.querySelectorAll('.panel-head').forEach((h) => {
    h.addEventListener('click', () => h.closest('.panel').classList.toggle('open'));
  });

  // drag-to-reorder the card lists (delegated, so it survives re-renders)
  setupDrag($('faList'), 'fa', '.fa-card');
  setupDrag($('sackList'), 'sack', '.fa-card');
  setupDrag($('dealBody'), 'deal', 'tr.deal-row');
  // track the pointer for edge auto-scroll even past a list's bounds
  document.addEventListener('dragover', (e) => { if (dragging) dragPointerY = e.clientY; });

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
  if (dragging) return; // don't rebuild the lists out from under an active drag
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

  putMoney('bSalary', budget.salary);
  putMoney('bFines', budget.fines);
  putMoney('bReserve', budget.reserve);
  putMoney('bTransferC', budget.transferC);
  putMoney('bTransferP', budget.transferP);
  putMoney('bLoanC', budget.loanC);
  putMoney('bLoanP', budget.loanP);
  // Net trade cash flow (received − paid). Received raises the budget (denominator,
  // green +); paid raises the spend (numerator, red −). Only one side is ever
  // non-zero, so the "on track" check is spend+paid vs budget+received.
  renderBudgetLine($('bSpend'), $('bBudget'), budget.spend, budget.budget, budget.netTradeFlow);
  const received = Math.max(0, budget.netTradeFlow), paid = Math.max(0, -budget.netTradeFlow);
  bar('bBar', budget.spend + paid, budget.budget ? budget.budget + received : 0);
}

// Fill the spend (numerator) + budget (denominator) cells with the trade-flow
// annotation on the correct side. flow > 0 = received (→ budget, green +);
// flow < 0 = paid (→ spend, red −).
function renderBudgetLine(spendEl, budgetEl, spend, budgetVal, flow) {
  const received = Math.max(0, flow), paid = Math.max(0, -flow);
  spendEl.textContent = ''; spendEl.append(blueEl(spend + paid));
  if (paid) spendEl.append(el('span', 'flow-neg', ` (−${fmtEuro(paid)} transfer net)`));
  budgetEl.textContent = '';
  if (!budgetVal) { budgetEl.textContent = 'not set'; return; }
  budgetEl.append(document.createTextNode(fmtEuro(budgetVal + received)));
  if (received) budgetEl.append(el('span', 'flow-pos', ` (+${fmtEuro(received)} transfer net)`));
}

function renderSacks(s) {
  const list = $('sackList');
  list.innerHTML = '';
  $('sackCount').textContent = s.sacks.length ? `(${s.sacks.length})` : '';
  $('sackEmpty').classList.toggle('hidden', s.sacks.length > 0);
  for (const k of s.sacks) {
    const card = el('div', 'fa-card');
    card.draggable = true; card.dataset.key = k.key || '';
    const l1 = el('div', 'fa-l1');
    const name = el('span', 'fa-name');
    const a = el('a', null, k.riderName); a.href = THREAD_URL(k.threadId); a.target = '_blank'; a.draggable = false; name.append(a);
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
  renderTiming(s);
  renderRoster(s);
}

// count with a golf-scorecard-style junior superscript, e.g. 18 ²ʲ
function countEl(o, sign = '') {
  const span = el('span');
  span.append(document.createTextNode(sign + (o.total || 0)));
  if (o.jr) { const sup = el('sup', 'jrsup', o.jr + 'j'); span.append(sup); }
  return span;
}
function putCount(id, o, sign = '') { const e = $(id); e.textContent = ''; e.append(countEl(o, sign)); }
const fmtHalf = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1)); // 13.5, 13

function renderRoster(s) {
  const r = s.roster;
  $('rDiv').textContent = `(${r.ct ? 'CT' : (s.division.code || '')} ${r.min}–${r.max})`;
  const squad = $('rSquad'); squad.textContent = '';
  // Show the count that's driving the constraint that's actually binding: over the
  // max, juniors count in full, so show the full head-count (maxCount); otherwise
  // show the min-weighted count where a CT junior is ½ (e.g. 13 seniors + 1 junior
  // → 13.5¹ʲ, matching the yellow "under min" colouring). Buckets stay raw counts.
  squad.append(document.createTextNode(fmtHalf(r.overMax ? r.committed.maxCount : r.committed.minCount)));
  if (r.committed.jr) squad.append(el('sup', 'jrsup', r.committed.jr + 'j'));
  squad.append(document.createTextNode(` / ${r.min}–${r.max}`));
  squad.classList.toggle('over', r.overMax);
  squad.classList.toggle('under', r.underMin);
  putCount('rExisting', r.existing);
  putCount('rConfirmed', r.confirmed, '+');
  putCount('rPending', r.pending, '+');
  putCount('rDeparted', r.departed, '−');
}

// Transfer-window open/close status. Before open → countdown; once open → green
// "Opened"; once closed → red "Closed". Called every second by the ticker too.
export function renderTiming(s) {
  const open = $('uWindow'), close = $('uClose');
  if (s.nowUtc < s.firstWindowUtc) {
    $('windowLabel').textContent = 'Transfers open in';
    open.textContent = fmtDuration(s.firstWindowUtc - s.nowUtc);
  } else {
    $('windowLabel').textContent = 'Transfer window';
    open.textContent = ''; open.append(badge('win-open', 'Opened'));
  }
  if (s.nowUtc >= s.transferCloseUtc) { close.textContent = ''; close.append(badge('win-closed', 'Closed')); }
  else close.textContent = fmtDuration(s.transferCloseUtc - s.nowUtc);
}

// A live countdown: a fixed prefix ("closes in ") plus an inner span carrying
// data-win that the 1s ticker updates. Keeping the prefix separate stops the
// ticker from overwriting it (which made "closes in" flash after each render).
function countdownEl(prefix, winMs, nowUtc) {
  const cd = el('span', 'cd');
  if (prefix) cd.append(document.createTextNode(prefix));
  const dur = el('span'); dur.dataset.win = winMs; dur.textContent = fmtDuration(winMs - nowUtc);
  cd.append(dur);
  return cd;
}

function stat(label, val) {
  const s = el('span', 'stat');
  s.append(el('label', null, label));
  const b = el('b', null, val); s.append(b);
  return s;
}

// Split a list into completed-to-you / active / completed-to-others sections and
// render each (with a subheader) into the container. The "Active" divider only
// appears when there's a completed-to-you block above it to separate from.
// makeItem(item) -> element; makeHead(text) -> a subheader element.
function renderSections(container, items, sectionOf, makeItem, makeHead) {
  const you = [], active = [], others = [];
  for (const it of items) { const g = sectionOf(it); (g === 'you' ? you : g === 'others' ? others : active).push(it); }
  if (you.length) container.append(makeHead('Completed (to you)'));
  for (const it of you) container.append(makeItem(it));
  if (you.length && active.length) container.append(makeHead('Active'));
  for (const it of active) container.append(makeItem(it));
  if (others.length) container.append(makeHead('Completed (to others)'));
  for (const it of others) container.append(makeItem(it));
}

function renderFA(s) {
  const list = $('faList');
  list.innerHTML = '';
  $('faCount').textContent = s.fa.length ? `(${s.fa.length})` : '';
  $('faEmpty').classList.toggle('hidden', s.fa.length > 0);
  renderSections(list, s.fa, (f) => faSection(f.status), (f) => faCard(f, s), (t) => el('div', 'list-subhead', t));
}

function faCard(f, s) {
    const card = el('div', 'fa-card' + (f.a.amILeading ? ' lead' : '') + (faSection(f.status) === 'others' ? ' done-other' : ''));
    card.draggable = true; card.dataset.key = f.key || '';

    // ---- top line: identity · evaluation · status · updated ----
    const l1 = el('div', 'fa-l1');
    const name = el('span', 'fa-name');
    if (f.threadId) {
      const a = el('a', null, f.rider.n); a.href = THREAD_URL(f.threadId); a.target = '_blank'; a.draggable = false; name.append(a);
    } else {
      name.append(el('span', null, f.rider.n));
    }
    if (!f.threadId) name.append(el('span', 'sub', f.locating ? ' · locating thread…' : ' · no thread found'));
    l1.append(name);
    // tags are flex siblings so they get even spacing on both sides (not crammed
    // against the name like a "Jr" name suffix)
    if (f.juniorTag) { const j = el('span', 'tag tag-jr', 'JUNIOR'); j.title = 'Junior rider — counts as ½ toward the CT roster minimum (bid under €50k)'; l1.append(j); }
    if (f.kind === 'sack') { const sk = el('span', 'tag tag-sack', 'SACKED'); sk.title = 'Sacked rider — now a free agent'; l1.append(sk); }

    l1.append(stat('Age', f.rider.a != null ? f.rider.a : '—'));
    l1.append(stat('OVL', f.rider.o != null ? Math.round(f.rider.o) : '—'));
    l1.append(stat('POT', f.rider.p != null ? f.rider.p : '—'));

    // Active → "closes in <countdown>"; once the 48h passes → "Signed to …".
    const stWrap = el('span', 'fa-status');
    const closed = f.status && (f.status.key === 'won' || f.status.key === 'gone');
    if (closed) {
      stWrap.append(badge(f.status.key, f.status.label));
    } else if (f.a.winUtcMs) {
      stWrap.append(countdownEl('closes in ', f.a.winUtcMs, s.nowUtc));
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
    // "Your bid" = your highest bid that COUNTED. If a higher bid of yours was
    // rejected (e.g. below the min increment), flag it rather than imply it stands.
    if (f.a.myInvalidHigh) {
      const node = el('span');
      node.append(document.createTextNode(f.a.myHighest ? fmtEuro(f.a.myHighest) : '—'));
      const flag = el('span', 'bid-rejected', `${fmtEuro(f.a.myInvalidHigh)} rejected`);
      flag.title = 'This bid was below the minimum increment, so it did not count.';
      node.append(flag);
      l2.append(statNode('Your bid', node));
    } else {
      l2.append(stat('Your bid', f.a.myHighest ? fmtEuro(f.a.myHighest) : '—'));
    }
    l2.append(stat('Leading', f.a.leadingAmount ? fmtEuro(f.a.leadingAmount) : '—'));
    const leadFig = el('span', 'stat'); leadFig.append(el('label', null, 'Leader'));
    if (f.a.leadingTeam) leadFig.append(badge(f.a.amILeading ? 'you' : 'other', f.a.amILeading ? 'YOU' : f.a.leadingTeam));
    else leadFig.append(el('b', null, '—'));
    l2.append(leadFig);
    l2.append(stat('Current band', f.band));
    l2.append(stat('Min next', fmtEuro(f.a.minNextBid)));
    card.append(l2);

    return card;
}

function renderDeals(s) {
  const body = $('dealBody');
  body.innerHTML = '';
  $('dealCount').textContent = s.deals.length ? `(${s.deals.length})` : '';
  $('dealEmpty').classList.toggle('hidden', s.deals.length > 0);
  $('dealTable').closest('.tablewrap').classList.toggle('hidden', s.deals.length === 0);

  const head = (t) => { const tr = el('tr', 'drophead'); const td = el('td', null, t); td.colSpan = 8; tr.append(td); return tr; };
  renderSections(body, s.deals, dealSection, (d) => dealRow(d, s), head);
}

function dealRow(d, s) {
    const tr = el('tr', 'deal-row' + (dealSection(d) === 'others' ? ' done-other' : ''));
    tr.draggable = true; tr.dataset.key = d.key || '';
    if (d.involvesMe && !d.voided && !d.superseded) tr.classList.add('lead'); // green highlight for your live deals
    const th = el('td', 'thread');
    const a = el('a', null, d.title || `Thread ${d.threadId}`); a.href = THREAD_URL(d.threadId); a.target = '_blank'; a.draggable = false;
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
    const typeTd = el('td'); typeTd.append(badge('type-' + d.type, DEAL_TYPE_LABEL[d.type] || 'Deal'));
    if (d.malformed) {
      const w = badge('malformed', '⚠ check');
      w.title = 'The forum thread listed inconsistent rider blocks (both sides showed the same riders). The tool auto-corrected by mirroring Team A — double-check this deal on the site.';
      typeTd.append(document.createTextNode(' ')); typeTd.append(w);
      tr.classList.add('malformed-row');
    }
    tr.append(typeTd);

    // read-only, from the thread/DB (green = money/cap back to you; n/a unknown)
    tr.append(moneyCell(d.display.transferFee));
    tr.append(moneyCell(d.display.loanFee));
    tr.append(moneyCell(d.display.salaryAdd));

    // status: voided → superseded → completed → "closes in" countdown
    const stTd = el('td');
    if (d.voided) stTd.append(badge('voided', 'Voided'));
    else if (d.superseded) { const b = badge('superseded', 'Superseded'); b.title = 'A later deal moved one of these riders again — this one no longer stands'; stTd.append(b); }
    else if (d.completed) stTd.append(badge('done', 'Completed'));
    else if (d.closeUtc) { stTd.append(countdownEl('closes in ', d.closeUtc, s.nowUtc)); }
    else stTd.textContent = '—';
    if (d.voided || d.superseded) tr.classList.add('voided-row');
    tr.append(stTd);

    const ts = el('td', 'subtle right', d.lastPostUtc ? fmtBst(d.lastPostUtc).replace(' BST', '') : '—');
    tr.append(ts);
    const rm = el('td'); const x = el('span', 'x', '✕'); x.title = 'Stop tracking'; x.onclick = () => H.removeDeal(d.threadId); rm.append(x);
    tr.append(rm);
    return tr;
}

// Read-only money cell: coloured value (green = back to you), or greyed "n/a".
function moneyCell(v) {
  const td = el('td', 'num');
  td.append(moneyEl(v));
  return td;
}

function tdNum(txt) { const td = el('td', 'num'); td.textContent = txt; return td; }
function badge(key, txt) { const b = el('span', 'badge ' + key, txt); return b; }
