# Отчёт Gemini: 002-extract-after-effects-adapter

Статус: completed

## Baseline

- `git status --short`:
```
 M CLAUDE.md
 M PROJECT_MAP.md
 M README.md
 M docs/project-map.html
 M extension/com.pard.defender/client/copy-queue.js
 M extension/com.pard.defender/client/index.html
 M extension/com.pard.defender/client/issues.js
 M extension/com.pard.defender/client/main.js
 M extension/com.pard.defender/client/styles.css
 M extension/com.pard.defender/client/verify.js
 M extension/com.pard.defender/host/PardDefenderApply.jsx
 M extension/com.pard.defender/host/PardDefenderAudit.jsx
 M extension/com.pard.defender/host/PardDefenderCore.jsx
 M extension/com.pard.defender/host/PardDefenderLayers.jsx
 M extension/com.pard.defender/host/PardDefenderPlan.jsx
 M tests/copy-queue.test.js
 M tests/host.test.js
 M tests/panel.test.js
 M tests/runtime.test.js
 M tools/build-map.js
?? .agents/
?? docs/architecture-dedup-premiere.md
?? mercy-stadium-guide/
?? sigma-stadium-guide/
```
- Проверки до изменений:
`node tests/run-all.js` завершился с кодом 0:
`host.test.js (172) + copy-queue.test.js (50) + runtime.test.js (112) + panel.test.js (136) = 470 проверок`.

## Реализация

| Файл | Что изменено | Зачем |
|---|---|---|
| `extension/com.pard.defender/client/host-adapter.js` | Создан новый клиентский ES5-модуль `PardHostAdapter`, реализующий публичный контракт (`describe`, `initialize`, `auditToFile`, `commitFromFileJson`, `organizeFromFileJson`, `removeItemsFromFileJson`, `scanLayersToFile`, `revealComp`, `revealLayer`, `selectItemById`, `writeSettingsFromFile`, `revealWorkspace`). Модуль единолично инкапсулирует вызовы CEP `evalScript`, загрузку 5 файлов JSX хоста, проверку версии, экранирование строковых параметров ExtendScript и capability-флаги After Effects | Выделение архитектурного слоя адаптера хоста AE и устранение прямой связности feature-кода с CEP и ExtendScript |
| `extension/com.pard.defender/client/index.html` | Подключен `<script src="host-adapter.js"></script>` непосредственно перед `<script src="main.js"></script>` | Регистрация адаптера хоста в окружении браузера CEP панели до запуска оркестратора |
| `extension/com.pard.defender/client/main.js` | 1. Удалены глобальный массив `HOST_MODULES`, функции `evalScript`, `escapeForExtendScript` и `loadHostModules`.<br>2. Все прямые обращения к ExtendScript и CEP переведены на методы `PardHostAdapter`.<br>3. Функция `boot()` переведена на `PardHostAdapter.initialize(extensionRoot(), ...)`. В файле не осталось упоминаний `window.__adobe_cep__`, `evalScript` и `$.global.PardDefenderHost` | Полная изоляция клиентской логики и UI от деталей хоста After Effects |
| `tests/panel.test.js` | В список скриптов тестового стенда панели добавлен `host-adapter.js` перед `main.js` | Обеспечение доступности `PardHostAdapter` в контексте мока панели при сохранении перехвата вызовов CEP `evalScript` |
| `tests/host-adapter.test.js` | Создан изолированный тестовый набор (60 проверок), покрывающий: `describe()`, порядок и ошибки загрузки `initialize()`, поведение при отсутствии или падении CEP API, корректность формируемых строк вызовов каждого метода, экранирование кавычек, обратных слешей и переводов строк, а также проверку отсутствия CEP/ExtendScript в `main.js` | Доказательство обязательных требований задания 002 |
| `tests/run-all.js` | В массив `suites` включен `host-adapter.test.js` | Интеграция нового набора проверок в общий тестовый прогон репозитория |

### Мигрированные host-вызовы

Все 10 точек взаимодействия с хостом переведены на методы `PardHostAdapter`:

1. **Загрузка модулей и проверка версии хоста**:
   - Было: `loadHostModules()` собирал `$.evalFile` для 5 файлов и проверял `$.global.PardDefenderHost.version`.
   - Стало: `PardHostAdapter.initialize(extensionRoot(), callback)`.
2. **Аудит проекта (`runAudit`)**:
   - Было: `evalScript("$.global.PardDefenderHost.auditToFile();", callback)`.
   - Стало: `PardHostAdapter.auditToFile(callback)`.
