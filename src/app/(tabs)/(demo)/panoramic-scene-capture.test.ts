import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('./panoramic-scene-capture.tsx', import.meta.url), 'utf8');

test('panorama route keeps AR access behind the WebXR-shaped API', () => {
  expect(routeSource).toContain("xr.requestSession('immersive-ar'");
  expect(routeSource).toContain("requiredFeatures: ['depth-sensing', 'camera-access']");
  expect(routeSource).toContain('frame.getDepthInformation(view)');
  expect(routeSource).toContain('new WebXRCPUCameraBinding(nextSession)');
  expect(routeSource).toContain('cameraBinding.getCameraImage(xrCamera)');

  for (const forbidden of [
    'ARKit',
    'ARSession',
    'LiDARDepthSource',
    'NativeStandardCamera',
    'getLatestWebXRLiDARDepthFrame',
    'getWebXRLiDARDepthFramePayload',
    'startLiDARDepth',
  ]) {
    expect(routeSource).not.toContain(forbidden);
  }
});
