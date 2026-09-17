# Задача 002: выделить клиентский адаптер After Effects

Статус: ready

## Зачем

Сейчас `client/main.js` напрямую собирает ExtendScript-строки, вызывает
`window.__adobe_cep__.evalScript` и знает имя `PardDefenderHost`. Это связывает
весь application/UI слой только с After Effects и не позволяет безопасно
подключить Premiere Pro.

Нужно выделить совместимый адаптер текущего AE-хоста, не меняя поведение,
интерфейс или формат данных. Это архитектурный шов для будущих задач; Premiere
в этой задаче не реализуется.

Baseline после принятой задачи 001: `node tests/run-all.js` проходит — 172 host
+ 50 copy-queue + 112 runtime + 136 panel, всего 470 проверок. Рабочее дерево
содержит более ранние изменения владельца: сохранить их полностью.

## Результат

Добавлен модуль `extension/com.pard.defender/client/host-adapter.js`, который
единолично знает:

- как вызвать CEP `evalScript`;
- какие AE JSX-модули загрузить и в каком порядке;
- имя глобального объекта `$.global.PardDefenderHost`;
- как безопасно экранировать строковые аргументы ExtendScript;
- какие возможности поддерживает текущий After Effects adapter.

После миграции `main.js` не должен содержать прямых вызовов
`window.__adobe_cep__.evalScript`, строк `$.global.PardDefenderHost` или ручной
сборки host expressions.

## Публичный ES5-контракт

Модуль экспортирует глобальный объект `PardHostAdapter`. Имена можно уточнить,
если есть веская причина, но контракт должен покрывать:

- `describe()` -> `{ id: "after-effects", appCode: "AEFT", capabilities: {...} }`;
- `initialize(extensionRoot, callback)` -> загружает существующие JSX-файлы,
  проверяет API/version и возвращает тот же успешный version или понятную ошибку,
  которую сейчас получает `boot()`;
- `auditToFile(callback)`;
- `commitFromFileJson(planPath, callback)`;
- `organizeFromFileJson(planPath, callback)`;
- `removeItemsFromFileJson(planPath, callback)`;
- `scanLayersToFile(callback)`;
- `revealComp(compId, callback)`;
- `revealLayer(compId, layerIndex, layerName, callback)`;
- `selectItemById(itemId, callback)`;
- `writeSettingsFromFile(path, callback)`;
- `revealWorkspace(callback)`.

Все методы на этом этапе могут возвращать существующие raw-ответы: парсинг и
пользовательские сообщения остаются в `main.js`. Адаптер отвечает за транспорт,
выбор host expression и quoting. Не раскрывай публичный generic `eval(expression)`
для feature-кода: иначе прямые зависимости быстро вернутся.

Минимальные capability-флаги:

- `auditMedia`
- `commitRelinks`
- `organizePanel`
- `removeUnusedProjectItems`
- `scanForgottenLayers`
- `revealItems`
- `proxies`

Для AE все они `true`. UI пока не обязан использовать capabilities; важно
зафиксировать контракт и протестировать его форму.

## Реализация

1. Подключи `host-adapter.js` в `index.html` непосредственно перед `main.js`.
2. Перенеси из `main.js` низкоуровневый `evalScript`, host-module bootstrap,
   проверку `PardDefenderHost.version` и ExtendScript escaping, если после
   миграции они больше нигде не нужны.
3. Переведи все перечисленные host-вызовы `main.js` на методы адаптера.
4. Сохрани порядок, асинхронность, raw-ответы, тексты ошибок и текущее поведение
   boot/audit/relink/organize/settings/reveal/layer scan.
5. Обнови panel harness: он должен загружать новый модуль перед `main.js` и
   продолжать перехватывать фактические CEP-вызовы.

## Жёсткие границы

- Не добавлять `PPRO` в manifest и не писать Premiere ExtendScript.
- Не менять JSX host-файлы, форматы планов/ответов или `.parddefender` metadata.
- Не менять UI, тексты, версию, updater и generated project map.
- Не добавлять зависимости, Promise/async или синтаксис новее текущего ES5.
- Не делать общий класс/DI-фреймворк: один небольшой модуль и явные методы.
- Не редактировать архитектурный документ и этот файл задания.

Ожидаемые файлы задачи:

- новый `extension/com.pard.defender/client/host-adapter.js`;
- `extension/com.pard.defender/client/index.html`;
- `extension/com.pard.defender/client/main.js`;
- `tests/panel.test.js`;
- при необходимости новый изолированный `tests/host-adapter.test.js` и его
  подключение в `tests/run-all.js`.

## Обязательные тесты

Докажи как минимум:

1. `describe()` возвращает AE id, `AEFT` и полный набор capability-флагов;
2. `initialize()` грузит существующие JSX-модули в прежнем порядке и возвращает
   version;
3. отсутствие CEP API даёт прежнюю понятную ошибку, а не исключение;
4. каждый публичный метод строит корректный AE-вызов и вызывает callback;
5. кавычки, backslash и переводы строк в аргументах экранируются централизованно;
6. в `main.js` после миграции нет `window.__adobe_cep__.evalScript` и
   `$.global.PardDefenderHost`;
7. существующие 136 panel-проверок остаются зелёными без изменения смысла.

Запусти целевые тесты, затем `node tests/run-all.js` и `git diff --check`.
Создай `.agents/reports/002-extract-after-effects-adapter.md` по шаблону. В
отчёте отдельно перечисли все мигрированные host-вызовы и подтверди, что ни
manifest, ни JSX, ни UI не менялись.

