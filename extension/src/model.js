// Domain logic: bid parsing, valid-bid reconstruction, leader/48h status,
// daily limits, transfer windows, and commitment totals.
import { teamsInText, norm } from './ridersdb.js';
import { parseForumStamp, stampToUtcMs, bstDayKey, nextBstMidnight, BST_OFFSET_MIN } from './tz.js';

export const MIN_WAGE = 50000;          // free-agent minimum wage / opening bid
export const JUNIOR_MIN = 20000;        // junior-rider / stagiaire opening bid (2026)
export const WIN_MS = 48 * 3600 * 1000; // 48h with no valid bid -> winner
export const DEAL_MS = 24 * 3600 * 1000;
export const MAX_RIDERS_PER_DAY = 8;
export const MAX_BIDS_PER_DAY = 20;
const EXTRACT_MIN = 5000;               // ignore smaller numbers as non-bids (noise)

// Junior-rider threads use a different opening minimum. Recognise the 2026 tag
// "[Junior]" (and the "[Junior Rider]" variant as a backup), plus the legacy /
// testbed spellings "[Stagiare]" / "[Stagiaire]".
const JUNIOR_TAG_RE = /\[\s*(junior(?:\s*rider)?|stagiaires?|stagiare)\s*\]/i;
const SACK_TAG_RE = /\[\s*sack\s*\]/i;
export function isJuniorThread(title) { return JUNIOR_TAG_RE.test(title || ''); }
export function isSackThread(title) { return SACK_TAG_RE.test(title || ''); }
export function openingMinFor(title) { return isJuniorThread(title) ? JUNIOR_MIN : MIN_WAGE; }
// Which threads in the free-agents forum are biddable signings we should track:
// [Free Agent], [Junior]/[Stagiare], and [Sack] (a sacked rider becomes an FA).
export function faThreadKind(title) {
  if (isJuniorThread(title)) return 'junior';
  if (isSackThread(title)) return 'sack';
  if (/\[\s*free\s*agent\s*\]/i.test(title || '')) return 'fa';
  return null; // not a biddable signing thread (e.g. Silent Auction, admin posts)
}

// First bid window opens Fri 24 Jul 2026 20:00 BST; subsequent windows 00:00 BST daily.
export const FIRST_WINDOW_UTC = Date.UTC(2026, 6, 24, 20 - BST_OFFSET_MIN / 60, 0, 0);
// Transfer window closes Thu 6 Aug 2026 12:00 BST (then unresolved FAs go to silent auction).
export const TRANSFER_CLOSE_UTC = Date.UTC(2026, 7, 6, 12 - BST_OFFSET_MIN / 60, 0, 0);

export function minIncrement(cur) {
  if (cur < 100000) return 5000;
  if (cur < 300000) return 10000;
  if (cur < 600000) return 20000;
  if (cur < 1000000) return 30000;
  return 50000;
}

// The wage band (increment tier) an amount currently sits in, as a range.
const BANDS = [[20000, 50000], [50000, 100000], [100000, 300000], [300000, 600000], [600000, 1000000], [1000000, Infinity]];
export function wageBand(amount) {
  const a = amount || 0;
  for (const [lo, hi] of BANDS) if (a < hi) return { lo, hi };
  return { lo: 1000000, hi: Infinity };
}
export function fmtBand(amount) {
  const { lo, hi } = wageBand(amount);
  const k = (v) => (v >= 1000000 ? (v / 1000000) + 'M' : (v / 1000) + 'k');
  return hi === Infinity ? `€${k(lo)}+` : `€${k(lo)}–€${k(hi)}`;
}

// Classify a deal from your perspective for a coloured label.
export function dealType(isLoan, ridersIn, ridersOut) {
  const inn = (ridersIn || []).length, out = (ridersOut || []).length;
  if (isLoan) return inn ? 'loan-in' : 'loan-out';
  if (inn && out) return 'swap';
  if (inn) return 'buy';
  if (out) return 'sell';
  return 'deal';
}
export const DEAL_TYPE_LABEL = {
  'loan-in': 'Loan in', 'loan-out': 'Loan out', buy: 'Buy', sell: 'Sale', swap: 'Swap', deal: 'Deal',
  loan: 'Loan', transfer: 'Transfer', // neutral (third-party) types
};

