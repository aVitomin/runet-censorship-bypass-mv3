# Политика безопасности

## Поддерживаемая область

Безопасностные исправления этого форка ориентированы на последний опубликованный
Chromium MV3 prerelease и текущий `main`. Исторические MV2/Firefox/store пакеты
upstream не являются поддерживаемым выпуском этого репозитория.

## Как сообщить

Для уязвимости используйте
**[GitHub private vulnerability reporting](https://github.com/aVitomin/runet-censorship-bypass-mv3/security/advisories/new)**.
Не создавайте публичный issue с описанием уязвимости.

В приватном отчёте укажите затронутую версию, краткое описание влияния,
предварительные условия воспроизведения и очищенное доказательство. Не
публикуйте и не прикладывайте без необходимости реальные exploit details,
пароли, private proxy data или PAC contents, tokens, cookies и browsing
history.

Если приватная форма GitHub временно недоступна, используйте обычную
[форму bug report](https://github.com/aVitomin/runet-censorship-bypass-mv3/issues/new?template=bug_report.yml)
только для публичного запроса на безопасный канал связи. Пометьте заголовок как
`[Security contact]`, а в обязательных публичных полях укажите лишь
`contact-only`, когда раскрытие ответа нежелательно. Такой запрос не должен
содержать технических деталей уязвимости или секретов: сопровождающие сначала
установят приватный канал и лишь затем запросят подробности.

Обычные ошибки без security-sensitive деталей следует отправлять через
[форму bug report](https://github.com/aVitomin/runet-censorship-bypass-mv3/issues/new?template=bug_report.yml).

## Область особого внимания

Особенно важны сообщения о:

- выполнении скачанного PAC в контексте расширения;
- обходе проверки URL/redirect или ограничений PAC body;
- утечке proxy credentials через PAC, RPC, UI, logs или diagnostics;
- неожиданном перехвате Chromium proxy ownership;
- повреждении/подмене durable state или IndexedDB artifacts;
- обходе ограничений proxy-auth challenge.

Поведение Chromium при `mandatory: false`, ошибка внешнего proxy или известная
граница между проверкой владельца и нативным `settings.set` сами по себе не
являются новым нарушением, но воспроизводимое ухудшение этих границ важно.

Публичные исправления и credit согласуются после устранения риска раскрытия.
Общие сведения: [docs/user/PRIVACY_AND_SECURITY.md](docs/user/PRIVACY_AND_SECURITY.md).
