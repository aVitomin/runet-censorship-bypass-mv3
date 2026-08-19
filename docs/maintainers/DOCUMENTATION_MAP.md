# Карта документации и инвентаризация репозитория

Дата актуализации: 2026-08-20. Базовая ревизия актуального `main`:
`275ba91d32adfe593a266b42a150f8cd689432ad`.

На базовой ревизии было 229 tracked файлов. Этот refresh добавляет только
`docs/release-current.json` и dependency-free `scripts/verify-docs.mjs`; runtime
и packaged bytes не меняются. Точные меняющиеся counts следует получать из Git,
а не поддерживать вручную в классификации ниже.

## Классификация полного дерева

| Категория | Пути и назначение |
| --- | --- |
| Current public product documentation | `README.md`, `docs/README.md`, `docs/user/*`, `docs/assets/readme/*`, `docs/release-current.json`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md` |
| Current maintainer/developer documentation | `docs/development/*`, `docs/maintainers/DOCUMENTATION_MAP.md`, `AGENTS.md`, `.agents/skills/*`, MV3 nested `AGENTS.md`, tooling-root и legacy-options pointer README, asset attribution README |
| Legacy upstream documentation | `docs/legacy/*`, включая исторический README, compatibility pointer для его исходной относительной ссылки, store description, MV2 reviewer/options notes, старые architecture/migration audits и beta RC snapshot |
| Runtime source | Текущий MV3 runtime/tests, common/full/mini compatibility inputs и `src/templates-data.js` |
| Build and verification tooling | Extension `package.json`/lockfile, `gulpfile.js`, ESLint/Git attributes, tools, `grep.sh`, `scripts/verify-docs.mjs`, workflow и tooling `.gitignore` |
| Required legal/license material | Корневой `LICENSE` (GPL-3.0); дополнительные vendor license копируются из установленной pinned зависимости при сборке |
| Obsolete or unreferenced candidate | Корневой `package.json` удалён как obsolete donation tooling после отдельного решения сопровождающего |
| Uncertain/supporting repository content | `.gitignore`, `.rgignore`, `.vscode/settings.json` и пять исходных SVG assets |
| Generated output | `build/`, `dist/`, `coverage/`, `.tmp/`, profiles и logs игнорируются и не tracked |
| Internal/local reports | Локальные отчёты находятся в ignored `.local/project-reports/` |

Файлы в `src/extension-common`, `src/extension-full` и `src/extension-mini`
классифицированы как runtime/build compatibility source, а не как текущая
публичная документация. Упоминания MV2/Firefox/MINI внутри них описывают
наследуемое поведение и не являются заявлением о текущей поставке.

## Канонические публичные документы

| Тема | Единственный основной документ |
| --- | --- |
| Продукт и краткий старт | [`README.md`](../../README.md) |
| Последний опубликованный release | [`docs/release-current.json`](../release-current.json) |
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
- `scripts/verify-docs.mjs` — dependency-free structural/metadata gate; network
  audit доступен отдельно и не делает обычный CI зависимым от внешних сайтов.
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

## Классификация upstream links

Все ссылки на upstream после текущего аудита относятся к одной из разрешённых
категорий:

1. `README.md` ссылается на
   `anticensority/runet-censorship-bypass` только как на происхождение и
   attribution.
2. `docs/legacy/**` сохраняет исходные repository/wiki/store/community links
   как историю; архивные headers прямо запрещают использовать их как текущую
   установку или support claim.
3. `src/extension-chromium-mv3/background/pac-providers.js` и
   `src/templates-data.js` намеренно используют опубликованные upstream PAC
   resources. Ссылки в `src/extension-common/**` принадлежат сохранённой legacy
   compatibility surface и upstream resource/attribution UI.

Старых upstream release links в текущих installation docs нет. Это правило
проверяет `scripts/verify-docs.mjs`; изменение runtime upstream resources требует
отдельной продуктовой/security проверки и не является задачей documentation
refresh.

## Локальные и generated материалы

`.local/project-reports/` хранит локальные рабочие отчёты и целиком игнорируется
Git. `.tmp/` содержит QA profiles, screenshots и release checks;
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
| Корневой `package.json` | Remove (completed) | Не использовался CI/build/test/release; удаление устраняет obsolete lifecycle, риск случайной root-установки, путаницу для contributors и неоднозначную ISC metadata внутри GPL-репозитория. Атрибуция и sponsor history сохранены отдельно. |
| `grep.sh` | Requires maintainer decision; keep | Нереференсный POSIX helper; не влияет на runtime, но может быть удобен не-Windows сопровождающим. |
| Пять SVG в tooling `assets/` | Requires maintainer decision; keep | Прямых ссылок не найдено, но это source artwork с attribution/history; безопасное удаление требует решения о сохранении исходников. |
| `.vscode/settings.json`, `.rgignore` | Keep in place | Активно исключают generated/vendor noise и соответствуют рабочему процессу. |
| `extension-common/full/mini` и Ace vendor | Keep in place | Нужны legacy compatibility build, общим assets и проверяемому vendor provenance. |
| MV3 placeholder pages | Remove (completed) | Четыре недоступные из manifest/UI страницы показывали только migration-era текст через отдельный `getPageStatus` RPC; страницы, shared placeholder assets и RPC удалены вместе. |
| Локальные project reports | Keep local/ignored | Внутренние планы/reviews не являются публичной документацией и не входят в package. |

В documentation refresh из tooling удалялся только `.github/FUNDING.yml`.
Корневой donation package позже удалён отдельным maintenance-изменением;
остальные неопределённые кандидаты сохранены согласно правилу недеструктивного
аудита.

## Удалённый корневой package.json

Удалённый файл объявлял пакет `subjective-good-is-evil`, лицензию ISC, единственный
`postinstall` через `opencollective` и ссылку на upstream collective. Поиск всего
дерева не нашёл использования в GitHub Actions, Gulp, тестах, сборке, упаковке
или выпуске. У него не было корневого lockfile; поддерживаемого корневого
npm-пакета теперь нет, а все команды направляются в extension tooling package.

Файл удалён из-за obsolete lifecycle, риска случайной root-установки, путаницы
для contributors и неоднозначной ISC package metadata внутри GPL-3.0
репозитория. Корневой `LICENSE`, upstream-атрибуция и исторические сведения о
спонсорах сохранены независимо в текущем README и legacy-документации.
