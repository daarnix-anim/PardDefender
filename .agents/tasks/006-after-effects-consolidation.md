# Задача 006: безопасная консолидация точных дубликатов в After Effects

Статус: ready

Зависит от: задачи 003–005.

## Определение операции

`ОБЪЕДИНИТЬ ФАЙЛЫ` означает: все подходящие AE FootageItem одной exact duplicate
group перелинковываются на один проверенный canonical media path. Project items,
слои и композиции не удаляются и не склеиваются. Исходные файлы не удаляются.

## Предусловия

- duplicate report относится к текущему `projectId`, audit generation и
  workspace;
- у каждого участника повторно совпадают size/mtime/SHA-256 непосредственно
  перед commit;
- proxy и original не смешиваются;
- unstable/missing/unreadable/unsupported sequence группа отклоняется;
- canonical существует и verified;
- ожидаемый старый путь каждого item совпадает с новым audit.

Если canonical не owned и лежит вне workspace, сначала провести один обычный
безопасный copy через существующую очередь в рекомендованный managed route,
записать provenance в `assets.tsv`, и только потом использовать копию. Равный
чужой файл не становится owned без записи о фактически созданной копии.

## Транзакция

Добавить operation record `.parddefender/operations/<operationId>.json` со
state machine `planned -> verified -> canonical_ready -> relinking -> completed`
и terminal `failed/partial`. Каждая запись атомарна и содержит contentId,
projectId, expected paths, canonical, результаты каждого item и eventId.

Relink выполнять существующим `PardHostAdapter.commitFromFileJson`; stale item
оставлять нетронутым и возвращать partial. Повтор операции по тому же
operationId идемпотентен. После crash панель показывает recoverable operation и
может безопасно продолжить с первого незавершённого шага.

## UX и безопасность

- Действие доступно только у safe group.
- Перед запуском показать canonical, число ссылок/файлов и текст «оригиналы не
  удаляются»; требуется второе нажатие в существующем confirmation window.
- После успеха показать, сколько items перелинковано и сколько физических копий
  осталось. Не предлагать автоматическое удаление в этой задаче.
- Кнопка очистки `НЕ ИСПОЛЬЗУЕТСЯ` не должна получить новые права на duplicate
  originals только из-за consolidation.

## Тесты

Покрыть happy path, external canonical copy, manifest failure before relink,
rehash mismatch, stale expected path, proxy/sequence guard, partial host result,
crash/recovery на каждом состоянии, idempotent повтор, отсутствие recycle и
удаления project items, UI two-click confirmation и полный regression suite.

Обновить README. Создать `.agents/reports/006-after-effects-consolidation.md`.

