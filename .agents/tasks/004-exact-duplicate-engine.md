# Задача 004: движок точных дубликатов и hash-cache

Статус: ready

Зависит от: задача 003.

## Цель

Создать read-only движок, который находит только точные побайтовые дубликаты в
текущем проекте/рабочей зоне. На этом этапе он ничего не перелинковывает и не
удаляет.

## Алгоритм

1. Принимать нормализованные media descriptors из audit report.
2. Не считать несколькими копиями повторные project-item ссылки на один и тот
   же нормализованный физический путь; сохранить их как `references`.
3. Отделять originals от proxies. Proxy никогда не объединяется с original,
   даже если байты совпали.
4. Сначала группировать обычные файлы по размеру; SHA-256 считать только для
   групп размера > 1.
5. SHA-256 читать потоково, последовательно, с progress и cancellation. Для
   duplicate scan нет лимита 1 GiB и нельзя молча считать большие файлы
   различными.
6. Cache entry: normalized path, size, mtimeMs, SHA-256. Любое изменение size
   или mtime инвалидирует hash. Cache записывать атомарно в
   `.parddefender/hash-cache.json` со schemaVersion.
7. Секвенция — отдельный content identity: нормализованный pattern плюс
   упорядоченный список `{relativeName,size,sha256}` всех кадров. Один кадр не
   представляет секвенцию. Неполная/изменившаяся во время scan секвенция даёт
   structured unstable result и не становится duplicate group.
8. Результат содержит `groupId`, `kind`, `contentId`, файлы/секвенции,
   references, totalBytes, reclaimableBytes, ownership из `assets.tsv`,
   recommendedCanonical и причины выбора.

Порядок выбора canonical: verified owned path -> путь внутри workspace -> не
temporary route -> стабильный lexical path. Выбор является рекомендацией, а не
разрешением на удаление.

## Модуль

Добавить `client/duplicate-index.js` с callback/ES5 API, совместимым с CEP Node.
Не связывать его с DOM. Движок должен иметь start/cancel/progress и гарантировать
ровно один terminal callback. Ошибки отдельных файлов возвращаются в отчёте;
фатальная ошибка store/hash останавливает scan с явным code.

## Тесты

Добавить `tests/duplicate-index.test.js` и покрыть:

- одинаковый размер, но разные bytes;
- точные дубликаты с разными именами;
- три project refs одного пути не создают duplicate;
- proxy/original разделены;
- cache hit и invalidation по size/mtime;
- файл больше 1 GiB через mocked streaming source;
- cancellation между chunks и один callback;
- progress monotonic;
- секвенции: равные, один изменённый кадр, пропавший кадр, разный pattern;
- ownership и canonical ordering;
- atomic cache failure не портит старый cache.

Не добавлять UI и не изменять файлы на диске кроме hash-cache. Запустить полный
набор тестов и создать `.agents/reports/004-exact-duplicate-engine.md`.

