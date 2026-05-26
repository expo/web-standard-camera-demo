// @ref LLP 0013#conformance-model - Repo-local WebXR-shaped research profile.
// This is not a browser-compatible WebXR runtime; it implements only the
// camera/depth subset needed by the LiDAR WebGPU demo.

import 'event-target-polyfill';

import { DOMException } from './DOMException';
import NativeStandardCamera, {
  type NativeLiDARDepthCapabilities,
  type NativeLiDARDepthFrame,
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

function transformNormalizedPoint(
  transform: WebXRRigidTransform,
  x: number,
  y: number
): { x: number; y: number } {
  // LLP 0013 currently maps ARKit's view-aligned buffers with identity
  // transforms, but keeping the matrix path here means `getDepthInMeters()`
  // already follows the spec-shaped coordinate pipeline.
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

function selectedDepthType(caps: NativeLiDARDepthCapabilities, request?: WebXRDepthType[]): WebXRDepthType {
  const preferred = request && request.length > 0 ? request : ['smooth', 'raw'];
  for (const type of preferred) {
    if (type === 'smooth' && caps.smoothedSceneDepth) return 'smooth';
    if (type === 'raw' && caps.sceneDepth) return 'raw';
  }
  return caps.smoothedSceneDepth ? 'smooth' : 'raw';
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

    const depthType = wantsDepth ? selectedDepthType(caps, options.depthSensing?.depthTypeRequest) : null;
    let locked = false;
    try {
      await cameraLockHandlers?.lockExternal();
      locked = true;
      await NativeStandardCamera.startLiDARDepthAsync();
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
      depthType,
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
  #depthActive = true;
  #ended = false;
  #callbacks = new Map<number, ScheduledXRCallback>();

  constructor(config: WebXRSessionConfig) {
    super();
    this.#cameraAccessEnabled = config.cameraAccessEnabled;
    this.#cameraFormat = config.cameraFormat;
    this.#depthEnabled = config.depthEnabled;
    this.#depthType = config.depthType;
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
      const nativeFrame = NativeStandardCamera.getLatestLiDARDepthFrame();
      if (!nativeFrame || nativeFrame.frameNumber === scheduled.lastSeenFrameNumber) {
        scheduled.rafId = globalThis.requestAnimationFrame(pump);
        return;
      }

      scheduled.lastSeenFrameNumber = nativeFrame.frameNumber;
      this.#callbacks.delete(handle);
      const time = now();
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
    if (this.#ended) return;
    this.#ended = true;
    for (const handle of [...this.#callbacks.keys()]) {
      this.cancelAnimationFrame(handle);
    }
    await NativeStandardCamera.stopLiDARDepthAsync();
    cameraLockHandlers?.unlockExternal();
    if (activeImmersiveSession === this) {
      activeImmersiveSession = null;
    }
    this.dispatchEvent(new Event('end'));
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
    this.inverse = inverse ?? this;
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
    return new WebXRCPUDepthInformation(this);
  }

  // @ref LLP 0013#xr-camera-image
  // @ref LLP 0017#xr-webgl-get-camera-image
  getCameraImage(view: WebXRView): WebXRCPUCameraImage | null {
    this.assertActive();
    if (!this.session.hasCameraAccess()) {
      throw unsupported('camera-access was not enabled for this XRSession');
    }
    if (view.frame !== this) {
      throw invalidState('XRView belongs to a different XRFrame');
    }
    return WebXRCPUCameraImage.fromFrame(this);
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
  readonly transform = identityTransform();
  readonly projectionMatrix = new Float32Array(IDENTITY_MATRIX);
  readonly frame: WebXRFrame;

  constructor(frame: WebXRFrame) {
    this.frame = frame;
  }

  // @ref LLP 0013#xr-camera-image
  // @ref LLP 0017#xr-view-camera
  get camera(): WebXRCamera | null {
    this.frame.assertActive();
    if (!this.frame.session.hasCameraAccess()) return null;
    const native = this.frame.nativeFrame;
    if (!native.colorData || !native.colorWidth || !native.colorHeight) return null;
    return new WebXRCamera(native.colorWidth, native.colorHeight, this.frame.session.cameraFormat);
  }
}

export class WebXRCamera {
  readonly width: number;
  readonly height: number;
  readonly format: WebXRCameraFormat;
  readonly normCameraImageFromNormView = identityTransform();

  constructor(width: number, height: number, format: WebXRCameraFormat) {
    this.width = width;
    this.height = height;
    this.format = format;
  }
}

export class WebXRDepthInformation {
  readonly width: number;
  readonly height: number;
  readonly normDepthBufferFromNormView = identityTransform();
  readonly rawValueToMeters = 1;
  protected readonly frame: WebXRFrame;

  constructor(frame: WebXRFrame) {
    this.frame = frame;
    this.width = frame.nativeFrame.width;
    this.height = frame.nativeFrame.height;
  }
}

export class WebXRCPUDepthInformation extends WebXRDepthInformation {
  get data(): ArrayBuffer {
    this.frame.assertActive();
    return exactArrayBuffer(this.frame.nativeFrame.depthData);
  }

  getDepthInMeters(x: number, y: number): number {
    this.frame.assertActive();
    const point = transformNormalizedPoint(this.normDepthBufferFromNormView, x, y);
    const px = Math.round(clamp01(point.x) * Math.max(0, this.width - 1));
    const py = Math.round(clamp01(point.y) * Math.max(0, this.height - 1));
    const values = new Float32Array(
      this.frame.nativeFrame.depthData.buffer,
      this.frame.nativeFrame.depthData.byteOffset,
      Math.min(this.width * this.height, Math.floor(this.frame.nativeFrame.depthData.byteLength / 4))
    );
    return (values[py * this.width + px] ?? 0) * this.rawValueToMeters;
  }
}

export class WebXRCPUCameraImage {
  readonly camera: WebXRCamera;
  readonly width: number;
  readonly height: number;
  readonly format: WebXRCameraFormat;
  readonly normCameraImageFromNormView = identityTransform();
  readonly #frame: WebXRFrame;
  readonly #bytes: Uint8Array;

  private constructor(frame: WebXRFrame, camera: WebXRCamera, bytes: Uint8Array) {
    this.#frame = frame;
    this.camera = camera;
    this.width = camera.width;
    this.height = camera.height;
    this.format = camera.format;
    this.#bytes = bytes;
  }

  static fromFrame(frame: WebXRFrame): WebXRCPUCameraImage | null {
    const native = frame.nativeFrame;
    if (!native.colorData || !native.colorWidth || !native.colorHeight) return null;
    const camera = new WebXRCamera(native.colorWidth, native.colorHeight, frame.session.cameraFormat);
    const bytes =
      native.colorFormat === 'bgra8unorm' && frame.session.cameraFormat === 'rgba8unorm'
        ? bgraToRgba(native.colorData)
        : native.colorData;
    return new WebXRCPUCameraImage(frame, camera, bytes);
  }

  get data(): ArrayBuffer {
    this.#frame.assertActive();
    return exactArrayBuffer(this.#bytes);
  }
}
