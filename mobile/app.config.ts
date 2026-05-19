import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Overlay on top of app.json.
 *
 * `ROVE_WEB_BASE_URL` — base path for the static web export (e.g., `/<repo>/app/`
 * for GitHub Pages). Native builds leave it unset and serve from `/`.
 *
 * `reactCompiler` is force-disabled when building for web. React Compiler 0.0.x
 * mishandles a few react-native-web style memoizations and the resulting bundle
 * crashes during commit with "Failed to set an indexed property [0] on
 * 'CSSStyleDeclaration'". Native builds keep React Compiler on, where it works.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const baseUrl = process.env.ROVE_WEB_BASE_URL?.trim();
  const isWebBuild = Boolean(baseUrl);
  return {
    ...(config as ExpoConfig),
    experiments: {
      ...config.experiments,
      ...(baseUrl ? { baseUrl } : {}),
      ...(isWebBuild ? { reactCompiler: false } : {}),
    },
  };
};
