# artifacts

HTML-артефакты, собранные Hermes. Данные внутри закрыты паролем-фразой
(WebCrypto: PBKDF2 600 000 итераций → AES-GCM 256), в файлах только шифротекст.

- `vietnam/` — чек-лист переезда во Вьетнам
- `iis-3/` — табло портфеля ИИС-3

Инструменты: `tools/vault.mjs` (шифрование/расшифровка/смена пароля).
  node tools/vault.mjs encrypt tools/seed_x.json tools/vault_x.json
  node tools/vault.mjs decrypt tools/vault_x.json

## Смена пароль-фразы

Сиды лежат вне репозитория (`SEEDS`, по умолчанию `~/.hermes/seeds`):

    node tools/rotate.mjs            # сиды берутся из ~/.hermes/seeds

Скроет новую фразу дважды, перешифрует оба артефакта и перепишет блоки `VAULT`
в HTML. Дальше — commit и push. Старая фраза перестаёт работать сразу.