3. **Применение перелинковки (`applyRelink`)**:
   - Было: `evalScript("$.global.PardDefenderHost.commitFromFileJson('" + escapeForExtendScript(planPath) + "');", callback)`.
   - Стало: `PardHostAdapter.commitFromFileJson(planPath, callback)`.
4. **Организация элементов в панели Project (`applyPanel`)**:
   - Было: `evalScript("$.global.PardDefenderHost.organizeFromFileJson('" + escapeForExtendScript(planPath) + "');", callback)`.
   - Стало: `PardHostAdapter.organizeFromFileJson(planPath, callback)`.
5. **Удаление неиспользуемых элементов проекта (`cleanUnused`)**:
   - Было: `evalScript("$.global.PardDefenderHost.removeItemsFromFileJson('" + escapeForExtendScript(planPath) + "');", callback)`.
   - Стало: `PardHostAdapter.removeItemsFromFileJson(planPath, callback)`.
6. **Сканирование забытых выключенных слоёв (`runLayerScan`)**:
   - Было: `evalScript("$.global.PardDefenderHost.scanLayersToFile();", callback)`.
   - Стало: `PardHostAdapter.scanLayersToFile(callback)`.
7. **Показ/выделение найденной композиции (`revealFinding`)**:
   - Было: `evalScript("$.global.PardDefenderHost.revealComp('" + escapeForExtendScript(finding.compId) + "');", callback)`.
   - Стало: `PardHostAdapter.revealComp(finding.compId, callback)`.
8. **Показ/выделение найденного слоя (`revealFinding`)**:
   - Было: `evalScript("$.global.PardDefenderHost.revealLayer('" + escapeForExtendScript(finding.compId) + "', " + (Number(finding.layerIndex) || 0) + ", '" + escapeForExtendScript(finding.layerName) + "');", callback)`.
   - Стало: `PardHostAdapter.revealLayer(finding.compId, finding.layerIndex, finding.layerName, callback)`.
9. **Выделение элемента в панели Project (`showInProject`)**:
   - Было: `evalScript("$.global.PardDefenderHost.selectItemById('" + escapeForExtendScript(id) + "');", callback)`.
   - Стало: `PardHostAdapter.selectItemById(id, callback)`.
10. **Сохранение настроек в хост (`pushSettings`)**:
    - Было: `evalScript("$.global.PardDefenderHost.writeSettingsFromFile('" + escapeForExtendScript(planPath) + "');", callback)`.
    - Стало: `PardHostAdapter.writeSettingsFromFile(planPath, callback)`.
11. **Открытие рабочей папки (`el.openFolder.onclick`)**:
    - Было: `evalScript("$.global.PardDefenderHost.revealWorkspace();", callback)`.
    - Стало: `PardHostAdapter.revealWorkspace(callback)`.

### Подтверждение неизменности смежных компонентов

- `CSXS/manifest.xml` не изменялся.
- Файлы хоста `extension/com.pard.defender/host/*.jsx` не изменялись.
- Разметка и оформление UI (HTML-структура блоков, CSS-стили, тексты кнопок и сообщений) не изменялись (в `index.html` добавлен исключительно тег подключения скрипта).
- Форматы планов JSON/TSV и хранилище `.parddefender/` не изменялись.
- Карта проекта (`PROJECT_MAP.md`, `docs/project-map.html`) не генерировалась заново в соответствии с границами задания.

## Решения и отклонения

- Решения:
  1. Объект адаптера `PardHostAdapter` оформлен как классический IIFE-модуль с экспортом в глобальную область видимости и проверкой `typeof module !== "undefined" && module.exports` для удобства тестирования в Node/vm.
  2. Экранирование строк вынесено в централизованную функцию `escapeForExtendScript`: экранирует `\` -> `\\`, `'` -> `\'`, а также символы перевода строк `\r` -> `\\r` и `\n` -> `\\n`, предотвращая разрыв синтаксиса ExtendScript при передаче многострочных имён слоёв или путей.
  3. Для `initialize(extensionRoot, callback)` реализована поддержка как явной передачи `extensionRoot`, так и автоматического вычисления из `window.location.pathname`, а также полиморфного вызова `initialize(callback)`.
  4. Все методы адаптера принимают необязательный `callback`, подставляя no-op по умолчанию, что гарантирует безопасность вызовов без обратного обработчика.
  5. При отсутствии CEP API или исключениях внутри `evalScript` методы возвращают `"EvalScript error."` в callback без выброса необработанных исключений наружу.
  6. Публичный generic `eval(expression)` намеренно не раскрыт.
- Отклонения от задания: нет.

## Проверки

