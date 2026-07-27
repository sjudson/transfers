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
    // A locked thread's row shows a padlock folder icon. On pcmdaily this is
    // `…/forum/folderlock.gif` with alt="Locked Thread" (normal threads use
    // folder.gif alt="No New Posts"). Match either the "lock" filename or the
    // alt text so it survives a theme swap.
    const locked = !!row.querySelector('img[src*="lock" i], img[alt*="lock" i]');
    out.push({
      threadId: id,
      title: (a.textContent || '').trim(),
      lastPostStamp: lastStamp,
      // heuristic: views is usually the larger, replies the smaller trailing count
      replies: nums.length >= 2 ? nums[nums.length - 1] : (nums[0] ?? null),
      views: nums.length >= 2 ? nums[nums.length - 2] : null,
      sticky, locked,
    });
  }
  return out;
}

// Parse a single thread page into ordered posts + pagination info.
export function parseThread(html) {
  const doc = parseDoc(html);
  const title = (doc.querySelector('.forum_thread_title')?.textContent || '').trim();

  // Extract each post from its OWN DOM structure so author / date / body can't
  // drift out of alignment. Layout per post is two rows:
  //   row 1: td.forum_thread_user_name (author) + td.forum_thread_post_date
  //          (contains the #N post_ anchor and a "Posted on DD-MM-YYYY HH:MM" div)
  //   row 2: td.forum_thread_user_info + td.forum_thread_user_post (the body)
  const posts = [];
  for (const body of doc.querySelectorAll('td.forum_thread_user_post')) {
    // walk back to the nearest header row (the one with the author cell)
    let hdr = body.closest('tr')?.previousElementSibling || null;
    while (hdr && !hdr.querySelector('.forum_thread_user_name')) hdr = hdr.previousElementSibling;
    const author = hdr?.querySelector('a.profile-link')?.textContent.trim() || '';
    const postId = (hdr?.querySelector('a[id^="post_"]')?.id || '').replace('post_', '') || String(posts.length);
    let stampStr = null;
    for (const d of (hdr ? hdr.querySelectorAll('.small') : [])) {
      if (/Posted on/i.test(d.textContent || '')) { const m = STAMP_RE.exec(d.textContent); if (m) { stampStr = m[1]; break; } }
    }
    posts.push({ postId, author, stampStr, text: normalizeText(body) });
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
    locked: threadLocked(doc),
    rowstarts: Array.from(rowstarts).sort((a, b) => a - b),
  };
}

// Detect a locked thread from its page. PHP-Fusion shows a "this thread is
// locked" notice and/or a padlock in the page chrome — NOT inside a post — so we
// strip the post bodies first (a post that merely says "locked" must not trigger
// it). Used to auto-discard invalid/locked threads even when auto-discovered.
function threadLocked(doc) {
  const chrome = doc.cloneNode(true);
  chrome.querySelectorAll('td.forum_thread_user_post').forEach((n) => n.remove());
  const text = (chrome.body ? chrome.body.textContent : '') || '';
  if (/\b(thread|topic)\s+(is|has been)\s+locked\b/i.test(text)) return true;
  if (/\bcannot\s+(post|make)\s+(replies|further)/i.test(text) && /\block/i.test(text)) return true;
  return !!chrome.querySelector("img[src*='lockthread' i], img[src*='thread_lock' i], img[src*='folder_lock' i]");
}

// The stamp of the newest post we actually parsed (posts are chronological, so
// scan from the end for the last non-empty stamp). The caller compares this to the
// listing's last-post stamp: if a fetch came back behind the listing, they differ
// and the thread stays queued for re-fetch instead of being masked as up-to-date.
export function newestPostStamp(posts) {
  for (let i = (posts || []).length - 1; i >= 0; i--) if (posts[i] && posts[i].stampStr) return posts[i].stampStr;
  return null;
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
