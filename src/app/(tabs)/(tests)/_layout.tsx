import { Stack } from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'run-tests',
};

export default function TestsStackLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
      }}>
      <Stack.Screen name="run-tests" options={{ title: 'Tests' }} />
    </Stack>
  );
}
