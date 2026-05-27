import { usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

// Routes whose content is painted on a hard dark background. Their stack
// headers opt into the expo-router `headerUserInterfaceStyle` patch per screen;
// this only keeps the tab chrome visually aligned with the focused route.
const DARK_PATHNAMES = new Set([
  '/cube',
  '/shader-lens',
  '/neural-lens',
  '/lidar-depth-webxr',
  '/panoramic-scene-capture',
]);

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
