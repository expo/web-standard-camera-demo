// @ref LLP 0013#conformance-model - Repo-local WebXR-shaped research profile.
// This is not a browser-compatible WebXR runtime; it implements only the
// camera/depth subset needed by the LiDAR WebGPU demo.

import 'event-target-polyfill';

import { DOMException } from './DOMException';
import NativeStandardCamera, {
  type NativeLiDARDepthCapabilities,
  type NativeLiDARDepthFrame,
  type NativeLiDARDepthSessionEvent,
} from './native';

export type WebXRSessionMode = 'immersive-ar';
export type WebXRReferenceSpaceType = 'viewer';
export type WebXRFeatureDescriptor = 'depth-sensing' | 'camera-access';
export type WebXRDepthType = 'raw' | 'smooth';
export type WebXRDepthUsage = 'cpu-optimized';
export type WebXRDepthDataFormat = 'float32';
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
const TRANSIENT_ACTIVATION_MS = 900;
let transientActivationUntil = 0;
let nextAnimationFrameHandle = 1;
let activeImmersiveSession: WebXRSession | null = null;
let cameraLockHandlers: CameraLockHandlers | null = null;

const IDENTITY_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const CAMERA_FRAME = Symbol('standard-camera.webxr.camera-frame');

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
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
  // @ref LLP 0013#xr-depth-information — `getDepthInMeters()` samples after
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
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
    if (feature !== 'depth-sensing' && feature !== 'camera-access') {
      throw unsupported(`Unsupported XR feature: ${String(feature)}`);
    }
    out.add(feature);
  }
  return out;
}

