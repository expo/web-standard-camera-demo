import { expect, test } from 'bun:test';

import {
  isComplete,
  isValidMetric,
  metricSetValidationError,
  missingMetrics,
  recordMetricLine,
  validateRequiredMetricSet,
  type SeenMetrics,
} from './validate-panorama-ios';

test('panorama validator accepts a consistent capture/render/export telemetry set', () => {
  const seen = completeMetricSet();

  expect(isComplete(seen)).toBe(true);
  expect(missingMetrics(seen)).toEqual([]);
  expect(metricSetValidationError(seen)).toBeNull();
  expect(() => validateRequiredMetricSet(seen)).not.toThrow();
});

test('panorama validator rejects mismatched exported model metrics', () => {
  const seen = completeMetricSet({
    PANORAMIC_EXPORT_METRICS: { surfelCount: 41 },
  });

  expect(metricSetValidationError(seen)).toContain('Capture/export telemetry mismatch');
  expect(() => validateRequiredMetricSet(seen)).toThrow('Capture/export telemetry mismatch');
});

test('panorama validator requires Files-visible PLY export metadata', () => {
  expect(isValidMetric('PANORAMIC_EXPORT_METRICS', {
    bytes: 1024,
    filename: 'scene.ply',
    filesVisiblePath: 'standard-camera-app/scene.ply',
    keyframes: 3,
    surfelCount: 42,
    uri: 'file:///Documents/scene.ply',
  })).toBe(true);
  expect(isValidMetric('PANORAMIC_EXPORT_METRICS', {
    bytes: 1024,
    filename: 'scene.ply',
    filesVisiblePath: 'wrong/scene.ply',
    keyframes: 3,
    surfelCount: 42,
    uri: 'file:///Documents/scene.ply',
  })).toBe(false);
});

test('panorama validator records only valid required metrics from log lines', () => {
  const seen: SeenMetrics = {};

  recordMetricLine('noise PANORAMIC_CAPTURE_METRICS {"keyframes":3,"surfelCount":42,"rawSampleCount":100,"cameraColorPercent":85,"boundsMeters":[1,2,0.2]}', seen);
  recordMetricLine('noise PANORAMIC_EXPORT_METRICS {"keyframes":3,"surfelCount":42,"bytes":1024,"filename":"scene.ply","filesVisiblePath":"wrong/scene.ply","uri":"file:///Documents/scene.ply"}', seen);

  expect(seen.PANORAMIC_CAPTURE_METRICS?.surfelCount).toBe(42);
  expect(seen.PANORAMIC_EXPORT_METRICS).toBeUndefined();
});

function completeMetricSet(
  overrides: Partial<Record<keyof SeenMetrics, Record<string, unknown>>> = {}
): SeenMetrics {
  const base = {
    PANORAMIC_KEYFRAME_PROFILE: {
      appendMs: 12,
      cameraColorPercent: 80,
      keyframes: 3,
      retainedSamples: 100,
      surfelCount: 34,
    },
    PANORAMIC_CAPTURE_METRICS: {
      boundsMeters: [1.1, 0.8, 0.3],
      buildMs: 25,
      cameraColorPercent: 80,
      colorSource: 'camera',
      fusionPercent: 42,
      keyframes: 3,
      normalPercent: 65,
      rawSampleCount: 100,
      surfelCount: 42,
      voxelSizeMeters: 0.045,
    },
    PANORAMIC_RENDER_METRICS: {
      buildMs: 25,
      cameraColorPercent: 80,
      canvasHeight: 1280,
      canvasWidth: 960,
      keyframes: 3,
      modelRevision: 4,
      normalPercent: 65,
      presentationFormat: 'bgra8unorm',
      rawSampleCount: 100,
      surfelCount: 42,
      viewMode: 'Color',
    },
    PANORAMIC_EXPORT_METRICS: {
      bytes: 4096,
      filename: 'scene.ply',
      filesVisiblePath: 'standard-camera-app/scene.ply',
      keyframes: 3,
      surfelCount: 42,
      uri: 'file:///Documents/scene.ply',
    },
  } satisfies SeenMetrics;
  return Object.fromEntries(
    Object.entries(base).map(([name, metric]) => [
      name,
      { ...metric, ...(overrides[name as keyof SeenMetrics] ?? {}) },
    ])
  ) as SeenMetrics;
}
