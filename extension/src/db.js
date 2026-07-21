// IndexedDB wrapper. Stores:
//  - kv:      config + small singletons (myTeam, settings, tz sample, daily meta)
//  - httpc:   HTTP cache keyed by URL { url, ts, etag, lastModified, status, body }
//  - threads: parsed thread snapshots keyed by threadId
//  - deals:   per-deal user overrides keyed by threadId
const DB_NAME = 'mangame-tracker';
const DB_VER = 1;

let _dbp = null;
function open() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('httpc')) db.createObjectStore('httpc', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'threadId' });
      if (!db.objectStoreNames.contains('deals')) db.createObjectStore('deals', { keyPath: 'threadId' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => req(s.get(k))),
  set: (k, v) => tx('kv', 'readwrite', (s) => req(s.put(v, k))),
};

export const httpCache = {
  get: (url) => tx('httpc', 'readonly', (s) => req(s.get(url))),
  put: (rec) => tx('httpc', 'readwrite', (s) => req(s.put(rec))),
  del: (url) => tx('httpc', 'readwrite', (s) => req(s.delete(url))),
};

export const threadStore = {
  get: (id) => tx('threads', 'readonly', (s) => req(s.get(id))),
  put: (rec) => tx('threads', 'readwrite', (s) => req(s.put(rec))),
  all: () => tx('threads', 'readonly', (s) => req(s.getAll())),
  del: (id) => tx('threads', 'readwrite', (s) => req(s.delete(id))),
};

export const dealStore = {
  get: (id) => tx('deals', 'readonly', (s) => req(s.get(id))),
  put: (rec) => tx('deals', 'readwrite', (s) => req(s.put(rec))),
  all: () => tx('deals', 'readonly', (s) => req(s.getAll())),
};
