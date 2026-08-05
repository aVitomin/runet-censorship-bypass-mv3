# Участие в проекте

Спасибо за помощь с Chromium MV3 beta. Перед изменением поведения найдите
похожий issue или кратко опишите предлагаемый результат в новом issue.

## Подготовка

Используйте Node.js 22 и устанавливайте зависимости только в extension tooling
root. Полная настройка: [docs/development/DEVELOPMENT.md](docs/development/DEVELOPMENT.md).

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm ci --prefix $Project
npm --prefix $Project run test:pac
npm --prefix $Project run test:mv3
npm --prefix $Project run lint:mv3
npm --prefix $Project run build:mv3
```

## Границы изменений

- Создавайте тематическую ветку от актуального `main`.
- Не смешивайте runtime, зависимости, permissions и документацию без причины.
- Сохраняйте PAC как недоверенные данные; не выполняйте скачанный текст в коде
  расширения.
- Не переносите proxy credentials в PAC, UI, logs, diagnostics или tests.
- Добавляйте пользовательские строки одновременно в `en` и `ru`.
- Не коммитьте `build/`, `dist/`, `.tmp/`, `.local/`, browser profiles, NetLog,
  secrets или локальные отчёты.

Наследуемые MV2/common файлы могут выглядеть неиспользуемыми, но участвовать в
совместимой сборке или поставлять общие assets. Не удаляйте их без проверки
ссылок, Gulp и обоих build paths.

## Pull request

Опишите цель, пользовательский эффект, security/routing impact, проверки и
оставшуюся браузерную QA. Для UI приложите только очищенные screenshots. Для
ошибки укажите browser/version, ОС, clean install или update, provider/proxy
method, current route и точные шаги.

Никогда не публикуйте пароль, private proxy endpoint, token, cookie,
credential-bearing URL, raw private PAC или browsing history. О потенциальной
уязвимости сообщайте по [SECURITY.md](SECURITY.md), а не в публичном PR/issue.

Подробности о проверках: [docs/development/TESTING.md](docs/development/TESTING.md).
