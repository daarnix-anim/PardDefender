# Карта проекта PardDefender

<!-- СГЕНЕРИРОВАНО tools/build-map.js — правки будут затёрты.
     Чтобы изменить описание файла, отредактируйте блок @map в его шапке. -->

Файлов: **56** · связей: **144** · собрано: 2026-09-18 01:32

Визуальная карта: [`docs/project-map.html`](docs/project-map.html) — откройте в браузере, узлы кликабельны.

## Хост (ExtendScript в After Effects)

### `PardDefenderApply.jsx`

`extension/com.pard.defender/host/PardDefenderApply.jsx` · 559 строк · работает

Две мутирующие операции: перелинковка на проверенную копию с сохранением интерпретации и раскладка панели проекта.

Используется в: `host-adapter.js`, `host-adapter.test.js`, `mock-ae.js`

### `PardDefenderAudit.jsx`

`extension/com.pard.defender/host/PardDefenderAudit.jsx` · 642 строк · работает

Один проход по проекту → один JSON-отчёт: где что лежит, куда должно попасть на диске и в панели. Решений о времени не принимает.

Используется в: `host-adapter.js`, `host-adapter.test.js`, `mock-ae.js`

### `PardDefenderCore.jsx`

`extension/com.pard.defender/host/PardDefenderCore.jsx` · 382 строк · работает

Основа хоста: свой JSON для ES3, чтение и запись файлов, работа с путями, санитация имён папок и классификация форматов по расширению.

Используется в: `host-adapter.js`, `mock-ae.js`

### `PardDefenderLayers.jsx`

`extension/com.pard.defender/host/PardDefenderLayers.jsx` · 367 строк · работает

Ищет выключенные и забытые слои в композициях и композиции, которые никуда не входят и не помечены. Отсекает всё, что выключено по делу.

Используется в: `host-adapter.js`, `host-adapter.test.js`, `mock-ae.js`

### `PardDefenderPlan.jsx`

`extension/com.pard.defender/host/PardDefenderPlan.jsx` · 569 строк · работает

Рабочая папка, настройки проекта и дерево композиций: какая композиция рендерная и к какой ветке относится элемент.

Используется в: `host-adapter.js`, `host-adapter.test.js`, `mock-ae.js`

## Хост (UXP в Premiere Pro)

### `adapter.js`

`premiere/com.pard.defender.uxp/adapter.js` · 507 строк · работает

Официальный UXP-адаптер для Premiere Pro 25.6+: инспекция проектов, рекурсивный аудит media items, классификация клипов/секвенций/proxy/generated, подключение к реестру проектов и нормализованный отчёт аудита.

Используется в: `index.html`, `main.js`, `e2e-hardening.test.js`, `premiere-adapter.test.js`, `premiere-protection.test.js`

### `copy-engine.js`

`premiere/com.pard.defender.uxp/copy-engine.js` · 622 строк · работает

Асинхронное поблочное копирование через UXP fs с инкрементальным SHA-256, временными файлами .pdpart, journal-before-copy в pending.tsv, фиксацией provenance в assets.tsv и безопасной перелинковкой клипов Premiere.

Используется в: `index.html`, `main.js`, `e2e-hardening.test.js`, `premiere-protection.test.js`

### `duplicates.js`

`premiere/com.pard.defender.uxp/duplicates.js` · 290 строк · работает

Обнаружение точных дубликатов и транзакционная консолидация для Premiere Pro: побайтовое SHA-256 хеширование, выбор каноникала, копирование внешнего каноникала в assets.tsv, перелинковка через changeMediaFilePath, двухкликовое подтверждение и строгое отсутствие удалений файлов.

Используется в: `index.html`, `main.js`, `e2e-hardening.test.js`, `premiere-protection.test.js`

### `icon-23.png`

`premiere/com.pard.defender.uxp/icons/icon-23.png` · 3 строк · работает

_Описание не задано._

### `main.js`

`premiere/com.pard.defender.uxp/main.js` · 560 строк · работает

UI-контроллер панели Premiere Pro UXP: вкладки «ЗАЩИТА», «ДУБЛИКАТЫ» и «ЖУРНАЛ», копирование внешних медиа в workspace с перелинковкой, поиск дубликатов, двухкликовое объединение файлов и журнал операций.

Использует: `adapter.js`, `copy-engine.js`, `duplicates.js`

Используется в: `index.html`, `host-adapter.test.js`, `panel.test.js`

### `sync-coordinator.js`

`premiere/com.pard.defender.uxp/sync-coordinator.js` · 464 строк · работает

Синхронизация After Effects и Premiere Pro в общей рабочей зоне: публикация media snapshots, журнал intents в events.jsonl, отложенная перелинковка для закрытых проектов и crash-safe compaction.

