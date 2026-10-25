# Отчёт: полный аудит PardDefender 2.3.4 (After Effects + Premiere Pro)

Статус: completed (только чтение, ни одна строка кода не изменена)
Дата: 2026-10-25

## Что проверено

| Область | Файлов | Строк |
|---|---:|---:|
| Хост After Effects (`.jsx`) | 5 | 3 437 |
| Клиент After Effects (CEP + Node) | 14 | 10 212 |
| Premiere Pro (UXP) | 5 | 6 297 |
| Инструменты и тесты | — | прогнаны |

Автоматические проверки до начала разбора:

| Команда | Exit | Результат |
|---|---:|---|
| `node tests/run-all.js` | 0 | 16 наборов, все зелено (1 365 проверок) |
| `node tools/validate-uxp.js` | 0 | манифест v5, чистота UXP подтверждена |
| `node tools/build-map.js --check` | 0 | карта актуальна (71 файл, 162 связи) |
| `node --check` по всем `.js` | 0 | синтаксис чистый |
| grep `qe.` / `evalScript` / `CSInterface` / `#include` в UXP | — | ничего не найдено (правило 3 соблюдено) |
| grep не-ASCII в `.jsx` | — | ничего не найдено (правило чистого ASCII соблюдено) |
| grep ES5+ конструкций в `.jsx` | — | только `String.prototype.indexOf` (это ES3, допустимо) |

Все жёсткие правила из `CLAUDE.md` соблюдены **кроме двух** — см. A-1 и A-2 ниже.

---

## A. Критическое — нарушает собственные правила проекта

> **Исправлено 2026-10-25**, см. [`051-critical-fixes-a1-a2.md`](051-critical-fixes-a1-a2.md).
> A-1 и A-2 закрыты, проверки: 1 557 в 16 наборах, зелено.

### A-1. ~~Кнопка «ОТСОРТИРОВАТЬ НЕИСПОЛЬЗУЕМЫЕ В UNUSED» удаляет файлы мимо Корзины и до перелинковки~~ — ИСПРАВЛЕНО

`extension/com.pard.defender/client/main.js:1333-1350` (`checkAndSortUnusedFiles`)

```js
fsMod.copyFileSync(nativeSrc, partDst);
var partStat = fsMod.statSync(partDst);
if (partStat.size === srcStat.size) {
    if (fsMod.existsSync(nativeDst)) fsMod.unlinkSync(nativeDst);   // (1)
    fsMod.renameSync(partDst, nativeDst);
    try { fsMod.unlinkSync(nativeSrc); } catch (eUnl) {}            // (2)
    success = true;
}
```

Три отдельные проблемы в одном блоке:

1. **(1) безусловный `unlinkSync` того, что уже лежит в назначении.** Файл сносится
   навсегда, не в Корзину, без проверки, что это наша копия (нет обращения к
   `PardVerify.wasCopiedByUs`). Прямое нарушение правила 1 и комментария в
   `housekeeping.js`: «Deletion here is ALWAYS to the Recycle Bin, never a
   permanent unlink».
2. **(2) оригинал удаляется ДО перелинковки.** `commitRelinkDirect(relinkEntries,…)`
   вызывается только в `finishAll()`, то есть после цикла. Если хост откажет
   (элемент исчез, AE занят, `RELINK_SOURCE_CHANGED`) — проект указывает на путь,
   которого больше нет. Файл лежит на новом месте, то есть восстановимо руками,
   но порядок «журнал → копия → сверка → relink → только потом трогать остаток»
   здесь нарушен, в отличие от правильного `runPass` → `recycleRelocated`.
3. **`canReuse` решается только по размеру** (`dstStat.size === srcStat.size`),
   без хэша. Если в `unused/VIDEO/` уже лежит ДРУГОЙ файл того же размера с тем
   же именем, он признаётся «уже перемещённым», оригинал остаётся, а проект
   перелинковывается на чужой файл. Это подмена футажа — ровно то, от чего
   защищает `copy-queue.resolveDestination` (там сверка по SHA-256).

Рядом, в том же блоке, помельче:

- `.pdpart` имеет фиксированное имя `nativeDst + ".pdpart"` вместо
  `PardCopyQueue.partialNameFor()`. Два параллельных прохода столкнутся,
  а `recoverJournal` (см. B-3) снесёт его.
