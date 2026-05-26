import { usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

// Routes whose content is painted on a hard dark background. When one of them
// is focused we force the whole tab container's interface style to `.dark` via
// `colorScheme` on the underlying TabsHost (maps to
// `overrideUserInterfaceStyle = .dark` on the UITabBarController), and we
// pick dark palette colors for our explicit overrides — otherwise our light
// background/labelStyle would win against the system-derived appearance.
const DARK_PATHNAMES = new Set(['/cube', '/shader-lens', '/neural-lens', '/lidar-depth']);

export default function AppTabs() {
  const systemScheme = useColorScheme();
  const pathname = usePathname();
  const forceDark = DARK_PATHNAMES.has(pathname);
  const effectiveScheme = forceDark
    ? 'dark'
    : systemScheme === 'unspecified' || systemScheme == null
      ? 'light'
      : systemScheme;
  const colors = Colors[effectiveScheme];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ selected: { color: colors.text } }}
      unstable_nativeProps={{ colorScheme: forceDark ? 'dark' : 'inherit' }}>
      <NativeTabs.Trigger name="(camera)">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(tests)">
        <NativeTabs.Trigger.Label>Tests</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(demo)">
        <NativeTabs.Trigger.Label>Demo</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="cube.fill" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(diagnostics)">
        <NativeTabs.Trigger.Label>Diagnostics</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="stethoscope" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
