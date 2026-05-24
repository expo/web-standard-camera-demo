import { Stack } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'diagnostics',
};

export default function DiagnosticsStackLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
    </Stack>
  );
}
