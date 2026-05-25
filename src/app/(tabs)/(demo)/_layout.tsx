import { Stack } from 'expo-router';

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
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ title: 'Demos' }} />
      <Stack.Screen
        name="cube"
        options={{
          title: 'WebGPU Demo',
          ...DARK_DEMO_HEADER_OPTIONS,
        }}
      />
      <Stack.Screen
        name="shader-lens"
        options={{
          title: 'Shader Lens',
          ...DARK_DEMO_HEADER_OPTIONS,
        }}
      />
      <Stack.Screen
        name="neural-lens"
        options={{
          title: 'Neural Lens',
          ...DARK_DEMO_HEADER_OPTIONS,
        }}
      />
    </Stack>
  );
}
