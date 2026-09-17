# Задача 003: идентичность рабочей зоны, проектов и журнал событий

Статус: ready

Зависит от: задача 002.

## Цель

Создать устойчивый общий слой метаданных, через который открытые проекты After
Effects и будущий Premiere UXP-плагин смогут узнавать одну рабочую зону,
регистрировать проекты и обмениваться идемпотентными событиями без перезаписи
закрытых Adobe-проектов.

## Persisted contract v1

В `<workspace>/.parddefender/` добавить:

- `workspace.json`: `schemaVersion`, `workspaceId`, нормализованный `root`,
  `createdAt`, `updatedAt`;
- `projects/<projectId>.json`: `schemaVersion`, `projectId`, `workspaceId`,
  `host` (`after-effects`/`premiere-pro`), `projectGuid` если хост его даёт,
  `path`, `normalizedPath`, `firstSeenAt`, `lastSeenAt`;
- `project-paths.json`: индекс normalized host+path -> projectId;
- `events.jsonl`: append-only события с `schemaVersion`, уникальным `eventId`,
  `workspaceId`, `projectId`, `host`, `type`, `createdAt`, `payload`;
- `locks/`: атомарные lock-directory для конкурентной записи.

JSON записывается через temporary sibling + atomic rename. JSONL reader обязан
терпеть пустые строки и оборванную последнюю строку, но сообщать о повреждении
любой более ранней строки. Lock имеет owner token и timestamp, ограниченное
ожидание и безопасное восстановление stale-lock; чужой свежий lock не удаляется.

## Project identity

- Для AE, где нет официального project GUID, projectId генерируется один раз и
  восстанавливается из path index. Save As в той же открытой сессии обновляет
  путь существующей записи; неизвестная копия после перезапуска получает новый
  id, пока владелец явно не выполнит reconciliation.
- Для Premiere позднее используется официальный `Project.guid` и одна и та же
  GUID всегда возвращает один projectId даже после Save As.
- Коллизия (один path у двух id или один GUID у двух id) не разрешается молча:
  вернуть structured conflict и ничего не перезаписывать.

## Реализация AE-клиента

Добавить небольшой модуль `client/workspace-store.js`, подключить до `main.js` и
attach/detach его при смене проекта. После успешного аудита регистрировать
текущий AE-проект. Не добавлять новый UI; конфликт выводится через существующий
журнал и не останавливает защиту файлов.

Не менять существующие `settings.json`, `assets.tsv`, `issues.json`,
`stats.json` и `pending.tsv`. Миграция только добавочная.

## Тесты

Добавить `tests/workspace-store.test.js` и включить в `run-all.js`. Покрыть:

1. создание и повторное чтение workspaceId;
2. нормализацию путей Windows без зависимости от регистра и slash;
3. стабильный AE projectId для того же пути;
4. Save As в текущей сессии и отдельную неизвестную копию;
5. будущий Premiere GUID identity;
6. конфликт без перезаписи;
7. atomic JSON write и отказ до rename;
8. два конкурирующих writer, timeout и stale-lock recovery;
9. идемпотентный `eventId`;
10. оборванную последнюю JSONL-строку и повреждение в середине;
11. panel regression tests.

Запустить целевой тест, затем полный набор и `git diff --check`. Создать
`.agents/reports/003-workspace-registry.md`.

