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
          Choose the proof point for the conversation: the current WebGPU camera cube, or the
          LFM2-VL port candidate that mirrors a real browser demo.
        </Text>
      </View>

      <DemoChoiceCard
        accentColor="#60a5fa"
        description="A spinning WebGPU cube textured with frames from the shared camera stream."
        detail="getUserMedia -> ImageCapture.grabFrame() -> GPUTexture -> WGSL"
        href="/cube"
        status="ready"
        title="Cube of cameras"
      />

      <DemoChoiceCard
        accentColor="#f59e0b"
        description="A research entry for Liquid AI's browser WebGPU captioning demo."
        detail="source demo: getUserMedia -> canvas frame -> Transformers.js WebGPU"
        href="/lfm2-vl"
        status="research"
        title="LFM2-VL captioning"
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
