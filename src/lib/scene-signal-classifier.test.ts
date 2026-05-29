import { expect, test } from 'bun:test';

import { makeSceneSignalPrediction, SCENE_SIGNAL_SCORE_FLOATS } from './scene-signal-classifier';

test('scene signal prediction promotes confident outdoor evidence to the primary scene label', () => {
  const values = makeScores({
    outdoor: 0.78,
    sky: 0.72,
    vegetation: 0.38,
    structure: 0.18,
  });

  const prediction = makeSceneSignalPrediction(values);

  expect(prediction.signals.environment.label).toBe('outdoor');
  expect(prediction.labelIndex).toBe(2);
  expect(prediction.features.sky).toBeCloseTo(0.72, 6);
});

test('scene signal prediction promotes confident indoor evidence to the primary scene label', () => {
  const values = makeScores({
    indoor: 0.74,
    sky: 0.06,
    structure: 0.66,
    vegetation: 0.03,
  });

  const prediction = makeSceneSignalPrediction(values);

  expect(prediction.signals.environment.label).toBe('indoor');
  expect(prediction.labelIndex).toBe(1);
  expect(prediction.signals.texture.label).toBe('structured');
});

test('scene signal prediction keeps window scenes distinct from simple indoor or outdoor labels', () => {
  const values = makeScores({
    indoor: 0.54,
    mixed: 0.62,
    outdoor: 0.58,
    sky: 0.48,
    structure: 0.64,
  });

  const prediction = makeSceneSignalPrediction(values);

  expect(prediction.signals.environment.label).toBe('window / mixed');
  expect(prediction.labelIndex).toBe(3);
});

test('scene signal prediction treats a covered lens as the top state before scene labels', () => {
  const values = makeScores({
    covered: 0.86,
    indoor: 0.78,
    outdoor: 0.74,
  });

  const prediction = makeSceneSignalPrediction(values);

  expect(prediction.signals.environment.label).toBe('blocked');
  expect(prediction.labelIndex).toBe(0);
});

test('scene signal prediction clamps non-finite shader values', () => {
  const values = makeScores({
    brightness: Number.NaN,
    indoor: Number.POSITIVE_INFINITY,
    outdoor: Number.NEGATIVE_INFINITY,
    sky: Number.NaN,
  });

  const prediction = makeSceneSignalPrediction(values);

  expect(prediction.features.brightness).toBe(0);
  expect(prediction.features.sky).toBe(0);
  expect(prediction.scores[1]).toBe(0);
  expect(prediction.scores[2]).toBe(0);
});

function makeScores(overrides: Partial<Record<ScoreName, number>>): Float32Array {
  const values = new Float32Array(SCENE_SIGNAL_SCORE_FLOATS);
  values[10] = 0.48;
  values[11] = 0.16;
  values[12] = 0.12;
  values[13] = 0.18;
  values[24] = 0.42;

  for (const [key, value] of Object.entries(overrides) as [ScoreName, number][]) {
    values[SCORE_INDEX[key]] = value;
    const duplicateFeatureIndex = DUPLICATE_FEATURE_INDEX[key];
    if (duplicateFeatureIndex !== undefined) values[duplicateFeatureIndex] = value;
  }
  return values;
}

type ScoreName = keyof typeof SCORE_INDEX;

const SCORE_INDEX = {
  brightness: 10,
  contrast: 11,
  covered: 0,
  indoor: 1,
  mixed: 3,
  outdoor: 2,
  sky: 18,
  structure: 20,
  vegetation: 19,
} as const;

const DUPLICATE_FEATURE_INDEX: Partial<Record<ScoreName, number>> = {
  indoor: 15,
  mixed: 17,
  outdoor: 16,
} as const;
