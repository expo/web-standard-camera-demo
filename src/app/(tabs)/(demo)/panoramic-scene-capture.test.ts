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

test('panorama route keeps capture, render, and Files export telemetry wired', () => {
  expectContainsInOrder(routeSource, [
    'async function captureModel()',
    'cancelXRLoop()',
    "setStatus('building-model')",
    'const nextModel = buildPreviewModel()',
    'publishModel(nextModel, { recenter: true })',
    'logCaptureMetrics(nextModel)',
    "setSaveInfo('ready to save .ply')",
    "setStatus('captured')",
    'await stopActiveSession()',
  ]);

  expectContainsInOrder(routeSource, [
    'didDrawCapturedModel =',
    "statusRef.current === 'captured'",
    'logRenderMetrics(',
  ]);

  expectContainsInOrder(routeSource, [
    'async function saveModel()',
    "const capturedModel = status === 'captured' ? modelRef.current : null",
    'new File(Paths.document, filename)',
    'serializeModelAsPly(capturedModel)',
    'file.create({ overwrite: true })',
    'file.write(ply)',
    'const savedSize = file.exists ? file.size : 0',
    "throw new Error('PLY export was not written to Files.')",
    'logExportMetrics(capturedModel, file.uri, filename, savedSize)',
  ]);
});

function expectContainsInOrder(source: string, snippets: string[]): void {
  let offset = 0;
  for (const snippet of snippets) {
    const foundAt = source.indexOf(snippet, offset);
    expect(foundAt, `Expected to find ${snippet}`).toBeGreaterThanOrEqual(offset);
    offset = foundAt + snippet.length;
  }
}
