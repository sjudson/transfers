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
  ok('56 teams loaded', teams.length === 56, String(teams.length));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
