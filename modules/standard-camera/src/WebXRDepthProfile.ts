// @ref LLP 0014#conformance-model - Repo-local WebXR-shaped research profile.
// This is not a browser-compatible WebXR runtime; it implements only the
// camera/depth subset needed by the LiDAR WebGPU demo.

import 'event-target-polyfill';

import { DOMException } from './DOMException';
import NativeStandardCamera, {
  type NativeLiDARDepthCapabilities,
  type NativeLiDARDepthFrame,
  type NativeLiDARDepthFramePayload,
  type NativeLiDARDepthSessionEvent,
  type NativeWebXRMesh,
  type NativeWebXRMeshSummary,
} from './native';

export type WebXRSessionMode = 'immersive-ar';
export type WebXRReferenceSpaceType = 'viewer' | 'local';
export type WebXRFeatureDescriptor = 'depth-sensing' | 'camera-access' | 'mesh-detection';
export type WebXRDepthType = 'raw' | 'smooth';
export type WebXRDepthUsage = 'cpu-optimized';
export type WebXRDepthDataFormat = 'float32';
export type WebXRDepthConfidencePreference = 'default' | 'low';
export type WebXRCameraUsage = 'cpu-optimized';
export type WebXRCameraFormat = 'rgba8unorm' | 'bgra8unorm';

export interface WebXRSessionInit {
  requiredFeatures?: WebXRFeatureDescriptor[];
  optionalFeatures?: WebXRFeatureDescriptor[];
  depthSensing?: WebXRDepthStateInit;
  cameraAccess?: WebXRCameraAccessStateInit;
}

export interface WebXRDepthStateInit {
  usagePreference: WebXRDepthUsage[];
  dataFormatPreference: WebXRDepthDataFormat[];
  depthTypeRequest?: WebXRDepthType[];
  confidencePreference?: WebXRDepthConfidencePreference;
  matchDepthView?: boolean;
}

export interface WebXRCameraAccessStateInit {
  usagePreference: WebXRCameraUsage[];
  formatPreference: WebXRCameraFormat[];
  matchCameraView?: boolean;
}

export type WebXRFrameRequestCallback = (time: DOMHighResTimeStamp, frame: WebXRFrame) => void;

type CameraLockHandlers = {
  lockExternal: () => Promise<void>;
  unlockExternal: () => void;
};

type XRNavigator = Navigator & { xr?: WebXRSystem };

declare global {
  interface Navigator {
    xr?: WebXRSystem;
  }
}

const INSTALLED_SYMBOL = Symbol.for('standard-camera.webxr-depth.installed');
const CAMERA_LOCK_HANDLERS_TIMEOUT_MS = 500;
const TRANSIENT_ACTIVATION_MS = 900;
let transientActivationUntil = 0;
let nextAnimationFrameHandle = 1;
let activeImmersiveSession: WebXRSession | null = null;
let immersiveSessionRequestInFlight = false;
let cameraLockHandlers: CameraLockHandlers | null = null;
let cameraLockHandlerWaiters: Array<{
  resolve: (handlers: CameraLockHandlers) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];
const trackedMeshCacheBySession = new WeakMap<WebXRSession, Map<string, WebXRMesh>>();

const IDENTITY_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const CAMERA_FRAME = Symbol('standard-camera.webxr.camera-frame');
const WEBXR_FRAME_NATIVE = new WeakMap<object, NativeLiDARDepthFrame>();

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function unsupported(message: string): DOMException {
  return new DOMException(message, 'NotSupportedError');
}

function invalidState(message: string): DOMException {
  return new DOMException(message, 'InvalidStateError');
}

function rethrowNativeXRStartError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (/denied|restricted|not.?authorized|permission/i.test(message)) {
    throw new DOMException(message, 'NotAllowedError');
  }
  throw new DOMException(message, 'NotSupportedError');
}

function hasTransientActivation(): boolean {
  return now() <= transientActivationUntil;
}

function setTransientActivation(): void {
  transientActivationUntil = now() + TRANSIENT_ACTIVATION_MS;
}

function identityTransform(): WebXRRigidTransform {
  return new WebXRRigidTransform(IDENTITY_MATRIX);
}

function nativeFrameFor(frame: object): NativeLiDARDepthFrame {
  const nativeFrame = WEBXR_FRAME_NATIVE.get(frame);
  if (!nativeFrame) {
    throw invalidState('XRFrame native data is unavailable');
  }
  return nativeFrame;
}

// @ref LLP 0014#xr-viewer-pose — `getViewerPose()` returns null when the
// native tracking system cannot provide an ARKit camera pose. Startup frames
// can still carry usable scene depth while ARKit reports limited tracking or
// non-mapped world mapping, so those states remain internal diagnostics rather
// than a hard app-facing pose failure.
function canReportViewerPose(nativeFrame: NativeLiDARDepthFrame): boolean {
  const trackingState = nativeFrame.trackingState;
  return trackingState == null || trackingState === 'normal' || trackingState === 'limited';
}

function matrixFromNative(values: readonly number[] | undefined): Float32Array {
  if (!values || values.length !== 16) {
    return new Float32Array(IDENTITY_MATRIX);
  }
  return new Float32Array(values);
}

function transformFromNative(values: readonly number[] | undefined): WebXRRigidTransform {
  return new WebXRRigidTransform(matrixFromNative(values));
}

function invertMatrix4(input: Float32Array): Float32Array | null {
  const a: number[] = new Array(16);
  const inv: number[] = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      a[row * 4 + col] = input[col * 4 + row];
    }
    inv[row * 4 + row] = 1;
  }

  for (let col = 0; col < 4; col += 1) {
    let pivotRow = col;
    let pivotSize = Math.abs(a[pivotRow * 4 + col]);
    for (let row = col + 1; row < 4; row += 1) {
      const size = Math.abs(a[row * 4 + col]);
      if (size > pivotSize) {
        pivotRow = row;
        pivotSize = size;
      }
    }
    if (pivotSize < 1e-8) return null;
    if (pivotRow !== col) {
      for (let i = 0; i < 4; i += 1) {
        [a[col * 4 + i], a[pivotRow * 4 + i]] = [a[pivotRow * 4 + i], a[col * 4 + i]];
        [inv[col * 4 + i], inv[pivotRow * 4 + i]] = [inv[pivotRow * 4 + i], inv[col * 4 + i]];
      }
    }

    const pivot = a[col * 4 + col];
    for (let i = 0; i < 4; i += 1) {
      a[col * 4 + i] /= pivot;
      inv[col * 4 + i] /= pivot;
    }
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = a[row * 4 + col];
      for (let i = 0; i < 4; i += 1) {
        a[row * 4 + i] -= factor * a[col * 4 + i];
        inv[row * 4 + i] -= factor * inv[col * 4 + i];
      }
    }
  }

  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col * 4 + row] = inv[row * 4 + col];
    }
  }
  return out;
}