- `journalTasks(copyTasks)` пишет `pending.tsv`, но в этом пути он **никогда не
  удаляется** — следующий старт отрапортует «после сбоя убрано незавершённых копий».
- `PardCopyQueue.run(copyTasks, state.settings, …)` передаёт настройки как
  options. `reserveBytes` там есть, а `freeBytes` нет → проверка свободного места
  пропускается целиком (в `copy-queue.run` она под `if (freeBytes > 0)`).
- `panelMoves` для скопированных задач собирается из `cTask.category.toUpperCase()`,
  а файл для секвенции ушёл в `unused/SEQUENCES/<name>`. Папка в панели и папка
  на диске расходятся.

Почему не поймали тесты: `panel.test.js` вызывает кнопку, но мок `fs` не проверяет
порядок unlink относительно relink.

### A-2. ~~Premiere не имеет защиты от небезопасной рабочей папки~~ — ИСПРАВЛЕНО

В AE есть `host.unsafeWorkspaceReason()`
(`extension/com.pard.defender/host/PardDefenderPlan.jsx:320-357`): рабочей папкой
не может стать корень диска, Рабочий стол, Загрузки, профиль пользователя,
`C:\Windows`, Program Files, `$RECYCLE.BIN` или папка Auto-Save. Правило появилось
потому, что владелец чистит «Загрузки» в расчёте на это.

В Premiere UXP **нет ничего похожего**: grep по `premiere/com.pard.defender.uxp/`
на `unsafe`, `Desktop`, `Downloads`, `workspaceIssue`, `systemRoot` не находит
ничего. `resolveWorkspace` возвращает папку и `protectExternalMedia` сразу начинает
копировать. `.prproj`, сохранённый на Рабочий стол, превратит Рабочий стол в
рабочую зону: там появятся `01_assets/_SHARED/VIDEO/…`, `03_audio/…` и
`.parddefender/`.

---

## B. Серьёзное — функция не работает или врёт об успехе

> **Исправлено 2026-10-25/26.**
> B-1, B-2, B-4, B-5, B-6, B-7 — см. [`052-group-b-fixes.md`](052-group-b-fixes.md).
> B-3 — см. [`053-b3-split-copy-journals.md`](053-b3-split-copy-journals.md).
> Группа B закрыта целиком. Проверки: 1 669 в 16 наборах, зелено.

### B-1. ~~Хост AE не имеет метода `removeItemsFromFileJson` — очистка неиспользуемых молча не доводится до конца~~ — ИСПРАВЛЕНО

- Клиент зовёт: `extension/com.pard.defender/client/host-adapter.js:152`
  → `$.global.PardDefenderHost.removeItemsFromFileJson('…')`
- Хост определяет только: `extension/com.pard.defender/host/PardDefenderApply.jsx:858`
  → `host.removeItemsFromFile` (без `Json`)

Проверено на моке:

```
removeItemsFromFile:     function
removeItemsFromFileJson: undefined
```

Последствие: в `cleanUnused()` (`main.js:1176`) файлы уже отправлены в Корзину,
затем вызов падает внутри ExtendScript, `evalScript` возвращает `"EvalScript error."`,
`JSON.parse` даёт `null` — и обе ветки логирования пропускаются. Пользователь не
видит ни ошибки, ни результата, а в панели проекта остаются offline-элементы.

Почему не поймали тесты: `host-adapter.test.js:264` проверяет **строку скрипта**,
а не наличие метода на хосте. Это тот самый случай из `CLAUDE.md` — «тест должен
проверять требование, а не то, что код сейчас делает».

Починка — одна строка в `PardDefenderApply.jsx`:

```js
host.removeItemsFromFileJson = function (planPath) {
    return host.jsonEncode(host.removeItemsFromFile(planPath));
};
```

### B-2. ~~Поиск дубликатов секвенций в After Effects не работает никогда~~ — ИСПРАВЛЕНО

`extension/com.pard.defender/client/duplicate-index.js:414-418` ждёт
`item.sequence.files` (массив кадров) и `item.sequence.pattern`:

```js
var pattern = String(seqData.pattern || seqItem.name || "");
var frames = seqData.files || [];
if (!frames.length) { currentStep++; nextSeq(); return; }   // всегда здесь
```

Хост AE отдаёт совсем другую форму —
`PardDefenderAudit.jsx:50-59` (`sequenceDescriptor`):

