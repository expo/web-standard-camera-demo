import { describe, expect, test } from 'bun:test';

import {
  detectTfjsCameraFrame,
  makeObjectSceneSummary,
  type ObjectDetectionBox,
} from './tfjs-object-detector';

describe('makeObjectSceneSummary', () => {
  test('maps desk objects into a workspace summary', () => {
    const detections: ObjectDetectionBox[] = [
      { bbox: [10, 12, 140, 90], className: 'keyboard', score: 0.72 },
      { bbox: [160, 20, 100, 90], className: 'laptop', score: 0.61 },
    ];

    const summary = makeObjectSceneSummary(detections);

    expect(summary.label).toBe('Workspace / study');
    expect(summary.reason).toBe('keyboard');
    expect(summary.confidence).toBe(1);
  });

  test('maps vehicles into a street summary', () => {
    const summary = makeObjectSceneSummary([
      { bbox: [0, 0, 200, 120], className: 'car', score: 0.64 },
      { bbox: [30, 10, 40, 90], className: 'traffic light', score: 0.42 },
    ]);

    expect(summary.label).toBe('Street / transport');
  });

  test('falls back when no detection matches a summary group', () => {
    const summary = makeObjectSceneSummary([
      { bbox: [0, 0, 80, 80], className: 'umbrella', score: 0.58 },
    ]);

    expect(summary.label).toBe('Object-first scene');
    expect(summary.reason).toBe('umbrella');
    expect(summary.confidence).toBe(0.58);
  });
});

describe('detectTfjsCameraFrame', () => {
  test('aborts before loading TensorFlow when the signal is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await detectTfjsCameraFrame(
        { _data: new Uint8Array(4), height: 1, width: 1 },
        { signal: controller.signal }
      );
      throw new Error('Expected detectTfjsCameraFrame to abort');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AbortError');
    }
  });
});
