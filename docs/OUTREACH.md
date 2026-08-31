# Outreach (фаза E)

Живі канали розсилки, follow-ups і детекція відповідей. Реалізує SPEC §4 етапи 14–15,
§7, §8 і рішення Романа #1 (Gmail), #2 (WAHA), #8 (пріоритет каналів).

Джерело істини — `docs/SPEC.md`. Цей документ описує, ЯК саме зроблено і що
Роман має налаштувати руками.

---

## 1. Канали

| Канал | Режим | Транспорт | Reply detection |
|---|---|---|---|
| **WhatsApp** | авто | WAHA `POST /api/sendText` | webhook `POST /webhooks/waha` |
| **Instagram** | **ручний** | — (deep link у Telegram/UI) | — (Роман бачить сам) |
| **Viber** | **ручний** | — (`viber://chat?number=…`) | — (Роман бачить сам) |
| **Email** | авто (fallback) | Gmail SMTP (nodemailer) | IMAP polling кожні 10 хв |

Пріоритет вибору каналу (рішення #8, код у `src/channels/select.ts`, LLM у це не лізе):

```
WhatsApp → Instagram → Viber → email
```

Instagram і Viber **ніколи не відправляються автоматично** — DM-автоматизація
означає бан акаунта, а легального API для холодних вихідних у Viber немає.
Для них фабрика готує текст і deep link; відправляє Роман, і саме його
підтвердження в UI ("я відправив") записує повідомлення як `sent`.

---

## 2. Файли

```
src/channels/
  types.ts        контракт адаптера (sendDryRun / sendLive / deepLink) + SendContext
  select.ts       детермінований вибір каналу (фаза D, не змінювався)
  waha.ts         HTTP-клієнт WAHA: ping, sessions, check-exists, sendText, типи вебхука
  whatsapp.ts     адаптер WhatsApp поверх waha.ts
  email.ts        адаптер email: nodemailer, наш Message-ID, List-Unsubscribe
  instagram.ts    ручний канал (без змін)
  viber.ts        ручний канал (без змін)

src/outreach/
  optout.ts       детекція opt-out (4 мови) і bounce/DSN — чисті функції
  replyMatch.ts   матчинг вхідного повідомлення до бізнесу (thread → address → contact)
  inbound.ts      спільна обробка: reply / opt-out / bounce + скасування follow-ups
  wahaWebhook.ts  верифікація api-key і HMAC, парсинг конверта WAHA
  wahaInbound.ts  WAHA webhook → inbound.ts
  settings.ts     key/value для курсора IMAP

src/workers/
  outreach.ts     send-outreach + send-followup (гейти фази D збережені)
  replies.ts      poll-replies: IMAP по UID-курсору

src/api/server.ts POST /webhooks/waha
scripts/phaseE-e2e.ts  повна перевірка циклу без секретів Романа
```

---

## 3. Env-змінні

### Email (Gmail, рішення #1)

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465                 # 465 = implicit TLS; 587 = STARTTLS
SMTP_USER=roman@gmail.com
SMTP_PASS=<app password>      # 16 символів, БЕЗ пробілів
SMTP_FROM="Roman <roman@gmail.com>"
SMTP_MESSAGE_ID_DOMAIN=factory.local   # має бути стабільним!
SMTP_UNSUBSCRIBE_TO=          # порожньо = SMTP_USER

IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=roman@gmail.com
IMAP_PASS=<той самий app password>
IMAP_MAILBOX=INBOX
IMAP_MAX_PER_POLL=50
```

`SMTP_MESSAGE_ID_DOMAIN` **не можна міняти після старту розсилки**: наш
Message-ID кодує в собі idempotency key, і по ньому матчаться відповіді.
Зміна домену не ламає старі треди (парсер дивиться на префікс `factory.`,
а не на домен), але робить логи неконсистентними.

### WhatsApp (WAHA, рішення #2)

```bash
WAHA_URL=http://waha:3000     # у compose; локально http://127.0.0.1:3001
WAHA_API_KEY=<довгий рандом>  # обов'язково
WAHA_SESSION=default
WAHA_HOOK_HMAC_KEY=<рандом>   # рекомендовано
WAHA_HOOK_URL=http://factory:8787/webhooks/waha
WAHA_DASHBOARD_USERNAME=waha
WAHA_DASHBOARD_PASSWORD=<пароль>
WAHA_ALLOW_DEV_KEY=false      # true ТІЛЬКИ для локального dev
WAHA_ENGINE=NOWEB
WAHA_CHECK_EXISTS=true
```

### Про dev-заглушки

`docker-compose.yml` дає `WAHA_API_KEY` і `WAHA_DASHBOARD_PASSWORD` дефолти
(`factory-dev-key` / `factory-dev-password`). Це не недбалість, а вимога
ергономіки: compose інтерполює змінні ВСІХ сервісів на КОЖНІЙ команді, тож
жорстка вимога (`${VAR:?}`) ламала б `docker compose ps` і
`docker compose exec postgres …` кожному, хто ще не налаштовував WhatsApp.

Захист від того, щоб заглушка поїхала в прод — у самому контейнері: WAHA
**відмовляється стартувати** із заглушкою, якщо явно не виставлено
`WAHA_ALLOW_DEV_KEY=true`. Відкритий WAHA = захоплення WhatsApp-акаунта,
тому це перевіряється, а не залишається на увагу.

На Apple Silicon образ за замовчуванням не запуститься (amd64):
`WAHA_IMAGE=devlikeapro/waha:noweb-arm`.

### Поведінка

```bash
FACTORY_MODE=dry_run          # live вмикає реальні відправки
OUTREACH_DAILY_LIMIT=20       # Gmail дозволяє ~500; тримаємо сильно нижче
FOLLOWUP_SCHEDULE_DAYS=3,7
```

---

## 4. Чекліст Романа: WAHA (готово до вставки в SETUP.md)

WhatsApp через WAHA — **неофіційний протокол**. Номер можна втратити.

1. **Візьми ОКРЕМИЙ номер** для розсилки. Не свій особистий. Це не
   перестраховка: при масовій розсилці на незнайомі номери WhatsApp банить.
2. Згенеруй ключі і поклади в `.env`:
   ```bash
   echo "WAHA_API_KEY=$(openssl rand -hex 32)" >> .env
   echo "WAHA_HOOK_HMAC_KEY=$(openssl rand -hex 32)" >> .env
   echo "WAHA_DASHBOARD_PASSWORD=$(openssl rand -hex 16)" >> .env
   ```
3. Підніми сервіс: `docker compose up -d waha`
4. Перевір, що живий: `curl http://127.0.0.1:3001/ping` → `{"message":"pong"}`
5. Створи і стартуй сесію:
   ```bash
   curl -X POST http://127.0.0.1:3001/api/sessions \
     -H "X-Api-Key: $WAHA_API_KEY" -H 'content-type: application/json' \
     -d '{"name":"default","start":true}'
   ```
6. **Відскануй QR** телефоном з номером розсилки. Два способи:
   - дашборд `http://127.0.0.1:3001/dashboard` (логін з `WAHA_DASHBOARD_*`);
   - QR картинкою: `http://127.0.0.1:3001/api/default/auth/qr` (з `X-Api-Key`).
7. Перевір статус — має бути `WORKING`:
   ```bash
   curl -H "X-Api-Key: $WAHA_API_KEY" http://127.0.0.1:3001/api/sessions/default
   ```
   `SCAN_QR_CODE` = ще не спарено, `STOPPED` = сесія не запущена.
   Фабрика **відмовляється відправляти**, поки статус не `WORKING`.
8. Тримай телефон онлайн. WhatsApp Web — це дзеркало телефона.

Порт 3001 прив'язаний до `127.0.0.1`. **Не виставляй WAHA в інтернет**:
сесія WhatsApp — це креденшел, відкритий WAHA = захоплення акаунта.

### Що WAHA робить із вхідними

Compose передає `WHATSAPP_HOOK_URL` і `WHATSAPP_HOOK_EVENTS=message`, тож
WAHA сама постить кожне вхідне повідомлення на `/webhooks/waha`. Фабрика
перевіряє `X-Api-Key` (WAHA echoes його через `WHATSAPP_HOOK_CUSTOM_HEADERS`)
і `X-Webhook-Hmac` (HMAC-SHA512 сирого тіла).

Ігноруються: `fromMe: true` і `source: "api"` (наше ж відлуння), групові чати
(`@g.us`), порожні тіла, не-`message` події.

---

## 5. Чекліст Романа: Gmail (готово до вставки в SETUP.md)

1. Увімкни двофакторну автентифікацію на акаунті (без неї app password недоступний).
2. https://myaccount.google.com/apppasswords → створи пароль, назви "websites-factory".
3. 16 символів **без пробілів** → `SMTP_PASS` і `IMAP_PASS`.
4. Увімкни IMAP: Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP.
5. Перевір, що воно живе:
   ```bash
   FACTORY_MODE=dry_run pnpm tsx -e "import('./src/channels/email.js').then(m=>m.getTransport().verify()).then(console.log)"
   ```
6. `OUTREACH_DAILY_LIMIT` тримай ≤ 20–30. Ліміт Gmail ~500/день, але
   репутація псується задовго до нього.

**Застереження зі спеки (§2.2, рішення #1):** якщо Gmail почне флагати листи
або з'явиться ризик для особистого акаунта — переїзд на окремий домен, і це
рішення переглядається першим.

---

## 6. Follow-ups (етап 15)

Плануються атомарно з фіксацією першого повідомлення через
`OutreachDeliveryService` на `FOLLOWUP_SCHEDULE_DAYS` (за замовчуванням +3 і
+7 днів), кожен зі своїм idempotency key `followup:approval:<id>:<n>`.

Перед автоматичною відправкою сервіс у транзакції резервує message intent і
слот денного ліміту. Тому паралельні воркери не можуть перевищити ліміт. Якщо
провайдер міг прийняти live-повідомлення, але локальну фіналізацію не вдалося
підтвердити, message переходить у `delivery_unknown`: автоматичний повтор
заборонений, доки оператор не звірить канал вручну.

**Умови зупинки перевіряються двічі** і це навмисно:

1. `cancelFollowups()` скасовує заплановані pg-boss jobs при reply/opt-out/bounce;
2. `followupSkipReason()` перевіряє все заново **в момент виконання**.

Скасування pg-boss — best effort. Другий рівень і є справжнім гейтом: пропущене
скасування = зайвий job, але **ніколи** не зайва відправка.

Причини пропуску: `status_beyond_contacted`, `deal_advanced`,
`reply_optout_bounce`, `initial_not_sent`, `do_not_contact`, `daily_limit`.

Для ручних каналів follow-up = **картка в Telegram** з deep link і готовим
текстом, а не автовідправка.

---

## 7. Матчинг відповідей

Дві незалежні дороги, сильніша перша:

1. **THREAD** — `In-Reply-To`/`References` містить наш Message-ID, у якому
   base64url-закодований idempotency key. Точний матч на конкретний рядок
   `outreach_messages`. Працює, навіть якщо власник відповів з іншої адреси.
2. **ADDRESS** — адреса відправника збігається з тією, куди ми писали, або з
   рядком у `business_contacts`. Слабше, але рятує, коли мейлер зрізав заголовки.

Кодування Message-ID **lossless** (base64url, не slug): втрата символів `:`
тихо деградувала б кожну відповідь до слабкого матчингу по адресі.

Невпізнане вхідне повідомлення **не вгадується** — логується і відкидається.

---

## 8. Opt-out і bounce

**Opt-out — назавжди** (§8). Пишеться і адреса/телефон, і `business_id`, щоб
друга адреса того самого бізнеса не відкрила його назад. Перевіряється в
момент send, а не approve: нова approval-картка все одно не відправиться.

Мови: англійська, грецька, українська, російська.

Дві пастки, на яких код спіткнувся під час верифікації і які тепер покриті тестами:

- **Грецька капсом не має наголосів.** `ΔΙΑΓΡΑΦΗ` у нижньому регістрі —
  `διαγραφη`, що ніколи не збіглося б із `διαγραφή`. Текст фолдиться через
  NFD перед матчингом, патерни написані без наголосів.
- **`\b` у JS — тільки ASCII.** `/не пишіть\b/` не спрацьовує ніколи, бо після
  кирилиці межі слова не існує. Використано явний lookahead.

Цитований оригінал відрізається перед перевіркою — інакше наш власний
`List-Unsubscribe` у цитаті читався б як opt-out.

**Bounce** (mailer-daemon, DSN, `Status: 5.x.x`) — не opt-out: бізнес може бути
доступний іншим каналом. Зупиняє follow-ups, ставить повідомлення в `failed`,
адреса з `Final-Recipient` витягується для матчингу.

---

## 9. Гейти безпеки (рекап)

| Гейт | Де | Що робить |
|---|---|---|
| Approval | `outreach.ts` gate 1 | без рядка `approvals.decision='approved'` send технічно неможливий |
| Idempotency | UNIQUE на `outreach_messages.idempotency_key` | рівно один send на approval; арбітр — БД, не `if` |
| do_not_contact | gate 2, **у момент send** | opt-out назавжди, перевіряється заново |
| Daily limit | gate 4, у момент send | рядок відкочується, щоб send міг пройти завтра |
| No auto-retry | `queue.ts` RETRY `send-outreach: {limit: 0}` | падіння send = `failed` + алерт, ніколи не повтор |
| dry_run | `config.mode` | за замовчуванням; live вмикається явно |
| Auth-помилки | адаптери | stop + Telegram alert (§7), бо це падіння каналу, не бізнеса |

---

## 10. Локальна перевірка без секретів

```bash
docker compose --profile dev-mail up -d greenmail   # SMTP 3025 / IMAP 3143
docker compose up -d waha                            # опційно, для /ping
pnpm phasee:e2e
```

`scripts/phaseE-e2e.ts` проганяє повний цикл на фікстурній кампанії
`e2e-phasee-<ts>`: approval → live SMTP → лист фізично в скриньці (перевірка
через IMAP) → відповідь → `poll-replies` → `outreach_events`/deal/status →
follow-up відмовляється відправлятись. Плюс bounce, opt-out, WAHA-вебхук,
exactly-once, HMAC. Наприкінці фікстури видаляються (`--keep` щоб лишити).

**Чому це безпечно для gr-patras-beauty:** send неможливий без рядка
`approvals`, а в жодного бізнеса цієї кампанії його немає — скрипт це
перевіряє окремим чеком. SMTP при цьому дивиться в контейнер на `127.0.0.1`,
тож навіть при помилці нічого не полетить назовні.

---

## 11. Що лишається ручним

- Instagram і Viber — відправка завжди руками Романа (deep link + текст).
- QR-скан WAHA при першому запуску і після втрати сесії.
- Оновлення стадії угоди (meeting/proposal/won/lost) — у UI, вручну.
- Retry впалого send — свідоме рішення людини, автоматичного повтору немає.
