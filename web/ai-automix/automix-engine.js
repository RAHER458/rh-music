const MODULE$1 = 'core/analyzer';
const VERSION$1 = 'phase-3-heuristic';
function source$1(field, timestamp) {
    return { source: 'algorithmic', module: MODULE$1, version: VERSION$1, timestamp, sourceField: field };
}
function value(input, field, timestamp, options = {}) {
    const available = input !== null && input !== undefined;
    return {
        value: available ? input : null,
        normalized: options.normalized ?? null,
        availability: options.availability ?? (available ? 'available' : 'unavailable'),
        provenance: available ? source$1(field, timestamp) : null,
        confidence: options.confidence == null ? null : options.confidence,
        notes: options.notes ? [...options.notes] : [],
    };
}
function fromTrackAnalysis(analysis, timestamp = Date.now()) {
    const bpmAvailable = typeof analysis.bpm === 'number' && Number.isFinite(analysis.bpm) && analysis.bpm > 0;
    const bpmConfidence = bpmAvailable && Number.isFinite(analysis.bpmConfidence) ? analysis.bpmConfidence : null;
    const meterAvailable = !!analysis.meter && analysis.meter.beatsPerBar != null;
    const keyAvailable = !!analysis.key;
    const sections = Array.isArray(analysis.sections) ? analysis.sections : [];
    const notes = [];
    if (analysis.bpmConfidence < 0.15)
        notes.push('Низкая уверенность BPM');
    if (analysis.keyConfidence < 0.08)
        notes.push('Низкая уверенность тональности');
    const energy = Number.isFinite(analysis.intensity) ? analysis.intensity : null;
    return {
        bpm: value(bpmAvailable ? analysis.bpm : null, 'bpm', timestamp, { confidence: bpmConfidence, notes }),
        bpmConfidence,
        tempoStability: value(analysis.tempoStability, 'tempoStability', timestamp),
        tempoMap: value(analysis.tempoMap && analysis.tempoMap.points.length ? analysis.tempoMap : null, 'tempoMap', timestamp),
        beatGrid: value(analysis.grid, 'grid', timestamp, { confidence: analysis.grid?.confidence ?? null }),
        meter: value(meterAvailable ? analysis.meter : null, 'meter', timestamp, {
            confidence: analysis.meter?.confidence ?? null,
            availability: meterAvailable ? 'available' : 'unsupported',
            notes: meterAvailable ? [] : ['Метр не определён с достаточной уверенностью'],
        }),
        key: value(keyAvailable ? analysis.key : null, 'key', timestamp, { confidence: analysis.keyConfidence }),
        camelot: value(analysis.camelot, 'camelot', timestamp, { confidence: analysis.keyConfidence }),
        keyConfidence: keyAvailable ? analysis.keyConfidence : null,
        sections: value(sections.length ? sections : null, 'sections', timestamp),
        cues: value(analysis.cues, 'cues', timestamp),
        energy: value(energy, 'intensity', timestamp, { normalized: energy, notes: ['intensity — эвристическая оценка 0..1'] }),
        loudness: value(analysis.loudness, 'loudness', timestamp),
        spectrum: value(analysis.spectrum, 'spectrum', timestamp),
        bands: value(analysis.bands, 'bands', timestamp),
        vocal: value(analysis.vocal, 'vocal', timestamp),
        genre: value(analysis.genre && analysis.genre.label !== 'unknown' ? analysis.genre : null, 'genre', timestamp, {
            confidence: analysis.genre?.confidence ?? null,
            availability: analysis.genre && analysis.genre.label !== 'unknown' ? 'available' : 'unsupported',
            notes: analysis.genre && analysis.genre.label !== 'unknown' ? ['Эвристическая жанровая оценка; не neural prediction'] : ['Жанр не определён'],
        }),
        instruments: value(analysis.instruments && Object.keys(analysis.instruments).length ? analysis.instruments : null, 'instruments', timestamp, {
            notes: ['Эвристическая оценка инструментов; не neural prediction'],
        }),
        rhythmMode: value(analysis.rhythmMode, 'rhythmMode', timestamp),
        intensity: value(analysis.intensity, 'intensity', timestamp),
        transientDensity: value(analysis.transientDensity, 'transientDensity', timestamp, { normalized: analysis.transientDensity }),
        vocalLikelihood: value(analysis.vocalLikelihood, 'vocalLikelihood', timestamp, { normalized: analysis.vocalLikelihood }),
        instrumentalLikelihood: value(analysis.instrumentalLikelihood, 'instrumentalLikelihood', timestamp, { normalized: analysis.instrumentalLikelihood }),
        warnings: [...analysis.warnings],
        provenance: source$1('TrackAnalysis', timestamp),
    };
}

const MODULE = 'neural/perception/yamnet';
const VERSION = 'phase-4.3-yamnet';
function source(timestamp, modelId, modelVersion, artifactHash, runtime, field) {
    return {
        source: 'neural',
        module: MODULE,
        version: VERSION,
        timestamp,
        modelId,
        modelVersion,
        artifactHash: artifactHash || undefined,
        runtime,
        sourceField: field,
    };
}
function topFromScores(scores, labels, limit = 10) {
    if (!scores || !scores.length)
        return [];
    const ranked = [];
    for (let i = 0; i < scores.length; i += 1) {
        ranked.push({
            classId: i,
            label: labels?.[i] || `class-${i}`,
            rawScore: scores[i],
            aggregatedScore: scores[i],
            segmentIndex: null,
        });
    }
    ranked.sort((a, b) => b.aggregatedScore - a.aggregatedScore || a.classId - b.classId);
    return ranked.slice(0, Math.max(1, Math.min(32, limit)));
}
function fromYamnetResult(result, options = {}) {
    const timestamp = options.timestamp ?? Date.now();
    const artifactHash = options.artifactHash ?? null;
    const runtime = options.runtime ?? 'onnx-wasm';
    const labels = result.labels;
    const segments = (result.segmentResults || []).map((segment) => ({
        index: segment.segmentIndex,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        top: topFromScores(segment.scores, labels, options.segmentTopK ?? 10),
        scores: segment.scores,
        embedding: segment.embedding,
        embeddingDimension: segment.embedding?.length ?? null,
        provenance: source(timestamp, result.modelId, result.modelVersion, artifactHash, runtime, `segment:${segment.segmentIndex}`),
    }));
    return {
        modelId: result.modelId,
        modelVersion: result.modelVersion,
        artifactHash,
        runtime,
        classes: result.classes,
        top: result.top,
        aggregate: result.aggregate?.scores ?? null,
        embeddings: result.embeddings,
        embeddingDimension: result.embeddings?.length ?? null,
        segments,
        timing: result.timing,
        warnings: [...result.warnings],
        provenance: source(timestamp, result.modelId, result.modelVersion, artifactHash, runtime, 'YamnetResult'),
    };
}

class ContextError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ContextError';
        this.code = code;
        this.details = details;
    }
}

const EPSILON = 1e-4;
const DEFAULT_MAX_SEGMENTS = 2048;
function addBoundary(boundaries, value, duration) {
    if (!Number.isFinite(value))
        return;
    const clamped = Math.min(duration, Math.max(0, value));
    boundaries.push(clamped);
}
function dedupeSorted(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const result = [];
    for (const value of sorted)
        if (!result.length || value - result[result.length - 1] > EPSILON)
            result.push(value);
    return result;
}
function decimate(boundaries, maxSegments, duration, sections) {
    if (boundaries.length - 1 <= maxSegments)
        return { boundaries, truncated: false };
    const mustKeep = new Set([0, duration]);
    for (const section of sections) {
        mustKeep.add(Math.min(duration, Math.max(0, section.start)));
        mustKeep.add(Math.min(duration, Math.max(0, section.end)));
    }
    const required = [...mustKeep].sort((a, b) => a - b);
    const remaining = boundaries.filter((value) => !required.some((entry) => Math.abs(entry - value) <= EPSILON));
    const budget = Math.max(0, maxSegments - Math.max(1, required.length - 1));
    const step = Math.max(1, Math.ceil(remaining.length / Math.max(1, budget)));
    const selected = [...required];
    for (let i = 0; i < remaining.length && selected.length < maxSegments + 1; i += step)
        selected.push(remaining[i]);
    return { boundaries: dedupeSorted(selected), truncated: true };
}
function overlap(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
function bestSection(sections, start, end) {
    let best = null;
    let bestOverlap = 0;
    for (const section of sections) {
        const value = overlap(start, end, section.start, section.end);
        if (value > bestOverlap) {
            best = section;
            bestOverlap = value;
        }
    }
    return best;
}
function bestNeural(segments, start, end) {
    let best = null;
    let bestOverlap = 0;
    for (const segment of segments) {
        const value = overlap(start, end, segment.startSeconds, segment.endSeconds);
        if (value > bestOverlap) {
            best = segment;
            bestOverlap = value;
        }
    }
    if (!best)
        return null;
    return { segment: best, coverage: bestOverlap / Math.max(EPSILON, end - start) };
}
function buildTimeline(input) {
    const duration = Math.max(0, input.duration);
    const maxSegments = Math.max(1, input.maxSegments ?? DEFAULT_MAX_SEGMENTS);
    const boundaries = [0, duration];
    for (const section of input.sections) {
        addBoundary(boundaries, section.start, duration);
        addBoundary(boundaries, section.end, duration);
    }
    for (const segment of input.neuralSegments) {
        addBoundary(boundaries, segment.startSeconds, duration);
        addBoundary(boundaries, segment.endSeconds, duration);
    }
    let sorted = dedupeSorted(boundaries);
    const decimated = decimate(sorted, maxSegments, duration, input.sections);
    sorted = decimated.boundaries;
    const segments = [];
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i += 1) {
        const start = sorted[i];
        const end = sorted[i + 1];
        if (end - start <= EPSILON)
            continue;
        const section = bestSection(input.sections, start, end);
        const neural = bestNeural(input.neuralSegments, start, end);
        const beats = input.grid?.beats?.filter((time) => time >= start - EPSILON && time < end - EPSILON) ?? [];
        const provenance = [];
        if (section && input.algorithmicProvenance)
            provenance.push(input.algorithmicProvenance);
        if (neural && input.neuralProvenance)
            provenance.push(input.neuralProvenance);
        const availability = section && neural ? 'aligned' : section ? 'algorithmic-only' : neural ? 'neural-only' : 'gap';
        const notes = [];
        if (neural && neural.coverage < 0.5)
            notes.push(`neural overlap ${Math.round(neural.coverage * 100)}%`);
        if (section && section.confidence < 0.35)
            notes.push('low algorithmic section confidence');
        const segment = {
            id: `seg-${i}`,
            index: i,
            start,
            end,
            sectionKind: section?.kind ?? null,
            sectionEnergy: section?.energy ?? null,
            sectionConfidence: section?.confidence ?? null,
            beatCount: beats.length,
            firstBeat: beats[0] ?? null,
            lastBeat: beats[beats.length - 1] ?? null,
            neuralSegmentIndex: neural?.segment.index ?? null,
            neuralTop: neural?.segment.top ?? [],
            neuralEmbeddingDimension: neural?.segment.embeddingDimension ?? null,
            availability,
            provenance,
            alignmentNotes: notes,
        };
        segments.push(segment);
        if (availability === 'gap')
            gaps.push({ start, end });
    }
    let algorithmicCoverage = 0;
    let neuralCoverage = 0;
    let alignedCoverage = 0;
    let gapCoverage = 0;
    for (const segment of segments) {
        const length = segment.end - segment.start;
        if (segment.sectionKind !== null)
            algorithmicCoverage += length;
        if (segment.neuralSegmentIndex !== null)
            neuralCoverage += length;
        if (segment.availability === 'aligned')
            alignedCoverage += length;
        if (segment.availability === 'gap')
            gapCoverage += length;
    }
    const round = (value) => Math.round((duration > 0 ? value / duration : 0) * 1000) / 1000;
    return {
        duration,
        segments,
        gaps,
        coverage: {
            algorithmic: round(algorithmicCoverage),
            neural: round(neuralCoverage),
            aligned: round(alignedCoverage),
            gap: round(gapCoverage),
        },
        alignment: {
            strategy: 'boundary-union',
            algorithmic: input.sections.length ? 'native' : 'absent',
            neural: input.neuralSegments.length ? 'native' : 'absent',
            truncated: decimated.truncated,
            segmentCount: segments.length,
        },
    };
}

const CONTEXT_SCHEMA_VERSION = 1;
const CONTEXT_SCHEMA = 'rh-unified-musical-context';

/** Clamp to 0..1 only for values whose source explicitly defines that range. */
function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function derivedValue(value, field, provenance, confidence = null, notes = []) {
    return {
        value,
        availability: value === null ? 'unsupported' : 'available',
        provenance: value === null ? null : { ...provenance, source: 'derived', sourceField: field, derivation: field },
        confidence,
        notes,
    };
}
function acousticProfile(algorithmic, neuralTop, neuralProvenance) {
    const spectrum = algorithmic?.spectrum.value;
    const loudness = algorithmic?.loudness.value;
    const source = algorithmic?.provenance ?? null;
    const derived = (value, field, notes = []) => {
        if (!source)
            return { value: null, availability: 'unavailable', provenance: null, confidence: null, notes: ['No algorithmic analysis'] };
        return derivedValue(value, field, source, null, notes);
    };
    return {
        energy: algorithmic?.energy ?? { value: null, availability: 'unavailable', provenance: null, confidence: null, notes: ['No algorithmic analysis'] },
        brightnessHz: derived(spectrum?.centroid ?? null, 'spectrum.centroid'),
        spectralFlatness: derived(spectrum?.flatness ?? null, 'spectrum.flatness'),
        dynamicRange: derived(loudness?.dynamicRange ?? null, 'loudness.dynamicRange'),
        loudnessLufs: derived(loudness?.lufsEstimate ?? null, 'loudness.lufsEstimate', ['Estimate, not certified BS.1770']),
        transientDensity: algorithmic?.transientDensity ?? derived(null, 'transientDensity'),
        vocalLikelihood: algorithmic?.vocalLikelihood ?? derived(null, 'vocalLikelihood'),
        instrumentalLikelihood: algorithmic?.instrumentalLikelihood ?? derived(null, 'instrumentalLikelihood'),
        texture: { value: null, availability: 'unsupported', provenance: null, confidence: null, notes: ['No texture model in Phase 4.4'] },
        density: { value: null, availability: 'unsupported', provenance: null, confidence: null, notes: ['No density model in Phase 4.4'] },
        neuralEvents: {
            value: neuralTop.length ? neuralTop : null,
            availability: neuralTop.length ? 'available' : 'unavailable',
            provenance: neuralTop.length ? neuralProvenance : null,
            confidence: null,
            notes: ['AudioSet event scores; not calibrated probabilities'],
        },
    };
}
function makeConflict(kind, severity, sources, message, details = {}) {
    return { kind, severity, sources, message, details };
}
function completenessOf(context) {
    let score = 0;
    if (context.algorithmic)
        score += 0.2;
    if (context.algorithmic?.bpm.value != null)
        score += 0.1;
    if (context.algorithmic?.key.value != null)
        score += 0.1;
    if (context.algorithmic?.sections.value?.length)
        score += 0.1;
    if (context.algorithmic?.beatGrid.value != null)
        score += 0.1;
    if (context.algorithmic?.energy.value != null)
        score += 0.05;
    if (context.neural)
        score += 0.2;
    if (context.neural?.top.length)
        score += 0.05;
    if (context.neural?.segments.length)
        score += 0.05;
    if (context.neural?.embeddings)
        score += 0.05;
    return Math.round(Math.min(1, score) * 100) / 100;
}
function buildUnifiedContext(input) {
    if (input.signal?.aborted)
        throw new ContextError('cancelled', 'Context build was cancelled');
    if (!input.algorithmic && !input.neural)
        throw new ContextError('no-sources', 'At least one analysis source is required');
    const started = Date.now();
    const analyzedAt = input.analyzedAt ?? Date.now();
    const algorithmic = input.algorithmic ? fromTrackAnalysis(input.algorithmic, analyzedAt) : null;
    const neural = input.neural ? fromYamnetResult(input.neural, {
        artifactHash: input.neuralArtifactHash ?? null,
        runtime: input.neuralRuntime ?? 'onnx-wasm',
        timestamp: analyzedAt,
    }) : null;
    const algorithmicDuration = finiteOrNull(input.algorithmic?.duration) ?? 0;
    const neuralDuration = neural?.segments.length ? Math.max(...neural.segments.map((segment) => segment.endSeconds)) : 0;
    const duration = Math.max(algorithmicDuration, neuralDuration);
    if (!(duration > 0))
        throw new ContextError('invalid-source', 'Analysis duration must be positive');
    const sampleRate = input.algorithmic?.sampleRate ?? 16000;
    const conflicts = [];
    if (algorithmicDuration > 0 && neuralDuration > 0 && Math.abs(algorithmicDuration - neuralDuration) > 0.5) {
        conflicts.push(makeConflict('duration-mismatch', 'warning', ['algorithmic', 'neural'], 'Algorithmic and neural durations disagree', {
            algorithmic: algorithmicDuration,
            neural: neuralDuration,
        }));
    }
    if (neural?.segments.some((segment) => segment.endSeconds > duration + 0.5)) {
        conflicts.push(makeConflict('timeline-mismatch', 'warning', ['neural'], 'Neural segment extends beyond track duration'));
    }
    const topNeural = neural?.top[0] ?? null;
    if (topNeural && algorithmic?.sections.value) {
        const silence = algorithmic.sections.value.find((section) => section.kind === 'silence');
        if (silence && /music|singing|speech/i.test(topNeural.label) && topNeural.aggregatedScore > 0.3) {
            conflicts.push(makeConflict('classification-energy-disagreement', 'info', ['algorithmic', 'neural'], 'Neural event may conflict with an algorithmic silence section', {
                neuralLabel: topNeural.label,
                neuralScore: topNeural.aggregatedScore,
                section: 'silence',
            }));
        }
        if (algorithmic.energy.value != null && algorithmic.energy.value > 0.6 && topNeural && /silence/i.test(topNeural.label) && topNeural.aggregatedScore > 0.5) {
            conflicts.push(makeConflict('classification-energy-disagreement', 'warning', ['algorithmic', 'neural'], 'High algorithmic energy conflicts with neural Silence label', {
                energy: algorithmic.energy.value,
                neuralLabel: topNeural.label,
                neuralScore: topNeural.aggregatedScore,
            }));
        }
    }
    if (!algorithmic)
        conflicts.push(makeConflict('missing-source', 'info', ['algorithmic'], 'Algorithmic analysis is unavailable'));
    if (!neural)
        conflicts.push(makeConflict('missing-source', 'info', ['neural'], 'Neural analysis is unavailable'));
    const timeline = buildTimeline({
        duration,
        sections: algorithmic?.sections.value ?? [],
        grid: algorithmic?.beatGrid.value ?? null,
        neuralSegments: neural?.segments ?? [],
        algorithmicProvenance: algorithmic?.provenance ?? null,
        neuralProvenance: neural?.provenance ?? null,
        maxSegments: input.maxSegments,
    });
    const warnings = [...new Set([...(algorithmic?.warnings ?? []), ...(neural?.warnings ?? []), ...timeline.gaps.length ? ['Timeline contains gaps without analysis'] : []])];
    const trackId = input.trackId || input.algorithmic?.id || `track-${analyzedAt}`;
    const sessionId = input.sessionId || `session-${analyzedAt}`;
    const contextBase = {
        schema: CONTEXT_SCHEMA,
        schemaVersion: CONTEXT_SCHEMA_VERSION,
        contextId: `ctx-${trackId}-${sessionId}`,
        trackId,
        sessionId,
        revision: 1,
        status: algorithmic && neural ? 'ready' : 'partial',
        createdAt: Date.now(),
        analyzedAt,
        duration,
        sampleRate,
        channels: null,
        metadata: {
            title: input.title ?? input.algorithmic?.title ?? null,
            artist: input.artist ?? input.algorithmic?.artist ?? null,
            source: input.source ?? null,
        },
        algorithmic,
        neural,
        acoustic: acousticProfile(algorithmic, neural?.top ?? [], neural?.provenance ?? null),
        timeline,
        conflicts,
        warnings,
        provenance: [algorithmic?.provenance, neural?.provenance].filter((entry) => !!entry),
    };
    const completeness = completenessOf(contextBase);
    return {
        ...contextBase,
        completeness,
        build: { buildMs: Date.now() - started, fusionMs: Date.now() - started },
    };
}

