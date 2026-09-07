# Инертный каркас Firefox MV3

В репозитории есть отдельная экспериментальная production-source граница
`src/extension-firefox-mv3`. Она пока **не является поддерживаемым Firefox-
продуктом** и не входит в публичные инструкции установки или выпуска.

Текущий пакет намеренно остаётся в состоянии `OFF`. Он содержит Firefox MV3
manifest, непостоянную background event page, минимальное долговременное
состояние `OFF`, read-only capability RPC, неактивный Firefox routing adapter и
реализацию declarative dataset runtime без самого provider dataset.
Adapter заранее регистрирует `proxy.onRequest` и блокирующий
`webRequest.onBeforeRequest`, поэтому manifest уже запрашивает `proxy`,
`webRequest`, `webRequestBlocking` и `<all_urls>`. Пока durable intent равен
`OFF`, proxy listener не задаёт маршрут, а guard разрешает обычный трафик.

Firefox routing adapter фиксирует проверенную в Firefox 154.0.1 семантику
результатов `proxy.onRequest`:

- browser-neutral `DIRECT` преобразуется в top-level `null`; это явный Direct,
  отличный от `OFF`, при котором listener возвращает `undefined` и не задаёт
  маршрут;
- `{type: 'direct'}` не является эквивалентом true Direct при наличии browser
  или global `proxy.settings`, потому что Firefox продолжает применять эти
  настройки;
- `PROXY + FAIL_CLOSED` преобразуется в `[...proxyInfos, null]`, где последний
  `null` завершает proxy fallback и не создаёт дополнительный
  `webRequest.onBeforeRequest` callback;
- Chromium provider chain может заканчиваться `DIRECT`. Firefox намеренно
  удаляет только этот terminal Direct fallback: browser-neutral
  `PROXY + DIRECT` преобразуется в тот же упорядоченный
  `[...proxyInfos, null]`, с budget только для proxy-кандидатов и diagnostic
  `PROXY_DIRECT_FALLBACK_STRIPPED`;
- успешный выбор proxy и failover между proxy-кандидатами остаются
  эквивалентными. Если все кандидаты недоступны, Chromium может перейти к
  Direct, а Firefox завершает запрос fail-closed. Это намеренное различие
  safety/availability, которое не создаёт Direct route.

Обычный provider Direct остаётся поддержанным, если shared routing core уже
свёл решение к `{kind: 'DIRECT'}`. Default provider Auto больше не блокируется
до первой proxy-попытки, но полная routing parity с Chromium не заявляется.
Firefox-specific control plane теперь содержит узкие primitives для global
fail-closed floor и Clear, но не содержит production activation path. Canonical
floor — manual SOCKS5 `127.0.0.1:<persisted-high-port>` с `proxyDNS: true`,
пустыми HTTP/SSL/auto-config/passthrough и `httpProxyAll: false`. Port `0`,
well-known и другие low ports невалидны. Кандидат high port создаётся только
внутри proxy-control через `crypto.getRandomValues`; activation caller не
выбирает floor и не подтверждает состояние порта. Assurance identifier
`RANDOM_LOOPBACK_UNVERIFIED_V1` прямо означает, что WebExtension API не может
доказать отсутствие listener на выбранном endpoint. Port не probe-ится и не
retry-ится по network behavior.

Принятый threat model защищает от Firefox/WebExtension lifecycle и listener
failures, control loss и private-access revocation, но не от hostile local
software. Случайный занятый port возможен. Обычный non-SOCKS listener обычно
остаётся fail-closed, но это не security guarantee; доступный SOCKS service на
точном endpoint может обойти floor. WebExtension не может предотвратить
bind-after-selection. Product сознательно не требует native helper/reservation.

Durable state имеет schema v3; канонический `OFF` имеет форму:

```json
{"schemaVersion":3,"intent":"OFF","floorIdentity":null}
```

`floorIdentity` может содержать только точный canonical floor, нужный для
cleanup после interruption. Schema v1/v2 OFF мигрирует в v3 OFF; malformed и
future state нормализуются в OFF и могут сохранить только отдельно валидную
floor identity для безопасного cleanup. Ownership признаётся
только при одновременных exact identity match и
`levelOfControl === "controlled_by_this_extension"`. Clear сначала сохраняет
OFF, очищает ephemeral requestId budgets, затем освобождает только точный
owned floor и удаляет identity лишь после подтверждения release. Mismatch не
перезаписывается и не очищается.

