import { Stack } from 'expo-router';
import type { NativeStackHeaderItem } from 'expo-router/build/react-navigation/native-stack';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import * as React from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { useCamera } from '@/contexts/CameraContext';
import { useTheme } from '@/hooks/use-theme';

export const unstable_settings = {
  initialRouteName: 'index',
};

const DISABLED_TINT = '#94a3b8';
const STOP_TINT = '#ff453a';

export default function CameraStackLayout(): React.JSX.Element {
  const theme = useTheme();
  const { hardware, start, status, stop } = useCamera();
  const blockedByLiDAR = hardware.owner === 'lidar' && hardware.phase !== 'stopped';
  const standardRunning = !blockedByLiDAR && status === 'playing';
  const standardTransitioning =
    status === 'requesting' || status === 'starting' || status === 'stopping';
  const disabled = blockedByLiDAR || standardTransitioning;
  const label = blockedByLiDAR
    ? 'Camera in use by LiDAR'
    : standardRunning
      ? 'Stop camera'
      : 'Start camera';
  const fallbackText = blockedByLiDAR ? 'L' : standardRunning ? 'S' : 'P';
  const sfSymbol: SFSymbol = blockedByLiDAR ? 'lock.fill' : standardRunning ? 'stop.fill' : 'play.fill';
  const androidSymbol: AndroidSymbol = blockedByLiDAR ? 'lock' : standardRunning ? 'stop' : 'play_arrow';
  const tintColor = blockedByLiDAR ? DISABLED_TINT : standardRunning ? STOP_TINT : theme.text;

  const onPress = React.useCallback((): void => {
    if (disabled) return;
    if (standardRunning) {
      stop('home-header');
    } else {
      void start();
    }
  }, [disabled, standardRunning, start, stop]);

  const headerRightItems = React.useCallback(
    (): NativeStackHeaderItem[] => [
      {
        type: 'button' as const,
        label,
        accessibilityLabel: label,
        disabled,
        icon: {
          type: 'sfSymbol' as const,
          name: sfSymbol,
        },
        identifier: 'home-camera-start-stop',
        onPress,
        tintColor,
        variant: 'plain' as const,
      },
    ],
    [disabled, label, onPress, sfSymbol, tintColor]
  );

  const headerRight = React.useCallback(
    () => (
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [
          styles.headerButton,
          { backgroundColor: theme.backgroundElement },
          disabled ? styles.headerButtonDisabled : null,
          pressed && !disabled ? styles.headerButtonPressed : null,
        ]}>
        <SymbolView
          fallback={<Text style={[styles.headerButtonFallback, { color: tintColor }]}>{fallbackText}</Text>}
          name={{ ios: sfSymbol, android: androidSymbol, web: androidSymbol }}
          size={20}
          tintColor={tintColor}
        />
      </Pressable>
    ),
    [androidSymbol, disabled, fallbackText, label, onPress, sfSymbol, theme.backgroundElement, tintColor]
  );

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        // Web renders the page title in the floating AppTabs header and puts
        // the start/stop button inside the page itself, so suppress the
        // per-screen Stack header to avoid a redundant heading row.
        headerShown: Platform.OS !== 'web',
      }}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Web Standard Camera',
          headerRight,
          unstable_headerRightItems: headerRightItems,
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtonDisabled: {
    opacity: 0.5,
  },
  headerButtonFallback: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  headerButtonPressed: {
    opacity: 0.7,
  },
});
