import { Platform } from 'react-native';

export type CameraFacingMode = 'user' | 'environment';
export type CameraFacingModeAvailability = 'unknown' | 'available' | 'unavailable';

export type CameraFacingAvailability = Record<CameraFacingMode, CameraFacingModeAvailability>;

export const DEFAULT_FACING_AVAILABILITY: CameraFacingAvailability = {
  user: 'available',
  environment: 'unknown',
};

export const KNOWN_FACING_AVAILABILITY: CameraFacingAvailability = {
  user: 'available',
  environment: 'available',
};

export function reportedFacingMode(
  settings: MediaTrackSettings | null | undefined
): CameraFacingMode | undefined {
  return settings?.facingMode === 'user' || settings?.facingMode === 'environment'
    ? settings.facingMode
    : undefined;
}

export function displayFacingMode({
  constraints,
  settings,
}: {
  constraints?: { facingMode?: CameraFacingMode };
  settings: MediaTrackSettings | null | undefined;
}): CameraFacingMode {
  const reported = reportedFacingMode(settings);
  if (Platform.OS === 'web') {
    return reported ?? 'user';
  }
  // @ref LLP 0012#frame-bound-demo-mirroring — Native UI should reflect the
  // camera that is actually active, not the next requested facing mode, so
  // preview mirroring cannot flip before the replacement stream produces
  // frames.
  return reported ?? constraints?.facingMode ?? 'environment';
}

// @ref LLP 0012#frame-bound-demo-mirroring — GPU demos mirror the frame whose
// pixels are currently bound, not the next requested constraint state.
export function cameraFrameFacingMode(
  settings: MediaTrackSettings | null | undefined
): CameraFacingMode {
  const reported = reportedFacingMode(settings);
  if (Platform.OS === 'web') {
    return reported ?? 'user';
  }
  return reported ?? 'environment';
}
