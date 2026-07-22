// Admin gate: prompt for the access code, verify + derive a key with WebCrypto,
// decrypt admin.enc (AES-256-GCM), and run the decrypted bundle inside the
// sandboxed iframe. All crypto is native crypto.subtle — no dependency.
//
//   verify:  PBKDF2(code, salt0, iters, SHA-256)  -> compare to embedded hash
//   key:     HKDF-SHA256(ikm=code, salt="", info) -> AES-256-GCM key
//   decrypt: AES-256-GCM(key, iv, admin.enc)       -> { code, css } bundle
//
// The access code is a 256-bit uniform secret shown as 64 hex chars
// (case-insensitive). Security here is obfuscation/gate-keeping, not defensible
// crypto — without the code you only have the ciphertext (2^256 brute force).

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

function hexToBytes(hex) {
  const clean = (hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function eqHex(a, b) { // length-independent-ish compare (obfuscation, not a real oracle concern)
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function decryptBundle(codeInput, gate) {
  const ikm = hexToBytes(codeInput);
  if (ikm.length !== 32) throw new Error('Access code must be 64 hex characters (256 bits).');

  // verify
  const pk = await crypto.subtle.importKey('raw', ikm, 'PBKDF2', false, ['deriveBits']);
  const vbits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(gate.pbkdf2.saltHex), iterations: gate.pbkdf2.iterations, hash: gate.pbkdf2.hash },
    pk, 256);
  if (!eqHex(bytesToHex(vbits), gate.verifyHash)) throw new Error('Incorrect access code.');

  // key + decrypt (GCM tag also authenticates the key)
  const hk = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(gate.hkdfInfo) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const ct = await fetch(chrome.runtime.getURL('admin.enc')).then((r) => r.arrayBuffer());
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(gate.aesgcm.ivHex) }, key, ct);
  return JSON.parse(dec.decode(pt)); // { code, css }
}

let iframe = null;
let getSnapshot = null;
let onSetBudget = null;
let running = false;

function ensureIframe() {
  if (iframe) return iframe;
  iframe = document.createElement('iframe');
  iframe.id = 'adminFrame';
  iframe.src = chrome.runtime.getURL('admin-sandbox.html');
  $('adminPane').append(iframe);
  return iframe;
}

function pushData() {
  if (!running || !iframe || !getSnapshot) return;
  iframe.contentWindow.postMessage({ type: 'data', payload: getSnapshot() }, '*');
}

async function launch(bundle) {
  running = true;
  ensureIframe();
  // wait for the sandbox to load, then send the bundle; on ready, push data
  await new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.type === 'sandbox-loaded') iframe.contentWindow.postMessage({ type: 'run', code: bundle.code, css: bundle.css }, '*');
      else if (m.type === 'admin-ready') { window.removeEventListener('message', onMsg); resolve(); }
    };
    window.addEventListener('message', onMsg);
    // if the frame already loaded before we attached, nudge it
    try { iframe.contentWindow.postMessage({ type: 'run', code: bundle.code, css: bundle.css }, '*'); } catch (e) {}
  });
  pushData();
}

function showTab(which) {
  const admin = which === 'admin';
  $('adminPane').classList.toggle('hidden', !admin);
  $('mainPane').classList.toggle('hidden', admin);
  $('tabTeam').classList.toggle('active', !admin);
  $('tabAdmin').classList.toggle('active', admin);
}

async function openAdmin() {
  const gate = await fetch(chrome.runtime.getURL('admin-gate.json')).then((r) => r.json());
  const modal = $('adminModal');
  modal.classList.remove('hidden');
  $('adminCode').value = '';
  $('adminCodeErr').textContent = '';
  $('adminCode').focus();

  const submit = async () => {
    $('adminCodeErr').textContent = '';
    try {
      const bundle = await decryptBundle($('adminCode').value, gate);
      modal.classList.add('hidden');
      $('adminTabs').classList.remove('hidden');
      await launch(bundle);
      showTab('admin');
    } catch (e) {
      $('adminCodeErr').textContent = e.message || 'Failed to open admin panel.';
    }
  };
  $('adminGo').onclick = submit;
  $('adminCode').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('adminCancel').onclick = () => modal.classList.add('hidden');
}

// Wire the header Admin button + tab toggle. `snapshotFn` returns the admin data;
// `setBudget(team, amount)` persists an admin-entered per-team budget.
export function setupAdmin(snapshotFn, setBudget) {
  getSnapshot = snapshotFn;
  onSetBudget = setBudget || null;
  // budgets are typed inside the sandboxed iframe, which posts them up to us
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'set-budget' && onSetBudget) onSetBudget(m.team, m.amount);
  });
  $('adminBtn').addEventListener('click', openAdmin);
  $('tabTeam').addEventListener('click', () => showTab('team'));
  $('tabAdmin').addEventListener('click', () => showTab('admin'));
}

// Called by the app after each refresh so the admin view stays current.
export function refreshAdmin() { pushData(); }
