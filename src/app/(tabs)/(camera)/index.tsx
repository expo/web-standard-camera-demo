import { useIsFocused } from 'expo-router';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { addTestRunStartListener } from '@/lib/camera-run-events';
import { Video, type HTMLVideoElement } from '../../../../modules/standard-camera';

// @ref LLP 0000 — Demo screen: the entire surface a developer interacts with
// is the spec-shaped navigator.mediaDevices.getUserMedia + <Video srcObject>.

const initialUrlPromise = Linking.getInitialURL();

export default function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const isFocused = useIsFocused();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const mountedRef = React.useRef(false);
  const startRequestRef = React.useRef(0);
  const launchAutoStartCheckedRef = React.useRef(false);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [status, setStatus] = React.useState<string>('idle');
  const [error, setError] = React.useState<string | null>(null);

  const stop = React.useCallback((nextStatus = 'stopped'): void => {
    const activeStream = streamRef.current;
    if (!activeStream) return;
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    streamRef.current = null;
    if (mountedRef.current) {
      setStream(null);
      setStatus(nextStatus);
    }
  }, []);

  const stopForTestRun = React.useCallback((): void => {
    startRequestRef.current += 1;
    if (!streamRef.current && mountedRef.current) {
      setStatus('stopped');
    }
    stop();
  }, [stop]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  React.useEffect(() => addTestRunStartListener(stopForTestRun), [stopForTestRun]);

  const start = React.useCallback(async (): Promise<void> => {
    if (streamRef.current) return;
    const requestId = startRequestRef.current + 1;
    startRequestRef.current = requestId;
    setError(null);
    setStatus('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      if (!mountedRef.current || requestId !== startRequestRef.current) {
        for (const track of s.getTracks()) {
          track.stop();
        }
        return;
      }
      streamRef.current = s;
      setStream(s);
      setStatus('starting');

      const v = videoRef.current;
      if (v) {
        v.srcObject = s;
        v.onloadeddata = () => {
          if (mountedRef.current && streamRef.current === s) setStatus('playing');
        };
        v.onended = () => {
          if (mountedRef.current && streamRef.current === s) setStatus('ended');
        };
        await v.play();
      }
    } catch (e) {
      if (!mountedRef.current || requestId !== startRequestRef.current) return;
      const err = e as Error & { name?: string };
      setError(`${err.name ?? 'Error'}: ${err.message}`);
      setStatus('idle');
    }
  }, []);

  // Auto-start only for the initial Home launch. A run-tests deeplink mounts
  // native tabs eagerly, so checking the original launch URL prevents the Home
  // screen from opening the camera behind the Tests tab.
  React.useEffect(() => {
    if (!isFocused || launchAutoStartCheckedRef.current) return;
    launchAutoStartCheckedRef.current = true;

    let cancelled = false;
    void (async () => {
      const initialUrl = await initialUrlPromise;
      if (cancelled || isTestsLaunchUrl(initialUrl)) return;
      await start();
    })();

    return () => {
      cancelled = true;
    };
  }, [isFocused, start]);

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.contentContainer}
      contentInsetAdjustmentBehavior="automatic">
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>navigator.mediaDevices.getUserMedia → &lt;Video srcObject&gt;</Text>

      <View style={styles.videoContainer}>
        <Video ref={videoRef} style={styles.video} />
      </View>

      <View style={styles.controls}>
        {!stream ? (
          <Button title="Start camera" onPress={start} />
        ) : (
          <Button title="Stop camera" onPress={() => stop()} />
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
  );
}

function isTestsLaunchUrl(url: string | null): boolean {
  return url != null && /(?:^|[/?:#])run-tests(?:$|[/?#&])/.test(url);
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 16,
    paddingBottom: 32,
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
    alignItems: 'center',
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
