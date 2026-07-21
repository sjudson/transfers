// Timezone handling.
//
// The forum renders "Posted on DD-MM-YYYY HH:MM" in whatever timezone the
// logged-in user's profile is set to. We must not assume it is BST. Instead we
// self-calibrate: every fetched page carries a header clock in a .sub-header
// cell ("DD-MM-YYYY HH:MM"). Comparing that to the response's real UTC time
// (the HTTP Date header, captured at fetch) tells us the forum's *display*
// offset. We then convert every parsed post time to UTC, and to BST for the UI.
//
// BST (British Summer Time, used by the transfer rules) is UTC+1 for the whole
// transfer season (late July -> autumn is BST until the last Sunday of October).

export const BST_OFFSET_MIN = 60; // UTC+1

// Parse "DD-MM-YYYY HH:MM" into {y,mo,d,h,mi} (all numbers), or null.
export function parseForumStamp(s) {
  const m = /(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  return { d: +m[1], mo: +m[2], y: +m[3], h: +m[4], mi: +m[5] };
}

// Treat a {y,mo,d,h,mi} as if it were UTC wall-clock and return epoch ms.
function asUtcMs(p) {
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
}

// Given the forum header clock string and the true UTC epoch ms at fetch time,
// return the forum display offset in minutes (displayTime = UTC + offset).
// Rounded to the nearest 15 minutes to absorb clock skew / minute rounding.
export function computeDisplayOffsetMin(headerClock, fetchedAtUtcMs) {
  const p = parseForumStamp(headerClock);
  if (!p) return null;
  const shownAsUtc = asUtcMs(p);
  let diff = shownAsUtc - fetchedAtUtcMs; // ms
  const min = Math.round(diff / 60000 / 15) * 15;
  // Clamp to a sane range (-12h .. +14h)
  if (min < -720 || min > 840) return null;
  return min;
}

// Convert a parsed forum stamp (in display tz with `offsetMin`) to UTC epoch ms.
export function stampToUtcMs(p, offsetMin) {
  return asUtcMs(p) - offsetMin * 60000;
}

// Format a UTC epoch ms as BST "DD Mon HH:MM".
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function fmtBst(utcMs) {
  if (utcMs == null) return '—';
  const d = new Date(utcMs + BST_OFFSET_MIN * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} BST`;
}

// BST day key (YYYY-MM-DD) that a UTC ms falls into. Bid-day windows start at
// 00:00 BST, so the "day" is computed in BST.
export function bstDayKey(utcMs) {
  const d = new Date(utcMs + BST_OFFSET_MIN * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Epoch ms for the next 00:00 BST boundary strictly after utcMs.
export function nextBstMidnight(utcMs) {
  const d = new Date(utcMs + BST_OFFSET_MIN * 60000);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return next - BST_OFFSET_MIN * 60000;
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  let out;
  if (d > 0) out = `${d}d ${h}h`;
  else if (h > 0) out = `${h}h ${m}m`;
  else out = `${m}m`;
  return neg ? `-${out}` : out;
}