function cosineSimilarity(a, b) {
    if (!a || !b || !a.length || a.length !== b.length)
        return null;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]))
            return null;
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return null;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const STRATEGIES = [
    'beat-blend', 'long-phrase-blend', 'bass-swap', 'filter-sweep', 'echo-out',
    'reverb-transition', 'delay-transition', 'percussion-blend', 'vocal-safe',
    'vocal-handoff', 'instrumental-bridge', 'breakdown-to-drop', 'build-up',
    'ambient-fade', 'atmospheric', 'frequency-swap', 'loop-assisted', 'tempo-ramp',
    'half-time', 'double-time', 'harmonic', 'rhythmic-cut', 'energy-based',
    'cinematic', 'intelligent-hard-cut',
];
const clamp01$1 = (value) => Math.min(1, Math.max(0, value));
function sectionEnergy(context) {
    const values = context.timeline.segments.map((segment) => segment.sectionEnergy).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function lastKind(context) {
    const sections = context.algorithmic?.sections.value ?? [];
    return sections.length ? sections[sections.length - 1].kind : null;
}
function firstKind(context) {
    return context.algorithmic?.sections.value?.[0]?.kind ?? null;
}
function camelotCompatibility(a, b) {
    if (!a || !b)
        return null;
    if (a === b)
        return 1;
    const parse = (value) => { const match = /^(\d{1,2})([AB])$/.exec(value); return match ? { number: Number(match[1]), letter: match[2] } : null; };
    const left = parse(a);
    const right = parse(b);
    if (!left || !right)
        return null;
    if (left.letter === right.letter) {
        const distance = Math.min(Math.abs(left.number - right.number), 12 - Math.abs(left.number - right.number));
        return distance === 1 ? 0.75 : 0;
    }
    return left.number === right.number ? 0.55 : 0;
}
function adviseTransition(a, b) {
    const bpmA = a.algorithmic?.bpm.value ?? null;
    const bpmB = b.algorithmic?.bpm.value ?? null;
    const tempo = bpmA && bpmB ? clamp01$1(1 - Math.abs(Math.log2(bpmA / bpmB)) / Math.log2(1.12)) : null;
    const grid = a.algorithmic?.beatGrid.value && b.algorithmic?.beatGrid.value
        ? Math.min(a.algorithmic.beatGrid.value.confidence, b.algorithmic.beatGrid.value.confidence)
        : null;
    const meterA = a.algorithmic?.meter.value?.beatsPerBar ?? null;
    const meterB = b.algorithmic?.meter.value?.beatsPerBar ?? null;
    const meter = meterA != null && meterB != null ? (meterA === meterB ? 1 : 0) : null;
    const energyA = sectionEnergy(a);
    const energyB = sectionEnergy(b);
    const energy = energyA != null && energyB != null ? clamp01$1(1 - Math.abs(energyA - energyB)) : null;
    const vocalA = a.acoustic.vocalLikelihood.value;
    const vocalB = b.acoustic.vocalLikelihood.value;
    const vocal = vocalA != null && vocalB != null ? clamp01$1(1 - Math.abs(vocalA - vocalB)) : null;
    const embedding = cosineSimilarity(a.neural?.embeddings ?? null, b.neural?.embeddings ?? null);
    const key = camelotCompatibility(a.algorithmic?.camelot.value ?? null, b.algorithmic?.camelot.value ?? null);
    const structureA = lastKind(a);
    const structureB = firstKind(b);
    const structure = structureA && structureB
        ? (['outro', 'breakdown', 'ambient'].includes(structureA) && ['intro', 'ambient', 'verse'].includes(structureB) ? 1 : structureA === structureB ? 0.5 : 0.15)
        : null;
    const data = clamp01$1((a.timeline.coverage.aligned + b.timeline.coverage.aligned) / 2);
    const factors = [
        { id: 'tempo', label: 'Tempo', value: bpmA && bpmB ? `${bpmA.toFixed(2)} → ${bpmB.toFixed(2)}` : null, score: tempo, available: tempo !== null, explanation: 'Log2 BPM distance with an experimental 12% horizon.' },
        { id: 'beatgrid', label: 'Beatgrid', value: grid, score: grid, available: grid !== null, explanation: 'Minimum analyzed beatgrid confidence.' },
        { id: 'meter', label: 'Meter', value: meterA && meterB ? `${meterA}/4 → ${meterB}/4` : null, score: meter, available: meter !== null, explanation: 'Exact meter match.' },
        { id: 'energy', label: 'Energy', value: energyA != null && energyB != null ? `${energyA.toFixed(3)} → ${energyB.toFixed(3)}` : null, score: energy, available: energy !== null, explanation: 'Difference of mean section energy.' },
        { id: 'vocal', label: 'Vocal density', value: vocalA != null && vocalB != null ? `${vocalA.toFixed(3)} → ${vocalB.toFixed(3)}` : null, score: vocal, available: vocal !== null, explanation: 'Heuristic vocal-likelihood difference.' },
        { id: 'key', label: 'Harmony', value: a.algorithmic?.camelot.value && b.algorithmic?.camelot.value ? `${a.algorithmic.camelot.value} → ${b.algorithmic.camelot.value}` : null, score: key, available: key !== null, explanation: 'Camelot exact/adjacent relation.' },
        { id: 'embedding', label: 'Embedding', value: embedding, score: embedding == null ? null : clamp01$1(embedding), available: embedding !== null, explanation: 'YAMNet cosine similarity; not validated for DJ compatibility.' },
        { id: 'structure', label: 'Structure', value: structureA && structureB ? `${structureA} → ${structureB}` : null, score: structure, available: structure !== null, explanation: 'Hand-written low-confidence structure mapping.' },
        { id: 'data', label: 'Coverage', value: data, score: data, available: true, explanation: 'Aligned timeline coverage, not accuracy.' },
    ];
    const score = (id, fallback = 0.5) => factors.find((factor) => factor.id === id)?.score ?? fallback;
    const beat = (score('tempo') + score('beatgrid') + score('meter')) / 3;
    const values = {};
    for (const strategy of STRATEGIES)
        values[strategy] = 0.2;
    values['beat-blend'] = clamp01$1(beat * 0.75 + score('data') * 0.25);
    values['long-phrase-blend'] = clamp01$1(beat * 0.65 + score('structure') * 0.2 + score('data') * 0.15);
    values['bass-swap'] = clamp01$1(beat * 0.55 + score('energy') * 0.3 + score('data') * 0.15);
    values['percussion-blend'] = clamp01$1(beat * 0.6 + score('structure') * 0.15 + score('data') * 0.25);
    values['harmonic'] = clamp01$1(score('key') * 0.55 + beat * 0.3 + score('data') * 0.15);
    values['filter-sweep'] = clamp01$1((1 - beat) * 0.35 + score('energy') * 0.25 + score('data') * 0.25);
    values['echo-out'] = clamp01$1((1 - beat) * 0.4 + score('vocal') * 0.25 + score('data') * 0.2);
    values['vocal-safe'] = clamp01$1(score('vocal') * 0.65 + score('data') * 0.2);
    values['vocal-handoff'] = clamp01$1(score('vocal') * 0.5 + beat * 0.3 + score('data') * 0.2);
    values['breakdown-to-drop'] = clamp01$1(score('structure') * 0.45 + score('energy') * 0.35 + score('data') * 0.2);
    values['build-up'] = clamp01$1(score('energy') * 0.45 + score('structure') * 0.25 + score('data') * 0.2);
    values['ambient-fade'] = clamp01$1((1 - beat) * 0.4 + (1 - score('energy')) * 0.25 + score('data') * 0.2);
    values['atmospheric'] = clamp01$1((1 - beat) * 0.35 + (1 - score('energy')) * 0.25 + score('embedding') * 0.2 + score('data') * 0.2);
    values['cinematic'] = clamp01$1(score('embedding') * 0.35 + (1 - score('energy')) * 0.2 + score('data') * 0.2);
    values['tempo-ramp'] = clamp01$1((1 - score('tempo')) * 0.45 + score('data') * 0.25);
    values['half-time'] = clamp01$1((1 - score('tempo')) * 0.4 + score('energy') * 0.2 + score('data') * 0.2);
    values['double-time'] = values['half-time'];
    values['rhythmic-cut'] = clamp01$1((1 - beat) * 0.25 + score('structure') * 0.35 + score('data') * 0.2);
    values['intelligent-hard-cut'] = clamp01$1((1 - beat) * 0.3 + score('data') * 0.2);
    values['frequency-swap'] = clamp01$1(beat * 0.45 + score('energy') * 0.25 + score('data') * 0.2);
    values['loop-assisted'] = clamp01$1(beat * 0.45 + score('data') * 0.2);
    values['energy-based'] = clamp01$1(score('energy') * 0.45 + score('data') * 0.25);
    values['reverb-transition'] = clamp01$1((1 - beat) * 0.25 + score('data') * 0.2);
    values['delay-transition'] = values['echo-out'];
    values['instrumental-bridge'] = clamp01$1(beat * 0.45 + score('structure') * 0.2 + score('data') * 0.2);
    const ranked = STRATEGIES.map((strategy) => ({
        strategy,
        score: Number(values[strategy]?.toFixed(4) ?? 0),
        reasons: [
            `tempo ${score('tempo').toFixed(2)}`,
            `beatgrid ${score('beatgrid').toFixed(2)}`,
            `energy ${score('energy').toFixed(2)}`,
            `vocal ${score('vocal').toFixed(2)}`,
            `data ${score('data').toFixed(2)}`,
        ],
    })).sort((left, right) => right.score - left.score || left.strategy.localeCompare(right.strategy));
    const dataCoverage = factors.filter((factor) => factor.available).length / factors.length;
    return {
        recommended: ranked[0].strategy,
        ranked,
        fallback: ranked.find((entry) => ['filter-sweep', 'echo-out', 'intelligent-hard-cut', 'ambient-fade'].includes(entry.strategy))?.strategy ?? 'intelligent-hard-cut',
        factors,
        strategyScores: values,
        dataCoverage: Math.round(dataCoverage * 100) / 100,
        confidence: null,
        limitations: [
            'Advisory only; not a calibrated probability or a transition decision.',
            'Weights and structure mapping are hand-written and unvalidated.',
            'YAMNet embeddings are not validated as musical compatibility.',
            'No audio is controlled by this module.',
        ],
    };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(value, 0, 1);
function mean(values) {
    if (!values.length)
        return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i += 1)
        sum += values[i];
    return sum / values.length;
}
function rms(values) {
    if (!values.length)
        return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i += 1)
        sum += values[i] * values[i];
    return Math.sqrt(sum / values.length);
}
function percentile(values, p) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = clamp(Math.floor((sorted.length - 1) * p), 0, sorted.length - 1);
    return sorted[index];
}
function dbToGain(db) {
    return 10 ** (db / 20);
}
function equalPower(position) {
    const p = clamp01(position);
    return {
        out: Math.cos((p * Math.PI) / 2),
        in: Math.sin((p * Math.PI) / 2),
    };
}
function round(value, digits = 3) {
    const m = 10 ** digits;
    return Math.round(value * m) / m;
}

function trackEnergy(analysis) {
    const loudness = clamp01((analysis.loudness.lufsEstimate + 24) / 18);
    return round(clamp01(analysis.intensity * 0.38
        + loudness * 0.22
        + analysis.transientDensity * 0.16
        + analysis.bands.low * 0.12
        + analysis.bands.high * 0.12), 3);
}

/**
 * Adaptive energy direction. It proposes targets, but every target is derived
 * from measured track energy and the selected mode; it is not a hard timeline.
 */
class EnergyArc {
    phase;
    current;
    history = [];
    mode;
    constructor(mode, startEnergy = 0.55) {
        this.mode = mode;
        this.current = clamp01(startEnergy);
        this.phase = this.initialPhase(mode, this.current);
    }
    initialPhase(mode, energy) {
        if (mode === 'Chill')
            return 'cooldown';
        if (mode === 'Peak Time')
            return 'peak';
        if (mode === 'Smooth')
            return 'plateau';
        if (mode === 'Energetic')
            return 'build';
        if (mode === 'Adaptive')
            return energy < 0.5 ? 'build' : energy > 0.75 ? 'peak' : 'plateau';
        return 'build';
    }
    observe(energy) {
        if (energy == null || !Number.isFinite(energy))
            return this.snapshot();
        this.current = clamp01(energy);
        this.history.push(this.current);
        if (this.history.length > 32)
            this.history.shift();
        if (this.phase === 'build' && this.current > 0.82)
            this.phase = 'peak';
        else if (this.phase === 'peak' && this.current < 0.58)
            this.phase = 'recover';
        else if (this.phase === 'cooldown' && this.current < 0.42)
            this.phase = 'plateau';
        else if (this.phase === 'recover' && this.current > 0.7)
            this.phase = 'build';
        return this.snapshot();
    }
    targets(horizon) {
        const count = Math.max(1, horizon);
        const out = [];
        for (let i = 1; i <= count; i += 1) {
            const progress = i / count;
            if (this.phase === 'build')
                out.push(clamp01(this.current + (0.86 - this.current) * progress));
            else if (this.phase === 'peak')
                out.push(clamp01(0.9 - (i - 1) * 0.015));
            else if (this.phase === 'plateau')
                out.push(clamp01(this.current + (0.62 - this.current) * progress * 0.5));
            else if (this.phase === 'cooldown')
                out.push(clamp01(this.current - (this.current - 0.42) * progress));
            else
                out.push(clamp01(this.current + (0.7 - this.current) * progress));
        }
        return out.map((value) => round(value, 3));
    }
    target() {
        return this.targets(1)[0];
    }
    snapshot() {
        return {
            phase: this.phase,
            current: round(this.current, 3),
            target: this.target(),
            history: this.history.map((value) => round(value, 3)),
            reason: `${this.mode}: ${this.phase} → ${this.target().toFixed(2)} (measured ${this.current.toFixed(2)})`,
        };
    }
    reset(mode, startEnergy = 0.55) {
        this.current = clamp01(startEnergy);
        this.history = [];
        this.phase = this.initialPhase(mode, this.current);
    }
    get average() {
        return this.history.length ? round(mean(this.history.slice(-8)), 3) : round(this.current, 3);
    }
}

function transitionScore(previous, next) {
    try {
        const advice = adviseTransition(previous, next);
        const weights = { tempo: 0.24, beatgrid: 0.18, meter: 0.06, key: 0.14, energy: 0.16, vocal: 0.05, embedding: 0.12, structure: 0.03, data: 0.02 };
        let total = 0;
        let sum = 0;
        for (const [id, weight] of Object.entries(weights)) {
            const factor = advice.factors.find((entry) => entry.id === id);
            if (!factor?.available || factor.score == null)
                continue;
            total += factor.score * weight;
            sum += weight;
        }
        return { score: sum > 0 ? total / sum : 0.35, reasons: [`transition ${sum > 0 ? (total / sum).toFixed(2) : 'unknown'}`, `advisor ${advice.recommended}`] };
    }
    catch {
        return { score: 0.35, reasons: ['transition context unavailable'] };
    }
}
function energyOf(candidate) {
    try {
        const value = trackEnergy(candidate.analysis);
        return Number.isFinite(value) ? value : null;
    }
    catch {
        return null;
    }
}
function contextCoverage(context) {
    return context.timeline.coverage.aligned;
}
class SessionIntelligence {
    arc;
    failures = new Map();
    direction;
    constructor(mode = 'Balanced', startEnergy = 0.55) {
        this.arc = new EnergyArc(mode, startEnergy);
        this.direction = this.buildDirection([], 0);
    }
    observeEnergy(value) {
        const snapshot = this.arc.observe(value);
        this.direction = this.buildDirection([], 0);
        return snapshot;
    }
    setMode(mode, startEnergy) {
        if (startEnergy == null)
            this.arc.reset(mode, this.arc.snapshot().current);
        else
            this.arc.reset(mode, startEnergy);
    }
    markFailure(id, reason, now = Date.now(), cooldownMs = 90_000) {
        const existing = this.failures.get(id);
        const count = (existing?.count ?? 0) + 1;
        this.failures.set(id, { id, count, until: now + cooldownMs * Math.min(4, count), reason: reason.slice(0, 160) });
    }
    markSuccess(id) {
        this.failures.delete(id);
    }
    isAvailable(id, now = Date.now()) {
        const failure = this.failures.get(id);
        return !failure || failure.until <= now;
    }
    blockedIds(now = Date.now()) {
        return [...this.failures.values()].filter((entry) => entry.until > now).map((entry) => entry.id);
    }
    plan(active, candidates, history, memory, options = {}) {
        const now = options.now ?? Date.now();
        const mode = options.mode ?? 'Adaptive';
        const horizon = Math.max(1, Math.min(4, options.horizon ?? 3));
        const exclude = new Set(options.excludeIds ?? []);
        const targetEnergy = options.targetEnergy ?? this.arc.target();
        const available = candidates.filter((candidate) => !exclude.has(candidate.id) && this.isAvailable(candidate.id, now));
        if (!available.length) {
            return this.emptyPlan('Нет доступных кандидатов после failure/исключений', horizon);
        }
        const ranked = [...available].sort((left, right) => {
            const l = transitionScore(active, left.context).score;
            const r = transitionScore(active, right.context).score;
            return r - l || left.id.localeCompare(right.id);
        }).slice(0, Math.max(2, Math.min(10, options.maxCandidates ?? 8)));
        const targets = this.arc.targets(horizon);
        const paths = [];
        const recentIds = new Set(history.ids.slice(-6));
        const recentArtists = new Set(history.artists.slice(-3));
        const walk = (state) => {
            if (state.steps.length >= horizon) {
                paths.push(state);
                return;
            }
            const stepIndex = state.steps.length;
            const energyTarget = targets[stepIndex] ?? targetEnergy;
            let extended = false;
            for (const candidate of ranked) {
                if (state.used.has(candidate.id))
                    continue;
                const transition = transitionScore(state.current, candidate.context);
                const measured = energyOf(candidate);
                const energyFit = measured == null ? 0.45 : Math.max(0, 1 - Math.abs(measured - energyTarget) / 0.55);
                const historyPenalty = (recentIds.has(candidate.id) ? 0.2 : 0) + (recentArtists.has(candidate.artist) ? 0.12 : 0);
                const data = contextCoverage(candidate.context);
                const stepScore = Math.max(0, Math.min(1, transition.score * 0.5 + energyFit * 0.3 + data * 0.15 + 0.05 - historyPenalty));
                const step = {
                    candidate,
                    score: Number(stepScore.toFixed(4)),
                    energyTarget,
                    transitionScore: Number(transition.score.toFixed(4)),
                    energyFit: Number(energyFit.toFixed(4)),
                    reasons: [...transition.reasons, `energy ${energyFit.toFixed(2)}`, `data ${data.toFixed(2)}`],
                };
                const used = new Set(state.used);
                used.add(candidate.id);
                extended = true;
                walk({ steps: [...state.steps, step], score: state.score + step.score, used, current: candidate.context });
            }
            if (!extended && state.steps.length > 0)
                paths.push(state);
        };
        walk({ steps: [], score: 0, used: new Set(), current: active });
        if (!paths.length)
            return this.emptyPlan('Не найдено совместимой последовательности', horizon);
        paths.sort((left, right) => (right.score / right.steps.length) - (left.score / left.steps.length) || left.steps[0].candidate.id.localeCompare(right.steps[0].candidate.id));
        const best = paths[0];
        const alternatives = paths.slice(1, 4).map((path) => path.steps);
        const chosen = best.steps[0]?.candidate ?? null;
        if (chosen && memory) {
            memory.recordSessionDecision({
                at: now,
                activeId: active.trackId,
                chosenId: chosen.id,
                sequenceIds: best.steps.map((step) => step.candidate.id),
                energyPhase: this.arc.snapshot().phase,
                reason: `score ${(best.score / best.steps.length).toFixed(3)}`,
            });
        }
        this.direction = this.buildDirection(best.steps, best.score / best.steps.length);
        return {
            chosen,
            sequence: best.steps,
            alternatives,
            direction: this.direction,
            reason: chosen
                ? `${mode}: ${chosen.title} · ${best.steps[0].reasons.join(', ')} · horizon ${best.steps.length}`
                : 'Нет выбора',
            horizon,
            usedFallback: false,
        };
    }
    currentDirection() {
        return { ...this.direction };
    }
    snapshot() {
        return { direction: this.direction, failures: [...this.failures.values()].map((entry) => ({ ...entry })), energy: this.arc.snapshot() };
    }
    emptyPlan(reason, horizon) {
        return { chosen: null, sequence: [], alternatives: [], direction: this.direction, reason, horizon, usedFallback: true };
    }
    buildDirection(steps, score) {
        const current = this.arc.snapshot();
        const bpmValues = steps.map((step) => step.candidate.analysis.bpm).filter((value) => value != null && Number.isFinite(value));
        const keys = steps.map((step) => step.candidate.context.algorithmic?.camelot.value).filter((value) => !!value);
        const coverage = steps.length ? steps.reduce((sum, step) => sum + contextCoverage(step.candidate.context), 0) / steps.length : 0;
        return {
            phase: current.phase,
            energyTarget: current.target,
            energyCurrent: current.current,
            bpmCenter: bpmValues.length ? bpmValues.reduce((sum, value) => sum + value, 0) / bpmValues.length : null,
            keyCenter: keys[0] ?? null,
            diversity: steps.length ? new Set(steps.map((step) => step.candidate.artist)).size / steps.length : 0,
            reasons: [
                current.reason,
                `sequence score ${score.toFixed(2)}`,
                `coverage ${coverage.toFixed(2)}`,
            ],
            dataCoverage: coverage,
            uncertainty: coverage > 0.7 ? 'low' : coverage > 0.3 ? 'medium' : 'high',
        };
    }
}

