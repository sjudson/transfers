// App controller: config, the rate-limited refresh loop, thread discovery,
// incremental fetching, and derived totals. Everything runs in this page.
import { kv } from './db.js';
import { fetchPage } from './net.js';
import { parseListing, parseThread } from './parse.js';
import { computeDisplayOffsetMin } from './tz.js';
import { crawlListing } from './crawl.js';
import { makeQueue } from './queue.js';
import {
  loadDb, riderById, riderByName, squadSalary, squadRoster, juniorByName, teamDivision, divisionCap, norm,
  riderFromThreadTitle, allRiders, allTeamsFull,
} from './ridersdb.js';
import { setupAdmin, refreshAdmin } from './admin-gate.js';
import {
  analyzeFreeAgentThread, faStatus, dailyUsage, computeTotals, dealFigures, winningDealText, dedupeFaByRider,
  openingMinFor, faThreadKind, fmtBand, dealType, rosterCounts, parseDeal, countsAsJunior,
  JUNIOR_MIN, MIN_WAGE, DEAL_MS, FIRST_WINDOW_UTC, TRANSFER_CLOSE_UTC,
} from './model.js';
import { parseForumStamp, stampToUtcMs } from './tz.js';
import * as ui from './ui.js';

const FA_FORUM = 396;   // [Man-Game] Transfers: Free Agents (default)
const DEAL_FORUM = 397; // [Man-Game] Transfers: Deals (default)
// Bump when the snapshot schema or parsing logic changes, so stale cached
// snapshots are discarded and everything is re-read with the current code.
const DATA_VERSION = 10;

// faForum/dealForum are configurable so the tool can be pointed at an old
// season's forums for testing, or reused in future seasons, without a rebuild.
// division: 'auto' | 'PT' | 'PCT' | 'CT' (auto = derive from the DB by team name;
// the DB can't be trusted for arbitrary/old-season teams, so this is overridable).
// Manual config (persisted, survives a team change): everything here.
const cfgDefaults = {
  myTeam: '', refreshSec: 30, division: 'auto', baseSalary: '', budget: '', reserve: '',
  shortlist: [], faThreads: [], deals: [],
  faForum: FA_FORUM, dealForum: DEAL_FORUM,
  adminBudgets: {}, // admin-only: norm(team) -> budget (€) for the admin panel
};
let cfg = { ...cfgDefaults };

// Auto/derived state (NOT manual). Cleared when the team or forums change so we
// never show another team's discovered bids. Snapshotted so a reload is instant.
let offsetMin = 60;                 // forum display offset (auto-calibrated)
let listing = new Map();            // threadId -> {title, lastPostStamp, forum}
let riderThread = new Map();        // riderId -> threadId
let highWater = {};                 // forumId -> newest last-post UTC ms processed
let autoFa = new Set();             // threadIds auto-discovered because YOU bid there
let faIgnore = new Set();           // threadIds you dismissed from the FA list
const faSnap = new Map();           // threadId -> {analysis, title, kind, updatedUtc, latestStamp, sack…}
const dealSnap = new Map();         // threadId -> {title, involvesMe, lastPostUtc, figures, updatedUtc}
const pending = makeQueue();        // FIFO work queue of "forum:threadId" keys (persisted)

let refreshState = { nextAt: 0 };
let loginRequired = false;
let initializing = true; // true during the one-time historical enumeration
let initDone = false;    // latches once both forums enumerated + backlog drained

// ---- persistence -----------------------------------------------------------
async function saveCfg() { await kv.set('config', cfg); }
async function loadCfg() { cfg = { ...cfgDefaults, ...(await kv.get('config')) }; }
async function loadHighWater() { highWater = (await kv.get('highwater')) || {}; }
async function saveHighWater() { await kv.set('highwater', highWater); }

