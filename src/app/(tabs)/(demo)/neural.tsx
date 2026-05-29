import { Image as ExpoImage } from 'expo-image';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import {
  Host,
  Picker,
  SymbolView,
  Text as UIText,
  disabled as disabledModifier,
  pickerStyle,
  tag,
} from '@/components/demo-platform-controls';
import { DemoPageFrame } from '@/components/demo-page-frame';
import { useCamera } from '@/contexts/CameraContext';
import { displayFacingMode } from '@/lib/camera-facing';
import {
  detectTfjsCameraFrame,
  detectTfjsObjectProbe,
  getTfjsObjectCacheInfo,
  preloadTfjsObjectModel,
  subscribeTfjsObjectCacheInfo,
  TFJS_OBJECT_PROBES,
  type ObjectDetectionBox,
  type ObjectProbeId,
  type TfjsCameraFrame,
  type TfjsObjectCacheInfo,
  type TfjsObjectResult,
} from '@/lib/tfjs-object-detector';
import { ImageCapture, Video, type HTMLVideoElement } from '../../../../modules/standard-camera';

// @ref LLP 0012#demo-6-tensorflowjs-object-lens — TensorFlow.js runs through
// the WebGPU backend and a bundled COCO-SSD graph detects objects from
// low-cadence camera tensors or static probe tensors without WASM/native ML.

type SourceId = 'camera' | ObjectProbeId;
type DetectionStatus = 'loading' | 'ready' | 'waiting' | 'error';

type DetectionState = {
  error: string | null;
  result: TfjsObjectResult | null;
  source: SourceId;
  status: DetectionStatus;
};

type SmokeState =
  | { source: SourceId; status: 'loading' }
  | { cameraStatus: string; error?: string; source: 'camera'; status: 'waiting' }
  | {
      backend: string;
      detections: number;
      detectMs: number;
      frame?: string;
      isWebGpu: boolean;
      modelLoadCount: number;
      modelLoadMs: number;
      modelWeightSource: string | null;
      prediction: string;
      probability: number;
      runtimeInitCount: number;
      source: SourceId;
      scene: string;
      status: 'ready';
      tensorMs: number;
    }
  | { error: string; source: SourceId; status: 'error' };

declare global {
  var __TFJS_SCENE_SMOKE__: SmokeState | undefined;
}

const INITIAL_SOURCE: SourceId = 'camera';
const CAMERA_INFERENCE_INTERVAL_MS = 1000;
const CAMERA_WAIT_RETRY_MS = 450;
const CAMERA_ERROR_RETRY_MS = 1500;
const CAMERA_CAPTURE_SETTLE_MS = 250;
const CAMERA_SWITCH_CLASSIFIER_PAUSE_MS = 900;
const PROBE_DETECT_DEBOUNCE_MS = 140;

