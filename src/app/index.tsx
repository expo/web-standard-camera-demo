import * as React from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';
import { Video, type HTMLVideoElement } from '../../modules/standard-camera';

// @ref LLP 0000 — Demo screen: the entire surface a developer interacts with
// is the spec-shaped navigator.mediaDevices.getUserMedia + <Video srcObject>.

export default function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [status, setStatus] = React.useState<string>('idle');
  const [error, setError] = React.useState<string | null>(null);

  // Auto-start on mount, with proper teardown so Fast Refresh / unmounts
  // don't leak an AVCaptureSession.
  React.useEffect(() => {
    let cancelled = false;
    let active: MediaStream | null = null;

    void (async () => {
      setError(null);
      setStatus('requesting');
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        active = s;
        setStream(s);
        setStatus('starting');

        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          v.onloadeddata = () => setStatus('playing');
          v.onended = () => setStatus('ended');
          await v.play();
        }
      } catch (e) {
        if (cancelled) return;
        const err = e as Error & { name?: string };
        setError(`${err.name ?? 'Error'}: ${err.message}`);
        setStatus('idle');
      }
    })();

    return () => {
      cancelled = true;
      if (active) {
        for (const t of active.getTracks()) t.stop();
      }
    };
  }, []);

  function stop(): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStream(null);
    setStatus('stopped');
  }

  async function start(): Promise<void> {
    setError(null);
    setStatus('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      setStream(s);
      setStatus('starting');

      const v = videoRef.current;
      if (v) {
        v.srcObject = s;
        v.onloadeddata = () => setStatus('playing');
        v.onended = () => setStatus('ended');
        await v.play();
      }
    } catch (e) {
      const err = e as Error & { name?: string };
      setError(`${err.name ?? 'Error'}: ${err.message}`);
      setStatus('idle');
    }
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        contentInsetAdjustmentBehavior="automatic">
        <Text style={[styles.title, { color: theme.text }]}>standard-camera-app</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>navigator.mediaDevices.getUserMedia → &lt;Video srcObject&gt;</Text>

        <View style={styles.videoContainer}>
          <Video ref={videoRef} style={styles.video} />
        </View>

        <View style={styles.controls}>
          {!stream ? (
            <Button title="Start camera" onPress={start} />
          ) : (
            <Button title="Stop camera" onPress={stop} />
          )}
        </View>

        <View style={styles.statusBlock}>
          <Text style={[styles.statusLine, { color: theme.text }]}>status: {status}</Text>
          <Text style={[styles.statusLine, { color: theme.text }]}>active: {stream?.active ? 'true' : 'false'}</Text>
          <Text style={[styles.statusLine, { color: theme.text }]}>tracks: {stream?.getTracks().length ?? 0}</Text>
          {stream?.getVideoTracks().map((t) => (
            <Text key={t.id} style={[styles.statusLine, { color: theme.text }]}>
              {t.label} • {t.kind} • {t.readyState}
            </Text>
          ))}
          {error && <Text style={styles.errorLine}>{error}</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 16,
    paddingBottom: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Menlo',
  },
  videoContainer: {
    aspectRatio: 3 / 4,
    backgroundColor: '#111',
    borderRadius: 12,
    overflow: 'hidden',
  },
  video: {
    flex: 1,
  },
  controls: {
    flexDirection: 'row',
    gap: 12,
  },
  statusBlock: {
    gap: 4,
  },
  statusLine: {
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  errorLine: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#c00',
  },
});