Использует: `workspace-store.js`

Используется в: `index.html`, `sync-coordinator.js`, `e2e-hardening.test.js`, `sync-coordinator.test.js`

## Клиент (CEP + Node)

### `consolidation.js`

`extension/com.pard.defender/client/consolidation.js` · 604 строк · работает

Безопасное объединение точных дубликатов: транзакционная машина состояний, re-verification, внешний copy каноникала, relink через хост и crash recovery.

Использует: `workspace-store.js`, `duplicate-index.js`, `copy-queue.js`, `host-adapter.js`

Используется в: `index.html`, `main.js`, `consolidation.test.js`, `e2e-hardening.test.js`

### `copy-queue.js`

`extension/com.pard.defender/client/copy-queue.js` · 724 строк · работает

Проверенное копирование: потоковая запись в .pdpart, сверка размера, дедуп по SHA-256, откат и коды ошибок. Оригинал не трогается никогда.

Используется в: `consolidation.js`, `index.html`, `issues.js`, `main.js`, `stats.js`, `updater.js`, `verify.js`, `consolidation.test.js`, `copy-queue.test.js`, `e2e-hardening.test.js`, `panel.test.js`, `runtime.test.js`

### `disk-space.js`

`extension/com.pard.defender/client/disk-space.js` · 156 строк · работает

Свободное место на диске проекта: fs.statfs → fsutil → df. wmic не используется.

Используется в: `index.html`, `main.js`, `panel.test.js`

### `duplicate-index.js`

`extension/com.pard.defender/client/duplicate-index.js` · 596 строк · работает

Движок поиска точных дубликатов: группировка по размерам, потоковый SHA-256, hash-cache и секвенции.

Используется в: `consolidation.js`, `index.html`, `main.js`, `consolidation.test.js`, `duplicate-index.test.js`, `e2e-hardening.test.js`, `panel.test.js`

### `host-adapter.js`

`extension/com.pard.defender/client/host-adapter.js` · 206 строк · работает

Адаптер хоста After Effects: вызовы CEP evalScript, загрузка JSX и изоляция ExtendScript.

Использует: `PardDefenderAudit.jsx`, `PardDefenderApply.jsx`, `PardDefenderLayers.jsx`, `PardDefenderCore.jsx`, `PardDefenderPlan.jsx`

Используется в: `consolidation.js`, `index.html`, `main.js`, `host-adapter.test.js`, `panel.test.js`

### `housekeeping.js`

`extension/com.pard.defender/client/housekeeping.js` · 367 строк · работает

Вес проекта на диске, удаление в Корзину и открытие файла в проводнике.

Используется в: `index.html`, `main.js`, `panel.test.js`, `runtime.test.js`

### `issues.js`

`extension/com.pard.defender/client/issues.js` · 303 строк · работает

Хранилище проблем: четыре класса ошибок, расписание повторов, предохранитель. Одна строка на элемент, а не на попытку.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `panel.test.js`, `runtime.test.js`

### `main.js`

`extension/com.pard.defender/client/main.js` · 3099 строк · работает

Оркестратор панели: владеет таймерами, решает когда действовать, собирает планы для хоста и рисует интерфейс.

Использует: `disk-space.js`, `host-adapter.js`, `copy-queue.js`, `issues.js`, `verify.js`, `stats.js`, `housekeeping.js`, `workspace-store.js`, `duplicate-index.js`, `consolidation.js`, `updater.js`

### `stats.js`

`extension/com.pard.defender/client/stats.js` · 137 строк · работает

Накопительные счётчики по проекту и дельта за текущую сессию.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `panel.test.js`, `runtime.test.js`

### `sync-coordinator.js`

`extension/com.pard.defender/client/sync-coordinator.js` · 464 строк · работает

Синхронизация After Effects и Premiere Pro в общей рабочей зоне: публикация media snapshots, журнал intents в events.jsonl, отложенная перелинковка для закрытых проектов и crash-safe compaction.

Использует: `sync-coordinator.js`, `workspace-store.js`

### `updater.js`

`extension/com.pard.defender/client/updater.js` · 338 строк · работает

Проверка обновлений: сначала публичный фид, потом GitHub Releases. Белый список хостов, токен внутрь не зашивается.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `panel.test.js`, `runtime.test.js`

### `verify.js`

`extension/com.pard.defender/client/verify.js` · 204 строк · работает

Скользящая сверка защищённых файлов с манифестом — по 64 за проход. Она же отвечает, какие файлы положило туда само расширение.

Использует: `copy-queue.js`

Используется в: `index.html`, `main.js`, `panel.test.js`, `runtime.test.js`

### `workspace-store.js`

