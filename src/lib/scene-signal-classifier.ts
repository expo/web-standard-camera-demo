export const SCENE_SIGNAL_LABELS = [
  { color: '#94a3b8', name: 'Lens covered' },
  { color: '#a78bfa', name: 'Indoor scene' },
  { color: '#34d399', name: 'Outdoor scene' },
  { color: '#38bdf8', name: 'Window / mixed' },
  { color: '#60a5fa', name: 'Low light' },
  { color: '#facc15', name: 'Bright scene' },
  { color: '#fb923c', name: 'Warm scene' },
  { color: '#22d3ee', name: 'Cool scene' },
  { color: '#f8fafc', name: 'Detailed scene' },
  { color: '#c084fc', name: 'Flat color' },
] as const;

export const SCENE_SIGNAL_SCORE_FLOATS = 25;

interface SceneSignalFeatureVector {
  brightness: number;
  contrast: number;
  edge: number;
  saturation: number;
  sky: number;
  structure: number;
  vegetation: number;
}

export interface SceneSignalPrediction {
  confidence: number;
  features: SceneSignalFeatureVector;
  labelIndex: number;
  scores: number[];
  signals: {
    environment: SceneSignal;
    palette: SceneSignal;
    texture: SceneSignal;
  };
}

export interface SceneSignal {
  confidence: number;
  label: string;
}

const LABEL_COUNT = SCENE_SIGNAL_LABELS.length;
const FEATURE_INDEX = {
  brightness: 10,
  contrast: 11,
  edge: 12,
  saturation: 13,
  colorBias: 14,
  indoor: 15,
  outdoor: 16,
  mixed: 17,
  sky: 18,
  vegetation: 19,
  structure: 20,
  texture: 24,
} as const;

export function makeSceneSignalPrediction(values: Float32Array): SceneSignalPrediction {
  const scores = Array.from(values.slice(0, LABEL_COUNT), finite01);
  const covered = scores[0] ?? 0;
  const indoor = finite01(values[FEATURE_INDEX.indoor]);
  const outdoor = finite01(values[FEATURE_INDEX.outdoor]);
  const mixed = finite01(values[FEATURE_INDEX.mixed]);
  const brightness = finite01(values[FEATURE_INDEX.brightness]);
  const contrast = finite01(values[FEATURE_INDEX.contrast]);
  const edge = finite01(values[FEATURE_INDEX.edge]);
  const saturation = finite01(values[FEATURE_INDEX.saturation]);
  const colorBias = finiteSigned(values[FEATURE_INDEX.colorBias]);
  const sky = finite01(values[FEATURE_INDEX.sky]);
  const vegetation = finite01(values[FEATURE_INDEX.vegetation]);
  const structure = finite01(values[FEATURE_INDEX.structure]);
  const texture = finite01(values[FEATURE_INDEX.texture]);
  const labelIndex = selectPrimaryLabel(scores, { covered, indoor, mixed, outdoor });

  return {
    confidence: scores[labelIndex] ?? 0,
    features: { brightness, contrast, edge, saturation, sky, structure, vegetation },
    labelIndex,
    scores,
    signals: {
      environment: makeEnvironmentSignal({ covered, indoor, mixed, outdoor }),
      palette: makePaletteSignal(colorBias, saturation),
      texture: makeTextureSignal(texture, structure),
    },
  };
}

function selectPrimaryLabel(
  scores: readonly number[],
  environment: { covered: number; indoor: number; mixed: number; outdoor: number }
): number {
  if (environment.covered > 0.72) return 0;

  const environmentScores = [
    { index: 1, score: environment.indoor },
    { index: 2, score: environment.outdoor },
    { index: 3, score: environment.mixed },
  ].sort((a, b) => b.score - a.score);
  const bestEnvironment = environmentScores[0];
  const secondEnvironment = environmentScores[1]?.score ?? 0;
  if (bestEnvironment && bestEnvironment.score >= 0.52 && bestEnvironment.score - secondEnvironment >= 0.04) {
    return bestEnvironment.index;
  }

  let labelIndex = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if ((scores[i] ?? 0) > (scores[labelIndex] ?? 0)) labelIndex = i;
  }
  return labelIndex;
}

function finite01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function makeEnvironmentSignal({
  covered,
  indoor,
  mixed,
  outdoor,
}: {
  covered: number;
  indoor: number;
  mixed: number;
  outdoor: number;
}): SceneSignal {
  if (covered > 0.72) return { confidence: covered, label: 'blocked' };
  if (mixed >= 0.50 && mixed >= Math.max(indoor, outdoor) - 0.06) {
    return { confidence: mixed, label: 'window / mixed' };
  }

  const top = Math.max(indoor, outdoor);
  const second = Math.min(indoor, outdoor);
  if (top < 0.34 || top - second < 0.08) {
    return { confidence: Math.max(top, mixed), label: 'uncertain' };
  }

  return {
    confidence: Math.min(0.96, top * 0.74 + (top - second) * 0.42),
    label: indoor > outdoor ? 'indoor' : 'outdoor',
  };
}

function makePaletteSignal(colorBias: number, saturation: number): SceneSignal {
  const strength = Math.min(1, Math.abs(colorBias) * 4 + saturation * 0.8);
  if (colorBias > 0.08) return { confidence: Math.max(0.36, strength), label: 'warm' };
  if (colorBias < -0.08) return { confidence: Math.max(0.36, strength), label: 'cool' };
  return { confidence: Math.max(0.35, 1 - Math.abs(colorBias) * 6), label: 'neutral' };
}

function makeTextureSignal(texture: number, structure: number): SceneSignal {
  if (structure >= 0.58) return { confidence: structure, label: 'structured' };
  if (texture >= 0.62) return { confidence: texture, label: 'high detail' };
  if (texture >= 0.34) return { confidence: Math.min(0.78, texture + 0.18), label: 'some detail' };
  return { confidence: Math.min(0.9, 1 - texture), label: 'flat' };
}
