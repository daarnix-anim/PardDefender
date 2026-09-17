# Отчёт Gemini: 004-exact-duplicate-engine

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
 M tests/run-all.js
 M tests/runtime.test.js
 M tools/build-map.js
?? .agents/
?? docs/architecture-dedup-premiere.md
?? docs/premiere-uxp-decision.md
?? extension/com.pard.defender/client/host-adapter.js
?? extension/com.pard.defender/client/workspace-store.js
?? mercy-stadium-guide/
?? sigma-stadium-guide/
?? tests/host-adapter.test.js
?? tests/workspace-store.test.js
```
- Проверки до изменений:
`node tests/run-all.js` — 172 host + 50 copy-queue + 112 runtime + 60 host-adapter + 39 workspace-store + 136 panel = 569 проверок.

## Реализация

| Файл | Что изменено | Зачем |
|---|---|---|
| `extension/com.pard.defender/client/duplicate-index.js` | Создан новый модуль `PardDuplicateIndex`, реализующий: группировку по размеру (SHA-256 только при размере группы > 1), потоковое последовательное хэширование SHA-256 без лимита 1 GiB с progress и cancellation, hash-кэш (`.parddefender/hash-cache.json`) с валидацией по size/mtime и атомарным сохранением, сегрегацию originals и proxies, вычисление идентичности секвенций по упорядоченным хэшам кадров и шаблону, учёт владения из `assets.tsv` и ранжирование рекомендованного canonical | Реализация безопасного read-only движка обнаружения побайтовых дубликатов |
| `extension/com.pard.defender/client/index.html` | Подключен скрипт `<script src="duplicate-index.js"></script>` перед `main.js` | Доступность модуля в среде панели |
| `tests/panel.test.js` | Добавлена загрузка `duplicate-index.js` в песочницу панели перед `main.js` | Сохранение целостности тестов панели |
| `tests/duplicate-index.test.js` | Создан изолированный тестовый набор (32 проверки), покрывающий все требования: разные байты при одинаковом размере, дубликаты с разными именами, повторные ссылки на один путь, изоляцию proxy/original, hit/invalidation кэша, стриминг > 1 GiB, cancellation с ровно одним callback, монотонный progress, секвенции кадров, canonical ranking и устойчивость к сбоям записи кэша | Доказательство корректности движка дубликатов |
| `tests/run-all.js` | В массив `suites` добавлен `duplicate-index.test.js` | Интеграция нового набора в единый прогон тестов |

## Решения и отклонения

- Решения:
  1. Хэширование выполняется строго последовательно, чтобы избежать перегрузки диска (особенно важно для сетевых и облачных папок вроде Яндекс.Диска).
  2. Несколько ссылок в проекте на один и тот же физический путь нормализуются и агрегируются в массив `references`, не создавая ложных дубликатов.
  3. Прокси отделяются от оригиналов с префиксом `proxy:` в ключе группировки, гарантируя невозможность слияния прокси с оригиналом.
  4. Для секвенций формируется составной идентификатор контента на основе упорядоченных относительных имён, размеров, хэшей кадров и шаблона имени. При отсутствии или повреждении любого кадра секвенция объявляется нестабильной и исключается из кандидатов в дубликаты.
  5. Порядок ранжирования canonical: проверенный путь из `assets.tsv` -> путь внутри рабочей папки -> непостоянный/нетестовый маршрут -> лексикографический порядок.
- Отклонения от задания: нет.

## Проверки

| Команда | Exit code | Точный результат |
|---|---:|---|
| `node tests/duplicate-index.test.js` | 0 | Все проверки пройдены: 32 |
| `node tests/run-all.js` | 0 | Все наборы пройдены: 601 проверка (172 host + 50 copy-queue + 112 runtime + 60 host-adapter + 39 workspace-store + 32 duplicate-index + 136 panel) |
| `git diff --check` | 0 | Синтаксических и пробельных ошибок нет |

## Ручная проверка UI

На данном этапе UI дубликатов не создавался (запланирован в задаче 005). Движок протестирован изолированно модульными тестами.

## Риски и что не проверено

- Проверка файлов размером более 1 GiB проводилась с помощью потокового генератора в Node.js без сохранения терабайтного тестового файла на физический диск.

## Итоговый diff

```text
 extension/com.pard.defender/client/duplicate-index.js | 460 +++++++++++++++++++
 extension/com.pard.defender/client/index.html         |   1 +
 tests/duplicate-index.test.js                         | 450 +++++++++++++++++++
 tests/panel.test.js                                   |   3 +-
 tests/run-all.js                                      |   3 +-
 5 files changed, 915 insertions(+), 2 deletions(-)
```