export default function TfjsSceneLensScreen(): React.JSX.Element {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { source: sourceParam } = useLocalSearchParams<{ source?: string | string[] }>();
  const {
    stream,
    status: cameraStatus,
    error: cameraError,
    constraints,
    settings,
    facingModeAvailability,
    userStopped,
    externalLocked,
    start,
    applyConstraints,
  } = useCamera();

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  const imageCaptureAcceptAfterRef = React.useRef(0);
  const captureSetupErrorRef = React.useRef<string | null>(null);
  const cameraInferenceAbortRef = React.useRef<AbortController | null>(null);
  const cameraInferencePausedUntilRef = React.useRef(0);
  const detectSeqRef = React.useRef(0);

  const [cacheInfo, setCacheInfo] = React.useState<TfjsObjectCacheInfo>(() => getTfjsObjectCacheInfo());
  const [source, setSource] = React.useState<SourceId>(() => parseSourceParam(sourceParam));
  const [detection, setDetection] = React.useState<DetectionState>(() => {
    const initialSource = parseSourceParam(sourceParam);
    return {
      error: null,
      result: null,
      source: initialSource,
      status: initialSource === 'camera' ? 'waiting' : 'loading',
    };
  });

  React.useEffect(() => subscribeTfjsObjectCacheInfo(setCacheInfo), []);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) {
      void video.play();
    }
  }, [stream]);

  React.useEffect(() => {
    const track = stream?.getVideoTracks()[0];
    if (!track) {
      imageCaptureRef.current = null;
      imageCaptureAcceptAfterRef.current = 0;
      captureSetupErrorRef.current = null;
      return;
    }
    try {
      imageCaptureRef.current = new ImageCapture(track);
      imageCaptureAcceptAfterRef.current = Date.now() + CAMERA_CAPTURE_SETTLE_MS;
      captureSetupErrorRef.current = null;
    } catch (e: unknown) {
      imageCaptureRef.current = null;
      imageCaptureAcceptAfterRef.current = 0;
      captureSetupErrorRef.current = formatError(e);
    }
  }, [stream]);

  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      let idleCancel: (() => void) | null = null;
      idleCancel = scheduleAfterPaintAndIdle(() => {
        if (cancelled) return;
        const preload = preloadTfjsObjectModel();
        setCacheInfo(getTfjsObjectCacheInfo());
        void preload
          .then((next) => {
            if (!cancelled) setCacheInfo(next);
          })
          .catch(() => {
            if (!cancelled) setCacheInfo(getTfjsObjectCacheInfo());
          });
      });
      return () => {
        cancelled = true;
        idleCancel?.();
      };
    }, [])
  );

  useFocusEffect(
    React.useCallback(() => {
      if (source !== 'camera' || userStopped || externalLocked) return undefined;
      if (
        !stream &&
        cameraStatus !== 'requesting' &&
        cameraStatus !== 'starting' &&
        cameraStatus !== 'stopping' &&
        cameraStatus !== 'error'
      ) {
        void start();
      }
      return undefined;
    }, [cameraStatus, externalLocked, source, start, stream, userStopped])
  );

  const selectSource = React.useCallback(
    (nextSource: SourceId): void => {
      if (source === nextSource) return;
      setSource(nextSource);
      setDetection({
        error: null,
        result: null,
        source: nextSource,
        status: nextSource === 'camera' ? 'waiting' : 'loading',
      });
      if (
        nextSource === 'camera' &&
        !stream &&
        !userStopped &&
        !externalLocked &&
        cameraStatus !== 'requesting' &&
        cameraStatus !== 'starting' &&
        cameraStatus !== 'stopping' &&
        cameraStatus !== 'error'
      ) {
        void start();
      }
    },
    [cameraStatus, externalLocked, source, start, stream, userStopped]
  );

  React.useEffect(() => {
    if (source === 'camera') return undefined;
    let cancelled = false;
    const seq = detectSeqRef.current + 1;
    detectSeqRef.current = seq;
    let timer: ReturnType<typeof setTimeout> | null = null;

    publishSmoke({ source, status: 'loading' });

    timer = setTimeout(() => {
      void (async () => {
        await waitForQuietFrame();
        const next = await detectTfjsObjectProbe(source);
        if (cancelled || detectSeqRef.current !== seq) return;
        setCacheInfo(next.cache);
        publishSmoke(makeReadySmoke(source, next), true);
        setDetection({ error: null, result: next, source, status: 'ready' });
      })().catch((e: unknown) => {
        if (cancelled || detectSeqRef.current !== seq) return;
        setCacheInfo(getTfjsObjectCacheInfo());
        const message = formatError(e);
        publishSmoke({ error: message, source, status: 'error' }, true);
        setDetection({ error: message, result: null, source, status: 'error' });
      });
    }, PROBE_DETECT_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [source]);

  const isDesktop = windowWidth >= 1040;
  const isWebDesktop = Platform.OS === 'web' && isDesktop;
  const previewAspect = Platform.OS === 'web' || isDesktop ? 4 / 3 : 3 / 4;
  const rotateForPortrait = Platform.OS !== 'web' && !isDesktop;

  React.useEffect(() => {
    if (source !== 'camera') return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const seq = detectSeqRef.current + 1;
    detectSeqRef.current = seq;

    const schedule = (delay: number): void => {
      if (cancelled || detectSeqRef.current !== seq) return;
      timer = setTimeout(detectNextFrame, delay);
    };

    const publishWaiting = (message?: string): void => {
      const smoke: SmokeState = {
        cameraStatus,
        ...(message ? { error: message } : null),
        source: 'camera',
        status: 'waiting',
      };
      publishSmoke(smoke);
      setDetection((current) => ({
        error: message ?? null,
        result: current.source === 'camera' ? current.result : null,
        source: 'camera',
        status: 'waiting',
      }));
    };

    const publishError = (message: string): void => {
      publishSmoke({ error: message, source: 'camera', status: 'error' }, true);
      setDetection((current) => ({
        error: message,
        result: current.source === 'camera' ? current.result : null,
        source: 'camera',
        status: 'error',
      }));
    };

    async function detectNextFrame(): Promise<void> {
      if (cancelled || detectSeqRef.current !== seq) return;
      const capture = imageCaptureRef.current;
      if (cameraStatus === 'error') {
        publishError(cameraError ?? 'Camera unavailable');
        schedule(CAMERA_ERROR_RETRY_MS);
        return;
      }
      if (!stream || cameraStatus !== 'playing' || !capture) {
        publishWaiting(captureSetupErrorRef.current ?? cameraError ?? `camera ${cameraStatus}`);
        schedule(CAMERA_WAIT_RETRY_MS);
        return;
      }

      const settleMs = Math.max(
        0,
        cameraInferencePausedUntilRef.current - Date.now(),
        imageCaptureAcceptAfterRef.current - Date.now()
      );
      if (settleMs > 0) {
        publishWaiting('camera settling');
        schedule(Math.min(CAMERA_WAIT_RETRY_MS, Math.ceil(settleMs)));
        return;
      }

      let frame: TfjsCameraFrame | null = null;
      const controller = new AbortController();
      cameraInferenceAbortRef.current?.abort();
      cameraInferenceAbortRef.current = controller;
      const isCurrentCapture = (): boolean => (
        !cancelled &&
        !controller.signal.aborted &&
        detectSeqRef.current === seq &&
        imageCaptureRef.current === capture
      );
      try {
        setDetection((current) => (
          current.source === 'camera' && current.result
            ? current
            : { error: null, result: null, source: 'camera', status: 'loading' }
        ));
        publishSmoke({ source: 'camera', status: 'loading' });
        await waitForNextPaint();
        if (!isCurrentCapture()) return;
        frame = await capture.grabFrame();
        await waitForNextPaint();
        if (!isCurrentCapture()) return;
        const next = await detectTfjsCameraFrame(frame, {
          rotateForPortrait,
          signal: controller.signal,
        });
        if (cancelled || detectSeqRef.current !== seq) return;
        setCacheInfo(next.cache);
        publishSmoke(makeReadySmoke('camera', next));
        setDetection({ error: null, result: next, source: 'camera', status: 'ready' });
        schedule(CAMERA_INFERENCE_INTERVAL_MS);
      } catch (e: unknown) {
        if (cancelled || detectSeqRef.current !== seq) return;
        if (isAbortError(e)) {
          publishWaiting('camera settling');
          schedule(CAMERA_WAIT_RETRY_MS);
          return;
        }
        const message = formatError(e);
        setCacheInfo(getTfjsObjectCacheInfo());
        if (isTransientCameraFrameError(message)) {
          publishWaiting(message);
          schedule(CAMERA_WAIT_RETRY_MS);
        } else {
          publishError(message);
          schedule(CAMERA_ERROR_RETRY_MS);
        }
      } finally {
        if (cameraInferenceAbortRef.current === controller) {
          cameraInferenceAbortRef.current = null;
        }
        frame?.close?.();
      }
    }

    void detectNextFrame();
    return () => {
      cancelled = true;
      cameraInferenceAbortRef.current?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [cameraError, cameraStatus, rotateForPortrait, source, stream]);

  const previewMaxHeight = Math.max(300, windowHeight - (isWebDesktop ? 180 : 500));
  const previewMaxWidth = Math.max(240, isWebDesktop ? windowWidth - 456 : windowWidth - 32);
  const previewStageWidth = Math.max(240, Math.min(previewMaxWidth, previewMaxHeight * previewAspect));
  const previewStageHeight = previewStageWidth / previewAspect;
  const cameraFacing = displayFacingMode({ constraints, settings });
  const backFacingDisabled = facingModeAvailability.environment === 'unavailable';
  const cameraSelected = source === 'camera';
  const isFront = cameraFacing === 'user';

  const setFacing = React.useCallback(
    (facingMode: 'user' | 'environment'): void => {
      if (facingMode === cameraFacing) return;
      if (facingMode === 'environment' && backFacingDisabled) return;
      cameraInferencePausedUntilRef.current = Date.now() + CAMERA_SWITCH_CLASSIFIER_PAUSE_MS;
      cameraInferenceAbortRef.current?.abort();
      cameraInferenceAbortRef.current = null;
      imageCaptureRef.current = null;
      imageCaptureAcceptAfterRef.current = 0;
      detectSeqRef.current += 1;
      setDetection(() => ({
        error: null,
        result: null,
        source: 'camera',
        status: 'waiting',
      }));
      applyConstraints({ facingMode });
    },
    [applyConstraints, backFacingDisabled, cameraFacing]
  );

  const result = detection.source === source ? detection.result : null;
  const activeCache = result?.cache ?? cacheInfo;
  const topDetection = result?.detections[0];
  const activeProbe = source === 'camera' ? null : findProbe(source);
  const modelPhaseLine = formatModelLoadPhase(activeCache);
  const primaryLine = result
    ? `${result.summary.reason} ${formatPercent(result.summary.confidence)}`
    : detection.status === 'error'
      ? 'Detector unavailable'
      : activeCache.modelStatus === 'ready'
        ? 'Classifying objects'
        : 'Preparing neural model';
  const secondaryLine = result
    ? result.summary.label
    : detection.status === 'loading'
      ? activeCache.modelStatus === 'ready'
        ? 'classifying current image'
        : modelPhaseLine
      : detection.error ?? 'camera pending';
  const cameraLine = formatCameraLine(cameraStatus, settings);
  const frameLine = result?.source.kind === 'camera'
    ? `${result.source.sourceWidth}x${result.source.sourceHeight} · ${result.source.frameFormat}`
    : activeProbe?.label ?? 'camera';
  const hudStatus = detection.status === 'loading'
    ? activeCache.modelStatus === 'ready'
      ? 'classifying'
      : 'loading model'
    : detection.status;
  const showCameraPlaceholder = source === 'camera' && (!stream || cameraStatus !== 'playing');
  const showLoadingOverlay = !result &&
    detection.status !== 'error' &&
    (activeCache.modelStatus !== 'ready' || detection.status === 'loading');
  const loadingTitle = activeCache.modelStatus === 'ready'
    ? 'Classifying image'
    : 'Loading neural model';
  const loadingDetail = activeCache.modelStatus === 'ready'
    ? 'running object detector'
    : modelPhaseLine;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <DemoPageFrame
        action="standard-camera"
        preview={
          <View style={[styles.previewStage, { height: previewStageHeight, width: previewStageWidth }]}>
            {source === 'camera' ? (
              <Video
                ref={videoRef}
                autoplay
                srcObject={stream}
                style={[styles.video, isFront ? styles.mirroredVideo : null]}
              />
            ) : (
              <ExpoImage
                accessibilityLabel={activeProbe?.label ?? 'Object probe'}
                contentFit="cover"
                source={{ uri: activeProbe?.imageUri }}
                style={styles.previewImage}
                transition={160}
              />
            )}
            {result?.detections.map((box) => (
              <DetectionBoxOverlay
                box={box}
                inputHeight={result.input.height}
                inputWidth={result.input.width}
                key={`${box.className}-${box.bbox.join('-')}`}
                mirrored={source === 'camera' && isFront}
                stageHeight={previewStageHeight}
                stageWidth={previewStageWidth}
              />
            ))}
            {showCameraPlaceholder ? (
              <View pointerEvents="none" style={styles.stoppedOverlay}>
                <SymbolView
                  name="video.slash.fill"
                  size={56}
                  tintColor="#94a3b8"
                  weight="semibold"
                />
              </View>
            ) : null}
            {showLoadingOverlay ? (
              <Animated.View
                entering={FadeIn.duration(160)}
                pointerEvents="none"
                style={styles.loadingOverlay}>
                <ActivityIndicator color="#38bdf8" size="small" />
                <View style={styles.loadingText}>
                  <Text selectable numberOfLines={1} style={styles.loadingTitle}>
                    {loadingTitle}
                  </Text>
                  <Text selectable numberOfLines={2} style={styles.loadingDetail}>
                    {loadingDetail}
                  </Text>
                </View>
              </Animated.View>
            ) : null}
            {!showCameraPlaceholder ? (
              <View pointerEvents="none" style={styles.sceneBadge}>
                <Text selectable numberOfLines={1} style={styles.sceneBadgePrimary}>
                  {primaryLine}
                </Text>
                <Text selectable numberOfLines={1} style={styles.sceneBadgeSecondary}>
                  {secondaryLine}
                </Text>
              </View>
            ) : null}
          </View>
        }
        controls={
          <View style={styles.controls}>
            <Host style={styles.pickerHost}>
              <Picker
                modifiers={[pickerStyle('segmented')]}
                label="Source"
                selection={source}
                onSelectionChange={(value) => selectSource(value as SourceId)}>
                <UIText modifiers={[tag('camera')]}>Camera</UIText>
                {TFJS_OBJECT_PROBES.map((probe) => (
                  <UIText key={probe.id} modifiers={[tag(probe.id)]}>
                    {probe.label}
                  </UIText>
                ))}
              </Picker>
            </Host>

            <Host style={styles.pickerHost}>
              <Picker
                modifiers={[pickerStyle('segmented')]}
                label="Camera"
                selection={cameraFacing}
                onSelectionChange={(value) => setFacing(value as 'user' | 'environment')}>
                <UIText modifiers={[tag('environment'), disabledModifier(!cameraSelected || backFacingDisabled)]}>
                  Back
                </UIText>
                <UIText modifiers={[tag('user'), disabledModifier(!cameraSelected)]}>Front</UIText>
              </Picker>
            </Host>

            {result?.detections.length ? (
              <View style={styles.detections} testID="tfjs-scene-ready">
                {result.detections.map((detectionBox, index) => (
                  <DetectionRow
                    detection={detectionBox}
                    index={index}
                    key={`${detectionBox.className}-${index}`}
                  />
                ))}
              </View>
            ) : null}
          </View>
        }
        hud={
          <View style={styles.hud}>
            <Text selectable style={styles.hudText}>
              COCO-SSD · {hudStatus}
            </Text>
            <Text selectable style={styles.hudSub}>
              top: {topDetection ? `${topDetection.className} · ${formatPercent(topDetection.score)}` : 'pending'}
            </Text>
            <Text selectable style={styles.hudSub}>
              backend: {result?.backend.backend ?? 'pending'} · model:{' '}
              {result ? `${result.modelLoadMs}ms` : 'pending'} · tensor:{' '}
              {result ? `${result.tensorMs}ms` : 'pending'} · detect:{' '}
              {result ? `${result.detectMs}ms` : 'pending'}
            </Text>
            <Text selectable style={styles.hudSub}>
              loads: model {activeCache.modelLoadCount} · runtime{' '}
              {activeCache.runtimeInitCount} · probes{' '}
              {activeCache.probeDecodeCount}
            </Text>
            <Text selectable style={styles.hudSub}>
              model: {activeCache.modelStatus} · {modelPhaseLine} · loads{' '}
              {activeCache.modelLoadCount} · weights: {activeCache.modelWeightSource ?? 'pending'}
            </Text>
            <Text selectable style={styles.hudSub}>
              source: {frameLine}
            </Text>
            {source === 'camera' ? (
              <Text selectable style={styles.hudSub}>
                camera: {cameraLine}
              </Text>
            ) : null}
            {detection.status === 'error' && detection.error ? (
              <Text selectable style={styles.hudError} testID="tfjs-scene-error">
                {detection.error}
              </Text>
            ) : null}
          </View>
        }
      />
    </ScrollView>
  );
}

function publishSmoke(smoke: SmokeState, log = false): void {
  globalThis.__TFJS_SCENE_SMOKE__ = smoke;
  if (__DEV__ && log) {
    console.log(`TFJS_SCENE_SMOKE ${JSON.stringify(smoke)}`);
  }
}

function makeReadySmoke(source: SourceId, result: TfjsObjectResult): SmokeState {
  const top = result.detections[0];
  return {
    backend: result.backend.backend,
    detections: result.detections.length,
    detectMs: result.detectMs,
    ...(result.source.kind === 'camera'
      ? { frame: `${result.source.sourceWidth}x${result.source.sourceHeight}` }
      : null),
    isWebGpu: result.backend.isWebGpu,
    modelLoadCount: result.cache.modelLoadCount,
    modelLoadMs: result.modelLoadMs,
    modelWeightSource: result.cache.modelWeightSource,
    prediction: top?.className ?? 'none',
    probability: top?.score ?? 0,
    runtimeInitCount: result.cache.runtimeInitCount,
    scene: result.summary.label,
    source,
    status: 'ready',
    tensorMs: result.tensorMs,
  };
}

function DetectionRow({
  detection,
  index,
}: {
  detection: ObjectDetectionBox;
  index: number;
}): React.JSX.Element {
  const progress = useSharedValue(0);

  React.useEffect(() => {
    progress.value = withTiming(Math.max(0.03, detection.score), {
      duration: 420,
    });
  }, [detection.score, progress]);

  const animatedBarStyle = useAnimatedStyle(() => ({
    width: `${Math.max(3, progress.value * 100)}%`,
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(180).delay(index * 35)}
      layout={LinearTransition.duration(180)}
      style={styles.detectionRow}>
      <View style={styles.detectionText}>
        <Text selectable numberOfLines={1} style={styles.detectionName}>
          {detection.className}
        </Text>
        <Text selectable style={styles.detectionValue}>
          {formatPercent(detection.score)}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <Animated.View style={[styles.barFill, animatedBarStyle]} />
      </View>
    </Animated.View>
  );
}

function DetectionBoxOverlay({
  box,
  inputHeight,
  inputWidth,
  mirrored,
  stageHeight,
  stageWidth,
}: {
  box: ObjectDetectionBox;
  inputHeight: number;
  inputWidth: number;
  mirrored: boolean;
  stageHeight: number;
  stageWidth: number;
}): React.JSX.Element {
  const [x, y, width, height] = box.bbox;
  const scale = Math.max(stageWidth / inputWidth, stageHeight / inputHeight);
  const displayedWidth = inputWidth * scale;
  const displayedHeight = inputHeight * scale;
  const offsetX = (stageWidth - displayedWidth) / 2;
  const offsetY = (stageHeight - displayedHeight) / 2;
  const left = mirrored
    ? stageWidth - (offsetX + (x + width) * scale)
    : offsetX + x * scale;
  const top = offsetY + y * scale;

  return (
    <Animated.View
      entering={FadeIn.duration(120)}
      pointerEvents="none"
      style={[
        styles.box,
        {
          height: Math.max(18, height * scale),
          left,
          top,
          width: Math.max(18, width * scale),
        },
      ]}>
      <Text numberOfLines={1} style={styles.boxLabel}>
        {box.className} {formatPercent(box.score)}
      </Text>
    </Animated.View>
  );
}

function findProbe(probe: ObjectProbeId): (typeof TFJS_OBJECT_PROBES)[number] {
  return TFJS_OBJECT_PROBES.find((candidate) => candidate.id === probe) ?? TFJS_OBJECT_PROBES[0];
}

function parseSourceParam(param: string | string[] | undefined): SourceId {
  const value = Array.isArray(param) ? param[0] : param;
  if (value && TFJS_OBJECT_PROBES.some((probe) => probe.id === value)) {
    return value as ObjectProbeId;
  }
  return INITIAL_SOURCE;
}

function formatCameraLine(status: string, settings: MediaTrackSettings | null): string {
  if (typeof settings?.width === 'number' && typeof settings.height === 'number') {
    const fpsPart = typeof settings.frameRate === 'number'
      ? ` @ ${Math.round(settings.frameRate)} fps`
      : '';
    return `${settings.width}x${settings.height}${fpsPart} · ${status}`;
  }
  return status;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function formatModelLoadPhase(cache: TfjsObjectCacheInfo): string {
  switch (cache.modelLoadPhase) {
    case 'runtime':
      return 'initializing TensorFlow.js';
    case 'weights':
      return cache.modelWeightSource
        ? `reading ${cache.modelWeightSource} weights`
        : 'reading bundled weights';
    case 'graph':
      return 'building COCO-SSD graph';
    case 'warmup':
      return 'warming COCO-SSD once';
    case 'ready':
      return 'model ready';
    case 'error':
      return 'model load failed';
    case 'idle':
    default:
      return 'waiting for screen paint';
  }
}

function isTransientCameraFrameError(message: string): boolean {
  return /No frames available|UnknownError|camera requesting|camera starting|camera idle/.test(message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function waitForQuietFrame(): Promise<void> {
  return new Promise((resolve) => {
    scheduleAfterPaintAndIdle(resolve);
  });
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let fallback: ReturnType<typeof setTimeout> | null = setTimeout(done, 120);
    function done(): void {
      if (settled) return;
      settled = true;
      if (fallback) {
        clearTimeout(fallback);
        fallback = null;
      }
      resolve();
    }
    requestAnimationFrame(() => {
      setTimeout(done, 0);
    });
  });
}

function scheduleAfterPaintAndIdle(callback: () => void): () => void {
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let idleId: number | null = null;
  let frameId: number | null = requestAnimationFrame(() => {
    frameId = null;
    if (cancelled) return;
    const requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle === 'function') {
      idleId = requestIdle(() => {
        idleId = null;
        if (!cancelled) callback();
      }, { timeout: 250 });
    } else {
      timeout = setTimeout(() => {
        timeout = null;
        if (!cancelled) callback();
      }, 0);
    }
  });

  return () => {
    cancelled = true;
    if (frameId != null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (idleId != null && typeof globalThis.cancelIdleCallback === 'function') {
      globalThis.cancelIdleCallback(idleId);
      idleId = null;
    }
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
}

const styles = StyleSheet.create({
  scroll: {
    backgroundColor: '#080b12',
    flex: 1,
  },
  content: {
    alignItems: 'center',
    gap: 12,
    paddingBottom: 32,
  },
  previewStage: {
    backgroundColor: '#020617',
    borderRadius: 10,
    overflow: 'hidden',
  },
  video: {
    height: '100%',
    width: '100%',
  },
  mirroredVideo: {
    transform: [{ scaleX: -1 }],
  },
  previewImage: {
    height: '100%',
    width: '100%',
  },
  stoppedOverlay: {
    alignItems: 'center',
    backgroundColor: '#000',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  loadingOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(2, 6, 23, 0.82)',
    borderColor: 'rgba(56, 189, 248, 0.24)',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    left: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    position: 'absolute',
    right: 12,
    top: 12,
  },
  loadingText: {
    flex: 1,
    gap: 2,
  },
  loadingTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '800',
  },
  loadingDetail: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 10,
    lineHeight: 13,
  },
  sceneBadge: {
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    borderColor: 'rgba(248, 250, 252, 0.16)',
    borderRadius: 8,
    borderWidth: 1,
    bottom: 12,
    gap: 2,
    left: 12,
    maxWidth: '86%',
    paddingHorizontal: 12,
    paddingVertical: 9,
    position: 'absolute',
  },
  sceneBadgePrimary: {
    color: '#f8fafc',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
  },
  sceneBadgeSecondary: {
    color: '#cbd5e1',
    fontSize: 12,
  },
  box: {
    borderColor: '#22d3ee',
    borderRadius: 6,
    borderWidth: 2,
    position: 'absolute',
  },
  boxLabel: {
    alignSelf: 'flex-start',
    backgroundColor: '#22d3ee',
    borderBottomRightRadius: 5,
    color: '#031014',
    fontSize: 10,
    fontWeight: '800',
    maxWidth: 150,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  controls: {
    alignSelf: 'stretch',
    gap: 14,
    paddingHorizontal: 16,
  },
  pickerHost: {
    alignSelf: 'stretch',
    height: 34,
  },
  detections: {
    gap: 10,
    paddingTop: 2,
  },
  detectionRow: {
    gap: 5,
  },
  detectionText: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  detectionName: {
    color: '#dbeafe',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  detectionValue: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  barTrack: {
    backgroundColor: 'rgba(148, 163, 184, 0.20)',
    borderRadius: 999,
    height: 6,
    overflow: 'hidden',
  },
  barFill: {
    backgroundColor: '#38bdf8',
    borderRadius: 999,
    height: '100%',
  },
  hud: {
    alignSelf: 'stretch',
    gap: 4,
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  hudText: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  hudSub: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 11,
  },
  hudError: {
    color: '#fca5a5',
    fontFamily: 'Menlo',
    fontSize: 11,
  },
});