// Persist parsed snapshots so a page reload shows the last-known data instantly
// (without any upstream request). Maps are stored as [key, value] arrays.
async function saveSnapshots() {
  await kv.set('snapshots', {
    offsetMin,
    faSnap: [...faSnap], dealSnap: [...dealSnap],
    riderThread: [...riderThread], listing: [...listing],
    autoFa: [...autoFa], faIgnore: [...faIgnore], highWater,
    pending: pending.toArray(), crawlState, initDone, version: DATA_VERSION,
  });
}
async function loadSnapshots() {
  const s = await kv.get('snapshots');
  if (!s || s.version !== DATA_VERSION) return; // stale schema -> re-read fresh
  if (s.offsetMin != null) offsetMin = s.offsetMin;
  for (const [k, v] of s.faSnap || []) faSnap.set(+k, v);
  for (const [k, v] of s.dealSnap || []) dealSnap.set(+k, v);
  for (const [k, v] of s.riderThread || []) riderThread.set(+k, v);
  for (const [k, v] of s.listing || []) listing.set(+k, v);
  autoFa = new Set((s.autoFa || []).map(Number));
  faIgnore = new Set((s.faIgnore || []).map(Number));
  pending.load(s.pending || []);
  Object.assign(crawlState, s.crawlState || {});
  initDone = !!s.initDone;
  initializing = !initDone;
}

// Discard everything auto-discovered (keeps manual cfg: shortlist/faThreads/deals).
async function wipeAuto() {
  listing.clear(); faSnap.clear(); dealSnap.clear();
  autoFa.clear(); faIgnore.clear(); riderThread.clear();
  pending.clear();
  for (const k of Object.keys(crawlState)) delete crawlState[k];
  highWater = {}; initDone = false; initializing = true;
  await saveHighWater(); await saveSnapshots();
}

// ---- calibration -----------------------------------------------------------
function calibrate(parsed, fetchedAtUtcMs) {
  if (parsed?.headerClock && fetchedAtUtcMs) {
    const o = computeDisplayOffsetMin(parsed.headerClock, fetchedAtUtcMs);
    if (o != null) offsetMin = o;
  }
}

// ---- listing crawl & discovery --------------------------------------------
// Listings are sorted by last-post descending. We page down from page 1 only
// until we reach threads older than our high-water mark (everything below is
// unchanged since last refresh), so we never miss a thread that was bumped to a
// later page while the tab was closed — and steady state is still one page.
const PAGE_STEP = 20; // threads per listing page (pcmdaily default)
const crawlState = {}; // forumId -> { cursor, initDone } (init pagination progress)
function cst(f) { return (crawlState[f] ??= { cursor: 0, initDone: false }); }

// Record a listing row and, if it's a thread we track and its last-post time
// advanced (or we've never read it), enqueue it for fetching. Enqueue only —
// the paced worker does the actual reads, so nothing is lost if a window is full.
function enqueueChanged(forumId, r) {
  listing.set(r.threadId, { title: r.title, lastPostStamp: r.lastPostStamp, forum: forumId });
  const isFa = forumId === cfg.faForum;
  if (isFa) {
    const rider = riderFromThreadTitle(r.title);
    if (rider && !riderThread.has(rider.id)) riderThread.set(rider.id, r.threadId);
    if (!faThreadKind(r.title) || faIgnore.has(r.threadId)) return; // not a biddable signing
  }
  const snap = isFa ? faSnap.get(r.threadId) : dealSnap.get(r.threadId);
  if (!snap || snap.latestStamp !== r.lastPostStamp) pending.push(forumId + ':' + r.threadId);
}

