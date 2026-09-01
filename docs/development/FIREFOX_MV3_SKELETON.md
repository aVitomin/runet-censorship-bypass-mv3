# Инертный каркас Firefox MV3

В репозитории есть отдельная экспериментальная production-source граница
`src/extension-firefox-mv3`. Она пока **не является поддерживаемым Firefox-
продуктом** и не входит в публичные инструкции установки или выпуска.

Текущий пакет намеренно остаётся в состоянии `OFF`. Он содержит только Firefox
MV3 manifest, непостоянную background event page, минимальное долговременное
состояние `OFF` и read-only capability RPC. В нём нет proxy/WebRequest-
разрешений, host permissions, маршрутизации, provider dataset, updater,
аутентификации или сетевых обращений. Команда активации всегда отвечает
`ACTIVATION_NOT_IMPLEMENTED`.

Для каркаса используется development-only Gecko ID
`firefox-mv3-skeleton@runet-censorship-bypass.invalid`. Production Gecko/AMO ID
и возможная связь с legacy-идентичностями пока не определены; этот ID нельзя
использовать для выпуска или миграции.

Детерминированные проверки запускаются из корня репозитория:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm --prefix $Project run test:firefox
npm --prefix $Project run lint:firefox
npm --prefix $Project run build:firefox
```

Сборка содержит только `manifest.json` и два background-скрипта в
`build/extension-firefox-mv3`. Она не меняет Chromium build output. Отдельный
локальный smoke с установленным Firefox 154.0.1 и одноразовым профилем можно
запустить командой:

```powershell
npm --prefix $Project run test:browser:firefox-skeleton
```

Smoke проверяет реальное уничтожение и пересоздание event page после idle,
сохранение `OFF` и отсутствие изменений заранее настроенного localhost proxy.
Он не является обязательным сетевым CI-шагом. Маршрутизация и пользовательский
Firefox-интерфейс должны появляться только в последующих отдельно проверяемых
изменениях.
