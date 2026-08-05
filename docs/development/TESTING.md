# Тестирование

Все команды выполняются из корня репозитория. Зависимости устанавливаются в
extension tooling root:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm ci --prefix $Project
```

## Автоматические проверки

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

### Полная MV3 verification

```powershell
npm --prefix $Project run verify:mv3
```

CI дополнительно запускает `test:pac` явно и проверяет `git diff --exit-code`
после сборки.

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
