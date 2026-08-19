# Архитектура Chromium MV3

MV3-реализация отделена от наследуемого MV2 runtime. Gulp переносит только
разрешённые общие статические ресурсы и собственный каталог
`src/extension-chromium-mv3` в готовый пакет.

## Общая схема

1. Popup и options запрашивают очищенную модель через внутренний RPC.
2. `background/service-worker.js` координирует состояние, PAC lifecycle,
   Chromium proxy API, health, auth и action status.
3. Нормализованное управление хранится в `chrome.storage.local` как `mv3State`.
4. Сырые и приготовленные PAC-тела хранятся отдельно в IndexedDB
   `mv3PacArtifacts`; в состоянии остаются ссылки, хэши и метаданные.
5. Chromium исполняет применённый PAC. Код расширения не выполняет загруженный
   текст как JavaScript.

## Service worker

Service worker синхронно импортирует фоновые модули и регистрирует listeners до
асинхронного восстановления. При пробуждении он восстанавливает поведение из
локального состояния, IndexedDB, alarms и живого `chrome.proxy.settings`, а не
из прежних переменных процесса.

Очереди операций, debounce-карты, попытки auth и action cache живут только в
памяти worker и исчезают при остановке. Это допустимо, если итоговое поведение
может быть восстановлено из durable state.

## Состояние и атомарные обновления

`background/state.js` владеет schema defaults, нормализацией и очередью
операций. Каждая queued mutation перечитывает актуальный storage snapshot,
вычисляет изменение и записывает нормализованный результат в одной операции.
Это предотвращает потерю параллельных изменений одного поля внутри активного
worker.

Сама очередь не переживает restart. Поэтому долгие workflow используют durable
generation/fingerprint и проверяют свежесть на асинхронных границах.

## Жизненный цикл PAC

### Download

Источник проверяется до `fetch`; после redirect проверяется конечный URL.
Допустимы HTTPS и loopback HTTP, credential-bearing URL запрещён. Deadline
охватывает чтение body, размер ограничен 16 MiB, UTF-8 декодируется в строгом
режиме. URL источника перебираются последовательно в заданном порядке.

### Store

Валидный текст хэшируется и сохраняется content-addressed артефактом IndexedDB.
Основное состояние получает только метаданные и `artifactRef`. Старое inline
PAC-тело удаляется только после успешной недеструктивной миграции в артефакт.

### Cook

PAC cooker нормализует правила и методы, формирует wrapper и сохраняет cooked
артефакт. Учётные данные собственного прокси исключаются. Явная Proxy-ветка
требует хотя бы одного пригодного кандидата и не содержит provider fallback или
преднамеренного `DIRECT`.

### Apply

Перед `chrome.proxy.settings.set` проверяются provider, хэши raw/cooked,
ревизия modifiers, workflow generation, живой владелец настройки и финальный
fingerprint. Применение использует `mandatory: false`; строгая сгенерированная
ветка не равна browser-level fail-closed гарантии.

## Свежесть workflow

Долгое обновление может пересекаться со сменой provider, правила, повторным
apply или clear. `pacWorkflowGeneration` инвалидирует старые download/cook
цепочки, а in-memory apply token не позволяет устаревшему callback записать
успех поверх нового действия. Перед финальной записью повторяются durable и
live-control проверки.

## Владение proxy settings

Сохранённый статус не считается достаточным: worker перечитывает живой
`levelOfControl`. При управлении другим расширением или policy UI показывает
`EXT`, а apply/clear не должны перехватывать настройку.

Chromium не даёт атомарный compare-and-set между последним чтением владельца и
обработкой `settings.set`. Эта узкая native timing boundary остаётся известным
ограничением.

### Восстановление после полного browser restart

На старте worker строит план восстановления только для последнего успешно
применённого PAC. План требует persisted applied intent, совпадения provider,
modifier revision, provenance, content hash и актуального cooked artifact, а
также живого состояния Chromium, которым расширение вправе управлять. Он не
скачивает и не готовит PAC заново.

Persisted Clear/Turn off запрещает восстановление. Новый manual Apply/Clear или
изменение конфигурации инвалидирует старый startup plan; external controller или
policy всегда приводит к пропуску без `settings.set`.

## Supervisor здоровья proxy

Health state привязан к точному кандидату, revision, target origin и browser
session. После startup reconstruction проверка планируется с 30-секундной
задержкой. Успех имеет TTL один час; proxy-specific failures используют
ограниченный backoff 1/5/15/30/60 минут, затем максимум один повтор в час.
Ошибка прошлой browser session становится нейтральной и stale до новой
проверки. Alarm и durable metadata позволяют восстановить расписание после
остановки worker.

Supervisor наблюдает browser proxy errors и выполняет credential-free fetch,
но не меняет PAC, A/P/D, provider или ownership. Неоднозначная destination,
DNS или TLS ошибка не классифицируется как доказанный отказ proxy.

## Маршрутизация

`background/site-scope.js` использует bundled `tldts` для доменной области.
Порядок важных решений: явный Direct, явный Proxy, whitelist miss, `.onion`,
затем provider policy. Порядок кандидатов Proxy: собственные прокси, локальный
Tor, Tor Browser, WARP.

Безопасные defaults сохраняют provider proxy, ограничивают собственные методы
собственными сайтами и не включают Direct replacement или `noDirect` без
явного opt-in.

## Поверхности интерфейса

- Popup — глобальное включение/выключение, текущий сайт, краткий status и
  переход в настройки.
- Options — семь секций, draft handling, применение конфигурации, diagnostics,
  maintenance и legacy migration.
- Action icon — вычисляемая модель A/P/D, OFF, EXT, busy и warning для активной
  вкладки.

Страницы используют `textContent`/DOM APIs и получают только redacted RPC
модели. Они не читают фоновые globals и не загружают удалённые скрипты.

## Границы безопасности

- Недоверенный PAC остаётся данными до передачи Chromium.
- Пароли остаются в локальном state для proxy-auth и не попадают в PAC/UI/logs.
- Диагностика скрывает PAC body, приватные source URL и reusable credentials.
- Auth применяется только к proxy challenge точного host/port и имеет retry
  limit.
- Миграция MV2 запускается явно, ограничена полями, не удаляет старые данные и
  не применяет proxy settings автоматически.

Исторический аудит, предшествующий исправлениям beta 1, сохранён в
[`docs/legacy/audits/`](../legacy/audits/). Актуальный performance audit находится
в [`audits/PERFORMANCE_AUDIT.md`](audits/PERFORMANCE_AUDIT.md).
