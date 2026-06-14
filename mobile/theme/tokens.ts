import { Platform } from 'react-native';

/**
 * Semantic design tokens for the Rove mobile app.
 *
 * Every visual decision (color, type, spacing, radius) should reference these
 * tokens rather than literal values. To re-skin the app, edit `light` / `dark`
 * below — no component code needs to change.
 */

export interface Theme {
  scheme: 'light' | 'dark';

  surface: {
    /** App background. */
    base: string;
    /** Cards, list items, raised surfaces. */
    raised: string;
    /** Inputs, code blocks — visually "below" the base. */
    sunken: string;
    /** Pressed state for interactive surfaces. */
    pressed: string;
    /** Modal scrim. */
    scrim: string;
  };

  text: {
    primary: string;
    secondary: string;
    muted: string;
    faint: string;
    placeholder: string;
    /** Text on top of `accent.primary`. */
    inverse: string;
  };

  border: {
    subtle: string;
    default: string;
    strong: string;
  };

  accent: {
    primary: string;
    pressed: string;
    fg: string;
  };

  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
    /** Subtle tinted backgrounds for status cards / chips. */
    successBg: string;
    warningBg: string;
    dangerBg: string;
    /** Strong tinted backgrounds for prominent error blocks. */
    dangerCardBg: string;
    warningCardBg: string;
    /** Text colors that pair with the warning card background. */
    warningCardFg: string;
  };

  bubble: {
    userBg: string;
    userFg: string;
    assistantBg: string;
    assistantFg: string;
  };

  code: {
    blockBg: string;
    inlineBg: string;
    fg: string;
    gutter: string;
    /** Syntax-highlight token colors, mapped from Prism token classes. */
    syntax: {
      keyword: string;
      string: string;
      comment: string;
      number: string;
      func: string;
      tag: string;
      attr: string;
      punctuation: string;
      operator: string;
      builtin: string;
      regex: string;
    };
  };

  diff: {
    addBg: string;
    addFg: string;
    removeBg: string;
    removeFg: string;
    contextFg: string;
  };

  sessionStatus: {
    /** Live, owned by our bridge. */
    bridge: string;
    /** Live, owned by a desktop terminal. */
    desktop: string;
    idle: string;
  };

  /** File-change operation indicators. */
  op: {
    add: string;
    change: string;
    unlink: string;
  };
}

const accent = '#0a7ea4';
const accentPressed = '#0066b0';

/**
 * Claude brand "clay" — the color of the sunburst mark. Fixed across themes
 * (it reads on both light and dark surfaces), so it lives outside `light`/`dark`.
 * Source: `--brand-clay: 14.8 63.1% 59.6%` (HSL) → #D97757.
 */
export const brand = { clay: '#D97757' } as const;

const dark: Theme = {
  scheme: 'dark',
  surface: {
    base: '#0b0c0e',
    raised: '#16181b',
    sunken: '#0f1115',
    pressed: '#1f2937',
    scrim: 'rgba(0,0,0,0.4)',
  },
  text: {
    primary: '#ECEDEE',
    secondary: '#9BA1A6',
    muted: '#666666',
    faint: '#444444',
    placeholder: '#555555',
    inverse: '#ffffff',
  },
  border: {
    subtle: '#1a1c1f',
    default: '#222222',
    strong: '#333333',
  },
  accent: {
    primary: accent,
    pressed: accentPressed,
    fg: '#ffffff',
  },
  status: {
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#dc2626',
    info: '#3b82f6',
    successBg: 'rgba(34,197,94,0.12)',
    warningBg: 'rgba(245,158,11,0.12)',
    dangerBg: 'rgba(220,38,38,0.12)',
    dangerCardBg: '#2a0e0e',
    warningCardBg: '#2a1d05',
    warningCardFg: '#fcd34d',
  },
  bubble: {
    userBg: '#1e3a5f',
    userFg: '#ECEDEE',
    assistantBg: '#16181b',
    assistantFg: '#ECEDEE',
  },
  code: {
    blockBg: '#0f1115',
    inlineBg: 'rgba(255,255,255,0.08)',
    fg: '#E2E4E7',
    gutter: '#555555',
    syntax: {
      keyword: '#c678dd',
      string: '#98c379',
      comment: '#7f848e',
      number: '#d19a66',
      func: '#61afef',
      tag: '#e06c75',
      attr: '#e5c07b',
      punctuation: '#abb2bf',
      operator: '#56b6c2',
      builtin: '#e5c07b',
      regex: '#98c379',
    },
  },
  diff: {
    addBg: 'rgba(34,197,94,0.12)',
    addFg: '#86efac',
    removeBg: 'rgba(239,68,68,0.12)',
    removeFg: '#fca5a5',
    contextFg: '#9BA1A6',
  },
  sessionStatus: {
    bridge: '#3b82f6',
    desktop: '#22c55e',
    idle: '#6b7280',
  },
  op: {
    add: '#22c55e',
    change: '#0a7ea4',
    unlink: '#ef4444',
  },
};

