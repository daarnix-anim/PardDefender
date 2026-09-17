# Спецификация схем метаданных PardDefender 2.0.0

Документ описывает структуру и политики совместимости файлов метаданных в директории `.parddefender/`, общей для хостов Adobe After Effects (CEP) и Adobe Premiere Pro (UXP).

---

## 1. Политика версионирования схем (Schema Versioning & Migration Policy)

Все структурированные JSON-документы метаданных содержат числовое поле `schemaVersion` (текущая версия: `1.0` / `1`).

### Правила совместимости:
1. **Major Version:** При чтении файла, если `Math.floor(schemaVersion) > 1`, операция прерывается с ошибкой `UNSUPPORTED_MAJOR_VERSION`. Приложение не пытается читать или перезаписывать структуры неизвестных старших версий.
2. **Minor Version:** Если `schemaVersion` больше текущей поддерживаемой в пределах `1.x` (например, `1.1`, `1.2`), парсер игнорирует неизвестные дополнительные поля и обрабатывает базовые поля без сбоев.
3. **Отсутствие версии:** Файлы без `schemaVersion` (или со старым форматом `version: 1` в `settings.json`) распознаются как legacy v1 и обновляются на лету без потери пользовательских настроек и записей манифестов.

---

## 2. Структуры данных

### 2.1. Реестр проектов (`.parddefender/projects.json`)

Хранит перечень проектов (AE и Premiere), привязанных к данному рабочему пространству.

```json
{
  "schemaVersion": 1,
  "projects": {
    "ae_1726580000000": {
      "projectId": "ae_1726580000000",
      "host": "aftereffects",
      "projectName": "Commercial_v1.aep",
      "projectPath": "d:/Work/Commercial/Commercial_v1.aep",
      "workspace": "d:/Work/Commercial",
      "lastSeen": 1726580000000,
      "mediaSnapshotPath": ".parddefender/projects/ae_1726580000000.media.json"
    },
    "pr_1726580001000": {
      "projectId": "pr_1726580001000",
      "host": "premierepro",
      "projectName": "Edit_Cut.prproj",
      "projectPath": "d:/Work/Commercial/Edit_Cut.prproj",
      "workspace": "d:/Work/Commercial",
      "lastSeen": 1726580001000,
      "mediaSnapshotPath": ".parddefender/projects/pr_1726580001000.media.json"
    }
  }
}
```

### 2.2. Снимки медиаданных проекта (`.parddefender/projects/<projectId>.media.json`)

Снимок ссылок на физические файлы, используемые проектом. Позволяет соседнему хосту рассчитывать намерения перелинковки (`intents`) даже когда второй хост закрыт.

```json
{
  "schemaVersion": 1,
  "projectId": "pr_172658001000",
  "host": "premierepro",
  "updatedAt": 1726580001000,
  "items": [
    {
      "id": "clip_node_42",
      "path": "01_assets/_SHARED/VIDEO/Interview.mp4",
      "contentId": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "classification": "clip",
      "isProxy": false,
      "isSequence": false,
      "size": 104857600
    }
  ]
}
```

### 2.3. Журнал синхронизации событий (`.parddefender/events.jsonl`)

Построчный лог событий (JSON Lines). Гарантирует атомарную дозапись (`append-only`) и идемпотентность через `eventId`.

```json
{"eventId":"evt_1","schemaVersion":1,"type":"media.relink.requested","timestamp":1726580002000,"projectId":"ae_1726580000000","payload":{"intentId":"intent_101","targetProjectId":"pr_1726580001000","originProjectId":"ae_1726580000000","locator":"clip_node_42","expectedOldPath":"01_assets/_SHARED/VIDEO/Interview_dup.mp4","newPath":"01_assets/_SHARED/VIDEO/Interview.mp4","contentId":"sha256:e3b0c442...","status":"pending"}}
{"eventId":"evt_2","schemaVersion":1,"type":"media.relink.acknowledged","timestamp":1726580003000,"projectId":"pr_1726580001000","payload":{"intentId":"intent_101","targetProjectId":"pr_1726580001000","status":"acknowledged","appliedAt":1726580003000}}
```

#### Типы событий и жизненный цикл интента (Intent State Machine):
- `media.relink.requested`: Запрос на перелинковку элемента в целевом проекте.
- `media.relink.acknowledged`: Успешное применение перелинковки целевым хостом при открытии проекта.
- `media.relink.rejected`: Отказ с указанием причины (`STALE_SOURCE`, `NOT_FOUND`, `USER_REJECTED`).

```
[ media.relink.requested ]
         │
         ├─── Проверка пути: ожидаемый путь совпадает ───> [ media.relink.acknowledged ]
         │
         └─── Несовпадение пути (изменено пользователем) ─> [ media.relink.rejected: STALE_SOURCE ]
```

### 2.4. Состояние операции консолидации (`.parddefender/operations/<opId>.json`)

Обеспечивает устойчивость к сбоям (crash recovery) при дедупликации и консолидации.

```json
{
  "schemaVersion": 1,
  "operationId": "op_987654",
  "state": "canonical_ready",
  "workspace": "d:/Work/Commercial",
  "projectId": "ae_1726580000000",
  "canonical": "01_assets/_SHARED/VIDEO/Footage_A.mp4",
  "contentId": "sha256:...",
  "targets": [
    { "id": 101, "oldPath": "01_assets/_SHARED/VIDEO/Footage_A_dup.mp4", "status": "pending" }
  ],
  "createdAt": 1726580000000,
  "updatedAt": 1726580005000
}
```

#### Машина состояний операции (Operation State Machine):
```
[ planned ] ──> [ canonical_ready ] ──> [ relinking ] ──> [ completed ]
      │                   │                     │
      └───────────────────┴─────────────────────┴───────> [ failed ]
```

### 2.5. Манифест активов (`.parddefender/assets.tsv`)

Табличный журнал подтверждённых проектных файлов (TSV):
1. `timestamp` (ISO 8601)
2. `id` (идентификатор ассета)
3. `sourcePath` (исходный путь при импорте)
4. `size` (размер в байтах)
5. `destPath` (нормализованный путь внутри рабочего пространства)
6. `folder` (корневая папка структуры, напр. `01_assets`)
7. `subfolder` (подкатегория, напр. `VIDEO`)

### 2.6. Журнал незавершённого копирования (`.parddefender/pending.tsv`)

Временный журнал записи во временные файлы `.pdpart`:
- Содержит строки: `timestamp\tid\tsourcePath\tdestPath`.
- При аварийном завершении хоста следующий запуск парсит `pending.tsv`, удаляет осиротевшие файлы `*.pdpart` и удаляет `pending.tsv`.

### 2.7. Файловые блокировки (`.parddefender/locks/<name>.lock/`)

Использует атомарное создание директории в файловой системе:
- Внутри папки создаётся `owner.json`:
  ```json
  {
    "token": "uuid-or-random",
    "pid": 12345,
    "at": 1726580000000
  }
  ```
- Политика `staleMs` (по умолчанию 30000 мс): если метка времени старше `staleMs`, блокировка считается зависшей и перехватывается.