/** In-place iterative radix-2 FFT for real input. */
class RealFFT {
    size;
    cos;
    sin;
    reverse;
    re;
    im;
    constructor(size) {
        if (size < 2 || (size & (size - 1)) !== 0)
            throw new Error('FFT size must be a power of two');
        this.size = size;
        this.cos = new Float64Array(size / 2);
        this.sin = new Float64Array(size / 2);
        this.reverse = new Uint32Array(size);
        this.re = new Float64Array(size);
        this.im = new Float64Array(size);
        const bits = Math.log2(size);
        for (let i = 0; i < size; i += 1) {
            let x = i;
            let r = 0;
            for (let b = 0; b < bits; b += 1) {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            this.reverse[i] = r;
        }
        for (let i = 0; i < size / 2; i += 1) {
            this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
            this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
        }
    }
    run() {
        const n = this.size;
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const step = n / len;
            for (let i = 0; i < n; i += len) {
                for (let j = 0; j < half; j += 1) {
                    const k = j * step;
                    const tRe = this.re[i + j + half] * this.cos[k] - this.im[i + j + half] * this.sin[k];
                    const tIm = this.re[i + j + half] * this.sin[k] + this.im[i + j + half] * this.cos[k];
                    this.re[i + j + half] = this.re[i + j] - tRe;
                    this.im[i + j + half] = this.im[i + j] - tIm;
                    this.re[i + j] += tRe;
                    this.im[i + j] += tIm;
                }
            }
        }
    }
    /** Returns magnitude spectrum (size/2). Input length must equal size. */
    magnitude(input, out) {
        const n = this.size;
        if (input.length !== n)
            throw new Error('FFT input length mismatch');
        for (let i = 0; i < n; i += 1) {
            this.re[this.reverse[i]] = input[i];
            this.im[this.reverse[i]] = 0;
        }
        this.run();
        const bins = n / 2;
        const mags = out && out.length === bins ? out : new Float32Array(bins);
        for (let i = 0; i < bins; i += 1) {
            mags[i] = Math.hypot(this.re[i], this.im[i]);
        }
        return mags;
    }
    /** Forward complex transform into caller-provided full-size arrays. */
    forward(input, realOut, imagOut) {
        const n = this.size;
        if (input.length !== n || realOut.length !== n || imagOut.length !== n)
            throw new Error('FFT forward length mismatch');
        for (let i = 0; i < n; i += 1) {
            this.re[this.reverse[i]] = input[i];
            this.im[this.reverse[i]] = 0;
        }
        this.run();
        realOut.set(this.re);
        imagOut.set(this.im);
    }
    /** Inverse complex transform; accepts full-size real/imag arrays and writes real samples. */
    inverse(real, imag, out) {
        const n = this.size;
        if (real.length !== n || imag.length !== n || out.length !== n)
            throw new Error('FFT inverse length mismatch');
        for (let i = 0; i < n; i += 1) {
            this.re[this.reverse[i]] = real[i];
            this.im[this.reverse[i]] = -imag[i];
        }
        this.run();
        for (let i = 0; i < n; i += 1)
            out[i] = this.re[i] / n;
    }
}
function hannWindow(size) {
    const win = new Float32Array(size);
    for (let i = 0; i < size; i += 1)
        win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    return win;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function mixToMono(buffer, targetRate) {
    const channels = Math.max(1, buffer.numberOfChannels);
    const ratio = buffer.sampleRate / targetRate;
    const length = Math.max(1, Math.floor(buffer.length / Math.max(1, ratio)));
    const out = new Float32Array(length);
    const data = [];
    for (let c = 0; c < channels; c += 1)
        data.push(buffer.getChannelData(c));
    for (let i = 0; i < length; i += 1) {
        const src = i * ratio;
        const i0 = Math.floor(src);
        const i1 = Math.min(buffer.length - 1, i0 + 1);
        const frac = src - i0;
        let sum = 0;
        for (let c = 0; c < channels; c += 1) {
            const a = data[c][i0] || 0;
            const b = data[c][i1] || 0;
            sum += a + (b - a) * frac;
        }
        out[i] = sum / channels;
    }
    return { samples: out, sampleRate: targetRate };
}
function frameFeatures(samples, sampleRate) {
    const frameSize = 1024;
    const hop = 512;
    const win = hannWindow(frameSize);
    const fft = new RealFFT(frameSize);
    const count = Math.max(0, Math.floor((samples.length - frameSize) / hop) + 1);
    const times = new Float32Array(count);
    const rmsArr = new Float32Array(count);
    const lowArr = new Float32Array(count);
    const midArr = new Float32Array(count);
    const highArr = new Float32Array(count);
    const centroidArr = new Float32Array(count);
    const rolloffArr = new Float32Array(count);
    const fluxArr = new Float32Array(count);
    const lowFluxArr = new Float32Array(count);
    const flatnessArr = new Float32Array(count);
    const chroma = Array.from({ length: count }, () => new Float32Array(12));
    const frame = new Float32Array(frameSize);
    const mags = new Float32Array(frameSize / 2);
    let prev = new Float32Array(frameSize / 2);
    const binHz = sampleRate / frameSize;
    const lowBin = Math.max(1, Math.floor(180 / binHz));
    const midBin = Math.max(lowBin + 1, Math.floor(2000 / binHz));
    const highBin = Math.max(midBin + 1, Math.floor(8000 / binHz));
    for (let f = 0; f < count; f += 1) {
        const offset = f * hop;
        let energy = 0;
        for (let i = 0; i < frameSize; i += 1) {
            const value = samples[offset + i] || 0;
            frame[i] = value * win[i];
            energy += value * value;
        }
        rmsArr[f] = Math.sqrt(energy / frameSize);
        times[f] = (offset + frameSize / 2) / sampleRate;
        fft.magnitude(frame, mags);
        let low = 0;
        let mid = 0;
        let high = 0;
        let weighted = 0;
        let total = 0;
        let logSum = 0;
        let linearSum = 0;
        let flux = 0;
        let lowFlux = 0;
        const chromaFrame = chroma[f];
        for (let i = 1; i < mags.length; i += 1) {
            const mag = mags[i];
            const power = mag * mag;
            total += power;
            weighted += i * binHz * power;
            linearSum += mag;
            logSum += Math.log(mag + 1e-9);
            if (i <= lowBin)
                low += power;
            else if (i <= midBin)
                mid += power;
            else if (i <= highBin)
                high += power;
            const diff = mag - prev[i];
            if (diff > 0) {
                flux += diff;
                if (i <= lowBin)
                    lowFlux += diff;
            }
            if (i > 2 && i < mags.length - 1) {
                const midi = Math.round(69 + 12 * Math.log2((i * binHz) / 440));
                const pitchClass = ((midi % 12) + 12) % 12;
                chromaFrame[pitchClass] += mag;
            }
        }
        const sumPower = total || 1;
        lowArr[f] = low / sumPower;
        midArr[f] = mid / sumPower;
        highArr[f] = high / sumPower;
        centroidArr[f] = weighted / sumPower;
        flatnessArr[f] = Math.exp(logSum / mags.length) / (linearSum / mags.length + 1e-9);
        fluxArr[f] = flux / (mags.length || 1);
        lowFluxArr[f] = lowFlux / (mags.length || 1);
        let cumulative = 0;
        const target = sumPower * 0.85;
        let rolloff = sampleRate / 2;
        for (let i = 1; i < mags.length; i += 1) {
            cumulative += mags[i] * mags[i];
            if (cumulative >= target) {
                rolloff = i * binHz;
                break;
            }
        }
        rolloffArr[f] = rolloff;
        prev = mags.slice();
    }
    return {
        times,
        rms: rmsArr,
        low: lowArr,
        mid: midArr,
        high: highArr,
        centroid: centroidArr,
        rolloff: rolloffArr,
        flux: fluxArr,
        lowFlux: lowFluxArr,
        flatness: flatnessArr,
        chroma,
    };
}
function normalizeOnset(values) {
    const positive = Array.from(values, (value) => Math.max(0, value));
    const sorted = [...positive].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const scale = p95 || Math.max(...positive) || 1;
    return Float32Array.from(positive, (value) => Math.min(1, value / scale));
}
function estimateTempo(onset, fps) {
    const minBpm = 60;
    const maxBpm = 200;
    const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm));
    const maxLag = Math.min(onset.length - 2, Math.ceil((60 * fps) / minBpm));
    if (maxLag <= minLag)
        return { bpm: 120, confidence: 0, beatOffset: 0 };
    let bestLag = minLag;
    let best = -Infinity;
    const scores = [];
    for (let lag = minLag; lag <= maxLag; lag += 1) {
        let sum = 0;
        let count = 0;
        for (let i = lag; i < onset.length; i += 1) {
            sum += onset[i] * onset[i - lag];
            count += 1;
        }
        let score = sum / Math.max(1, count);
        const bpm = (60 * fps) / lag;
        const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.65) ** 2);
        score *= 0.75 + prior * 0.5;
        scores.push(score);
        if (score > best) {
            best = score;
            bestLag = lag;
        }
    }
    const meanScore = scores.reduce((sum, value) => sum + Math.max(0, value), 0) / Math.max(1, scores.length);
    const confidence = clamp01((best / Math.max(1e-9, meanScore) - 1) / 2.6);
    let refinedLag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
        const y0 = scores[bestLag - minLag - 1];
        const y1 = scores[bestLag - minLag];
        const y2 = scores[bestLag - minLag + 1];
        const denom = y0 - 2 * y1 + y2;
        if (Number.isFinite(denom) && Math.abs(denom) > 1e-12) {
            const delta = 0.5 * (y0 - y2) / denom;
            refinedLag = bestLag + clamp(delta, -0.9, 0.9);
        }
    }
    let bpm = (60 * fps) / refinedLag;
    while (bpm < 82)
        bpm *= 2;
    while (bpm > 178)
        bpm /= 2;
    const period = 60 / bpm;
    const periodFrames = period * fps;
    let bestPhase = 0;
    let phaseScore = -Infinity;
    const phaseLimit = Math.min(onset.length, Math.floor(periodFrames * 16));
    for (let phase = 0; phase < Math.floor(periodFrames); phase += 1) {
        let score = 0;
        for (let t = phase; t < phaseLimit; t += periodFrames) {
            const i = Math.round(t);
            score += onset[Math.min(onset.length - 1, i)];
        }
        if (score > phaseScore) {
            phaseScore = score;
            bestPhase = phase;
        }
    }
    return { bpm: round(bpm, 2), confidence: round(confidence, 3), beatOffset: bestPhase / fps };
}
function buildBeatGrid(features, tempo, duration, fps) {
    const period = 60 / tempo.bpm;
    const onset = normalizeOnset(features.flux);
    const beats = [];
    let t = tempo.beatOffset;
    const search = Math.max(1, Math.round(0.09 * fps));
    while (t < duration - 0.04) {
        const center = Math.round(t * fps);
        let bestIndex = center;
        let bestValue = -Infinity;
        for (let i = center - search; i <= center + search; i += 1) {
            if (i < 0 || i >= onset.length)
                continue;
            if (onset[i] > bestValue) {
                bestValue = onset[i];
                bestIndex = i;
            }
        }
        beats.push(indexToTime(bestIndex, features, t));
        t += period;
    }
    const phaseScores = [0, 0, 0, 0];
    for (let i = 0; i < beats.length; i += 1) {
        const frame = Math.round(beats[i] * fps);
        const low = features.low[Math.min(features.low.length - 1, Math.max(0, frame))] || 0;
        const energy = features.rms[Math.min(features.rms.length - 1, Math.max(0, frame))] || 0;
        phaseScores[i % 4] += low * 2 + energy;
    }
    let downbeatPhase = 0;
    for (let i = 1; i < 4; i += 1)
        if (phaseScores[i] > phaseScores[downbeatPhase])
            downbeatPhase = i;
    const downbeats = beats.filter((_, index) => index % 4 === downbeatPhase);
    const phraseBars = inferPhraseBars(features, downbeats, duration);
    return {
        bpm: tempo.bpm,
        beatOffset: beats[0] ?? tempo.beatOffset,
        beats,
        downbeats,
        phraseBars,
        confidence: tempo.confidence,
    };
}
function indexToTime(index, features, fallback) {
    const frameTime = features.times[Math.min(features.times.length - 1, Math.max(0, index))];
    return Number.isFinite(frameTime) ? frameTime : fallback;
}
function inferPhraseBars(features, downbeats, duration) {
    if (downbeats.length < 8 || duration < 30)
        return 4;
    const barEnergy = [];
    for (let i = 0; i < downbeats.length - 1; i += 1) {
        const a = Math.round(downbeats[i] * 43.07);
        const b = Math.round(downbeats[i + 1] * 43.07);
        let sum = 0;
        let count = 0;
        for (let f = a; f < b && f < features.rms.length; f += 1) {
            sum += features.rms[f];
            count += 1;
        }
        barEnergy.push(sum / Math.max(1, count));
    }
    let best = 4;
    let bestScore = 0;
    for (const phrase of [4, 8, 16]) {
        let score = 0;
        for (let i = phrase; i < barEnergy.length; i += phrase) {
            score += Math.abs(barEnergy[i] - barEnergy[i - 1]);
        }
        score /= Math.max(1, Math.floor(barEnergy.length / phrase));
        if (score > bestScore) {
            bestScore = score;
            best = phrase;
        }
    }
    return best;
}
function buildSections(features, grid, duration) {
    const bpm = grid?.bpm || 120;
    const barSec = (60 / bpm) * 4;
    const bars = Math.max(2, Math.floor(duration / barSec));
    const energy = [];
    const low = [];
    const high = [];
    const centroid = [];
    const flatness = [];
    for (let bar = 0; bar < bars; bar += 1) {
        const start = Math.round(bar * barSec * 43.07);
        const end = Math.min(features.rms.length, Math.round((bar + 1) * barSec * 43.07));
        const slice = (arr) => {
            let sum = 0;
            let count = 0;
            for (let i = start; i < end; i += 1) {
                sum += arr[i] || 0;
                count += 1;
            }
            return sum / Math.max(1, count);
        };
        energy.push(slice(features.rms));
        low.push(slice(features.low));
        high.push(slice(features.high));
        centroid.push(slice(features.centroid));
        flatness.push(slice(features.flatness));
    }
    const maxEnergy = Math.max(...energy, 1e-6);
    const normEnergy = energy.map((v) => v / maxEnergy);
    const novelty = [0];
    for (let i = 1; i < bars; i += 1) {
        novelty.push(Math.abs(normEnergy[i] - normEnergy[i - 1])
            + Math.abs(low[i] - low[i - 1]) * 0.6
            + Math.abs(centroid[i] - centroid[i - 1]) / 8000);
    }
    const threshold = Math.max(0.12, percentile(novelty, 0.72));
    const boundaries = [0];
    for (let i = 1; i < bars; i += 1) {
        if (novelty[i] >= threshold && i - boundaries[boundaries.length - 1] >= 4)
            boundaries.push(i);
    }
    if (bars - boundaries[boundaries.length - 1] < 4 && boundaries.length > 1)
        boundaries.pop();
    boundaries.push(bars);
    const sections = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
        const startBar = boundaries[i];
        const endBar = boundaries[i + 1];
        if (endBar <= startBar)
            continue;
        const secEnergy = mean(normEnergy.slice(startBar, endBar));
        const secLow = mean(low.slice(startBar, endBar));
        const secHigh = mean(high.slice(startBar, endBar));
        const secFlatness = mean(flatness.slice(startBar, endBar));
        const prevEnergy = i > 0 ? mean(normEnergy.slice(boundaries[i - 1], startBar)) : secEnergy;
        const prevKind = i > 0 ? sections[i - 1]?.kind : null;
        let kind = 'verse';
        if (secEnergy < 0.1)
            kind = 'silence';
        else if (secEnergy < 0.28 && secFlatness > 0.22)
            kind = 'ambient';
        else if (i === 0 && secEnergy < 0.72)
            kind = 'intro';
        else if (i === boundaries.length - 2 && secEnergy < 0.75)
            kind = 'outro';
        else if (secEnergy < 0.38 && prevEnergy > 0.55)
            kind = 'breakdown';
        else if (prevKind === 'drop' && secEnergy < prevEnergy - 0.25)
            kind = 'interlude';
        else if (secEnergy < 0.55 && secEnergy > prevEnergy + 0.12)
            kind = 'build';
        else if (secEnergy > 0.78 && secLow > 0.18)
            kind = 'drop';
        else if (secEnergy > 0.64)
            kind = 'chorus';
        else if (prevKind === 'chorus' && secEnergy < prevEnergy - 0.05 && secEnergy > 0.45)
            kind = 'bridge';
        else if (prevKind === 'verse' && secEnergy > prevEnergy + 0.06)
            kind = 'pre-chorus';
        else if (secHigh > 0.16)
            kind = 'instrumental';
        sections.push({
            start: round(startBar * barSec, 3),
            end: round(Math.min(duration, endBar * barSec), 3),
            kind,
            energy: round(clamp01(secEnergy), 3),
            confidence: round(clamp01(0.35 + Math.abs(secEnergy - prevEnergy) * 0.9 + (kind === 'drop' ? 0.15 : 0)), 3),
            beatConfidence: round(grid?.confidence ?? 0, 3),
        });
    }
    if (!sections.length) {
        sections.push({ start: 0, end: duration, kind: 'verse', energy: 0.5, confidence: 0.2 });
    }
    if (sections.length === 1 && duration >= 24) {
        const single = sections[0];
        const introEnd = single.start + (single.end - single.start) * 0.16;
        const outroStart = single.start + (single.end - single.start) * 0.82;
        return [
            { ...single, end: round(introEnd, 3), kind: 'intro', confidence: 0.25 },
            { ...single, start: round(introEnd, 3), end: round(outroStart, 3), kind: 'verse', confidence: 0.3 },
            { ...single, start: round(outroStart, 3), kind: 'outro', confidence: 0.25 },
        ];
    }
    return sections;
}
function buildCues(sections, grid, duration) {
    const downbeats = grid?.downbeats || [];
    const snap = (time) => {
        if (!downbeats.length)
            return clamp(time, 0, duration);
        let best = downbeats[0];
        let bestD = Math.abs(best - time);
        for (const value of downbeats) {
            const d = Math.abs(value - time);
            if (d < bestD) {
                best = value;
                bestD = d;
            }
        }
        return bestD <= 2.2 ? best : clamp(time, 0, duration);
    };
    const introSection = sections[0];
    const outroSection = sections[sections.length - 1];
    const firstMix = sections.find((section, index) => index > 0 && section.kind !== 'intro')
        || sections[Math.min(1, sections.length - 1)];
    const outro = outroSection.kind === 'outro'
        ? outroSection.start
        : Math.max(duration * 0.82, duration - 32);
    return {
        intro: snap(introSection?.start || 0),
        mixIn: snap(Math.max(firstMix?.start || duration * 0.08, duration * 0.04)),
        mixOut: snap(Math.min(outro, duration - 1.5)),
        outro: snap(Math.min(outro, duration - 0.5)),
    };
}
function detectKey(chroma) {
    const normalized = Array.from(chroma, (v) => v);
    const total = normalized.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < 12; i += 1)
        normalized[i] /= total;
    let best = { key: 'C major', camelot: '8B', confidence: 0 };
    for (const minor of [false, true]) {
        const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
        for (let root = 0; root < 12; root += 1) {
            let score = 0;
            for (let i = 0; i < 12; i += 1)
                score += normalized[(i + root) % 12] * profile[i];
            if (score > best.confidence) {
                best = {
                    key: `${NOTE_NAMES[root]} ${minor ? 'minor' : 'major'}`,
                    camelot: minor ? CAMELOT_MINOR[root] : CAMELOT_MAJOR[root],
                    confidence: score,
                };
            }
        }
    }
    const sorted = [];
    for (const minor of [false, true]) {
        const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
        for (let root = 0; root < 12; root += 1) {
            let score = 0;
            for (let i = 0; i < 12; i += 1)
                score += normalized[(i + root) % 12] * profile[i];
            sorted.push(score);
        }
    }
    sorted.sort((a, b) => b - a);
    const margin = (sorted[0] - (sorted[1] || 0)) / Math.max(1e-6, sorted[0]);
    return { key: best.key, camelot: best.camelot, confidence: round(clamp01(margin * 2.4), 3) };
}
function buildWaveform(samples, peaks = 1200) {
    const out = new Float32Array(peaks);
    const bucket = Math.max(1, Math.floor(samples.length / peaks));
    for (let i = 0; i < peaks; i += 1) {
        const start = i * bucket;
        const end = Math.min(samples.length, start + bucket);
        let max = 0;
        let sum = 0;
        let count = 0;
        const step = Math.max(1, Math.floor((end - start) / 80));
        for (let j = start; j < end; j += step) {
            const v = Math.abs(samples[j] || 0);
            max = Math.max(max, v);
            sum += v * v;
            count += 1;
        }
        out[i] = Math.min(1, max * 0.7 + Math.sqrt(sum / Math.max(1, count)) * 0.8);
    }
    return out;
}
function buildTempoMap(onset, fps, duration, global) {
    const points = [];
    const windowSec = 8;
    const stepSec = 4;
    for (let time = 0; time + windowSec <= duration + 0.01; time += stepSec) {
        const start = Math.round(time * fps);
        const end = Math.min(onset.length, Math.round((time + windowSec) * fps));
        if (end - start < 60)
            continue;
        const local = estimateTempo(onset.subarray(start, end), fps);
        if (local.confidence > 0.03) {
            points.push({
                time: round(time + windowSec / 2, 2),
                bpm: local.bpm,
                confidence: local.confidence,
                stable: local.confidence > 0.2,
            });
        }
    }
    if (!points.length) {
        points.push({ time: duration / 2, bpm: global.bpm, confidence: global.confidence, stable: global.confidence > 0.2 });
    }
    const bpms = points.map((point) => point.bpm).sort((a, b) => a - b);
    const median = bpms[Math.floor(bpms.length / 2)];
    const min = bpms[0];
    const max = bpms[bpms.length - 1];
    const variable = max - min > Math.max(2.5, median * 0.025);
    const meanConfidence = mean(points.map((point) => point.confidence));
    return {
        points,
        medianBpm: round(median, 2),
        minBpm: round(min, 2),
        maxBpm: round(max, 2),
        variable,
        stability: round(clamp01(meanConfidence * (variable ? 0.55 : 0.9)), 3),
    };
}
function detectMeter(features, grid) {
    if (!grid || grid.beats.length < 16) {
        return { beatsPerBar: null, confidence: 0, alternatives: [] };
    }
    const meters = [3, 4, 5, 6, 7];
    const scores = meters.map((meter) => {
        const phases = new Array(meter).fill(0);
        for (let i = 0; i < grid.beats.length; i += 1) {
            const frame = Math.min(features.low.length - 1, Math.max(0, Math.round(grid.beats[i] * 43.07)));
            phases[i % meter] += features.low[frame] * 1.8 + features.rms[frame];
        }
        const max = Math.max(...phases);
        const min = Math.min(...phases);
        return { beatsPerBar: meter, score: round(max / Math.max(1e-6, min + 0.001), 3) };
    }).sort((a, b) => b.score - a.score);
    const best = scores[0];
    const second = scores[1];
    const confidence = round(clamp01((best.score - second.score) / Math.max(0.2, best.score)), 3);
    return { beatsPerBar: confidence >= 0.2 ? best.beatsPerBar : null, confidence, alternatives: scores.map((entry) => ({ beatsPerBar: entry.beatsPerBar, score: entry.score })) };
}
function buildVocalProfile(sections, vocalLikelihood, transientDensity) {
    const regions = sections.map((section) => {
        const instrumental = ['intro', 'outro', 'breakdown', 'ambient', 'interlude', 'silence', 'instrumental'].includes(section.kind);
        const likely = !instrumental && vocalLikelihood > 0.42;
        return {
            start: section.start,
            end: section.end,
            type: likely ? 'vocal' : instrumental ? 'instrumental' : 'unknown',
            confidence: round(clamp01(likely ? vocalLikelihood : 0.55), 3),
        };
    });
    const vocalTime = regions.filter((region) => region.type === 'vocal').reduce((sum, region) => sum + (region.end - region.start), 0);
    const total = Math.max(1, sections.reduce((sum, section) => sum + (section.end - section.start), 0));
    return {
        regions,
        vocalCoverage: round(clamp01(vocalTime / total), 3),
        maxDensity: round(clamp01(vocalLikelihood * 0.7 + transientDensity * 0.2), 3),
        risk: round(clamp01(vocalLikelihood * 0.8 + transientDensity * 0.1), 3),
        kind: 'unknown',
    };
}
function classifyGenre(bpm, bands, transient, centroid, flatness) {
    const b = bpm || 120;
    const scores = [
        { label: 'electronic', score: 0.25 + bands.low * 0.2 + transient * 0.2 + (b > 110 && b < 150 ? 0.2 : 0) },
        { label: 'house', score: bands.low * 0.35 + (b > 115 && b < 135 ? 0.28 : 0) + transient * 0.12 },
        { label: 'techno', score: bands.low * 0.3 + (b > 125 && b < 155 ? 0.24 : 0) + (1 - flatness) * 0.1 },
        { label: 'trance', score: (b > 130 && b < 150 ? 0.28 : 0) + bands.high * 0.18 + (1 - flatness) * 0.1 },
        { label: 'drum and bass', score: (b > 160 ? 0.35 : 0) + transient * 0.22 + bands.low * 0.1 },
        { label: 'dubstep', score: (b > 135 && b < 150 ? 0.16 : 0) + bands.low * 0.25 + (1 - flatness) * 0.12 },
        { label: 'hip-hop', score: (b > 75 && b < 105 ? 0.25 : 0) + bands.low * 0.2 + transient * 0.08 },
        { label: 'pop', score: centroid > 1800 ? 0.16 : 0.08 },
        { label: 'rock', score: bands.mid * 0.25 + transient * 0.15 + (centroid > 1600 ? 0.12 : 0) },
        { label: 'metal', score: transient * 0.3 + bands.high * 0.18 + (centroid > 3000 ? 0.12 : 0) },
        { label: 'jazz', score: (1 - transient) * 0.18 + bands.mid * 0.12 + (b > 70 && b < 140 ? 0.1 : 0) },
        { label: 'classical', score: (1 - transient) * 0.22 + (1 - bands.low) * 0.16 + (centroid > 1400 ? 0.08 : 0) },
        { label: 'ambient', score: (1 - transient) * 0.28 + (1 - bands.low) * 0.18 + (flatness > 0.2 ? 0.08 : 0) },
    ].map((entry) => ({ ...entry, score: round(clamp01(entry.score), 3) })).sort((a, b2) => b2.score - a.score);
    const best = scores[0];
    const second = scores[1];
    const confidence = round(clamp01((best.score - second.score) / Math.max(0.15, best.score)), 3);
    return {
        label: best.score >= 0.2 && confidence >= 0.25 ? best.label : 'unknown',
        confidence,
        alternatives: scores.slice(0, 4),
    };
}
function estimateInstruments(bands, transient, centroid, flatness) {
    return {
        drums: round(clamp01(transient * 0.8), 2),
        bass: round(clamp01(bands.low * 1.2), 2),
        guitars: round(clamp01(bands.mid * 0.6 + transient * 0.18), 2),
        keys: round(clamp01(bands.mid * 0.7 + (1 - flatness) * 0.1), 2),
        synths: round(clamp01(bands.high * 0.55 + (centroid > 2400 ? 0.18 : 0)), 2),
        strings: round(clamp01((1 - transient) * 0.25 + bands.mid * 0.2), 2),
        brass: round(clamp01(bands.mid * 0.2 + bands.high * 0.18), 2),
        orchestral: round(clamp01((1 - transient) * 0.22 + (1 - bands.low) * 0.18), 2),
        electronic: round(clamp01(bands.low * 0.2 + bands.high * 0.25 + transient * 0.15), 2),
    };
}
function estimateLufs(samples) {
    const block = 4000;
    const powers = [];
    for (let i = 0; i + block <= samples.length; i += block) {
        let sum = 0;
        for (let j = 0; j < block; j += 1)
            sum += samples[i + j] * samples[i + j];
        powers.push(sum / block);
    }
    if (!powers.length)
        return -70;
    powers.sort((a, b) => a - b);
    const gated = powers.slice(Math.floor(powers.length * 0.1));
    const meanPower = gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length);
    return round(-0.691 + 10 * Math.log10(meanPower + 1e-12), 2);
}
function analyzeAudioBuffer(buffer, options = {}) {
    const targetRate = options.targetSampleRate || 22050;
    const maxDuration = options.maxDurationSec || 600;
    const duration = Math.min(buffer.duration, maxDuration);
    const maxLength = Math.min(buffer.length, Math.floor(buffer.sampleRate * maxDuration));
    const limited = {
        sampleRate: buffer.sampleRate,
        length: maxLength,
        numberOfChannels: buffer.numberOfChannels,
        duration,
        getChannelData: buffer.getChannelData.bind(buffer),
    };
    const { samples, sampleRate } = mixToMono(limited, targetRate);
    const features = frameFeatures(samples, sampleRate);
    const fps = sampleRate / 512;
    const spectralOnset = normalizeOnset(features.flux);
    const lowOnset = normalizeOnset(features.lowFlux);
    const onset = Float32Array.from(spectralOnset, (value, index) => value * 0.72 + lowOnset[index] * 0.55);
    const tempo = estimateTempo(onset, fps);
    const grid = tempo.confidence > 0.04 ? buildBeatGrid(features, tempo, duration, fps) : null;
    const half = Math.floor(onset.length / 2);
    const firstHalf = estimateTempo(onset.subarray(0, Math.max(8, half)), fps);
    const secondHalf = estimateTempo(onset.subarray(half), fps);
    const halfDelta = Math.abs(firstHalf.bpm - secondHalf.bpm) / Math.max(1, tempo.bpm);
    const tempoStability = grid ? round(clamp01(1 - halfDelta / 0.04), 3) : 0;
    const tempoAlternatives = grid
        ? [...new Set([round(tempo.bpm / 2, 2), round(tempo.bpm, 2), round(tempo.bpm * 2, 2)])].filter((value) => value >= 50 && value <= 220)
        : [];
    const sections = buildSections(features, grid, duration);
    const cues = buildCues(sections, grid, duration);
    const chroma = new Float32Array(12);
    for (const frame of features.chroma)
        for (let i = 0; i < 12; i += 1)
            chroma[i] += frame[i];
    const key = detectKey(chroma);
    const rmsValue = rms(samples);
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1)
        peak = Math.max(peak, Math.abs(samples[i]));
    const low = mean(features.low);
    const mid = mean(features.mid);
    const high = mean(features.high);
    const transientDensity = clamp01(features.flux.filter((value) => value > 0.02).length / Math.max(1, features.flux.length) * 4);
    const vocalLikelihood = clamp01((mid * 1.4 + (1 - mean(features.flatness)) * 0.35) - low * 0.35);
    const intensity = clamp01(mean(features.rms) * 5 + transientDensity * 0.35 + high * 0.3);
    const tempoMap = buildTempoMap(onset, fps, duration, tempo);
    const meter = detectMeter(features, grid);
    const vocalProfile = buildVocalProfile(sections, vocalLikelihood, transientDensity);
    const genre = classifyGenre(grid?.bpm ?? tempo.bpm, { low, mid, high }, transientDensity, mean(features.centroid), mean(features.flatness));
    const instruments = estimateInstruments({ low, mid, high }, transientDensity, mean(features.centroid), mean(features.flatness));
    const rhythmMode = grid ? 'beat' : transientDensity > 0.2 ? 'event' : 'none';
    const warnings = [];
    if (tempo.confidence < 0.15)
        warnings.push('Темп определён неуверенно; переход может быть упрощён.');
    if (key.confidence < 0.08)
        warnings.push('Тональность определена неуверенно; гармоническая совместимость не гарантируется.');
    if (duration >= maxDuration)
        warnings.push('Анализ ограничен первыми 10 минутами трека.');
    return {
        id: options.id || `track-${Date.now()}`,
        title: options.title || 'Untitled',
        artist: options.artist,
        duration,
        sampleRate,
        bpm: grid?.bpm ?? tempo.bpm,
        bpmConfidence: grid?.confidence ?? 0,
        tempoAlternatives,
        tempoStability,
        phrases: grid ? grid.downbeats.filter((_, index) => index % Math.max(1, grid.phraseBars) === 0) : [],
        vocalRisk: round(clamp01(vocalLikelihood * 0.7 + transientDensity * 0.15), 3),
        tempoMap,
        rhythmMode,
        meter,
        vocal: vocalProfile,
        genre,
        instruments,
        grid,
        key: key.key,
        camelot: key.camelot,
        keyConfidence: key.confidence,
        sections,
        cues,
        loudness: {
            rms: round(rmsValue, 4),
            lufsEstimate: estimateLufs(samples),
            peak: round(peak, 4),
            dynamicRange: round(peak / Math.max(rmsValue, 1e-6), 2),
        },
        spectrum: {
            centroid: round(mean(features.centroid), 1),
            rolloff: round(mean(features.rolloff), 1),
            flux: round(mean(features.flux), 4),
            flatness: round(mean(features.flatness), 4),
        },
        bands: { low: round(low, 3), mid: round(mid, 3), high: round(high, 3) },
        transientDensity: round(transientDensity, 3),
        vocalLikelihood: round(vocalLikelihood, 3),
        instrumentalLikelihood: round(1 - vocalLikelihood, 3),
        intensity: round(intensity, 3),
        energyProfile: sections.map((section) => section.energy),
        waveform: buildWaveform(samples),
        warnings,
    };
}
function camelotDistance(a, b) {
    if (!a || !b)
        return 3;
    const parse = (value) => {
        const m = /^(\d+)([AB])$/.exec(value);
        return m ? { n: Number(m[1]), mode: m[2] } : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb)
        return 3;
    const diff = Math.abs(pa.n - pb.n);
    const wheel = Math.min(diff, 12 - diff);
    return wheel + (pa.mode === pb.mode ? 0 : 2);
}
function bpmRatio(a, b) {
    if (!a || !b)
        return 1;
    let ratio = b / a;
    while (ratio > 1.25)
        ratio /= 2;
    while (ratio < 0.8)
        ratio *= 2;
    return ratio;
}

