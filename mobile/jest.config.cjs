/**
 * Minimal jest config for pure-TS unit tests (e.g. the markdown parser).
 *
 * We deliberately do NOT pull in jest-expo / react-native here — tests under
 * `lib/**` are platform-agnostic logic with no React Native imports, so the
 * vanilla ts-jest preset keeps the test runner light and fast. If we add
 * component-level tests later, we'd configure a separate jest project with
 * the jest-expo preset.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/lib/**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          // tsx isn't needed for the pure-TS tests, but allowing it keeps the
          // config simple if a test file imports a `.ts` that pulls in shared
          // types from a `.tsx` neighbour.
          jsx: 'react-jsx',
          esModuleInterop: true,
          target: 'es2022',
          module: 'commonjs',
          moduleResolution: 'node',
          strict: true,
        },
      },
    ],
  },
};
