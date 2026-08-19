# Runet Censorship Bypass

[![Verify MV3](https://github.com/aVitomin/runet-censorship-bypass-mv3/actions/workflows/mv3.yml/badge.svg?branch=main)](https://github.com/aVitomin/runet-censorship-bypass-mv3/actions/workflows/mv3.yml)
[![Prerelease](https://img.shields.io/github/v/release/aVitomin/runet-censorship-bypass-mv3?include_prereleases&label=prerelease)](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases)

Расширение для Chromium, которое выборочно направляет сайты через прокси по
PAC-правилам. Текущий продукт использует Manifest V3 и ориентирован прежде
всего на Brave.

> **Статус: ограниченная бета.** Текущий публичный выпуск —
> [`v0.0.2.0-beta2`](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/tag/v0.0.2.0-beta2).
> Он предназначен для ручной установки и тестирования, а не объявлен стабильным
> магазинным выпуском.

[Выпуски](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases) ·
[Проверки CI](https://github.com/aVitomin/runet-censorship-bypass-mv3/actions) ·
[Сообщить об ошибке](https://github.com/aVitomin/runet-censorship-bypass-mv3/issues) ·
[GPL-3.0](LICENSE)

## Текущий выпуск

- Версия: [`v0.0.2.0-beta2`](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/tag/v0.0.2.0-beta2)
- Архив (356 944 байта):
  [`runet-censorship-bypass-mv3-0.0.2.0-beta2-b6b5cd6.zip`](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/download/v0.0.2.0-beta2/runet-censorship-bypass-mv3-0.0.2.0-beta2-b6b5cd6.zip)
- SHA-256:
  `ad9462f19b02c64f2a2e2cff0363612bd7467f978608cd9dfe183b26899915ef`
- Опубликованный файл контрольной суммы:
  [`runet-censorship-bypass-mv3-0.0.2.0-beta2-b6b5cd6.sha256.txt`](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/download/v0.0.2.0-beta2/runet-censorship-bypass-mv3-0.0.2.0-beta2-b6b5cd6.sha256.txt)
- Установка: [пошаговая инструкция](docs/user/INSTALLATION.md)

<details>
<summary>English summary</summary>

Runet Censorship Bypass is a limited-beta Chromium Manifest V3 extension for
selective PAC-based routing. The latest public beta is `v0.0.2.0-beta2`. Its
exact archive was tested in Brave; stable Google Chrome was not available for
final validation. Other Chromium-compatible browsers are not independently
verified. Install the unpacked ZIP from this repository's release page.
Firefox is not part of the current MV3 release. See the
[installation guide](docs/user/INSTALLATION.md) and
[privacy and security notes](docs/user/PRIVACY_AND_SECURITY.md).

</details>

## Интерфейс

![Всплывающее окно в применённом состоянии: глобальное управление, режимы Auto, Proxy и Direct](docs/assets/readme/popup-applied.png)

![Раздел Overview семисекционной страницы настроек после успешного применения](docs/assets/readme/options-overview-applied.png)

![Раздел Proxy methods с безопасным редактированием учётных данных](docs/assets/readme/options-proxy-methods.png)

![Состояния значка панели инструментов: A, P, D, OFF, EXT, ожидание и предупреждение](docs/assets/readme/toolbar-states.png)

Снимки сделаны на реальном текущем интерфейсе в Brave. В них используются
только синтетические тестовые адреса и данные.

## Возможности

- Выборочная маршрутизация через PAC: обычный трафик не требуется отправлять
  через прокси целиком.
- Режимы **Auto**, **Proxy** и **Direct** для текущего сайта с выбором точного
  хоста или домена и поддоменов.
- Встроенные источники маршрутизации Antizapret и Anticensority, режим только
  собственных правил и доверенные пользовательские PAC-источники.
- Собственные HTTP/HTTPS/SOCKS-прокси, локальный Tor, Tor Browser и локальный
  прокси WARP.
- Правила сайтов с учётом границ публичных суффиксов.
- Состояние соединения и безопасная проверка доступности настроенного прокси.
- Редактирование прокси с паролем без повторного показа сохранённого пароля.
- Архитектура Manifest V3 с восстанавливаемым service worker.
- Русский и английский интерфейс.

## Поведение beta2

- После полного перезапуска Chromium/Brave ранее применённый PAC безопасно
  восстанавливается только при совпадении сохранённой конфигурации, происхождения
  и хэша артефакта. Последний **Clear / Turn off** остаётся главным решением, а
  настройка другого расширения или политики никогда не перезаписывается.
- Supervisor автоматически обновляет здоровье активного proxy после запуска и
  по истечении срока свежести. Ошибки прошлого browser session не считаются
  свежими, временные proxy failures получают ограниченные повторы, а Tor Browser
  может восстановиться автоматически, если запущен после браузера.
- Health-проверки не меняют Auto/Proxy/Direct, PAC-правила, provider или владельца
  proxy settings.

## Установка

1. Откройте [страницу `v0.0.2.0-beta2`](https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/tag/v0.0.2.0-beta2)
   и скачайте указанный выше ZIP-архив текущего выпуска.
2. При необходимости сверьте SHA-256 с приложенным файлом `*.sha256.txt`.
3. Полностью распакуйте архив в постоянную папку.
4. Откройте `brave://extensions` или `chrome://extensions`.
5. Включите **Режим разработчика / Developer mode**.
6. Нажмите **Загрузить распакованное расширение / Load unpacked**.
7. Выберите папку, в которой непосредственно лежит `manifest.json`.

Не выбирайте сам ZIP-файл или его родительскую папку. Ручная распакованная
установка не получает автоматические обновления из магазина. Подробности,
обновление и удаление: [инструкция по установке](docs/user/INSTALLATION.md).

## Быстрый старт

1. Выберите источник маршрутизации. Для собственных правил без внешнего списка
   доступен вариант **Only my site rules**.
2. При необходимости настройте Tor, WARP или собственный прокси в разделе
   **Proxy methods**.
3. Нажмите **Apply configuration**. Это единый защищённый процесс обновления,
   проверки, подготовки и применения правил.
4. Откройте popup на нужном сайте и выберите:
   - **Auto** — удалить исключение для сайта и следовать выбранному источнику;
   - **Proxy** — всегда использовать один из включённых методов прокси;
   - **Direct** — явно обходить прокси расширения.
5. Используйте **Turn off extension proxy**, чтобы вернуть Chromium к системным
   настройкам прокси, не удаляя сохранённые правила и кэш.

Глобальное состояние и правило текущего сайта независимы: **Turn off** отключает
управление прокси во всём браузере, а Auto/Proxy/Direct меняют только маршрут
выбранного сайта. Проверка здоровья показывает доступность маршрута, но не
доказывает успешную аутентификацию или отсутствие DNS-утечек.

Значки панели: `A` — Auto, `P` — Proxy, `D` — Direct, `OFF` — прокси расширения
выключен, `EXT` — настройками владеет другое расширение или политика, `…` —
операция выполняется, `!` — требуется внимание.

## Поддержка браузеров

| Браузер | Текущий статус |
| --- | --- |
| Brave | Точный архив beta2 прошёл restart, автоматическое восстановление Tor Browser на порту 9150, Clear/restart, popup и options smoke QA в Brave 1.93.134 / Chromium 151.0.7922.108. |
| Другие Chromium-совместимые браузеры | Ожидается совместимость с необходимыми MV3 API; требуется проверка конкретного браузера и версии. |
| Google Chrome Stable | Финальная beta2 не была отдельно проверена в стабильном Chrome; стабильная Chrome-валидация не заявляется. |
| Firefox | Не входит в текущий выпуск MV3. |

## Безопасность и приватность

- Пароли собственных прокси хранятся локально для ответа на proxy-auth запросы,
  не добавляются в сгенерированный PAC и маскируются в ответах popup/options.
- Адрес пользовательского PAC проверяется до загрузки и повторно после
  перенаправления. Загрузка ограничена тайм-аутом, размером и строгой
  проверкой UTF-8.
- Загруженный PAC обрабатывается как данные и передаётся Chromium; код
  расширения не выполняет его через `eval` или `Function`.
- Исходный код MV3 не содержит телеметрии или аналитики. Сетевые обращения
  нужны для PAC-источников и запускаемой пользователем проверки маршрута.
- Расширение проверяет владельца настройки прокси и не должно молча
  перезаписывать управление другого расширения или политики.

Известные границы beta2: PAC применяется с `mandatory: false`; реальный обмен
с внешним аутентифицируемым прокси покрыт не полностью; Chromium сохраняет
узкую нативную границу времени между последней проверкой владельца и применением
настройки; ручная установка требует ручных обновлений.

Подробнее: [приватность и безопасность](docs/user/PRIVACY_AND_SECURITY.md) и
[решение проблем](docs/user/TROUBLESHOOTING.md).

## Документация

- [Обзор документации](docs/README.md)
- [Установка и обновление](docs/user/INSTALLATION.md)
- [Руководство пользователя](docs/user/USER_GUIDE.md)
- [Решение проблем](docs/user/TROUBLESHOOTING.md)
- [Приватность и безопасность](docs/user/PRIVACY_AND_SECURITY.md)
- [Разработка](docs/development/DEVELOPMENT.md)
- [Архитектура](docs/development/ARCHITECTURE.md)
- [Тестирование](docs/development/TESTING.md)
- [Процесс выпуска](docs/development/RELEASE_PROCESS.md)
- [Legacy и история upstream](docs/legacy/UPSTREAM_README.md)
- [Участие в проекте](CONTRIBUTING.md)
- [Сообщение об уязвимости](SECURITY.md)

## Быстрый старт для разработки

Проверенная среда CI — Node.js 22. Поддерживаемого корневого npm-пакета нет:
все команды разработки явно направляйте в канонический пакет
`extensions/chromium/runet-censorship-bypass`. Устаревшие funding metadata и
lifecycle удалены; историческая атрибуция и сведения о спонсорах сохранены в
[upstream README](docs/legacy/UPSTREAM_README.md).

```powershell
node ./scripts/verify-docs.mjs
npm ci --prefix ./extensions/chromium/runet-censorship-bypass
npm --prefix ./extensions/chromium/runet-censorship-bypass run test:pac
npm --prefix ./extensions/chromium/runet-censorship-bypass run test:mv3
npm --prefix ./extensions/chromium/runet-censorship-bypass run lint:mv3
npm --prefix ./extensions/chromium/runet-censorship-bypass run build:mv3
```

Результат сборки:
`extensions/chromium/runet-censorship-bypass/build/extension-chromium-mv3`.

## Статус проекта и участие

Отзывы о бете приветствуются в
[Issues](https://github.com/aVitomin/runet-censorship-bypass-mv3/issues).
Укажите браузер и версию, ОС, чистую установку или обновление, источник/метод
прокси, текущий маршрут, шаги воспроизведения и очищенные от чувствительных
данных ошибки. Никогда не публикуйте пароли, приватные прокси, токены, cookies,
URL с учётными данными, приватный PAC или историю посещений.

Правила для изменений находятся в [CONTRIBUTING.md](CONTRIBUTING.md), политика
безопасности — в [SECURITY.md](SECURITY.md).

## Происхождение и лицензия

Проект основан на
[`anticensority/runet-censorship-bypass`](https://github.com/anticensority/runet-censorship-bypass).
Авторские права исходного проекта остаются у его авторов и участников;
миграция MV3 развивается в этом форке. Код распространяется по
[GNU GPL v3](LICENSE).

<details>
<summary>Historical upstream README and legacy instructions</summary>

The original README is preserved at
[docs/legacy/UPSTREAM_README.md](docs/legacy/UPSTREAM_README.md).

These instructions may describe old MV2, Firefox, store, or upstream release
workflows and are not the current installation guide.

</details>
