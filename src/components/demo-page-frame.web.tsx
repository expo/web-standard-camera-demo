import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import * as React from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useCamera } from '@/contexts/CameraContext';
import type { DemoPageAction, DemoPageFrameProps } from './demo-page-frame';

const STOP_TINT = '#ff453a';
const START_STOP_BUTTON_WIDTH = 146;
const ICONS: Record<'play' | 'stop', { web: AndroidSymbol }> = {
  play: { web: 'play_arrow' },
  stop: { web: 'stop' },
};

export function DemoPageFrame({ action, controls, hud, preview }: DemoPageFrameProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const resolvedAction = useResolvedAction(action);
  const isDesktop = width >= 1040;

  return (
    <View style={[styles.frame, isDesktop ? styles.frameDesktop : null]}>
      <View style={[styles.previewPane, isDesktop ? styles.previewPaneDesktop : null]}>
        <View style={styles.previewHeader}>
          <View style={styles.headerSpacer} />
          {resolvedAction ? <DemoActionButton action={resolvedAction} colors={colors} /> : null}
        </View>
        {preview}
      </View>

      <View style={[styles.sidePane, isDesktop ? styles.sidePaneDesktop : null]}>
        {controls}
        {hud}
      </View>
    </View>
  );
}

function useResolvedAction(action: DemoPageFrameProps['action']): DemoPageAction | null {
  const { externalLocked, start, status, stop } = useCamera();
  if (action === null || action === undefined) return null;
  if (action !== 'standard-camera') return action;

  const running = status === 'playing';
  const transitioning = status === 'requesting' || status === 'starting' || status === 'stopping';
  const disabled = externalLocked || transitioning;
  const label = externalLocked
    ? 'Camera in use'
    : status === 'requesting' || status === 'starting'
      ? 'Starting...'
      : status === 'stopping'
        ? 'Stopping...'
        : running
          ? 'Stop camera'
          : 'Start camera';

  return {
    disabled,
    label,
    onPress: running ? () => stop('demo-inline-web') : () => void start(),
    running,
    testID: 'standard-camera-start-stop',
  };
}

function DemoActionButton({
  action,
  colors,
}: {
  action: DemoPageAction;
  colors: (typeof Colors)[keyof typeof Colors];
}): React.JSX.Element {
  const tintColor = action.running ? STOP_TINT : colors.text;
  return (
    <Pressable
      accessibilityLabel={action.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: action.disabled }}
      disabled={action.disabled}
      onPress={action.onPress}
      testID={action.testID}
      style={({ pressed }) => [
        styles.startStopButton,
        { backgroundColor: colors.backgroundElement },
        action.disabled ? styles.startStopButtonDisabled : null,
        pressed && !action.disabled ? styles.startStopButtonPressed : null,
      ]}>
      <View style={styles.startStopIconSlot}>
        <SymbolView
          fallback={<Text style={[styles.startStopFallback, { color: tintColor }]}>{action.running ? 'S' : 'P'}</Text>}
          name={ICONS[action.running ? 'stop' : 'play']}
          size={18}
          tintColor={tintColor}
        />
      </View>
      <Text numberOfLines={1} style={[styles.startStopText, { color: tintColor }]}>
        {action.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignSelf: 'center',
    gap: 14,
    maxWidth: 1412,
    paddingHorizontal: 16,
    paddingTop: 10,
    width: '100%',
  },
  frameDesktop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 28,
    paddingHorizontal: 32,
  },
  previewPane: {
    alignItems: 'center',
    gap: 14,
    minWidth: 0,
    width: '100%',
  },
  previewPaneDesktop: {
    flex: 1.7,
  },
  previewHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    minHeight: 36,
    paddingHorizontal: 2,
    width: '100%',
  },
  headerSpacer: {
    flex: 1,
    minWidth: 0,
  },
  sidePane: {
    alignSelf: 'stretch',
    gap: 14,
    width: '100%',
  },
  sidePaneDesktop: {
    flexShrink: 0,
    width: 360,
  },
  startStopButton: {
    alignItems: 'center',
    borderRadius: 18,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'flex-start',
    minHeight: 36,
    paddingHorizontal: 13,
    paddingVertical: 8,
    width: START_STOP_BUTTON_WIDTH,
  },
  startStopIconSlot: {
    alignItems: 'center',
    flexShrink: 0,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  startStopButtonDisabled: {
    opacity: 0.55,
  },
  startStopButtonPressed: {
    opacity: 0.72,
  },
  startStopFallback: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  startStopText: {
    flex: 1,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 15,
    textAlign: 'left',
  },
});