`extension/com.pard.defender/client/workspace-store.js` · 523 строк · работает

Общий слой метаданных рабочей зоны: идентификация проектов, блокировки и журнал событий.

Используется в: `consolidation.js`, `index.html`, `main.js`, `sync-coordinator.js`, `consolidation.test.js`, `e2e-hardening.test.js`, `panel.test.js`, `sync-coordinator.test.js`, `workspace-store.test.js`

## Интерфейс панели

### `index.html`

`extension/com.pard.defender/client/index.html` · 219 строк · работает

Разметка панели: шапка, вкладки и панели внутри них — главное, неиспользуемые, старый проект, журнал, настройки. Порядок script-тегов задаёт загрузку модулей.  @map status: ready  @map layer: ui -->

Использует: `disk-space.js`, `copy-queue.js`, `issues.js`, `stats.js`, `verify.js`, `housekeeping.js`, `updater.js`, `host-adapter.js`, `workspace-store.js`, `duplicate-index.js`, `consolidation.js`, `sync-coordinator.js`, `main.js`, `styles.css`

### `index.html`

`premiere/com.pard.defender.uxp/index.html` · 110 строк · работает

Разметка UXP-панели для Premiere Pro: вкладки Защита, Дубликаты и Журнал.

Использует: `copy-engine.js`, `duplicates.js`, `adapter.js`, `sync-coordinator.js`, `main.js`, `styles.css`

### `styles.css`

`extension/com.pard.defender/client/styles.css` · 1020 строк · работает

Оформление панели под тёмный интерфейс After Effects.  @map status: ready  @map layer: ui */

### `styles.css`

`premiere/com.pard.defender.uxp/styles.css` · 524 строк · работает

Стили темы UXP-панели для Premiere Pro в едином тёмном визуальном стиле PardDefender.

Используется в: `index.html`

## Конфигурация расширения

### `manifest.json`

`premiere/com.pard.defender.uxp/manifest.json` · 44 строк · работает

_Описание не задано._

### `manifest.xml`

`extension/com.pard.defender/CSXS/manifest.xml` · 47 строк · работает

Манифест CEP: версия, поддерживаемые версии AE, включение Node и геометрия панели.  @map status: ready  @map layer: config -->

## Тесты

### `consolidation.test.js`

`tests/consolidation.test.js` · 512 строк · работает

25 проверок безопасного объединения дубликатов в After Effects.

Использует: `consolidation.js`, `duplicate-index.js`, `copy-queue.js`, `workspace-store.js`

Используется в: `run-all.js`

### `copy-queue.test.js`

`tests/copy-queue.test.js` · 363 строк · работает

50 проверок копирования на настоящих файлах во временной папке.

Использует: `copy-queue.js`

Используется в: `run-all.js`

### `duplicate-index.test.js`

`tests/duplicate-index.test.js` · 450 строк · работает

45 проверок движка точных дубликатов: группировка, хэширование, секвенции, кэш.

Использует: `duplicate-index.js`

Используется в: `run-all.js`

### `e2e-hardening.test.js`

`tests/e2e-hardening.test.js` · 461 строк · работает

40 интеграционных end-to-end проверок надёжности (hardening), синхронизации и безопасности релиза 2.0.1.

Использует: `workspace-store.js`, `sync-coordinator.js`, `consolidation.js`, `copy-queue.js`, `duplicate-index.js`, `copy-engine.js`, `duplicates.js`, `adapter.js`, `mock-premiere.js`

Используется в: `run-all.js`

### `host-adapter.test.js`

`tests/host-adapter.test.js` · 364 строк · работает

Проверки клиентского адаптера After Effects: вызовы, экранирование, ошибки CEP.

Использует: `host-adapter.js`, `PardDefenderAudit.jsx`, `PardDefenderApply.jsx`, `PardDefenderLayers.jsx`, `PardDefenderPlan.jsx`, `main.js`

Используется в: `run-all.js`

### `host.test.js`

`tests/host.test.js` · 955 строк · работает

172 проверки хоста: рабочая папка, ветки, маршруты, секвенции, границы раскладки.

Использует: `mock-ae.js`

Используется в: `run-all.js`

### `mock-ae.js`

`tests/mock-ae.js` · 352 строк · работает

Мок объектной модели After Effects: настоящие .jsx загружаются через vm.

Использует: `PardDefenderCore.jsx`, `PardDefenderPlan.jsx`, `PardDefenderAudit.jsx`, `PardDefenderApply.jsx`, `PardDefenderLayers.jsx`

Используется в: `host.test.js`

### `mock-dom.js`

`tests/mock-dom.js` · 285 строк · работает

Крошечный DOM, чтобы панель можно было запустить без браузера: разметка читается из настоящего index.html.

Используется в: `panel.test.js`

