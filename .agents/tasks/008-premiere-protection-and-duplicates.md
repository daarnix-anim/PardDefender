# Задача 008: защита файлов, дубликаты и консолидация в Premiere Pro

Статус: ready

Зависит от: задачи 004–007.

## Цель

Довести Premiere UXP-плагин до функционального паритета в общей части:
копирование внешнего media внутрь workspace, проверенная перелинковка, отчёт
точных дубликатов и безопасная file consolidation.

## UXP filesystem layer

Реализовать асинхронную последовательную copy queue через официальный UXP `fs`:

- писать `<dest>.<random>.pdpart` рядом с destination;
- читать/писать chunks, показывать monotonic progress;
- проверять итоговый размер и SHA-256 до rename;
- journal-before-copy в совместимом `pending.tsv` либо versioned replacement с
  миграцией, которую понимает AE;
- recovery удаляет только `.pdpart`, доказанно созданные своей записью журнала;
- collision-safe name, exact owned reuse и sequence all-or-nothing;
- ENOSPC/permission/missing/stalled/changed-source дают стабильные codes;
- если UXP не предоставляет официальный free-space API, не выдумывать цифры:
  полагаться на safe `.pdpart` rollback, честно показать capability warning и
  обработать ENOSPC без relink.

Для больших файлов нельзя загружать файл целиком в RAM ради Web Crypto digest.
Использовать проверенную incremental SHA-256 реализацию над chunks (с тестовыми
векторами NIST) либо официальный streaming API, если он реально доступен в
используемой UXP-версии.

## Premiere relink

- Перед commit повторно получить item и expected old media path.
- Проверить `canChangeMediaPath()`, затем
  `changeMediaFilePath(newPath, false)`; `overrideCompatibilityCheck` не включать
  автоматически.
- Для proxy использовать официальный proxy API отдельно; main/proxy результаты
  не смешивать.
- Сохранить item identity, bins, labels/interpretation там, где relink API их
  сохраняет; после commit перечитать path и считать успехом только совпадение.
- Merged/multicam/generated/unsupported не менять, а показывать code.

## UI

- `ЗАЩИТИТЬ СЕЙЧАС`, очередь/progress/issues для media вне workspace.
- Категорийные routes совместимы с общей рабочей зоной; Premiere bins не должны
  имитировать AE compositions.
- Read-only `ДУБЛИКАТЫ` использует те же persisted content/group schemas.
- `ОБЪЕДИНИТЬ ФАЙЛЫ` выполняет те же предусловия и operation state machine, что
  задача 006: rehash, canonical ready, expected path, no deletion, no project
  item merge.

## Тесты

Mock UXP fs/DOM tests должны покрыть chunk copy, partial recovery, hash vectors,
large mocked media, cancellation, collisions, sequences, proxies, canChange
false, compatibility rejection, stale path, post-relink verification, duplicate
scan/canonical/consolidation, отсутствие delete/unlink для originals и UI error
states. Включить Premiere suites в общий runner.

README должен явно перечислять отличия от AE: нет forgotten-layer scan и
AE-композиционной раскладки. Отчёт:
`.agents/reports/008-premiere-protection-and-duplicates.md`.

