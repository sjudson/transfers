// Loads the bundled database snapshot (riders.json / teams.json) and provides
// lookups: rider by id, rider by name (for "[Free Agent] Name" thread titles),
// team detection inside post bodies, and current squad salary per team.
let RIDERS = [];
let BY_ID = new Map();
let BY_NAME = new Map();     // normalized name -> rider (may collide; keep first)
let TEAMS = [];              // [{name, norm}] sorted longest-first for matching

export function norm(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function loadDb() {
  const [rj, tj] = await Promise.all([
    fetch(chrome.runtime.getURL('data/riders.json')).then((r) => r.json()),
    fetch(chrome.runtime.getURL('data/teams.json')).then((r) => r.json()),
  ]);
  RIDERS = rj.riders;
  BY_ID = new Map(RIDERS.map((r) => [r.id, r]));
  BY_NAME = new Map();
  for (const r of RIDERS) {
    const k = norm(r.n);
    if (!BY_NAME.has(k)) BY_NAME.set(k, r);
  }
  TEAMS = tj.teams.map((name) => ({ name, norm: norm(name) }))
    .sort((a, b) => b.norm.length - a.norm.length);
  return { count: RIDERS.length, teams: TEAMS.length };
}

export const riderById = (id) => BY_ID.get(+id) || null;
export const allTeams = () => TEAMS.map((t) => t.name);
export const allRiders = () => RIDERS;

export function riderByName(name) {
  return BY_NAME.get(norm(name)) || null;
}

// Search riders by free-text (name / team), for the shortlist picker.
export function searchRiders(q, limit = 20) {
  const nq = norm(q);
  if (!nq) return [];
  const toks = nq.split(' ').filter(Boolean);
  const scored = [];
  for (const r of RIDERS) {
    const hay = norm(r.n) + ' ' + norm(r.t);
    if (toks.every((t) => hay.includes(t))) {
      // prefer free agents and name-start matches
      const s = (r.fa ? 0 : 5) + (norm(r.n).startsWith(toks[0]) ? 0 : 2);
      scored.push([s, r]);
    }
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n));
  return scored.slice(0, limit).map((x) => x[1]);
}

// From "[Free Agent] Remco Evenepoel" -> rider record (or null).
export function riderFromThreadTitle(title) {
  const cleaned = (title || '').replace(/\[[^\]]*\]/g, ' ').trim();
  const direct = riderByName(cleaned);
  if (direct) return direct;
  // fallback: try matching the longest trailing name-ish substring
  const nc = norm(cleaned);
  if (!nc) return null;
  return BY_NAME.get(nc) || null;
}

// Detect known team names present in a post body. Returns array of team names
// (exact DB spelling), longest matches first, de-duplicated.
export function teamsInText(text) {
  const nt = ' ' + norm(text) + ' ';
  const found = [];
  const used = [];
  for (const t of TEAMS) {
    if (t.norm.length < 4) continue;
    if (nt.includes(' ' + t.norm + ' ') || nt.includes(t.norm)) {
      // avoid double-counting a shorter name contained in an already-found one
      if (!used.some((u) => u.includes(t.norm))) {
        found.push(t.name);
        used.push(t.norm);
      }
    }
  }
  return found;
}

// Current squad salary (sum of wages) for a team, from the DB snapshot.
export function squadSalary(teamName) {
  const nt = norm(teamName);
  let sum = 0, count = 0;
  for (const r of RIDERS) {
    if (norm(r.t) === nt) { sum += r.w || 0; count++; }
  }
  return { salary: sum, count };
}

export function divisionCap(div) {
  const d = (div || '').toUpperCase();
  if (d.startsWith('PT') || d === 'PT') return 3500000;
  if (d.startsWith('PCT') || d.startsWith('PROC')) return 2500000;
  return 1200000; // CT
}

export function teamDivision(teamName) {
  const nt = norm(teamName);
  for (const r of RIDERS) if (norm(r.t) === nt) return r.d;
  return null;
}