function transformNormalizedPoint(
  transform: WebXRRigidTransform,
  x: number,
  y: number
): { x: number; y: number } {
  // @ref LLP 0014#xr-depth-information — `getDepthInMeters()` samples after
  // applying the native normalized-view to normalized-depth transform.
  const m = transform.matrix;
  const tx = m[0] * x + m[4] * y + m[12];
  const ty = m[1] * x + m[5] * y + m[13];
  const tw = m[3] * x + m[7] * y + m[15];
  if (tw !== 0 && tw !== 1) {
    return { x: tx / tw, y: ty / tw };
  }
  return { x: tx, y: ty };
}

function assertNormalizedInputCoordinate(value: number, axis: 'x' | 'y'): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${axis} must be between 0 and 1`);
  }
}

function normalizedDepthCoordinateToIndex(value: number, size: number): number {
  if (!Number.isFinite(value) || size <= 0) return 0;
  const max = Math.max(0, size - 1);
  const index = Math.trunc(value * size);
  return Math.min(max, Math.max(0, index));
}

function selectedDepthType(caps: NativeLiDARDepthCapabilities, request?: WebXRDepthType[]): WebXRDepthType | null {
  const preferred = request && request.length > 0 ? request : ['smooth', 'raw'];
  for (const type of preferred) {
    if (type === 'smooth' && caps.smoothedSceneDepth) return 'smooth';
    if (type === 'raw' && caps.sceneDepth) return 'raw';
  }
  return null;
}

function validateRequiredFeatures(features: WebXRFeatureDescriptor[] | undefined): Set<WebXRFeatureDescriptor> {
  const out = new Set<WebXRFeatureDescriptor>();
  for (const feature of features ?? []) {
    if (feature !== 'depth-sensing' && feature !== 'camera-access' && feature !== 'mesh-detection') {
      throw unsupported(`Unsupported XR feature: ${String(feature)}`);
    }
    out.add(feature);
  }
  return out;
}

function collectKnownOptionalFeatures(features: WebXRFeatureDescriptor[] | undefined): Set<WebXRFeatureDescriptor> {
  const out = new Set<WebXRFeatureDescriptor>();
  for (const feature of features ?? []) {
    if (feature === 'depth-sensing' || feature === 'camera-access' || feature === 'mesh-detection') {
      out.add(feature);
    }
  }
  return out;
}

function validateDepthInit(enabled: boolean, required: boolean, init: WebXRDepthStateInit | undefined): void {
  if (!enabled) return;
  if (!init) {
    if (required) {
      throw unsupported('depthSensing is required when "depth-sensing" is requested');
    }
    return;
  }
  if (!init.usagePreference.includes('cpu-optimized')) {
    throw unsupported('Only cpu-optimized depth sensing is supported');
  }
  if (!init.dataFormatPreference.includes('float32')) {
    throw unsupported('Only float32 depth data is supported');
  }
  if (
    init.confidencePreference != null &&
    init.confidencePreference !== 'default' &&
    init.confidencePreference !== 'low'
  ) {
    throw unsupported(`Unsupported depth confidence preference: ${String(init.confidencePreference)}`);
  }
  for (const type of init.depthTypeRequest ?? []) {
    if (type !== 'smooth' && type !== 'raw') {
      throw unsupported(`Unsupported depth type: ${String(type)}`);
    }
  }
  if (init.matchDepthView === false) {
    throw unsupported('matchDepthView=false is not supported');
  }
}

function validateCameraInit(enabled: boolean, required: boolean, init: WebXRCameraAccessStateInit | undefined): void {
  if (!enabled) return;
  if (!init) {
    if (required) {
      throw unsupported('cameraAccess is required when "camera-access" is requested');
    }
    return;
  }
  if (!init.usagePreference.includes('cpu-optimized')) {
    throw unsupported('Only cpu-optimized camera access is supported');
  }
  if (!init.formatPreference.some((format) => format === 'rgba8unorm' || format === 'bgra8unorm')) {
    throw unsupported('Only rgba8unorm or bgra8unorm camera formats are supported');
  }
  if (init.matchCameraView === false) {
    throw unsupported('matchCameraView=false is not supported');
  }
}

function selectedCameraFormat(init: WebXRCameraAccessStateInit | undefined): WebXRCameraFormat {
  for (const format of init?.formatPreference ?? []) {
    if (format === 'bgra8unorm' || format === 'rgba8unorm') {
      return format;
    }
  }
  return 'bgra8unorm';
}

function bgraToRgba(src: Uint8Array): Uint8Array {
  const dst = new Uint8Array(src.byteLength);
  for (let i = 0; i < src.byteLength; i += 4) {
    dst[i] = src[i + 2] ?? 0;
    dst[i + 1] = src[i + 1] ?? 0;
    dst[i + 2] = src[i] ?? 0;
    dst[i + 3] = src[i + 3] ?? 255;
  }
  return dst;
}

// @ref LLP 0014#xr-request-session - `requestSession()` must stop/suspend any
// active `getUserMedia` stream through the same external-lock mechanism used
// by the LiDAR native sidecar.
export function setWebXRDepthCameraLockHandlers(handlers: CameraLockHandlers | null): void {
  cameraLockHandlers = handlers;
  if (!handlers) return;
  const waiters = cameraLockHandlerWaiters;
  cameraLockHandlerWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(handlers);
  }
}

// React Native has no browser `navigator.userActivation`, so the demo's press
// handler wraps the `requestSession()` call in this transient activation token.
// @ref LLP 0014#xr-request-session
export function runWithWebXRUserActivation<T>(callback: () => T): T {
  setTransientActivation();
  return callback();
}

function waitForCameraLockHandlers(): Promise<CameraLockHandlers> {
  if (cameraLockHandlers) {
    return Promise.resolve(cameraLockHandlers);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        cameraLockHandlerWaiters = cameraLockHandlerWaiters.filter((entry) => entry !== waiter);
        reject(invalidState('WebXR camera ownership lock is not installed'));
      }, CAMERA_LOCK_HANDLERS_TIMEOUT_MS),
    };
    cameraLockHandlerWaiters.push(waiter);
  });
}

// @ref LLP 0014#xr-install
export function installWebXRDepthProfile(): void {
  const g = globalThis as unknown as Record<string | symbol, unknown>;
  if (g[INSTALLED_SYMBOL]) return;

  if (g.navigator == null) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  const nav = (globalThis.navigator ?? {}) as XRNavigator;
  if (nav.xr) {
    throw new Error('navigator.xr is already installed by another runtime');
  }

  Object.defineProperty(nav, 'xr', {
    value: new WebXRSystem(),
    writable: false,
    configurable: true,
    enumerable: true,
  });
  g[INSTALLED_SYMBOL] = true;
}

export class WebXRSystem extends EventTarget {
  // @ref LLP 0014#xr-is-session-supported
  async isSessionSupported(mode: string): Promise<boolean> {
    if (mode !== 'immersive-ar') {
      return false;
    }
    const caps = NativeStandardCamera.getLiDARDepthCapabilities();
    return caps.supported === true;
  }

  // @ref LLP 0014#xr-request-session
  async requestSession(mode: string, options: WebXRSessionInit = {}): Promise<WebXRSession> {
    if (mode !== 'immersive-ar') {
      throw unsupported('Only immersive-ar sessions are supported');
    }
    if (!hasTransientActivation()) {
      throw new DOMException('XR session requests require user activation', 'SecurityError');
    }
    if (activeImmersiveSession && !activeImmersiveSession.ended) {
      throw invalidState('An immersive-ar session is already active');
    }
    if (immersiveSessionRequestInFlight) {
      throw invalidState('An immersive-ar session is already starting');
    }

    const requiredFeatures = validateRequiredFeatures(options.requiredFeatures);
    const optionalFeatures = collectKnownOptionalFeatures(options.optionalFeatures);
    const wantsDepth = requiredFeatures.has('depth-sensing') ||
      (optionalFeatures.has('depth-sensing') && options.depthSensing != null);
    const wantsCamera = requiredFeatures.has('camera-access') ||
      (optionalFeatures.has('camera-access') && options.cameraAccess != null);
    const wantsMeshRequest = requiredFeatures.has('mesh-detection') || optionalFeatures.has('mesh-detection');
    validateDepthInit(wantsDepth, requiredFeatures.has('depth-sensing'), options.depthSensing);
    validateCameraInit(wantsCamera, requiredFeatures.has('camera-access'), options.cameraAccess);

    const caps = NativeStandardCamera.getLiDARDepthCapabilities();
    if (!caps.supported) {
      throw unsupported(caps.reason ?? 'LiDAR scene depth is unavailable');
    }
    const wantsMesh = caps.meshDetection === true && wantsMeshRequest;
    if (requiredFeatures.has('mesh-detection') && !wantsMesh) {
      throw unsupported('WebXR mesh-detection is unavailable');
    }
    if (!wantsDepth && !wantsCamera && !wantsMesh) {
      throw unsupported('This profile requires depth-sensing, camera-access, or mesh-detection');
    }

    // @ref LLP 0014#xr-request-session — Pick one supported observable
    // depth type before starting ARKit so native semantics and session.depthType match.
    const depthType = wantsDepth ? selectedDepthType(caps, options.depthSensing?.depthTypeRequest) : null;
    // @ref LLP 0014#xr-depth-confidence — Visual inspection sessions may
    // preserve low-confidence positive depth without exposing confidence maps.
    const lowConfidenceDepthEnabled = wantsDepth && options.depthSensing?.confidencePreference === 'low';
    if (wantsDepth && !depthType) {
      throw unsupported('Requested depth type is unavailable');
    }
    immersiveSessionRequestInFlight = true;
    let locked = false;
    let lockHandlers: CameraLockHandlers | null = null;
    let started: NativeLiDARDepthCapabilities | null = null;
    try {
      // @ref LLP 0014#xr-request-session - Cold-start autorun can reach a
      // child route's WebXR session effect before CameraProvider's passive
      // effect installs the shared AVFoundation handoff. Wait briefly rather
      // than starting ARKit without owning the camera lock.
      lockHandlers = await waitForCameraLockHandlers();
      await lockHandlers.lockExternal();
      locked = true;
      started = await NativeStandardCamera.startWebXRLiDARDepthAsync(depthType ?? '', wantsMesh);
    } catch (e) {
      immersiveSessionRequestInFlight = false;
      if (locked && lockHandlers) {
        lockHandlers.unlockExternal();
      }
      if (e instanceof DOMException) {
        throw e;
      }
      rethrowNativeXRStartError(e);
    }
    immersiveSessionRequestInFlight = false;

    const session = new WebXRSession({
      cameraLockHandlers: lockHandlers,
      cameraAccessEnabled: wantsCamera,
      cameraFormat: wantsCamera ? selectedCameraFormat(options.cameraAccess) : 'bgra8unorm',
      depthEnabled: wantsDepth,
      lowConfidenceDepthEnabled,
      depthType: wantsDepth ? (started.depthType ?? depthType) : null,
      meshDetectionEnabled: wantsMesh,
      sessionId: started.sessionId ?? null,
    });
    activeImmersiveSession = session;
    return session;
  }
}

type WebXRSessionConfig = {
  cameraLockHandlers?: CameraLockHandlers | null;
  cameraAccessEnabled: boolean;
  cameraFormat: WebXRCameraFormat;
  depthEnabled: boolean;
  lowConfidenceDepthEnabled?: boolean;
  depthType: WebXRDepthType | null;
  meshDetectionEnabled: boolean;
  sessionId: number | null;
};

type ScheduledXRCallback = {
  cancelled: boolean;
  rafId: number | null;
};

type NativePayloadRequest = {
  includeCameraImage: boolean;
  includeDepthData: boolean;
  includeLowConfidenceDepthData?: boolean;
};

// @ref LLP 0014#xr-session
export class WebXRSession extends EventTarget {
  #cameraAccessEnabled: boolean;
  #cameraFormat: WebXRCameraFormat;
  #cameraLockHandlers: CameraLockHandlers | null;
  #depthEnabled: boolean;
  #lowConfidenceDepthEnabled: boolean;
  #depthType: WebXRDepthType | null;
  #meshDetectionEnabled: boolean;
  #sessionId: number | null;
  #depthActive = true;
  #ended = false;
  #callbacks = new Map<number, ScheduledXRCallback>();
  #lastDeliveredFrameNumber = 0;
  #nativeTimestampOriginMs: number | null = null;
  #domTimestampOriginMs: number | null = null;
  #endDispatched = false;
  #nativeStateSubscription: { remove(): void } | null = null;

  constructor(config: WebXRSessionConfig) {
    super();
    this.#cameraAccessEnabled = config.cameraAccessEnabled;
    this.#cameraFormat = config.cameraFormat;
    this.#cameraLockHandlers = config.cameraLockHandlers ?? cameraLockHandlers;
    this.#depthEnabled = config.depthEnabled;
    this.#lowConfidenceDepthEnabled = config.lowConfidenceDepthEnabled === true;
    this.#depthType = config.depthType;
    this.#meshDetectionEnabled = config.meshDetectionEnabled;
    this.#sessionId = config.sessionId;
    this.#nativeStateSubscription = NativeStandardCamera.addListener(
      'onLiDARDepthSessionState',
      (event) => this.#handleNativeSessionState(event)
    );
  }

  get ended(): boolean {
    return this.#ended;
  }

  get depthActive(): boolean {
    if (!this.#depthEnabled) {
      throw invalidState('depth-sensing was not enabled for this XRSession');
    }
    return this.#depthActive;
  }

  get depthUsage(): WebXRDepthUsage {
    if (!this.#depthEnabled) {
      throw invalidState('depth-sensing was not enabled for this XRSession');
    }
    return 'cpu-optimized';
  }

  get depthDataFormat(): WebXRDepthDataFormat {
    if (!this.#depthEnabled) {
      throw invalidState('depth-sensing was not enabled for this XRSession');
    }
    return 'float32';
  }

  get depthType(): WebXRDepthType | null {
    if (!this.#depthEnabled) {
      throw invalidState('depth-sensing was not enabled for this XRSession');
    }
    return this.#depthType;
  }

  get cameraUsage(): WebXRCameraUsage {
    if (!this.#cameraAccessEnabled) {
      throw invalidState('camera-access was not enabled for this XRSession');
    }
    return 'cpu-optimized';
  }

  get cameraFormat(): WebXRCameraFormat {
    if (!this.#cameraAccessEnabled) {
      throw invalidState('camera-access was not enabled for this XRSession');
    }
    return this.#cameraFormat;
  }

  get cameraAccessActive(): boolean {
    if (!this.#cameraAccessEnabled) {
      throw invalidState('camera-access was not enabled for this XRSession');
    }
    return !this.#ended;
  }

  hasDepthAccess(): boolean {
    return this.#depthEnabled;
  }

  usesLowConfidenceDepth(): boolean {
    return this.#lowConfidenceDepthEnabled;
  }

  hasCameraAccess(): boolean {
    return this.#cameraAccessEnabled;
  }

  hasMeshDetection(): boolean {
    return this.#meshDetectionEnabled;
  }

  isDepthActiveForFrame(): boolean {
    return this.#depthEnabled && this.#depthActive && !this.#ended;
  }

  frameTime(nativeFrame: NativeLiDARDepthFrame, fallback: DOMHighResTimeStamp): DOMHighResTimeStamp {
    // @ref LLP 0014#xr-frame-loop — The callback time follows the native AR
    // frame timestamp, shifted into the JS performance timeline.
    const nativeTimestampMs = typeof nativeFrame.timestamp === 'number' && Number.isFinite(nativeFrame.timestamp)
      ? nativeFrame.timestamp * 1000
      : null;
    if (nativeTimestampMs === null) {
      return fallback;
    }
    if (this.#nativeTimestampOriginMs === null || this.#domTimestampOriginMs === null) {
      this.#nativeTimestampOriginMs = nativeTimestampMs;
      this.#domTimestampOriginMs = fallback;
    }
    return this.#domTimestampOriginMs + nativeTimestampMs - this.#nativeTimestampOriginMs;
  }

  #handleNativeSessionState(event: NativeLiDARDepthSessionEvent): void {
    if (this.#ended) return;
    if (this.#sessionId !== null && event.sessionId !== this.#sessionId) return;
    if (event.state === 'interrupted') {
      this.#depthActive = false;
      return;
    }
    if (event.state === 'running') {
      if (this.#depthEnabled) {
        this.#depthActive = true;
      }
      return;
    }
    if (event.state === 'failed' || event.state === 'stopped') {
      this.#finishEnd();
    }
  }

  // @ref LLP 0014#xr-reference-space
  async requestReferenceSpace(type: string): Promise<WebXRReferenceSpace> {
    if (this.#ended) {
      throw invalidState('XRSession has ended');
    }
    if (type !== 'viewer' && type !== 'local') {
      throw unsupported('Only viewer and local reference spaces are supported');
    }
    return new WebXRReferenceSpace(this, type);
  }

  // @ref LLP 0014#xr-frame-loop
  requestAnimationFrame(callback: WebXRFrameRequestCallback): number {
    if (this.#ended) {
      throw invalidState('XRSession has ended');
    }
    const handle = nextAnimationFrameHandle++;
    const scheduled: ScheduledXRCallback = {
      cancelled: false,
      rafId: null,
    };
    this.#callbacks.set(handle, scheduled);

    const pump = (): void => {
      if (this.#ended || scheduled.cancelled) {
        this.#callbacks.delete(handle);
        return;
      }
      // @ref LLP 0014#xr-camera-resolution - The WebXR profile owns this
      // CPU-visible camera image size as a private implementation detail.
      let nativeFrame: NativeLiDARDepthFrame | null = null;
      try {
        nativeFrame = NativeStandardCamera.getLatestWebXRLiDARDepthFrame();
      } catch {
        scheduled.rafId = globalThis.requestAnimationFrame(pump);
        return;
      }
      if (!nativeFrame) {
        scheduled.rafId = globalThis.requestAnimationFrame(pump);
        return;
      }
      if (nativeFrame.frameNumber <= this.#lastDeliveredFrameNumber) {
        scheduled.rafId = globalThis.requestAnimationFrame(pump);
        return;
      }

      this.#lastDeliveredFrameNumber = nativeFrame.frameNumber;
      this.#callbacks.delete(handle);
      const time = this.frameTime(nativeFrame, now());
      const frame = new WebXRFrame(this, nativeFrame, time);
      try {
        callback(time, frame);
      } finally {
        frame.deactivate();
      }
    };

    scheduled.rafId = globalThis.requestAnimationFrame(pump);
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    const scheduled = this.#callbacks.get(handle);
    if (!scheduled) return;
    scheduled.cancelled = true;
    if (scheduled.rafId !== null) {
      globalThis.cancelAnimationFrame(scheduled.rafId);
    }
    this.#callbacks.delete(handle);
  }

  pauseDepthSensing(): void {
    if (!this.#depthEnabled) {
      throw invalidState('depth-sensing was not enabled for this XRSession');
    }
    this.#depthActive = false;
  }

  resumeDepthSensing(): void {
    if (!this.#depthEnabled) {
      throw invalidState('depth-sensing was not enabled for this XRSession');
    }
    if (!this.#ended) {
      this.#depthActive = true;
    }
  }

  async end(): Promise<void> {
    if (!this.#beginEnd()) return;
    try {
      // @ref LLP 0013#camera-ownership-handoff — Keep the external camera
      // lock until native ARKit pause has resolved. Clearing it earlier lets
      // focused standard-camera routes reopen AVFoundation while ARKit is
      // still winding down, which can starve the next WebXR frame pump.
      await NativeStandardCamera.stopLiDARDepthAsync();
    } finally {
      this.#finishEnd();
    }
  }

  #beginEnd(): boolean {
    if (this.#ended) return false;
    this.#ended = true;
    for (const handle of [...this.#callbacks.keys()]) {
      this.cancelAnimationFrame(handle);
    }
    this.#nativeStateSubscription?.remove();
    this.#nativeStateSubscription = null;
    if (activeImmersiveSession === this) {
      activeImmersiveSession = null;
    }
    return true;
  }

  #finishEnd(): boolean {
    if (!this.#ended) {
      this.#beginEnd();
    }
    if (this.#endDispatched) return false;
    this.#endDispatched = true;
    this.#cameraLockHandlers?.unlockExternal();
    this.dispatchEvent(new Event('end'));
    return true;
  }
}

export class WebXRReferenceSpace extends EventTarget {
  readonly session: WebXRSession;
  readonly type: WebXRReferenceSpaceType;

  constructor(session: WebXRSession, type: WebXRReferenceSpaceType) {
    super();
    this.session = session;
    this.type = type;
  }
}

export class WebXRPose {
  readonly transform: WebXRRigidTransform;

  constructor(transform: WebXRRigidTransform) {
    this.transform = transform;
  }
}

export class WebXRMeshSpace extends EventTarget {
  readonly session: WebXRSession;
  #transform: WebXRRigidTransform;

  constructor(session: WebXRSession, transform: WebXRRigidTransform) {
    super();
    this.session = session;
    this.#transform = transform;
  }

  get transform(): WebXRRigidTransform {
    return this.#transform;
  }

  updateTransform(transform: WebXRRigidTransform): void {
    this.#transform = transform;
  }
}

export class WebXRMesh {
  #frame: WebXRFrame;
  readonly #id: string;
  #nativeMesh: NativeWebXRMesh | null;
  #indices: Uint32Array | null = null;
  #lastChangedTime: DOMHighResTimeStamp;
  #normals: Float32Array | null | undefined;
  #semanticLabel: string | null;
  #vertices: Float32Array | null = null;
  readonly meshSpace: WebXRMeshSpace;

  constructor(
    session: WebXRSession,
    frame: WebXRFrame,
    nativeSummary: NativeWebXRMeshSummary,
    nativeMesh: NativeWebXRMesh | null = null
  ) {
    const transform = transformFromNative(nativeSummary.transform);
    this.#frame = frame;
    this.#id = nativeSummary.id;
    this.#nativeMesh = nativeMesh;
    this.meshSpace = new WebXRMeshSpace(session, transform);
    this.#lastChangedTime = nativeSummary.lastChangedTime;
    this.#semanticLabel = nativeSummary.semanticLabel ?? null;
  }

  get lastChangedTime(): DOMHighResTimeStamp {
    return this.#lastChangedTime;
  }

  get semanticLabel(): string | null {
    return this.#semanticLabel;
  }

  updateFromNativeFrame(
    frame: WebXRFrame,
    nativeSummary: NativeWebXRMeshSummary,
    nativeMesh: NativeWebXRMesh | null = null
  ): void {
    const changed = nativeSummary.lastChangedTime !== this.#lastChangedTime;
    this.#frame = frame;
    this.#nativeMesh = nativeMesh;
    this.#semanticLabel = nativeSummary.semanticLabel ?? null;
    this.meshSpace.updateTransform(transformFromNative(nativeSummary.transform));
    if (changed) {
      this.#indices = null;
      this.#normals = undefined;
      this.#vertices = null;
      this.#lastChangedTime = nativeSummary.lastChangedTime;
    }
  }

  get vertices(): Float32Array {
    this.#vertices ??= new Float32Array(exactArrayBuffer(this.#nativePayload()?.vertices ?? new Uint8Array()));
    return this.#vertices;
  }

  get indices(): Uint32Array {
    this.#indices ??= new Uint32Array(exactArrayBuffer(this.#nativePayload()?.indices ?? new Uint8Array()));
    return this.#indices;
  }

  get normals(): Float32Array | null {
    if (this.#normals !== undefined) return this.#normals;
    const normals = this.#nativePayload()?.normals;
    this.#normals = normals ? new Float32Array(exactArrayBuffer(normals)) : null;
    return this.#normals;
  }

  #nativePayload(): NativeWebXRMesh | null {
    if (this.#nativeMesh) return this.#nativeMesh;
    this.#nativeMesh = this.#frame.nativeMeshById(this.#id);
    return this.#nativeMesh;
  }
}

export class WebXRMeshSet implements Iterable<WebXRMesh> {
  readonly #meshes: readonly WebXRMesh[];
  static readonly #empty = new WebXRMeshSet([]);

  private constructor(meshes: readonly WebXRMesh[]) {
    this.#meshes = meshes;
  }

  static empty(): WebXRMeshSet {
    return WebXRMeshSet.#empty;
  }

  static fromTrackedMeshes(meshes: readonly WebXRMesh[]): WebXRMeshSet {
    if (meshes.length === 0) return WebXRMeshSet.empty();
    return new WebXRMeshSet(meshes);
  }

  static fromNative(session: WebXRSession, frame: WebXRFrame, nativeMeshes: readonly NativeWebXRMesh[]): WebXRMeshSet {
    return trackedMeshSetFromNative(session, frame, nativeMeshes, true);
  }

  static fromNativeSummaries(
    session: WebXRSession,
    frame: WebXRFrame,
    nativeMeshes: readonly NativeWebXRMeshSummary[]
  ): WebXRMeshSet {
    return trackedMeshSetFromNative(session, frame, nativeMeshes, false);
  }

  get size(): number {
    return this.#meshes.length;
  }

  has(mesh: WebXRMesh): boolean {
    return this.#meshes.includes(mesh);
  }

  values(): IterableIterator<WebXRMesh> {
    return this.#meshes[Symbol.iterator]();
  }

  keys(): IterableIterator<WebXRMesh> {
    return this.values();
  }

  entries(): IterableIterator<[WebXRMesh, WebXRMesh]> {
    return this.#meshes.map((mesh): [WebXRMesh, WebXRMesh] => [mesh, mesh])[Symbol.iterator]();
  }

  forEach(callback: (value: WebXRMesh, key: WebXRMesh, parent: WebXRMeshSet) => void): void {
    for (const mesh of this.#meshes) {
      callback(mesh, mesh, this);
    }
  }

  [Symbol.iterator](): IterableIterator<WebXRMesh> {
    return this.values();
  }
}

function trackedMeshSetFromNative(
  session: WebXRSession,
  frame: WebXRFrame,
  nativeMeshes: readonly NativeWebXRMeshSummary[],
  includesPayload: boolean
): WebXRMeshSet {
  if (nativeMeshes.length === 0) {
    trackedMeshCacheBySession.get(session)?.clear();
    return WebXRMeshSet.empty();
  }
  let cache = trackedMeshCacheBySession.get(session);
  if (!cache) {
    cache = new Map();
    trackedMeshCacheBySession.set(session, cache);
  }
  const seenIds = new Set<string>();
  const meshes = nativeMeshes.map((nativeMesh) => {
    seenIds.add(nativeMesh.id);
    const payload = includesPayload ? nativeMesh as NativeWebXRMesh : null;
    let mesh = cache.get(nativeMesh.id);
    if (mesh) {
      // @ref LLP 0014#xr-mesh-detection — WebXR Mesh Detection tracks native
      // mesh identity across frames. Reuse the XRMesh object and its SameObject
      // meshSpace while refreshing the current-frame pose and geometry snapshot.
      mesh.updateFromNativeFrame(frame, nativeMesh, payload);
    } else {
      mesh = new WebXRMesh(session, frame, nativeMesh, payload);
      cache.set(nativeMesh.id, mesh);
    }
    return mesh;
  });
  for (const id of cache.keys()) {
    if (!seenIds.has(id)) {
      cache.delete(id);
    }
  }
  return WebXRMeshSet.fromTrackedMeshes(meshes);
}

// @ref LLP 0014#idl-surface — XRRigidTransform from the IDL surface
export class WebXRRigidTransform {
  readonly matrix: Float32Array;
  readonly inverse: WebXRRigidTransform;

  constructor(matrix: Float32Array = IDENTITY_MATRIX, inverse?: WebXRRigidTransform) {
    this.matrix = new Float32Array(matrix);
    if (inverse) {
      this.inverse = inverse;
      return;
    }
    const inverseMatrix = invertMatrix4(this.matrix);
    this.inverse = inverseMatrix ? new WebXRRigidTransform(inverseMatrix, this) : this;
  }
}

// @ref LLP 0014#xr-frame-loop
export class WebXRFrame {
  readonly session: WebXRSession;
  readonly predictedDisplayTime: DOMHighResTimeStamp;
  #active = true;
  #detectedMeshes: WebXRMeshSet | null = null;
  #depthInformation = new WeakMap<WebXRView, WebXRCPUDepthInformation>();
  #depthData: Uint8Array | null = null;
  #cameraData: Uint8Array | null = null;
  #cameraDataFormat: 'bgra8unorm' | null = null;
  #nativeMeshPayloads: readonly NativeWebXRMesh[] | null = null;

  constructor(session: WebXRSession, nativeFrame: NativeLiDARDepthFrame, time: DOMHighResTimeStamp) {
    this.session = session;
    WEBXR_FRAME_NATIVE.set(this, nativeFrame);
    this.predictedDisplayTime = time;
  }

  assertActive(): void {
    if (!this.#active || this.session.ended) {
      throw invalidState('XRFrame is no longer active');
    }
  }

  deactivate(): void {
    this.#active = false;
  }

  nativeDepthData(): Uint8Array | null {
    this.assertActive();
    if (this.#depthData) return this.#depthData;
    const nativeFrame = nativeFrameFor(this);
    // @ref LLP 0014#xr-depth-confidence — The native bridge keeps ARKit's
    // confidence map internal while honoring the session confidence preference.
    const payload = requestNativeFramePayload(nativeFrame, {
      includeCameraImage: false,
      includeDepthData: true,
      includeLowConfidenceDepthData: typeof this.session.usesLowConfidenceDepth === 'function'
        ? this.session.usesLowConfidenceDepth()
        : false,
    });
    this.#depthData = payload?.depthData ?? null;
    return this.#depthData;
  }

  nativeCameraData(): { data: Uint8Array; format: 'bgra8unorm' } | null {
    this.assertActive();
    if (this.#cameraData && this.#cameraDataFormat) {
      return { data: this.#cameraData, format: this.#cameraDataFormat };
    }
    const nativeFrame = nativeFrameFor(this);
    const payload = requestNativeFramePayload(nativeFrame, {
      includeCameraImage: true,
      includeDepthData: false,
      includeLowConfidenceDepthData: false,
    });
    if (!payload?.colorData || payload.colorFormat !== 'bgra8unorm') {
      return null;
    }
    this.#cameraData = payload.colorData;
    this.#cameraDataFormat = payload.colorFormat;
    return { data: this.#cameraData, format: this.#cameraDataFormat };
  }

  nativeMeshById(id: string): NativeWebXRMesh | null {
    this.assertActive();
    return this.nativeMeshPayloads().find((mesh) => mesh.id === id) ?? null;
  }

  private nativeMeshPayloads(): readonly NativeWebXRMesh[] {
    if (this.#nativeMeshPayloads) {
      return this.#nativeMeshPayloads;
    }
    const nativeFrame = nativeFrameFor(this);
    const getMeshes = (
      NativeStandardCamera as typeof NativeStandardCamera & {
        getWebXRLiDARDepthFrameMeshes?: unknown;
      }
    ).getWebXRLiDARDepthFrameMeshes;
    if (typeof getMeshes !== 'function') {
      this.#nativeMeshPayloads = [];
      return this.#nativeMeshPayloads;
    }
    let nativeMeshes: readonly NativeWebXRMesh[];
    try {
      nativeMeshes = getMeshes.call(NativeStandardCamera, nativeFrame.frameNumber) ?? [];
    } catch {
      this.#nativeMeshPayloads = [];
      return this.#nativeMeshPayloads;
    }
    this.#nativeMeshPayloads = nativeMeshes;
    return this.#nativeMeshPayloads;
  }

  // @ref LLP 0014#xr-viewer-pose
  getViewerPose(referenceSpace: WebXRReferenceSpace): WebXRViewerPose | null {
    this.assertActive();
    if (referenceSpace.session !== this.session) {
      throw invalidState('XRReferenceSpace belongs to a different XRSession');
    }
    const nativeFrame = nativeFrameFor(this);
    if (!canReportViewerPose(nativeFrame)) {
      return null;
    }
    return new WebXRViewerPose([new WebXRView(this, referenceSpace)]);
  }

  // @ref LLP 0014#xr-depth-information
  getDepthInformation(view: WebXRView): WebXRCPUDepthInformation | null {
    this.assertActive();
    if (!this.session.hasDepthAccess()) {
      throw unsupported('depth-sensing was not enabled for this XRSession');
    }
    if (view.frame !== this) {
      throw invalidState('XRView belongs to a different XRFrame');
    }
    if (!this.session.isDepthActiveForFrame()) {
      return null;
    }
    let depthInformation = this.#depthInformation.get(view) ?? null;
    if (!depthInformation) {
      depthInformation = new WebXRCPUDepthInformation(this, view);
      this.#depthInformation.set(view, depthInformation);
    }
    return depthInformation;
  }

  // @ref LLP 0014#xr-mesh-detection — Real-world mesh access follows the
  // WebXR Mesh Detection draft's `XRFrame.detectedMeshes` shape. Native ARKit
  // mesh anchors remain hidden behind XRMesh objects and mesh spaces.
  get detectedMeshes(): WebXRMeshSet {
    this.assertActive();
    if (!this.session.hasMeshDetection()) {
      return WebXRMeshSet.empty();
    }
    if (!this.#detectedMeshes) {
      // @ref LLP 0014#xr-mesh-detection — `detectedMeshes` can be observed
      // through lightweight native mesh summaries. Full vertex/index buffers
      // are fetched only if app code reads standard XRMesh geometry fields.
      const nativeMeshSummaries = nativeFrameFor(this).detectedMeshes;
      this.#detectedMeshes = nativeMeshSummaries
        ? WebXRMeshSet.fromNativeSummaries(this.session, this, nativeMeshSummaries)
        : WebXRMeshSet.fromNative(this.session, this, this.nativeMeshPayloads());
    }
    return this.#detectedMeshes;
  }

  // @ref LLP 0014#xr-mesh-detection — Mesh poses are exposed through the
  // standard `getPose(space, baseSpace)` pattern instead of app-facing ARKit
  // anchor transforms.
  getPose(space: WebXRMeshSpace, baseSpace: WebXRReferenceSpace): WebXRPose | null {
    this.assertActive();
    if (space.session !== this.session || baseSpace.session !== this.session) {
      throw invalidState('XRSpace belongs to a different XRSession');
    }
    if (baseSpace.type !== 'local') {
      throw unsupported('Mesh poses are currently available only in local reference space');
    }
    return new WebXRPose(space.transform);
  }
}

function requestNativeFramePayload(
  frame: NativeLiDARDepthFrame,
  request: NativePayloadRequest
): NativeLiDARDepthFramePayload | null {
  const getPayloadWithOptions = (
    NativeStandardCamera as typeof NativeStandardCamera & {
      getWebXRLiDARDepthFramePayloadWithOptions?: unknown;
    }
  ).getWebXRLiDARDepthFramePayloadWithOptions;
  const getPayload = (
    NativeStandardCamera as typeof NativeStandardCamera & {
      getWebXRLiDARDepthFramePayload?: unknown;
    }
  ).getWebXRLiDARDepthFramePayload;
  if (typeof getPayload !== 'function') {
    return null;
  }

  let payload: NativeLiDARDepthFramePayload | null | undefined;
  try {
    if (request.includeLowConfidenceDepthData === true && typeof getPayloadWithOptions === 'function') {
      payload = getPayloadWithOptions.call(
        NativeStandardCamera,
        frame.frameNumber,
        request.includeDepthData,
        request.includeCameraImage,
        true
      );
    } else {
      payload = getPayload.call(
        NativeStandardCamera,
        frame.frameNumber,
        request.includeDepthData,
        request.includeCameraImage
      );
    }
  } catch {
    return null;
  }

  return payload ?? null;
}

export class WebXRViewerPose {
  readonly transform: WebXRRigidTransform;
  readonly views: readonly WebXRView[];

  constructor(views: readonly WebXRView[]) {
    this.views = views;
    // @ref LLP 0014#xr-viewer-pose — XRViewerPose is an XRPose for the
    // viewer. In this monocular phone profile, the single XRView carries the
    // same camera-to-reference-space transform.
    this.transform = views[0]?.transform ?? identityTransform();
  }
}

// @ref LLP 0014#xr-viewer-pose — single XRView, eye === "none"
export class WebXRView {
  readonly eye = 'none';
  readonly index = 0;
  readonly recommendedViewportScale = null;
  readonly transform: WebXRRigidTransform;
  readonly projectionMatrix: Float32Array;
  readonly frame: WebXRFrame;
  readonly referenceSpace: WebXRReferenceSpace;
  #camera: WebXRCamera | null | undefined;

  constructor(frame: WebXRFrame, referenceSpace: WebXRReferenceSpace) {
    this.frame = frame;
    this.referenceSpace = referenceSpace;
    const nativeFrame = nativeFrameFor(frame);
    // @ref LLP 0014#xr-viewer-pose — `local` exposes ARKit camera-to-world as
    // the viewer pose; `viewer` is the viewer-relative reference space.
    this.transform = referenceSpace.type === 'viewer'
      ? identityTransform()
      : transformFromNative(nativeFrame.viewTransform);
    this.projectionMatrix = matrixFromNative(nativeFrame.projectionMatrix);
  }

  // @ref LLP 0014#xr-camera-image
  get camera(): WebXRCamera | null {
    this.frame.assertActive();
    if (this.#camera !== undefined) {
      return this.#camera;
    }
    if (!this.frame.session.hasCameraAccess()) return null;
    const native = nativeFrameFor(this.frame);
    if (!native.colorWidth || !native.colorHeight) return null;
    this.#camera = new WebXRCamera(
      this.frame,
      native.colorWidth,
      native.colorHeight,
      this.frame.session.cameraFormat,
      transformFromNative(native.normCameraImageFromNormView)
    );
    return this.#camera;
  }
}

export class WebXRCamera {
  readonly width: number;
  readonly height: number;
  readonly format: WebXRCameraFormat;
  readonly normCameraImageFromNormView: WebXRRigidTransform;
  readonly [CAMERA_FRAME]: WebXRFrame;

  constructor(
    frame: WebXRFrame,
    width: number,
    height: number,
    format: WebXRCameraFormat,
    normCameraImageFromNormView: WebXRRigidTransform
  ) {
    this[CAMERA_FRAME] = frame;
    this.width = width;
    this.height = height;
    this.format = format;
    this.normCameraImageFromNormView = normCameraImageFromNormView;
  }
}

export class WebXRDepthInformation {
  readonly width: number;
  readonly height: number;
  readonly projectionMatrix: Float32Array;
  readonly transform: WebXRRigidTransform;
  readonly normDepthBufferFromNormView: WebXRRigidTransform;
  readonly rawValueToMeters = 1;
  protected readonly frame: WebXRFrame;

  constructor(frame: WebXRFrame, view: WebXRView) {
    this.frame = frame;
    const nativeFrame = nativeFrameFor(frame);
    this.width = nativeFrame.width;
    this.height = nativeFrame.height;
    // @ref LLP 0014#xr-depth-information — The WebXR Depth Sensing spec mixes
    // XRViewGeometry into XRDepthInformation; for matchDepthView=true these
    // geometry fields match the associated XRView.
    this.projectionMatrix = new Float32Array(view.projectionMatrix);
    this.transform = view.transform;
    this.normDepthBufferFromNormView = transformFromNative(nativeFrame.normDepthBufferFromNormView);
  }
}

export class WebXRCPUDepthInformation extends WebXRDepthInformation {
  #data: ArrayBuffer | null = null;

  get data(): ArrayBuffer {
    this.frame.assertActive();
    const bytes = this.frame.nativeDepthData();
    if (!bytes) {
      throw invalidState('Depth data for this XRFrame is no longer available');
    }
    this.#data ??= exactArrayBuffer(bytes);
    return this.#data;
  }

  getDepthInMeters(x: number, y: number): number {
    this.frame.assertActive();
    assertNormalizedInputCoordinate(x, 'x');
    assertNormalizedInputCoordinate(y, 'y');
    const bytes = this.frame.nativeDepthData();
    if (!bytes) {
      throw invalidState('Depth data for this XRFrame is no longer available');
    }
    const point = transformNormalizedPoint(this.normDepthBufferFromNormView, x, y);
    const px = normalizedDepthCoordinateToIndex(point.x, this.width);
    const py = normalizedDepthCoordinateToIndex(point.y, this.height);
    const values = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(this.width * this.height, Math.floor(bytes.byteLength / 4))
    );
    return (values[py * this.width + px] ?? 0) * this.rawValueToMeters;
  }
}

export class WebXRCPUCameraImage {
  readonly camera: WebXRCamera;
  readonly width: number;
  readonly height: number;
  readonly format: WebXRCameraFormat;
  readonly normCameraImageFromNormView: WebXRRigidTransform;
  readonly #frame: WebXRFrame;
  readonly #bytes: Uint8Array;
  #data: ArrayBuffer | null = null;

  private constructor(frame: WebXRFrame, camera: WebXRCamera, bytes: Uint8Array) {
    this.#frame = frame;
    this.camera = camera;
    this.width = camera.width;
    this.height = camera.height;
    this.format = camera.format;
    this.normCameraImageFromNormView = camera.normCameraImageFromNormView;
    this.#bytes = bytes;
  }

  static fromCamera(camera: WebXRCamera): WebXRCPUCameraImage | null {
    const frame = camera[CAMERA_FRAME];
    const cameraData = frame.nativeCameraData();
    if (!cameraData) return null;
    const bytes =
      cameraData.format === 'bgra8unorm' && frame.session.cameraFormat === 'rgba8unorm'
        ? bgraToRgba(cameraData.data)
        : cameraData.data;
    return new WebXRCPUCameraImage(frame, camera, bytes);
  }

  get data(): ArrayBuffer {
    this.#frame.assertActive();
    this.#data ??= exactArrayBuffer(this.#bytes);
    return this.#data;
  }
}

// @ref LLP 0014#xr-camera-image — Repo-local CPU analog of
// XRWebGLBinding.getCameraImage(camera). The standard draft returns WebGLTexture;
// this profile returns CPU bytes for the WebGPU demo upload path.
export class WebXRCPUCameraBinding {
  readonly session: WebXRSession;

  constructor(session: WebXRSession) {
    this.session = session;
  }

  getCameraImage(camera: WebXRCamera): WebXRCPUCameraImage | null {
    const frame = camera[CAMERA_FRAME];
    frame.assertActive();
    if (!this.session.hasCameraAccess()) {
      throw unsupported('camera-access was not enabled for this XRSession');
    }
    if (frame.session !== this.session) {
      throw invalidState('XRCamera belongs to a different XRSession');
    }
    return WebXRCPUCameraImage.fromCamera(camera);
  }
}
