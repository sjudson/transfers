// Test harness: exercises the REAL extension modules under jsdom + a fake
// chrome/fetch, against saved live HTML samples where available.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const SAMP = path.join(HERE, '..', 'research', 'samples');

// ---- DOM + chrome + fetch shims -------------------------------------------
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
globalThis.chrome = { runtime: { getURL: (p) => path.join(EXT, p) } };
globalThis.fetch = async (p) => {
  const buf = readFileSync(p, 'utf8');
  return { json: async () => JSON.parse(buf), text: async () => buf };
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ---- imports (after shims) -------------------------------------------------
const tz = await import(path.join(EXT, 'src/tz.js'));
const model = await import(path.join(EXT, 'src/model.js'));
const rdb = await import(path.join(EXT, 'src/ridersdb.js'));
const parse = await import(path.join(EXT, 'src/parse.js'));

await rdb.loadDb();

// ============================ TZ ===========================================
console.log('\n[timezone]');
{
  const fetchedAt = Date.parse('Mon, 20 Jul 2026 13:46:08 GMT');
  eq('offset from 14:46 header vs 13:46Z = +60m', tz.computeDisplayOffsetMin('20-07-2026 14:46', fetchedAt), 60);
  eq('offset when forum shows UTC = 0', tz.computeDisplayOffsetMin('20-07-2026 13:46', fetchedAt), 0);
  const p = tz.parseForumStamp('24-07-2026 20:00');
  const utc = tz.stampToUtcMs(p, 60); // BST 20:00 -> 19:00Z
  eq('BST 20:00 -> 19:00Z', new Date(utc).toISOString(), '2026-07-24T19:00:00.000Z');
  ok('bstDayKey rolls at 00:00 BST', tz.bstDayKey(Date.parse('2026-07-24T22:30:00Z')) === '2026-07-24' &&
     tz.bstDayKey(Date.parse('2026-07-24T23:30:00Z')) === '2026-07-25');
}

// ============================ bid parsing ==================================
console.log('\n[parseAmount]');
{
  const cases = [
    ['Rabobank\n55.000€', 55000], ['bid 55,000', 55000], ['€120000', 120000],
    ['55k', 55000], ['1.25m', 1250000], ['My bid: 300.000€', 300000],
    ['1,250,000€', 1250000], ['nothing here', null],
    ['52250', null],                                   // not a full thousand
    ['49.000€', 49000],                                // pure extraction (validity is separate)
    // regression: the k/m unit must not eat the "M" of a following word
    ['Polar\n55,000\nManager of Polar in Man-Game', 55000],
    ['Spark Team NZ\n60,000\nManager of Spark - Liquigas Pro Team - PCT MG', 60000],
    ['Newton Foundation p/b Zwift\n50,000\n Zwift - Newton Foundation | MG History', 50000],
    ['Euskotren - Pays Basque\n15,000\nsig', 15000],   // junior/stagiaire below 50k
  ];
  for (const [t, want] of cases) eq(JSON.stringify(t), model.parseAmount(t), want);
}

console.log('\n[junior / stagiaire classification]');
{
  ok('[Junior] is junior', model.isJuniorThread('[Junior] Someone'));
  ok('[Junior Rider] is junior (backup)', model.isJuniorThread('[Junior Rider] Someone'));
  ok('[Stagiare] is junior (testbed)', model.isJuniorThread('[Stagiare] Robert Donaldson'));
  ok('[Free Agent] is not junior', !model.isJuniorThread('[Free Agent] Jay McCarthy'));
  eq('junior opening min', model.openingMinFor('[Stagiare] X'), 20000);
  eq('FA opening min', model.openingMinFor('[Free Agent] X'), 50000);
  // junior thread analysis: 20k opening, +5k increments
  const jr = model.analyzeFreeAgentThread([
    { author: 'a', stampStr: '24-07-2026 20:00', text: 'Alpha\n20,000' },
    { author: 'b', stampStr: '24-07-2026 20:05', text: 'Beta\n25,000' },
  ], 60, 'Alpha', 20000);
  eq('junior leader = Beta 25k', jr.leadingAmount, 25000);
  eq('junior min next = 30k', jr.minNextBid, 30000);
}

console.log('\n[minIncrement]');
{
  eq('50k->+5k', model.minIncrement(50000), 5000);
  eq('100k->+10k', model.minIncrement(100000), 10000);
  eq('300k->+20k', model.minIncrement(300000), 20000);
  eq('600k->+30k', model.minIncrement(600000), 30000);
  eq('1.2m->+50k', model.minIncrement(1200000), 50000);
}

// ============================ ridersdb =====================================
console.log('\n[ridersdb]');
{
  const teams = rdb.allTeams();
  ok('61 teams loaded (56 DB + 5 new CT incl. Karthago)', teams.length === 61, String(teams.length));
  ok('allTeamsFull carries divisions', rdb.allTeamsFull().every((t) => t.name && t.div));
  eq('new CT team present with CT division', rdb.teamDivision('Billstedt-Horn'), 'CT');
  const aman = rdb.riderById(5);
  ok('rider 5 is Awet Aman (FA)', aman && aman.n === 'Awet Aman' && aman.fa === 1);
  eq('riderFromThreadTitle [Free Agent] Awet Aman', rdb.riderFromThreadTitle('[Free Agent] Awet Aman')?.id, 5);
  const t0 = teams[Math.floor(teams.length / 2)];
  ok(`teamsInText finds "${t0}"`, rdb.teamsInText(`We bid.\n${t0}\n80.000€`).includes(t0));
  ok('squadSalary returns a positive sum for a real team',
     rdb.squadSalary(teams.find((t) => rdb.squadSalary(t).count > 0)).salary > 0);
}

// ============================ FA analysis (synthetic) ======================
console.log('\n[analyzeFreeAgentThread]');
{
  const teams = rdb.allTeams();
  const A = teams[0], B = teams[1];
  const mk = (team, amt, stamp) => ({ author: 'x', stampStr: stamp, text: `${team}\n${amt}€` });
  const posts = [
    mk(A, '50.000', '24-07-2026 20:05'),
    mk(B, '55.000', '24-07-2026 20:10'),
    mk(A, '54.000', '24-07-2026 20:11'), // invalid: below min increment over 55k
    mk(A, '60.000', '24-07-2026 21:00'),
  ];
  const a = model.analyzeFreeAgentThread(posts, 60, A);
  eq('leader amount 60k', a.leadingAmount, 60000);
  eq('leader team A', a.leadingTeam, A);
  ok('I (A) am leading', a.amILeading === true);
  eq('my highest = 60k', a.myHighest, 60000);
  eq('min next bid = 65k', a.minNextBid, 65000);
  const winISO = new Date(a.winUtcMs).toISOString();
  eq('win = last valid bid +48h', winISO, '2026-07-26T20:00:00.000Z'); // 24 Jul 21:00 BST = 20:00Z +48h
  // daily usage
  a.threadId = 999;
  const u = model.dailyUsage([a], Date.parse('2026-07-24T20:30:00Z'));
  // A posted 3 bids (incl. one below min increment). Placed bids all count
  // toward the daily limit, valid or not — the conservative reading.
  eq('bids today = all placed bids by A', u.bidsToday, 3);
  eq('riders today', u.ridersToday, 1);
}

// ===== invalid own bid: "your bid" = highest VALID; a rejected raise is flagged =
console.log('\n[invalid own bid (De Lie 67205)]');
{
  const A = rdb.allTeams()[0], X = rdb.allTeams()[1];
  const mk = (team, amt, stamp) => ({ author: 'x', stampStr: stamp, text: `${team}\n${amt}€` });
  const posts = [
    mk(A, '570.000', '25-08-2024 20:00'),   // valid opening
    mk(X, '600.000', '25-08-2024 21:00'),   // valid (≥ 590k)
    mk(A, '625.000', '26-08-2024 09:29'),   // invalid: min over 600k is +30k → 630k
  ];
  const a = model.analyzeFreeAgentThread(posts, 60, A);
  eq('leader is X at 600k', a.leadingAmount, 600000);
  ok('A is not leading (625k was rejected)', a.amILeading === false);
  eq('your bid = highest VALID (570k)', a.myHighest, 570000);
  eq('rejected raise surfaced (625k)', a.myInvalidHigh, 625000);
  // when a later valid bid tops your invalid one, nothing is flagged
  const a2 = model.analyzeFreeAgentThread([
    mk(X, '50.000', '25-08-2024 20:00'), mk(A, '54.000', '25-08-2024 20:05'), mk(A, '60.000', '25-08-2024 20:10'),
  ], 60, A);
  eq('no rejected flag when a valid bid is higher', a2.myInvalidHigh, null);
  eq('your bid = 60k', a2.myHighest, 60000);
}

// ===== dedupe rider across junior→FA conversion threads =====================
console.log('\n[dedupeFaByRider]');
{
  const juniorThread = { riderId: 42, threadId: 100, updatedUtc: 10, a: { leadingAmount: 25000, leadingUtcMs: 100 } };
  const faThread = { riderId: 42, threadId: 200, updatedUtc: 20, a: { leadingAmount: 50000, leadingUtcMs: 200 } };
  const other = { riderId: 7, threadId: 300, updatedUtc: 5, a: { leadingAmount: 80000, leadingUtcMs: 300 } };
  const out = model.dedupeFaByRider([juniorThread, faThread, other]);
  eq('two entries after dedupe (rider 42 collapsed)', out.length, 2);
  ok('kept the escalated FA thread (50k), not the junior (25k)', out.some((f) => f.threadId === 200) && !out.some((f) => f.threadId === 100));
  ok('unrelated rider is untouched', out.some((f) => f.riderId === 7));
  // tie on amount → most recent activity wins
  const t1 = { riderId: 9, threadId: 1, updatedUtc: 1, a: { leadingAmount: 50000, leadingUtcMs: 1 } };
  const t2 = { riderId: 9, threadId: 2, updatedUtc: 2, a: { leadingAmount: 50000, leadingUtcMs: 2 } };
  const out2 = model.dedupeFaByRider([t1, t2]);
  eq('tie broken by recency', out2[0].threadId, 2);
  // unresolved riders (riderId null) are never merged
  const u1 = { riderId: null, threadId: 11, updatedUtc: 1, a: { leadingAmount: 0 } };
  const u2 = { riderId: null, threadId: 12, updatedUtc: 1, a: { leadingAmount: 0 } };
  eq('null-rider threads kept separate', model.dedupeFaByRider([u1, u2]).length, 2);
}

// ============================ commitments ==================================
console.log('\n[computeTotals: salary breakdown + budget + sacks]');
{
  const faItems = [
    { salary: 120000, amILeading: true, completed: false },   // pending FA
    { salary: 50000, amILeading: true, completed: true },     // completed FA
    { salary: 90000, amILeading: false, completed: false },   // not mine
  ];
  const deals = [
    { transferFee: 250000, loanFee: 0, salaryAdd: 80000, isLoan: false, completed: true },   // completed transfer
    { transferFee: 0, loanFee: 30000, salaryAdd: -20000, isLoan: true, completed: false },   // pending loan (frees salary)
  ];
  const sacks = [
    { mine: true, wage: 60000, timeUtc: 100 },
    { mine: true, wage: 50000, timeUtc: 200 },
    { mine: false, wage: 999000, timeUtc: 300 },
  ];
  const t = model.computeTotals({ faItems, deals, sacks, baseSalary: '1000000', budget: '600000', reserve: '100000', cap: 1200000 });
  eq('FA pending', t.salary.faPending, 120000);
  eq('FA completed', t.salary.faCompleted, 50000);
  eq('transfer completed salary', t.salary.transferCompleted, 80000);
  eq('loan pending salary (freed)', t.salary.loanPending, -20000);
  // 1,000,000 + 120k + 50k + 80k − 20k − sacks(110k) = 1,120,000
  eq('projected salary', t.salary.projected, 1120000);
  eq('sack reduction (mine only)', t.salary.sackReduction, 110000);
  // budget: transfer 250k (completed) + loan 30k (pending) + fines 160k + reserve 100k + projected salary 1,120k
  eq('sacking fines progressive', t.budget.fines, 160000);
  eq('full projected salary against budget', t.budget.salary, 1120000);
  eq('transfer fee completed', t.budget.transferC, 250000);
  eq('transfer fee pending', t.budget.transferP, 0);
  eq('loan fee pending', t.budget.loanP, 30000);
  eq('projected budget spend', t.budget.spend, 1660000);
  const over = model.computeTotals({ faItems: [{ salary: 100000, amILeading: true, completed: false }], baseSalary: '1200000', cap: 1200000 });
  eq('salary over cap flagged', over.salary.over, true);
}

console.log('\n[wage bands + deal types]');
{
  eq('band of 60k', model.fmtBand(60000), '€50k–€100k');
  eq('band of 250k', model.fmtBand(250000), '€100k–€300k');
  eq('band of 1.5M', model.fmtBand(1500000), '€1M+');
  eq('junior band <50k', model.fmtBand(30000), '€20k–€50k');
  eq('buy', model.dealType(false, ['A'], []), 'buy');
  eq('sell', model.dealType(false, [], ['B']), 'sell');
  eq('swap', model.dealType(false, ['A'], ['B']), 'swap');
  eq('loan-in', model.dealType(true, ['A'], []), 'loan-in');
  eq('loan-out', model.dealType(true, [], ['B']), 'loan-out');
  // bidding war: winning deal = highest money moved, not the opening post
  const war = [
    { text: 'Team A:Minions\nRider Out:Ziga\nMoney In:€70,000\nTeam B:Cervelo\nRider In:Ziga\nMoney Out:€70,000' },
    { text: 'Team A:Minions\nRider Out:Ziga\nMoney In:€150,000\nTeam B:Lidl\nRider In:Ziga\nMoney Out:€150,000' },
    { text: 'Team A:Minions\nRider Out:Ziga\nMoney In:€200,000\nTeam B:Cervelo\nRider In:Ziga\nMoney Out:€200,000' },
  ];
  const win = model.dealFigures(model.winningDealText(war), 'Cervelo', () => 90000);
  eq('winning deal fee = 200k (Cervelo pays)', win.transferFee, 200000);
  eq('winning buyer is me', win.involvesMe, true);
}

// ============================ parse real HTML ==============================
console.log('\n[parse real samples]');
{
  const thread = readFileSync(path.join(SAMP, 'rules.html'), 'utf8');
  const pt = parse.parseThread(thread);
  ok('thread title parsed', /Transfer Rules 2026/.test(pt.title), pt.title);
  ok('>=1 post parsed', pt.posts.length >= 1, String(pt.posts.length));
  ok('first author = ManGame-Admin', pt.posts[0].author === 'ManGame-Admin', pt.posts[0].author);
  ok('first post has a stamp', !!pt.posts[0].stampStr, pt.posts[0].stampStr);
  ok('post body non-empty', pt.posts[0].text.length > 20);
  ok('header clock parsed', /\d{2}-\d{2}-\d{4}/.test(pt.headerClock || ''), pt.headerClock);

  const listing = readFileSync(path.join(SAMP, 'forum70.html'), 'utf8');
  const rows = parse.parseForumListing(listing);
  ok('listing rows parsed', rows.length > 3, String(rows.length));
  const rules = rows.find((r) => r.threadId === 72684);
  ok('finds thread 72684 in listing', !!rules, JSON.stringify(rows[0]));
  ok('row has a last-post stamp', !!rules?.lastPostStamp, rules?.lastPostStamp);

  // parseListing: rows + header clock in one parse (used by the incremental crawl)
  const pl = parse.parseListing(listing);
  eq('parseListing returns same row count', pl.rows.length, rows.length);
  ok('parseListing extracts a header clock', /\d{2}-\d{2}-\d{4}/.test(pl.headerClock || ''), pl.headerClock);
}

// ============ realistic bid thread (observed markup + a quote) =============
console.log('\n[parse+analyze a realistic bid thread]');
{
  const teams = rdb.allTeams();
  const A = teams[0], B = teams[1];
  const post = (pid, user, stamp, bodyHtml) => `
    <tr>
      <td class='tbl2 forum_thread_user_name' style='width:140px'><a href='../profile.php?lookup=${pid}' class='profile-link'>${user}</a></td>
      <td class='tbl2 forum_thread_post_date'>
        <a href='#post_${pid}' id='post_${pid}'>#${pid}</a>
        <div class='small'>Posted on ${stamp}</div>
      </td>
    </tr>
    <tr>
      <td class='tbl2 forum_thread_user_info' style='width:140px'><span class='small'>DS</span></td>
      <td class='tbl1 forum_thread_user_post'>${bodyHtml}</td>
    </tr>`;
  const html = `<!doctype html><html><body>
    <td class='sub-header'>24-07-2026 21:30</td>
    <div class='forum_thread_title'><strong>[Free Agent] Test Rider</strong></div>
    <table class='forum_thread_table'>
      ${post(1, 'alice', '24-07-2026 20:05', `${A}<br />50.000&euro;`)}
      ${post(2, 'bob',   '24-07-2026 20:10', `${B}<br />55.000&euro;`)}
      ${post(3, 'alice', '24-07-2026 20:20',
        `<div class='quote'>bob wrote:<br />${B}<br />55.000&euro;</div>${A}<br />60.000&euro;`)}
      ${post(4, 'bob',   '24-07-2026 20:40', `${B}<br />62.000&euro;`)}
      ${post(5, 'bob',   '24-07-2026 20:45', `${B}<br />65.000&euro;`)}
    </table>
  </body></html>`;

  const pt = parse.parseThread(html);
  eq('5 posts parsed', pt.posts.length, 5);
  ok('quote stripped from post 3 body', !pt.posts[2].text.includes('55.000'), pt.posts[2].text);

  const a = model.analyzeFreeAgentThread(pt.posts, 60, A);
  eq('leader = B (65k)', a.leadingTeam, B);
  eq('leading amount = 65k', a.leadingAmount, 65000);
  ok('B 62k rejected (below +5k over A 60k), then 65k valid', a.leadingAmount === 65000);
  ok('A not leading', a.amILeading === false);
  eq('A highest = 60k (own bid, not quoted 55k)', a.myHighest, 60000);
  eq('min next over 65k = 70k', a.minNextBid, 70000);
}

// ============ incremental listing crawl (high-water paging) ================
console.log('\n[crawlListing high-water paging]');
{
  const crawl = await import(path.join(EXT, 'src/crawl.js'));
  // Build a synthetic forum: N threads sorted last-post DESC, 1 minute apart.
  // Thread i (0=newest) posted at 12:00 - i minutes on 24-07-2026 (BST=+60).
  const base = Date.parse('2026-07-24T11:00:00Z'); // 12:00 BST
  const stampOf = (i) => {
    const d = new Date(base - i * 60000 + 60 * 60000); // display in BST
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const utcOf = (i) => base - i * 60000;
  const listingHtml = (rowsIdx) => `<!doctype html><html><body>
    <td class='sub-header'>24-07-2026 12:05</td>
    <table>${rowsIdx.map((i) => `<tr>
      <td class='tbl1'><a href='viewthread.php?thread_id=${1000 + i}'>Thread ${i}</a></td>
      <td class='tbl2'><a href='../profile.php?lookup=1' class='profile-link'>u</a></td>
      <td class='tbl1'>50</td><td class='tbl2'>3</td>
      <td class='tbl1'>${stampOf(i)}<br /><span class='small'>by <a href='#'>u</a></span></td>
    </tr>`).join('')}</table></body></html>`;

  const TOTAL = 55, STEP = 20; // 3 pages, last one partial (15 rows)
  const makeFetch = () => {
    const reads = [];
    const fn = async (rowstart) => {
      reads.push(rowstart);
      const idx = [];
      for (let i = rowstart; i < Math.min(rowstart + STEP, TOTAL); i++) idx.push(i);
      return { body: listingHtml(idx), fetchedAtUtcMs: Date.parse('2026-07-24T11:05:00Z') };
    };
    return { fn, reads };
  };
  const run = async (prevHW) => {
    const { fn, reads } = makeFetch();
    let off = 60; const seen = [];
    const res = await crawl.crawlListing({
      fetchPageFn: fn, prevHW, pageStep: STEP,
      getOffset: () => off, setOffset: (o) => { off = o; },
      onRow: (r) => seen.push(r.threadId),
    });
    return { res, reads, seen };
  };

  // First run (prevHW=0): capped at 4 pages, but only 3 pages of data exist.
  const first = await run(0);
  eq('first run reads all 3 pages', first.reads.length, 3);
  eq('first run newest = thread 0 time', first.res.newest, utcOf(0));

  // Steady state: prevHW = newest; nothing newer -> reads only page 1 and stops.
  const steady = await run(utcOf(0));
  eq('steady state reads 1 page', steady.reads.length, 1);
  ok('steady state captured page-1 threads', steady.seen.includes(1000) && steady.seen.includes(1019));

  // Caught closed a while: 25 threads newer than prevHW (which sits at index 25).
  const catchUp = await run(utcOf(25));
  eq('catch-up spanning >1 page reads 2 pages', catchUp.reads.length, 2);
  ok('catch-up captured all 25 changed threads',
     Array.from({ length: 25 }, (_, i) => 1000 + i).every((id) => catchUp.seen.includes(id)));
  ok('catch-up stopped before paging the whole forum', catchUp.reads.length < 3);

  // Login gate is surfaced, not silently swallowed.
  const gated = await crawl.crawlListing({
    fetchPageFn: async () => ({ loginRequired: true }), prevHW: 0,
    getOffset: () => 60, setOffset: () => {}, onRow: () => {},
  });
  ok('login gate reported', gated.loginRequired === true);
}

// ============ deal auto-parsing ============================================
console.log('\n[dealFigures]');
{
  // real captured OP (Benetton sells Oscar Cabanas for 50k, receives cash)
  const op = 'Team A:Benetton Bimex Cycling\nRider Out:Oscar Cabanas\nRider In: -\nMoney Out: 0\nMoney In:50.000\nTeam B:Euskotren - Pays Basque\nRider Out:-\nRider In:Oscar Cabanas\nMoney Out:50.000\nMoney In:0\nDeal confirmed by Benetton Bimex Cycling';
  const wageOf = (n) => (n === 'Oscar Cabanas' ? 80000 : null);
  const f = model.dealFigures(op, 'Benetton Bimex Cycling', wageOf);
  ok('involvesMe', f.involvesMe === true);
  eq('transfer fee = net cash (received 50k)', f.transferFee, -50000);
  eq('salary Δ = −wage of sold rider', f.salaryDelta, -80000);
  ok('rider out captured', f.ridersOut.includes('Oscar Cabanas'));
  // unknown wage -> n/a
  const f2 = model.dealFigures(op, 'Benetton Bimex Cycling', () => null);
  eq('salary Δ n/a when wage unknown', f2.salaryDelta, null);
  // the other side pays the fee
  const f3 = model.dealFigures(op, 'Euskotren - Pays Basque', wageOf);
  eq('buyer pays 50k', f3.transferFee, 50000);
  eq('buyer gains wage', f3.salaryDelta, 80000);
  // loan deal: money is a loan fee, salary from wagePaid fields (no DB needed)
  const loan = 'Team A:Carlsberg - Danske Bank\nRider Out:Tobias Lund Andresen\nRiders\' Wage:€ 170,000\nMoney Out:€ 290,000\nMoney In:€ 0\nWage paid by Team A:€ 150,000\nTeam B:Ekoi - Le Creuset\nRider In:Tobias Lund Andresen\nMoney Out:€ 0\nMoney In:€ 290,000\nWage paid by Team B:€ 20,000\nLoan Clause:reach level 3';
  const l = model.dealFigures(loan, 'Ekoi - Le Creuset', () => null);
  ok('loan detected', l.isLoan === true);
  eq('loan fee (B receives 290k)', l.loanFee, -290000);
  eq('loan-in salary = wage B pays', l.salaryDelta, 20000);

  // "---" empty-slot placeholders must not be parsed as riders (real thread 67xxx:
  // DK Žalgiris sells Moscon to Cervelo for 900k — a Buy, not a Swap, salary known)
  const moscon = 'Team A: DK Žalgiris\nRider Out: Gianni Moscon\nRider In: ---\nMoney Out: 0\nMoney In: € 900,000\nTeam B: Cervelo Test Team\nRider Out: ---\nRider In: Gianni Moscon\nMoney Out: € 900,000\nMoney In: 0\nDeal confirmed by DK Žalgiris';
  const mf = model.dealFigures(moscon, 'Cervelo Test Team', (n) => (n === 'Gianni Moscon' ? 900000 : null));
  eq('“---” not parsed as a rider (buyer rider-in only)', mf.ridersIn.join(), 'Gianni Moscon');
  eq('buyer rider-out empty (no phantom “---” rider)', mf.ridersOut.length, 0);
  eq('classified as a transfer, not a swap', mf.neutralType, 'transfer');
  eq('buyer pays 900k fee', mf.transferFee, 900000);
  eq('salary resolves to Moscon wage (not n/a)', mf.salaryDelta, 900000);
}

// ============ REAL archived threads (2024 testbed forums 384/385) ==========
console.log('\n[real archived free-agent / deal threads]');
{
  const readThread = (tid) => parse.parseThread(readFileSync(path.join(SAMP, `old_thread_${tid}.html`), 'utf8'));

  // Free agent: [Free Agent] Jay McCarthy — a long, real bidding war.
  const fa = readThread(67299);
  ok('FA thread title', /\[Free Agent\] Jay McCarthy/.test(fa.title), fa.title);
  ok('FA thread has many posts', fa.posts.length > 15, String(fa.posts.length));
  // every post that states a bid should now extract a number (the "Manager" bug
  // used to null several of them out)
  const bidPosts = fa.posts.filter((p) => /\d[.,]?\d{3}/.test(p.text));
  const extracted = bidPosts.filter((p) => model.parseAmount(p.text) != null);
  ok('all bid-shaped posts extract an amount', extracted.length === bidPosts.length,
     `${extracted.length}/${bidPosts.length}`);
  const a = model.analyzeFreeAgentThread(fa.posts, 60, '', 50000);
  ok('FA has a leader', a.leadingAmount != null, String(a.leadingAmount));
  ok('FA leader is a real escalated amount', a.leadingAmount >= 110000, String(a.leadingAmount));
  ok('FA leader team resolved (first-line fallback)', !!a.leadingTeam, a.leadingTeam);
  // amILeading works when I am that team
  const mine = model.analyzeFreeAgentThread(fa.posts, 60, a.leadingTeam, 50000);
  ok('amILeading true when I am the leading team', mine.amILeading === true);
  // auto-discovery signal: a team that bid but didn't lead still gets myBids>0
  const coyote = model.analyzeFreeAgentThread(fa.posts, 60, 'Manada Coyote', 50000);
  ok('auto-discovery: bidding team detected via myBids', coyote.myBids.length > 0,
     JSON.stringify(coyote.myBids));
  // "signed" wording (won state)
  const won = model.faStatus({ leadingAmount: 100000, leadingTeam: 'X', winUtcMs: 1 }, 2);
  ok('won status says "Signed to"', /^Signed to /.test(won.label), won.label);

  // Stagiare: below-50k bids must still be extracted.
  const st = readThread(67721);
  ok('Stagiare thread detected as junior', model.isJuniorThread(st.title), st.title);
  const stAmts = st.posts.map((p) => model.parseAmount(p.text)).filter((x) => x != null);
  ok('stagiaire sub-50k bids extracted (10k/15k)', stAmts.includes(10000) && stAmts.includes(15000),
     JSON.stringify(stAmts));

  // Deal + Loan deal: fee suggestions extracted from the opening post.
  for (const [tid, fee] of [[67805, 113000], [67785, 290000]]) {
    const d = readThread(tid);
    const sugg = model.euroAmounts(d.posts[0]?.text || '');
    ok(`deal ${tid} fee ${fee} appears in € suggestions`, sugg.includes(fee), JSON.stringify(sugg));
  }
}

// ============ work queue: nothing lost in the gap ==========================
console.log('\n[queue: no-loss carryover]');
{
  const { makeQueue } = await import(path.join(EXT, 'src/queue.js'));
  const q = makeQueue();
  // 102 threads change this window
  for (let i = 0; i < 102; i++) q.push('f:' + i);
  eq('102 enqueued', q.size, 102);
  const first = q.take(78);            // one 30s window reads 78 (13×6)
  eq('read 78 this window', first.length, 78);
  eq('24 remain queued', q.size, 24);
  // next window: 10 NEW threads change — they must go BEHIND the 24 leftovers
  for (let i = 200; i < 210; i++) q.push('f:' + i);
  const second = q.take(78);
  eq('leftovers came first', second[0], 'f:78');       // the 79th original, not a new one
  ok('all 24 leftovers read before any new', second.slice(0, 24).every((k, i) => k === 'f:' + (78 + i)));
  ok('new ones read after leftovers', second.includes('f:200'));
  // dedup: re-detecting a queued thread doesn't duplicate it
  const q2 = makeQueue();
  q2.push('x'); q2.push('x'); q2.push('y');
  eq('dedup keeps size 2', q2.size, 2);
  // unshift brings a user-added thread to the front
  q2.unshift('z');
  eq('unshifted to front', q2.take(1)[0], 'z');
  // persistence round-trip
  const q3 = makeQueue(); q3.load(['a', 'b', 'c']);
  eq('loaded size', q3.size, 3);
  eq('load preserves order', q3.take(3).join(','), 'a,b,c');
}

// ============ roster counts (junior ½, division min/max) ===================
console.log('\n[rosterCounts]');
{
  const ct = model.rosterCounts('CT', { existing: { full: 14, jr: 2 }, pending: { full: 1, jr: 0 } });
  eq('CT min-count = 14 + ½·2 = 15', ct.committed.minCount, 15);
  eq('CT max-count = 14 + 2 = 16', ct.committed.maxCount, 16);
  ok('CT not under min at 15', ct.underMin === false);
  const pt = model.rosterCounts('PT', { existing: { full: 19, jr: 0 } });
  ok('PT under min at 19 (<20)', pt.underMin === true);
  const over = model.rosterCounts('CT', { existing: { full: 21, jr: 0 } });
  ok('CT over max at 21 (>20)', over.overMax === true);
}

console.log('\n[junior 50k ceiling]');
{
  ok('eligible at 20k counts as junior', model.countsAsJunior(true, 20000) === true);
  ok('eligible at exactly 50k is a normal signing', model.countsAsJunior(true, 50000) === false);
  ok('eligible above 50k is a normal signing', model.countsAsJunior(true, 55000) === false);
  ok('not junior-eligible never counts as junior', model.countsAsJunior(false, 20000) === false);
  ok('missing amount treated as 0 (junior)', model.countsAsJunior(true, null) === true);
  // a CT team leading a [Junior] at 55k fills a FULL slot, not a half slot
  const promoted = model.rosterCounts('CT', {
    existing: { full: 14, jr: 0 },
    pending: model.countsAsJunior(true, 55000) ? { full: 0, jr: 1 } : { full: 1, jr: 0 },
  });
  eq('promoted junior adds a full projected slot', promoted.projected.minCount, 15);
}

// ============ admin gate crypto round-trip (WebCrypto ↔ Node build) =========
console.log('\n[admin crypto]');
{
  const subtle = globalThis.crypto.subtle;
  const gate = JSON.parse(readFileSync(path.join(EXT, 'admin-gate.json'), 'utf8'));
  const encBuf = readFileSync(path.join(EXT, 'admin.enc'));
  const secret = JSON.parse(readFileSync(path.join(HERE, '..', 'admin-secret.json'), 'utf8'));
  const hexToBytes = (h) => Uint8Array.from(h.replace(/[^0-9a-f]/gi, '').match(/../g).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  const decrypt = async (codeHex) => {
    const ikm = hexToBytes(codeHex);
    const pk = await subtle.importKey('raw', ikm, 'PBKDF2', false, ['deriveBits']);
    const vbits = await subtle.deriveBits({ name: 'PBKDF2', salt: hexToBytes(gate.pbkdf2.saltHex), iterations: gate.pbkdf2.iterations, hash: gate.pbkdf2.hash }, pk, 256);
    if (bytesToHex(vbits) !== gate.verifyHash) throw new Error('bad code');
    const hk = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(gate.hkdfInfo) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(gate.aesgcm.ivHex) }, key, encBuf);
    return JSON.parse(new TextDecoder().decode(pt));
  };
  const bundle = await decrypt(secret.accessCodeHex);
  ok('correct code decrypts a {code,css} bundle', bundle.code.length > 100 && bundle.css.length > 10);
  const wrong = secret.accessCodeHex.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  let rejected = false; try { await decrypt(wrong); } catch { rejected = true; }
  ok('wrong code is rejected', rejected);
}

// ============ admin aggregation (run the real bundle under jsdom) ===========
console.log('\n[admin aggregation]');
{
  const adminSrc = readFileSync(path.join(HERE, '..', 'admin-src', 'admin.js'), 'utf8');
  document.body.innerHTML = '<div id="root"></div>';
  // eslint-disable-next-line no-eval
  (0, eval)(adminSrc); // defines window.renderAdmin
  const now = Date.UTC(2026, 7, 1, 12, 0, 0);
  const riders = [
    ...Array.from({ length: 14 }, (_, i) => ({ n: 'A' + i, t: 'Alpha', d: 'CT', w: 50000, j: 0, loan: 0 })),
    ...Array.from({ length: 20 }, (_, i) => ({ n: 'B' + i, t: 'Beta', d: 'PT', w: 100000, j: 0, loan: 0 })),
    ...Array.from({ length: 15 }, (_, i) => ({ n: 'G' + i, t: 'Gamma', d: 'CT', w: 50000, j: 0, loan: 0 })),
  ];
  const faFacts = [
    { id: 1, kind: 'fa', riderName: 'Big', junior: false, leaderTeam: 'Beta', leaderAmount: 1600000, winUtcMs: now - 1000, bids: [] },
  ];
  const day = Date.UTC(2026, 7, 1, 10, 0, 0);
  for (let i = 0; i < 9; i++) { // Gamma: 9 riders, 21 bids in one day → over 8/20
    const nb = i < 3 ? 3 : 2;
    faFacts.push({ id: 100 + i, kind: 'fa', riderName: 'Gr' + i, junior: false, leaderTeam: '', leaderAmount: 0, winUtcMs: null, bids: Array.from({ length: nb }, () => ({ t: 'Gamma', u: day })) });
  }
  // teams carry authoritative divisions; "Newbie" has no riders (new CT team)
  const teams = [
    { name: 'Alpha', div: 'CT' }, { name: 'Beta', div: 'PT' },
    { name: 'Gamma', div: 'CT' }, { name: 'Newbie', div: 'CT' },
  ];
  window.renderAdmin({ riders, teams, faFacts, dealFacts: [], nowUtc: now });
  const cards = [...document.querySelectorAll('.acard')];
  const cardOf = (name) => cards.find((c) => c.querySelector('.aname')?.textContent === name);
  eq('rendered 4 team cards', cards.length, 4);
  eq('sorted PT (Beta) first', cards[0].querySelector('.aname').textContent, 'Beta');
  ok('Alpha (14 CT) → yellow (under min)', cardOf('Alpha').classList.contains('yellow'));
  ok('Beta over cap committed → red', cardOf('Beta').classList.contains('red'));
  ok('Gamma bid-limit crossed → red', cardOf('Gamma').classList.contains('red'));
  ok('Gamma shows a bid-limit label', /Bid limit crossed/.test(cardOf('Gamma').textContent));
  // new team with no riders still gets its CT division/cap from the teams list
  ok('Newbie (new CT, 0 riders) shows CT division', /CT/.test(cardOf('Newbie').querySelector('.adiv').textContent));
  ok('Newbie under min (0 < 15) → yellow', cardOf('Newbie').classList.contains('yellow'));

  // admin-entered budget: Alpha spends 14×50k = 700k. A 600k budget is exceeded.
  window.renderAdmin({ riders, teams, faFacts, dealFacts: [], nowUtc: now, budgets: { alpha: 600000 } });
  const cardOf2 = (name) => [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === name);
  ok('Alpha over its 600k budget → "Over budget" label', /Over budget/.test(cardOf2('Alpha').textContent));
  ok('Alpha budget input prefilled with the entered figure', cardOf2('Alpha').querySelector('.abudin').value.includes('600,000'));
  ok('Beta (no budget entered) shows no budget label', !/Over budget/.test(cardOf2('Beta').textContent));
  ok('Beta budget input is empty', cardOf2('Beta').querySelector('.abudin').value === '');
  // division section headers
  const heads = [...document.querySelectorAll('.adivname')].map((h) => h.textContent);
  ok('renders Pro Tour + Continental headers', heads.includes('Pro Tour') && heads.includes('Continental'));
  ok('Pro Tour header precedes Continental', heads.indexOf('Pro Tour') < heads.indexOf('Continental'));

  // existing squad: DB "j" is eligibility — only riders still on a junior wage
  // (< 50k) count as ½; junior-eligible riders resigned at ≥ 50k are full.
  const jrRiders = [
    { n: 'Cheap', t: 'JrTeam', d: 'CT', w: 30000, j: 1, loan: 0 }, // still a junior
    { n: 'Resigned', t: 'JrTeam', d: 'CT', w: 55000, j: 1, loan: 0 }, // eligible but normal now
    { n: 'AtFloor', t: 'JrTeam', d: 'CT', w: 50000, j: 1, loan: 0 }, // exactly 50k → normal
    { n: 'Plain', t: 'JrTeam', d: 'CT', w: 60000, j: 0, loan: 0 }, // not eligible
  ];
  window.renderAdmin({ riders: jrRiders, teams: [{ name: 'JrTeam', div: 'CT' }], faFacts: [], dealFacts: [], nowUtc: now, budgets: {} });
  const jcard = [...document.querySelectorAll('.acard')][0];
  const existingPart = jcard.querySelector('.abreak .apart'); // first part = existing
  ok('existing shows all 4 riders', /4/.test(existingPart.textContent));
  ok('existing counts exactly 1 junior (the <50k eligible one)', existingPart.querySelector('.jrsup')?.textContent === '1j');
}

console.log('\n[parseSackPost]');
{
  // bare-team-name form (like a bid): team is the line, wage comes from the DB (null here)
  const bare = model.parseSackPost('Xero Racing');
  eq('bare form: team = the line', bare.sackTeam, 'Xero Racing');
  eq('bare form: no wage stated', bare.sackWage, null);
  // sentence form: "<rider> (Wage: N) is sacked by <TEAM>"
  const s1 = model.parseSackPost('Sean McKenna (Wage: 100,000) is sacked by Glanbia');
  eq('sentence: team after "sacked by"', s1.sackTeam, 'Glanbia');
  eq('sentence: wage from post (100,000)', s1.sackWage, 100000);
  const s2 = model.parseSackPost('Kevin Feiereisen (Wage: 60,000) is sacked by Evonik - ELKO');
  eq('team with a hyphen preserved', s2.sackTeam, 'Evonik - ELKO');
  eq('wage 60k', s2.sackWage, 60000);
  const s3 = model.parseSackPost('Jhon Stiven Ramirez (Wage: 50,000) is sacked by Spark Team NZ');
  eq('multi-word team', s3.sackTeam, 'Spark Team NZ');
  const s4 = model.parseSackPost('Roy Jans (Wage: 50 000) is sacked by Babymetal');
  eq('space-separated wage (50 000)', s4.sackWage, 50000);
  eq('team = Babymetal', s4.sackTeam, 'Babymetal');
  const s5 = model.parseSackPost('Andrea Guardini (Wage: 70,000) is sacked by Euskadi-Murias');
  eq('team = Euskadi-Murias', s5.sackTeam, 'Euskadi-Murias');
  eq('wage 70k', s5.sackWage, 70000);
}

console.log('\n[transaction CSV export]');
{
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  const done = now - 3600000, future = now + 3600000;
  const faFacts = [
    { id: 501, kind: 'fa', riderName: 'Alice Aro', junior: false, leaderTeam: 'Beta, Inc', leaderAmount: 120000, winUtcMs: done },  // completed signing (team has a comma)
    { id: 502, kind: 'junior', riderName: 'Jun Ior', junior: true, leaderTeam: 'Alpha', leaderAmount: 30000, winUtcMs: done },     // completed junior signing
    { id: 503, kind: 'junior', riderName: 'Big Jr', junior: true, leaderTeam: 'Alpha', leaderAmount: 80000, winUtcMs: done },      // eligible but 80k → not "junior"
    { id: 504, kind: 'fa', riderName: 'Notyet', junior: false, leaderTeam: 'Alpha', leaderAmount: 60000, winUtcMs: future },       // NOT completed → excluded
    { id: 505, kind: 'sack', riderName: 'Sacked Sam', sackTeam: 'Gamma', sackWage: 90000, sackUtcMs: done },                       // Gamma's 1st sack
    { id: 506, kind: 'sack', riderName: 'Sacked Sue', sackTeam: 'Gamma', sackWage: 50000, sackUtcMs: done + 1000 },                // Gamma's 2nd sack → 2× fee
    { id: 507, kind: 'sack', riderName: 'Lone Sack', sackTeam: 'Alpha', sackWage: 40000, sackUtcMs: done + 2000 },                 // Alpha's 1st sack → 1× fee
  ];
  const dealFacts = [
    { id: 601, a: { name: 'Alpha', out: ['Rider One'], in: [], moneyOut: 0, moneyIn: 200000 }, b: { name: 'Beta', out: [], in: ['Rider One'], moneyOut: 200000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: done - 90000000 }, // completed transfer
    { id: 602, a: { name: 'Alpha', out: ['L1'], in: [], moneyOut: 0, moneyIn: 50000 }, b: { name: 'Gamma', out: [], in: ['L1'], moneyOut: 50000, moneyIn: 0 }, isLoan: true, voided: false, opUtc: done - 90000000 },                     // completed loan
    { id: 603, a: { name: 'Alpha', out: ['V'], in: [] }, b: { name: 'Beta', out: [], in: ['V'] }, isLoan: false, voided: true, opUtc: done - 90000000 },                                                                                  // voided → excluded
    { id: 604, a: { name: 'Alpha', out: ['P'], in: [] }, b: { name: 'Beta', out: [], in: ['P'] }, isLoan: false, voided: false, opUtc: future },                                                                                          // not closed → excluded
  ];
  const csv = window.buildTransactionCsvs({ faFacts, dealFacts, nowUtc: now });
  const lines = (s) => s.trim().split('\r\n');
  const sign = lines(csv.signings), sack = lines(csv.sackings), tr = lines(csv.transfers);
  eq('signings header', sign[0], 'rider,team,wage,signed_as_junior,completed_at,thread_url');
  eq('3 completed signings (future one excluded)', sign.length, 4);
  ok('comma in team name is quoted', sign.some((l) => l.includes('"Beta, Inc"')));
  ok('junior signed <50k flagged yes', sign.some((l) => /Jun Ior,Alpha,30000,yes,/.test(l)));
  ok('eligible signed ≥50k flagged no', sign.some((l) => /Big Jr,Alpha,80000,no,/.test(l)));
  ok('signing carries a thread link', sign.some((l) => l.includes('viewthread.php?thread_id=501')));
  ok('in-progress signing (504) excluded', !csv.signings.includes('Notyet'));
  eq('sackings header', sack[0], 'rider,team,wage_freed,sack_fee,sacked_at,thread_url');
  ok('1st sack fee = 1× wage', sack.some((l) => /Sacked Sam,Gamma,90000,90000,.*thread_id=505/.test(l)));
  ok('2nd sack (same team) fee = 2× wage', sack.some((l) => /Sacked Sue,Gamma,50000,100000,/.test(l)));
  ok('other team\'s 1st sack fee = 1× wage', sack.some((l) => /Lone Sack,Alpha,40000,40000,/.test(l)));
  eq('transfers header', tr[0], 'deal_date,type,team_a,team_b,riders_a_to_b,riders_b_to_a,transfer_fee,loan_fee,fee_paid_by,thread_url');
  eq('2 completed deals (voided + open excluded)', tr.length, 3);
  ok('transfer: Beta buys, so Beta pays the fee A←B', tr.some((l) => /Transfer,Alpha,Beta,Rider One,,200000,0,Beta,/.test(l)));
  ok('loan: Gamma pays the loan fee', tr.some((l) => /Loan,Alpha,Gamma,L1,,0,50000,Gamma,/.test(l)));
  ok('voided deal excluded', !csv.transfers.includes('thread_id=603'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
