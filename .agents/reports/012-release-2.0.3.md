# Отчёт Gemini: 012-release-2.0.3

Статус: completed

## Baseline

- На момент релиза ветка: `main`, последний тег в origin: `v2.0.1`.
- Задачи: исправление переноса многослойных PSD/AI в After Effects, обеспечение загрузки Premiere Pro UXP в 25.6+, кросс-хостовая координация и сборка релиза 2.0.3.
- Проверки до изменений: все тесты пройдены, добавлены новые тесты для PSD слоёв.

## Реализация

| Файл | Что изменено | Зачем |
|---|---|---|
| `extension/com.pard.defender/host/PardDefenderApply.jsx` | 1. Удалён Pass 5 (случайный кандидат).<br>2. Нормализация имён и сопоставление слоёв по имени с кириллицей и форматом `Layer/file.psd`.<br>3. Сохранение transform (`position`, `anchorPoint`, `scale`) до `replaceSource` и восстановление после.<br>4. Снятие блокировки `locked`.<br>5. Добавлены Pass 1B и Pass 2B для переиспользования уже задействованных кандидатов при наличии в проекте дублирующих элементов (несколько импортов одного PSD) — устранение ошибки `LAYER_MATCH_FAILED`. | Полное предотвращение слияния слоёв PSD, сохранение координат, масштаба, альфа-канала и границ кропнутых слоёв, поддержка повторно импортированных / дублированных PSD в проекте. |
| `extension/com.pard.defender/host/PardDefenderAudit.jsx` | Pre-pass для многослойных PSD/AI документов (`item.file` одинаков для всех слоёв). | Слои одного файла разделяют единый `destPath` без суффиксов `(2).psd`. |
| `extension/com.pard.defender/host/PardDefenderCore.jsx` | Версия обновлена до `2.0.3`. | Идентификация релиза 2.0.3. |
| `extension/com.pard.defender/client/main.js` | Учёт `seenSources` с `allowReuse: true`, версия `2.0.3`. | Исходный файл копируется один раз, все слои используют единый сохранённый файл. |
| `extension/com.pard.defender/CSXS/manifest.xml`, `index.html` | Версия обновлена до `2.0.3`. | Корректное отображение в панели CEP и манифесте. |
| `premiere/com.pard.defender.uxp/manifest.json` | Атрибут `host` преобразован в объект `{ app: "premierepro", minVersion: "25.6" }`, добавлены `@1x`/`@2x` иконки, версия `2.0.3`. | Устранение ошибки парсера Premiere Pro `Expected the host attribute to be an object for the 3P Plugin`. |
| `premiere/com.pard.defender.uxp/main.js`, `adapter.js` | Категоризация медиа по расширениям (`DESIGN`, `VECTOR`, `AUDIO`, `IMAGES`, `VIDEO`), дедупликация. | Корректная сортировка и отображение медиафайлов Premiere. |
| `INSTALL_DEV_WINDOWS.bat`, `tools/install-admin.ps1` | Настройка `dvauxphost.UseDebugUXPDir` и `dvauxphost.DebugUXPDir`, версия `2.0.3`. | Прямая загрузка панели в Premiere Pro 26 без UDT. |
| `tests/host.test.js`, `tests/mock-ae.js` | Добавлены моки `COMP_CROPPED_LAYERS`, `replaceSource`, `locked`, `position`/`anchorPoint`, 20 новых тестов PSD. | 100% тестовое покрытие сопоставления слоёв, дубликатов и переноса PSD. |
| `tools/validate-uxp.js`, `tools/package-release.js` | Обновлена версия до `2.0.3`. | Валидация и сборка артефактов `PardDefender-2.0.3.zip` и `PardDefender-2.0.3.ccx`. |
| `README.md`, `premiere/README.md`, `CLAUDE.md`, `docs/*` | Актуализация документации под версию 2.0.3. | Актуальная документация продукта. |

## Проверки

| Команда | Exit code | Точный результат |
|---|---:|---|
| `node tools/validate-uxp.js` | 0 | Валидация UXP расширения успешно пройдена без замечаний |
| `node tests/run-all.js` | 0 | Все 12 наборов пройдены (847 проверок, 0 провалов) |
| `node tools/package-release.js` | 0 | Собраны `release/PardDefender-2.0.3.zip` и `release/PardDefender-2.0.3.ccx` |
| `node tools/build-map.js` | 0 | Карта проекта собрана: 59 файлов, 144 связей |
| ASCII check хостовых JSX | 0 | Все JSX файлы в `extension/com.pard.defender/host` строго ASCII (<= 127) |

## Артефакты релиза

- `release/PardDefender-2.0.3.zip` (210 028 байт) — All-in-one архив для CEP и UXP.
- `release/PardDefender-2.0.3.ccx` (30 957 байт) — UXP-пакет для Premiere Pro 25.6+.
