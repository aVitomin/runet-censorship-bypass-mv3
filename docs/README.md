# Документация Runet Censorship Bypass

Здесь собраны инструкции для пользователей, справочные материалы и техническая
документация текущего продукта для Chromium. Для начала достаточно
[установить стабильный выпуск](user/INSTALLATION.md), пройти
[первую настройку](user/USER_GUIDE.md#1-первая-настройка) и использовать popup
для выбора маршрута сайта.

Интерфейс доверенной ветки `main` может быть новее интерфейса последнего
опубликованного ZIP `v0.0.2.3`. Страница выпуска и контрольная сумма всегда
относятся к опубликованному файлу; актуальные руководства описывают направление
текущего продукта и отдельно отмечают заметные различия.

## Пользователям

- [Установка, обновление и удаление](user/INSTALLATION.md) — стабильный ZIP,
  проверка SHA-256, Load unpacked и ручные обновления.
- [Руководство пользователя](user/USER_GUIDE.md) — первая настройка, popup,
  Auto / Proxy / Direct и все разделы Options.
- [Решение проблем](user/TROUBLESHOOTING.md) — проблема → причина → безопасное
  действие.
- [Приватность и безопасность](user/PRIVACY_AND_SECURITY.md) — разрешения,
  локальные данные, сетевые обращения и границы защиты.

## Расширенные возможности и обслуживание

- [Automatic routing и Site rules](user/USER_GUIDE.md#3-automatic-routing)
- [Proxy connections](user/USER_GUIDE.md#5-proxy-connections)
- [Maintenance](user/USER_GUIDE.md#6-maintenance)
- [Advanced](user/USER_GUIDE.md#7-advanced)
- [Диагностика распространённых проблем](user/TROUBLESHOOTING.md)
- [Модель приватности и безопасности](user/PRIVACY_AND_SECURITY.md)

## Участникам и разработчикам

- [Подготовка среды и разработка](development/DEVELOPMENT.md)
- [Архитектура Manifest V3](development/ARCHITECTURE.md)
- [Тестирование и браузерная QA](development/TESTING.md)
- [Процесс выпуска](development/RELEASE_PROCESS.md)
- [Совместимость и миграция старых настроек](development/LEGACY_MIGRATION.md)
- [Правила участия](../CONTRIBUTING.md)
- [Политика безопасности](../SECURITY.md)

Точечные браузерные чек-листы находятся в
[`development/qa/`](development/qa/), а агентские инструкции — в
[`../.agents/`](../.agents/). Эти материалы описывают инженерный процесс, а не
обычную установку продукта.

## История

- [README исходного проекта](legacy/UPSTREAM_README.md)
- [Архив upstream-документации](legacy/)

Runet Censorship Bypass сохраняет историю, вклад авторов и GPL-3.0 атрибуцию
[`anticensority/runet-censorship-bypass`](https://github.com/anticensority/runet-censorship-bypass).
Материалы в `legacy/**` могут описывать MV2, Firefox, магазины и старые
upstream-процессы; они сохранены как история и не являются инструкцией по
установке текущего Chromium-продукта.
