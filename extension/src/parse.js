// HTML parsing of pcmdaily forum pages via DOMParser.
// Markup reference (PHP-Fusion style, captured from live pages):
//  listing row: <a href='viewthread.php?thread_id=N'>TITLE</a> ... author
//               profile-link ... Views ... Replies ... LastPost
//               "DD-MM-YYYY HH:MM<br><span class='small'>by <a>USER</a>"
//  header clock: <td ... class='sub-header'>DD-MM-YYYY HH:MM</td>
//  post: td.forum_thread_user_name > a.profile-link  (author)
//        div.small "Posted on DD-MM-YYYY HH:MM"       (time)
//        td.forum_thread_user_post                    (body)
//        a[id^="post_"]                               (post id)

const DP = new DOMParser();
const STAMP_RE = /(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2})/;

export function parseDoc(html) {
  return DP.parseFromString(html, 'text/html');
}

// The forum's current wall clock, as displayed (for tz self-calibration).
export function parseHeaderClock(doc) {
  const cells = doc.querySelectorAll('.sub-header');
  for (const c of cells) {
    const m = STAMP_RE.exec(c.textContent || '');
    if (m) return m[1];
  }
  // fallback: any element text that looks like a clock near the top
  const m = STAMP_RE.exec(doc.body ? doc.body.textContent.slice(0, 4000) : '');
  return m ? m[1] : null;
}

export function threadIdFromHref(href) {
  const m = /thread_id=(\d+)/.exec(href || '');
  return m ? +m[1] : null;
}

// Parse a listing page into { rows, headerClock } in a single DOM parse.
export function parseListing(html) {
  const doc = parseDoc(html);
  return { rows: listingRows(doc), headerClock: parseHeaderClock(doc) };
}

// Parse a forum listing page into thread rows (kept for direct/testing use).
export function parseForumListing(html) {
  return listingRows(parseDoc(html));
}

function listingRows(doc) {
  const out = [];
  const seen = new Set();
  const links = doc.querySelectorAll('a[href*="viewthread.php?thread_id="]');
  for (const a of links) {
    const id = threadIdFromHref(a.getAttribute('href'));
    if (id == null || seen.has(id)) continue;
    const row = a.closest('tr');
    if (!row) continue;
    seen.add(id);
    const tds = Array.from(row.querySelectorAll('td'));
    const rowText = row.textContent || '';
    // last-post stamp: last stamp found in the row
    let lastStamp = null;
    const stamps = rowText.match(/\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}/g);
    if (stamps && stamps.length) lastStamp = stamps[stamps.length - 1];
    // replies/views: numeric-only cells (align center, nowrap). Take the two
    // small integer cells that sit between the author cell and the last-post cell.
    const nums = [];
    for (const td of tds) {
      const t = (td.textContent || '').trim().replace(/[.,]/g, '');
      if (/^\d+$/.test(t)) nums.push(+t);
    }
    const sticky = !!row.querySelector('img[src*="stickythread"]');
    out.push({
      threadId: id,
      title: (a.textContent || '').trim(),
      lastPostStamp: lastStamp,
      // heuristic: views is usually the larger, replies the smaller trailing count
      replies: nums.length >= 2 ? nums[nums.length - 1] : (nums[0] ?? null),
      views: nums.length >= 2 ? nums[nums.length - 2] : null,
      sticky,
    });
  }
  return out;
}

// Parse a single thread page into ordered posts + pagination info.
export function parseThread(html) {
  const doc = parseDoc(html);
  const title = (doc.querySelector('.forum_thread_title')?.textContent || '').trim();

  const authors = Array.from(doc.querySelectorAll('td.forum_thread_user_name a.profile-link'))
    .map((a) => (a.textContent || '').trim());
  const bodies = Array.from(doc.querySelectorAll('td.forum_thread_user_post'));
  const postAnchors = Array.from(doc.querySelectorAll('a[id^="post_"]'))
    .map((a) => a.id.replace('post_', ''));

  // "Posted on DD-MM-YYYY HH:MM" stamps in document order
  const stamps = [];
  for (const d of doc.querySelectorAll('div.small')) {
    const t = d.textContent || '';
    if (/Posted on/i.test(t)) {
      const m = STAMP_RE.exec(t);
      stamps.push(m ? m[1] : null);
    }
  }

  const n = Math.max(authors.length, bodies.length, stamps.length);
  const posts = [];
  for (let i = 0; i < n; i++) {
    const body = bodies[i];
    posts.push({
      postId: postAnchors[i] || String(i),
      author: authors[i] || '',
      stampStr: stamps[i] || null,
      text: body ? normalizeText(body) : '',
    });
  }

  // pagination: distinct rowstart offsets present in the page
  const rowstarts = new Set([0]);
  for (const a of doc.querySelectorAll('a[href*="rowstart="]')) {
    const m = /rowstart=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) rowstarts.add(+m[1]);
  }
  return {
    title,
    headerClock: parseHeaderClock(doc),
    posts,
    rowstarts: Array.from(rowstarts).sort((a, b) => a - b),
  };
}

// Convert a post body element to readable plain text (keep line breaks).
function normalizeText(el) {
  const clone = el.cloneNode(true);
  // drop quoted blocks so we don't attribute a quoted bid to the poster
  clone.querySelectorAll('.quote, blockquote, .forum_quote').forEach((q) => q.remove());
  clone.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  clone.querySelectorAll('p, div, tr, li').forEach((b) => b.append('\n'));
  const txt = clone.textContent || '';
  return txt.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
