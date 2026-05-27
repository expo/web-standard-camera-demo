import { readFileSync } from 'node:fs';
import { test, expect } from 'bun:test';

const cameraContextSource = readFileSync(
  new URL('../contexts/CameraContext.tsx', import.meta.url),
  'utf8'
);
const homeSource = readFileSync(new URL('../app/(tabs)/(camera)/index.tsx', import.meta.url), 'utf8');
const cubeSource = readFileSync(new URL('../app/(tabs)/(demo)/cube.tsx', import.meta.url), 'utf8');
const shaderLensSource = readFileSync(new URL('../app/(tabs)/(demo)/shader-lens.tsx', import.meta.url), 'utf8');
const neuralLensSource = readFileSync(new URL('../app/(tabs)/(demo)/neural-lens.tsx', import.meta.url), 'utf8');

test('native camera context coalesces duplicate default auto-starts', () => {
  expect(cameraContextSource).toContain('const startInFlightRef = React.useRef(false)');
  expect(cameraContextSource).toContain('startInFlightRef.current = false;');
  expect(cameraContextSource).toContain('if (startInFlightRef.current && next == null && !streamRef.current)');
  expect(cameraContextSource).toContain("console.log(`CAMERA_CTX start skipped in-flight");
  expect(cameraContextSource).toContain('startInFlightRef.current = true;');
  expect(cameraContextSource).toContain('if (requestId === startRequestRef.current)');
});

test('standard camera auto-start is scoped to focused camera-consuming routes', () => {
  expect(cameraContextSource).not.toContain('auto-start firing');
  expect(cameraContextSource).not.toContain('Linking.getInitialURL');
  for (const source of [homeSource, cubeSource, shaderLensSource, neuralLensSource]) {
    expect(source).toContain("import { useFocusEffect } from 'expo-router'");
    expect(source).toContain('useFocusEffect(');
    expect(source).toContain('if (userStopped || externalLocked) return undefined');
    expect(source).toContain('void start()');
  }
});
