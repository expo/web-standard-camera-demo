import Constants from 'expo-constants';

// Time the JS bundle was produced, baked into the bundle at build time
// by app.config.ts (extra.jsBuildTime = Date.now() evaluated when Metro
// generates the manifest in dev, or when `expo export:embed` runs the
// config in release). Used by the Diagnostics tab to answer "how old is
// the JS code on this device?". Falls back to load time when the field
// is missing — e.g. if app.config.ts was bypassed during a custom build.
export const JS_BUILD_TIME: number =
  (Constants.expoConfig?.extra?.jsBuildTime as number | undefined) ?? Date.now();
