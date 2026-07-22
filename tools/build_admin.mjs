#!/usr/bin/env node
// Encrypt the cleartext admin panel (admin-src/) into the opaque blob the public
// extension ships: extension/admin.enc + extension/admin-gate.json.
//
//   verify:  PBKDF2(code, salt0, iters, SHA-256)  -> admin-gate.json.verifyHash
//   key:     HKDF-SHA256(ikm=code, salt="", info) -> AES-256-GCM key
//   payload: AES-256-GCM(key, iv, JSON{code,css}) -> admin.enc  (ciphertext||tag)
//
// Node's crypto is byte-compatible with the extension's WebCrypto path
// (src/admin-gate.js). On first run it generates admin-secret.json (the 256-bit
// access code + params); keep that file private (never in the public release).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = path.join(ROOT, 'admin-secret.json');
const SRC = path.join(ROOT, 'admin-src');
const EXT = path.join(ROOT, 'extension');
const nodeHash = (h) => h.toLowerCase().replace('-', ''); // "SHA-256" -> "sha256"

let secret;
if (fs.existsSync(SECRET)) {
  secret = JSON.parse(fs.readFileSync(SECRET, 'utf8'));
} else {
  secret = {
    accessCodeHex: crypto.randomBytes(32).toString('hex'),
    pbkdf2SaltHex: crypto.randomBytes(16).toString('hex'),
    iterations: 600000,
    hash: 'SHA-256',
    hkdfInfo: 'mangame-admin-aesgcm-v1',
    aesgcmIvHex: crypto.randomBytes(12).toString('hex'),
  };
  fs.writeFileSync(SECRET, JSON.stringify(secret, null, 2) + '\n');
  console.log('Generated admin-secret.json.\n  >>> ACCESS CODE: ' + secret.accessCodeHex + '\n  (keep admin-secret.json private — never ship it publicly)');
}

const ikm = Buffer.from(secret.accessCodeHex, 'hex');
const verifyHash = crypto
  .pbkdf2Sync(ikm, Buffer.from(secret.pbkdf2SaltHex, 'hex'), secret.iterations, 32, nodeHash(secret.hash))
  .toString('hex');
const key = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(secret.hkdfInfo, 'utf8'), 32));

const bundle = JSON.stringify({
  code: fs.readFileSync(path.join(SRC, 'admin.js'), 'utf8'),
  css: fs.readFileSync(path.join(SRC, 'admin.css'), 'utf8'),
});
const iv = Buffer.from(secret.aesgcmIvHex, 'hex');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(bundle, 'utf8'), cipher.final(), cipher.getAuthTag()]); // ct || 16B tag

fs.writeFileSync(path.join(EXT, 'admin.enc'), enc);
fs.writeFileSync(path.join(EXT, 'admin-gate.json'), JSON.stringify({
  verifyHash,
  pbkdf2: { saltHex: secret.pbkdf2SaltHex, iterations: secret.iterations, hash: secret.hash },
  hkdfInfo: secret.hkdfInfo,
  aesgcm: { ivHex: secret.aesgcmIvHex },
}, null, 2) + '\n');

console.log(`Wrote extension/admin.enc (${enc.length} bytes) + extension/admin-gate.json`);