function collectKnownOptionalFeatures(features: WebXRFeatureDescriptor[] | undefined): Set<WebXRFeatureDescriptor> {
  const out = new Set<WebXRFeatureDescriptor>();
  for (const feature of features ?? []) {
    if (feature === 'depth-sensing' || feature === 'camera-access') {
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

// @ref LLP 0013#xr-request-session - `requestSession()` must stop/suspend any
// active `getUserMedia` stream through the same external-lock mechanism used
// by the LiDAR native sidecar.
export function setWebXRDepthCameraLockHandlers(handlers: CameraLockHandlers | null): void {
  cameraLockHandlers = handlers;
}

// React Native has no browser `navigator.userActivation`, so the demo's press
// handler wraps the `requestSession()` call in this transient activation token.
// @ref LLP 0013#xr-request-session
export function runWithWebXRUserActivation<T>(callback: () => T): T {
  setTransientActivation();
  return callback();
}

// @ref LLP 0013#xr-install
// @ref LLP 0014#xr-system
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
  // @ref LLP 0013#xr-is-session-supported
  // @ref LLP 0014#xr-session-mode
  async isSessionSupported(mode: string): Promise<boolean> {
    if (mode !== 'immersive-ar') {
      return false;
    }
    const caps = NativeStandardCamera.getLiDARDepthCapabilities();
    return caps.supported === true;
  }

  // @ref LLP 0013#xr-request-session
  // @ref LLP 0015#ar-compositor-privacy
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

    const requiredFeatures = validateRequiredFeatures(options.requiredFeatures);
    const optionalFeatures = collectKnownOptionalFeatures(options.optionalFeatures);
    const wantsDepth = requiredFeatures.has('depth-sensing') ||
      (optionalFeatures.has('depth-sensing') && options.depthSensing != null);
    const wantsCamera = requiredFeatures.has('camera-access') ||
      (optionalFeatures.has('camera-access') && options.cameraAccess != null);
    if (!wantsDepth && !wantsCamera) {
      throw unsupported('This profile requires depth-sensing or camera-access');
    }
    validateDepthInit(wantsDepth, requiredFeatures.has('depth-sensing'), options.depthSensing);
    validateCameraInit(wantsCamera, requiredFeatures.has('camera-access'), options.cameraAccess);

    const caps = NativeStandardCamera.getLiDARDepthCapabilities();
    if (!caps.supported) {
      throw unsupported(caps.reason ?? 'LiDAR scene depth is unavailable');
    }

    // @ref LLP 0013#xr-request-session — Pick one supported observable
    // depth type before starting ARKit so native semantics and session.depthType match.
    const depthType = wantsDepth ? selectedDepthType(caps, options.depthSensing?.depthTypeRequest) : null;
    if (wantsDepth && !depthType) {
      throw unsupported('Requested depth type is unavailable');
    }
    let locked = false;
    let started: NativeLiDARDepthCapabilities;
    try {
      await cameraLockHandlers?.lockExternal();
      locked = true;
      started = depthType
        ? await NativeStandardCamera.startLiDARDepthWithTypeAsync(depthType)
        : await NativeStandardCamera.startLiDARDepthAsync();
    } catch (e) {
      if (locked) {
        cameraLockHandlers?.unlockExternal();
      }
      rethrowNativeXRStartError(e);
    }

    const session = new WebXRSession({
      cameraAccessEnabled: wantsCamera,
      cameraFormat: wantsCamera ? selectedCameraFormat(options.cameraAccess) : 'bgra8unorm',
      depthEnabled: wantsDepth,
      depthType: wantsDepth ? (started.depthType ?? depthType) : null,
      sessionId: started.sessionId ?? null,
    });
    activeImmersiveSession = session;
    return session;
  }
}

type WebXRSessionConfig = {
  cameraAccessEnabled: boolean;
  cameraFormat: WebXRCameraFormat;
  depthEnabled: boolean;
  depthType: WebXRDepthType | null;
  sessionId: number | null;
};

type ScheduledXRCallback = {
  cancelled: boolean;
  rafId: number | null;
  lastSeenFrameNumber: number;
};

// @ref LLP 0013#xr-session
// @ref LLP 0014#xr-session
export class WebXRSession extends EventTarget {
  #cameraAccessEnabled: boolean;
  #cameraFormat: WebXRCameraFormat;
  #depthEnabled: boolean;
  #depthType: WebXRDepthType | null;
  #sessionId: number | null;
  #depthActive = true;
  #ended = false;
  #callbacks = new Map<number, ScheduledXRCallback>();
  #nativeTimestampOriginMs: number | null = null;
  #domTimestampOriginMs: number | null = null;
  #nativeStateSubscription: { remove(): void } | null = null;

  constructor(config: WebXRSessionConfig) {
    super();
    this.#cameraAccessEnabled = config.cameraAccessEnabled;
    this.#cameraFormat = config.cameraFormat;
    this.#depthEnabled = config.depthEnabled;
    this.#depthType = config.depthType;
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

  hasCameraAccess(): boolean {
    return this.#cameraAccessEnabled;
  }

  isDepthActiveForFrame(): boolean {
    return this.#depthEnabled && this.#depthActive && !this.#ended;
  }

  frameTime(nativeFrame: NativeLiDARDepthFrame, fallback: DOMHighResTimeStamp): DOMHighResTimeStamp {
    // @ref LLP 0013#xr-frame-loop — The callback time follows the native AR
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

  // @ref LLP 0013#xr-reference-space
  // @ref LLP 0014#xr-reference-space
  async requestReferenceSpace(type: string): Promise<WebXRReferenceSpace> {
    if (this.#ended) {
      throw invalidState('XRSession has ended');
    }
    if (type !== 'viewer') {
      throw unsupported('Only viewer reference spaces are supported');
    }
    return new WebXRReferenceSpace(this, type);
  }

  // @ref LLP 0013#xr-frame-loop
  // @ref LLP 0014#xr-frame-loop
  requestAnimationFrame(callback: WebXRFrameRequestCallback): number {
    if (this.#ended) {
      throw invalidState('XRSession has ended');
    }
    const handle = nextAnimationFrameHandle++;
    const scheduled: ScheduledXRCallback = {
      cancelled: false,
      rafId: null,
      lastSeenFrameNumber: 0,
    };
    this.#callbacks.set(handle, scheduled);

    const pump = (): void => {
      if (this.#ended || scheduled.cancelled) {
        this.#callbacks.delete(handle);
        return;
      }
      // @ref LLP 0013#xr-camera-resolution - The WebXR profile owns this
      // CPU-visible camera image size as a private implementation detail.
      const nativeFrame = NativeStandardCamera.getLatestWebXRLiDARDepthFrame();
      if (!nativeFrame || nativeFrame.frameNumber === scheduled.lastSeenFrameNumber) {
        scheduled.rafId = globalThis.requestAnimationFrame(pump);
        return;
      }

      scheduled.lastSeenFrameNumber = nativeFrame.frameNumber;
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
    if (!this.#finishEnd()) return;
    await NativeStandardCamera.stopLiDARDepthAsync();
  }

  #finishEnd(): boolean {
    if (this.#ended) return false;
    this.#ended = true;
    for (const handle of [...this.#callbacks.keys()]) {
      this.cancelAnimationFrame(handle);
    }
    this.#nativeStateSubscription?.remove();
    this.#nativeStateSubscription = null;
    cameraLockHandlers?.unlockExternal();
    if (activeImmersiveSession === this) {
      activeImmersiveSession = null;
    }
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

// @ref LLP 0014#xr-rigid-transform
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

// @ref LLP 0013#xr-frame-loop
// @ref LLP 0014#xr-frame
export class WebXRFrame {
  readonly session: WebXRSession;
  readonly predictedDisplayTime: DOMHighResTimeStamp;
  readonly nativeFrame: NativeLiDARDepthFrame;
  #active = true;
  #view: WebXRView | null = null;
  #depthInformation: WebXRCPUDepthInformation | null = null;
  #depthData: Uint8Array | null = null;
  #cameraData: Uint8Array | null = null;
  #cameraDataFormat: 'bgra8unorm' | null = null;

  constructor(session: WebXRSession, nativeFrame: NativeLiDARDepthFrame, time: DOMHighResTimeStamp) {
    this.session = session;
    this.nativeFrame = nativeFrame;
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
    const payload = NativeStandardCamera.getWebXRLiDARDepthFramePayload(
      this.nativeFrame.frameNumber,
      true,
      false
    );
    this.#depthData = payload?.depthData ?? null;
    return this.#depthData;
  }

  nativeCameraData(): { data: Uint8Array; format: 'bgra8unorm' } | null {
    this.assertActive();
    if (this.#cameraData && this.#cameraDataFormat) {
      return { data: this.#cameraData, format: this.#cameraDataFormat };
    }
    const payload = NativeStandardCamera.getWebXRLiDARDepthFramePayload(
      this.nativeFrame.frameNumber,
      false,
      true
    );
    if (!payload?.colorData || payload.colorFormat !== 'bgra8unorm') {
      return null;
    }
    this.#cameraData = payload.colorData;
    this.#cameraDataFormat = payload.colorFormat;
    return { data: this.#cameraData, format: this.#cameraDataFormat };
  }

  // @ref LLP 0013#xr-viewer-pose
  // @ref LLP 0014#xr-viewer-pose
  getViewerPose(referenceSpace: WebXRReferenceSpace): WebXRViewerPose | null {
    this.assertActive();
    if (referenceSpace.session !== this.session) {
      throw invalidState('XRReferenceSpace belongs to a different XRSession');
    }
    if (!this.#view) {
      this.#view = new WebXRView(this);
    }
    return new WebXRViewerPose([this.#view]);
  }

  // @ref LLP 0013#xr-depth-information
  // @ref LLP 0016#cpu-depth-information
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
    this.#depthInformation ??= new WebXRCPUDepthInformation(this);
    return this.#depthInformation;
  }
}

export class WebXRViewerPose {
  readonly transform = identityTransform();
  readonly views: readonly WebXRView[];

  constructor(views: readonly WebXRView[]) {
    this.views = views;
  }
}

// @ref LLP 0013#xr-viewer-pose
// @ref LLP 0014#xr-view
export class WebXRView {
  readonly eye = 'none';
  readonly index = 0;
  readonly recommendedViewportScale = null;
  readonly transform: WebXRRigidTransform;
  readonly projectionMatrix: Float32Array;
  readonly frame: WebXRFrame;
  #camera: WebXRCamera | null | undefined;

  constructor(frame: WebXRFrame) {
    this.frame = frame;
    // @ref LLP 0013#xr-viewer-pose — XRView exposes the per-frame ARKit camera
    // transform and projection matrix supplied by the native sidecar.
    this.transform = transformFromNative(frame.nativeFrame.viewTransform);
    this.projectionMatrix = matrixFromNative(frame.nativeFrame.projectionMatrix);
  }

  // @ref LLP 0013#xr-camera-image
  // @ref LLP 0017#xr-view-camera
  get camera(): WebXRCamera | null {
    this.frame.assertActive();
    if (this.#camera !== undefined) {
      return this.#camera;
    }
    if (!this.frame.session.hasCameraAccess()) return null;
    const native = this.frame.nativeFrame;
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
  readonly cameraIntrinsics: Float32Array | null;
  readonly cameraIntrinsicsImageResolution: { height: number; width: number } | null;
  readonly cameraIntrinsicsReference: 'captured-image' | 'camera-bytes' | 'depth-buffer' | null;
  readonly normDepthBufferFromNormView: WebXRRigidTransform;
  readonly rawValueToMeters = 1;
  protected readonly frame: WebXRFrame;

  constructor(frame: WebXRFrame) {
    this.frame = frame;
    this.width = frame.nativeFrame.width;
    this.height = frame.nativeFrame.height;
    this.cameraIntrinsics = frame.nativeFrame.cameraIntrinsics
      ? new Float32Array(frame.nativeFrame.cameraIntrinsics)
      : null;
    this.cameraIntrinsicsImageResolution = frame.nativeFrame.cameraIntrinsicsImageResolution
      ? {
          height: frame.nativeFrame.cameraIntrinsicsImageResolution.height,
          width: frame.nativeFrame.cameraIntrinsicsImageResolution.width,
        }
      : null;
    this.cameraIntrinsicsReference = frame.nativeFrame.cameraIntrinsicsReference ?? null;
    this.normDepthBufferFromNormView = transformFromNative(frame.nativeFrame.normDepthBufferFromNormView);
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
    const bytes = this.frame.nativeDepthData();
    if (!bytes) {
      throw invalidState('Depth data for this XRFrame is no longer available');
    }
    const point = transformNormalizedPoint(this.normDepthBufferFromNormView, x, y);
    const px = Math.round(clamp01(point.x) * Math.max(0, this.width - 1));
    const py = Math.round(clamp01(point.y) * Math.max(0, this.height - 1));
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

// @ref LLP 0013#xr-camera-image — Repo-local CPU analog of
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
