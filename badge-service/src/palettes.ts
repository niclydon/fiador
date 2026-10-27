// Canonical badge palettes, ported from the static badge set in
// assets/badges/ (fiador-{pill,icon}-{dark,light}-{verified,expired,
// unverified}.svg). Those files are the visual authority (SPEC 4.3:
// the service's renderer ports the canonical colour tables, it does
// not re-pick colours). Every state ships in both themes, designed
// and checked, never one derived as an afterthought (standing rule,
// SPEC section 4 preamble).

import type { VerificationStatus } from '@fiador/verify';

export type BadgeState = 'verified' | 'expired' | 'unverified';
export type ThemeName = 'dark' | 'light';
export type BadgeVariant = 'pill' | 'icon';

export interface PillPalette {
  bg: string;
  border: string;
  ring: string;
  dot: string;
  label: string;
  labelText: string;
  /** Muted colour for the "expired" tag and the check-time text. */
  muted: string;
}

export interface IconPalette {
  bg: string;
  border: string;
  ring: string;
  dot: string;
}

export const PILL_PALETTES: Record<ThemeName, Record<BadgeState, PillPalette>> = {
  dark: {
    verified: {
      bg: '#1C1C1E',
      border: '#4A7FA5',
      ring: '#D4A55D',
      dot: '#FDE1A0',
      label: '#8ABAD3',
      labelText: 'fiador',
      muted: '#7d838a',
    },
    expired: {
      bg: '#1C1C1E',
      border: '#3f3f44',
      ring: '#8a6f45',
      dot: '#a5875c',
      label: '#7d838a',
      labelText: 'fiador',
      muted: '#7d838a',
    },
    unverified: {
      bg: '#1C1C1E',
      border: '#3a3d42',
      ring: '#6b7280',
      dot: '#6b7280',
      label: '#9aa0a6',
      labelText: 'not verified',
      muted: '#7d838a',
    },
  },
  light: {
    verified: {
      bg: '#FFFFFF',
      border: '#4A7FA5',
      ring: '#C9933A',
      dot: '#C9933A',
      label: '#1C1C1E',
      labelText: 'fiador',
      muted: '#6e6e73',
    },
    expired: {
      bg: '#FFFFFF',
      border: '#b9b9be',
      ring: '#a08b62',
      dot: '#a08b62',
      label: '#6e6e73',
      labelText: 'fiador',
      muted: '#6e6e73',
    },
    unverified: {
      bg: '#FFFFFF',
      border: '#c2c5ca',
      ring: '#9a9ea6',
      dot: '#9a9ea6',
      label: '#6e6e73',
      labelText: 'not verified',
      muted: '#6e6e73',
    },
  },
};

export const ICON_PALETTES: Record<ThemeName, Record<BadgeState, IconPalette>> = {
  dark: {
    verified: { bg: '#0A0B13', border: '#4A7FA5', ring: '#D4A55D', dot: '#FDE1A0' },
    expired: { bg: '#0A0B13', border: '#2c2f36', ring: '#8a6f45', dot: '#a5875c' },
    unverified: { bg: '#0A0B13', border: '#2c2f36', ring: '#6b7280', dot: '#6b7280' },
  },
  light: {
    verified: { bg: '#FFFFFF', border: '#d7d7dc', ring: '#C9933A', dot: '#C9933A' },
    expired: { bg: '#FFFFFF', border: '#d7d7dc', ring: '#a08b62', dot: '#a08b62' },
    unverified: { bg: '#FFFFFF', border: '#d7d7dc', ring: '#9a9ea6', dot: '#9a9ea6' },
  },
};

/** Dynamic pill widths (SPEC 4.4: the static pill's layout on the
 * left, extended to carry the visible check time on the right). */
export const PILL_WIDTHS: Record<BadgeState, number> = {
  verified: 208,
  unverified: 232,
  expired: 288,
};
export const PILL_HEIGHT = 28;
export const ICON_SIZE = 64;

/** SPEC 4.3 mapping. Only `verified` ever renders the verified
 * design; a check that did not complete is grey, with no exceptions. */
export function stateForStatus(status: VerificationStatus): BadgeState {
  if (status === 'verified') return 'verified';
  if (status === 'expired') return 'expired';
  return 'unverified';
}
