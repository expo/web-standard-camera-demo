import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { CameraProvider } from '@/contexts/CameraContext';

// @ref LLP 0007 — Install navigator.mediaDevices polyfill before any screen renders.
import { installNavigatorMediaDevices } from '../../modules/standard-camera';
installNavigatorMediaDevices();

export default function RootLayout(): React.JSX.Element {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <CameraProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
        </Stack>
      </CameraProvider>
    </ThemeProvider>
  );
}
