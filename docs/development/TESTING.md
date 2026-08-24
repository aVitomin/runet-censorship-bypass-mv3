# Тестирование

Все команды выполняются из корня репозитория. Зависимости устанавливаются в
extension tooling root:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm ci --prefix $Project
```

## Автоматические проверки

### Documentation integrity

```powershell
node .\scripts\verify-docs.mjs
```

Dependency-free проверка сканирует tracked Markdown, relative links, images и
anchors, запрещает developer-machine paths и stale current-release/default-
branch/install metadata. Она не делает CI зависимым от доступности внешних
сайтов; отдельный bounded аудит можно запустить с `--audit-external`.

### Production npm audit

```powershell
npm --prefix $Project run audit:prod
```

CI запускает этот gate сразу после `npm ci`. Команда использует
`npm audit --omit=dev` и блокирует любую advisory в production dependency tree.
Полный `npm audit` остаётся диагностическим: принятые dev-only findings дерева
Mocha не входят в production gate и не блокируют CI.

### PAC semantics

```powershell
npm --prefix $Project run test:pac
```

Тесты исполняют итоговый `FindProxyForURL` и проверяют exact/wildcard scope,
Auto/Proxy/Direct, порядок кандидатов, provider fallback, safe defaults и
конфликтующие правила. Изменение строк генератора без проверки наблюдаемого
результата недостаточно.

### Все MV3 tests

```powershell
npm --prefix $Project run test:mv3
```

Набор покрывает фоновые модули, сериализацию состояния, PAC download/security,
freshness, redaction, popup/options, action status и deterministic performance
counters.

### Lint

```powershell
npm --prefix $Project run lint:mv3
```

Используйте сфокусированный MV3 lint. Whole-tree legacy lint имеет отдельный
исторический baseline и не должен вызывать массовое форматирование.

### Build, package integrity и runtime icons

```powershell
npm --prefix $Project run build:mv3
```

Скрипт собирает `build/extension-chromium-mv3`, затем автоматически запускает:

- `test/verify-runtime-icons.js` — каждый используемый icon существует с
  правильным регистром и попал в пакет;
- `test/verify-package-integrity.js` — в пакете нет docs, tests, profiles,
  logs, archives, secrets-related metadata и других repository-only файлов.

Количество файлов выводится проверкой; не фиксируйте его в документации без
необходимости.

### Chrome Stable MV3 smoke

После MV3 build можно запустить короткий browser-level smoke на установленном
Google Chrome Stable:

```powershell
$env:CHROME_BIN = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm --prefix $Project run test:browser:mv3
```

`CHROME_BIN` — явный авторитетный override. Без него скрипт проверяет только
несколько стандартных путей установки и никогда не скачивает браузер. Тест
запускает собранное unpacked MV3-расширение в одноразовом профиле и поднимает
локальные PAC, origin и proxy на динамических loopback-портах. Через production
RPC он сохраняет provider и PAC modifiers, применяет реальный
`chrome.proxy.settings` и проверяет фактические HTTP receivers для Auto, Proxy
и Direct. Тест также выполняет настоящий HTTP proxy authentication flow:
первый запрос без credentials, ответ `407 Proxy Authentication Required`,
`webRequest.onAuthRequired`, повторный запрос с ожидаемыми credentials и
детерминированный ответ proxy. Второй, ранее не использованный authenticated
proxy проверяется только после полного перезапуска Chrome с тем же профилем.
Отдельные transport cases подтверждают обе HTTPS-границы: HTTPS destination
через обычный HTTP proxy проходит настоящий `CONNECT -> 407 -> authenticated
CONNECT -> TLS tunnel`, а PAC-кандидат `HTTPS host:port` устанавливает TLS до
самого proxy и выполняет `407` внутри этого соединения. В обоих случаях
отдельный direct trap остаётся пустым.

Для локальных TLS fixtures нужен установленный OpenSSL. `OPENSSL_BIN` задаёт
явный override; на Windows smoke также проверяет обычные пути OpenSSL из Git for
Windows. Сертификат и ключ создаются только во временном каталоге. Chrome
получает только SHA-256 SPKI этого сертификата через
`--ignore-certificate-errors-spki-list`; глобальное отключение проверки
сертификатов и изменение machine trust store не используются.

Негативные browser cases подтверждают отказ передавать proxy credentials на
обычный origin `401`, несовпадающий host/port и passwordless proxy, а также
ограничение повторов при неверном пароле. Отдельный синхронизированный case
останавливает точную версию MV3 service worker через CDP между двумя `407` и
подтверждает, что `storage.session` сохраняет общий лимит из двух credential
responses для прежнего `requestId`. Receiver logs хранят только безопасные
классы (`none`, `expected`, `known-wrong`, `unexpected`); password и reusable
Basic token дополнительно ищутся в PAC, RPC responses, DOM, diagnostics и
errors. Smoke сохраняет существующую проверку external-controller takeover,
deferred Turn off и restart persistence. Внешняя сеть не нужна; PAC исполняет
сам Chrome, а не Node.

Smoke не заменяет ручные проверки upgrade существующего профиля и полного UI.
Plain HTTP `407`, HTTPS destination `CONNECT` и TLS-to-proxy (`HTTPS` PAC
scheme) покрыты отдельно; forced mid-request worker termination также покрыт
receiver barrier без timing sleeps. Retry metadata живёт только в
`chrome.storage.session`, не содержит credentials и очищается на границе
browser session/extension reload. Тест не изменяет machine policy, а
детерминированные loopback DNS и receiver checks не доказывают отсутствие
утечек в произвольной реальной
сети.

### Полная MV3 verification

```powershell
npm --prefix $Project run verify:mv3
```

CI дополнительно запускает `test:pac` явно и проверяет `git diff --exit-code`
после сборки.

### Aggregate verification

```powershell
npm --prefix $Project run verify
```

Aggregate gate запускает полный extension test suite, focused MV3 lint,
совместимую MV2 build и затем финальную MV3 build. Именно этот gate вместе с
docs integrity обязан присутствовать и пройти в trusted-main release CI; набор
отдельных зелёных команд не заменяет отсутствующий обязательный gate.

## Проверка release package

Для каждого кандидата убедитесь, что:

- `manifest.json` находится в корне ZIP, а не во вложенном каталоге;
- распакованное содержимое совпадает с проверенной build directory;
- package-integrity и runtime-icon verification прошли;
- SHA-256 вычислен после окончательной упаковки;
- docs screenshots, `.local`, `.tmp`, profiles и reports не попали в ZIP.

Подробности: [процесс выпуска](RELEASE_PROCESS.md).

## Браузерная QA

Автоматические fakes не доказывают поведение конкретного Chromium build.
Используйте отдельный профиль и синтетические данные. Минимальная проверка:

1. Load unpacked, cold start, stop/restart service worker.
2. Выбор provider и единый Apply configuration.
3. Auto/Proxy/Direct для точного хоста и домена/поддоменов.
4. Turn off, повторный apply и external owner takeover/release.
5. Changed и unchanged PAC refresh; выключенное управление не должно само
   включиться.
6. Tor/WARP/собственный proxy по мере доступности тестовой среды.
7. Реальный authenticated proxy challenge отдельным тестовым аккаунтом.
8. Ошибки PAC/proxy, health badge и восстановление.
9. IndexedDB/state после worker restart и upgrade существующего профиля.
10. Русский и английский UI, keyboard flow, narrow/desktop layout.

Точечные чек-листы:

- [Action status](qa/ACTION_STATUS_BROWSER_QA.md)
- [PAC apply freshness](qa/PAC_APPLY_FRESHNESS_BROWSER_QA.md)
- [PAC download bounds](qa/PAC_DOWNLOAD_BOUNDS_BROWSER_QA.md)
- [PAC failure behavior](qa/PAC_FAILURE_BROWSER_QA.md)
- [RPC credential redaction](qa/RPC_CREDENTIAL_BROWSER_QA.md)

Не используйте личный профиль или публичный случайный proxy. Не публикуйте
NetLog, PAC, history или screenshots до проверки на чувствительные данные.
