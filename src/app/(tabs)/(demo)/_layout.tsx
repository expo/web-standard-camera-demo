import { Stack } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index',
};

// The cube screen is rendered on a dark WebGPU clear color, so it keeps a
// light transparent header. Other demo routes use the current app theme.
const DARK_BG = '#0a0e1a';
const LIGHT_TINT = '#f8fafc';

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
          headerTransparent: true,
          headerTintColor: LIGHT_TINT,
          headerLargeTitleStyle: { color: LIGHT_TINT },
          headerStyle: { backgroundColor: 'transparent' },
          headerTitleStyle: { color: LIGHT_TINT },
          contentStyle: { backgroundColor: DARK_BG },
        }}
      />
      <Stack.Screen name="lfm2-vl" options={{ title: 'LFM2-VL' }} />
    </Stack>
  );
}