```js
{ folder, prefix, padding, suffix, firstFrame }
```

Ни `files`, ни `pattern` там нет, а `main.js:3314` передаёт
`items: state.report.items` без обогащения. Значит каждая секвенция попадает в
`scannedSequences`, но ни одна группа дубликатов секвенций не может быть найдена.

Почему не поймали тесты: `tests/duplicate-index.test.js:303` подаёт
`sequence: { pattern: "frame_%03d.png", files: [...] }` — форму, которой в
продакшене не существует.

Починка: либо расширять дескриптор в `buildCopyTasks`/перед `scan` через
`PardCopyQueue.expandSequence(item.sequence)` (он как раз умеет разворачивать
`{folder,prefix,padding,suffix}` в список файлов), либо научить
`duplicate-index` понимать дескриптор хоста напрямую. Второе честнее — тест тогда
проверит требование.

### B-3. ~~`pending.tsv` общий для двух хостов, и они затирают журналы друг другу~~ — ИСПРАВЛЕНО

Один и тот же файл `<workspace>/.parddefender/pending.tsv`, но разные форматы и
несовместимые процедуры восстановления:

| | AE | Premiere |
|---|---|---|
| Колонок | 4 (`ts, key, src, dest`) | 5 (`ts, id, src, dest, part`) |
| Запись | `writeText` — **перезаписывает файл целиком** (`main.js:617`) | `appendText` — дописывает (`copy-engine.js:1290`) |
| Восстановление | `recoverJournal`: удаляет **все** `.pdpart` в папке назначения (`copy-queue.js:600`) | `recoverPending`: удаляет **ровно тот** `.pdpart`, что записан в журнале |
| Чтение чужих строк | принимает строки ≥ 4 колонок, т.е. и строки Premiere | требует ≥ 5 колонок, строки AE игнорирует |
| После восстановления | `removeQuietly(journalPath)` — **весь файл** | `unlinkSync(pFile)` — **весь файл** |

Два следствия, оба реальны при открытых AE и Premiere на одной рабочей папке:

1. Старт прохода в AE (`journalTasks`) **стирает** журнал незавершённого
   копирования Premiere. Крах после этого — и `.pdpart` Premiere остаётся навсегда.
2. `recoverJournal` AE вызывается на каждую смену проекта
   (`main.js:2055`, внутри `onProjectChanged`) и удаляет **все** `.pdpart` в папке
   назначения — включая тот, в который Premiere **прямо сейчас пишет**. Premiere
   затем упадёт на `stat` своей части.

### B-4. ~~`Premiere.recoverPending` написан, но нигде не вызывается~~ — ИСПРАВЛЕНО

`premiere/com.pard.defender.uxp/copy-engine.js:1131` — единственные вызовы в
репозитории это `tests/premiere-protection.test.js:119`. В `main.js` плагина
Premiere вызова нет (`init()` зовёт только `triggerAudit` и `startAutoRefresh`).

То есть Premiere честно пишет журнал до первого байта (правило 7), но **никогда
не откатывает незавершённое**: `.pdpart` после краха остаются на диске, а
`pending.tsv` растёт. Починка — один вызов в `init()`.

### B-5. ~~`PardConsolidation.executeRelink` рапортует успех, когда хост вернул отказ~~ — ИСПРАВЛЕНО

`extension/com.pard.defender/client/consolidation.js:398-410`

```js
var failures = parsed.failures || [];
…
} else {
    target.status = "relinked";   // ← если failures пуст, всё помечено успешным
    relinkedCount++;
}
```

`parsed.ok` не проверяется. Хост (`PardDefenderApply.jsx:600`) ставит `ok: false`
и заполняет `result.error` при исключении во внешнем try — при этом `failures`
остаётся **пустым**. Тогда:

- все targets → `"relinked"`,
- `op.state = "completed"`,
- в `events.jsonl` пишется событие об успешной консолидации,
- панель показывает «✓ Дубликаты успешно объединены: перелинковано N ссылок».

При том что не перелинковано ничего. Основной проход `runPass` этой ошибки не
имеет — там `commitRelink` отдаёт `parsed.ok ? "" : parsed.error` и `absorbRelinkResult`
вообще не вызывается при непустом `error`. Нужна та же проверка здесь.

### B-6. ~~Событие консолидации в журнале теряет все свои данные~~ — ИСПРАВЛЕНО

