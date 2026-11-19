#!/usr/bin/env node
// Шифровальщик данных для статических артефактов (WebCrypto, AES-GCM + PBKDF2).
// Использование:
//   node vault.mjs encrypt seed.json vault.json     # пароль спросит или возьмёт из VAULT_PASS
//   node vault.mjs decrypt vault.json               # проверка: расшифровать и напечатать
//   node vault.mjs rotate seed.json vault.json      # то же, что encrypt (новый пароль)
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
const crypto = webcrypto;

const ITER = 600000;
const KEYLEN = 256;

const b64 = b => Buffer.from(b).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function derive(pass, salt, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: KEYLEN }, false, ['encrypt', 'decrypt']);
}

function ask(prompt, { silent = true } = {}) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let buf = '';
    const onData = ch => {
      const s = ch.toString();
      for (const c of s) {
        if (c === '\n' || c === '\r') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false); stdin.pause();
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') { buf = buf.slice(0, -1); continue; }
        buf += c;
        if (!silent) process.stdout.write(c);
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

async function getPass(confirm) {
  if (process.env.VAULT_PASS) return process.env.VAULT_PASS;
  const p1 = await ask('Пароль-фраза: ');
  if (p1.length < 8) { console.error('Слишком коротко: минимум 8 символов, лучше 4 слова.'); process.exit(1); }
  if (confirm) {
    const p2 = await ask('Повтори: ');
    if (p1 !== p2) { console.error('Не совпало.'); process.exit(1); }
  }
  return p1;
}

async function encryptFile(inPath, outPath) {
  const data = fs.readFileSync(inPath, 'utf8');
  const pass = await getPass(true);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
  const vault = { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  fs.writeFileSync(outPath, JSON.stringify(vault, null, 2) + '\n');
  console.log(`готово: ${outPath} — ${data.length} байт открытого текста → ${ct.byteLength} байт шифротекста, ${ITER} итераций PBKDF2`);
}

async function decryptFile(vaultPath) {
  const vault = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  const pass = await getPass(false);
  const key = await derive(pass, unb64(vault.salt), vault.iter || ITER);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
    console.log(new TextDecoder().decode(pt));
  } catch (e) {
    console.error('Не расшифровалось — пароль не тот.');
    process.exit(2);
  }
}

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'encrypt' || cmd === 'rotate') return encryptFile(a, b);
  if (cmd === 'decrypt') return decryptFile(a);
  console.log('usage: node vault.mjs encrypt|rotate <in.json> <out.json> | decrypt <vault.json>');
  process.exit(1);
})();