const light: Theme = {
  scheme: 'light',
  surface: {
    base: '#ffffff',
    raised: '#f3f4f6',
    sunken: '#f5f6f8',
    pressed: '#e5e7eb',
    scrim: 'rgba(0,0,0,0.4)',
  },
  text: {
    primary: '#11181C',
    secondary: '#555555',
    muted: '#888888',
    faint: '#aaaaaa',
    placeholder: '#aaaaaa',
    inverse: '#ffffff',
  },
  border: {
    subtle: '#eeeeee',
    default: '#dddddd',
    strong: '#cccccc',
  },
  accent: {
    primary: accent,
    pressed: accentPressed,
    fg: '#ffffff',
  },
  status: {
    success: '#16a34a',
    warning: '#d97706',
    danger: '#dc2626',
    info: '#2563eb',
    successBg: 'rgba(34,197,94,0.18)',
    warningBg: 'rgba(245,158,11,0.18)',
    dangerBg: 'rgba(220,38,38,0.18)',
    dangerCardBg: '#fee2e2',
    warningCardBg: '#fef3c7',
    warningCardFg: '#92400e',
  },
  bubble: {
    userBg: '#dbeafe',
    userFg: '#11181C',
    assistantBg: '#f3f4f6',
    assistantFg: '#11181C',
  },
  code: {
    blockBg: '#f5f6f8',
    inlineBg: 'rgba(0,0,0,0.06)',
    fg: '#22272e',
    gutter: '#aaaaaa',
    syntax: {
      keyword: '#a626a4',
      string: '#50a14f',
      comment: '#a0a1a7',
      number: '#986801',
      func: '#4078f2',
      tag: '#e45649',
      attr: '#c18401',
      punctuation: '#383a42',
      operator: '#0184bc',
      builtin: '#c18401',
      regex: '#50a14f',
    },
  },
  diff: {
    addBg: 'rgba(34,197,94,0.18)',
    addFg: '#166534',
    removeBg: 'rgba(239,68,68,0.18)',
    removeFg: '#991b1b',
    contextFg: '#555555',
  },
  sessionStatus: {
    bridge: '#2563eb',
    desktop: '#16a34a',
    idle: '#6b7280',
  },
  op: {
    add: '#16a34a',
    change: '#0a7ea4',
    unlink: '#dc2626',
  },
};

export const themes = { light, dark } as const;

/* ──────────────────────────────────────────────────────────────────────── */
/* Non-color tokens: typography, spacing, radii. Independent of color scheme. */

export const fontFamily = {
  sans: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' }) ?? 'System',
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) ?? 'monospace',
};

export const fontSize = {
  xs: 11,
  sm: 12,
  base: 13,
  md: 14,
  lg: 15,
  xl: 16,
  '2xl': 17,
  '3xl': 19,
  '4xl': 22,
};

export const lineHeight = {
  tight: 1.2,
  body: 1.45,
  relaxed: 1.6,
};

export const fontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

/** 4pt base scale. */
export const space = {
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  pill: 9999,
} as const;