`consolidation.js:569` передаёт поля верхним уровнем:

```js
PardWorkspaceStore.appendEvent(workspace, {
    type: "consolidate_duplicates",
    projectId: op.projectId,
    contentId: op.contentId,     // ← вот эти
    canonical: op.canonical,     // ← четыре
    relinkedCount: res.relinked, // ← поля
    totalCount: res.total,       // ← теряются
    operationId: op.operationId
});
```

А `workspace-store.js:432` собирает запись так:

```js
var record = { …, type: …, projectId: …, host: …, payload: ev.payload || {} };
```

Всё, что не `eventId/workspaceId/projectId/host/type/createdAt/payload`, выбрасывается.
Запись в `events.jsonl` получается с `payload: {}`. `sync-coordinator.js` (и AE, и
Premiere) оборачивает в `payload` правильно — расходится только этот один вызов.

### B-7. ~~Четыре кода ошибок не зарегистрированы в `PardIssues`~~ — ИСПРАВЛЕНО

Автопроверка кодов:

```
USED BUT NOT REGISTERED: CONSOLIDATE_FAILED, CONSOLIDATE_PROJECT_ITEMS_FAILED,
                         PROXY_GONE, PROXY_REJECTED
```

- `PROXY_GONE`, `PROXY_REJECTED` — реально приходят от хоста
  (`PardDefenderApply.jsx:521, 573`) и попадают в `PardIssues.record` через
  `absorbRelinkResult`. `api.describe` отдаёт fallback: класс `transient`, текст
  «неизвестная ошибка (PROXY_REJECTED)». Вместо строки «включён прокси» владелец
  видит «неизвестная ошибка», и вещь перепроверяется по расширяющемуся расписанию
  вместо того, чтобы быть показанной как требующая внимания.
- `CONSOLIDATE_FAILED`, `CONSOLIDATE_PROJECT_ITEMS_FAILED` — передаются в `trip()`
  (`main.js:3707, 3752`). `trip()` ставит `state.paused`, то есть **неудача
  пользовательской операции объединения дубликатов останавливает весь
  автоматический режим защиты** — и делает это с подписью «неизвестная ошибка».

---

## C. Средней важности — расхождения и узкие места

> **Частично исправлено 2026-10-26**, см. [`054-c4-c5-performance.md`](054-c4-c5-performance.md).
> C-4 и C-5 закрыты: чтение шрифтов 305,5 МБ → 3,66 МБ, обращений к проекту за
> проход раскладки ≥43 680 → 91. C-7 закрыт раньше вместе с B-2.
> Остальные пункты открыты. Проверки: 1 691 в 16 наборах, зелено.

### C-1. AE и Premiere могут вычислить РАЗНУЮ рабочую папку для одного дерева

| | AE (`PardDefenderPlan.jsx:272`) | Premiere (`adapter.js:242`) |
|---|---|---|
| Подъём | ровно один уровень | `while` — пока имя совпадает со списком |
| Список имён | 10 имён | 15 имён (+`shot_production`, `shot production`, `prproj`, `premiere`, `premierepro`, `ppro`) |

Примеры расхождения:

- `…/X/shot production/proj.*` → Premiere даёт `…/X`, AE даёт `…/X/shot production`
  (у AE в списке только `05_shot_production`).
- `…/Projects/edit/proj.*` → Premiere поднимается дважды (`edit`, потом `projects`)
  и даёт родителя `Projects`; AE останавливается на `…/Projects`.

Разные рабочие папки → разные `.parddefender/`, и межхостовая синхронизация
(snapshots, assets.tsv, events.jsonl, pending.tsv) просто не видит друг друга.
Список имён и правило подъёма стоит вынести в одно место и держать идентичными.

### C-2. `withLock` блокирует поток UI активным ожиданием

`extension/com.pard.defender/client/workspace-store.js:222`

```js
var sleepUntil = Date.now() + pollMs;
while (Date.now() < sleepUntil) {}
```

Busy-wait в однопоточном Chromium CEP: панель замирает, ядро грузится на 100%.
`timeoutMs` по умолчанию 2 500 мс, то есть до 2,5 с фриза на одну попытку взятия
блокировки. Блокировки берут `ensureWorkspace`, `registerProject`, `appendEvent`,
`compactEvents` — то есть это происходит регулярно.

