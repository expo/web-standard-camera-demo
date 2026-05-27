import { useSegments } from 'expo-router';
import {
  TabList,
  Tabs,
  TabSlot,
  TabTrigger,
  type TabTriggerSlotProps,
} from 'expo-router/ui';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { Pressable, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';

import { Colors } from '@/constants/theme';

type ThemeColors = (typeof Colors)[keyof typeof Colors];

type TabItem = {
  href:
    | '/(tabs)/(camera)'
    | '/(tabs)/(tests)/run-tests'
    | '/(tabs)/(demo)/demos'
    | '/(tabs)/(diagnostics)/diagnostics';
  icon: { ios: SFSymbol; web: AndroidSymbol };
  label: string;
  name: string;
};

const TABS: TabItem[] = [
  {
    href: '/(tabs)/(camera)',
    icon: { ios: 'house.fill', web: 'home' },
    label: 'Home',
    name: 'home',
  },
  {
    href: '/(tabs)/(tests)/run-tests',
    icon: { ios: 'checklist', web: 'checklist' },
    label: 'Tests',
    name: 'tests',
  },
  {
    href: '/(tabs)/(demo)/demos',
    icon: { ios: 'cube.fill', web: 'deployed_code' },
    label: 'Demo',
    name: 'demo',
  },
  {
    href: '/(tabs)/(diagnostics)/diagnostics',
    icon: { ios: 'stethoscope', web: 'stethoscope' },
    label: 'Diagnostics',
    name: 'diagnostics',
  },
];

// Title text shown in the floating header. The web app does not show the
// per-screen Stack header (see each (tabs) Stack's headerShown override),
// so the heading lives entirely in this nav shell. We first check the leaf
// for a known subscreen, then fall back to the tab group's default title.
const LEAF_TITLES: Record<string, string> = {
  cube: 'Cube',
  'shader-lens': 'Shader Lens',
  'neural-lens': 'Neural Lens',
  'lidar-depth-webxr': 'WebXR LiDAR',
  'panoramic-scene-capture': 'Scene Capture',
  'webgpu-spike': 'WebGPU Spike',
};

const GROUP_TITLES: Record<string, string> = {
  '(tests)': 'Tests',
  '(diagnostics)': 'Diagnostics',
  '(demo)': 'Demos',
  '(camera)': 'Web Standard Camera',
};

function usePageTitle(): string {
  const segments = useSegments();
  const leaf = [...segments].reverse().find((s) => !s.startsWith('(')) ?? '';
  if (LEAF_TITLES[leaf]) {
    return LEAF_TITLES[leaf];
  }
  // Pick the inner-most tab group (skip the outer (tabs) wrapper).
  const innerGroup = segments.find((s) => s.startsWith('(') && s !== '(tabs)');
  return GROUP_TITLES[innerGroup ?? '(camera)'] ?? 'Web Standard Camera';
}

export default function AppTabs() {
  const systemScheme = useColorScheme();
  const { width } = useWindowDimensions();
  const scheme = systemScheme === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const isCompact = width < 640;
  const title = usePageTitle();

  return (
    <Tabs>
      <TabSlot
        style={[
          styles.slot,
          isCompact ? styles.slotCompact : null,
          { backgroundColor: colors.background },
        ]}
      />

      <View
        style={[
          styles.navShell,
          isCompact ? styles.navShellCompact : null,
          {
            backgroundColor: scheme === 'dark' ? 'rgba(20,20,22,0.94)' : 'rgba(255,255,255,0.94)',
            borderColor: scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)',
          },
        ]}>
        {isCompact ? null : (
          <Text numberOfLines={1} style={[styles.navTitle, { color: colors.text }]}>
            {title}
          </Text>
        )}
      </View>

      <TabList
        style={[
          styles.navItems,
          isCompact ? styles.navItemsCompact : null,
          {
            borderColor: scheme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
          },
        ]}>
        {TABS.map((tab) => (
          <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
            <TabButton colors={colors} compact={isCompact} icon={tab.icon} label={tab.label} />
          </TabTrigger>
        ))}
      </TabList>
    </Tabs>
  );
}

function TabButton({
  colors,
  compact,
  icon,
  isFocused,
  label,
  ...props
}: TabTriggerSlotProps & {
  colors: ThemeColors;
  compact: boolean;
  icon: TabItem['icon'];
  label: string;
}) {
  const tintColor = isFocused ? colors.text : colors.textSecondary;
  return (
    <Pressable
      {...props}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.tabButton,
        compact ? styles.tabButtonCompact : null,
        isFocused ? { backgroundColor: colors.backgroundSelected } : null,
        pressed ? styles.pressed : null,
      ]}>
      <SymbolView
        name={icon}
        size={19}
        tintColor={tintColor}
        fallback={<Text style={[styles.iconFallback, { color: tintColor }]}>{label[0]}</Text>}
      />
      <Text
        numberOfLines={1}
        style={[
          styles.tabLabel,
          compact ? styles.tabLabelCompact : null,
          {
            color: tintColor,
            fontWeight: isFocused ? '700' : '600',
          },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: {
    flex: 1,
    paddingTop: 86,
  },
  slotCompact: {
    paddingTop: 78,
  },
  navShell: {
    position: 'absolute',
    top: 12,
    right: 12,
    left: 12,
    minHeight: 58,
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: 18,
    justifyContent: 'center',
    paddingLeft: 18,
    paddingRight: 18,
    boxShadow: '0 10px 28px rgba(0,0,0,0.14)',
    pointerEvents: 'none',
    zIndex: 1,
  },
  navShellCompact: {
    minHeight: 54,
    paddingLeft: 12,
    paddingRight: 12,
  },
  navTitle: {
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 20,
  },
  // Centered horizontally via left:50% + translateX(-50%) so the pill stays
  // visually anchored regardless of the title's length on the left.
  navItems: {
    position: 'absolute',
    top: 17,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 368,
    height: 48,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 0,
    zIndex: 2,
  },
  navItemsCompact: {
    top: 15,
    right: 15,
    left: 15,
    width: 'auto',
    height: 44,
    transform: 'none',
  },
  tabButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  tabButtonCompact: {
    minHeight: 36,
    borderRadius: 11,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  pressed: {
    opacity: 0.7,
  },
  tabLabel: {
    maxWidth: '100%',
    fontSize: 11,
    lineHeight: 13,
  },
  tabLabelCompact: {
    fontSize: 10,
    lineHeight: 12,
  },
  iconFallback: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 19,
  },
});
