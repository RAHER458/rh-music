# RH Neural AI — Reference Annotation & iPhone Validation Report

## 1. Что реализовано

- Отдельная ветка `reference-annotation-validation`.
- Инструмент ручной разметки:
  - `web/ai-automix/annotation.html`
  - `web/ai-automix/annotation.js`
  - `web/ai-automix/annotation.css`
  - `web/ai-automix/reference-schema.js`
- Формат Reference Annotation `schema_version 1.0`.
- Метрики reference comparison в `validation-metrics.js`:
  - Tempo accuracy;
  - Beat precision/recall/F1 при ±50/70/100 ms;
  - Downbeat F1;
  - Phase median/mean/p95;
  - Grid stability;
  - Confidence calibration bins.
- Validation dashboard с загрузкой Reference JSON и колонками F1 по источникам.
- Unit-тесты:
  - `tests/reference-schema.test.mjs`
  - `tests/beat-this-consensus.test.mjs`
  - `tests/planner-intelligence.test.mjs`

## 2. Что НЕ реализовано

- **Реальная ручная разметка не создана.** В этой среде нет возможности прослушивать музыку, поэтому я не могу независимо расставить beats/downbeats. Инструмент готов, но аннотации должны быть сделаны человеком.
- **Нет независимого Ground Truth**, поэтому reference-based метрики не измерены.
- **Нет второго annotator**, inter-annotator agreement не проверялся.
- **iPhone Safari не тестировался** — реального устройства у агента нет.
- **Aggregate metrics по корпусу не сформированы**.
- **A/B planner и blind listening** не выполнены.
- **Не менялись** consensus, Transition Planner, плеер, Production.

## 3. Архитектура Annotation System

```text
annotation.html
  → annotation.js
       → reference-schema.js (schema, add/remove/normalize, tempo segments)
       → IndexedDB rh_reference_annotations
       → JSON import/export
```

Интерфейс разметки:

- waveform;
- zoom in/out;
- pan;
- click-to-seek;
- play/pause;
- step ±1s / ±5s;
- переход к следующему/предыдущему beat;
- Tap Beat;
- Tap Downbeat;
- Undo;
- Delete nearest;
- Loop A/B;
- Save;
- Export JSON;
- Import JSON;
- Clear.

В интерфейсе разметки **не отображаются** Neural AI, PulseGrid, Beat This, consensus и confidence.

## 4. Формат Reference Annotation

```json
{
  "schema_version": "1.0",
  "track_id": "track_001",
  "title": "",
  "source": "local",
  "duration_seconds": 214.35,
  "annotation_status": "in_progress",
  "annotator_id": "annotator_1",
  "bpm_estimate": 124.0,
  "beats": [0.482, 0.965, 1.448],
  "downbeats": [0.482, 2.413],
  "tempo_segments": [{"start": 0, "end": 214.35, "bpm": 124.0}],
  "uncertain_regions": [],
  "notes": "",
  "created_at": "",
  "updated_at": ""
}
```

Формат поддерживает переменный темп, несколько tempo segments, uncertain regions, повторную разметку и версионирование.

## 5. Состав корпуса

`docs/validation-corpus.json`:

```text
30 real Zvuk tracks
103–420 s
House / Deep House / Tech House / Progressive / Trance /
Drum & Bass / Techno / Hip-Hop / Pop / Rock / Funk-Disco
reference annotations: none yet
```

## 6. Количество размеченных треков

```text
0 из 10 минимально требуемых
0 из 20 целевых
0 из 30 расширенных
```

Причина: разметка требует человеческого прослушивания; агент не может заменить аннотатора.

## 7. Методология разметки

Предусмотрена ручная разметка по слуху с waveform как вспомогательным визуальным инструментом. Автоматические анализаторы в процессе разметки скрыты. Документация метода встроена в инструмент.

## 8. Независимость Ground Truth

Не подтверждена, потому что разметка не создана. Инструмент структурно исключает подсказки анализаторов, но это лишь условие независимости, а не доказательство.

## 9–13. Результаты Neural AI / PulseGrid / Beat This / Consensus / Aggregate

Reference-based результаты отсутствуют. Ранее измеренные exploratory данные (без ground truth):

```text
Neural AI:  123.62 BPM · conf 0.396
PulseGrid:  124.10 BPM · conf 0.99
Beat This:  125.00 BPM · conf 0.98 (20 s real segment, 42 beats, 11 downbeats, 5478 ms worker)
```

Консенсус-тесты:

```text
124 + 125 → 124.71 · conf 0.98
100 vs 150 → альтернативы сохранены, confidence снижен
```

## 14. Tempo accuracy

Reference-based: **не измерена**.

## 15. Beat F1

Reference-based: **не измерена**.

## 16. Downbeat F1

Reference-based: **не измерена**.

## 17. Phase error

Reference-based: **не измерена**. Unit-тест consensus дал phase error 0.000 s на синтетике; тест metrics дал median 20 ms на синтетическом смещении.

## 18. Timing error

Реализованы median и p95 в `matchEvents`; на реальной музыке не измерены.

## 19. Grid stability

Реализована; на реальной музыке в рамках этого этапа не измерена.

## 20. Confidence analysis

Реализованы confidence bins в `confidenceCalibration`; данных для калибровки нет.

## 21. Failed tracks

Причина отсутствия результатов — не отказы анализаторов, а отсутствие reference-разметки. Ранее зафиксированные инженерные проблемы:

- Zvuk stream download: 154–210 s на один трек;
- validation-прогон не удерживался браузером достаточно долго;
- PulseGrid worker path для validation-страницы исправлен на абсолютный.

## 22. iPhone testing

Не выполнено. Сценарий для пользователя:

1. Открыть `https://rh-music-reference-preview.pages.dev/ai-automix/annotation.html`.
2. Загрузить короткий трек и разметить 10–20 beats/downbeats.
3. Экспортировать JSON.
4. Открыть `https://rh-music-reference-preview.pages.dev/ai-automix/validation.html`.
5. Загрузить экспортированный Reference JSON.
6. Запустить Run corpus и выгрузить результат.

## 23. Performance

Ранее измеренное:

```text
Beat This cold + 1 s: 2163 ms
Beat This 20 s worker: 5478 ms
```

iPhone performance не измерена.

## 24. Known limitations

- нет ground truth;
- нет второго annotator;
- валидация неполная;
- iPhone не проверен;
- Aggregate report не построен;
- A/B planner и blind listening не выполнены.

## 25. Regression test results

```text
reference-schema.test.mjs          passed
reference metrics synthetic test   passed (F1 1.0, median phase 20 ms)
beat-this-consensus.test.mjs       passed
planner-intelligence.test.mjs      passed
```

Production-файлы не изменялись.

## 26. Commit hash

```text
reference-annotation-validation branch
checkpoint base: dc41345
```

Actual commit after this work is recorded at the end of the deployment step.

## 27. Preview URL

```text
Validation:
https://rh-music-reference-preview.pages.dev/ai-automix/validation.html

Annotation:
https://rh-music-reference-preview.pages.dev/ai-automix/annotation.html
```

## 28. Инструкции по тестированию

См. раздел 22. Для desktop можно размечать клавишами B (beat) и D (downbeat).

## 29. Проблемы для дальнейшей работы

1. Создать минимум 10 полностью размеченных треков человеком.
2. Провести повторную разметку 5–10 треков вторым annotator.
3. Запустить reference comparison на iPhone.
4. Сформировать aggregate report.
5. Только после этого запускать A/B planner.
