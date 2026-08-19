# Разработка Chromium MV3

Текущая цель репозитория —
`extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3`.
Корневого npm-пакета нет. Старый Open Collective donation package удалён как
не связанный со сборкой и содержавший устаревший lifecycle hook. Это не меняет
[GPL-3.0](../../LICENSE), upstream-атрибуцию или историю спонсоров в
[архивном README](../legacy/UPSTREAM_README.md).

## Требования

- Git.
- Node.js 22 и совместимый npm. Node 22 используется в GitHub Actions.
- Brave или другой Chromium-браузер с поддержкой требуемых MV3 API.
- Windows PowerShell для команд в этом руководстве; сами npm-скрипты также
  выполняются в CI на Ubuntu.

## Клонирование и установка

```powershell
git clone https://github.com/aVitomin/runet-censorship-bypass-mv3.git
Set-Location .\runet-censorship-bypass-mv3
npm ci --prefix .\extensions\chromium\runet-censorship-bypass
```

Не запускайте `npm install`, `npm ci` или npm-скрипты в корне репозитория.
Используйте только extension-scoped команды: канонический пакет и его lockfile
находятся в `extensions/chromium/runet-censorship-bypass`.

## Основные команды

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'

node .\scripts\verify-docs.mjs
npm --prefix $Project run test:pac
npm --prefix $Project run test:mv3
npm --prefix $Project run lint:mv3
npm --prefix $Project run build:mv3
npm --prefix $Project run verify:mv3
```

`verify:mv3` последовательно запускает lint, весь набор MV3-тестов и сборку.
Фокусный `test:pac` полезно запускать отдельно при работе с маршрутизацией.
Dependency-free docs verifier запускается из корня и не требует корневого
`package.json` или `npm install`.

## Пути исходников и сборки

| Назначение | Путь |
| --- | --- |
| MV3 runtime | `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3` |
| Service worker | `…/background/service-worker.js` |
| Popup и settings | `…/pages/popup` и `…/pages/options` |
| Manifest template | `…/manifest.tmpl.json` |
| Версия и общие template values | `extensions/chromium/runet-censorship-bypass/src/templates-data.js` |
| Gulp orchestration | `extensions/chromium/runet-censorship-bypass/gulpfile.js` |
| Готовая unpacked-сборка | `extensions/chromium/runet-censorship-bypass/build/extension-chromium-mv3` |

Каталоги `extension-common`, `extension-full` и `extension-mini` — наследуемые
исходники. Часть общих статических ресурсов всё ещё копируется в MV3, а старые
цели нужны для совместимости сборки; не удаляйте их как «неиспользуемые» без
отдельного графа зависимостей.

## Загрузка локальной сборки

1. Выполните `build:mv3`.
2. Откройте `brave://extensions` или `chrome://extensions`.
3. Включите Developer mode.
4. Нажмите Load unpacked и выберите каталог
   `build/extension-chromium-mv3` внутри tooling root.
5. После изменений исходников снова соберите пакет и нажмите Reload.

Используйте отдельный тестовый профиль без личной истории, bookmarks и других
proxy-расширений. Не добавляйте профиль, NetLog, `build/`, `dist/` или `.tmp/` в
Git.

## Локализация

Пользовательская строка должна появиться в обоих файлах:

- `src/extension-chromium-mv3/_locales/en/messages.json`;
- `src/extension-chromium-mv3/_locales/ru/messages.json`.

Сохраняйте одинаковые ключи и формы placeholders. После изменения проверьте обе
локали в popup/options и выполните `lint:mv3`, `test:mv3`, `build:mv3`.
Интерфейс создаёт DOM через безопасные текстовые API; не добавляйте HTML injection
sinks для сохранённых значений.

## Значки

Состояния action генерируются детерминированным скриптом. Из tooling root:

```powershell
Set-Location .\extensions\chromium\runet-censorship-bypass
node .\src\extension-chromium-mv3\test\generate-action-icons.js
npm run build:mv3
```

`build:mv3` автоматически проверяет наличие и точное имя каждого runtime icon.
Не меняйте сгенерированные PNG вручную без обновления генератора и тестов.

## GitHub Actions

Workflow [`.github/workflows/mv3.yml`](../../.github/workflows/mv3.yml) работает
на Node 22 для push и pull request в `main`. Он устанавливает только зависимости
расширения, проверяет документацию, запускает PAC/MV3 tests, lint, build,
aggregate `verify`, package/icons и чистоту tracked tree. Только trusted push в
`main` сохраняет краткоживущий unpacked artifact; pull request artifact не
публикуется.

## Ветки и pull request

- Создавайте узкую тематическую ветку от актуального `main`.
- Не смешивайте документацию, поведение маршрутизации и обновление зависимостей
  без необходимости.
- Не коммитьте generated output, браузерные профили, секреты или локальные
  отчёты.
- Выполните `node .\scripts\verify-docs.mjs`; если изменение затрагивает
  установку, поведение, browser support, privacy/security, команды, архитектуру
  или выпуск, обновите соответствующий текущий документ.
- Опишите влияние на безопасность, маршрутизацию и требуемую браузерную QA.
- Дождитесь успешного workflow и ответьте на review до слияния.

Подробнее: [тестирование](TESTING.md), [архитектура](ARCHITECTURE.md) и
[CONTRIBUTING.md](../../CONTRIBUTING.md).
