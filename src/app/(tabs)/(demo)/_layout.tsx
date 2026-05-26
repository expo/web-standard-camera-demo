import { Stack } from 'expo-router';
import type { NativeStackHeaderItem } from 'expo-router/build/react-navigation/native-stack';
import * as React from 'react';
import { Platform } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { useCamera } from '@/contexts/CameraContext';

export const unstable_settings = {
  initialRouteName: 'index',
};

// The WebGPU demo screens render on dark clear colors, so they keep light
// transparent headers. The catalog route uses the current app theme.
const DARK_BG = '#0a0e1a';
const LIGHT_TINT = '#f8fafc';
const DARK_DEMO_HEADER_OPTIONS = {
  headerTransparent: true,
  headerTintColor: LIGHT_TINT,
  headerUserInterfaceStyle: 'dark' as const,
  headerLargeTitleStyle: { color: LIGHT_TINT },
  headerStyle: { backgroundColor: 'transparent' },
  headerTitleStyle: { color: LIGHT_TINT },
  contentStyle: { backgroundColor: DARK_BG },
};

export default function DemoStackLayout(): React.JSX.Element {
  const {
    hardware,
    start,
    status,
    stop,
  } = useCamera();
  const blockedByLiDAR = hardware.owner === 'lidar' && hardware.phase !== 'stopped';
  const standardRunning = !blockedByLiDAR && status === 'playing';
  const standardTransitioning =
    status === 'requesting' || status === 'starting' || status === 'stopping';

  // @ref LLP 0010#global-camera-controls — The stack owns demo header buttons
  // so the route push starts with a populated Start/Stop control instead of
  // waiting for each screen body to mount and call Stack.Screen options.
  const standardHeaderRightItems = React.useCallback(
    (): NativeStackHeaderItem[] => {
      const iconName: SFSymbol = blockedByLiDAR ? 'lock.fill' : standardRunning ? 'stop.fill' : 'play.fill';
      const label = blockedByLiDAR
        ? 'Camera in use by LiDAR'
        : standardRunning
          ? 'Stop camera'
          : 'Start camera';
      return [
        {
          type: 'button' as const,
          label,
          accessibilityLabel: label,
          disabled: blockedByLiDAR || standardTransitioning,
          icon: {
            type: 'sfSymbol' as const,
            name: iconName,
          },
          identifier: 'standard-camera-start-stop',
          onPress: blockedByLiDAR ? () => {} : standardRunning ? stop : () => void start(),
          tintColor: blockedByLiDAR ? '#94a3b8' : standardRunning ? '#ff453a' : LIGHT_TINT,
          variant: 'plain' as const,
        },
      ];
    },
    [blockedByLiDAR, standardTransitioning, standardRunning, start, stop]
  );

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        // Web shows the page title inside the AppTabs floating header; the
        // demo subscreens render their own dark overlays for chrome on web,
        // so the per-screen Stack header is hidden on web only.
        headerShown: Platform.OS !== 'web',
      }}>
      <Stack.Screen name="index" options={{ title: 'Demos' }} />
      <Stack.Screen name="demos" options={{ title: 'Demos' }} />
      <Stack.Screen
        name="cube"
        options={{
          title: 'WebGPU Demo',
          ...DARK_DEMO_HEADER_OPTIONS,
          unstable_headerRightItems: standardHeaderRightItems,
        }}
      />
      <Stack.Screen
        name="shader-lens"
        options={{
          title: 'Shader Lens',
          ...DARK_DEMO_HEADER_OPTIONS,
          unstable_headerRightItems: standardHeaderRightItems,
        }}
      />
      <Stack.Screen
        name="neural-lens"
        options={{
          title: 'Neural Lens',
          ...DARK_DEMO_HEADER_OPTIONS,
          unstable_headerRightItems: standardHeaderRightItems,
        }}
      />
      <Stack.Screen
        name="lidar-depth-webxr"
        options={{
          title: 'WebXR LiDAR',
          ...DARK_DEMO_HEADER_OPTIONS,
        }}
      />
      <Stack.Screen
        name="panoramic-scene-capture"
        options={{
          title: 'Scene Capture',
          ...DARK_DEMO_HEADER_OPTIONS,
        }}
      />
    </Stack>
  );
}
