# Процесс выпуска Chromium MV3

Публичный продуктовый артефакт — ZIP готовой MV3-сборки. Выпуск допустим только
из точного validated commit актуального чистого `main`, после успешного
trusted-main CI и проверки того же артефакта, который будет опубликован.

> Release останавливается, если в обязательном CI отсутствует любой release
> gate, даже когда отдельные тесты зелёные. Нельзя заменять отсутствующий
> aggregate `verify`, docs integrity или artifact-integrity gate набором похожих
> локальных результатов.

## 1. Подготовить чистый main

1. Обновите `main` через fast-forward и убедитесь, что рабочее дерево чистое.
2. Запишите полный SHA кандидата и проверьте, что version согласована между
   `src/templates-data.js`, manifest template и собранным `manifest.json`.
3. Установите pinned зависимости только в extension tooling package на Node 22.
4. Убедитесь, что reports, profiles, build/dist, archives, `.local`, `.tmp` и
   секреты не tracked и не staged.

Если менялись shared templates, Gulp или legacy-shared inputs, отдельно
подтвердите совместимость наследуемой сборки. Это не делает MV2 текущим
продуктом. MV2 build выполняется до финальной MV3 build, потому что старые цели
очищают общий `build/`.

## 2. Выполнить локальные gates

Из корня репозитория:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
node .\scripts\verify-docs.mjs
node .\scripts\verify-supply-chain.mjs
node --test .\scripts\verify-supply-chain.test.mjs
npm ci --prefix $Project
npm audit signatures --prefix $Project
npm --prefix $Project run test:pac
npm --prefix $Project run test:mv3
npm --prefix $Project run lint:mv3
npm --prefix $Project run build:mv3
npm --prefix $Project run verify
git diff --check
```

`build:mv3` включает package-integrity и runtime-icon verification. Aggregate
`verify` включает полный test suite, MV3 lint, совместимую MV2 build и финальную
MV3 build. После всех команд tracked tree должен остаться чистым.

## 3. Подтвердить trusted-main CI

Для exact main SHA workflow **Verify MV3** должен завершиться успешно как
trusted push в `main`. Если GitHub не создал ожидаемый push run, не переписывайте
и не дополняйте `main`: вручную запустите тот же workflow на `main`. Такой run
допустим только при `event = workflow_dispatch`, `ref = refs/heads/main`,
`head_sha = origin/main`, полном успехе обычного job и наличии canonical
artifact этого run. Dispatch другой ветки не является trusted source и не
загружает canonical artifact. Проверьте не только общий зелёный статус, но
наличие и успех обязательных gates:

- documentation integrity;
- static supply-chain policy, focused verifier tests и registry signatures;
- PAC и MV3 tests;
- focused MV3 lint и build;
- aggregate `verify`;
- runtime icons и package integrity внутри build;
- exact-output и tracked-worktree checks;
- trusted-main-only artifact upload.

Если обязательного шага нет, release блокирован до исправления workflow и
нового успешного trusted-main run. Артефакт PR не является trusted release
source: upload на pull request намеренно пропускается.

## 4. Скачать и проверить trusted artifact

Скачайте unpacked MV3 artifact именно из успешного trusted-main run exact SHA.
Не пересобирайте release независимо от CI. Проверьте:

- имя run/artifact и полный commit SHA;
- `manifest_version: 3`, version и `manifest.json` в корне;
- точный список и SHA-256 всех runtime-файлов;
- runtime icons и package-integrity;
- отсутствие docs, screenshots, tests, source maps, archives, profiles, logs,
  `.env`, `.local`, `.tmp`, credentials и приватных URL.

Если выпуск требует browser QA, загрузите именно распакованный trusted artifact
в чистый профиль. Запишите browser и точную версию. Минимально проверьте Brave;
статус stable Chrome укажите честно. Сценарии перечислены в
[TESTING.md](TESTING.md#браузерная-qa). Для authenticated proxy используйте
только разрешённый тестовый аккаунт и не записывайте пароль.

## 5. Создать ZIP из проверенного artifact

Пакуется содержимое trusted artifact directory, а не сам каталог. После
распаковки `manifest.json` должен находиться в корне ZIP. Не допускается ни
одного runtime-byte отличия от проверенного artifact.

Пример упаковки:

```powershell
$Package = '.\trusted-artifact'
$Archive = '.\dist\runet-censorship-bypass-mv3-<version>-<short-sha>.zip'
New-Item -ItemType Directory -Force .\dist | Out-Null
Compress-Archive -Path "$Package\*" -DestinationPath $Archive
Get-FileHash $Archive -Algorithm SHA256
```

Создайте отдельный checksum asset с точным именем ZIP. Не перезаписывайте уже
опубликованный asset тем же именем.

## 6. Проверить tag и prerelease scope

- Tag имеет форму `v<version-name>` и должен указывать на exact validated main
  SHA, а не просто на текущее имя ветки.
- **Prerelease** обязателен для ограниченной beta, неполного browser matrix или
  значимых известных границ.
- **Stable** допустим только после согласованного support scope, закрытых release
  blockers и достаточной real-browser QA; unit tests сами по себе недостаточны.

Перед публикацией проверьте target tag, prerelease flag, release-page path,
имена и размеры assets и SHA-256.

## 7. Опубликовать и повторно скачать assets

Release notes должны указывать статус, целевую аудиторию, подтверждённые
highlights, browser QA, CI, manual installation, отсутствие store auto-update,
имена assets, SHA-256, security/routing impact, известные ограничения и
безопасный канал обратной связи.

После upload, но до объявления выпуска окончательно:

1. скачайте опубликованные ZIP и checksum asset заново;
2. проверьте размер, SHA-256, checksum content и корень ZIP;
3. сравните распакованные runtime-файлы с trusted artifact;
4. подтвердите tag target и prerelease status через GitHub metadata;
5. убедитесь, что публичные assets не содержат секретов или repository-only
   файлов.

Любое несовпадение блокирует выпуск; опубликованный архив нельзя молча заменить
другим содержимым под тем же именем.

## 8. Обновить current-release документацию

README описывает последний **опубликованный** release, а не произвольную версию
на `main`. После публикации:

1. обновите `docs/release-current.json` точными публичными metadata;
2. обновите README current-release block, status, browser QA и installation;
3. проверьте release, ZIP и checksum links и опубликованный SHA-256;
4. убедитесь, что прежний release нигде не назван текущим;
5. выполните `node .\scripts\verify-docs.mjs` и дождитесь нового успешного CI.

Обычный unreleased tooling commit не требует изменения публичной версии README.
Commit, tag, upload и GitHub Release — отдельные внешние действия и выполняются
только с явным разрешением сопровождающего.
