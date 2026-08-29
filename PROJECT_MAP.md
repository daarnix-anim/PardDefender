# Карта проекта PardDefender

<!-- СГЕНЕРИРОВАНО tools/build-map.js — правки будут затёрты.
     Чтобы изменить описание файла, отредактируйте блок @map в его шапке. -->

Файлов: **29** · связей: **57** · собрано: 2026-08-29 10:04

Визуальная карта: [`docs/project-map.html`](docs/project-map.html) — откройте в браузере, узлы кликабельны.

## Хост (ExtendScript в After Effects)

### `PardDefenderApply.jsx`

`extension/com.pard.defender/host/PardDefenderApply.jsx` · 560 строк · работает

Две мутирующие операции: перелинковка на проверенную копию с сохранением интерпретации и раскладка панели проекта.

Используется в: `main.js`, `mock-ae.js`

### `PardDefenderAudit.jsx`

`extension/com.pard.defender/host/PardDefenderAudit.jsx` · 644 строк · работает

Один проход по проекту → один JSON-отчёт: где что лежит, куда должно попасть на диске и в панели. Решений о времени не принимает.

Используется в: `main.js`, `mock-ae.js`

### `PardDefenderCore.jsx`

`extension/com.pard.defender/host/PardDefenderCore.jsx` · 384 строк · работает

Основа хоста: свой JSON для ES3, чтение и запись файлов, работа с путями, санитация имён папок и классификация форматов по расширению.

Используется в: `main.js`, `mock-ae.js`

### `PardDefenderLayers.jsx`

`extension/com.pard.defender/host/PardDefenderLayers.jsx` · 369 строк · работает

Ищет выключенные и забытые слои в композициях и композиции, которые никуда не входят и не помечены. Отсекает всё, что выключено по делу.

Используется в: `main.js`, `mock-ae.js`

### `PardDefenderPlan.jsx`

`extension/com.pard.defender/host/PardDefenderPlan.jsx` · 570 строк · работает

Рабочая папка, настройки проекта и дерево композиций: какая композиция рендерная и к какой ветке относится элемент.

Используется в: `main.js`, `mock-ae.js`

## Клиент (CEP + Node)

### `copy-queue.js`

`extension/com.pard.defender/client/copy-queue.js` · 620 строк · работает

Проверенное копирование: потоковая запись в .pdpart, сверка размера, дедуп по SHA-256, откат и коды ошибок. Оригинал не трогается никогда.

Используется в: `index.html`, `issues.js`, `main.js`, `stats.js`, `updater.js`, `verify.js`, `copy-queue.test.js`, `runtime.test.js`

### `disk-space.js`

`extension/com.pard.defender/client/disk-space.js` · 156 строк · работает

Свободное место на диске проекта: fs.statfs → fsutil → df. wmic не используется.

Используется в: `index.html`, `main.js`

### `housekeeping.js`

`extension/com.pard.defender/client/housekeeping.js` · 367 строк · работает

Вес проекта на диске, удаление в Корзину и открытие файла в проводнике.

Используется в: `index.html`, `main.js`, `runtime.test.js`, `CLAUDE.md`

### `issues.js`

`extension/com.pard.defender/client/issues.js` · 300 строк · работает

Хранилище проблем: четыре класса ошибок, расписание повторов, предохранитель. Одна строка на элемент, а не на попытку.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `runtime.test.js`

### `main.js`

`extension/com.pard.defender/client/main.js` · 2564 строк · работает

Оркестратор панели: владеет таймерами, решает когда действовать, собирает планы для хоста и рисует интерфейс.

Использует: `disk-space.js`, `copy-queue.js`, `issues.js`, `stats.js`, `housekeeping.js`, `verify.js`, `updater.js`, `PardDefenderAudit.jsx`, `PardDefenderApply.jsx`, `PardDefenderLayers.jsx`, `PardDefenderCore.jsx`, `PardDefenderPlan.jsx`

Используется в: `index.html`

### `stats.js`

`extension/com.pard.defender/client/stats.js` · 137 строк · работает

Накопительные счётчики по проекту и дельта за текущую сессию.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `runtime.test.js`

### `updater.js`

`extension/com.pard.defender/client/updater.js` · 338 строк · работает

Проверка обновлений: сначала публичный фид, потом GitHub Releases. Белый список хостов, токен внутрь не зашивается.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `runtime.test.js`

