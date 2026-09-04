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
через `crypto.getRandomValues`, но WebExtension API не может надёжно доказать,
что произвольный локальный процесс не владеет портом. Поэтому acquisition
primitive требует внешне prevalidated identity и не вызывается ни startup, ни
RPC. Остаточный риск local-port collision сохраняется.

Durable OFF state имеет schema v2:

```json
{"schemaVersion":2,"intent":"OFF","floorIdentity":null}
```

`floorIdentity` может содержать только точный canonical floor, нужный для
cleanup после interruption. Schema v1 OFF мигрирует в v2 OFF; malformed и
future state нормализуются в OFF без floor identity. Ownership признаётся
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

Реальный provider dataset, updater, активация, аутентификация и health-проверки
ещё не реализованы. Ownership primitives не делают routing доступным. Команда
активации всегда отвечает
`ACTIVATION_NOT_IMPLEMENTED`; наличие широких сетевых разрешений не делает
маршрутизацию доступной пользователю.

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
содержит реального или синтетического provider
dataset и в `OFF` не открывает dataset storage. Он не меняет Chromium build
output. Отдельный
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