function parseCamelot(value) {
    if (!value)
        return null;
    const match = /^(\d{1,2})([AB])$/.exec(value.trim().toUpperCase());
    if (!match)
        return null;
    return { n: Number(match[1]), mode: match[2] };
}
/**
 * Camelot-aware compatibility. This is a score, not a hard gate: a key clash
 * lowers the score but does not forbid a transition.
 */
function harmonicCompatibility(a, b, tempoRatio = 1) {
    const ka = parseCamelot(a.camelot);
    const kb = parseCamelot(b.camelot);
    const confidence = clamp(Math.min(a.keyConfidence, b.keyConfidence) * 1.15, 0, 1);
    if (!ka || !kb) {
        return { score: 0.5, relation: 'unknown', conflict: false, confidence, explanation: 'Тональность неизвестна; гармония не блокирует переход.' };
    }
    const diff = Math.abs(ka.n - kb.n);
    const wheel = Math.min(diff, 12 - diff);
    let score = 0.55;
    let relation = 'unknown';
    let explanation = '';
    if (ka.n === kb.n && ka.mode === kb.mode) {
        score = 1;
        relation = 'same';
        explanation = 'Одна и та же тональность.';
    }
    else if (ka.n === kb.n && ka.mode !== kb.mode) {
        score = 0.92;
        relation = 'relative';
        explanation = 'Относительный мажор/минор.';
    }
    else if (wheel === 1 && ka.mode === kb.mode) {
        score = 0.88;
        relation = 'adjacent';
        explanation = 'Соседняя тональность на колесе Camelot.';
    }
    else if (wheel === 1) {
        score = 0.8;
        relation = 'parallel';
        explanation = 'Параллельная соседняя тональность.';
    }
    else if (wheel === 2 && ka.mode === kb.mode) {
        score = 0.7;
        relation = 'two-apart';
        explanation = 'Две ступени на колесе Camelot.';
    }
    else {
        score = wheel >= 4 ? 0.22 : 0.42;
        relation = 'clash';
        explanation = `Тональный конфликт (${a.camelot} → ${b.camelot}).`;
    }
    // Fast beatmatching stresses the harmonic relationship less than a long blend.
    score *= 1 - clamp(Math.abs(tempoRatio - 1) * 1.8, 0, 0.25);
    return {
        score: round(clamp(score * (0.65 + confidence * 0.35), 0, 1), 3),
        relation,
        conflict: relation === 'clash' && confidence > 0.18,
        confidence: round(confidence, 3),
        explanation,
    };
}

const OUT_SCORE = {
    outro: 1, breakdown: 0.92, ambient: 0.9, interlude: 0.82, instrumental: 0.8, build: 0.72, verse: 0.58, bridge: 0.55, chorus: 0.45, drop: 0.32, intro: 0.25, silence: 0.1, unknown: 0.4,
};
const IN_SCORE = {
    intro: 1, instrumental: 0.9, ambient: 0.88, verse: 0.72, build: 0.78, breakdown: 0.68, chorus: 0.62, drop: 0.6, bridge: 0.5, interlude: 0.7, outro: 0.25, silence: 0.1, unknown: 0.4,
};
function vocalDensityAt(analysis, time) {
    const regions = analysis.vocal?.regions ?? [];
    let overlap = 0;
    for (const region of regions) {
        if (region.type !== 'vocal')
            continue;
        overlap += Math.max(0, Math.min(time + 1, region.end) - Math.max(time, region.start));
    }
    return Math.min(1, overlap);
}
function phraseAligned(analysis, time) {
    const grid = analysis.grid;
    if (!grid?.downbeats.length)
        return false;
    const index = grid.downbeats.findIndex((beat) => Math.abs(beat - time) < 0.09);
    if (index < 0)
        return false;
    return index % Math.max(1, grid.phraseBars) === 0;
}
function nearestDownbeat$1(analysis, time) {
    const grid = analysis.grid;
    if (!grid?.downbeats.length)
        return Math.max(0, Math.min(analysis.duration, time));
    let best = grid.downbeats[0];
    for (const beat of grid.downbeats)
        if (Math.abs(beat - time) < Math.abs(best - time))
            best = beat;
    return best;
}
function sectionAt(analysis, time) {
    return analysis.sections.find((section) => time >= section.start && time < section.end)?.kind ?? null;
}
function sectionConfidenceAt(analysis, time) {
    return analysis.sections.find((section) => time >= section.start && time < section.end)?.confidence ?? null;
}
/**
 * Chooses a real transition window from section boundaries, cues, beatgrid,
 * vocal regions and energy. No structural classifier is simulated.
 */
