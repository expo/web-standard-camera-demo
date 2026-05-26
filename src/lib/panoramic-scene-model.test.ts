import { expect, test } from 'bun:test';

import {
  appendDepthSurfels,
  buildModel,
  formatFilesLocation,
  invertMatrix4,
  sampleCameraColor,
  serializeModelAsPly,
  SURFEL_STRIDE_FLOATS,
  transformPoint,
  unprojectViewSample,
  type PanoramicCameraImage,
  type PanoramicDepthInformation,
} from './panoramic-scene-model';

const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

test('unprojectViewSample treats depth as camera-plane meters', () => {
  const point = unprojectViewSample(IDENTITY_4X4, 0.5, 0.5, 2);

  expect(point[0]).toBeCloseTo(0, 6);
  expect(point[1]).toBeCloseTo(0, 6);
  expect(point[2]).toBeCloseTo(-2, 6);
});

test('transformPoint applies column-major camera-to-world translation', () => {
  const translated = new Float32Array(IDENTITY_4X4);
  translated[12] = 1;
  translated[13] = 2;
  translated[14] = 3;

  expect(transformPoint(translated, [0.25, 0.5, -2])).toEqual([1.25, 2.5, 1]);
});

test('sampleCameraColor reads BGRA camera bytes without channel-swizzling the full frame', () => {
  const camera = makeCameraImage(new Uint8Array([
    10, 20, 30, 255,
    40, 50, 60, 255,
    70, 80, 90, 255,
    100, 110, 120, 255,
  ]), 'bgra8unorm', 2, 2);

  const color = sampleCameraColor(camera, new Uint8Array(camera.data), IDENTITY_4X4, 1, 1);

  expect(color).not.toBeNull();
  expect(color?.[0]).toBeCloseTo(120 / 255, 6);
  expect(color?.[1]).toBeCloseTo(110 / 255, 6);
  expect(color?.[2]).toBeCloseTo(100 / 255, 6);
});

test('buildModel fuses same-voxel surfels and prefers camera colors over fallback colors', () => {
  const points = [
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.01, y: 0.01, z: -1.01, r: 0, g: 0, b: 1, weight: 1 }),
    ...surfelSample({ x: 0.2, y: 0, z: -1, r: 0, g: 1, b: 0, weight: -1 }),
  ];

  const model = buildModel(points, 2);

  expect(model).not.toBeNull();
  expect(model?.rawSampleCount).toBe(3);
  expect(model?.surfelCount).toBe(2);
  expect(model?.cameraColoredSurfels).toBe(1);
  expect(model?.colorSource).toBe('mixed');
  expect(model?.surfels[4]).toBeCloseTo(0.5, 6);
  expect(model?.surfels[5]).toBeCloseTo(0, 6);
  expect(model?.surfels[6]).toBeCloseTo(0.5, 6);
});

test('appendDepthSurfels converts WebXR-shaped RGB-D frame data into camera-colored samples', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const points: number[] = [];

  const added = appendDepthSurfels(depth, camera, IDENTITY_4X4, IDENTITY_4X4, points, 0);

  expect(added.surfelCount).toBeGreaterThan(0);
  expect(added.cameraColoredSurfels).toBe(added.surfelCount);
  expect(points.length).toBe(added.surfelCount * SURFEL_STRIDE_FLOATS);
  expect(points[4]).toBeCloseTo(1, 6);
  expect(points[5]).toBeCloseTo(128 / 255, 6);
  expect(points[6]).toBeCloseTo(0, 6);
});

test('serializeModelAsPly emits vertex colors and normals for Files export', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
  ], 1);

  expect(model).not.toBeNull();
  const ply = serializeModelAsPly(model!);

  expect(ply).toContain('format ascii 1.0\n');
  expect(ply).toContain('element vertex 1\n');
  expect(ply).toContain('property float nx\n');
  expect(ply).toContain('property uchar red\n');
  expect(ply).toContain('0.00000 0.00000 -1.00000 0.00000 1.00000 0.00000 255 128 0\n');
  expect(ply.endsWith('\n')).toBe(true);
});

test('formatFilesLocation reports the app Documents path shown to the user', () => {
  expect(formatFilesLocation('scan.ply', 1536)).toBe('Files: standard-camera-app/scan.ply (1.5 KB)');
});

test('invertMatrix4 round-trips a simple transform', () => {
  const matrix = new Float32Array(IDENTITY_4X4);
  matrix[12] = 3;
  matrix[13] = -2;
  matrix[14] = 1;
  const inverse = invertMatrix4(matrix);

  expect(inverse).not.toBeNull();
  expect(transformPoint(inverse!, transformPoint(matrix, [0.5, 0.25, -2]))).toEqual([0.5, 0.25, -2]);
});

function makeDepthInformation(values: Float32Array): PanoramicDepthInformation {
  return {
    data: exactArrayBuffer(values),
    height: 1,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: 1,
  };
}

function makeCameraImage(
  bytes: Uint8Array,
  format: PanoramicCameraImage['format'],
  width: number,
  height: number
): PanoramicCameraImage {
  return {
    data: exactArrayBuffer(bytes),
    format,
    height,
    normCameraImageFromNormView: { matrix: IDENTITY_4X4 },
    width,
  };
}

function exactArrayBuffer(view: Uint8Array | Float32Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function surfelSample({
  b,
  g,
  r,
  weight,
  x,
  y,
  z,
}: {
  b: number;
  g: number;
  r: number;
  weight: number;
  x: number;
  y: number;
  z: number;
}): number[] {
  return [
    x,
    y,
    z,
    1,
    r,
    g,
    b,
    weight,
    0,
    1,
    0,
    1,
  ];
}
