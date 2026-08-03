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

console.log('\n[dedupeAdminFaFacts]');
{
  // Real repro: a rider gets a duplicate FA thread. The dead one holds a lone low bid
  // that looks like an uncontested win; the real thread runs a bidding war another team
  // wins. Only the authoritative (highest-bid) thread must survive per rider.
  const facts = [
    { id: 72952, kind: 'fa', riderName: 'Joel Yates', leaderTeam: 'Aker - Ab InBev', leaderAmount: 50000, winUtcMs: 100 },      // dead duplicate
    { id: 72951, kind: 'fa', riderName: 'Joel Yates', leaderTeam: 'Air New Zealand-Prada', leaderAmount: 95000, winUtcMs: 200 }, // real thread
    { id: 72830, kind: 'fa', riderName: 'Diego Pescador', leaderTeam: 'Aker - Ab InBev', leaderAmount: 50000, winUtcMs: 100 },   // dead duplicate
    { id: 72829, kind: 'fa', riderName: 'Diego Pescador', leaderTeam: 'Peugeot', leaderAmount: 160000, winUtcMs: 300 },          // real thread
    { id: 99, kind: 'sack', sackTeam: 'Aker - Ab InBev', sackWage: 60000, riderName: 'SackedGuy' },
  ];
  const out = model.dedupeAdminFaFacts(facts);
  const byRider = (n) => out.filter((f) => f.riderName === n && f.kind === 'fa');
  eq('one Yates fact kept', byRider('Joel Yates').length, 1);
  eq('kept the real Yates thread (95k), not Aker 50k', byRider('Joel Yates')[0].id, 72951);
  eq('kept the real Pescador thread (Peugeot 160k)', byRider('Diego Pescador')[0].leaderTeam, 'Peugeot');
  ok('Aker no longer wins either free agent', !out.some((f) => f.kind === 'fa' && f.leaderTeam === 'Aker - Ab InBev'));
  ok('sack passes through untouched', out.some((f) => f.kind === 'sack' && f.sackTeam === 'Aker - Ab InBev'));
  // tie on leading amount → most recent win time wins
  const tie = model.dedupeAdminFaFacts([
    { id: 1, kind: 'fa', riderName: 'X', leaderAmount: 50000, winUtcMs: 10 },
    { id: 2, kind: 'fa', riderName: 'X', leaderAmount: 50000, winUtcMs: 20 },
  ]);
  eq('tie broken by recency', tie[0].id, 2);
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
  // budget model: spend = projected salary + fines + reserve (NOT trade fees).
  // Trades adjust the budget: 250k transfer + 30k loan PAID → budget − 280k.
  eq('sacking fines progressive', t.budget.fines, 160000);
  eq('full projected salary against budget', t.budget.salary, 1120000);
  eq('transfer fee completed', t.budget.transferC, 250000);
  eq('transfer fee pending', t.budget.transferP, 0);
  eq('loan fee pending', t.budget.loanP, 30000);
  eq('spend = salary + fines + reserve (no fees)', t.budget.spend, 1380000); // 1,120k + 160k + 100k
  eq('net trade flow = −280k (paid out)', t.budget.netTradeFlow, -280000);
  eq('adjusted budget = 600k − 280k', t.budget.adjustedBudget, 320000);
  ok('over budget (1.38m > 320k)', t.budget.over === true);
  // a net SELLER raises the budget: receive 300k on a transfer → budget + 300k
  const seller = model.computeTotals({ baseSalary: '1000000', budget: '1000000',
    deals: [{ transferFee: -300000, loanFee: 0, salaryAdd: 0, isLoan: false, completed: true }] });
  eq('net received raises budget (+300k)', seller.budget.netTradeFlow, 300000);
  eq('seller adjusted budget = 1.3m', seller.budget.adjustedBudget, 1300000);
  eq('seller spend = salary only', seller.budget.spend, 1000000);
  ok('seller not over budget', seller.budget.over === false);
  const over = model.computeTotals({ faItems: [{ salary: 100000, amILeading: true, completed: false }], baseSalary: '1200000', cap: 1200000 });
  eq('salary over cap flagged', over.salary.over, true);
  // transfer tax: computed on GROSS cash received (earned), progressive over €500k/€1M.
  eq('tax: 0 under €500k', model.transferTax(400000), 0);
  eq('tax: 10% band (€910k → €41k)', model.transferTax(910000), 41000);
  eq('tax: 20% band (€1.2m → €90k)', model.transferTax(1200000), 90000);
  // a swap: gross €1.2m in AND €1.2m out (net 0) → €90k tax, excluded from base spend
  // but counted in the over-budget check (tips 1.0m spend over a 1.05m budget).
  const swap = model.computeTotals({ baseSalary: '1000000', budget: '1050000',
    deals: [{ transferFee: 0, loanFee: 0, earned: 1200000, salaryAdd: 0, isLoan: false, completed: true }] });
  eq('swap gross income tracked', swap.budget.income, 1200000);
  eq('tax computed on gross income = €90k', swap.budget.tax, 90000);
  eq('base spend excludes tax', swap.budget.spend, 1000000);
  ok('tax tips spend over budget', swap.budget.over === true);
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
  // the 24h anchors to the WINNING (over-the-top) post, so its stamp is available
  const stamped = [
    { text: war[0].text, stampStr: '28-07-2026 20:49' }, // original proposal
    { text: war[2].text, stampStr: '28-07-2026 23:10' }, // over-the-top confirmation
  ];
  eq('winning post is the over-the-top one', model.winningDealPost(stamped).stampStr, '28-07-2026 23:10');
  // on a tie (re-post of the same top figure) the LATER post wins
  const tie = [
    { text: war[2].text, stampStr: '28-07-2026 23:10' },
    { text: war[2].text, stampStr: '28-07-2026 23:40' },
  ];
  eq('tie → latest post', model.winningDealPost(tie).stampStr, '28-07-2026 23:40');
  ok('no deal posts → null', model.winningDealPost([{ text: 'just a comment' }]) === null);
  // an "overbid" only counts within 24h of the standing offer: a higher post 2 days
  // later comes AFTER the first deal completed, so the ORIGINAL offer stands.
  const lateOverbid = [
    { text: war[0].text, stampStr: '28-07-2026 20:49' }, // 70k — completes 24h later
    { text: war[2].text, stampStr: '30-07-2026 21:00' }, // 200k, but >24h later → too late
  ];
  eq('late overbid (>24h) ignored → original 70k post stands', model.winningDealPost(lateOverbid).stampStr, '28-07-2026 20:49');
  // a higher post WITHIN 24h is a valid overbid and wins
  const inTimeOverbid = [
    { text: war[0].text, stampStr: '28-07-2026 20:49' }, // 70k
    { text: war[2].text, stampStr: '29-07-2026 10:00' }, // 200k, within 24h → wins
  ];
  eq('in-time overbid (<24h) wins', model.winningDealPost(inTimeOverbid).stampStr, '29-07-2026 10:00');
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

  // newestPostStamp: the latest parsed post's stamp (drives honest re-fetching)
  const seq = [{ stampStr: '24-07-2026 17:04' }, { stampStr: '24-07-2026 17:13' }, { stampStr: '24-07-2026 17:21' }];
  eq('newest = last post stamp', parse.newestPostStamp(seq), '24-07-2026 17:21');
  eq('skips trailing null stamp', parse.newestPostStamp([...seq, { stampStr: null }]), '24-07-2026 17:21');
  eq('null when no stamps', parse.newestPostStamp([{ stampStr: null }]), null);
  eq('null on empty', parse.newestPostStamp([]), null);
}

