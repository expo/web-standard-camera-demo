import { Stack } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'cube',
};

// The demo screen is always rendered on a dark background (the WebGPU clear
// color matches), so the header tints are forced light regardless of the
// system color scheme — a system-default dark title would be unreadable on
// the dark canvas backdrop.
const DARK_BG = '#0a0e1a';
const LIGHT_TINT = '#f8fafc';

export default function DemoStackLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        headerTransparent: true,
        headerTintColor: LIGHT_TINT,
        headerLargeTitleStyle: { color: LIGHT_TINT },
        headerTitleStyle: { color: LIGHT_TINT },
        contentStyle: { backgroundColor: DARK_BG },
      }}>
      <Stack.Screen name="cube" options={{ title: 'WebGPU Demo' }} />
    </Stack>
  );
}
