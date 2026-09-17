# Задача 010: финальная интеграция, документация и release readiness

Статус: ready

Зависит от: задачи 003–009.

## Цель

Свести две версии продукта в проверяемый релиз без расширения функционального
scope. Устранить интеграционные регрессии, завершить миграции/документацию и
оставить воспроизводимый пакет проверки.

## Интеграционные проверки

Добавить end-to-end mock scenarios:

1. новый AE project -> protection -> duplicate scan -> consolidation;
2. новый Premiere project -> protection -> duplicate scan -> consolidation;
3. AE и Premiere в одной workspace -> intent -> target opens -> relink applied;
4. target path изменился -> rejected без перезаписи;
5. crash после copy/до manifest, после manifest/до relink, после relink/до ack;
6. sequence/proxy across hosts;
7. два одновременно открытых хоста и lock contention;
8. migration существующего `.parddefender` без потери assets/settings/issues.

Все тестовые временные workspace должны удаляться только внутри собственных
temp fixtures. Добавить одну команду, запускающую AE, shared и Premiere suites.

## Документация

- Обновить `README.md`: AE, Premiere minimum 25.6, установка, различия функций,
  duplicates/consolidation, shared workspace/sync, recovery и безопасность.
- Обновить `CLAUDE.md` для будущих агентов.
- Обновить `PROJECT_MAP.md` и `docs/project-map.html` штатным генератором после
  добавления корректных `@map` headers; не редактировать generated map вручную.
- Добавить `docs/metadata-schemas.md` с точными schemaVersion, полями, state
  machines и migration policy.
- Добавить две отдельные manual smoke checklists для реальных AE и Premiere.

## Версия и доставка

Это major release из-за нового хоста и persisted protocol: после полного green
suite согласованно поднять продукт до `2.0.0` во всех существующих version
locations. Не менять идентификатор установленной AE extension.

- Проверить существующий AE dev installer, не запускать его автоматически.
- Для Premiere подготовить документированный dev-load/package workflow UXP и
  validate script. Не заявлять, что `.ccx` собран, если официальный toolchain
  отсутствует.
- Не включать в релиз посторонние каталоги `mercy-stadium-guide` и
  `sigma-stadium-guide`.

## Финальные критерии

- полный runner зелёный два последовательных запуска;
- `git diff --check` чистый;
- no debug logs/secrets/absolute developer paths;
- schema readers отклоняют неизвестную major version и терпят известную minor;
- ни один production path автоматически не удаляет originals;
- duplicate consolidation не удаляет project items;
- ни один Premiere source не содержит QE/CEP/evalScript;
- unresolved live проверки перечислены честно.

Создать `.agents/reports/010-final-hardening-release.md`, затем итоговый
`.agents/reports/FINAL-003-010.md` согласно batch-файлу.

