import * as React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { DemoChoiceCard } from '@/components/demo-choice-card';
import { useTheme } from '@/hooks/use-theme';

// @ref LLP 0010#demo-catalog-route — The Demo tab opens to a chooser so
// shipped demos and candidate ports can coexist without replacing each other.
export default function DemoCatalogScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <View style={styles.header}>
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>Web APIs on Expo</Text>
        <Text style={[styles.subtitle, { color: theme.text }]}>
          A suite of demos showcasing camera frames rendered, transformed, or classified through
          the Media Capture and WebGPU APIs.
        </Text>
      </View>

      <DemoChoiceCard
        accentColor="#f59e0b"
        description="A live camera shader playground that runs entirely through WebGPU."
        detail="getUserMedia -> ImageCapture.grabFrame() -> GPUTexture -> WGSL effects"
        href="/shader-lens"
        status="ready"
        title="Shader lens"
      />

      <DemoChoiceCard
        accentColor="#4ade80"
        description="A tiny no-WASM classifier that runs WGSL compute over the live camera texture."
        detail="getUserMedia -> GPUTexture -> WGSL compute -> class scores"
        href="/neural-lens"
        status="ready"
        title="Neural lens"
      />

      <DemoChoiceCard
        accentColor="#a78bfa"
        description="The same LiDAR depth story expressed through a small navigator.xr research profile."
        detail="navigator.xr -> XRFrame depth/camera bytes -> GPUTextures -> WGSL"
        href="/lidar-depth-webxr"
        status="experimental"
        title="WebXR LiDAR depth"
      />

      <DemoChoiceCard
        accentColor="#60a5fa"
        description="A spinning WebGPU cube textured with frames from the shared camera stream."
        detail="getUserMedia -> ImageCapture.grabFrame() -> GPUTexture -> WGSL"
        href="/cube"
        status="ready"
        title="Cube of cameras"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    gap: 14,
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    gap: 8,
    paddingBottom: 4,
  },
  eyebrow: {
    fontFamily: 'Menlo',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  subtitle: {
    fontSize: 17,
    lineHeight: 24,
  },
});