// Detection. Init: page through the WHOLE forum once (one page per tick) so
// every existing thread is enumerated & enqueued — nothing beyond page 1 is
// missed. Steady: crawl page 1 down to the high-water mark and enqueue changes.
async function detectForum(forumId, ttlMs) {
  const st = cst(forumId);
  if (!st.initDone) {
    const res = await fetchPage(`viewforum.php?forum_id=${forumId}&rowstart=${st.cursor}`, { ttlMs: 10 * 60000 });
    if (res.loginRequired) { loginRequired = true; return; }
    loginRequired = false;
    const { rows, headerClock } = parseListing(res.body);
    if (headerClock) { const o = computeDisplayOffsetMin(headerClock, res.fetchedAtUtcMs); if (o != null) offsetMin = o; }
    for (const r of rows) {
      enqueueChanged(forumId, r);
      const p = parseForumStamp(r.lastPostStamp);
      if (p) { const u = stampToUtcMs(p, offsetMin); if (u > (highWater[forumId] || 0)) highWater[forumId] = u; }
    }
    if (rows.length < PAGE_STEP) { st.initDone = true; st.cursor = 0; } else st.cursor += PAGE_STEP;
    await saveHighWater();
  } else {
    const { newest, loginRequired: g } = await crawlListing({
      prevHW: highWater[forumId] || 0, pageStep: PAGE_STEP,
      getOffset: () => offsetMin, setOffset: (o) => { offsetMin = o; },
      fetchPageFn: (rowstart, page) => fetchPage(`viewforum.php?forum_id=${forumId}&rowstart=${rowstart}`, { ttlMs: page === 0 ? ttlMs : 10 * 60000 }),
      onRow: (r) => enqueueChanged(forumId, r),
    });
    if (g) { loginRequired = true; return; }
    loginRequired = false;
    highWater[forumId] = newest;
    await saveHighWater();
  }
}

// ---- thread fetching -------------------------------------------------------
// Fetch page 1 (+ last page if paginated), merge posts, dedupe by postId.
async function fetchThreadPosts(threadId, ttlMs) {
  const first = await fetchPage(`viewthread.php?thread_id=${threadId}&rowstart=0`, { ttlMs });
  if (first.loginRequired) { loginRequired = true; return null; }
  const p1 = parseThread(first.body);
  calibrate(p1, first.fetchedAtUtcMs);
  let posts = p1.posts;
  let title = p1.title;
  const maxStart = Math.max(...p1.rowstarts);
  if (maxStart > 0) {
    const last = await fetchPage(`viewthread.php?thread_id=${threadId}&rowstart=${maxStart}`, { ttlMs });
    if (!last.loginRequired) {
      const p2 = parseThread(last.body);
      calibrate(p2, last.fetchedAtUtcMs);
      const seen = new Set(posts.map((p) => p.postId));
      posts = posts.concat(p2.posts.filter((p) => !seen.has(p.postId)));
    }
  }
  return { title, posts };
}

async function fetchFaThread(threadId) {
  const t = await fetchThreadPosts(threadId, cfg.refreshSec * 1000).catch(() => null);
  if (!t) return;
  const title = t.title || listing.get(threadId)?.title || '';
  const kind = faThreadKind(title) || 'fa';
  const analysis = analyzeFreeAgentThread(t.posts, offsetMin, cfg.myTeam, openingMinFor(title));
  analysis.threadId = threadId;
  analysis.junior = kind === 'junior';
  const rec = { analysis, title, kind, updatedUtc: Date.now(), latestStamp: listing.get(threadId)?.lastPostStamp ?? null };
  if (kind === 'sack') Object.assign(rec, sackInfo(t.posts, title));
  // team-agnostic facts for the admin aggregator (every team, not just mine)
  const rider = riderFromThreadTitle(title);
  rec.admin = {
    kind, riderName: rider?.n || cleanTitleName(title),
    // DB flag is authoritative for junior status; the [Junior] tag is only a
    // fallback for riders not in the bundled DB. (The 50k-ceiling promotion is
    // applied at roster-count time, where the winning amount is known.)
    junior: rider ? !!rider.j : kind === 'junior',
    leaderTeam: analysis.leadingTeam, leaderAmount: analysis.leadingAmount, winUtcMs: analysis.winUtcMs,
    sackTeam: rec.sackTeam || null, sackWage: rec.sackWage || 0, // for [Sack] threads
    bids: analysis.bids.map((b) => ({ t: b.team, u: b.utcMs })).filter((b) => b.t && b.u != null),
  };
  faSnap.set(threadId, rec);
  // auto-track (or untrack) based on whether YOU are currently bidding here
  if (analysis.myBids.length > 0 && !faIgnore.has(threadId)) autoFa.add(threadId);
  else if (!cfg.faThreads.includes(threadId)) autoFa.delete(threadId);
}

