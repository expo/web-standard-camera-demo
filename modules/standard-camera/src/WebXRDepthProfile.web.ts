// Web entry point for the repo-local WebXR depth profile. Browsers already own
// `navigator.xr` when they support WebXR, so this file does not install the
// iOS research runtime. It only provides the exported symbols that universal
// demo routes import.

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

export interface WebXRDepthProfileTelemetryContext {
  scanId?: number | null;
}

type CameraLockHandlers = {
  lockExternal: () => Promise<void>;
  unlockExternal: () => void;
};

function unsupported(message: string): DOMException {
  return new DOMException(message, 'NotSupportedError');
}

function identityMatrix4(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function setWebXRDepthCameraLockHandlers(_handlers: CameraLockHandlers | null): void {}

export function setWebXRDepthProfileTelemetryContext(
  _context: WebXRDepthProfileTelemetryContext | null,
): void {}

export function runWithWebXRUserActivation<T>(callback: () => T): T {
  return callback();
}

export function installWebXRDepthProfile(): void {
  // The web build uses the browser's own navigator.xr when present.
}

export class WebXRSystem extends EventTarget {
  async isSessionSupported(_mode: string): Promise<boolean> {
    return false;
  }

  async requestSession(_mode: string, _options: WebXRSessionInit = {}): Promise<WebXRSession> {
    throw unsupported('WebXR depth/camera access is not available in this browser');
  }
}

export class WebXRSession extends EventTarget {
  readonly depthType: WebXRDepthType | null = null;
  readonly ended = true;

  async requestReferenceSpace(_type: WebXRReferenceSpaceType): Promise<WebXRReferenceSpace> {
    throw unsupported('WebXR reference spaces are not available in this browser');
  }

  requestAnimationFrame(_callback: WebXRFrameRequestCallback): number {
    return 0;
  }

  cancelAnimationFrame(_handle: number): void {}

  async end(): Promise<void> {}
}

export class WebXRReferenceSpace extends EventTarget {}

export class WebXRPose {
  readonly transform = new WebXRRigidTransform();
}

export class WebXRMeshSpace extends EventTarget {}

export class WebXRMesh {
  readonly meshSpace = new WebXRMeshSpace();
  readonly vertices = new Float32Array(0);
  readonly indices = new Uint32Array(0);
  readonly lastChangedTime = 0;
  readonly semanticLabel: string | null = null;
  readonly normals: Float32Array | null = null;
}

export class WebXRMeshSet implements Iterable<WebXRMesh> {
  readonly size = 0;

  has(_mesh: WebXRMesh): boolean {
    return false;
  }

  values(): IterableIterator<WebXRMesh> {
    return [][Symbol.iterator]();
  }

  keys(): IterableIterator<WebXRMesh> {
    return this.values();
  }

  entries(): IterableIterator<[WebXRMesh, WebXRMesh]> {
    return [][Symbol.iterator]();
  }

  forEach(_callback: (value: WebXRMesh, key: WebXRMesh, parent: WebXRMeshSet) => void): void {}

  [Symbol.iterator](): IterableIterator<WebXRMesh> {
    return this.values();
  }
}

export class WebXRRigidTransform {
  readonly matrix: Float32Array;

  constructor(matrix?: Float32Array) {
    this.matrix = matrix ?? identityMatrix4();
  }
}

export class WebXRFrame {
  readonly detectedMeshes = new WebXRMeshSet();

  getViewerPose(_referenceSpace: WebXRReferenceSpace): WebXRViewerPose | null {
    return null;
  }

  getDepthInformation(_view: WebXRView): WebXRCPUDepthInformation | null {
    return null;
  }

  getPose(_space: WebXRMeshSpace, _baseSpace: WebXRReferenceSpace): WebXRPose | null {
    return null;
  }
}

export class WebXRViewerPose {
  readonly transform = new WebXRRigidTransform();
  readonly views: WebXRView[] = [];
}

export class WebXRView {
  readonly projectionMatrix = identityMatrix4();
  readonly transform = new WebXRRigidTransform();
  readonly camera: WebXRCamera | null = null;
}

export class WebXRCamera {
  readonly width = 0;
  readonly height = 0;
  readonly format: WebXRCameraFormat = 'bgra8unorm';
  readonly normCameraImageFromNormView = new WebXRRigidTransform();
}

export class WebXRDepthInformation {
  readonly width = 0;
  readonly height = 0;
  readonly projectionMatrix = identityMatrix4();
  readonly transform = new WebXRRigidTransform();
  readonly normDepthBufferFromNormView = new WebXRRigidTransform();
  readonly rawValueToMeters = 1;
}

export class WebXRCPUDepthInformation extends WebXRDepthInformation {
  readonly data = new ArrayBuffer(0);

  getDepthInMeters(_x: number, _y: number): number {
    return 0;
  }
}

export class WebXRCPUCameraImage {
  readonly camera = new WebXRCamera();
  readonly width = 0;
  readonly height = 0;
  readonly format: WebXRCameraFormat = 'bgra8unorm';
  readonly normCameraImageFromNormView = new WebXRRigidTransform();
  readonly data = new ArrayBuffer(0);
}

export class WebXRCPUCameraBinding {
  readonly session: WebXRSession;

  constructor(session: WebXRSession) {
    this.session = session;
  }

  getCameraImage(_camera: WebXRCamera): WebXRCPUCameraImage | null {
    throw unsupported('WebXR CPU camera access is not available in this browser');
  }
}
