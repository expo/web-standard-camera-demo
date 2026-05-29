import { type ConfigContext, type ExpoConfig } from 'expo/config';

// Dynamic layer over app.json. Stamps the JS bundle with the time
// app.config.ts was evaluated, which is when Metro generated the
// manifest (dev) or when the EXConstants build phase ran during
// xcodebuild (release / dev-client native build). Surfaced at runtime
// via Constants.expoConfig.extra.jsBuildTime.
//
// The CFBundleVersion bump is handled by the with-bump-ios-build-number
// plugin via an Xcode Run Script build phase, not from this file —
// app.config.ts is evaluated on every Metro start and would over-bump
// if it touched the counter.

export default ({ config }: ConfigContext): ExpoConfig => {
  return {
    ...config,
    name: config.name ?? 'Standard Camera Demo',
    slug: config.slug ?? 'standard-camera-demo',
    plugins: [
      ...(config.plugins ?? []),
      './plugins/with-bundled-tfjs-model',
      './plugins/with-bump-ios-build-number',
    ],
    extra: {
      ...config.extra,
      jsBuildTime: Date.now(),
    },
  };
};