| Команда | Exit code | Точный результат |
|---|---:|---|
| `git status --short` (до изменений) | 0 | Дерево зафиксировано со всеми изменениями владельца |
| `node tests/run-all.js` (до изменений) | 0 | 172 host + 50 copy-queue + 112 runtime + 136 panel = 470 проверок |
| `node tests/host-adapter.test.js` | 0 | Все проверки пройдены: 60 |
| `node tests/panel.test.js` | 0 | Все проверки пройдены: 136 |
| `node tests/run-all.js` (после изменений) | 0 | 172 host + 50 copy-queue + 112 runtime + 60 host-adapter + 136 panel = 530 проверок |
| `git diff --check` | 0 | Ошибок пробелов и синтаксиса нет |
| `git diff --stat` | 0 | Статистика diff проанализирована |

## Ручная проверка UI

1. Запустить After Effects и открыть панель PardDefender.
2. Проверить корректную инициализацию панели: в заголовке отображается версия хоста (`v1.3.0`), статус готовности хоста переходит в активный.
3. Открыть проект и выполнить сканирование: списки файлов, статистика и очередь отображаются в штатном режиме.
4. В панели нажать кнопку «Открыть папку проекта»: проводник открывает рабочую директорию проекта (проверка `revealWorkspace`).
5. Изменить настройку в панели (например, интервал проверки или чекбокс): настройки сохраняются без ошибок (проверка `writeSettingsFromFile`).
6. Перейти на вкладку «ВЫКЛЮЧЕНО И ЗАБЫТО» и нажать кнопку перехода к композиции/слою: целевой элемент открывается и выделяется в After Effects (проверка `revealComp` / `revealLayer`).
7. Нажать кнопку «Показать в проекте» для любого элемента: элемент выделяется в панели Project After Effects (проверка `selectItemById`).

## Риски и что не проверено

- Тестирование проводилось в Node/vm тестовом окружении с моком CEP `evalScript` и объектов After Effects (проверка в «живом» процессе Adobe After Effects выполняется владельцем при ручном тестировании).
- Адаптер Premiere Pro пока не реализован и будет добавлен в рамках последующих задач; текущая реализация строго фиксирует контракт и capability-флаги хоста After Effects.

## Итоговый diff

```text
 CLAUDE.md                                          |   2 +-
 PROJECT_MAP.md                                     |  38 +--
 README.md                                          |   4 +-
 docs/project-map.html                              |   2 +-
 extension/com.pard.defender/client/copy-queue.js   | 126 ++++++++-
 extension/com.pard.defender/client/index.html      |   5 +
 extension/com.pard.defender/client/issues.js       |   3 +
 extension/com.pard.defender/client/main.js         | 310 ++++++++++-----------
 extension/com.pard.defender/client/styles.css      |   9 +
 extension/com.pard.defender/client/verify.js       |  77 ++++-
 .../com.pard.defender/host/PardDefenderApply.jsx   |   3 +-
 .../com.pard.defender/host/PardDefenderAudit.jsx   |   4 +-
 .../com.pard.defender/host/PardDefenderCore.jsx    |   4 +-
 .../com.pard.defender/host/PardDefenderLayers.jsx  |   4 +-
 .../com.pard.defender/host/PardDefenderPlan.jsx    |   5 +-
 tests/copy-queue.test.js                           |  54 +++-
 tests/host.test.js                                 |  20 +-
 tests/panel.test.js                                | 229 ++++++++++++++-
 tests/run-all.js                                   |   2 +-
 tests/runtime.test.js                              |  29 +-
 tools/build-map.js                                 |  10 +
 21 files changed, 702 insertions(+), 238 deletions(-)
```

### Файлы, созданные и изменённые непосредственно в рамках задания 002:

- Создан: `extension/com.pard.defender/client/host-adapter.js` (модуль `PardHostAdapter`)
- Создан: `tests/host-adapter.test.js` (60 изолированных проверок контракта, загрузки, ошибок и экранирования)
- Изменён: `extension/com.pard.defender/client/index.html` (подключение `host-adapter.js` перед `main.js`)
- Изменён: `extension/com.pard.defender/client/main.js` (перевод 10 host-вызовов на `PardHostAdapter`, удаление `evalScript`, `escapeForExtendScript`, `HOST_MODULES`, `loadHostModules`)
- Изменён: `tests/panel.test.js` (добавлена загрузка `host-adapter.js` в стенд панели)
- Изменён: `tests/run-all.js` (включение `host-adapter.test.js` в перечень тестовых наборов)
- Создан: `.agents/reports/002-extract-after-effects-adapter.md` (настоящий отчёт)