### `mock-premiere.js`

`tests/mock-premiere.js` · 131 строк · работает

Мок официального UXP DOM Premiere Pro 25.6+ для автономных тестов без Premiere.

Используется в: `e2e-hardening.test.js`, `premiere-adapter.test.js`, `premiere-protection.test.js`

### `panel.test.js`

`tests/panel.test.js` · 1365 строк · работает

Проверки самой панели: вкладки, кнопки, места блоков и дисциплина перерисовки. Первый набор, который запускает main.js.

Использует: `disk-space.js`, `housekeeping.js`, `updater.js`, `copy-queue.js`, `duplicate-index.js`, `issues.js`, `stats.js`, `verify.js`, `host-adapter.js`, `workspace-store.js`, `main.js`, `mock-dom.js`

Используется в: `run-all.js`

### `premiere-adapter.test.js`

`tests/premiere-adapter.test.js` · 269 строк · работает

30 проверок фундамента Premiere Pro UXP адаптера.

Использует: `adapter.js`, `mock-premiere.js`

Используется в: `run-all.js`

### `premiere-protection.test.js`

`tests/premiere-protection.test.js` · 262 строк · работает

35 проверок защиты файлов, поблочного копирования, хеширования и консолидации в Premiere UXP.

Использует: `copy-engine.js`, `duplicates.js`, `adapter.js`, `mock-premiere.js`

Используется в: `run-all.js`

### `run-all.js`

`tests/run-all.js` · 42 строк · работает

Прогоняет все наборы и выдаёт один вердикт.

Использует: `host.test.js`, `copy-queue.test.js`, `runtime.test.js`, `host-adapter.test.js`, `workspace-store.test.js`, `duplicate-index.test.js`, `consolidation.test.js`, `premiere-adapter.test.js`, `premiere-protection.test.js`, `sync-coordinator.test.js`, `panel.test.js`, `e2e-hardening.test.js`

### `runtime.test.js`

`tests/runtime.test.js` · 557 строк · работает

112 проверок клиентских модулей: ошибки, метрики, сверка, обновления.

Использует: `issues.js`, `stats.js`, `verify.js`, `updater.js`, `copy-queue.js`, `housekeeping.js`

Используется в: `run-all.js`

### `sync-coordinator.test.js`

`tests/sync-coordinator.test.js` · 343 строк · работает

35 проверок межхостовой синхронизации перелинковки в общей рабочей зоне.

Использует: `workspace-store.js`, `sync-coordinator.js`

Используется в: `run-all.js`

### `workspace-store.test.js`

`tests/workspace-store.test.js` · 282 строк · работает

40 проверок реестра рабочей зоны: идентификация, блокировки, журнал событий.

Использует: `workspace-store.js`

Используется в: `run-all.js`

## Инструменты

### `build-map.js`

`tools/build-map.js` · 509 строк · работает

Строит карту проекта из самого кода — граф связей выводится из исходников, а не ведётся руками

### `map-template.html`

`tools/map-template.html` · 478 строк · работает

Шаблон визуальной карты: граф с панорамированием, зумом, поиском и подробностями по клику.  @map status: ready  @map layer: tools -->

### `package-release.js`

`tools/package-release.js` · 67 строк · работает

Скрипт сборки release-архивов для GitHub (zip и ccx).

### `repair-1.0.0-junk.js`

`tools/repair-1.0.0-junk.js` · 178 строк · работает

Разовая починка проектов после 1.0.0: копии без расширения — в Корзину, манифест чистится. По умолчанию — пробный прогон.

### `validate-uxp.js`

`tools/validate-uxp.js` · 93 строк · работает

Валидация структуры, манифеста и чистоты кода Premiere Pro UXP расширения перед релизом.

## Установка

### `INSTALL_DEV_WINDOWS.bat`

`INSTALL_DEV_WINDOWS.bat` · 130 строк · работает

Ставит расширения PardDefender в After Effects (CEP) и Premiere Pro (UXP), включает PlayerDebugMode.

### `UNINSTALL_DEV_WINDOWS.bat`

`UNINSTALL_DEV_WINDOWS.bat` · 26 строк · работает

Снимает расширение. Проекты и файлы не трогаются.

## Документация

### `CLAUDE.md`

`CLAUDE.md` · 296 строк · работает

Точка входа для любого агента и нового чата: правила, архитектура, команды.  @map status: ready  @map layer: docs -->

### `PROJECT_MAP.md`

`PROJECT_MAP.md` · 490 строк · работает

_Описание не задано._

### `README.md`

`README.md` · 1023 строк · работает

Полное описание продукта: поведение, структура папок, безопасность, метрики, ошибки, автообновление.  @map status: ready  @map layer: docs -->