### `verify.js`

`extension/com.pard.defender/client/verify.js` · 151 строк · работает

Скользящая сверка защищённых файлов с манифестом — по 64 за проход. Она же отвечает, какие файлы положило туда само расширение.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `runtime.test.js`

## Интерфейс панели

### `index.html`

`extension/com.pard.defender/client/index.html` · 172 строк · работает

Разметка панели: шапка, вкладки и панели внутри них — главное, неиспользуемые, старый проект, журнал, настройки. Порядок script-тегов задаёт загрузку модулей.  @map status: ready  @map layer: ui -->

Использует: `disk-space.js`, `copy-queue.js`, `issues.js`, `stats.js`, `verify.js`, `housekeeping.js`, `updater.js`, `main.js`, `styles.css`

### `styles.css`

`extension/com.pard.defender/client/styles.css` · 736 строк · работает

Оформление панели под тёмный интерфейс After Effects.  @map status: ready  @map layer: ui */

Используется в: `index.html`

## Конфигурация расширения

### `manifest.xml`

`extension/com.pard.defender/CSXS/manifest.xml` · 47 строк · работает

Манифест CEP: версия, поддерживаемые версии AE, включение Node и геометрия панели.  @map status: ready  @map layer: config -->

## Тесты

### `copy-queue.test.js`

`tests/copy-queue.test.js` · 313 строк · работает

42 проверки копирования на настоящих файлах во временной папке.

Использует: `copy-queue.js`

Используется в: `run-all.js`

### `host.test.js`

`tests/host.test.js` · 937 строк · работает

167 проверок хоста: рабочая папка, ветки, маршруты, секвенции, границы раскладки.

Использует: `mock-ae.js`

Используется в: `run-all.js`

### `mock-ae.js`

`tests/mock-ae.js` · 352 строк · работает

Мок объектной модели After Effects: настоящие .jsx загружаются через vm.

Использует: `PardDefenderCore.jsx`, `PardDefenderPlan.jsx`, `PardDefenderAudit.jsx`, `PardDefenderApply.jsx`, `PardDefenderLayers.jsx`

Используется в: `host.test.js`

### `run-all.js`

`tests/run-all.js` · 38 строк · работает

Прогоняет все наборы и выдаёт один вердикт.

Использует: `host.test.js`, `copy-queue.test.js`, `runtime.test.js`

### `runtime.test.js`

`tests/runtime.test.js` · 530 строк · работает

107 проверок клиентских модулей: ошибки, метрики, сверка, обновления.

Использует: `issues.js`, `stats.js`, `verify.js`, `updater.js`, `copy-queue.js`, `housekeeping.js`

Используется в: `run-all.js`

## Инструменты

### `build-map.js`

`tools/build-map.js` · 492 строк · работает

Строит карту проекта из самого кода — граф связей выводится из исходников, а не ведётся руками

### `map-template.html`

`tools/map-template.html` · 478 строк · работает

Шаблон визуальной карты: граф с панорамированием, зумом, поиском и подробностями по клику.  @map status: ready  @map layer: tools -->

### `repair-1.0.0-junk.js`

`tools/repair-1.0.0-junk.js` · 178 строк · работает

Разовая починка проектов после 1.0.0: копии без расширения — в Корзину, манифест чистится. По умолчанию — пробный прогон.

## Установка

### `INSTALL_DEV_WINDOWS.bat`

`INSTALL_DEV_WINDOWS.bat` · 63 строк · работает

Ставит расширение в %APPDATA%/Adobe/CEP/extensions и включает PlayerDebugMode.

### `UNINSTALL_DEV_WINDOWS.bat`

`UNINSTALL_DEV_WINDOWS.bat` · 26 строк · работает

Снимает расширение. Проекты и файлы не трогаются.

## Документация

### `CLAUDE.md`

`CLAUDE.md` · 278 строк · работает

Точка входа для любого агента и нового чата: правила, архитектура, команды.  @map status: ready  @map layer: docs -->

Использует: `housekeeping.js`

### `PROJECT_MAP.md`

`PROJECT_MAP.md` · 260 строк · работает

_Описание не задано._

### `README.md`

`README.md` · 907 строк · работает

Полное описание продукта: поведение, структура папок, безопасность, метрики, ошибки, автообновление.  @map status: ready  @map layer: docs -->

