# board-sync — синхронизация отметок между устройствами

Закрывает главную дыру доски: галочки больше не живут только в `localStorage`
одного браузера. Каждое устройство после разблокировки тянет общее состояние,
каждый клик уходит на сервер, чужие изменения подтягиваются сами.

```
GET  /board-sync  → {"rev":N,"marks":{"<id>":{"done":true,"doneAt":"…","ts":1795269260421}}}
POST /board-sync  → {"marks":{…}} → сервер сливает и возвращает итог
```

Заголовок `X-Board-Key` обязателен (кроме `/board-sync/health`). Ключ лежит
в `SYNC.key` внутри `vietnam/index.html` — страница публичная, но ключ позволяет
только переключать галочки на этом табло, ничего больше.

## Слияние

Для каждого `id` побеждает запись с бо́льшим `ts` (мс, часы устройства); при равном
`ts` — «выполнено». Поэтому отметка с телефона и снятая отметка на ноутбуке не
затирают друг друга пачкой: сервер мержит, а не перезаписывает целиком.
Старые локальные отметки без `ts` получают его из `doneAt` и один раз вливаются
на сервер при первом открытии.

## Где живёт (VPS 162.248.161.120, alexvorobyov.com)

| Что | Путь |
|---|---|
| Код | `/opt/board-sync/server.py` (копия этого каталога в репозитории) |
| systemd | `/etc/systemd/system/board-sync.service`, `DynamicUser`, `StateDirectory=board-sync` |
| Ключ | `/etc/board-sync/key` (600, читается через `LoadCredential`) |
| Состояние | `/var/lib/board-sync/state.json` + снимки каждые 20 ревизий в `history/` |
| Публикация | nginx `location = /board-sync` → `127.0.0.1:8791`, дальше Cloudflare |

Правка nginx не в git (так устроен прод). Блок, который нужно вернуть при переезде:

```nginx
location = /board-sync {
    proxy_pass http://127.0.0.1:8791;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 1m;
    proxy_buffering off;
}
```

Переустановка с нуля: `scp server.py` в `/opt/board-sync/`, ключ
(`python3 -c 'import secrets;print(secrets.token_hex(24))'`) в `/etc/board-sync/key`,
юнит в `/etc/systemd/system/`, `systemctl daemon-reload && systemctl enable --now board-sync`,
затем блок nginx, `nginx -t && systemctl reload nginx` и новый ключ в `SYNC.key` страницы.

## Проверка

```bash
KEY=$(grep -o 'key:"[a-f0-9]*' vietnam/index.html | cut -d'"' -f2)
curl -sS https://alexvorobyov.com/board-sync -H "X-Board-Key: $KEY" | python3 -m json.tool
curl -sS https://alexvorobyov.com/board-sync/health
```