Firefox 154 добавляет к live `proxy.settings.get()` нормализованное
`autoLogin: false`. Оно не хранится в durable identity, но exact live comparison
явно требует `false`, если поле присутствует; другие дополнительные поля и
`autoLogin: true` считаются mismatch.

На каждом event-page boot OFF reconciliation никогда не приобретает floor. Если
Firefox после disable/re-enable восстановил точный extension-owned floor,
reconciliation очищает его даже при denied private access и оставляет runtime
OFF. RPC `firefox.activation.clear` предоставляет только этот безопасный Clear;
он не вызывает `proxy.settings.set`.

Firefox-specific proxy authentication регистрируется синхронно через
блокирующий `webRequest.onAuthRequired`, но shipped OFF-only event page
использует пустой in-memory credential resolver. `authRef` остаётся непрозрачной
routing metadata: он хранится только в bounded request-scoped map и никогда не
попадает в Firefox `ProxyInfo`. Username/password не являются полями routing
decision, не сохраняются, не логируются, не выдаются через RPC и diagnostics.

Auth handler возвращает credentials только при одновременном совпадении
активного `requestId`, выбранного в `onBeforeRequest.details.proxyInfo` proxy и
challenger host/port с одним validated route candidate и его `authRef`. Origin
authentication при активной защите отменяется; в `OFF` listener возвращает no
override и не вмешивается в постороннюю browser auth. Missing credentials,
mismatch, malformed state и внутренний failure отменяют challenge, не открывая
Firefox proxy-auth prompt.

Firefox 154 повторно вызывает `onBeforeRequest` с тем же `requestId` после
каждого credential response. Поэтому routing и auth используют раздельные
budgets: непосредственно перед возвратом credentials auth разрешает ровно один
дополнительный guard callback. На request/challenger допускается максимум два
credential response. Terminal event, Clear и event-page recreation очищают как
route-auth, так и attempt state. Отмена исчерпанного auth challenge завершает
request вместо перехода к следующему proxy candidate; это известное Firefox
availability-отличие, а не Direct fallback или утечка.

Реальный provider dataset, production updater configuration, активация,
production credential configuration/UI и health-проверки ещё не реализованы.
Ownership/auth
primitives не делают routing доступным. Команда
активации всегда отвечает
`ACTIVATION_NOT_IMPLEMENTED`; наличие широких сетевых разрешений не делает
маршрутизацию доступной пользователю.

В package присутствует inert activation controller для отдельного тестирования
полностью подготовленной synthetic session. Его production event page создаёт,
но не вызывает: RPC, startup и storage не имеют пути к `activatePrepared`, а
capability `activationSupported` остаётся `false`. Prepared input имеет строгую
форму и содержит provider key, exact dataset identity, строгий routing
descriptor, dataset store, synchronous routing-input factory и synchronous
in-memory credential resolver. Floor identity не является caller input: её
генерирует и возвращает proxy-control только после exact ownership confirmation.
Credentials не сохраняются.

Транзакция сначала полностью проверяет exact dataset и строит lookup index,
затем требует `READY`, приобретает и подтверждает exact fail-closed floor,
записывает строгий durable `ON`, очищает старое request/auth ephemeral state и
только последним синхронным присваиванием публикует immutable active session.
До floor acquisition controller остаётся `OFF`; между acquisition и publication
обычный listener не задаёт route, а global floor закрывает сетевой путь. Clear
сначала записывает `OFF` с cleanup identity, затем скрывает session и очищает
request/auth state, и только после этого освобождает exact floor. Ошибка после
acquisition запускает тот же exact-match rollback; если release невозможен,
session остаётся недоступной, floor и durable cleanup identity остаются
fail-closed для следующего startup reconciliation.

Durable state schema v3 различает `OFF` и строгий `ON`. `ON` содержит только
canonical floor identity, provider key, exact dataset identity
(`datasetVersion` + SHA-256) и routing descriptor, который ссылается на
отдельную версионированную конфигурацию по key/version/SHA-256. Functions,
credentials, request IDs, auth attempts и session state не сохраняются.
Malformed или future `ON` никогда не активируется; допустимая cleanup floor
identity сохраняется только для безопасного exact-match освобождения.

