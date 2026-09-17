# Задача 009: синхронизация AE и Premiere в общей рабочей зоне

Статус: ready

Зависит от: задачи 003, 006 и 008.

## Цель

Если `.aep` и `.prproj` зарегистрированы в одной workspace, изменение canonical
media path одним хостом создаёт безопасные pending relink intents для остальных
проектов. Открытый проект применяет их; закрытый ждёт открытия. Закрытые Adobe
project files никогда не переписываются.

## Media snapshots

После каждого успешного host audit атомарно публиковать
`.parddefender/projects/<projectId>.media.json`:

- schemaVersion, workspaceId, projectId, host, auditGeneration, createdAt;
- item locator, main/proxy role, normalized path, size/mtime и известный
  contentId/hash;
- unsupported flags.

Snapshot — наблюдение, не ownership и не разрешение на удаление. Старый snapshot
помечается stale по age/generation и не подтверждает безопасность cleanup.

## Event protocol

Через locked append-only `events.jsonl` использовать события:

- `media.relink.requested` — intentId, origin operation/project, targetProjectId,
  item locator, role, expectedOldPath, newPath, contentId;
- `media.relink.applied` — фактически перечитанный new path;
- `media.relink.rejected` — stable reason code и observed path;
- `media.relink.deferred` — project closed/not active/temporarily unavailable.

`intentId` идемпотентен. Один target project применяет intent не более одного
раза. Никакой host не подтверждает intent другого projectId. Перед relink
обязательно re-audit/resolve locator, expected old path и content identity.

## Поведение

- После AE/Premiere consolidation coordinator находит в свежих snapshots других
  проектов ссылки на тот же contentId/old path и создаёт intents.
- Обе панели проверяют pending intents после открытия/смены проекта и затем на
  умеренном polling interval без busy loop.
- UI показывает `СИНХРОНИЗАЦИЯ`: applied/pending/rejected по проектам и кнопку
  retry только для безопасно повторяемых причин.
- Отсутствующий/закрытый проект остаётся pending без системной ошибки.
- Конфликт пути никогда не перезаписывается; владелец видит observed path.
- Compaction JSONL сохраняет все unresolved intents и terminal summaries,
  выполняется под тем же lock и имеет crash-safe swap.

## Тесты

Симулировать два процесса/хоста: concurrent append, AE -> Premiere, Premiere ->
AE, закрытый target и позднее открытие, duplicate delivery, crash до/после host
commit, stale snapshot, stale expected path, proxy role, partial multi-item
operation, lock timeout/stale recovery, compaction crash. Проверить, что ни один
тест не редактирует `.aep`/`.prproj` напрямую.

Обновить обе UI и docs. Отчёт:
`.agents/reports/009-cross-host-relink-sync.md`.