function selectTransitionWindow(out, incoming, context, strategy, durationSec) {
    const duration = Math.max(0.6, durationSec);
    const minStart = Math.max(0, context.position + 0.15);
    const maxStart = Math.max(minStart, out.duration - 0.5);
    const outCandidates = new Set();
    outCandidates.add(Math.min(maxStart, out.cues.mixOut));
    outCandidates.add(Math.min(maxStart, context.position + 2));
    for (const section of out.sections) {
        if (section.start >= minStart && section.start <= maxStart)
            outCandidates.add(section.start);
        const late = section.end - duration;
        if (late >= minStart && late <= maxStart)
            outCandidates.add(late);
    }
    const inCandidates = new Set();
    inCandidates.add(incoming.cues.intro);
    inCandidates.add(incoming.cues.mixIn);
    for (const section of incoming.sections)
        inCandidates.add(section.start);
    const windows = [];
    for (const rawStart of outCandidates) {
        const startAt = Math.min(maxStart, Math.max(minStart, nearestDownbeat$1(out, rawStart)));
        const outEnd = Math.min(out.duration - 0.05, startAt + duration);
        if (outEnd - startAt < 0.6)
            continue;
        const outKind = sectionAt(out, startAt);
        for (const rawIn of inCandidates) {
            const inStart = Math.max(0, Math.min(incoming.duration - 0.6, nearestDownbeat$1(incoming, rawIn)));
            if (inStart + (outEnd - startAt) > incoming.duration - 0.1)
                continue;
            const inKind = sectionAt(incoming, inStart);
            const outVocal = vocalDensityAt(out, startAt);
            const inVocal = vocalDensityAt(incoming, inStart);
            const vocalCollision = Math.min(outVocal, inVocal);
            const outScore = outKind ? OUT_SCORE[outKind] ?? 0.4 : 0.4;
            const inScore = inKind ? IN_SCORE[inKind] ?? 0.4 : 0.4;
            let pairBonus = 0;
            if (outKind === 'outro' && inKind === 'intro')
                pairBonus = 0.2;
            else if (outKind === 'breakdown' && inKind === 'drop')
                pairBonus = 0.18;
            else if (outKind === 'build' && inKind === 'drop')
                pairBonus = 0.16;
            else if (outKind === 'instrumental' && inKind === 'instrumental')
                pairBonus = 0.12;
            const phrase = phraseAligned(out, startAt) ? 0.1 : 0;
            const energyDelta = Math.abs((out.sections.find((s) => s.start <= startAt && s.end > startAt)?.energy ?? 0.5) - (incoming.sections.find((s) => s.start <= inStart && s.end > inStart)?.energy ?? 0.5));
            const energyScore = Math.max(0, 1 - energyDelta);
            const vocalPenalty = strategy === 'vocal-safe' || strategy === 'vocal-handoff' ? vocalCollision * 0.08 : Math.max(0, vocalCollision - 0.2) * 0.35;
            const remainingFit = outEnd <= out.duration ? 0.08 : 0;
            const score = Math.max(0, Math.min(1, outScore * 0.3 + inScore * 0.28 + pairBonus + phrase + energyScore * 0.12 + remainingFit - vocalPenalty));
            const outConfidence = sectionConfidenceAt(out, startAt);
            const inConfidence = sectionConfidenceAt(incoming, inStart);
            const confidence = outConfidence == null || inConfidence == null ? 0 : Math.min(outConfidence, inConfidence);
            const reasons = [
                `${outKind ?? 'unknown'} → ${inKind ?? 'unknown'}`,
                `energy Δ${energyDelta.toFixed(2)}`,
                vocalCollision > 0.25 ? `vocal overlap ${vocalCollision.toFixed(2)}` : 'vocal overlap low',
                phrase ? 'phrase-aligned' : 'internal phrase',
            ];
            windows.push({
                strategy,
                startAt: Number(startAt.toFixed(3)),
                outEnd: Number(outEnd.toFixed(3)),
                inStart: Number(inStart.toFixed(3)),
                durationSec: Number((outEnd - startAt).toFixed(3)),
                score: Number(score.toFixed(4)),
                reasons,
                uncertainty: confidence > 0.65 ? 'low' : confidence > 0.35 ? 'medium' : 'high',
                evidence: ['section', 'beatgrid', 'vocal', 'energy', 'cue'],
            });
        }
    }
    if (!windows.length) {
        const startAt = Math.min(maxStart, Math.max(minStart, nearestDownbeat$1(out, out.cues.mixOut)));
        const outEnd = Math.min(out.duration, startAt + duration);
        return {
            strategy,
            startAt,
            outEnd,
            inStart: Math.max(0, Math.min(incoming.duration - 0.6, incoming.cues.intro)),
            durationSec: Math.max(0.6, outEnd - startAt),
            score: 0.25,
            reasons: ['no structural window; beatgrid/cue fallback'],
            uncertainty: 'high',
            evidence: ['beatgrid', 'cue', 'fallback'],
        };
    }
    windows.sort((a, b) => b.score - a.score || a.startAt - b.startAt || a.inStart - b.inStart);
    return windows[0];
}

const ALLOWED_LENGTHS = [1, 2, 4, 8, 16];
function nearestDownbeatAtOrBefore(analysis, time) {
    const downbeats = analysis.grid?.downbeats ?? [];
    if (!downbeats.length)
        return null;
    let best = null;
    for (const beat of downbeats) {
        if (beat <= time + 0.12 && (best == null || beat > best))
            best = beat;
    }
    return best;
}
/** Quantized loop selection from real beatgrid; null when no reliable grid. */
function selectLoopWindow(analysis, position, preferredBeats = 4) {
    const bpm = analysis.bpm;
    if (!bpm || !analysis.grid?.downbeats.length)
        return null;
    const lengthBeats = ALLOWED_LENGTHS.includes(preferredBeats) ? preferredBeats : 4;
    const beatSec = 60 / bpm;
    const start = nearestDownbeatAtOrBefore(analysis, position);
    if (start == null)
        return null;
    let end = start + beatSec * lengthBeats;
    if (end > analysis.duration - 0.05) {
        const shifted = Math.max(0, analysis.duration - 0.05 - beatSec * lengthBeats);
        const shiftedStart = nearestDownbeatAtOrBefore(analysis, shifted);
        if (shiftedStart == null || shiftedStart + beatSec * lengthBeats > analysis.duration)
            return null;
        end = shiftedStart + beatSec * lengthBeats;
        return { start: shiftedStart, end, lengthBeats, confidence: analysis.grid.confidence >= 0.6 ? 'high' : analysis.grid.confidence >= 0.35 ? 'medium' : 'low' };
    }
    return { start, end, lengthBeats, confidence: analysis.grid.confidence >= 0.6 ? 'high' : analysis.grid.confidence >= 0.35 ? 'medium' : 'low' };
}
/**
 * Drives a real HTMLMediaElement loop. Native loopStart/loopEnd are used when
 * present, with a watchdog timer as a fallback for browsers that ignore them.
 * This is a media-element loop, not a sample-accurate AudioBuffer loop.
 */
class LoopExecutor {
    element;
    intervalMs;
    timer = null;
    active = false;
    startAt = 0;
    endAt = 0;
    constructor(element, intervalMs = 30) {
        this.element = element;
        this.intervalMs = intervalMs;
    }
    get isActive() {
        return this.active;
    }
    get boundaries() {
        return this.active ? { start: this.startAt, end: this.endAt } : null;
    }
    start(start, end) {
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start < 0.08)
            return false;
        this.stop();
        this.startAt = Math.max(0, start);
        this.endAt = Math.min(this.element.duration || end, end);
        if (this.endAt - this.startAt < 0.08)
            return false;
        try {
            this.element.loopStart = this.startAt;
            this.element.loopEnd = this.endAt;
            this.element.loop = true;
            this.element.currentTime = this.startAt;
            this.active = true;
            this.timer = globalThis.setInterval(() => this.watchdog(), this.intervalMs);
            return true;
        }
        catch {
            this.stop();
            return false;
        }
    }
    setLength(seconds) {
        if (!this.active)
            return false;
        const end = this.startAt + Math.max(0.08, seconds);
        if (end > (this.element.duration || end))
            return false;
        this.endAt = end;
        try {
            this.element.loopEnd = end;
            return true;
        }
        catch {
            return false;
        }
    }
    stop() {
        if (this.timer != null) {
            globalThis.clearInterval(this.timer);
            this.timer = null;
        }
        if (this.active) {
            try {
                this.element.loop = false;
                this.element.loopStart = 0;
                this.element.loopEnd = 0;
            }
            catch { /* ignore */ }
        }
        this.active = false;
    }
    /** Exposed for deterministic tests and diagnostics. */
    tick() {
        this.watchdog();
    }
    watchdog() {
        if (!this.active)
            return;
        const time = this.element.currentTime;
        if (!Number.isFinite(time))
            return;
        if (time >= this.endAt - 0.02 || time < this.startAt - 0.15) {
            try {
                this.element.currentTime = this.startAt;
            }
            catch {
                this.stop();
            }
        }
    }
}