Рядом: `DEFAULT_STALE_LOCK_MS = 5000` — блокировка, которую честно держит занятый
процесс (а рабочая папка на Яндекс.Диске, I/O медленный), через 5 с признаётся
«протухшей» и **принудительно снимается**. Освобождение проверяет токен владельца,
так что чужой `.lock` не удалится при выходе, но взаимное исключение внутри
критической секции уже нарушено. Для файлов на облачном диске 5 с мало.

### C-3. `appendEvent` перечитывает весь `events.jsonl` на каждую запись

`workspace-store.js:410-424` — проверка идемпотентности построчно парсит весь
журнал перед каждым добавлением. O(n) на запись, O(n²) за сессию, и журнал растёт
(компакция ручная). Достаточно индекса последних N `eventId` или отдельного файла
с уже виденными id.

### C-4. ~~`font-engine` читает по 2 МБ с каждого системного шрифта синхронно~~ — ИСПРАВЛЕНО

`extension/com.pard.defender/client/font-engine.js:125-131`

```js
var readLen = Math.min(stat.size, 2097152); // read up to 2MB header
var buf = Buffer.alloc(readLen);
fd = fs.openSync(filePath, "r");
fs.readSync(fd, buf, 0, readLen, 0);
```

Это вызывается для **каждого** `.ttf/.otf/.ttc` в `C:\Windows\Fonts`,
`%LOCALAPPDATA%\…\Fonts` и `%APPDATA%\Adobe\Fonts` — обычно 400–1 500 файлов. До
2 ГБ синхронного чтения при построении индекса, с полной блокировкой панели.

При этом нужна-то только таблица `name`: её смещение лежит в первых
`12 + 16 × numTables` байтах, то есть хватает чтения ~4 КБ, а затем точечного
чтения самой таблицы (код для второго случая уже написан — ветка «Name table
beyond 2MB buffer»). Это самая очевидная оптимизация во всём проекте.

Там же синхронно и дважды запускается `reg query` через `execSync` с таймаутом
4 с (`font-engine.js:197-205`).

### C-5. ~~Квадратичные проходы в хосте AE~~ — ИСПРАВЛЕНО

Все эти функции линейно сканируют `app.project.numItems`, и все они вызываются в цикле:

| Функция | Где | Сложность |
|---|---|---|
| `host.findItemById` | `PardDefenderApply.jsx:845` | O(n) на вызов |
| `panelEligible` для комп | `PardDefenderAudit.jsx:870-875` | O(комп × n) — `findItemById` в цикле |
| `childFolderNamed` / `ensureFolderPath` | `PardDefenderApply.jsx:625` | O(сегментов × n) на каждый move |
| `isEmptyFolder` в `pruneEmptyManagedFolders` | `PardDefenderApply.jsx:751` | **O(6 × n²)** — до 6 проходов, внутри скан всех элементов на каждую папку |
| `layeredUsages` | `PardDefenderApply.jsx:207` | O(комп × слоёв) на каждый элемент группы |
| `hasChildren` | `PardDefenderLayers.jsx:233` | O(слоёв) на каждого кандидата |

`pruneEmptyManagedFolders` — худший: на проекте в 5 000 элементов это ~150 млн
итераций в ExtendScript, то есть минуты. И он вызывается при каждом
`organizeFromFile` с `prune: true`, то есть в каждом проходе раскладки.

Лечится одним предпроходом: собрать `{id → item}`, `{folder → [children]}` и
`{parent+name → folder}` один раз за вызов и считать по карте. Без изменения
поведения.

### C-6. Аудит AE делает файловый I/O на каждый аудиофайл в каждом проходе

`PardDefenderAudit.jsx:616-636` — для каждого аудиоэлемента создаётся до 8
объектов `File` и проверяется `.exists`:

```js
var audioCandidates = [ "03_audio/voice/"+n, "03_audio/music/"+n, …, "03_audio/"+n ];
for (…) { var cTestFile = new File(report.workspace + "/" + audioCandidates[aci]); if (cTestFile.exists) …
```

Плюс `collectProjectFonts(app.project)` обходит все слои всех композиций и читает
`Source Text` и все его ключи — и тоже на **каждом** аудите, не только когда
владелец открыл вкладку шрифтов. Аудит идёт по таймеру `scanIntervalMs`
(по умолчанию 3 мин). Сбор шрифтов стоит вынести из `host.audit` и звать только
из `scanFontsToFile`, который уже существует.

