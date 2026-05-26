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
  return constraints?.facingMode ?? reported ?? 'environment';
}
