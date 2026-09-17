# Задача 007: фундамент отдельного Premiere Pro UXP-плагина

Статус: ready

Зависит от: задача 003 и принятый `docs/premiere-uxp-decision.md`.

## Архитектурная граница

Создать отдельный plugin tree `premiere/com.pard.defender.uxp/`. Не добавлять
`PPRO` в существующий CEP manifest, не использовать ExtendScript, CEP,
`evalScript`, QE DOM или undocumented APIs. Минимальная версия Premiere Pro —
25.6, UXP manifestVersion 5.

Использовать официальные API:

- `require("premierepro")` и `Project.getActiveProject()`;
- `Project.guid`, `Project.path`, `Project.getRootItem()`;
- официальные FolderItem/ProjectItem/ClipProjectItem методы;
- `ClipProjectItem.getMediaFilePath()`, `getProxyPath()`, `hasProxy()`;
- UXP `require("fs")`, `path`, `require("uxp").storage`;
- manifest permission, достаточный для автоматической работы рядом с открытым
  project path. Если выбран `fullAccess`, явно объяснить его в UI/README и не
  использовать доступ за пределами resolved workspace.

## Первая версия плагина

- Тёмная компактная panel UI визуально родственна AE-панели, но код UI не
  копируется вслепую из CEP.
- Показывает host/version, активный project, resolved workspace и статус.
- Реализует UXP adapter с `describe`, `identifyProject`, `auditMedia`,
  `commitRelinks`, `revealItem` и capability flags.
- Рекурсивный read-only audit перечисляет media project items, stable item id,
  main media path, proxy path/flag, bin path, online/offline и достаточный тип,
  чтобы отличить sequence/generated/merged/multicam/unsupported.
- Публикует нормализованный audit JSON, совместимый по обязательным полям с AE
  application layer, но допускающий `hostDetails`.
- Подключается к workspace/project registry v1 по `Project.guid`; при Save As
  сохраняется тот же projectId и обновляется path.
- Никаких копий, relink и удаления в этой задаче.

## Tooling

Добавить минимальные package/build/dev-load инструкции без установки глобальных
инструментов и без запуска скачанного ПО. Предпочесть обычный JavaScript или
локально уже доступный toolchain; не вводить тяжёлый framework ради одной
панели. Исходники должны тестироваться Node-моками без Premiere.

## Тесты

Добавить Premiere mock DOM и тесты: no active project, saved/unsaved project,
GUID identity, recursive bins, atomic media, proxy, offline, generated media,
merged/multicam/sequence classification, capability flags, normalized report,
отсутствие строк QE/CEP/evalScript. Включить эти suite в общий runner.

Создать `premiere/README.md` с dev-load инструкцией и явным minimum 25.6. Полный
test suite должен оставаться зелёным. Отчёт:
`.agents/reports/007-premiere-uxp-foundation.md`.

