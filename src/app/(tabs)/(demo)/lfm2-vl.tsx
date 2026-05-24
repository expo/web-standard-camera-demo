import type { Href } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { useTheme } from '@/hooks/use-theme';

const LIVE_DEMO_URL = 'https://huggingface.co/spaces/LiquidAI/LFM2-VL-WebGPU';
const SOURCE_URL = 'https://huggingface.co/spaces/LiquidAI/LFM2-VL-WebGPU/tree/main';

const PROMPTS = [
  'Describe the scene in one sentence.',
  'What color shirt am I wearing?',
  'What am I holding?',
  'How old do I look?',
] as const;

// @ref LLP 0010#demo-4-lfm2-vl-video-captioning-candidate — This route keeps
// the LFM2-VL browser demo selectable without touching the local camera until
// the Transformers.js runtime path is actually ported and validated.
export default function Lfm2VlCandidateScreen(): React.JSX.Element {
  const theme = useTheme();
  const [prompt, setPrompt] = React.useState<string>(PROMPTS[0]);

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <View style={styles.hero}>
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>Candidate port</Text>
        <Text style={[styles.title, { color: theme.text }]}>LFM2-VL captioning</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          This is the source demo we want to port: camera frames flow through browser APIs into
          a Transformers.js vision-language model running on WebGPU.
        </Text>
      </View>

      <View style={styles.linkRow}>
        <ExternalAction href={LIVE_DEMO_URL} label="Open live demo" />
        <ExternalAction href={SOURCE_URL} label="Open source" />
      </View>

      <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Why it is compelling</Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          It is not a synthetic graphics sample. The browser demo asks a real question about
          the current camera frame and answers locally through WebGPU-backed model inference.
        </Text>
      </View>

      <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Prompt shape</Text>
        <View style={styles.promptGrid}>
          {PROMPTS.map((candidate) => (
            <Pressable
              key={candidate}
              onPress={() => setPrompt(candidate)}
              style={[
                styles.promptChip,
                {
                  backgroundColor: prompt === candidate ? theme.text : theme.background,
                },
              ]}>
              <Text
                style={[
                  styles.promptText,
                  { color: prompt === candidate ? theme.background : theme.text },
                ]}>
                {candidate}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text selectable style={[styles.selectedPrompt, { color: theme.textSecondary }]}>
          selected prompt: {prompt}
        </Text>
      </View>

      <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Port map</Text>
        <PortLine label="browser" value="getUserMedia -> video.srcObject -> canvas -> RawImage" />
        <PortLine label="Expo target" value="getUserMedia -> Video srcObject -> frame extraction -> RawImage" />
        <PortLine label="model" value="Transformers.js AutoModelForImageTextToText, device: webgpu" />
      </View>

      <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Not wired locally yet</Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          This screen intentionally does not start the camera or probe frames. The next implementation
          step is validating Transformers.js under Hermes V1, then wiring the camera frame conversion
          once the model path is known to run.
        </Text>
      </View>
    </ScrollView>
  );
}

function PortLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.portLine}>
      <Text style={[styles.portLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text selectable style={[styles.portValue, { color: theme.text }]}>
        {value}
      </Text>
    </View>
  );
}

function ExternalAction({
  href,
  label,
}: {
  href: Href & string;
  label: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <ExternalLink href={href} asChild>
      <Pressable
        style={({ pressed }) => [
          styles.externalButton,
          {
            backgroundColor: theme.backgroundElement,
            opacity: pressed ? 0.72 : 1,
          },
        ]}>
        <Text style={[styles.externalButtonText, { color: theme.text }]}>{label}</Text>
      </Pressable>
    </ExternalLink>
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
  hero: {
    gap: 7,
  },
  eyebrow: {
    fontFamily: 'Menlo',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
  },
  linkRow: {
    flexDirection: 'row',
    gap: 10,
  },
  externalButton: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  externalButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  panel: {
    borderRadius: 8,
    borderCurve: 'continuous',
    gap: 10,
    padding: 14,
  },
  panelTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
  },
  promptGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  promptChip: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  promptText: {
    fontSize: 12,
    fontWeight: '700',
  },
  selectedPrompt: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
  },
  portLine: {
    gap: 3,
  },
  portLabel: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  portValue: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
  },
});
