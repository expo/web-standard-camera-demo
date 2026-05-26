// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    rules: {
      // React Compiler is enabled for this app, but existing camera/demo code
      // still has effect-driven state and render-time instrumentation to migrate.
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    ignores: ["dist/*"],
  }
]);