async function fetchDealThread(threadId) {
  const t = await fetchThreadPosts(threadId, cfg.refreshSec * 1000).catch(() => null);
  if (!t) return;
  const wageOf = (name) => { const r = riderByName(name); return r ? (r.w || 0) : null; };
  // Use the winning (highest-money) offer in a bidding-war thread, not the OP.
  const fig = dealFigures(winningDealText(t.posts), cfg.myTeam, wageOf);
  // Anchor the 24h close to the deal proposal: the EARLIEST post time. Deals
  // confirm within a day of the OP, and using the minimum stamp ignores later
  // comments/re-posts and is robust to a missing/garbled opening-post stamp.
  let lastPostUtc = Infinity;
  for (const p of t.posts) { const ps = parseForumStamp(p.stampStr); if (ps) { const u = stampToUtcMs(ps, offsetMin); if (u < lastPostUtc) lastPostUtc = u; } }
  if (!isFinite(lastPostUtc)) lastPostUtc = Date.now();
  // Voided/cancelled deals: a later post declares it off (excluded from totals).
  const voided = t.posts.slice(1).some((p) => /\b(void(ed)?|cancell?ed)\b/i.test(p.text || ''));
  // team-agnostic winning-deal blocks for the admin aggregator (both sides)
  const wd = parseDeal(winningDealText(t.posts));
  dealSnap.set(threadId, {
    title: t.title || listing.get(threadId)?.title, voided,
    involvesMe: fig.involvesMe, isLoan: fig.isLoan, mySide: fig.mySide,
    transferFee: fig.transferFee, loanFee: fig.loanFee, salaryDelta: fig.salaryDelta,
    ridersIn: fig.ridersIn || [], ridersOut: fig.ridersOut || [],
    teamA: fig.teamA, teamB: fig.teamB, dealFee: fig.dealFee, neutralType: fig.neutralType,
    lastPostUtc, updatedUtc: Date.now(),
    latestStamp: listing.get(threadId)?.lastPostStamp ?? null,
    admin: { a: wd.teamA, b: wd.teamB, isLoan: wd.isLoan, voided, opUtc: isFinite(lastPostUtc) ? lastPostUtc : null },
  });
}

// Drain up to n thread reads from the FRONT of the queue.
async function fetchChunk(n) {
  const keys = pending.take(n);
  for (const key of keys) {
    const i = key.indexOf(':');
    const forumId = +key.slice(0, i), threadId = +key.slice(i + 1);
    if (forumId === cfg.faForum) await fetchFaThread(threadId);
    else await fetchDealThread(threadId);
  }
  return keys.length;
}

// ---- paced worker ----------------------------------------------------------
// Every CHUNK_MS: run detection, then read up to THREADS_PER_CHUNK threads.
// The front end is (re)rendered once per refresh window (default 30s), so the UI
// updates in clean atomic batches while the network work is spread out.
const CHUNK_MS = 5000;
const THREADS_PER_CHUNK = 13; // ≈78 threads over a 30s window
let workerTimer = null;
let workerBusy = false;
let lastRenderAt = 0;

async function workerTick() {
  const start = Date.now();
  if (workerBusy) { workerTimer = setTimeout(workerTick, CHUNK_MS); return; }
  workerBusy = true;
  try {
    if (cfg.myTeam) {
      await detectForum(cfg.faForum, cfg.refreshSec * 1000).catch(() => {});
      await detectForum(cfg.dealForum, cfg.refreshSec * 1000).catch(() => {});
      await fetchChunk(THREADS_PER_CHUNK).catch(() => {});
      // init latches done once both forums are enumerated AND the backlog drains
      if (!initDone && cst(cfg.faForum).initDone && cst(cfg.dealForum).initDone && pending.size === 0) initDone = true;
      initializing = !initDone;
      await saveSnapshots();
    }
  } finally {
    workerBusy = false;
    const windowMs = cfg.refreshSec * 1000;
    if (Date.now() - lastRenderAt >= windowMs) { lastRenderAt = Date.now(); render(); }
    refreshState.nextAt = lastRenderAt + windowMs;
    // pace ticks ~every CHUNK_MS measured from the start of this tick
    workerTimer = setTimeout(workerTick, Math.max(500, CHUNK_MS - (Date.now() - start)));
  }
}

