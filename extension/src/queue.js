// A persistent FIFO work queue with de-duplication.
//
// Guarantees the "nothing gets lost in the gap" property: threads detected as
// changed are enqueued; each paced chunk drains from the FRONT; whatever isn't
// drained this window stays at the front and is processed first next window.
// So if 102 threads change but we only read 78, the remaining 24 are the very
// next items read — never dropped, never starved.
export function makeQueue() {
  let items = [];
  const keys = new Set();
  return {
    // enqueue at the back (normal detection order)
    push(key) {
      if (keys.has(key)) return false;
      items.push(key); keys.add(key); return true;
    },
    // enqueue at the front (user-initiated: fetch this ASAP)
    unshift(key) {
      if (keys.has(key)) { const i = items.indexOf(key); if (i > 0) items.splice(i, 1); else return false; }
      items.unshift(key); keys.add(key); return true;
    },
    // remove and return up to n items from the front
    take(n) {
      const out = items.splice(0, Math.max(0, n));
      for (const k of out) keys.delete(k);
      return out;
    },
    remove(key) {
      if (!keys.has(key)) return;
      const i = items.indexOf(key); if (i >= 0) items.splice(i, 1);
      keys.delete(key);
    },
    has(key) { return keys.has(key); },
    get size() { return items.length; },
    toArray() { return [...items]; },
    load(arr) { items = [...(arr || [])]; keys.clear(); for (const k of items) keys.add(k); },
    clear() { items = []; keys.clear(); },
  };
}
