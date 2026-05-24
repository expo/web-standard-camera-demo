import type { Href } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ExternalLink } from '@/components/external-link';
import { useCamera } from '@/contexts/CameraContext';
import { useTheme } from '@/hooks/use-theme';
import { ImageCapture, Video, type HTMLVideoElement } from '../../../../modules/standard-camera';

const LIVE_DEMO_URL = 'https://huggingface.co/spaces/LiquidAI/LFM2-VL-WebGPU';
const SOURCE_URL = 'https://huggingface.co/spaces/LiquidAI/LFM2-VL-WebGPU/tree/main';

const PROMPTS = [
  'Describe the scene in one sentence.',
  'What color shirt am I wearing?',
  'What am I holding?',
  'How old do I look?',
] as const;

interface FrameProbe {
  bytes: number;
  frameNumber: number;
  height: number;
  width: number;
}

// @ref LLP 0010#demo-4-lfm2-vl-video-captioning-candidate — This route
// keeps the LFM2-VL browser demo selectable while we verify the Expo runtime
// requirements before bundling the Transformers.js model path.
export default function Lfm2VlCandidateScreen(): React.JSX.Element {
  const theme = useTheme();
  const { stream, status, error, userStopped, start, stop } = useCamera();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [prompt, setPrompt] = React.useState<string>(PROMPTS[0]);
  const [frameProbe, setFrameProbe] = React.useState<FrameProbe | null>(null);
  const [grabError, setGrabError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) {
      void video.play();
    }
  }, [stream]);

  React.useEffect(() => {
    if (userStopped) return;
    if (!stream && status !== 'requesting' && status !== 'error') {
      void start({ facingMode: 'user', width: 1280, height: 720 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, status, userStopped]);

  React.useEffect(() => {
    if (!stream) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const track = stream.getVideoTracks()[0];
    if (!track) {
      setGrabError('No video track is available on the active stream.');
      return;
    }

    const imageCapture = new ImageCapture(track);
    const probe = async (): Promise<void> => {
      try {
        const bitmap = await imageCapture.grabFrame();
        if (!cancelled) {
          setFrameProbe({
            bytes: bitmap._data.byteLength,
            frameNumber: bitmap._frameNumber,
            height: bitmap.height,
            width: bitmap.width,
          });
          setGrabError(null);
        }
        bitmap.close();
      } catch (e) {
        if (!cancelled) {
          setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void probe();
          }, 1400);
        }
      }
    };

    void probe();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [stream]);

  const cameraOn = stream != null;

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <View style={styles.hero}>
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>Candidate port</Text>
        <Text style={[styles.title, { color: theme.text }]}>LFM2-VL captioning</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          The source demo is a browser app that runs camera frames through Transformers.js on
          WebGPU. This route keeps it selectable and verifies the camera frame path before the
          model is bundled.
        </Text>
      </View>

      <View style={styles.previewBlock}>
        <View style={styles.videoContainer}>
          <Video ref={videoRef} style={styles.video} />
        </View>
        <View style={styles.actionRow}>
          <ActionButton
            label={cameraOn ? 'Stop camera' : 'Start front camera'}
            onPress={() =>
              cameraOn ? stop() : void start({ facingMode: 'user', width: 1280, height: 720 })
            }
            tone="primary"
          />
          <ActionButton
            label="Use front"
            onPress={() => void start({ facingMode: 'user', width: 1280, height: 720 })}
            tone="secondary"
          />
        </View>
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
          prompt: {prompt}
        </Text>
      </View>

      <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Frame probe</Text>
        <ProbeLine label="camera status" value={status} />
        <ProbeLine label="WebGPU surface" value={navigator.gpu ? 'navigator.gpu present' : 'missing'} />
        <ProbeLine
          label="latest frame"
          value={
            cameraOn && frameProbe
              ? `${frameProbe.width}x${frameProbe.height}, ${frameProbe.bytes} bytes, #${frameProbe.frameNumber}`
              : 'waiting'
          }
        />
        {error ? <Text selectable style={styles.errorText}>camera error: {error}</Text> : null}
        {grabError ? <Text selectable style={styles.errorText}>grabFrame: {grabError}</Text> : null}
      </View>

      <View style={[styles.panel, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.panelTitle, { color: theme.text }]}>Port map</Text>
        <ProbeLine label="browser" value="video.srcObject -> canvas.getImageData() -> RawImage" />
        <ProbeLine label="Expo" value="Video srcObject -> ImageCapture.grabFrame() -> RawImage" />
        <ProbeLine label="model" value="AutoModelForImageTextToText, device: webgpu" />
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          The remaining question is runtime compatibility: Transformers.js v4 next, model caching,
          and BGRA-to-RawImage ingestion under Hermes V1.
        </Text>
      </View>

      <View style={styles.linkRow}>
        <ExternalAction href={LIVE_DEMO_URL} label="Open live demo" />
        <ExternalAction href={SOURCE_URL} label="Open source" />
      </View>
    </ScrollView>
  );
}

function ProbeLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.probeLine}>
      <Text style={[styles.probeLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text selectable style={[styles.probeValue, { color: theme.text }]}>
        {value}
      </Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  tone,
}: {
  label: string;
  onPress: () => void;
  tone: 'primary' | 'secondary';
}): React.JSX.Element {
  const theme = useTheme();
  const primary = tone === 'primary';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? '#60a5fa' : theme.backgroundElement,
          borderColor: primary ? '#60a5fa' : theme.textSecondary,
          opacity: pressed ? 0.72 : 1,
        },
      ]}>
      <Text style={[styles.buttonText, { color: primary ? '#07111f' : theme.text }]}>{label}</Text>
    </Pressable>
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
  previewBlock: {
    gap: 10,
  },
  videoContainer: {
    aspectRatio: 3 / 4,
    backgroundColor: '#111827',
    borderRadius: 8,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  video: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  buttonText: {
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
  probeLine: {
    gap: 3,
  },
  probeLabel: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  probeValue: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
  },
  errorText: {
    color: '#f87171',
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
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
});