const META = {
    'beat-blend': { group: 'beat', beats: 16, minBeats: 8, label: 'Beatmatched phrase blend' },
    'long-phrase-blend': { group: 'beat', beats: 32, minBeats: 16, label: 'Long phrase blend' },
    'bass-swap': { group: 'bass', beats: 16, minBeats: 8, label: 'Bass swap' },
    'filter-sweep': { group: 'filter', beats: 8, minBeats: 4, label: 'Filter sweep' },
    'echo-out': { group: 'echo', beats: 8, minBeats: 4, label: 'Echo out' },
    'reverb-transition': { group: 'filter', beats: 8, minBeats: 4, label: 'Reverb transition' },
    'delay-transition': { group: 'echo', beats: 8, minBeats: 4, label: 'Delay transition' },
    'percussion-blend': { group: 'beat', beats: 16, minBeats: 8, label: 'Percussion blend' },
    'vocal-safe': { group: 'vocal', beats: 8, minBeats: 4, label: 'Vocal-safe transition' },
    'vocal-handoff': { group: 'vocal', beats: 16, minBeats: 8, label: 'Vocal handoff' },
    'instrumental-bridge': { group: 'beat', beats: 16, minBeats: 8, label: 'Instrumental bridge' },
    'breakdown-to-drop': { group: 'filter', beats: 16, minBeats: 8, label: 'Breakdown → drop' },
    'build-up': { group: 'filter', beats: 16, minBeats: 8, label: 'Build-up transition' },
    'ambient-fade': { group: 'fade', beats: 16, minBeats: 8, label: 'Ambient fade' },
    atmospheric: { group: 'fade', beats: 16, minBeats: 8, label: 'Atmospheric transition' },
    'frequency-swap': { group: 'bass', beats: 8, minBeats: 4, label: 'Frequency swap' },
    'loop-assisted': { group: 'special', beats: 8, minBeats: 4, label: 'Loop-assisted transition' },
    'tempo-ramp': { group: 'special', beats: 16, minBeats: 8, label: 'Tempo ramp' },
    'half-time': { group: 'special', beats: 8, minBeats: 4, label: 'Half-time transition' },
    'double-time': { group: 'special', beats: 8, minBeats: 4, label: 'Double-time transition' },
    harmonic: { group: 'beat', beats: 16, minBeats: 8, label: 'Harmonic transition' },
    'rhythmic-cut': { group: 'cut', beats: 4, minBeats: 4, label: 'Rhythmic cut' },
    'energy-based': { group: 'bass', beats: 8, minBeats: 4, label: 'Energy-based transition' },
    cinematic: { group: 'fade', beats: 16, minBeats: 8, label: 'Cinematic transition' },
    'intelligent-hard-cut': { group: 'cut', beats: 4, minBeats: 4, label: 'Intelligent hard cut' },
};
const STRATEGY_ORDER = Object.keys(META);
function sectionOf(analysis, kinds) {
    return analysis.sections.find((section) => kinds.includes(section.kind));
}
function nearestDownbeat(analysis, time, direction = 'nearest') {
    const grid = analysis.grid;
    if (!grid || !grid.downbeats.length)
        return clamp(time, 0, analysis.duration);
    if (direction === 'next')
        return grid.downbeats.find((value) => value >= time - 0.001) ?? grid.downbeats[grid.downbeats.length - 1];
    let best = grid.downbeats[0];
    let bestD = Math.abs(best - time);
    for (const value of grid.downbeats) {
        const d = Math.abs(value - time);
        if (d < bestD) {
            best = value;
            bestD = d;
        }
    }
    return bestD <= 2.5 ? best : clamp(time, 0, analysis.duration);
}
function chooseOutStart(a, context, durationSec, strategy) {
    let target = Math.min(a.cues.mixOut, a.duration - Math.max(1, durationSec));
    if (strategy === 'breakdown-to-drop') {
        const section = sectionOf(a, ['breakdown']);
        if (section)
            target = section.start;
    }
    else if (strategy === 'build-up') {
        const section = sectionOf(a, ['build']);
        if (section)
            target = section.start;
    }
    else if (strategy === 'ambient-fade' || strategy === 'cinematic') {
        target = Math.max(a.cues.mixOut, a.duration - Math.max(2, durationSec));
    }
    const now = clamp(context.position, 0, a.duration);
    if (target - now < 1.5)
        target = Math.max(now + 0.2, a.duration - Math.max(1, durationSec));
    target = Math.max(target, now + 0.15);
    target = Math.min(target, Math.max(now, a.duration - 0.35));
    return nearestDownbeat(a, target);
}
function chooseInStart(b, strategy) {
    if (strategy === 'breakdown-to-drop' || strategy === 'build-up') {
        const drop = sectionOf(b, ['drop', 'chorus']);
        if (drop)
            return nearestDownbeat(b, drop.start);
    }
    if (strategy === 'instrumental-bridge') {
        const instrumental = sectionOf(b, ['instrumental', 'ambient', 'interlude']);
        if (instrumental)
            return nearestDownbeat(b, instrumental.start);
    }
    if (strategy === 'vocal-handoff') {
        const vocal = b.vocal?.regions.find((region) => region.type === 'vocal' && region.start > b.duration * 0.04);
        if (vocal)
            return nearestDownbeat(b, vocal.start);
    }
    if (strategy === 'ambient-fade' || strategy === 'atmospheric' || strategy === 'cinematic') {
        return nearestDownbeat(b, b.cues.intro);
    }
    if (strategy === 'rhythmic-cut' || strategy === 'intelligent-hard-cut') {
        const drop = sectionOf(b, ['drop', 'chorus']);
        if (drop)
            return nearestDownbeat(b, drop.start);
    }
    return nearestDownbeat(b, b.cues.mixIn);
}
function durationBeats(strategy, min, max) {
    return clamp(META[strategy].beats, min, max);
}
function scoreStrategy(strategy, a, b) {
    const meta = META[strategy];
    const reasons = [];
    const warnings = [];
    const gap = Math.abs(bpmRatio(a.bpm, b.bpm) - 1);
    const keyDist = camelotDistance(a.camelot, b.camelot);
    const harmonic = harmonicCompatibility(a, b, bpmRatio(a.bpm, b.bpm)).score;
    const vocalRisk = Math.max(a.vocal?.risk || 0, b.vocal?.risk || 0, a.vocalRisk || 0, b.vocalRisk || 0);
    const energyGap = Math.abs(a.intensity - b.intensity);
    const grid = !!a.grid?.beats.length && !!b.grid?.beats.length;
    const instrumentalB = !!sectionOf(b, ['instrumental', 'ambient', 'interlude']);
    const breakdownA = !!sectionOf(a, ['breakdown']);
    const buildA = !!sectionOf(a, ['build']);
    const dropB = !!sectionOf(b, ['drop', 'chorus']);
    let score = 0.42;
    const beatLike = ['beat-blend', 'long-phrase-blend', 'bass-swap', 'percussion-blend', 'harmonic', 'half-time', 'double-time'].includes(strategy);
    if (grid && gap < 0.03) {
        score += beatLike ? 0.26 : 0.08;
        reasons.push('BPM и beatgrid совместимы');
    }
    if (grid && gap < 0.07) {
        score += beatLike ? 0.13 : 0.04;
        reasons.push('Умеренный BPM gap');
    }
    if (!grid) {
        score += ['ambient-fade', 'atmospheric', 'cinematic', 'intelligent-hard-cut', 'echo-out', 'reverb-transition'].includes(strategy) ? 0.26 : -0.35;
        warnings.push('Нет надёжного beatgrid: beatmatching недоступен');
    }
    if (gap > 0.1 && ['ambient-fade', 'atmospheric', 'cinematic', 'tempo-ramp', 'intelligent-hard-cut', 'echo-out', 'reverb-transition'].includes(strategy))
        score += 0.15;
    if (keyDist <= 2) {
        score += 0.08;
        reasons.push('Гармоническая совместимость');
    }
    else if (keyDist >= 4) {
        score += ['echo-out', 'reverb-transition', 'atmospheric', 'intelligent-hard-cut'].includes(strategy) ? 0.1 : -0.04;
        warnings.push('Тональный конфликт');
    }
    if (harmonic > 0.75)
        score += 0.05;
    if (vocalRisk > 0.55) {
        score += ['vocal-safe', 'vocal-handoff', 'instrumental-bridge', 'echo-out'].includes(strategy) ? 0.12 : -0.08;
        if (['vocal-safe', 'vocal-handoff'].includes(strategy))
            reasons.push('Высокий vocal risk: вокал разводится');
    }
    if (strategy === 'vocal-safe')
        score += vocalRisk * 0.1;
    if (strategy === 'vocal-handoff')
        score += vocalRisk * 0.12 + (b.vocal?.regions.length ? 0.04 : 0);
    if (strategy === 'instrumental-bridge')
        score += instrumentalB ? 0.25 : -0.15;
    if (strategy === 'breakdown-to-drop')
        score += breakdownA && dropB ? 0.32 : -0.2;
    if (strategy === 'build-up')
        score += buildA && dropB ? 0.3 : -0.15;
    if (strategy === 'ambient-fade')
        score += (a.intensity < 0.5 || b.intensity < 0.5) ? 0.2 : 0.02;
    if (strategy === 'atmospheric')
        score += (a.spectrum.flatness > 0.25 || b.spectrum.flatness > 0.25) ? 0.18 : 0.02;
    if (strategy === 'percussion-blend')
        score += (a.transientDensity + b.transientDensity) / 2 > 0.6 ? 0.15 : -0.05;
    if (strategy === 'long-phrase-blend')
        score += (a.duration > 150 && b.duration > 150) ? 0.1 : -0.08;
    if (strategy === 'frequency-swap')
        score += Math.abs(a.bands.low - b.bands.low) > 0.16 ? 0.15 : 0;
    if (strategy === 'tempo-ramp')
        score += gap > 0.06 && gap < 0.2 ? 0.24 : -0.08;
    if (strategy === 'half-time') {
        const r = (b.bpm || 120) / (a.bpm || 120);
        score += r > 1.7 && r < 2.3 ? 0.32 : -0.25;
    }
    if (strategy === 'double-time') {
        const r = (a.bpm || 120) / (b.bpm || 120);
        score += r > 1.7 && r < 2.3 ? 0.32 : -0.25;
    }
    if (strategy === 'harmonic')
        score += harmonic > 0.72 ? 0.2 : -0.12;
    if (strategy === 'rhythmic-cut')
        score += grid && a.transientDensity > 0.55 ? 0.2 : -0.08;
    if (strategy === 'energy-based')
        score += energyGap > 0.25 ? 0.18 : 0.03;
    if (strategy === 'cinematic')
        score += (a.duration > 180 && b.duration > 180) ? 0.12 : 0;
    if (strategy === 'intelligent-hard-cut')
        score += gap > 0.1 || !grid ? 0.2 : 0.02;
    if (strategy === 'loop-assisted') {
        score += grid ? 0.12 : -0.3;
        warnings.push('Loop-assisted требует надёжного beatgrid; при отсутствии будет безопасный fallback');
    }
    if (strategy === 'half-time' || strategy === 'double-time')
        warnings.push('Half/double-time — экспериментальный режим, без экстремального растяжения');
    if (strategy === 'reverb-transition')
        warnings.push('Reverb реализован как фильтр/echo-огибающая, не convolution reverb');
    if (strategy === 'delay-transition')
        warnings.push('Delay использует echo-send существующего графа');
    if (strategy === 'tempo-ramp')
        warnings.push('Tempo ramp выполняется как ограниченная коррекция ставок, не непрерывная кривая');
    const label = meta.label;
    reasons.unshift(label);
    return { strategy, score: round(clamp01(score), 3), reasons, warnings };
}
function automation(points) {
    return points.map(([at, value]) => ({ at: round(clamp01(at), 3), value: round(value, 3) }));
}
function equalPowerGain() {
    const points = 12;
    const out = [];
    const inn = [];
    for (let i = 0; i <= points; i += 1) {
        const t = i / points;
        out.push([t, Math.cos((t * Math.PI) / 2)]);
        inn.push([t, Math.sin((t * Math.PI) / 2)]);
    }
    return { out: automation(out), in: automation(inn) };
}
function buildEq(strategy) {
    const group = META[strategy].group;
    if (strategy === 'bass-swap') {
        return {
            out: { low: automation([[0, 0], [0.35, 0], [0.5, -24], [1, -24]]), mid: automation([[0, 0], [0.45, 0], [1, -8]]), high: automation([[0, 0], [0.6, 0], [1, -6]]) },
            in: { low: automation([[0, -24], [0.45, -24], [0.56, 0], [1, 0]]), mid: automation([[0, -6], [0.55, 0], [1, 0]]), high: automation([[0, -4], [0.55, 0], [1, 0]]) },
        };
    }
    if (strategy === 'frequency-swap') {
        return {
            out: { low: automation([[0, 0], [0.48, 0], [0.52, -24], [1, -24]]), mid: automation([[0, 0], [0.5, -4], [1, -10]]), high: automation([[0, 0], [0.65, 2], [1, -4]]) },
            in: { low: automation([[0, -24], [0.48, -24], [0.55, 0], [1, 0]]), mid: automation([[0, -8], [0.5, -4], [1, 0]]), high: automation([[0, -6], [0.7, 0], [1, 0]]) },
        };
    }
    if (strategy === 'energy-based') {
        return {
            out: { low: automation([[0, 0], [0.2, -2], [0.65, -12], [1, -18]]), mid: automation([[0, 0], [1, -6]]), high: automation([[0, 0], [1, -2]]) },
            in: { low: automation([[0, -18], [0.45, -12], [1, 0]]), mid: automation([[0, -8], [0.7, 0], [1, 0]]), high: automation([[0, -4], [0.7, 0], [1, 0]]) },
        };
    }
    if (strategy === 'beat-blend' || strategy === 'long-phrase-blend' || strategy === 'percussion-blend' || strategy === 'harmonic') {
        const cut = strategy === 'long-phrase-blend' ? 0.42 : strategy === 'percussion-blend' ? 0.5 : 0.46;
        const mid = strategy === 'percussion-blend' ? -12 : strategy === 'long-phrase-blend' ? -7 : -5;
        return {
            out: { low: automation([[0, 0], [cut - 0.08, 0], [cut + 0.06, -18], [1, -20]]), mid: automation([[0, 0], [1, mid]]), high: automation([[0, 0], [0.7, 0], [1, strategy === 'percussion-blend' ? -6 : -2]]) },
            in: { low: automation([[0, -18], [cut - 0.02, -18], [cut + 0.1, 0], [1, 0]]), mid: automation([[0, -6], [0.65, 0], [1, 0]]), high: automation([[0, -4], [0.7, 0], [1, 0]]) },
        };
    }
    if (strategy === 'vocal-safe') {
        return {
            out: { low: automation([[0, 0], [0.3, -8], [1, -14]]), mid: automation([[0, 0], [0.22, -18], [0.75, -20], [1, -24]]), high: automation([[0, 0], [1, -6]]) },
            in: { low: automation([[0, -24], [0.5, -18], [1, 0]]), mid: automation([[0, -24], [0.55, -16], [1, 0]]), high: automation([[0, -8], [0.7, 0], [1, 0]]) },
        };
    }
    if (strategy === 'vocal-handoff') {
        return {
            out: { low: automation([[0, 0], [0.5, -8], [1, -12]]), mid: automation([[0, 0], [0.5, -8], [0.56, -24], [1, -24]]), high: automation([[0, 0], [1, -4]]) },
            in: { low: automation([[0, -12], [0.5, -6], [1, 0]]), mid: automation([[0, -24], [0.52, -24], [0.62, 0], [1, 0]]), high: automation([[0, -6], [0.6, 0], [1, 0]]) },
        };
    }
    if (strategy === 'filter-sweep') {
        return {
            out: { low: automation([[0, 0], [0.6, -4], [1, -12]]), mid: automation([[0, 0], [1, -4]]), high: automation([[0, 0], [1, 0]]) },
            in: { low: automation([[0, -16], [0.7, -2], [1, 0]]), mid: automation([[0, -10], [0.7, 0], [1, 0]]), high: automation([[0, -4], [0.6, 0], [1, 0]]) },
        };
    }
    if (strategy === 'build-up') {
        return {
            out: { low: automation([[0, 0], [0.5, -8], [1, -16]]), mid: automation([[0, 0], [1, -10]]), high: automation([[0, 0], [0.8, -6], [1, -10]]) },
            in: { low: automation([[0, -20], [0.4, -16], [1, 0]]), mid: automation([[0, -12], [0.6, -4], [1, 0]]), high: automation([[0, -8], [0.6, 0], [1, 0]]) },
        };
    }
    if (strategy === 'breakdown-to-drop') {
        return {
            out: { low: automation([[0, 0], [0.25, -12], [1, -20]]), mid: automation([[0, 0], [1, -10]]), high: automation([[0, 0], [1, -8]]) },
            in: { low: automation([[0, -24], [0.55, -24], [0.65, 0], [1, 0]]), mid: automation([[0, -18], [0.6, 0], [1, 0]]), high: automation([[0, -10], [0.65, 0], [1, 0]]) },
        };
    }
    if (strategy === 'ambient-fade' || strategy === 'atmospheric' || strategy === 'cinematic') {
        return {
            out: { low: automation([[0, 0], [1, strategy === 'atmospheric' ? -6 : -10]]), mid: automation([[0, 0], [1, strategy === 'cinematic' ? -6 : -4]]), high: automation([[0, 0], [1, strategy === 'atmospheric' ? -12 : -3]]) },
            in: { low: automation([[0, -12], [0.7, -4], [1, 0]]), mid: automation([[0, -8], [0.7, 0], [1, 0]]), high: automation([[0, -6], [0.7, 0], [1, 0]]) },
        };
    }
    if (strategy === 'echo-out') {
        return {
            out: { low: automation([[0, 0], [1, -8]]), mid: automation([[0, 0], [0.5, -10], [1, -16]]), high: automation([[0, 0], [0.5, 2], [1, -4]]) },
            in: { low: automation([[0, -18], [0.4, -12], [0.85, 0], [1, 0]]), mid: automation([[0, -8], [0.7, 0], [1, 0]]), high: automation([[0, -4], [0.7, 0], [1, 0]]) },
        };
    }
    if (strategy === 'delay-transition') {
        return {
            out: { low: automation([[0, 0], [1, -6]]), mid: automation([[0, 0], [0.6, -12], [1, -18]]), high: automation([[0, 0], [0.4, 4], [1, -2]]) },
            in: { low: automation([[0, -16], [0.5, -10], [1, 0]]), mid: automation([[0, -10], [0.65, 0], [1, 0]]), high: automation([[0, -6], [0.5, 0], [1, 0]]) },
        };
    }
    if (strategy === 'reverb-transition') {
        return {
            out: { low: automation([[0, 0], [1, -8]]), mid: automation([[0, 0], [1, -6]]), high: automation([[0, 0], [1, -2]]) },
            in: { low: automation([[0, -14], [0.6, -4], [1, 0]]), mid: automation([[0, -8], [0.6, 0], [1, 0]]), high: automation([[0, -4], [0.6, 0], [1, 0]]) },
        };
    }
    if (group === 'cut') {
        return {
            out: { low: automation([[0, 0], [0.49, 0], [0.5, -60], [1, -60]]), mid: automation([[0, 0], [0.5, -60], [1, -60]]), high: automation([[0, 0], [0.5, -60], [1, -60]]) },
            in: { low: automation([[0, -60], [0.5, 0], [1, 0]]), mid: automation([[0, -60], [0.5, 0], [1, 0]]), high: automation([[0, -60], [0.5, 0], [1, 0]]) },
        };
    }
    return {
        out: { low: automation([[0, 0], [1, -4]]), mid: automation([[0, 0], [1, -2]]), high: automation([[0, 0], [1, 0]]) },
        in: { low: automation([[0, -4], [0.6, 0], [1, 0]]), mid: automation([[0, -2], [0.6, 0], [1, 0]]), high: automation([[0, 0], [0.6, 0], [1, 0]]) },
    };
}
function buildFilter(strategy) {
    const group = META[strategy].group;
    if (strategy === 'filter-sweep' || strategy === 'build-up' || strategy === 'breakdown-to-drop') {
        return { out: automation([[0, 0], [0.7, -0.85], [1, -1]]), in: automation([[0, 0.85], [0.65, 0], [1, 0]]) };
    }
    if (group === 'echo')
        return { out: automation([[0, 0], [0.5, -0.4], [1, -0.9]]), in: automation([[0, 0.2], [0.6, 0], [1, 0]]) };
    if (group === 'fade')
        return { out: automation([[0, 0], [1, -0.55]]), in: automation([[0, 0.45], [0.7, 0], [1, 0]]) };
    return { out: automation([[0, 0], [1, 0]]), in: automation([[0, 0], [1, 0]]) };
}
function buildGain(strategy) {
    if (strategy === 'intelligent-hard-cut' || strategy === 'rhythmic-cut') {
        return { out: automation([[0, 1], [0.49, 1], [0.5, 0], [1, 0]]), in: automation([[0, 0], [0.5, 0], [0.51, 1], [1, 1]]) };
    }
    if (strategy === 'bass-swap') {
        return { out: automation([[0, 1], [0.4, 1], [0.55, 0.2], [1, 0]]), in: automation([[0, 0], [0.35, 0], [0.55, 0.7], [1, 1]]) };
    }
    if (strategy === 'frequency-swap') {
        return { out: automation([[0, 1], [0.5, 1], [0.55, 0], [1, 0]]), in: automation([[0, 0], [0.5, 0], [0.55, 1], [1, 1]]) };
    }
    if (strategy === 'vocal-safe') {
        return { out: automation([[0, 1], [0.2, 0.9], [0.7, 0.4], [1, 0]]), in: automation([[0, 0], [0.5, 0], [0.8, 1], [1, 1]]) };
    }
    if (strategy === 'vocal-handoff') {
        return { out: automation([[0, 1], [0.5, 0.8], [1, 0]]), in: automation([[0, 0], [0.5, 0.2], [1, 1]]) };
    }
    if (strategy === 'filter-sweep') {
        return { out: automation([[0, 1], [0.6, 1], [1, 0]]), in: automation([[0, 0], [0.4, 0.2], [1, 1]]) };
    }
    if (strategy === 'build-up') {
        return { out: automation([[0, 1], [0.7, 1], [1, 0]]), in: automation([[0, 0], [0.5, 0.1], [1, 1]]) };
    }
    if (strategy === 'ambient-fade' || strategy === 'atmospheric' || strategy === 'cinematic') {
        return { out: automation([[0, 1], [0.7, 0.8], [1, 0]]), in: automation([[0, 0], [0.3, 0.1], [1, 1]]) };
    }
    if (strategy === 'percussion-blend') {
        return { out: automation([[0, 1], [0.4, 1], [1, 0]]), in: automation([[0, 0], [0.6, 0], [1, 1]]) };
    }
    if (strategy === 'echo-out' || strategy === 'delay-transition') {
        return { out: automation([[0, 1], [0.55, 0.7], [1, 0]]), in: automation([[0, 0], [0.3, 0.2], [0.85, 1], [1, 1]]) };
    }
    if (strategy === 'long-phrase-blend') {
        const points = 24;
        const out = [];
        const inn = [];
        for (let i = 0; i <= points; i += 1) {
            const t = i / points;
            out.push([t, Math.cos((t * Math.PI) / 2)]);
            inn.push([t, Math.sin((t * Math.PI) / 2)]);
        }
        return { out: automation(out), in: automation(inn) };
    }
    return equalPowerGain();
}
function buildEffects(strategy) {
    if (strategy === 'echo-out')
        return { echo: 0.65, reverb: 0 };
    if (strategy === 'delay-transition')
        return { echo: 0.5, reverb: 0 };
    if (strategy === 'vocal-handoff')
        return { echo: 0.35, reverb: 0 };
    if (strategy === 'reverb-transition' || strategy === 'atmospheric')
        return { echo: 0.18, reverb: 0.5 };
    if (strategy === 'cinematic')
        return { echo: 0.12, reverb: 0.62 };
    if (strategy === 'build-up')
        return { echo: 0.08, reverb: 0.24 };
    if (strategy === 'ambient-fade')
        return { echo: 0, reverb: 0.35 };
    return { echo: 0, reverb: 0 };
}
function bpmTarget(a, b, strategy, maxRateDelta) {
    const outBpm = a.bpm || 120;
    const inBpm = b.bpm || 120;
    const ratio = bpmRatio(outBpm, inBpm);
    if (strategy === 'half-time')
        return { target: outBpm / 2, rateOut: 1, rateIn: 1 };
    if (strategy === 'double-time')
        return { target: outBpm * 2, rateOut: 1, rateIn: 1 };
    if (strategy === 'tempo-ramp') {
        const target = (outBpm + inBpm) / 2;
        return { target, rateOut: round(clamp(target / outBpm, 1 - maxRateDelta, 1 + maxRateDelta), 4), rateIn: round(clamp(target / inBpm, 1 - maxRateDelta, 1 + maxRateDelta), 4) };
    }
    if (META[strategy].group === 'cut' || META[strategy].group === 'echo' || META[strategy].group === 'fade' || Math.abs(ratio - 1) > maxRateDelta) {
        return { target: outBpm, rateOut: 1, rateIn: 1 };
    }
    return { target: outBpm, rateOut: 1, rateIn: round(clamp(outBpm / inBpm, 1 - maxRateDelta, 1 + maxRateDelta), 4) };
}
function strategyCandidates(a, b) {
    return STRATEGY_ORDER.map((strategy) => scoreStrategy(strategy, a, b)).sort((x, y) => y.score - x.score || x.strategy.localeCompare(y.strategy));
}
function planTransition(outgoing, incoming, context, options = {}) {
    const weight = clamp(options.advisory?.weight ?? 0.35, 0, 0.45);
    const outBpmForWindow = outgoing.bpm || 120;
    const candidates = strategyCandidates(outgoing, incoming).map((candidate) => {
        const advisory = options.advisory?.strategyScores[candidate.strategy];
        const advisoryScore = advisory == null ? candidate.score : clamp01(candidate.score * (1 - weight) + advisory * weight);
        const duration = durationBeats(candidate.strategy, options.minDurationBeats ?? 4, options.maxDurationBeats ?? 32) * (60 / outBpmForWindow);
        const structural = selectTransitionWindow(outgoing, incoming, context, candidate.strategy, duration).score;
        const usagePenalty = clamp(options.sessionStrategyPenalty?.[candidate.strategy] ?? 0, 0, 0.2);
        return {
            ...candidate,
            score: clamp01(advisoryScore * 0.82 + structural * 0.18 - usagePenalty),
            reasons: [...candidate.reasons, ...(advisory == null ? [] : [`advisory ${advisory.toFixed(2)}`]), `window ${structural.toFixed(2)}`],
        };
    }).sort((left, right) => right.score - left.score || left.strategy.localeCompare(right.strategy));
    const forced = options.forceStrategy ? candidates.find((candidate) => candidate.strategy === options.forceStrategy) : undefined;
    const selected = forced || candidates[0];
    const meta = META[selected.strategy];
    const maxRateDelta = clamp(options.maxRateDelta ?? 0.06, 0.02, 0.12);
    const bpm = bpmTarget(outgoing, incoming, selected.strategy, maxRateDelta);
    let beats = durationBeats(selected.strategy, options.minDurationBeats ?? 4, options.maxDurationBeats ?? 32);
    let durationSec = (60 / Math.max(40, bpm.target)) * beats;
    let startAt = chooseOutStart(outgoing, context, durationSec, selected.strategy);
    startAt = Math.max(startAt, context.position + 0.15);
    startAt = Math.min(startAt, Math.max(context.position, outgoing.duration - 0.35));
    const remaining = outgoing.duration - startAt;
    if (remaining < durationSec + 0.1) {
        const maxSec = Math.max(0.5, remaining - 0.1);
        beats = Math.max(2, Math.floor((maxSec / (60 / Math.max(40, bpm.target))) / 2) * 2);
        durationSec = (60 / Math.max(40, bpm.target)) * beats;
    }
    const inStart = chooseInStart(incoming, selected.strategy);
    if (inStart + durationSec > incoming.duration - 0.2) {
        durationSec = Math.max(0.6, incoming.duration - inStart - 0.2);
        beats = Math.max(1, Math.floor((durationSec / (60 / Math.max(40, bpm.target))) * 2) / 2);
    }
    const window = selectTransitionWindow(outgoing, incoming, context, selected.strategy, durationSec);
    startAt = window.startAt;
    const outEnd = clamp(window.outEnd, startAt + 0.2, outgoing.duration);
    const actualDuration = Math.max(0.6, outEnd - startAt);
    durationSec = actualDuration;
    beats = round(actualDuration / (60 / Math.max(40, bpm.target)), 2);
    const loop = selected.strategy === 'loop-assisted' ? selectLoopWindow(outgoing, startAt, beats >= 8 ? 8 : 4) : null;
    const plan = {
        version: 1,
        id: `${outgoing.id}->${incoming.id}:${Math.round(startAt * 10)}:${selected.strategy}`,
        strategy: selected.strategy,
        startAt: round(startAt, 3),
        outEnd: round(outEnd, 3),
        inStart: round(window.inStart, 3),
        durationSec: round(actualDuration, 3),
        durationBeats: round(beats, 2),
        bpmTarget: round(bpm.target, 2),
        rateOut: bpm.rateOut,
        rateIn: bpm.rateIn,
        crossfadeCurve: meta.group === 'cut' ? 'cut' : 'equal-power',
        bassSwapAt: 0.5,
        effects: buildEffects(selected.strategy),
        eq: buildEq(selected.strategy),
        filter: buildFilter(selected.strategy),
        gain: buildGain(selected.strategy),
        score: selected.score,
        reasons: [...selected.reasons, `Окно ${window.reasons.join(', ')}`, `Длительность ${beats} beats / ${durationSec.toFixed(1)} s`, `rate ${bpm.rateIn.toFixed(3)}`, ...(options.advisory?.note ? [options.advisory.note] : [])],
        warnings: [...selected.warnings, ...outgoing.warnings.slice(0, 1), ...incoming.warnings.slice(0, 1), ...(window.uncertainty === 'high' ? ['Структурное окно неопределённо; используется beatgrid/cue fallback'] : []), ...(selected.strategy === 'loop-assisted' && !loop ? ['Loop недоступен: нет надёжного beatgrid; используется безопасный fallback'] : [])],
        window: { score: window.score, uncertainty: window.uncertainty, evidence: window.evidence, reasons: window.reasons },
        loop: loop ? { start: round(loop.start, 3), end: round(loop.end, 3), lengthBeats: loop.lengthBeats, confidence: loop.confidence } : undefined,
    };
    validatePlan(plan, outgoing, incoming, context);
    return plan;
}
function validatePlan(plan, outgoing, incoming, context) {
    const finite = (value) => Number.isFinite(value);
    if (plan.version !== 1)
        throw new Error('Unsupported transition plan version');
    if (!STRATEGY_ORDER.includes(plan.strategy))
        throw new Error('Unknown transition strategy');
    if (!finite(plan.startAt) || plan.startAt < 0 || plan.startAt >= outgoing.duration)
        throw new Error('Invalid transition start');
    if (!finite(plan.outEnd) || plan.outEnd <= plan.startAt || plan.outEnd > outgoing.duration + 0.01)
        throw new Error('Invalid transition end');
    if (!finite(plan.inStart) || plan.inStart < 0 || plan.inStart >= incoming.duration)
        throw new Error('Invalid incoming cue');
    if (!finite(plan.durationSec) || plan.durationSec <= 0 || plan.durationSec > 180)
        throw new Error('Invalid transition duration');
    if (!finite(plan.rateOut) || plan.rateOut < 0.88 || plan.rateOut > 1.12)
        throw new Error('Outgoing rate outside allowed range');
    if (!finite(plan.rateIn) || plan.rateIn < 0.88 || plan.rateIn > 1.12)
        throw new Error('Incoming rate outside allowed range');
    if (!finite(plan.bpmTarget) || plan.bpmTarget < 30 || plan.bpmTarget > 260)
        throw new Error('Invalid target BPM');
    if (plan.startAt < context.position - 0.05 && context.position > 0)
        throw new Error('Transition start is in the past');
    if (!Number.isFinite(plan.effects.echo) || !Number.isFinite(plan.effects.reverb))
        throw new Error('Non-finite effects');
    const points = [
        ...plan.eq.out.low, ...plan.eq.out.mid, ...plan.eq.out.high,
        ...plan.eq.in.low, ...plan.eq.in.mid, ...plan.eq.in.high,
        ...plan.filter.out, ...plan.filter.in,
        ...plan.gain.out, ...plan.gain.in,
    ];
    for (const point of points) {
        if (!finite(point.at) || !finite(point.value))
            throw new Error('Non-finite automation point');
        if (point.at < 0 || point.at > 1)
            throw new Error('Automation point outside 0..1');
        if (Math.abs(point.value) > 120)
            throw new Error('Automation value out of range');
    }
    if (!plan.reasons.length)
        throw new Error('Plan must explain its decision');
}

