import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, type CanvasRef } from 'react-native-wgpu';

import { useTheme } from '@/hooks/use-theme';

// WebGPU smoke test on react-native-wgpu under SDK 56 / RN 0.85 / Hermes V1 /
// New Arch. Draws a single magenta triangle through navigator.gpu, a WGSL
// shader, and the React Native Canvas surface. If a triangle appears, the
// entire WebGPU pipeline (adapter, device, shader compile, render pipeline,
// command encoder, queue submit, surface present) is alive.

const SHADER = /* wgsl */ `
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(
    vec2f( 0.0,  0.6),
    vec2f(-0.6, -0.5),
    vec2f( 0.6, -0.5),
  );
  return vec4f(positions[idx], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.95, 0.25, 0.55, 1.0);
}
`;

export default function WebGPUSpikeScreen(): React.JSX.Element {
  const theme = useTheme();
  const ref = React.useRef<CanvasRef>(null);
  const [status, setStatus] = React.useState('initializing');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const draw = async (): Promise<void> => {
      try {
        if (!navigator.gpu) {
          throw new Error('navigator.gpu is undefined');
        }
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          throw new Error('requestAdapter returned null');
        }
        const device = await adapter.requestDevice();
        if (cancelled) return;
        const context = ref.current?.getContext('webgpu');
        if (!context) {
          throw new Error('getContext("webgpu") returned null');
        }

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });

        const module = device.createShaderModule({ code: SHADER });
        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs_main' },
          fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: { r: 0.05, g: 0.07, b: 0.12, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        context.present();

        const adapterDesc =
          adapter.info
            ? `${adapter.info.vendor || '?'} / ${adapter.info.architecture || '?'}`
            : 'adapter info N/A';
        setStatus(`ok — ${format}, ${adapterDesc}`);
        // eslint-disable-next-line no-console
        console.log(
          `WEBGPU_SPIKE_RESULT ${JSON.stringify({ status: 'pass', format, adapterDesc })}`
        );
      } catch (e) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        setError(message);
        setStatus('error');
        // eslint-disable-next-line no-console
        console.log(`WEBGPU_SPIKE_RESULT ${JSON.stringify({ status: 'fail', error: message })}`);
      }
    };
    // Give the native surface a tick to attach before we grab its context.
    const timer = setTimeout(() => void draw(), 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Text style={[styles.title, { color: theme.text }]}>WebGPU smoke test</Text>
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
        Expected: navy background with a magenta triangle.
      </Text>
      <Canvas ref={ref} style={styles.canvas} />
      <Text style={[styles.status, { color: theme.text }]}>status: {status}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    fontFamily: 'Menlo',
  },
  canvas: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  status: {
    fontFamily: 'Menlo',
    fontSize: 11,
  },
  error: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#c00',
  },
});