### C-7. ~~Рекурсия без разрыва стека в `duplicate-index`~~ — ИСПРАВЛЕНО (вместе с B-2)

`duplicate-index.js:368-375` — при попадании в кэш `processNextFile()` зовёт себя
**синхронно**:

```js
if (cached && cached.size === item.size && cached.mtimeMs === item.mtimeMs && cached.sha256) {
    item.sha256 = cached.sha256;
    …
    processNextFile();   // синхронный рекурсивный вызов
    return;
}
```

То же в `nextFrame()` (строка 452) для кадров секвенции. На прогретом кэше это
~2 кадра стека на файл: 5 000 файлов (или одна секвенция на 5 000 кадров) —
`RangeError: Maximum call stack size exceeded`. Разрывается одним
`setTimeout(processNextFile, 0)` раз в N итераций.

### C-8. Файлы больше 1 ГБ не дедуплицируются и копируются повторно

`copy-queue.js:33` — `HASH_LIMIT_BYTES = 1073741824`. `hashFile` для файла больше
гигабайта возвращает `null`, `resolveDestination` уходит в ветку `rename` и
создаёт `clip (2).mov`. Для BRAW/R3D/ProRes это норма размера. На Яндекс.Диске
каждая такая копия — полная повторная выгрузка в облако.

Дешёвое улучшение: хэшировать не весь файл, а первые/последние 8 МБ + размер
(«быстрый отпечаток») и полный SHA-256 считать только при совпадении отпечатка.
Premiere, кстати, лимита не имеет вообще — ещё одно расхождение между хостами.

### C-9. Фиксированные имена во временной папке

`main.js:100` — `tempRoot()` = `%TEMP%/parddefender-client`, и в нём всегда одни
и те же имена: `relink-plan.json`, `panel-plan.json`, `remove-plan.json`.
`housekeeping.js:108` — `recycle-list.txt`, `recycle.ps1`, `pin.ps1` там же.

Опаснее всех `recycle-list.txt`: он управляет удалением, а перезаписывается по
фиксированному пути. Два одновременных действия (две копии AE, или AE и что-то
ещё) — и PowerShell читает не тот список. Решается суффиксом как у `.pdpart`.

---

## D. Мелкое и косметическое