/** In-memory musical memory; intentionally not persisted in this phase. */
class MusicalMemory {
    entries = [];
    decisions = [];
    record(entry) {
        this.entries.push({ ...entry, qualityScore: round(clamp01(entry.qualityScore), 3), planScore: round(clamp01(entry.planScore), 3) });
        if (this.entries.length > 200)
            this.entries.shift();
    }
    get all() {
        return this.entries.slice();
    }
    recent(count = 4) {
        return this.entries.slice(-count);
    }
    trackWasPlayed(id, within = 8) {
        return this.entries.slice(-within).some((entry) => entry.incomingId === id || entry.outgoingId === id);
    }
    artistWasPlayed(artist, within = 4) {
        return this.entries.slice(-within).some((entry) => entry.incomingArtist === artist || entry.outgoingArtist === artist);
    }
    recordSessionDecision(entry) {
        this.decisions.push({ ...entry, sequenceIds: [...entry.sequenceIds] });
        if (this.decisions.length > 100)
            this.decisions.shift();
    }
    sessionDecisions(count = 8) {
        return this.decisions.slice(-count).map((entry) => ({ ...entry, sequenceIds: [...entry.sequenceIds] }));
    }
    strategyTechnicalScore(strategy) {
        const entries = this.entries.filter((entry) => entry.strategy === strategy);
        if (!entries.length)
            return null;
        return round(entries.reduce((sum, entry) => sum + entry.qualityScore, 0) / entries.length, 3);
    }
    strategySuccess(strategy) {
        const entries = this.entries.filter((entry) => entry.strategy === strategy);
        if (!entries.length)
            return 0.5;
        return round(entries.filter((entry) => entry.success).length / entries.length, 3);
    }
    summary() {
        const strategyUsage = {};
        const strategySuccess = {};
        for (const entry of this.entries) {
            strategyUsage[entry.strategy] = (strategyUsage[entry.strategy] || 0) + 1;
            if (entry.success)
                strategySuccess[entry.strategy] = (strategySuccess[entry.strategy] || 0) + 1;
        }
        const successes = this.entries.filter((entry) => entry.success).length;
        return {
            count: this.entries.length,
            successRate: this.entries.length ? round(successes / this.entries.length, 3) : 0,
            strategyUsage,
            strategySuccess,
            recentArtists: this.entries.slice(-8).map((entry) => entry.incomingArtist).filter(Boolean),
            recentTracks: this.entries.slice(-8).map((entry) => entry.incomingId),
            averageEnergy: this.entries.length ? round(this.entries.reduce((sum, entry) => sum + entry.energy, 0) / this.entries.length, 3) : 0,
        };
    }
    reset() {
        this.entries = [];
        this.decisions = [];
    }
}

/**
 * Framework-free integration facade over the existing RH-AI-DJ-ENGINE intelligence.
 * It contains no UI and no standalone player; the host owns audio and catalog.
 */
class AutoMixCore {
    sessionId;
    memory;
    session;
    contexts = new Map();
    analyses = new Map();
    selectionMode;
    horizon;
    decisions = 0;
    strategyUsage = {};
    constructor(options = {}) {
        this.sessionId = options.sessionId ?? 'rh-automix';
        this.selectionMode = options.selectionMode ?? 'Adaptive';
        this.horizon = options.horizon ?? 3;
        this.memory = new MusicalMemory();
        this.session = new SessionIntelligence(options.energyMode ?? 'Adaptive');
    }
    initialize() {
        this.contexts.clear();
        this.analyses.clear();
        this.decisions = 0;
        this.strategyUsage = {};
        this.memory.reset();
        this.session.setMode('Adaptive');
    }
    destroy() {
        this.contexts.clear();
        this.analyses.clear();
    }
    setSelectionMode(mode) {
        this.selectionMode = mode;
    }
    setEnergyMode(mode) {
        this.session.setMode(mode);
    }
    /** Registers/reuses a real analysis and builds a Unified Musical Context. */
    analyzeTrack(input) {
        const cached = this.contexts.get(input.id);
        if (cached && this.analyses.has(input.id))
            return cached;
        this.analyses.set(input.id, input.analysis);
        const context = buildUnifiedContext({
            trackId: input.id,
            sessionId: this.sessionId,
            title: input.title,
            artist: input.artist,
            source: input.source ?? 'host analysis',
            algorithmic: input.analysis,
            neural: input.neural ?? null,
            analyzedAt: Date.now(),
        });
        this.contexts.set(input.id, context);
        return context;
    }
    context(trackId) {
        return this.contexts.get(trackId) ?? null;
    }
    analysis(trackId) {
        return this.analyses.get(trackId) ?? null;
    }
    advise(activeId, incomingId) {
        const active = this.contexts.get(activeId);
        const incoming = this.contexts.get(incomingId);
        if (!active || !incoming)
            return null;
        return adviseTransition(active, incoming);
    }
    /** Selects the next track and returns a real executable transition plan. */
    decide(activeId, candidates, history, context, options = {}) {
        const active = this.contexts.get(activeId);
        if (!active)
            throw new Error(`Unknown active track: ${activeId}`);
        const activeAnalysis = this.analyses.get(activeId);
        if (!activeAnalysis)
            throw new Error(`No analysis for active track: ${activeId}`);
        const sessionPlan = this.session.plan(active, candidates, history, this.memory, {
            horizon: this.horizon,
            mode: this.selectionMode,
            targetEnergy: options.targetEnergy,
            excludeIds: options.excludeIds,
        });
        if (!sessionPlan.chosen) {
            return { chosen: null, plan: null, advice: null, session: sessionPlan, direction: sessionPlan.direction, reason: sessionPlan.reason };
        }
        const chosen = sessionPlan.chosen;
        const advice = adviseTransition(active, chosen.context);
        const plan = planTransition(activeAnalysis, chosen.analysis, context, {
            advisory: { strategyScores: advice.strategyScores, weight: 0.35, note: `advisor: ${advice.recommended}` },
        });
        this.decisions += 1;
        this.strategyUsage[plan.strategy] = (this.strategyUsage[plan.strategy] || 0) + 1;
        return { chosen, plan, advice, session: sessionPlan, direction: sessionPlan.direction, reason: `${sessionPlan.reason} · ${plan.strategy}` };
    }
    recordOutcome(input) {
        this.memory.record({
            at: Date.now(),
            outgoingId: input.outgoingId,
            incomingId: input.incomingId,
            outgoingArtist: this.contexts.get(input.outgoingId)?.metadata.artist ?? '',
            incomingArtist: this.contexts.get(input.incomingId)?.metadata.artist ?? '',
            strategy: input.strategy,
            planScore: input.planScore,
            qualityScore: input.qualityScore,
            success: input.success,
            energy: input.energy,
            warnings: [],
            ...(input.technical ?? {}),
            technicalScoreKind: 'technical_only',
        });
    }
    markFailure(id, reason, now = Date.now()) {
        this.session.markFailure(id, reason, now);
    }
    markSuccess(id) {
        this.session.markSuccess(id);
    }
    direction() {
        return this.session.currentDirection();
    }
    diagnostics() {
        return {
            sessionId: this.sessionId,
            tracks: this.contexts.size,
            decisions: this.decisions,
            strategyUsage: { ...this.strategyUsage },
            direction: this.session.currentDirection(),
            memory: this.memory.summary(),
        };
    }
    memorySnapshot() {
        return this.memory.summary();
    }
}
function createAutoMixCore(options = {}) {
    return new AutoMixCore(options);
}

function scheduleParam(param, points, start, duration) {
    if (!points.length)
        return;
    const sorted = [...points].sort((a, b) => a.at - b.at);
    param.cancelScheduledValues(start);
    param.setValueAtTime(sorted[0].value, start + sorted[0].at * duration);
    for (let i = 1; i < sorted.length; i += 1) {
        const point = sorted[i];
        param.linearRampToValueAtTime(point.value, start + point.at * duration);
    }
}
function filterFrequencies(value) {
    const v = clamp(value, -1, 1);
    return {
        lowpass: v < 0 ? 22000 / 10 ** (-v * 2.4) : 22000,
        highpass: v > 0 ? 20 * 10 ** (v * 2.4) : 20,
    };
}
function holdParam(param, at) {
    const withHold = param;
    if (typeof withHold.cancelAndHoldAtTime === 'function') {
        withHold.cancelAndHoldAtTime(at);
        return;
    }
    const value = param.value;
    param.cancelScheduledValues(at);
    param.setValueAtTime(value, at);
}
function scheduleRemaining(param, points, from, now, remaining) {
    holdParam(param, now);
    const future = points.filter((point) => point.at > from + 0.001).sort((a, b) => a.at - b.at);
    for (const point of future) {
        param.linearRampToValueAtTime(point.value, now + Math.max(0.01, (point.at - from) * remaining));
    }
}
class Deck {
    id;
    audio;
    ctx = null;
    source = null;
    trim = null;
    eqLow = null;
    eqMid = null;
    eqHigh = null;
    highpass = null;
    lowpass = null;
    fader = null;
    cross = null;
    echoSend = null;
    echoDelay = null;
    echoFeedback = null;
    echoWet = null;
    reverbSend = null;
    stretch = null;
    buffer = null;
    bufferSource = null;
    bufferInput = null;
    bufferPosition = 0;
    bufferStartedAt = 0;
    bufferRate = 1;
    bufferPlaying = false;
    loopBounds = null;
    constructor(id, audio) {
        this.id = id;
        this.audio = audio;
        this.audio.preload = 'auto';
        this.audio.crossOrigin = 'anonymous';
        this.audio.setAttribute('playsinline', '');
    }
    attach(ctx, master, stretch = null, reverbInput = null) {
        if (this.ctx)
            return;
        this.stretch = stretch;
        this.ctx = ctx;
        try {
            this.source = ctx.createMediaElementSource(this.audio);
        }
        catch {
            this.source = null;
        }
        this.trim = ctx.createGain();
        this.eqLow = ctx.createBiquadFilter();
        this.eqMid = ctx.createBiquadFilter();
        this.eqHigh = ctx.createBiquadFilter();
        this.highpass = ctx.createBiquadFilter();
        this.lowpass = ctx.createBiquadFilter();
        this.fader = ctx.createGain();
        this.cross = ctx.createGain();
        this.echoSend = ctx.createGain();
        this.echoDelay = ctx.createDelay(2);
        this.echoFeedback = ctx.createGain();
        this.echoWet = ctx.createGain();
        this.reverbSend = ctx.createGain();
        this.bufferInput = ctx.createGain();
        this.eqLow.type = 'lowshelf';
        this.eqLow.frequency.value = 180;
        this.eqMid.type = 'peaking';
        this.eqMid.frequency.value = 1100;
        this.eqMid.Q.value = 0.8;
        this.eqHigh.type = 'highshelf';
        this.eqHigh.frequency.value = 6500;
        this.highpass.type = 'highpass';
        this.highpass.frequency.value = 20;
        this.highpass.Q.value = 0.7;
        this.lowpass.type = 'lowpass';
        this.lowpass.frequency.value = 22000;
        this.lowpass.Q.value = 0.7;
        this.trim.gain.value = 1;
        this.fader.gain.value = 0;
        this.cross.gain.value = 0.707;
        this.echoSend.gain.value = 0;
        this.echoFeedback.gain.value = 0.32;
        this.echoWet.gain.value = 0.28;
        this.reverbSend.gain.value = 0;
        this.echoDelay.delayTime.value = 0.25;
        if (this.stretch) {
            this.source?.connect(this.stretch);
            this.bufferInput.connect(this.stretch);
            this.stretch.connect(this.trim);
        }
        else {
            this.source?.connect(this.trim);
            this.bufferInput.connect(this.trim);
        }
        this.trim.connect(this.eqLow);
        this.eqLow.connect(this.eqMid);
        this.eqMid.connect(this.eqHigh);
        this.eqHigh.connect(this.highpass);
        this.highpass.connect(this.lowpass);
        this.lowpass.connect(this.fader);
        this.fader.connect(this.cross);
        this.cross.connect(master);
        this.fader.connect(this.echoSend);
        this.echoSend.connect(this.echoDelay);
        this.echoDelay.connect(this.echoFeedback);
        this.echoFeedback.connect(this.echoDelay);
        this.echoDelay.connect(this.echoWet);
        this.echoWet.connect(master);
        if (reverbInput)
            this.reverbSend.connect(reverbInput);
    }
    get attached() {
        return !!this.ctx;
    }
    get mediaElement() {
        return this.audio;
    }
    get currentTime() {
        if (this.buffer) {
            if (!this.bufferPlaying || !this.ctx)
                return Math.min(this.bufferPosition, this.buffer.duration);
            return Math.min(this.buffer.duration, this.bufferPosition + (this.ctx.currentTime - this.bufferStartedAt) * this.bufferRate);
        }
        return this.audio.currentTime || 0;
    }
    get duration() {
        if (this.buffer)
            return this.buffer.duration;
        return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }
    get paused() {
        if (this.buffer)
            return !this.bufferPlaying;
        return this.audio.paused;
    }
    loadBuffer(buffer) {
        this.cancelAutomation();
        this.stopBuffer();
        this.audio.pause();
        this.buffer = buffer;
        this.bufferPosition = 0;
        this.bufferPlaying = false;
        this.loopBounds = null;
    }
    get usesBuffer() {
        return !!this.buffer;
    }
    async load(url) {
        this.cancelAutomation();
        this.buffer = null;
        this.stopBuffer();
        this.audio.pause();
        this.audio.src = url;
        this.audio.load();
        await new Promise((resolve, reject) => {
            if (this.audio.readyState >= 1) {
                resolve();
                return;
            }
            const timer = setTimeout(() => reject(new Error('metadata timeout')), 12_000);
            const done = () => { clearTimeout(timer); resolve(); };
            this.audio.addEventListener('loadedmetadata', done, { once: true });
            this.audio.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error(this.audio.error ? `media error ${this.audio.error.code}` : 'media error'));
            }, { once: true });
        });
    }
    async play(offset = 0, rate = 1) {
        this.setTempo(rate);
        if (this.buffer) {
            this.startBuffer(offset);
            return;
        }
        if (offset > 0 && Number.isFinite(this.audio.duration)) {
            this.audio.currentTime = Math.min(offset, Math.max(0, this.audio.duration - 0.2));
        }
        await this.audio.play();
    }
    pause() {
        if (this.buffer) {
            this.bufferPosition = this.currentTime;
            this.stopBuffer();
            return;
        }
        this.audio.pause();
    }
    stop() {
        if (this.buffer) {
            this.stopBuffer();
            this.bufferPosition = 0;
            this.fadeTo(0, 0.03);
            return;
        }
        this.audio.pause();
        this.fadeTo(0, 0.03);
    }
    seek(time) {
        if (this.buffer) {
            const wasPlaying = this.bufferPlaying;
            const target = clamp(time, 0, Math.max(0, this.buffer.duration - 0.05));
            this.stopBuffer();
            this.bufferPosition = target;
            if (wasPlaying)
                this.startBuffer(target);
            return;
        }
        if (Number.isFinite(this.audio.duration)) {
            this.audio.currentTime = clamp(time, 0, Math.max(0, this.audio.duration - 0.05));
        }
    }
    setTempo(rate) {
        const value = clamp(rate, 0.88, 1.12);
        this.bufferRate = value;
        if (this.bufferSource && this.ctx) {
            try {
                this.bufferSource.playbackRate.setTargetAtTime(value, this.ctx.currentTime, 0.015);
            }
            catch { /* ignore */ }
        }
        const media = this.audio;
        this.audio.playbackRate = value;
        if (this.stretch && this.ctx) {
            // playbackRate changes tempo; the worklet shifts pitch back by 1/rate.
            media.preservesPitch = false;
            media.webkitPreservesPitch = false;
            const now = this.ctx.currentTime;
            const pitch = this.stretch.parameters.get('pitchRatio');
            const bypass = this.stretch.parameters.get('bypass');
            if (pitch)
                pitch.setTargetAtTime(1 / value, now, 0.015);
            if (bypass)
                bypass.setTargetAtTime(Math.abs(value - 1) < 0.0008 ? 1 : 0, now, 0.015);
        }
        else {
            media.preservesPitch = true;
            media.webkitPreservesPitch = true;
        }
    }
    setRate(rate) {
        this.setTempo(rate);
    }
    get stretchActive() {
        return !!this.stretch;
    }
    setVolumeDb(db) {
        if (!this.trim || !this.ctx)
            return;
        this.trim.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
    }
    fadeTo(value, seconds = 0.04) {
        if (!this.fader || !this.ctx)
            return;
        const now = this.ctx.currentTime;
        this.fader.gain.cancelScheduledValues(now);
        this.fader.gain.setValueAtTime(Math.max(0.0001, this.fader.gain.value), now);
        this.fader.gain.linearRampToValueAtTime(clamp(value, 0, 1.5), now + Math.max(0.005, seconds));
    }
    setCrossfader(position) {
        if (!this.cross || !this.ctx)
            return;
        const gains = equalPower(position);
        const target = this.id === 'A' ? gains.out : gains.in;
        this.cross.gain.setTargetAtTime(target, this.ctx.currentTime, 0.008);
    }
    setEQ(low, mid, high) {
        if (!this.ctx)
            return;
        const now = this.ctx.currentTime;
        for (const [node, value] of [[this.eqLow, low], [this.eqMid, mid], [this.eqHigh, high]]) {
            if (!node)
                continue;
            node.gain.cancelScheduledValues(now);
            node.gain.setTargetAtTime(value, now, 0.015);
        }
    }
    setFilter(value) {
        if (!this.ctx || !this.lowpass || !this.highpass)
            return;
        const frequencies = filterFrequencies(value);
        const now = this.ctx.currentTime;
        this.lowpass.frequency.setTargetAtTime(frequencies.lowpass, now, 0.02);
        this.highpass.frequency.setTargetAtTime(frequencies.highpass, now, 0.02);
    }
    setReverb(amount) {
        if (!this.ctx || !this.reverbSend)
            return;
        this.reverbSend.gain.setTargetAtTime(clamp(amount, 0, 1), this.ctx.currentTime, 0.03);
    }
    setEcho(amount, beatSec = 0.5) {
        if (!this.ctx || !this.echoSend || !this.echoDelay)
            return;
        const now = this.ctx.currentTime;
        this.echoDelay.delayTime.setTargetAtTime(clamp(beatSec, 0.08, 1.5), now, 0.02);
        this.echoSend.gain.setTargetAtTime(clamp(amount, 0, 1), now, 0.02);
    }
    /** Re-schedule only the remaining automation; used by the adaptive controller. */
    rescheduleRemaining(plan, role, progress, scale = 1, adaptation = {}) {
        if (!this.ctx)
            return;
        const now = this.ctx.currentTime;
        const remaining = Math.max(0.05, plan.durationSec * (1 - progress) * scale);
        const isOut = role === 'out';
        if (this.fader)
            scheduleRemaining(this.fader.gain, isOut ? plan.gain.out : plan.gain.in, progress, now, remaining);
        const eq = isOut ? plan.eq.out : plan.eq.in;
        const bias = adaptation.eqBiasDb ?? { low: 0, mid: 0, high: 0 };
        const shifted = (points, offset) => points.map((point) => ({ ...point, value: clamp(point.value + offset, -24, 6) }));
        if (this.eqLow)
            scheduleRemaining(this.eqLow.gain, shifted(eq.low, bias.low), progress, now, remaining);
        if (this.eqMid)
            scheduleRemaining(this.eqMid.gain, shifted(eq.mid, bias.mid), progress, now, remaining);
        if (this.eqHigh)
            scheduleRemaining(this.eqHigh.gain, shifted(eq.high, bias.high), progress, now, remaining);
        const filter = isOut ? plan.filter.out : plan.filter.in;
        const filterBias = adaptation.filterBias ?? 0;
        if (this.lowpass && this.highpass) {
            scheduleRemaining(this.lowpass.frequency, filter.map((point) => ({ at: point.at, value: filterFrequencies(clamp(point.value + filterBias, -1, 1)).lowpass })), progress, now, remaining);
            scheduleRemaining(this.highpass.frequency, filter.map((point) => ({ at: point.at, value: filterFrequencies(clamp(point.value + filterBias, -1, 1)).highpass })), progress, now, remaining);
        }
        if (isOut && this.echoSend && (plan.effects?.echo || 0) > 0) {
            scheduleRemaining(this.echoSend.gain, [
                { at: 0, value: 0 },
                { at: 0.25, value: plan.effects.echo },
                { at: 0.75, value: plan.effects.echo * 0.55 },
                { at: 1, value: 0 },
            ], progress, now, remaining);
        }
        if (isOut && this.reverbSend && (plan.effects?.reverb || 0) > 0) {
            scheduleRemaining(this.reverbSend.gain, [
                { at: 0, value: 0 },
                { at: 0.18, value: plan.effects.reverb },
                { at: 0.72, value: plan.effects.reverb * 0.6 },
                { at: 1, value: 0 },
            ], progress, now, remaining);
        }
    }
    startBuffer(offset) {
        if (!this.ctx || !this.buffer || !this.bufferInput)
            return;
        const target = clamp(offset, 0, Math.max(0, this.buffer.duration - 0.02));
        this.stopBuffer();
        const source = this.ctx.createBufferSource();
        source.buffer = this.buffer;
        source.playbackRate.value = this.bufferRate;
        if (this.loopBounds) {
            source.loop = true;
            source.loopStart = this.loopBounds.start;
            source.loopEnd = this.loopBounds.end;
        }
        source.connect(this.bufferInput);
        source.onended = () => {
            if (this.bufferSource === source) {
                this.bufferSource = null;
                this.bufferPlaying = false;
                this.bufferPosition = this.buffer ? this.buffer.duration : 0;
            }
        };
        try {
            source.start(0, target);
            this.bufferSource = source;
            this.bufferPosition = target;
            this.bufferStartedAt = this.ctx.currentTime;
            this.bufferPlaying = true;
        }
        catch {
            try {
                source.disconnect();
            }
            catch { /* ignore */ }
            this.bufferPlaying = false;
        }
    }
    setLoop(start, end) {
        if (!this.buffer || end <= start)
            return false;
        this.loopBounds = { start, end };
        if (this.bufferSource) {
            this.bufferSource.loop = true;
            this.bufferSource.loopStart = start;
            this.bufferSource.loopEnd = end;
        }
        return true;
    }
    clearLoop() {
        this.loopBounds = null;
        if (this.bufferSource) {
            this.bufferSource.loop = false;
            this.bufferSource.loopStart = 0;
            this.bufferSource.loopEnd = 0;
        }
    }
    stopBuffer() {
        const source = this.bufferSource;
        this.bufferSource = null;
        this.bufferPlaying = false;
        if (!source)
            return;
        source.onended = null;
        try {
            source.stop();
        }
        catch { /* already stopped */ }
        try {
            source.disconnect();
        }
        catch { /* ignore */ }
    }
    /** Cancel stale automation from a previous transition before reusing the deck. */
    cancelAutomation() {
        if (!this.ctx)
            return;
        const now = this.ctx.currentTime;
        const params = [
            this.fader?.gain ?? null,
            this.eqLow?.gain ?? null,
            this.eqMid?.gain ?? null,
            this.eqHigh?.gain ?? null,
            this.lowpass?.frequency ?? null,
            this.highpass?.frequency ?? null,
            this.echoSend?.gain ?? null,
            this.echoDelay?.delayTime ?? null,
            this.reverbSend?.gain ?? null,
        ];
        for (const param of params) {
            if (!param)
                continue;
            try {
                if (typeof param.cancelAndHoldAtTime === 'function')
                    param.cancelAndHoldAtTime(now);
                else {
                    const value = param.value;
                    param.cancelScheduledValues(now);
                    param.setValueAtTime(value, now);
                }
            }
            catch {
                try {
                    param.cancelScheduledValues(now);
                }
                catch { /* ignore */ }
            }
        }
    }
    resetMix() {
        this.cancelAutomation();
        this.setEQ(0, 0, 0);
        this.setFilter(0);
        this.setEcho(0);
        this.setReverb(0);
        this.fadeTo(0, 0.03);
    }
    schedulePlan(plan, start, role) {
        if (!this.ctx)
            return;
        const duration = plan.durationSec;
        const isOut = role === 'out';
        const side = isOut ? plan.gain.out : plan.gain.in;
        if (this.fader)
            scheduleParam(this.fader.gain, side, start, duration);
        const eq = isOut ? plan.eq.out : plan.eq.in;
        if (this.eqLow)
            scheduleParam(this.eqLow.gain, eq.low, start, duration);
        if (this.eqMid)
            scheduleParam(this.eqMid.gain, eq.mid, start, duration);
        if (this.eqHigh)
            scheduleParam(this.eqHigh.gain, eq.high, start, duration);
        const filter = isOut ? plan.filter.out : plan.filter.in;
        if (this.lowpass && this.highpass) {
            const lp = filter.map((point) => ({ at: point.at, value: filterFrequencies(point.value).lowpass }));
            const hp = filter.map((point) => ({ at: point.at, value: filterFrequencies(point.value).highpass }));
            scheduleParam(this.lowpass.frequency, lp, start, duration);
            scheduleParam(this.highpass.frequency, hp, start, duration);
        }
        const echo = plan.effects?.echo || 0;
        if (echo > 0 && isOut && this.echoSend) {
            scheduleParam(this.echoSend.gain, [
                { at: 0, value: 0 },
                { at: 0.25, value: echo },
                { at: 0.75, value: echo * 0.55 },
                { at: 1, value: 0 },
            ], start, duration);
        }
        const reverb = plan.effects?.reverb || 0;
        if (reverb > 0 && isOut && this.reverbSend) {
            scheduleParam(this.reverbSend.gain, [
                { at: 0, value: 0 },
                { at: 0.18, value: reverb },
                { at: 0.72, value: reverb * 0.6 },
                { at: 1, value: 0 },
            ], start, duration);
        }
    }
}

