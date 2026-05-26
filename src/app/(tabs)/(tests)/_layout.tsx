import { Stack } from 'expo-router';
import { Platform } from 'react-native';

export const unstable_settings = {
  initialRouteName: 'run-tests',
};

export default function TestsStackLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        // The web build paints the page title inside the AppTabs floating
        // header, so the per-screen Stack header is hidden on web only.
        headerShown: Platform.OS !== 'web',
      }}>
      <Stack.Screen name="run-tests" options={{ title: 'Tests' }} />
    </Stack>
  );
}
