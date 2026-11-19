#!/usr/bin/env node
// Смена пароль-фразы для артефактов: расшифровывать старое не нужно —
// берём открытые сиды из локальной папки SEEDS и шифруем заново новым паролем.
//
//   node tools/rotate.mjs                 # спросит новую фразу, перепатчит оба артефакта
//   SEEDS=/path/to/seeds node tools/rotate.mjs
//   VAULT_PASS="..." node tools/rotate.mjs --no-prompt   (для скриптов, не для людей)
//
// Сиды — обычные JSON: seed_vietnam.json (массив задач) и seed_iis3.json ({state, months}).
// Храни их ВНЕ репозитория: они открытым текстом.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { webcrypto } from 'node:crypto';

const crypto = webcrypto;
const ITER = 600000;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SEEDS = process.env.SEEDS || path.join(os.homedir(), '.hermes', 'cache', 'scratch', 'seeds');
const TARGETS = [
  { slug: 'vietnam', seed: 'seed_vietnam.json', vault: 'tools/vault_vietnam.json' },
  { slug: 'iis-3',   seed: 'seed_iis3.json',   vault: 'tools/vault_iis3.json' },
];

const b64 = b => Buffer.from(b).toString('base64');

async function derive(pass, salt, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function ask(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let buf = '';
    const onData = ch => {
      for (const c of ch.toString()) {
        if (c === '\n' || c === '\r') {
          stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause();
          process.stdout.write('\n'); return resolve(buf);
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

async function getPass(noPrompt) {
  if (noPrompt || process.env.VAULT_PASS) {
    const p = process.env.VAULT_PASS;
    if (!p) { console.error('Нужен VAULT_PASS или интерактивный запуск.'); process.exit(1); }
    return p;
  }
  const p1 = await ask('Новая пароль-фраза: ');
  if (p1.trim().length < 8) { console.error('Слишком коротко: минимум 8 символов, лучше 4 слова.'); process.exit(1); }
  const p2 = await ask('Повтори: ');
  if (p1 !== p2) { console.error('Не совпало.'); process.exit(1); }
  return p1;
}

(async () => {
  const pass = await getPass(process.argv.includes('--no-prompt'));
  for (const t of TARGETS) {
    const seedPath = path.join(SEEDS, t.seed);
    if (!fs.existsSync(seedPath)) { console.error(`нет сида: ${seedPath}`); process.exit(1); }
    const data = fs.readFileSync(seedPath, 'utf8');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(pass, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
    const vault = { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };

    fs.writeFileSync(path.join(ROOT, t.vault), JSON.stringify(vault, null, 2) + '\n');

    const htmlPath = path.join(ROOT, t.slug, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const re = /const VAULT=\{[^\n]*?\};\n/;
    if (!re.test(html)) { console.error(`не нашёл VAULT в ${htmlPath}`); process.exit(1); }
    fs.writeFileSync(htmlPath, html.replace(re, `const VAULT=${JSON.stringify(vault)};\n`));
    console.log(`${t.slug}: перешифровано (${data.length} → ${ct.byteLength} байт)`);
  }
  console.log('\nДальше: git add -A && git commit -m "rotate passphrase" && git push');
})();