const DEFAULT_REVERB = {
    decaySec: 2.4,
    damping: 0.35,
    roomSize: 0.65,
    preDelaySec: 0.02,
    wet: 0.8,
};
function clampReverb(params) {
    const p = { ...DEFAULT_REVERB, ...params };
    return {
        decaySec: Math.min(6, Math.max(0.25, p.decaySec)),
        damping: Math.min(0.98, Math.max(0, p.damping)),
        roomSize: Math.min(1, Math.max(0.05, p.roomSize)),
        preDelaySec: Math.min(0.15, Math.max(0, p.preDelaySec)),
        wet: Math.min(1, Math.max(0, p.wet)),
    };
}
/**
 * Deterministic synthetic impulse response for a ConvolverNode. It is a real
 * DSP reverberation source; no external impulse or sample data is used.
 */
function generateImpulseData(sampleRate, input = {}) {
    const params = clampReverb(input);
    const length = Math.max(128, Math.floor(sampleRate * params.decaySec));
    const preDelay = Math.floor(sampleRate * params.preDelaySec);
    const left = new Float32Array(length + preDelay);
    const right = new Float32Array(length + preDelay);
    let seed = 0x13579bdf;
    let lpL = 0;
    let lpR = 0;
    const damping = params.damping * 0.92;
    for (let i = 0; i < length; i += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const nL = (seed / 0xffffffff) * 2 - 1;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const nR = (seed / 0xffffffff) * 2 - 1;
        const t = i / length;
        const envelope = Math.pow(1 - t, 2 + params.roomSize * 3);
        lpL = lpL * damping + nL * (1 - damping);
        lpR = lpR * damping + nR * (1 - damping);
        left[preDelay + i] = lpL * envelope;
        right[preDelay + i] = lpR * envelope;
    }
    let norm = 0;
    for (let i = 0; i < left.length; i += 1)
        norm = Math.max(norm, Math.abs(left[i]), Math.abs(right[i]));
    if (norm > 0) {
        const scale = 0.6 / norm;
        for (let i = 0; i < left.length; i += 1) {
            left[i] *= scale;
            right[i] *= scale;
        }
    }
    return { left, right };
}
/** Creates the production reverb graph: send → convolver → wet → master. */
function createReverbGraph(ctx, master, initial = {}) {
    const input = ctx.createGain();
    const convolver = ctx.createConvolver();
    const wet = ctx.createGain();
    let params = clampReverb(initial);
    input.gain.value = 1;
    wet.gain.value = params.wet;
    const apply = (next) => {
        params = clampReverb({ ...params, ...next });
        const data = generateImpulseData(ctx.sampleRate, params);
        const buffer = ctx.createBuffer(2, data.left.length, ctx.sampleRate);
        buffer.getChannelData(0).set(data.left);
        buffer.getChannelData(1).set(data.right);
        convolver.buffer = buffer;
        wet.gain.setTargetAtTime(params.wet, ctx.currentTime, 0.03);
    };
    apply(params);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);
    return {
        input,
        wet,
        convolver,
        setParameters: (next) => apply(next),
        reset: () => {
            // Clear the tail without rebuilding the impulse on the audio thread.
            // setParameters() rebuilds on the next transition that actually uses reverb.
            try {
                convolver.buffer = null;
            }
            catch { /* ignore */ }
        },
        dispose: () => {
            try {
                input.disconnect();
                convolver.disconnect();
                wet.disconnect();
            }
            catch { /* ignore */ }
            convolver.buffer = null;
        },
    };
}

const SILENT_WAV = 'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
class AudioEngine {
    elements;
    ctx = null;
    master = null;
    reverb = null;
    analyser = null;
    monitor = null;
    decks = null;
    masterVolume = 0.9;
    unlocked = false;
    stretchMode = 'native';
    stretchMetrics = { A: null, B: null };
    constructor(elements) {
        this.elements = elements;
    }
    get context() {
        return this.ctx;
    }
    get deckA() {
        if (!this.decks)
            throw new Error('Audio engine is not started');
        return this.decks.A;
    }
    get deckB() {
        if (!this.decks)
            throw new Error('Audio engine is not started');
        return this.decks.B;
    }
    get started() {
        return !!this.ctx && !!this.decks;
    }
    get timeStretchMode() {
        return this.stretchMode;
    }
    get stretchStatus() {
        return this.stretchMetrics;
    }
    /**
     * iOS/Safari requires play() on each media element to happen inside a user
     * gesture. Unlock both elements with a short silent WAV before any async
     * analysis or loading happens.
     */
    async unlock() {
        if (this.unlocked)
            return;
        const elements = [this.elements.A, this.elements.B];
        const attempts = [];
        for (const element of elements) {
            try {
                element.muted = true;
                element.src = SILENT_WAV;
                attempts.push(element.play().then(() => { element.pause(); }).catch(() => undefined));
            }
            catch {
                // Best effort only; the real play() error is surfaced to the UI.
            }
        }
        await Promise.all(attempts);
        for (const element of elements) {
            try {
                element.pause();
                element.muted = false;
                element.removeAttribute('src');
                element.load();
            }
            catch { /* ignore */ }
        }
        this.unlocked = true;
    }
    async start() {
        let unlockPromise = Promise.resolve();
        let resumeError = null;
        let resumePromise = Promise.resolve();
        if (!this.ctx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor)
                throw new Error('Web Audio API is not available');
            const ctx = new Ctor({ latencyHint: 'interactive' });
            unlockPromise = this.unlock();
            resumePromise = ctx.state === 'suspended'
                ? ctx.resume().catch((error) => { resumeError = error instanceof Error ? error : new Error(String(error)); })
                : Promise.resolve();
            const master = ctx.createGain();
            const limiter = ctx.createDynamicsCompressor();
            const analyser = ctx.createAnalyser();
            master.gain.value = this.masterVolume;
            limiter.threshold.value = -1.5;
            limiter.knee.value = 0;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.002;
            limiter.release.value = 0.2;
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.2;
            master.connect(limiter);
            limiter.connect(analyser);
            analyser.connect(ctx.destination);
            this.ctx = ctx;
            this.master = master;
            this.reverb = createReverbGraph(ctx, master);
            this.analyser = analyser;
            this.monitor = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
            this.decks = {
                A: new Deck('A', this.elements.A),
                B: new Deck('B', this.elements.B),
            };
            let stretchA = null;
            let stretchB = null;
            if (ctx.audioWorklet) {
                try {
                    await ctx.audioWorklet.addModule(new URL('time-stretch-worklet.js', document.baseURI).toString());
                    stretchA = new AudioWorkletNode(ctx, 'rh-time-stretch', {
                        numberOfInputs: 1,
                        numberOfOutputs: 1,
                        outputChannelCount: [2],
                        processorOptions: { channels: 2 },
                    });
                    stretchB = new AudioWorkletNode(ctx, 'rh-time-stretch', {
                        numberOfInputs: 1,
                        numberOfOutputs: 1,
                        outputChannelCount: [2],
                        processorOptions: { channels: 2 },
                    });
                    this.stretchMode = 'worklet';
                    stretchA.port.onmessage = (event) => { this.stretchMetrics.A = { ...event.data, at: Date.now() }; };
                    stretchB.port.onmessage = (event) => { this.stretchMetrics.B = { ...event.data, at: Date.now() }; };
                }
                catch {
                    stretchA = null;
                    stretchB = null;
                    this.stretchMode = 'native';
                }
            }
            this.decks.A.attach(ctx, master, stretchA, this.reverb.input);
            this.decks.B.attach(ctx, master, stretchB, this.reverb.input);
            this.decks.A.setCrossfader(0.5);
            this.decks.B.setCrossfader(0.5);
        }
        else if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
            // iOS can report interrupted/suspended even after the first gesture; re-run
            // the media-element unlock in the same user gesture before resuming.
            unlockPromise = this.unlock();
            resumePromise = this.ctx.resume().catch((error) => {
                resumeError = error instanceof Error ? error : new Error(String(error));
            });
        }
        await unlockPromise;
        if (this.ctx.state !== 'running') {
            let timer = 0;
            try {
                await Promise.race([
                    resumePromise,
                    new Promise((_, reject) => {
                        timer = window.setTimeout(() => reject(new Error('AudioContext не запустился: нет доступного аудиоустройства или нет пользовательского жеста.')), 2500);
                    }),
                ]);
            }
            finally {
                window.clearTimeout(timer);
            }
            if (resumeError)
                throw resumeError;
        }
        if (this.ctx.state !== 'running') {
            throw new Error(`AudioContext в состоянии ${this.ctx.state}; нажмите Start ещё раз после взаимодействия со страницей.`);
        }
    }
    async suspend() {
        if (this.ctx && this.ctx.state === 'running')
            await this.ctx.suspend();
    }
    async resume() {
        if (this.ctx && this.ctx.state === 'suspended')
            await this.ctx.resume();
    }
    setMasterVolume(value) {
        this.masterVolume = clamp(value, 0, 1);
        if (this.master && this.ctx)
            this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
    }
    setCrossfader(position) {
        this.decks?.A.setCrossfader(position);
        this.decks?.B.setCrossfader(position);
    }
    getMasterSamples() {
        if (!this.analyser || !this.monitor)
            return new Float32Array(0);
        this.analyser.getFloatTimeDomainData(this.monitor);
        return this.monitor.slice();
    }
    metrics() {
        if (!this.analyser || !this.monitor || !this.ctx) {
            return { peak: 0, rms: 0, clipping: false, contextState: 'suspended' };
        }
        this.analyser.getFloatTimeDomainData(this.monitor);
        let peak = 0;
        let sum = 0;
        for (let i = 0; i < this.monitor.length; i += 1) {
            const v = this.monitor[i];
            peak = Math.max(peak, Math.abs(v));
            sum += v * v;
        }
        return {
            peak,
            rms: Math.sqrt(sum / this.monitor.length),
            clipping: peak >= 0.995,
            contextState: this.ctx.state,
        };
    }
    async beginTransition(plan, outDeck, inDeck) {
        if (!this.ctx)
            throw new Error('Audio engine is not started');
        await this.start();
        if (!this.ctx)
            throw new Error('Audio engine is not started');
        // Cancel any stale automation before touching transition-owned params.
        outDeck.cancelAutomation();
        inDeck.cancelAutomation();
        outDeck.setRate(plan.rateOut);
        inDeck.setRate(plan.rateIn);
        outDeck.setEQ(0, 0, 0);
        outDeck.setFilter(0);
        outDeck.setEcho(0);
        outDeck.setReverb(0);
        outDeck.fadeTo(1, 0.001);
        inDeck.setEQ(-24, -8, -4);
        inDeck.setFilter(0);
        inDeck.setEcho(0);
        inDeck.setReverb(0);
        inDeck.fadeTo(0, 0.001);
        await inDeck.play(plan.inStart, plan.rateIn);
        if (inDeck.paused)
            throw new Error('Incoming deck did not start playback');
        // Anchor automation only after the incoming element is actually playing;
        // otherwise play() latency can put the whole schedule in the past.
        const startAt = this.ctx.currentTime + 0.08;
        inDeck.schedulePlan(plan, startAt, 'in');
        outDeck.schedulePlan(plan, startAt, 'out');
        return startAt;
    }
    completeTransition(outDeck, inDeck) {
        outDeck.stop();
        outDeck.resetMix();
        inDeck.setEQ(0, 0, 0);
        inDeck.setFilter(0);
        inDeck.setEcho(0);
        inDeck.setReverb(0);
        this.reverb?.reset();
        inDeck.fadeTo(1, 0.08);
        inDeck.setRate(1);
    }
    panic() {
        this.decks?.A.stop();
        this.decks?.B.stop();
        this.decks?.A.setEcho(0);
        this.decks?.B.setEcho(0);
    }
    setReverbParameters(params) {
        this.reverb?.setParameters(params);
    }
    async close() {
        this.panic();
        this.reverb?.dispose();
        this.reverb = null;
        if (this.ctx)
            await this.ctx.close();
        this.ctx = null;
        this.decks = null;
    }
}

export { AudioEngine, AutoMixCore, Deck, LoopExecutor, MusicalMemory, SessionIntelligence, adviseTransition, analyzeAudioBuffer, createAutoMixCore, createReverbGraph, generateImpulseData, planTransition, strategyCandidates, trackEnergy };
//# sourceMappingURL=automix-engine.js.map