| # | Файл:строка | Что |
|---|---|---|
| D-1 | `PardDefenderPlan.jsx:196` | `var out = defaults` — `out` и `defaults` это **один объект**. Поэтому `out.sectionLabel = defaults.sectionLabel` при коллизии с `pinLabel` — no-op, и срабатывает следующая строка `= 0`. Если владелец поставит `pinLabel: 10`, цвет-метка SECTION отключится совсем вместо возврата к умолчанию. |
| D-2 | `copy-engine.js:1508-1513` (Premiere) | `changeMediaFilePath(pCand, false)` вызван **дважды с одинаковыми аргументами**. По аналогии с веткой `changeMediaPath` (`true`, `1`, без аргумента) второй вызов должен быть с `true`. Вариант с `true` не пробуется никогда. |
| D-3 | `main.js:755-765` (Premiere) | `mPath = cand.getMediaFilePath()` **без `await`** в резервном поиске клипа по пути. В UXP это Promise, `normalizePath(Promise)` даёт `"[object promise]"` — резервный поиск мёртв, и при промахе `pMap[id]` получается «Элемент не найден для перелинковки». Рядом, в `duplicates.js`, тот же вызов везде с `await`. |
| D-4 | `consolidation.js:299` | `destFolder = normWs + "/01_assets/_SHARED/VIDEO"`, `category: "video"` — **для любого** каноникала вне рабочей папки. PSD, WAV, OBJ уедут в `VIDEO` и так же запишутся в `assets.tsv`. |
| D-5 | `consolidation.js:386` | `failMap[failures[f].id]` — ключ по `id`, а не по `key`. Один элемент может дать две записи (сам и его прокси) с одним `id`. |
| D-6 | `consolidation.js:380` | `var relinkedMap = {}` объявлен и не используется. |
| D-7 | `adapter.js:2103` (Premiere) | `api.commitRelinks` — заглушка: «In Task 007 … simulates/stubs», рапортует `relinked` для любой корректной записи плана, не трогая проект. Вызовов в продакшене нет (реальный relink идёт через `copy-engine.relinkClip`) — то есть это мёртвый код, который при случайном вызове соврёт. |
| D-8 | `copy-engine.js:60`, `duplicates.js:28` (Premiere) | `var isWin = (…) \|\| (…) \|\| true;` — выражение всегда `true`, разделитель всегда `\`. На macOS fallback-`path` даст обратные слеши. Для Windows-владельца безвредно, но это не то, что написано в комментарии. |
| D-9 | `PardDefenderLayers.jsx:302` | Находка «композиция-сирота» добавляется **без** проверки `MAX_FINDINGS`, в отличие от находок по слоям. Список может превысить 200. |
| D-10 | `issues.js:40` | Комментарий «Attempt 1 is immediate», но `RETRY_STEPS[Math.min(record.attempts, …)]` при `attempts === 1` даёт 60 000 мс. Первая повторная попытка не мгновенная. |
| D-11 | `issues.js:177` | `record.ignored = false` на каждом новом совпадающем сбое — скрытая владельцем строка возвращается сама. |
| D-12 | `sync-coordinator.js:342` (AE) | `unlinkSync` + `renameSync` в «crash-safe atomic swap». Между ними журнала нет. `renameSync` поверх существующего файла на Windows в современном Node работает, так что `unlink` не нужен и именно он ломает атомарность. Та же пара в `publishSnapshot:103`. |
| D-13 | `verify.js:160` | `candidates` пересобирается на каждый `sweep`, а `cursor` — индекс в этом массиве. Состав элементов между проходами меняется → часть файлов пропускается, часть проверяется дважды. |
| D-14 | `updater.js:159` | `isAllowedHost` пускает любой `*.amazonaws.com`. Белый список хостов в остальном строгий и на редиректах соблюдается (`parseUrl` → `isAllowedHost`), это единственная широкая маска. |
| D-15 | `font-engine.js:377` | Залипший `fonts.lock` после краха блокирует сбор шрифтов навсегда — проверки давности, как у `withLock`, нет. Текст ошибки честно это объясняет, так что скорее задел на доработку, чем баг. |
| D-16 | `copy-queue.js:385` | Метрика прогресса для детектора зависания считает **прочитанные** байты (`readStream.on("data")`), а не записанные. На практике backpressure это выравнивает, но при зависании только на записи сработает позже, чем хотелось. |
| D-17 | `Audit.jsx` (вся функция `audit`), `adapter.js:622-2086` | `api.auditMedia` в Premiere — одна функция на **1 464 строки**. Самый тяжёлый кандидат на разбиение перед любыми оптимизациями. |
| D-18 | `main.js:186` (AE) | `var key` объявлен дважды в `refreshTracking`. |

---

## E. Что работает правильно и трогать не надо

Отмечаю отдельно, чтобы при оптимизации это не сломали:

- **Правила 1–9 из `CLAUDE.md` соблюдены**, кроме A-1 (правило 1 и 6 в одном месте)
  и отсутствия у Premiere аналога защиты рабочей папки (A-2).
- `copy-queue.copyOne` — `.pdpart` со случайным именем, сверка размера,
  `renameSync` на место, откат при любой ошибке, сохранение mtime. Ровно по правилу 6.
- `premiere/copy-engine.copyVerified` — **строже** AE: сверяет хэш источника до и
  после, `mtimeMs` источника, размер и хэш части, перепроверяет отсутствие
  назначения перед `rename`, пишет provenance в `assets.tsv` до relink и только
  потом вычищает строку журнала. Это образец, по которому стоит выровнять AE.
- `premiere/duplicates.consolidateGroup` — перепроверяет **каждый** файл и
  **каждую** живую ссылку проекта до первой мутации, требует каноникал AE, если он
  в группе есть, и никогда не удаляет файлы. Правило 5 соблюдено.
- `PardDefenderApply.relinkLayeredGroup` — валидация до импорта, подготовка всего
  отображения до первого изменения, откат заменённых слоёв при ошибке, отказ
  удалять оригинал, у которого остались ссылки, очистка только импортированного
  в `finally`. Это самый аккуратный код в проекте.
- `captureInterpretation` / `restoreInterpretation` / `captureProxy` / `restoreProxy` —
  каждое свойство в своём `try`, порядок `alphaMode` → `premulColor` соблюдён.
- `host.auditToFile` — отчёт через файл, а не через возврат `evalScript`. Правило
  из `CLAUDE.md` про сотни килобайт соблюдено.
- `housekeeping.revealFile` — сырая командная строка через `exec` с кавычками
  только вокруг пути, плюс `looksInjectable` на `"` и `%`. Урок про `explorer.exe`
  усвоен.