Новый event page начинает с `INITIALIZING`, поэтому blocking guard отменяет
запросы, пока storage intent неизвестен. `OFF` выполняет cleanup reconciliation
и только затем разрешает обычный browser routing. Для `ON` recovery сначала
требует private access и уже существующий exact extension-owned floor; старый
random port никогда не генерируется заново и floor не переустанавливается.
Затем recovery factory должен восстановить dataset store, routing-input factory,
тот же exact routing descriptor и in-memory credential resolver. Controller
принимает только exact сохранённые dataset hash и routing descriptor, строит
index, очищает ephemeral maps и публикует session последним присваиванием.
Missing/mismatched floor переводит durable intent в `OFF`, не
перезаписывая чужие settings, но сохраняет точную старую floor identity как
cleanup identity на случай, если Firefox позже восстановит слой расширения.
Missing configuration/dataset/credentials или
revoked private access оставляет session недоступной, а exact floor —
fail-closed до Clear.

`proxy.settings.onChange` регистрируется синхронно рядом с network listeners.
Если `READY` session видит что-либо кроме exact persisted floor с
`controlled_by_this_extension`, handler без ожидания скрывает active session,
переводит runtime в `BLOCKED_CONTROL_LOSS` и очищает routing/auth ephemeral
state. Асинхронная часть затем сохраняет `OFF` с retained cleanup identity;
она никогда не вызывает `set()` и не очищает setting другого расширения или
policy. Ошибка записи `OFF` оставляет runtime blocked/fail-closed и не
восстанавливает session.

Если Firefox после освобождения внешнего controller автоматически возвращает
старый exact extension-owned floor, уже `OFF` controller удаляет только этот
точно совпавший слой, восстанавливает нижележащую настройку и удаляет cleanup
identity лишь после подтверждённого release. Resurfacing никогда не означает
восстановление `ON` или `READY`. Безопасность на границе передачи control
по-прежнему зависит от своевременной доставки Firefox события
`proxy.settings.onChange`; до доставки browser может продолжать вызывать
старые routing listeners.

Prepared activation теперь фиксирует `ON` после floor confirmation, но до
session publication. Crash до записи `ON` оставляет `OFF` + cleanup identity;
startup очищает floor. Crash после записи `ON` восстанавливает exact session.
Clear сначала записывает `OFF` с cleanup identity, затем скрывает session,
очищает request/auth state и освобождает exact floor. Ошибка release сохраняет
durable `OFF` и floor identity для следующего reconciliation.

Production event page теперь передаёт controller реальный recovery factory, но
по-прежнему не имеет пути создания `ON`: `firefox.activation.apply` возвращает
`ACTIVATION_NOT_IMPLEMENTED`, а capability `activationSupported` равен `false`.
Factory используется только при уже существующем строгом durable `ON`; чистая
установка `OFF` не открывает IndexedDB и не читает Firefox product config.

Non-secret product config хранится отдельно под
`firefoxMv3ProductRoutingConfig` в schema v1. Он содержит exact provider и
dataset identity, тот же routing descriptor и каноническую структуру всех
browser-neutral inputs: rules, candidate groups, flags, provider candidates и
provider fallback. `configurationSha256` — SHA-256 от детерминированных UTF-8
bytes этой строгой структуры. Поэтому recovery требует одновременного exact
совпадения provider key, dataset hash/version, descriptor key/version/hash и
уже принадлежащего расширению floor; новая active/staged/LKG версия dataset не
подменяет durable identity.

Proxy credentials находятся в отдельной schema v1 записи
`firefoxMv3ProxyCredentials`, привязанной к тому же routing descriptor.
Configuration содержит только `authRef`; credential record содержит только
строгий список `authRef`/username/password. Во время boot credentials читаются
до publication, проверяется наличие всех и только требуемых `authRef`, после
чего READY session получает синхронный in-memory resolver. Passwords не входят
в durable `ON`, routing descriptor, dataset metadata, RPC/status/errors/logs
или diagnostics. Missing/malformed/future config, descriptor/provider/dataset
mismatch, missing credential, hash failure или недоступный dataset store
оставляют session недоступной, а exact floor — fail-closed до Clear.

