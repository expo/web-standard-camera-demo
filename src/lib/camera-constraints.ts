export interface CameraConstraintSet {
  deviceId?: string;
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
}

const CAMERA_CONSTRAINT_KEYS = ['deviceId', 'facingMode', 'width', 'height', 'frameRate'] as const;

export function normalizeCameraConstraints<T extends CameraConstraintSet>(constraints: T): CameraConstraintSet {
  const normalized: CameraConstraintSet = {};
  for (const key of CAMERA_CONSTRAINT_KEYS) {
    const value = constraints[key];
    if (value === undefined) continue;
    switch (key) {
      case 'deviceId':
        normalized.deviceId = value as string;
        break;
      case 'facingMode':
        normalized.facingMode = value as CameraConstraintSet['facingMode'];
        break;
      case 'width':
        normalized.width = value as number;
        break;
      case 'height':
        normalized.height = value as number;
        break;
      case 'frameRate':
        normalized.frameRate = value as number;
        break;
    }
  }
  return normalized;
}

export function mergeCameraConstraints<T extends CameraConstraintSet>(
  previous: T,
  patch: Partial<T>
): CameraConstraintSet {
  const merged = normalizeCameraConstraints({ ...previous, ...patch });
  if (patch.deviceId) delete merged.facingMode;
  if (patch.facingMode) delete merged.deviceId;
  return merged;
}

export function cameraConstraintsEqual(
  a: CameraConstraintSet,
  b: CameraConstraintSet
): boolean {
  const left = normalizeCameraConstraints(a);
  const right = normalizeCameraConstraints(b);
  return CAMERA_CONSTRAINT_KEYS.every((key) => left[key] === right[key]);
}