function startWorker() {
  clearTimeout(workerTimer);
  lastRenderAt = Date.now();
  refreshState.nextAt = lastRenderAt + cfg.refreshSec * 1000;
  workerTimer = setTimeout(workerTick, CHUNK_MS); // first read one chunk in, not on load
}

const cleanTitleName = (title) => (title || '').replace(/\[[^\]]*\]/g, '').trim();
const parseThreadId = (input) => {
  const m = /thread_id=(\d+)/.exec(input) || /^\s*(\d+)\s*$/.exec(input);
  return m ? +m[1] : null;
};

// From a [Sack] thread: who sacked (first line of the opening post is the team,
// by posting convention), the sacked rider's wage (from the DB), and when.
function sackInfo(posts, title) {
  const op = posts[0];
  const line = (op?.text || '').split('\n').map((s) => s.trim()).find((s) => /[a-z]/i.test(s)) || '';
  const rider = riderFromThreadTitle(title);
  const p = parseForumStamp(op?.stampStr);
  return {
    sackTeam: line,
    sackWage: rider?.w || 0,
    sackTimeUtc: p ? stampToUtcMs(p, offsetMin) : null,
  };
}

// ---- build state & render --------------------------------------------------
function buildState() {
  const nowUtc = Date.now();
  const faAnalyses = [];
  const fa = [];

  // Tracked FA threads: shortlisted riders' discovered threads, manually added,
  // and auto-discovered (you're bidding) — minus any you dismissed.
  const trackedIds = new Set();
  for (const rid of cfg.shortlist) { const t = riderThread.get(rid); if (t) trackedIds.add(t); }
  for (const t of cfg.faThreads) trackedIds.add(t);
  for (const t of autoFa) trackedIds.add(t);
  for (const t of faIgnore) trackedIds.delete(t);

  const shownThreads = new Set();
  for (const threadId of trackedIds) {
    const snap = faSnap.get(threadId);
    const title = snap?.title || listing.get(threadId)?.title || '';
    const kind = snap?.kind || faThreadKind(title) || 'fa';
    const juniorThread = kind === 'junior';       // thread type -> opening minimum
    const openMin = juniorThread ? JUNIOR_MIN : MIN_WAGE;
    const dbRider = riderFromThreadTitle(title);
    const rider = dbRider || { id: `t${threadId}`, n: cleanTitleName(title) || `Thread ${threadId}`, d: '-', w: 0, fa: 1 };
    // DB flag is authoritative for junior status; [Junior] tag is the fallback.
    const junior = dbRider ? !!dbRider.j : juniorThread;
    const analysis = snap?.analysis || { leadingAmount: null, minNextBid: openMin, myHighest: null, amILeading: false, myBids: [], winUtcMs: null };
    analysis.threadId = threadId;
    faAnalyses.push(analysis);
    const completed = !!(analysis.amILeading && analysis.winUtcMs != null && nowUtc >= analysis.winUtcMs);
    fa.push({
      riderId: dbRider?.id, threadId, rider, kind, junior,
      band: fmtBand(analysis.leadingAmount || openMin), completed,
      a: analysis, status: faStatus(analysis, nowUtc), updatedUtc: snap?.updatedUtc,
    });
    shownThreads.add(threadId);
  }
  // shortlisted riders whose thread hasn't been located yet
  for (const riderId of cfg.shortlist) {
    const t = riderThread.get(riderId);
    if (t && shownThreads.has(t)) continue;
    const rider = riderById(riderId);
    if (!rider) continue;
    const analysis = { leadingAmount: null, minNextBid: MIN_WAGE, myHighest: null, amILeading: false, myBids: [], winUtcMs: null, threadId: `r${riderId}` };
    faAnalyses.push(analysis);
    fa.push({
      riderId, threadId: t, rider, kind: 'fa', junior: false,
      band: fmtBand(Math.max(MIN_WAGE, rider.w || 0)), completed: false,
      a: analysis, status: t ? faStatus(analysis, nowUtc) : null,
      updatedUtc: null, locating: !t && !initDone,
    });
  }

  // Collapse duplicate threads for the same rider (junior→FA conversion leaves
  // both on the forum); keep the authoritative one. See dedupeFaByRider.
  const faDedup = dedupeFaByRider(fa);
  fa.length = 0;
  fa.push(...faDedup);

  // deals: include auto-detected (involvesMe) + manually added
  const deals = [];
  const shown = new Set();
  const addDeal = (threadId, snap) => {
    if (shown.has(threadId)) return;
    shown.add(threadId);
    // Everything is read straight from the thread/DB — no manual entry.
    const figures = {
      transferFee: snap?.transferFee ?? null,
      loanFee: snap?.loanFee ?? null,
      salaryAdd: snap?.salaryDelta ?? null, // null = n/a (unknown wage)
    };
    const closeUtc = snap?.lastPostUtc != null ? snap.lastPostUtc + DEAL_MS : null;
    const involvesMe = snap?.involvesMe ?? false;
    const isLoan = snap?.isLoan ?? false;
    // Principal → your-perspective type + figures; third-party (manually added) →
    // a neutral view (the deal's own fee & type) so it still displays properly.
    const type = involvesMe ? dealType(isLoan, snap?.ridersIn, snap?.ridersOut) : (snap?.neutralType || 'deal');
    const display = involvesMe ? figures
      : { transferFee: isLoan ? null : (snap?.dealFee ?? null), loanFee: isLoan ? (snap?.dealFee ?? null) : null, salaryAdd: null };
    deals.push({
      threadId, title: snap?.title || listing.get(threadId)?.title,
      involvesMe, isLoan, type, voided: !!snap?.voided, mySide: snap?.mySide || null,
      ridersIn: snap?.ridersIn || [], ridersOut: snap?.ridersOut || [],
      teams: [snap?.teamA, snap?.teamB].filter(Boolean),
      lastPostUtc: snap?.lastPostUtc, closeUtc, completed: closeUtc != null && nowUtc >= closeUtc,
      figures, display,
    });
  };
  for (const [tid, snap] of dealSnap) if (snap.involvesMe) addDeal(tid, snap);
  for (const tid of cfg.deals) addDeal(tid, dealSnap.get(tid));

  // sacks: only the ones YOUR team made (the [Sack] opening post's team == you).
  const nMy = norm(cfg.myTeam || '');
  const sacks = [];
  for (const [tid, snap] of faSnap) {
    if (snap.kind !== 'sack') continue;
    if (!nMy || norm(snap.sackTeam || '') !== nMy) continue;
    const rider = riderFromThreadTitle(snap.title);
    sacks.push({
      threadId: tid, riderName: rider?.n || cleanTitleName(snap.title) || `Thread ${tid}`,
      rider: rider || { a: null, o: null, p: null },
      wage: snap.sackWage || 0, mine: true,
      timeUtc: snap.sackTimeUtc || null, updatedUtc: snap.updatedUtc,
    });
  }
  // progressive fine: nth sack (by time) costs n × wage
  sacks.sort((a, b) => (a.timeUtc || 0) - (b.timeUtc || 0));
  sacks.forEach((s, i) => { s.fine = (i + 1) * (s.wage || 0); });
  sacks.reverse(); // newest first for display

  // Division: explicit override wins; 'auto' derives from the DB (only reliable
  // when your team is actually in the bundled snapshot).
  const derived = teamDivision(cfg.myTeam);
  const divChosen = cfg.division && cfg.division !== 'auto' ? cfg.division : derived;
  const cap = divisionCap(divChosen || 'CT');
  const dbSquad = squadSalary(cfg.myTeam);
  // Existing salary: use the manual entry; if blank, fall back to the DB (real season).
  const baseSalary = cfg.baseSalary !== '' ? cfg.baseSalary : (dbSquad.count ? dbSquad.salary : '');

  const totals = computeTotals({
    faItems: fa.map((f) => ({ salary: f.a.leadingAmount || 0, amILeading: f.a.amILeading, completed: f.completed })),
    deals: deals.filter((d) => d.involvesMe && !d.voided).map((d) => ({ ...d.figures, isLoan: d.isLoan, completed: d.completed })),
    sacks,
    baseSalary, budget: cfg.budget, reserve: cfg.reserve, cap,
  });
  const usage = dailyUsage(faAnalyses, nowUtc, FIRST_WINDOW_UTC);

  // roster counts for MY team (existing squad ± confirmed/pending signings & deals)
  const rb = { existing: squadRoster(cfg.myTeam), confirmed: { full: 0, jr: 0 }, pending: { full: 0, jr: 0 }, departed: { full: 0, jr: 0 } };
  const addJr = (o, isJr) => { o[isJr ? 'jr' : 'full']++; };
  for (const f of fa) {
    if (!f.a.amILeading) continue;
    // a junior bid above 50k is promoted to a normal (full-slot) signing
    addJr(f.completed ? rb.confirmed : rb.pending, countsAsJunior(f.junior, f.a.leadingAmount));
  }
  for (const d of deals) {
    if (!d.involvesMe || d.voided) continue;
    if (!d.isLoan) { // transfers change ownership
      for (const n of d.ridersIn) addJr(d.completed ? rb.confirmed : rb.pending, juniorByName(n));
      if (d.completed) for (const n of d.ridersOut) addJr(rb.departed, juniorByName(n));
    } else if (d.completed) { // loan-out removes an owned rider from the count; loan-in isn't owned
      for (const n of d.ridersOut) addJr(rb.departed, juniorByName(n));
    }
  }
  for (const k of sacks) addJr(rb.departed, countsAsJunior(k.rider?.j, k.rider?.w)); // your sacks depart
  const roster = rosterCounts(divChosen || 'CT', rb);

  return {
    config: cfg, nowUtc, offsetMin, loginRequired,
    fa, deals, sacks, totals, usage, roster,
    division: { code: divChosen || 'CT', assumed: !divChosen, cap },
    init: { active: initializing, scanned: faSnap.size + dealSnap.size },
    firstWindowUtc: FIRST_WINDOW_UTC, transferCloseUtc: TRANSFER_CLOSE_UTC,
    refresh: refreshState,
  };
}

