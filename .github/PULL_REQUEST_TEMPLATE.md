## Что изменено

Кратко опишите цель и пользовательский результат.

## Проверки

- [ ] `test:pac` (если затронута маршрутизация)
- [ ] `test:mv3`
- [ ] `lint:mv3`
- [ ] `build:mv3` с package-integrity и runtime-icon verification
- [ ] `git diff --check`
- [ ] Нужная browser QA выполнена или явно перечислена как оставшаяся
- [ ] Пользовательская/разработческая документация обновлена или изменение не требует её обновления

## Риск и приватность

- [ ] Описано влияние на PAC/proxy/state/permissions/credentials или подтверждено его отсутствие
- [ ] Нет build/dist, profiles, logs, `.tmp`, `.local`, secrets или release artifacts
- [ ] Screenshots и logs очищены от passwords, private proxy endpoints, tokens, cookies, credential-bearing URLs, private PAC и browsing history
- [ ] Пользовательские строки обновлены в `en` и `ru`, если применимо

## Дополнительно

Связанный issue, tested browser/version и замечания для reviewer.
