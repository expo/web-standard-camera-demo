import { expect, test } from 'bun:test';

import {
  WebXRDepthInformation,
  WebXRViewerPose,
  WebXRView,
  type WebXRFrame,
} from './WebXRDepthProfile';

const PROJECTION = [
  2, 0, 0, 0,
  0, 3, 0, 0,
  0, 0, -1, -1,
  0, 0, -0.2, 0,
];

const VIEW_TRANSFORM = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  1.5, -0.25, 0.75, 1,
];

const DEPTH_TRANSFORM = [
  0.8, 0, 0, 0,
  0, 0.9, 0, 0,
  0, 0, 1, 0,
  0.1, 0.05, 0, 1,
];

test('XRDepthInformation exposes WebXR view geometry without ARKit intrinsics extensions', () => {
  const frame = {
    nativeFrame: {
      height: 192,
      normDepthBufferFromNormView: DEPTH_TRANSFORM,
      projectionMatrix: PROJECTION,
      viewTransform: VIEW_TRANSFORM,
      width: 256,
    },
  } as unknown as WebXRFrame;

  const view = new WebXRView(frame);
  const pose = new WebXRViewerPose([view]);
  const depth = new WebXRDepthInformation(frame);

  expect(depth.width).toBe(256);
  expect(depth.height).toBe(192);
  expect(pose.views).toHaveLength(1);
  expect(pose.views[0]).toBe(view);
  expectMatrixClose(pose.transform.matrix, VIEW_TRANSFORM);
  expectMatrixClose(depth.projectionMatrix, PROJECTION);
  expectMatrixClose(depth.transform.matrix, VIEW_TRANSFORM);
  expectMatrixClose(depth.normDepthBufferFromNormView.matrix, DEPTH_TRANSFORM);
  expectMatrixClose(view.projectionMatrix, depth.projectionMatrix);
  expectMatrixClose(view.transform.matrix, depth.transform.matrix);
  expect('cameraIntrinsics' in depth).toBe(false);
  expect('cameraIntrinsicsImageResolution' in depth).toBe(false);
  expect('cameraIntrinsicsReference' in depth).toBe(false);
});

function expectMatrixClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] ?? 0, 6);
  }
}