function render() { ui.render(buildState()); refreshAdmin(); }

// Team-agnostic snapshot the admin panel aggregates (all teams).
function adminSnapshot() {
  const faFacts = [], dealFacts = [];
  for (const [id, s] of faSnap) if (s.admin) faFacts.push({ id, ...s.admin });
  for (const [id, s] of dealSnap) if (s.admin) dealFacts.push({ id, title: s.title, ...s.admin });
  return { riders: allRiders(), teams: allTeamsFull(), faFacts, dealFacts, nowUtc: Date.now(), budgets: cfg.adminBudgets };
}

// Persist an admin-entered per-team budget (keyed by normalized team name), then
// re-push so the admin panel reflects the on-track / exceeded verdict immediately.
async function setAdminBudget(team, amount) {
  const k = norm(team);
  if (!k) return;
  if (amount == null || amount === '' || isNaN(Number(amount))) delete cfg.adminBudgets[k];
  else cfg.adminBudgets[k] = Number(amount);
  await saveCfg();
  refreshAdmin();
}

// ---- 1s ticker (countdowns only; never rebuilds tables) --------------------
function tick() {
  const s = buildState();
  const { fmtBst, fmtDuration } = window.__tzfmt;
  document.getElementById('bstClock').textContent = fmtBst(s.nowUtc);
  const ri = document.getElementById('refreshInfo');
  ri.textContent = `next update in ${Math.max(0, Math.round((s.refresh.nextAt - Date.now()) / 1000))}s`;
  // keep the init banner count live between renders
  document.getElementById('initBanner').classList.toggle('hidden', !(s.init && s.init.active && s.config.myTeam));
  if (s.init) document.getElementById('initCount').textContent = s.init.scanned;
  ui.renderTiming(s); // transfers open/close countdowns → Opened/Closed labels
  document.querySelectorAll('[data-win]').forEach((elm) => {
    const w = +elm.dataset.win;
    if (w) elm.textContent = fmtDuration(w - s.nowUtc);
  });
}

