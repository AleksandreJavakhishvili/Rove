import { useColorScheme } from '@/hooks/use-color-scheme';
import { themes, type Theme } from './tokens';

/**
 * Returns the active theme based on the system color scheme. The single
 * hook to call in every component that needs colors.
 *
 * Usage:
 *   const t = useTheme();
 *   <View style={{ backgroundColor: t.surface.base }} />
 */
export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? themes.dark : themes.light;
}