// ============ locked-thread detection (invalid threads → discard) ===========
console.log('\n[locked-thread detection]');
{
  // listing: a locked row shows a padlock icon. Real pcmdaily markup (thread
  // 32087): src=".../forum/folderlock.gif" alt="Locked Thread"; normal threads
  // use folder.gif alt="No New Posts".
  const lockList = `<!doctype html><html><body><table>
    <tr><td><a href='viewthread.php?thread_id=555'>Locked</a></td>
        <td><img src='../themes/Bluescape/forum/folderlock.gif' alt='Locked Thread'/></td>
        <td>01-01-2026 10:00<br><span class='small'>by <a href='#'>u</a></span></td></tr>
    <tr><td><a href='viewthread.php?thread_id=556'>Open</a></td>
        <td><img src='../themes/Bluescape/forum/folder.gif' alt='No New Posts'/></td>
        <td>01-01-2026 11:00<br><span class='small'>by <a href='#'>u</a></span></td></tr>
    <tr><td><a href='viewthread.php?thread_id=557'>AltOnly</a></td>
        <td><img src='../themes/Other/forum/f2.gif' alt='Locked Thread'/></td>
        <td>01-01-2026 12:00<br><span class='small'>by <a href='#'>u</a></span></td></tr>
  </table></body></html>`;
  const lrows = parse.parseForumListing(lockList);
  ok('locked listing row flagged (folderlock.gif)', lrows.find((r) => r.threadId === 555)?.locked === true);
  ok('normal listing row not flagged', lrows.find((r) => r.threadId === 556)?.locked === false);
  ok('locked via alt="Locked Thread" only', lrows.find((r) => r.threadId === 557)?.locked === true);

  const thread = (chrome, postBody) => `<!doctype html><html><body>
    <div class='forum_thread_title'>[Free Agent] X</div>
    <table>
      <tr><td class='forum_thread_user_name'><a class='profile-link' href='#'>u</a></td>
          <td class='forum_thread_post_date'><a id='post_1'></a><div class='small'>Posted on 01-01-2026 10:00</div></td></tr>
      <tr><td>info</td><td class='forum_thread_user_post'>${postBody}</td></tr>
    </table>${chrome}</body></html>`;
  ok('locked notice in page chrome → locked',
     parse.parseThread(thread('<div>This thread is locked. You cannot post replies.</div>', 'Team\n60000')).locked === true);
  ok('"locked" only inside a post → NOT locked',
     parse.parseThread(thread('', 'Team\n60000\nI am locked in — this thread is locked to me!')).locked === false);
  ok('normal thread → not locked',
     parse.parseThread(thread('<div>Reply</div>', 'Team\n60000')).locked === false);
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

  // Regression: an OLD pinned sticky on page 1 must not stop the crawl early —
  // otherwise a catch-up after time away misses changes that spilled to page 2.
  const stickyRow = `<tr><td class='tbl1'><img src='../images/stickythread.gif'/><a href='viewthread.php?thread_id=9999'>Rules</a></td>
    <td class='tbl2'><a href='../profile.php?lookup=1' class='profile-link'>u</a></td>
    <td class='tbl1'>9</td><td class='tbl2'>9</td>
    <td class='tbl1'>01-01-2020 08:00<br /><span class='small'>by <a href='#'>u</a></span></td></tr>`;
  const rowHtml = (i) => `<tr><td class='tbl1'><a href='viewthread.php?thread_id=${1000 + i}'>Thread ${i}</a></td>
    <td class='tbl2'><a href='../profile.php?lookup=1' class='profile-link'>u</a></td>
    <td class='tbl1'>50</td><td class='tbl2'>3</td>
    <td class='tbl1'>${stampOf(i)}<br /><span class='small'>by <a href='#'>u</a></span></td></tr>`;
  const wrap = (inner) => `<!doctype html><html><body><td class='sub-header'>24-07-2026 12:05</td><table>${inner}</table></body></html>`;
  const stReads = [], stSeen = [];
  const stFetch = async (rowstart, page) => {
    stReads.push(page);
    let rows = '';
    if (page === 0) { rows = stickyRow; for (let i = 0; i <= 18; i++) rows += rowHtml(i); } // sticky + t0..t18 = 20 rows
    else { const start = 19 + (page - 1) * STEP; for (let i = start; i < Math.min(start + STEP, TOTAL); i++) rows += rowHtml(i); }
    return { body: wrap(rows), fetchedAtUtcMs: Date.parse('2026-07-24T11:05:00Z') };
  };
  let stOff = 60;
  await crawl.crawlListing({
    fetchPageFn: stFetch, prevHW: utcOf(25), pageStep: STEP,
    getOffset: () => stOff, setOffset: (o) => { stOff = o; }, onRow: (r) => stSeen.push(r.threadId),
  });
  eq('old sticky on page 1 does not stop the crawl early', stReads.length, 2);
  ok('catches changed threads that spilled past the sticky onto page 2',
     Array.from({ length: 25 }, (_, i) => 1000 + i).every((id) => stSeen.includes(id)));

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

  // Mis-filled thread: BOTH team blocks typed from the same perspective (both list
  // Rider Out: Scott Davies / Rider In: Michael Christodoulos). B must mirror A, so
  // RoR really gets Scott + gives Michael — salary delta flips to −25k, not +25k.
  const swap = 'Team A: ELCO - ABEA\nRider Out: Scott Davies\nRider In: Michael Christodoulos\nMoney Out: 0\nMoney In: 100,000\nTeam B: Riders of Rohan\nRider Out: Scott Davies\nRider In: Michael Christodoulos\nMoney Out: 100,000\nMoney In: 0\nDeal confirmed by ELCO - ABEA';
  const pd = model.parseDeal(swap);
  eq('team B rider-in corrected to Scott Davies', pd.teamB.in.join(), 'Scott Davies');
  eq('team B rider-out corrected to Michael Christodoulos', pd.teamB.out.join(), 'Michael Christodoulos');
  const wage = (n) => (n === 'Scott Davies' ? 75000 : n === 'Michael Christodoulos' ? 100000 : null);
  eq('RoR salary delta = −25k (was +25k)', model.dealFigures(swap, 'Riders of Rohan', wage).salaryDelta, -25000);
  eq('ELCO salary delta = +25k', model.dealFigures(swap, 'ELCO - ABEA', wage).salaryDelta, 25000);
  // a well-formed (already mirrored) deal is left unchanged
  const wf = model.parseDeal('Team A: X\nRider Out: A1\nRider In: B1\nTeam B: Y\nRider Out: B1\nRider In: A1');
  eq('well-formed B.in unchanged', wf.teamB.in.join(), 'A1');
  eq('well-formed B.out unchanged', wf.teamB.out.join(), 'B1');
  // malformed flag: set only when both sides listed riders that didn't mirror
  ok('malformed flag set on the mis-filled swap', pd.malformed === true);
  ok('well-formed deal not flagged', wf.malformed === false);
  ok('flag propagates through dealFigures', model.dealFigures(swap, 'Riders of Rohan', wage).malformed === true);
  // one-sided (B blank) is reconciled silently, not flagged as bad
  const oneSided = model.parseDeal('Team A: X\nRider Out: A1\nRider In: ---\nTeam B: Y\nRider Out: ---\nRider In: ---');
  ok('one-sided deal not flagged malformed', oneSided.malformed === false);

  // FA-signed rider traded: dealFigures honours an FA-aware wageOf (DB wage 0 →
  // fall back to the FA bid), so the buyer's salary reflects the real wage.
  const buy = 'Team A: X\nRider Out: Newbie\nMoney Out: 0\nMoney In: 100,000\nTeam B: Y\nRider In: Newbie\nMoney Out: 100,000\nMoney In: 0';
  const wageOfFa = (n) => (n === 'Newbie' ? 300000 : null); // FA-aware wage
  eq('buyer salary uses FA-aware wage (+300k)', model.dealFigures(buy, 'Y', wageOfFa).salaryDelta, 300000);
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
  ok('Gamma bid-limit alert has a dismiss ✕', !!cardOf('Gamma').querySelector('.alabel-x'));
  // dismissing the crossing drops Gamma's red and hides the alert
  window.renderAdmin({ riders, teams, faFacts, dealFacts: [], nowUtc: now, dismissedBids: { 'gamma|2026-08-01': true } });
  const gDis = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Gamma');
  ok('dismissed bid-limit removes Gamma red', !gDis.classList.contains('red'));
  ok('dismissed bid-limit hides the alert', !/Bid limit crossed/.test(gDis.textContent));
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

  // superseded deal's fee must NOT count toward the admin budget spend (repro of
  // the "outgoing 760 vs 15" report: a 750k superseded swap was still counted)
  // deal 2 reopens 6h after deal 1 — WITHIN the 24h window, so it's a renegotiation
  // that supersedes deal 1 (not a legitimate re-trade after completion).
  const t1 = Date.UTC(2026, 6, 26, 12, 0, 0), t2 = Date.UTC(2026, 6, 26, 18, 0, 0);
  const dealFacts = [
    { id: 1, a: { name: 'Bolt', out: ['Laurence Pithie'], in: ['Logan Owen'], moneyOut: 0, moneyIn: 750000 },
      b: { name: 'Philips', out: ['Logan Owen'], in: ['Laurence Pithie'], moneyOut: 750000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: t1 },
    { id: 2, a: { name: 'Bolt', out: ['Laurence Pithie'], in: ['David Gaudu'], moneyOut: 0, moneyIn: 1500000 },
      b: { name: 'Grieg', out: ['David Gaudu'], in: ['Laurence Pithie'], moneyOut: 1500000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: t2 },
  ];
  window.renderAdmin({ riders: [], teams: [{ name: 'Philips', div: 'PCT' }], faFacts: [], dealFacts, nowUtc: now, budgets: { philips: 100000 } });
  const pcard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Philips');
  ok('superseded 750k swap excluded from admin spend (not over 100k budget)', !/Over budget/.test(pcard.textContent));

  // budget REMAINING = original budget + fees earned − wages − fees spent − tax −
  // renewal fines. Aker: budget 3.5m, wages 3.0m, sold a rider for 200k received.
  const akr = [{ n: 'A1', t: 'Aker', d: 'PT', w: 3000000, j: 0, loan: 0 }]; // 3.0m wages
  const akd = [{ id: 5, a: { name: 'Aker', out: ['SoldGuy'], in: [], moneyOut: 0, moneyIn: 200000 },
    b: { name: 'Buyer', out: [], in: ['SoldGuy'], moneyOut: 200000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: now - 3 * 24 * 3600 * 1000 }];
  window.renderAdmin({ riders: akr, teams: [{ name: 'Aker', div: 'PT' }], faFacts: [], dealFacts: akd, nowUtc: now, budgets: { aker: 3500000 } });
  const acard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Aker');
  // 3,500,000 + 200,000 received − 3,000,000 wages = 700,000 remaining
  ok('remaining = €700,000 (budget + received − wages)', /Projected remaining/.test(acard.textContent) && /€700,000/.test(acard.textContent));
  ok('transfer-net line under remaining (+€200,000, incl. transfer/loan net)', /\(incl\. transfer\/loan net\)/.test(acard.textContent) && /\+€200,000/.test(acard.textContent));
  ok('positive remaining is not over budget', !/Over budget/.test(acard.textContent) && !acard.classList.contains('red'));
  // renewal fines is a further input that reduces remaining (tax is 0 here — income < €500k)
  window.renderAdmin({ riders: akr, teams: [{ name: 'Aker', div: 'PT' }], faFacts: [], dealFacts: akd, nowUtc: now,
    budgets: { aker: 3500000 }, renewals: { aker: 150000 } });
  const acard2 = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Aker');
  ok('renewal fines reduce remaining to €550,000', /€550,000/.test(acard2.textContent)); // 700k − 150k
  eq('two numeric inputs render (budget, renewal)', acard2.querySelectorAll('.abudin').length, 2);
  // transfer tax is COMPUTED from income received (progressive: 0/10/20% over €500k/€1M).
  // A team selling for €1,200,000 owes 10%·500k + 20%·200k = €90,000 tax.
  const txr = [{ n: 'T1', t: 'Taxo', d: 'PT', w: 1000000, j: 0, loan: 0 }];
  const txd = [{ id: 6, a: { name: 'Taxo', out: ['Star'], in: [], moneyOut: 0, moneyIn: 1200000 },
    b: { name: 'Buyer', out: [], in: ['Star'], moneyOut: 1200000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: now - 3 * 24 * 3600 * 1000 }];
  window.renderAdmin({ riders: txr, teams: [{ name: 'Taxo', div: 'PT' }], faFacts: [], dealFacts: txd, nowUtc: now, budgets: { taxo: 3000000 } });
  const tcard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Taxo');
  ok('transfer tax computed (€1.2M income → €90,000 tax, incl. tax line)', /\(incl\. tax\)/.test(tcard.textContent) && /−€90,000/.test(tcard.textContent));
  // remaining = 3,000,000 + 1,200,000 − 1,000,000 − 90,000 = 3,110,000
  ok('tax reduces projected remaining to €3,110,000', /€3,110,000/.test(tcard.textContent));
  // negative remaining → over budget (red)
  window.renderAdmin({ riders: akr, teams: [{ name: 'Aker', div: 'PT' }], faFacts: [], dealFacts: [], nowUtc: now, budgets: { aker: 2500000 } });
  const acard3 = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Aker');
  ok('negative remaining → "Over budget by €500,000", card red', /Over budget by €500,000/.test(acard3.textContent) && acard3.classList.contains('red'));
  // EVERY card shows the full budget picture — even with no budget entered and no trades,
  // all three rows render (remaining as "—", transfer net + tax as €0).
  window.renderAdmin({ riders: akr, teams: [{ name: 'Aker', div: 'PT' }], faFacts: [], dealFacts: [], nowUtc: now });
  const acard4 = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Aker');
  ok('bare card still shows Projected remaining / transfer net / tax rows',
    /Projected remaining/.test(acard4.textContent) && /\(incl\. transfer\/loan net\)/.test(acard4.textContent) && /\(incl\. tax\)/.test(acard4.textContent));
  // loan fees are real cash and must count in the admin budget net (repro of the
  // "€15k off" Aker report: net loan fees were dropped from Projected remaining).
  const lnd = [{ id: 7, a: { name: 'Loano', out: ['Loanee'], in: [], moneyOut: 0, moneyIn: 100000, wagePaid: 0 },
    b: { name: 'Borrower', out: [], in: ['Loanee'], moneyOut: 100000, moneyIn: 0, wagePaid: 0 }, isLoan: true, voided: false, opUtc: now - 3 * 24 * 3600 * 1000 }];
  window.renderAdmin({ riders: [], teams: [{ name: 'Loano', div: 'PT' }], faFacts: [], dealFacts: lnd, nowUtc: now, budgets: { loano: 1000000 } });
  const lcard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Loano');
  ok('loan fee counts in net (incl. transfer/loan net +€100,000)', /\(incl\. transfer\/loan net\)/.test(lcard.textContent) && /\+€100,000/.test(lcard.textContent));
  ok('loan fee raises projected remaining to €1,100,000', /€1,100,000/.test(lcard.textContent));

  // salary audit must reconcile to the card's committed salary, and a superseded
  // deal must be shown-but-excluded (the tool for debugging the "170k off" report)
  // done2 reopens 6h after done3 — within the 24h window, so deal 62 supersedes 61.
  const done3 = now - 3 * 24 * 3600 * 1000, done2 = done3 + 6 * 3600 * 1000;
  const audRiders = [
    { n: 'Base1', t: 'Audit', d: 'PT', w: 1000000, j: 0, loan: 0 },
    { n: 'KeepGuy', t: 'Seller', d: 'PT', w: 200000, j: 0, loan: 0 },
    { n: 'DupGuy', t: 'Seller2', d: 'PT', w: 500000, j: 0, loan: 0 },
  ];
  const audFa = [
    { id: 50, kind: 'fa', riderName: 'FreeAgent1', leaderTeam: 'Audit', leaderAmount: 100000, winUtcMs: done3 },
    { id: 51, kind: 'sack', sackTeam: 'Audit', sackWage: 50000, riderName: 'SackedOne', sackUtcMs: done3 },
  ];
  const audDeals = [
    { id: 60, a: { name: 'Seller', out: ['KeepGuy'], in: [], moneyOut: 0, moneyIn: 200000 }, b: { name: 'Audit', out: [], in: ['KeepGuy'], moneyOut: 200000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: done3 },
    { id: 61, a: { name: 'Seller2', out: ['DupGuy'], in: [], moneyOut: 0, moneyIn: 500000 }, b: { name: 'Audit', out: [], in: ['DupGuy'], moneyOut: 500000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: done3 },
    { id: 62, a: { name: 'Seller2', out: ['DupGuy'], in: [], moneyOut: 0, moneyIn: 500000 }, b: { name: 'Other', out: [], in: ['DupGuy'], moneyOut: 500000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: done2 },
  ];
  const audData = { riders: audRiders, teams: [{ name: 'Audit', div: 'PT' }], faFacts: audFa, dealFacts: audDeals, nowUtc: now, budgets: {} };
  window.renderAdmin(audData);
  const audCard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Audit');
  // expected committed = 1,000,000 base + 100,000 FA − 50,000 sack + 200,000 KeepGuy = 1,250,000 (DupGuy 500k superseded)
  ok('card committed salary = €1,250,000', /€1,250,000 \//.test(audCard.textContent));
  const audit = window.buildSalaryAudit(audData);
  const auditLine = audit.split('\r\n').find((l) => l.startsWith('Audit,=== COMMITTED SALARY ==='));
  eq('audit reconciles to committed salary', auditLine.split(',').pop(), '1250000');
  ok('superseded deal 61 shown-but-excluded in audit', /transfer IN \[SUPERSEDED\],61,DupGuy/.test(audit));
  ok('counted deal 60 present with running total', /transfer IN \[completed\],60,KeepGuy,200000,1250000/.test(audit));

  // FA-signed-then-traded: the rider is in the DB as a free agent (wage 0); their
  // wage must fall back to the FA-winning amount when traded (the €0-salary
  // undercount that likely explains "salary 170k low with +10 confirmed").
  const ftR = [{ n: 'Newbie', t: '', fa: 1, w: 0, j: 0, loan: 0 }];
  const ftFa = [{ id: 70, kind: 'fa', riderName: 'Newbie', leaderTeam: 'X', leaderAmount: 300000, winUtcMs: done3 }];
  const ftD = [{ id: 71, a: { name: 'X', out: ['Newbie'], in: [], moneyOut: 0, moneyIn: 100000 }, b: { name: 'Y', out: [], in: ['Newbie'], moneyOut: 100000, moneyIn: 0 }, isLoan: false, voided: false, opUtc: done2 }];
  window.renderAdmin({ riders: ftR, teams: [{ name: 'X', div: 'PT' }, { name: 'Y', div: 'PT' }], faFacts: ftFa, dealFacts: ftD, nowUtc: now, budgets: {} });
  const yCard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'Y');
  const xCard = [...document.querySelectorAll('.acard')].find((c) => c.querySelector('.aname')?.textContent === 'X');
  ok('traded FA rider carries their FA wage to the new team (Y = €300,000)', /€300,000 \//.test(yCard.textContent));
  ok('selling team nets to €0 (FA won − traded out)', /€0 \//.test(xCard.textContent));
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

console.log('\n[supersededDealIds]');
{
  // Pithie chain: an early swap is superseded by later deals moving the same rider
  const deals = [
    { threadId: 1, riders: ['Laurence Pithie', 'Logan Owen'], opUtc: 100, voided: false }, // early swap
    { threadId: 2, riders: ['Laurence Pithie', 'Mathieu Van der Poel', 'David Gaudu'], opUtc: 200, voided: false },
    { threadId: 3, riders: ['Logan Owen'], opUtc: 300, voided: false }, // Logan Owen sold later (valid)
    { threadId: 4, riders: ['Laurence Pithie', 'David Gaudu'], opUtc: 400, voided: false }, // latest Pithie deal
  ];
  const sup = model.supersededDealIds(deals);
  ok('early swap (1) superseded', sup.has(1));
  ok('mid Pithie deal (2) superseded by (4)', sup.has(2));
  ok('final Pithie deal (4) NOT superseded', !sup.has(4));
  ok('latest Logan Owen deal (3) NOT superseded', !sup.has(3));
  // a voided later deal must NOT supersede an earlier one
  const withVoid = [
    { threadId: 10, riders: ['Rider X'], opUtc: 100, voided: false },
    { threadId: 11, riders: ['Rider X'], opUtc: 200, voided: true },
  ];
  ok('voided later deal does not supersede', !model.supersededDealIds(withVoid).has(10));
  // simultaneous (equal opUtc) reposts don't cancel each other
  const tie = [
    { threadId: 20, riders: ['Rider Y'], opUtc: 500, voided: false },
    { threadId: 21, riders: ['Rider Y'], opUtc: 500, voided: false },
  ];
  const tieSet = model.supersededDealIds(tie);
  ok('equal-time deals: neither superseded', !tieSet.has(20) && !tieSet.has(21));
  // unrelated riders are independent
  const indep = [
    { threadId: 30, riders: ['A'], opUtc: 100, voided: false },
    { threadId: 31, riders: ['B'], opUtc: 200, voided: false },
  ];
  ok('unrelated riders: neither superseded', model.supersededDealIds(indep).size === 0);
  // a rider CAN be traded twice: a later deal that opens AFTER the first completed
  // (>24h) is a legitimate re-trade, not a supersession — both stand.
  const DAY = 24 * 3600 * 1000, base = 1_000_000_000;
  const retrade = [
    { threadId: 40, riders: ['Wout van Aert'], opUtc: base, voided: false },
    { threadId: 41, riders: ['Wout van Aert'], opUtc: base + 3 * DAY, voided: false }, // 3 days later
  ];
  const rs = model.supersededDealIds(retrade);
  ok('re-trade >24h later: first NOT superseded', !rs.has(40));
  ok('re-trade >24h later: second NOT superseded', !rs.has(41));
  // but a repost WITHIN 24h is a renegotiation that supersedes the first
  const quickRe = [
    { threadId: 42, riders: ['Wout van Aert'], opUtc: base, voided: false },
    { threadId: 43, riders: ['Wout van Aert'], opUtc: base + 6 * 3600 * 1000, voided: false }, // 6h later
  ];
  const qs = model.supersededDealIds(quickRe);
  ok('renegotiation within 24h: first superseded', qs.has(42));
  ok('renegotiation within 24h: second stands', !qs.has(43));
}

console.log('\n[applyManualOrder]');
{
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
  const keyStr = (r) => r.map((x) => x.key).join('');
  eq('empty order → natural order', keyStr(model.applyManualOrder(items, [])), 'abcd');
  eq('full order applied', keyStr(model.applyManualOrder(items, ['c', 'a', 'd', 'b'])), 'cadb');
  // new cards (not in the saved order) keep natural order, appended at the end
  eq('unknown keys appended in natural order', keyStr(model.applyManualOrder(items, ['d', 'b'])), 'dbac');
  // stale keys in the order that aren't present are simply ignored
  eq('stale keys ignored', keyStr(model.applyManualOrder(items, ['z', 'c', 'y', 'a'])), 'cabd');
  ok('returns a copy (does not mutate input)', model.applyManualOrder(items, ['b', 'a']) !== items && keyStr(items) === 'abcd');
}

console.log('\n[faSection / dealSection]');
{
  eq('FA won → you', model.faSection({ key: 'won' }), 'you');
  eq('FA gone → others', model.faSection({ key: 'gone' }), 'others');
  eq('FA open → active', model.faSection({ key: 'open' }), 'active');
  eq('FA closing → active', model.faSection({ key: 'closing' }), 'active');
  eq('FA nobids → active', model.faSection({ key: 'nobids' }), 'active');
  eq('FA no status → active', model.faSection(null), 'active');

  eq('deal completed + mine → you', model.dealSection({ completed: true, voided: false, involvesMe: true }), 'you');
  eq('deal completed + third-party → others', model.dealSection({ completed: true, voided: false, involvesMe: false }), 'others');
  eq('deal pending → active', model.dealSection({ completed: false, involvesMe: true }), 'active');
  eq('deal voided (even if completed) → active', model.dealSection({ completed: true, voided: true, involvesMe: true }), 'active');
  eq('superseded (mine) → completed to you', model.dealSection({ superseded: true, involvesMe: true }), 'you');
  eq('superseded (others) → completed to others', model.dealSection({ superseded: true, involvesMe: false }), 'others');
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
