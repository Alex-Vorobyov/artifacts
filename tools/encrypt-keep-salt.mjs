#!/usr/bin/env node
// Перешифровка данных артефакта С СОХРАНЕНИЕМ соли (правило №1 из скилла):
// ключ на устройствах выводится из фразы + соли, поэтому соль берём из текущего
// vault-файла, а IV генерим новый. Устройства остаются разблокированными.
// Использование: node tools/encrypt-keep-salt.mjs <seed.json> <vault.json> [--patch <index.html>]
// Пароль-фраза: из VAULT_PASS или интерактивный запрос.
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
const crypto = webcrypto;

const b64 = b => Buffer.from(b).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function derive(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

function ask(prompt) {
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
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

(async () => {
  const args = process.argv.slice(2);
  const patchIdx = args.indexOf('--patch');
  const patchPath = patchIdx >= 0 ? args[patchIdx + 1] : null;
  const pos = args.filter((a, i) => patchIdx < 0 || (i !== patchIdx && i !== patchIdx + 1));
  const [inPath, outPath] = pos;
  if (!inPath || !outPath) {
    console.error('usage: node tools/encrypt-keep-salt.mjs <seed.json> <vault.json> [--patch <index.html>]');
    process.exit(1);
  }

  const old = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const salt = unb64(old.salt);
  const iter = old.iter || 600000;

  const pass = process.env.VAULT_PASS || await ask('Пароль-фраза: ');
  if (pass.length < 8) { console.error('Слишком коротко.'); process.exit(1); }

  const data = fs.readFileSync(inPath, 'utf8');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(pass, salt, iter);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
  const vault = { v: 1, iter, salt: old.salt, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  fs.writeFileSync(outPath, JSON.stringify(vault, null, 2) + '\n');
  console.log(`готово: ${outPath} — соль сохранена, новый IV ${vault.iv}, ${data.length} байт открытого текста`);

  if (patchPath) {
    const html = fs.readFileSync(patchPath, 'utf8');
    const re = /const VAULT=\{[^;]*?\};/;
    if (!re.test(html)) { console.error(`не нашёл блок const VAULT= в ${patchPath}`); process.exit(1); }
    fs.writeFileSync(patchPath, html.replace(re, `const VAULT=${JSON.stringify(vault)};`));
    console.log(`пропатчен ${patchPath}`);
  }
})();