// Extract the bid amount (in €) from a post. Real posts are "Team\nAMOUNT\n
// signature", so we take the FIRST whole-thousand amount in range — signatures
// (which may contain big career numbers) come after the bid. This is pure
// extraction; whether the amount is a *valid* bid is decided in analyze.
//
// Handles "55.000€", "55,000", "55k", "1.25m", "1,250,000". A k/m unit must be
// immediately adjacent to the digits and not part of a word, so "55,000\n
// Manager..." is NOT read as 55 million.
export function parseAmount(text) {
  if (!text) return null;
  const re = /(\d[\d.,]*\d|\d)([kmKM])?(?![a-zA-Z0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const rawNum = m[1];
    const suffix = (m[2] || '').toLowerCase();
    let val;
    if (suffix === 'k' || suffix === 'm') {
      const dec = rawNum.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
      const f = parseFloat(dec);
      if (isNaN(f)) continue;
      val = Math.round(f * (suffix === 'k' ? 1e3 : 1e6));
    } else {
      const digits = rawNum.replace(/[^\d]/g, '');
      if (!digits) continue;
      val = parseInt(digits, 10);
    }
    if (val >= EXTRACT_MIN && val <= 30000000 && val % 1000 === 0) return val;
  }
  return null;
}

// The team a bid post belongs to. Prefer a known team name (so a rival mentioned
// in a signature isn't mistaken for the bidder), preferring my own team if
// present; otherwise fall back to the first non-empty line, which by the posting
// convention is the bidder's team (this also makes unknown/old-season teams work).
function bidderTeam(text, myTeam, nMy) {
  const known = teamsInText(text);
  if (nMy && known.some((t) => norm(t) === nMy)) return myTeam;
  if (known.length) return known[0];
  const line = (text || '').split('\n').map((s) => s.trim()).find((s) => /[a-z]/i.test(s));
  return line || null;
}

// Reconstruct the valid-bid sequence for one free-agent thread.
// posts: [{author, stampStr, text}], offsetMin: forum display offset.
// myTeam: exact DB team name. openingMin: first legal bid (50k FA / 20k junior).
export function analyzeFreeAgentThread(posts, offsetMin, myTeam, openingMin = MIN_WAGE) {
  const nMy = norm(myTeam || '');
  let lead = null;        // {amount, team, utcMs, author}
  const myBids = [];      // {utcMs, amount}
  const bidLog = [];
  for (const p of posts) {
    const stamp = parseForumStamp(p.stampStr);
    const utcMs = stamp ? stampToUtcMs(stamp, offsetMin) : null;
    const amount = parseAmount(p.text);
    if (amount == null) continue;
    const team = bidderTeam(p.text, myTeam, nMy);
    const threshold = lead ? lead.amount + minIncrement(lead.amount) : openingMin;
    const valid = team != null && amount >= threshold && amount % 1000 === 0;
    if (team && nMy && norm(team) === nMy && utcMs != null) myBids.push({ utcMs, amount });
    bidLog.push({ utcMs, amount, team, valid });
    if (valid) lead = { amount, team, utcMs, author: p.author };
  }
  const myHighest = myBids.reduce((mx, b) => Math.max(mx, b.amount), 0) || null;
  const amILeading = !!(lead && nMy && norm(lead.team) === nMy);
  return {
    leadingAmount: lead?.amount ?? null,
    leadingTeam: lead?.team ?? null,
    leadingUtcMs: lead?.utcMs ?? null,
    minNextBid: lead ? lead.amount + minIncrement(lead.amount) : openingMin,
    myHighest,
    amILeading,
    myBids,
    bids: bidLog, // full team-agnostic log: {utcMs, amount, team, valid}
    bidCount: bidLog.length,
    winUtcMs: lead?.utcMs != null ? lead.utcMs + WIN_MS : null,
  };
}

// Status label for a free-agent thread given "now".
export function faStatus(a, nowUtc) {
  if (a.leadingAmount == null) return { key: 'nobids', label: 'No valid bids' };
  if (a.winUtcMs != null && nowUtc >= a.winUtcMs) {
    // green only when YOU won them; otherwise they signed elsewhere
    return { key: a.amILeading ? 'won' : 'gone', label: `Signed to ${a.leadingTeam}` };
  }
  const left = a.winUtcMs - nowUtc;
  return { key: left < 6 * 3600 * 1000 ? 'closing' : 'open', label: 'Live', leftMs: left };
}

// Daily bid usage across all analyzed FA threads, for the current BST day.
// Only bids placed within the transfer period count (nothing before it opens).
export function dailyUsage(analyses, nowUtc, windowStartUtc = 0) {
  const day = bstDayKey(nowUtc);
  let bids = 0; const riders = new Set();
  for (const a of analyses) {
    for (const b of a.myBids) {
      if (b.utcMs >= windowStartUtc && bstDayKey(b.utcMs) === day) { bids++; riders.add(a.threadId); }
    }
  }
  return {
    day,
    bidsToday: bids,
    ridersToday: riders.size,
    bidsLeft: Math.max(0, MAX_BIDS_PER_DAY - bids),
    ridersLeft: Math.max(0, MAX_RIDERS_PER_DAY - riders.size),
    nextWindowUtc: nextBstMidnight(nowUtc),
  };
}

// Parse a [Deal]/[Loan Deal] opening post. The format is line-based:
//   Team A:<name> / Rider Out:… / Rider In:… / Money Out:… / Money In:…
//   Team B:<name> / … / (Loan Deal adds "Wage paid by Team X:" + "Loan Clause:")
function dealMoney(s) { const d = (s || '').replace(/[^\d]/g, ''); return d ? parseInt(d, 10) : 0; }
function dealRiders(s) { return (s || '').split(',').map((x) => x.trim()).filter((x) => x && x !== '-'); }

export function parseDeal(opText) {
  const isLoan = /wage paid by|loan clause/i.test(opText || '');
  const blk = { A: { name: '', out: [], in: [], moneyOut: 0, moneyIn: 0, wagePaid: 0 },
                B: { name: '', out: [], in: [], moneyOut: 0, moneyIn: 0, wagePaid: 0 } };
  let cur = null, m;
  for (const line of (opText || '').split('\n').map((l) => l.trim())) {
    if ((m = /^Team\s*A\s*:(.*)$/i.exec(line))) { cur = 'A'; blk.A.name = m[1].trim(); }
    else if ((m = /^Team\s*B\s*:(.*)$/i.exec(line))) { cur = 'B'; blk.B.name = m[1].trim(); }
    else if (!cur) continue;
    else if ((m = /^Riders?\s*Out\s*:(.*)$/i.exec(line))) blk[cur].out = dealRiders(m[1]);
    else if ((m = /^Riders?\s*In\s*:(.*)$/i.exec(line))) blk[cur].in = dealRiders(m[1]);
    else if ((m = /^Money\s*Out\s*:(.*)$/i.exec(line))) blk[cur].moneyOut = dealMoney(m[1]);
    else if ((m = /^Money\s*In\s*:(.*)$/i.exec(line))) blk[cur].moneyIn = dealMoney(m[1]);
    else if ((m = /^Wage paid by Team\s*[AB]\s*:(.*)$/i.exec(line))) blk[cur].wagePaid = dealMoney(m[1]);
    else if (/^(Deal confirmed|Confirmed|Loan Clause)/i.test(line)) cur = null;
  }
  return { teamA: blk.A, teamB: blk.B, isLoan };
}

// A deal thread can be a bidding war (the price escalates across posts as teams
// out-bid each other). The winning deal is the one that moved the most money —
// pick that post's terms rather than the opening proposal.
export function winningDealText(posts) {
  let best = '', bestFee = -1;
  for (const p of posts || []) {
    const d = parseDeal(p.text || '');
    if (!d.teamA.name || !d.teamB.name) continue;
    const fee = Math.max(d.teamA.moneyOut || 0, d.teamA.moneyIn || 0, d.teamB.moneyOut || 0, d.teamB.moneyIn || 0);
    if (fee >= bestFee) { bestFee = fee; best = p.text; } // >= : a later re-post wins ties
  }
  return best || (posts?.[0]?.text || '');
}

// Your-perspective figures for a deal. wageOf(name) -> wage or null (unknown).
// salaryDelta is null when any traded rider's wage is unknown (shows as n/a).
export function dealFigures(opText, myTeam, wageOf) {
  const d = parseDeal(opText);
  const nMy = norm(myTeam || '');
  let side = null, other = null;
  if (nMy && norm(d.teamA.name) === nMy) { side = d.teamA; other = d.teamB; }
  else if (nMy && norm(d.teamB.name) === nMy) { side = d.teamB; other = d.teamA; }
  // You're "involved" only as a principal (Team A/B) — not merely mentioned in a
  // signature, which would false-positive every thread your manager posts in.
  const involvesMe = !!side;
  // Neutral facts about the deal (used to display third-party deals you add by hand).
  const dealFee = Math.max(d.teamA.moneyOut || 0, d.teamA.moneyIn || 0, d.teamB.moneyOut || 0, d.teamB.moneyIn || 0);
  const neutralType = d.isLoan ? 'loan' : ((d.teamA.out.length && d.teamB.out.length) ? 'swap' : 'transfer');
  const common = { isLoan: d.isLoan, teamA: d.teamA.name, teamB: d.teamB.name, dealFee, neutralType };
  if (!side) return { involvesMe, mySide: null, transferFee: null, loanFee: null, salaryDelta: null, ridersIn: [], ridersOut: [], ...common };

  const net = (side.moneyOut || 0) - (side.moneyIn || 0); // + = cash I pay
  let salaryDelta;
  if (d.isLoan) {
    if (side.in.length) salaryDelta = side.wagePaid || 0;            // loaning in: I pay a wage
    else if (side.out.length) salaryDelta = -(other.wagePaid || 0); // loaning out: freed = wage the other side covers
    else salaryDelta = 0;
  } else {
    let sum = 0, known = true;
    for (const r of side.in) { const w = wageOf(r); if (w == null) known = false; else sum += w; }
    for (const r of side.out) { const w = wageOf(r); if (w == null) known = false; else sum -= w; }
    salaryDelta = (side.in.length || side.out.length) ? (known ? sum : null) : 0;
  }
  return {
    involvesMe, mySide: side.name,
    transferFee: d.isLoan ? 0 : net,
    loanFee: d.isLoan ? net : 0,
    salaryDelta,
    ridersIn: side.in, ridersOut: side.out,
    ...common,
  };
}

// Extract candidate € amounts from a deal's opening post (suggestions only).
export function euroAmounts(text) {
  const out = new Set();
  const re = /(\d[\d.,]*\d|\d)/g;
  let m;
  while ((m = re.exec(text))) {
    const digits = m[1].replace(/[^\d]/g, '');
    if (digits.length >= 4) {
      const v = parseInt(digits, 10);
      if (v >= 1000 && v <= 30000000 && v % 1000 === 0) out.add(v);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

// ---- roster size (squad counts vs the division min/max) --------------------
// CT: 15–20, juniors count as ½ toward the 15 minimum (full toward the 20 max).
// PT/PCT: 20–30, juniors count as full. Loaned-out riders are excluded upstream.
export function isCtDivision(div) { return (div || '').toUpperCase() === 'CT'; }
export function rosterLimits(div) { return isCtDivision(div) ? { min: 15, max: 20 } : { min: 20, max: 30 }; }

// The DB "j" flag (and the [Junior] thread tag) mark junior-ELIGIBILITY, not that
// a rider is actually signed as a junior. A rider only counts as a half-rider
// while their money is a junior wage — strictly below the 50k normal-signing
// floor. At/above 50k they were (re)signed as a normal rider and fill a full
// slot. `eligible` is the eligibility flag; `amount` is the rider's current wage
// (existing/traded squad riders) or winning bid (fresh free-agent signings).
export const JUNIOR_WAGE_CEILING = 50000;
export function countsAsJunior(eligible, amount) {
  return !!eligible && (amount || 0) < JUNIOR_WAGE_CEILING;
}

// b = { existing, confirmed, pending, departed }, each { full, jr } (jr = juniors).
// Returns per-bucket totals plus committed / projected weighted counts and flags.
export function rosterCounts(div, b = {}) {
  const ct = isCtDivision(div);
  const lim = rosterLimits(div);
  const bucket = (o = {}) => ({ full: o.full || 0, jr: o.jr || 0, total: (o.full || 0) + (o.jr || 0) });
  const ex = bucket(b.existing), cf = bucket(b.confirmed), pe = bucket(b.pending), de = bucket(b.departed);
  const minW = (full, jr) => (ct ? full + 0.5 * jr : full + jr);
  const maxW = (full, jr) => full + jr;
  const comFull = ex.full + cf.full - de.full, comJr = ex.jr + cf.jr - de.jr;
  const committed = { full: comFull, jr: comJr, total: comFull + comJr, minCount: minW(comFull, comJr), maxCount: maxW(comFull, comJr) };
  const projected = { full: comFull + pe.full, jr: comJr + pe.jr, total: comFull + pe.full + comJr + pe.jr, minCount: minW(comFull + pe.full, comJr + pe.jr), maxCount: maxW(comFull + pe.full, comJr + pe.jr) };
  return {
    ct, min: lim.min, max: lim.max,
    existing: ex, confirmed: cf, pending: pe, departed: de,
    committed, projected,
    underMin: committed.minCount < lim.min, overMax: committed.maxCount > lim.max,
    projUnderMin: projected.minCount < lim.min, projOverMax: projected.maxCount > lim.max,
  };
}

// Progressive sacking fines: the nth rider a team sacks costs n × its wage.
// mine: [{ wage, timeUtc }] — the sacks made by your team.
export function sackFines(mine) {
  const sorted = [...(mine || [])].sort((a, b) => (a.timeUtc || 0) - (b.timeUtc || 0));
  let sum = 0;
  sorted.forEach((s, i) => { sum += (i + 1) * (s.wage || 0); });
  return sum;
}

// Two-axis budget model, assuming you win every free agent you currently lead:
//  * SALARY (wages, vs the division salary cap): existing squad + new free-agent
//    wages + deal salary changes − wages freed by riders you sacked.
//  * BUDGET (cash, vs your entered budget): transfer fees + loan fees + the
//    progressive fines for riders you sacked.
// faItems: [{ salary, amILeading, completed }]
// deals:   [{ salaryAdd, transferFee, loanFee, isLoan, completed }]
export function computeTotals({ faItems = [], deals = [], sacks = [], baseSalary = 0, budget = 0, reserve = 0, cap = 0 }) {
  const S = {
    existing: num(baseSalary),
    faCompleted: 0, faPending: 0,
    transferCompleted: 0, transferPending: 0,
    loanCompleted: 0, loanPending: 0,
  };
  for (const f of faItems) {
    if (!f.amILeading || !f.salary) continue;
    if (f.completed) S.faCompleted += f.salary; else S.faPending += f.salary;
  }
  const F = { transferC: 0, transferP: 0, loanC: 0, loanP: 0 };
  for (const d of deals) {
    const sa = num(d.salaryAdd);
    if (d.isLoan) {
      d.completed ? (S.loanCompleted += sa) : (S.loanPending += sa);
      d.completed ? (F.loanC += num(d.loanFee)) : (F.loanP += num(d.loanFee));
    } else {
      d.completed ? (S.transferCompleted += sa) : (S.transferPending += sa);
      d.completed ? (F.transferC += num(d.transferFee)) : (F.transferP += num(d.transferFee));
    }
  }
  const transfer = F.transferC + F.transferP, loan = F.loanC + F.loanP;
  // Sacks only count when they're yours: they free wages and incur a fine.
  const mine = sacks.filter((s) => s.mine);
  const sackReduction = mine.reduce((x, s) => x + (s.wage || 0), 0);
  const fines = sackFines(mine);

  const projected = S.existing + S.faCompleted + S.faPending
    + S.transferCompleted + S.transferPending + S.loanCompleted + S.loanPending - sackReduction;
  const bud = num(budget), res = num(reserve);
  // The whole projected squad salary draws on the budget, alongside fees,
  // fines and the reserve.
  const spend = transfer + loan + fines + res + projected;
  return {
    salary: { ...S, sackReduction, projected, cap, over: cap > 0 && projected > cap },
    budget: { salary: projected, ...F, transfer, loan, fines, reserve: res, spend, budget: bud, over: bud > 0 && spend > bud },
  };
}

function num(v) { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; }

export function fmtEuro(v) {
  if (v == null || isNaN(v)) return '—';
  return '€' + Math.round(v).toLocaleString('en-US');
}