// ---- handlers --------------------------------------------------------------
const handlers = {
  async setTeam(name) {
    const changed = norm(name) !== norm(cfg.myTeam);
    cfg.myTeam = name;
    await saveCfg();
    // A new team invalidates everything auto-discovered (bids, deals, sacks),
    // but keeps threads you added by hand (faThreads / deals / shortlist). The
    // worker re-enumerates from scratch on its next tick.
    if (changed) await wipeAuto();
    render();
  },
  async setRefreshSec(sec) { cfg.refreshSec = sec; await saveCfg(); render(); },
  async setForums(fa, deal) {
    if (fa === cfg.faForum && deal === cfg.dealForum) return;
    cfg.faForum = fa; cfg.dealForum = deal;
    await saveCfg();
    await wipeAuto(); // discovery caches are forum-specific
    render();
  },
  async setDivision(div) { cfg.division = div; await saveCfg(); render(); },
  async setBaseSalary(v) { cfg.baseSalary = v; await saveCfg(); render(); },
  async setBudget(v) { cfg.budget = v; await saveCfg(); render(); },
  async setReserve(v) { cfg.reserve = v; await saveCfg(); render(); },
  async addRider(id) {
    if (!cfg.shortlist.includes(id)) {
      cfg.shortlist.push(id);
      const t = riderThread.get(id); if (t) pending.unshift(cfg.faForum + ':' + t); // fetch it soon
      await saveCfg(); await saveSnapshots(); render();
    }
  },
  async addFaThread(input) {
    const id = parseThreadId(input);
    if (!id) return;
    faIgnore.delete(id);
    if (!cfg.faThreads.includes(id)) cfg.faThreads.push(id);
    pending.unshift(cfg.faForum + ':' + id);
    await saveCfg(); await saveSnapshots(); render();
  },
  // Remove one FA row regardless of source (shortlisted rider / manual / auto).
  async removeFaRow(riderId, threadId) {
    if (riderId != null) cfg.shortlist = cfg.shortlist.filter((x) => x !== riderId);
    if (threadId != null) {
      cfg.faThreads = cfg.faThreads.filter((x) => x !== threadId);
      autoFa.delete(threadId);
      faIgnore.add(threadId);
    }
    await saveCfg(); await saveSnapshots(); render();
  },
  async addDeal(input) {
    const id = parseThreadId(input);
    if (id && !cfg.deals.includes(id)) {
      cfg.deals.push(id);
      pending.unshift(cfg.dealForum + ':' + id);
      await saveCfg(); await saveSnapshots(); render();
    }
  },
  async removeDeal(id) { cfg.deals = cfg.deals.filter((x) => x !== id); await saveCfg(); render(); },
};

// ---- boot ------------------------------------------------------------------
async function boot() {
  await loadDb();
  await loadCfg();
  await loadHighWater();
  await loadSnapshots();
  // expose formatters to the ticker without re-importing
  const tz = await import('./tz.js');
  window.__tzfmt = { fmtBst: tz.fmtBst, fmtDuration: tz.fmtDuration };

  ui.setup(handlers);
  ui.setTeamInput(cfg.myTeam);
  ui.setRefreshSel(cfg.refreshSec);
  ui.setForumInputs(cfg.faForum, cfg.dealForum);
  ui.setDivision(cfg.division);
  ui.setMoneyInputs(cfg.baseSalary, cfg.budget, cfg.reserve);
  setupAdmin(adminSnapshot, setAdminBudget);
  render(); // show cached snapshots immediately
  // The worker's first read happens one chunk in (not on load), then it fetches
  // ~13 threads every 5s and re-renders the whole UI once per refresh window.
  startWorker();
  setInterval(tick, 1000);
}

boot();