Recovery не выполняет network request: production dataset store открывается
локально через IndexedDB только для durable `ON`, exact stored artifact ещё раз
проверяется существующим dataset runtime, и session публикуется только после
полного успеха. Реальный provider artifact, updater URL/key и persistent
production configuration по-прежнему отсутствуют в package.

Для каркаса используется development-only Gecko ID
`firefox-mv3-skeleton@runet-censorship-bypass.invalid`. Production Gecko/AMO ID
и возможная связь с legacy-идентичностями пока не определены; этот ID нельзя
использовать для выпуска или миграции.

Детерминированные проверки запускаются из корня репозитория:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm --prefix $Project run test:firefox
npm --prefix $Project run lint:firefox
npm --prefix $Project run build:firefox
```

Сборка содержит только `manifest.json`, Firefox background-скрипты и точные
копии browser-neutral routing/dataset contract в
`build/extension-firefox-mv3`. Dataset runtime использует неизменяемые
SHA-256-addressed артефакты, строгую общую верификацию и fallback
active -> previous LKG -> packaged baseline; parsed index хранится только в
памяти event page. Неизменяемые bytes и маленькие provider pointers находятся
в отдельных object stores Firefox-specific IndexedDB; запись артефакта и
переключение pointer выполняются одной транзакцией только после проверки точных
bytes. Remote candidate с unauthenticated trust не может стать active. Пакет не
содержит реального или синтетического provider dataset и в `OFF` не открывает
dataset storage. Он не меняет Chromium build output.

Пакет содержит инертный authenticated-update pipeline, но production event
page его не создаёт и не вызывает: отсутствуют production URL, public key,
alarm/timer, startup fetch и RPC update command. Update manifest schema v1
содержит только `schemaVersion`, `providerKey`, monotonic `sequence`, `keyId`,
relative `artifactPath` и строгий dataset `envelope`. Отдельная 64-byte
Ed25519 signature проверяется native WebCrypto над точными UTF-8 bytes
manifest до доверия его полям. `keyId` выбирает ключ только из injected pinned
`Map`; remote JSON не может объявить `trust`. После signature, manifest,
provider identity, exact byte count, SHA-256 и общей declarative dataset
verification pipeline внутренне присваивает `REMOTE_AUTHENTICATED`.

Fetch boundary принимает только явный HTTPS URL без credentials/query/fragment,
использует manual redirects с максимум тремя same-origin HTTPS переходами,
`credentials: omit`, `referrerPolicy: no-referrer`, общий deadline/AbortSignal и
streaming size bounds. Manifest ограничен 256 KiB, signature — ровно 64 bytes,
artifact — существующим пределом 16 MiB. Downloaded bytes никогда не
исполняются и остаются `HOST_BUCKETS_V1` data.

Provider pointer schema v2 мигрирует v1 с сохранением `active`,
`previousLkg` и `packagedBaseline`, добавляя отдельный `staged` pointer и
anti-rollback пару `highestAuthenticatedSequence`/artifact SHA-256. Lower
sequence отклоняется; одинаковые sequence+SHA idempotent, а одинаковый
sequence с другим SHA даёт conflict. Только полностью verified candidate
атомарно записывает immutable artifact, staged pointer и sequence metadata.
Stage не меняет active/LKG/live session/durable ON identity. Отдельный explicit
promotion одной IndexedDB transaction переводит staged в active, прежний
active в LKG и очищает staged; production event page promotion не вызывает.
Storage/signature/network failure не продвигает sequence и не меняет текущий
routing dataset.

Отдельный
локальный smoke с установленным Firefox 154.0.1 и одноразовым профилем можно
запустить командой:

```powershell
npm --prefix $Project run test:browser:firefox-skeleton
```

Smoke проверяет реальное уничтожение и пересоздание event page после idle,
сохранение `OFF` и отсутствие изменений заранее настроенного localhost proxy.
Он не является обязательным сетевым CI-шагом. Маршрутизация и пользовательский
Firefox-интерфейс должны появляться только в последующих отдельно проверяемых
изменениях. Источник, лицензия и authenticated publication production-scale
provider dataset остаются нерешённым prerelease-блокером; этот пакет не
предполагает их одобрения.
