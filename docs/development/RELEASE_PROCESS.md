# Процесс выпуска Chromium MV3

Публичный продуктовый артефакт — ZIP готовой MV3-сборки. Выпуск не должен
создаваться, пока точный commit, CI, локальные проверки, браузерная QA и
известные ограничения не зафиксированы.

## 1. Подготовить кандидата

- Работайте в узкой release branch от актуального `main`.
- Проверьте, что версия согласована между `src/templates-data.js`, manifest
  template и собранным `manifest.json`.
- Рабочее дерево кандидата должно быть понятным и не содержать локальных
  reports, profiles, build/dist или секретов.
- Установите pinned зависимости через extension-only `npm ci` на Node 22.

Если менялись общие templates/gulp/legacy-shared inputs, отдельно подтвердите
совместимость наследуемой сборки до финального MV3 build. Это проверка
совместимости, а не публикация MV2 как текущего продукта; финальная MV3-сборка
должна выполняться последней, потому что старые build targets очищают `build/`.

## 2. Выполнить проверки

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm ci --prefix $Project
npm --prefix $Project run test:pac
npm --prefix $Project run test:mv3
npm --prefix $Project run lint:mv3
npm --prefix $Project run build:mv3
git diff --check
```

GitHub Actions для exact commit должен завершиться успешно. Локальный
`build:mv3` уже включает runtime-icon и package-integrity verification.

## 3. Проверить артефакт

Пакуется содержимое каталога
`extensions/chromium/runet-censorship-bypass/build/extension-chromium-mv3`, а не
сам каталог. После распаковки `manifest.json` обязан находиться в корне ZIP.

Проверьте:

- версию и `manifest_version: 3`;
- точный список и хэши runtime-файлов;
- отсутствие docs, screenshots, tests, source maps, archives, profiles, logs,
  `.env`, `.local`, `.tmp`, credentials и приватных URL;
- загрузку exact ZIP после распаковки в чистом профиле;
- совпадение проверенного ZIP с тем, который будет опубликован.

Пример упаковки из tooling root:

```powershell
$Package = '.\build\extension-chromium-mv3'
$Archive = '.\dist\runet-censorship-bypass-mv3-<version>-<short-sha>.zip'
New-Item -ItemType Directory -Force .\dist | Out-Null
Compress-Archive -Path "$Package\*" -DestinationPath $Archive
Get-FileHash $Archive -Algorithm SHA256
```

Не перезаписывайте уже опубликованный архив тем же именем. Сохраните checksum в
отдельном текстовом asset и повторно сверьте скачанный draft asset до публикации.

## 4. Браузерная QA

Запишите браузер и точную версию. Минимально проверьте Brave; статус stable
Chrome укажите честно. Обязательные сценарии перечислены в
[TESTING.md](TESTING.md#браузерная-qa). Для аутентифицируемого прокси используйте
только разрешённый тестовый аккаунт и никогда не записывайте пароль.

## 5. Prerelease или stable

- **Prerelease** используйте для ограниченной beta, неполного browser matrix или
  значимых известных границ. Текущий пример: `v0.0.2.0-beta1`.
- **Stable** допустим только после согласованного browser/support scope,
  закрытия release blockers и достаточной реальной QA. Не снимайте prerelease
  только из-за успешных unit tests.

Теги имеют форму `v<version-name>`; beta suffix включается в tag, например
`v0.0.2.0-beta2`. Tag должен указывать на точно проверенный commit.

## 6. Release notes

Укажите:

- статус выпуска и целевую аудиторию;
- highlights без неподтверждённых обещаний;
- проверенные браузеры/версии и CI;
- manual installation и отсутствие store auto-update;
- SHA-256 и имена assets;
- security/routing impact;
- известные ограничения, включая `mandatory: false`, proxy-auth coverage и
  ownership timing boundary;
- безопасный канал обратной связи.

Перед публикацией ещё раз скачайте assets, проверьте хэши, корень ZIP и
отсутствие секретов. Commit, tag, upload и GitHub Release — отдельные внешние
действия и требуют явного разрешения сопровождающего.
