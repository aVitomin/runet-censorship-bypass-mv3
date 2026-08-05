# Карта документации и инвентаризация репозитория

Дата инвентаризации: 2026-08-05. Базовая ревизия:
`4b13af64bb5e9859d52963bcbfcb40e1e3b302b5`.

До refresh в репозитории было 203 tracked файла. После предполагаемого
добавления текущего набора документации — 227 файлов: runtime и packaged bytes
не меняются, а разница состоит из docs, screenshots, community templates и
удалённого upstream funding pointer.

## Классификация полного дерева

| Категория | Количество | Пути и назначение |
| --- | ---: | --- |
| Current public product documentation | 17 | `README.md`, `docs/README.md`, `docs/user/*`, `docs/assets/readme/*`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md` |
| Current maintainer/developer documentation | 21 | `docs/development/*`, `docs/maintainers/DOCUMENTATION_MAP.md`, `AGENTS.md`, `.agents/skills/*`, MV3 nested `AGENTS.md`, tooling-root и legacy-options pointer README, asset attribution README |
| Legacy upstream documentation | 9 | `docs/legacy/*`, включая исторический README, compatibility pointer для его исходной относительной ссылки, store description, MV2 reviewer/options notes, старые architecture/migration audits и beta RC snapshot |
| Runtime source | 160 | 88 файлов текущего MV3 runtime/tests плюс 62 common, 8 full, 1 mini и `src/templates-data.js`; nested source build inputs входят в эту группу |
| Build tooling | 10 | extension `package.json`/lockfile, `gulpfile.js`, ESLint/Git attributes, tools, `grep.sh`, workflow и tooling `.gitignore` |
| Required legal/license material | 1 | Корневой `LICENSE` (GPL-3.0); дополнительные vendor license копируются из установленной pinned зависимости при сборке |
| Obsolete or unreferenced candidate | 1 | Корневой `package.json`, оставленный до явного решения сопровождающего |
| Uncertain/supporting repository content | 8 | `.gitignore`, `.rgignore`, `.vscode/settings.json` и пять исходных SVG assets |
| Generated output tracked | 0 | `build/`, `dist/`, `coverage/`, `.tmp/`, profiles и logs игнорируются |
| Internal/local report tracked | 0 | Четыре локальных отчёта находятся в ignored `.local/project-reports/` |

Файлы в `src/extension-common`, `src/extension-full` и `src/extension-mini`
классифицированы как runtime/build compatibility source, а не как текущая
публичная документация. Упоминания MV2/Firefox/MINI внутри них описывают
наследуемое поведение и не являются заявлением о текущей поставке.

## Канонические публичные документы

| Тема | Единственный основной документ |
| --- | --- |
| Продукт и краткий старт | [`README.md`](../../README.md) |
| Установка/обновление/удаление | [`docs/user/INSTALLATION.md`](../user/INSTALLATION.md) |
| Повседневная работа | [`docs/user/USER_GUIDE.md`](../user/USER_GUIDE.md) |
| Решение проблем | [`docs/user/TROUBLESHOOTING.md`](../user/TROUBLESHOOTING.md) |
| Privacy/security для пользователя | [`docs/user/PRIVACY_AND_SECURITY.md`](../user/PRIVACY_AND_SECURITY.md) |
| Подготовка разработки | [`docs/development/DEVELOPMENT.md`](../development/DEVELOPMENT.md) |
| Архитектура | [`docs/development/ARCHITECTURE.md`](../development/ARCHITECTURE.md) |
| Тестирование | [`docs/development/TESTING.md`](../development/TESTING.md) |
| Выпуск | [`docs/development/RELEASE_PROCESS.md`](../development/RELEASE_PROCESS.md) |
| Совместимость и legacy migration | [`docs/development/LEGACY_MIGRATION.md`](../development/LEGACY_MIGRATION.md) |
| Участие | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |
| Security reporting | [`SECURITY.md`](../../SECURITY.md) |

Tooling-root и legacy-options README теперь только направляют к этим документам
и не дублируют команды или пользовательскую установку.

## Текущие инженерные материалы

- `docs/development/LEGACY_MIGRATION.md` — актуальная совместимость хранения и
  явная недеструктивная миграция, а не инструкция по установке MV2.
- `docs/development/audits/PERFORMANCE_AUDIT.md` — публичный актуальный
  performance audit после исправлений.
- `docs/development/qa/*` — пять узких real-browser чек-листов для action,
  PAC freshness/download/failure и credential redaction.
- `AGENTS.md`, `.agents/skills/*` и nested `AGENTS.md` — локальные правила
  сопровождения исходников; они остаются рядом с областью действия.
- `extensions/chromium/runet-censorship-bypass/assets/README.md` — происхождение
  исходных графических assets и attribution, поэтому остаётся на месте.

## Архив

- `docs/legacy/UPSTREAM_README.md` содержит архивный header и неизменённое тело
  прежнего корневого README, включая upstream credit, links, contributors,
  sponsors/backers и GPL lineage.
- `docs/legacy/extensions/chromium/runet-censorship-bypass/README.md` сохраняет
  работоспособность исходной относительной ссылки внутри неизменённого тела.
- `docs/legacy/UPSTREAM_STORE_DESCRIPTION.md` — старая store copy.
- `docs/legacy/FOR_REVIEWERS.md` и
  `docs/legacy/LEGACY_OPTIONS_BUNDLE_README.md` — инструкции MV2.
- `docs/legacy/CHROMIUM_READINGS.txt` — upstream reference links.
- `docs/legacy/audits/ARCHITECTURE_AUDIT_2026-07-17.md` — point-in-time audit,
  основные находки которого исправлены до beta 1.
- `docs/legacy/audits/MV3_LEGACY_MIGRATION_PHASE_NOTES.md` — фазовый snapshot,
  заменённый поддерживаемым руководством без внутренних RC-этапов.
- `docs/legacy/releases/V0.0.2.0_BETA1_RC_NOTES.md` — pre-release snapshot с
  историческими test counts и pending items; GitHub Release остаётся
  пользовательским источником статуса.

Каждый архивный документ явно предупреждает, что старые store/MV2/Firefox
инструкции не являются текущим руководством.

## Локальные и generated материалы

`.local/project-reports/` хранит четыре неизменённых локальных отчёта и целиком
игнорируется Git. `.tmp/` содержит QA profiles, screenshots и release checks;
только четыре отобранных, проверенных изображения скопированы в
`docs/assets/readme/`. `build/`, `dist/` и browser profiles также ignored и не
должны попадать в историю или extension ZIP.

## Полный список кандидатов на очистку

| Кандидат | Действие | Обоснование |
| --- | --- | --- |
| Старый корневой README | Archive under legacy + replace | Содержал текущими старые Web Store/Edge/Firefox/MINI/upstream release links; тело сохранено для attribution. |
| Tooling-root README | Move content to current docs; keep pointer | Дублировал build/release/user instructions; путь полезен как вход в tooling. |
| `description.md` | Archive under legacy | Нереференсная MV2 store copy со старым upstream release URL. |
| `extensions/chromium/readings.txt` | Archive under legacy | Исторические upstream links, не текущая инструкция. |
| Legacy options README | Archive body; keep source pointer | Boilerplate `yarn/npm install` неверен для текущего workflow; короткий pointer сохраняет осмысленным явное Gulp-исключение старого пути. |
| Старые reviewer notes | Archive under legacy | Нужны для provenance/Ace verification, но описывают MV2 packaging. |
| Beta 1 RC notes | Archive under legacy | Point-in-time test counts и pending items не должны конкурировать с Release. |
| Architecture audit 2026-07-17 | Archive under legacy | Четыре основные проблемы уже исправлены; audit сохраняет историческую ценность. |
| Performance audit | Move to current development docs | Описывает текущие оптимизации и ещё полезные browser measurements. |
| Пять browser QA документов | Move to current development docs | Актуальны сопровождающим, не должны лежать в tooling root. |
| Legacy migration notes | Archive phase snapshot; replace with current guide | Runtime migration остаётся текущей совместимостью, но старые phase/RC notes не должны быть канонической инструкцией. |
| `.github/FUNDING.yml` | Remove | Показывал donation link upstream как настройку этого standalone fork; sponsor history сохранена в archived README. |
| Корневой `package.json` | Requires maintainer decision; keep now | Только `opencollective postinstall` для upstream, без lockfile; CI/build/release его не используют. Рекомендуется удалить отдельным решением, если upstream donation prompt не является политикой форка. |
| `grep.sh` | Requires maintainer decision; keep | Нереференсный POSIX helper; не влияет на runtime, но может быть удобен не-Windows сопровождающим. |
| Пять SVG в tooling `assets/` | Requires maintainer decision; keep | Прямых ссылок не найдено, но это source artwork с attribution/history; безопасное удаление требует решения о сохранении исходников. |
| `.vscode/settings.json`, `.rgignore` | Keep in place | Активно исключают generated/vendor noise и соответствуют рабочему процессу. |
| `extension-common/full/mini` и Ace vendor | Keep in place | Нужны legacy compatibility build, общим assets и проверяемому vendor provenance. |
| MV3 placeholder pages | Keep in place | Ссылаются на shared placeholder runtime и входят в проверенный пакет. |
| Четыре project reports | Keep local/ignored | Внутренние планы/reviews не являются публичной документацией и не входят в package. |

Кроме `.github/FUNDING.yml`, кодовые или tooling-файлы в этом refresh не
удалялись. Неопределённые кандидаты сохранены согласно правилу недеструктивного
аудита.

## Корневой package.json

Файл объявляет пакет `subjective-good-is-evil`, лицензию ISC, единственный
`postinstall` через `opencollective` и ссылку на upstream collective. Поиск всего
дерева не нашёл использования в GitHub Actions, Gulp, тестах, сборке, упаковке
или выпуске. У него нет корневого lockfile, а актуальная документация прямо
запрещает устанавливать зависимости в корне.

Рекомендация: после явного решения о funding policy удалить этот файл отдельным
не-runtime изменением. До решения он остаётся, чтобы refresh документации не
принимал за сопровождающего решение о donation automation и лицензии metadata.
