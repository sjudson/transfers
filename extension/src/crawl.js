// Incremental listing crawl. A forum listing is sorted by last-post time
// descending, so to find everything that changed since we last looked we page
// down from page 1 and stop as soon as a page is entirely older than our
// high-water mark (prevHW). Steady state that's one page; after the tab was
// closed a while it pages deeper to catch up, then settles.
//
// Pure/injectable so it can be unit-tested without network or DOM globals:
//  fetchPageFn(rowstart, pageIndex) -> { body, loginRequired?, fetchedAtUtcMs }
//  onRow(row)      called for every listing row (caller updates its maps)
//  getOffset/setOffset  the forum display offset (auto-calibrated from the clock)
import { parseListing } from './parse.js';
import { computeDisplayOffsetMin, parseForumStamp, stampToUtcMs } from './tz.js';

export async function crawlListing({
  fetchPageFn, prevHW = 0, pageStep = 20, maxPages,
  getOffset, setOffset, onRow,
}) {
  const firstRun = prevHW === 0;
  const cap = maxPages ?? (firstRun ? 4 : 15);
  let newest = prevHW;
  let pagesRead = 0;

  for (let page = 0; page < cap; page++) {
    const res = await fetchPageFn(page * pageStep, page);
    if (res.loginRequired) return { newest, loginRequired: true, pagesRead };
    const { rows, headerClock } = parseListing(res.body);
    if (headerClock) {
      const o = computeDisplayOffsetMin(headerClock, res.fetchedAtUtcMs);
      if (o != null) setOffset(o);
    }
    pagesRead++;
    if (!rows.length) break;

    let pageOldest = Infinity;
    let nonSticky = 0;
    for (const r of rows) {
      onRow(r);
      // Stickies are PINNED to the top regardless of activity, so their (often
      // old) last-post time must not drive the crawl-depth decision — otherwise
      // a sticky on page 1 makes pageOldest < prevHW and we stop after one page,
      // missing changes on page 2+ (e.g. catching up after time away).
      if (r.sticky) continue;
      nonSticky++;
      const p = parseForumStamp(r.lastPostStamp);
      if (p) {
        const utc = stampToUtcMs(p, getOffset());
        if (utc < pageOldest) pageOldest = utc;
        if (utc > newest) newest = utc;
      }
    }
    if (rows.length < pageStep) break; // last page reached (avoids an empty fetch)
    // Everything below a page whose oldest non-sticky thread predates prevHW is
    // unchanged. (Guard against an all-sticky page leaving pageOldest at Infinity.)
    if (!firstRun && nonSticky > 0 && pageOldest < prevHW) break;
  }
  return { newest, loginRequired: false, pagesRead };
}