- `disk-space` — `fs.statfs` → `fsutil` (по позиции, не по подписи) → `df`, без
  `wmic`. Правильно для Windows 11 24H2+.
- `updater` — белый список хостов проверяется и на редиректах, `MAX_BODY_BYTES`
  ограничивает ответ, токенов в коде нет. Правило 9 соблюдено.
- Защита от цикла аудитов (`panelPath` vs `panelTarget` в `buildPanelMoves`),
  дисциплина перерисовки (`changed()`/`painted`), `[hidden] { display: none !important; }` —
  всё на месте, уроки живых прогонов не откатились.

---

## F. Предлагаемый порядок работ

**Сначала безопасность (ломает данные):**

1. A-1 — переписать внутреннее перемещение в `/unused` по образцу
   `runPass`: сверка по хэшу вместо размера, relink **до** того, как тронут
   оригинал, остаток только в Корзину через `PardHousekeeping.recycle`, случайное
   имя `.pdpart`, удаление `pending.tsv` после прохода.
2. A-2 — перенести `unsafeWorkspaceReason` в Premiere.
3. B-3 — развести журналы: `pending-ae.tsv` / `pending-premiere.tsv`, либо
   один формат с колонкой хоста и удалением только своих строк и только своих `.pdpart`.

**Потом «не работает» (быстро и локально):**

4. B-1 — добавить `removeItemsFromFileJson` (3 строки) + тест, который зовёт метод
   на реальном хосте через мок, а не сверяет строку скрипта.
5. B-5 — проверять `parsed.ok` в `executeRelink`.
6. B-6 — обернуть поля события в `payload`.
7. B-7 — зарегистрировать 4 кода; `CONSOLIDATE_*` не должны звать `trip()`
   (неудача ручной операции не повод останавливать автоматический режим).
8. B-4 — вызвать `recoverPending` в `init()` Premiere.
9. B-2 — согласовать форму дескриптора секвенции между хостом AE и
   `duplicate-index`.

**Затем производительность (по убыванию выигрыша):**

10. C-4 — читать 4 КБ заголовка шрифта вместо 2 МБ. Самый большой выигрыш на старте.
11. C-5 — предпроходные карты в хосте AE; начать с `pruneEmptyManagedFolders` (O(n²)).
12. C-6 — вынести `collectProjectFonts` из `host.audit`; кэшировать результат
    аудиопроверок между проходами.
13. C-2 — заменить busy-wait на асинхронную блокировку; поднять `staleMs` для
    облачного диска.
14. C-3 — индекс `eventId` вместо перечитывания журнала.
15. C-7 — разорвать синхронную рекурсию.
16. C-8 — быстрый отпечаток вместо отказа от дедупликации на >1 ГБ.
17. C-1 — единый `resolveWorkspace` для обоих хостов.
18. D-17 — разбить `auditMedia` (1 464 строки) перед дальнейшими правками Premiere.

**Мелкое — одной пачкой:** D-1…D-18.

---

## G. Риски и что не проверено

- Аудит **только по чтению кода**. Ни Adobe-приложение не запускалось, ни один
  сценарий не проверялся на живом проекте.
- A-1, B-1, B-2, B-4, B-7, D-3 подтверждены инструментально (запуск кода, grep,
  сверка API хоста на моке). Остальное — чтение кода; поведение реального
  ExtendScript и реального UXP может отличаться от ожидаемого.
- Не разбирались подробно: `styles.css` (1 668 + 833 строк), `renderItems`
  и прочая отрисовка Premiere, `tools/*`, `INSTALL_DEV_WINDOWS.bat`,
  `deploy-local.js` (у него и в карте стоит `status: partial`).
- `premiere/adapter.js:622-2086` (`auditMedia`) прочитан выборочно: разобраны
  `resolveWorkspace`, `isBinNode`, `resolveChildren`, `isInProjectMediaFolder`,
  работа с `assets.tsv` и снапшотами. Середина функции (обход bin-дерева,
  классификация, определение использования на таймлайне) просмотрена не построчно.
- Оценки сложности в C-5 — аналитические, не измеренные профилировщиком.
