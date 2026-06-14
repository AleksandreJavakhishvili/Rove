import { Image, type ImageStyle, type StyleProp } from 'react-native';

import { brand } from '@/theme';

// Monochrome silhouette of the Claude sunburst, rasterized from
// assets/claude-code.svg. `tintColor` recolors the opaque pixels, so the same
// asset renders in any color — we default to the brand clay.
const SOURCE = require('../assets/images/claude-mark.png');

export function ClaudeMark({
  size = 14,
  color = brand.clay,
  style,
}: {
  /** Square edge length in px. */
  size?: number;
  color?: string;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={SOURCE}
      resizeMode="contain"
      accessibilityLabel="Claude"
      style={[{ width: size, height: size, tintColor: color }, style]}
    />
  );
}
