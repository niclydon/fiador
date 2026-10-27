// Badge rendering (SPEC 4.3-4.5). SVG is generated from templates
// with no external assets. PNG rasterises the exact explicit-theme
// SVG the .svg route would serve for the resolved theme, at 3x,
// via @resvg/resvg-js (a pure-JS-distributed rasteriser over the
// resvg engine: no native build step, no second layout engine, so
// palette/layout parity with the SVG is by construction).

import { Resvg } from '@resvg/resvg-js';
import {
  ICON_PALETTES,
  ICON_SIZE,
  PILL_HEIGHT,
  PILL_PALETTES,
  PILL_WIDTHS,
  type BadgeState,
  type BadgeVariant,
  type IconPalette,
  type PillPalette,
  type ThemeName,
} from './palettes.js';

export type ThemeSelection = ThemeName | 'auto';

const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** SPEC 4.4: the visible check time is the bare time when the check
 * ran today (UTC), plus the date when it did not. */
export function formatCheckedLabel(checkedAtIso: string, now: Date): string {
  const checked = new Date(checkedAtIso);
  if (Number.isNaN(checked.getTime())) return 'checked unknown';
  const hh = String(checked.getUTCHours()).padStart(2, '0');
  const mm = String(checked.getUTCMinutes()).padStart(2, '0');
  const sameDay =
    checked.getUTCFullYear() === now.getUTCFullYear() &&
    checked.getUTCMonth() === now.getUTCMonth() &&
    checked.getUTCDate() === now.getUTCDate();
  if (sameDay) return `checked ${hh}:${mm} UTC`;
  const y = checked.getUTCFullYear();
  const mo = String(checked.getUTCMonth() + 1).padStart(2, '0');
  const d = String(checked.getUTCDate()).padStart(2, '0');
  return `checked ${y}-${mo}-${d} ${hh}:${mm} UTC`;
}

interface Slots {
  bg: string;
  border: string;
  ring: string;
  dot: string;
  label: string;
  muted: string;
}

function paintAttrs(
  palette: Record<string, string>,
  pairs: Array<[string, 'fill' | 'stroke']>,
  mode: 'attrs' | 'classes',
): string {
  if (mode === 'classes') {
    return `class="${pairs.map(([slot]) => `c-${slot}`).join(' ')}"`;
  }
  return pairs.map(([slot, kind]) => `${kind}="${palette[slot]}"`).join(' ');
}

function pillInner(p: PillPalette, state: BadgeState, checkedLabel: string, mode: 'attrs' | 'classes', labelOverride?: string): string {
  const width = labelOverride ? 280 : PILL_WIDTHS[state];
  const pal = p as unknown as Record<string, string>;
  const parts: string[] = [];
  parts.push(
    `<rect x="0.5" y="0.5" width="${width - 1}" height="27" rx="13.5" ${paintAttrs(pal, [['bg', 'fill'], ['border', 'stroke']], mode)}/>`,
  );
  parts.push(
    `<circle cx="15" cy="14" r="6.5" fill="none" ${paintAttrs(pal, [['ring', 'stroke']], mode)} stroke-width="2"/>` +
      `<circle cx="15" cy="14" r="2.6" ${paintAttrs(pal, [['dot', 'fill']], mode)}/>`,
  );
  parts.push(
    `<text x="30" y="18" font-family="${FONT}" font-size="12.5" letter-spacing="0.2" ${paintAttrs(pal, [['label', 'fill']], mode)}>${escapeXml(labelOverride ?? p.labelText)}</text>`,
  );
  if (state === 'expired') {
    parts.push(
      `<text x="${width - 104}" y="18" text-anchor="end" font-size="8.5" ${paintAttrs(pal, [['muted', 'fill']], mode)} font-family="${FONT}">expired</text>`,
    );
  }
  parts.push(
    `<text x="${width - 10}" y="18" text-anchor="end" font-size="8.5" ${paintAttrs(pal, [['muted', 'fill']], mode)} font-family="${FONT}">${escapeXml(checkedLabel)}</text>`,
  );
  return parts.join('');
}

function iconInner(p: IconPalette, mode: 'attrs' | 'classes'): string {
  const pal = p as unknown as Record<string, string>;
  return (
    `<rect x="0.5" y="0.5" width="63" height="63" rx="14" ${paintAttrs(pal, [['bg', 'fill'], ['border', 'stroke']], mode)}/>` +
    `<circle cx="32" cy="32" r="15" fill="none" ${paintAttrs(pal, [['ring', 'stroke']], mode)} stroke-width="2"/>` +
    `<circle cx="32" cy="32" r="6" ${paintAttrs(pal, [['dot', 'fill']], mode)}/>`
  );
}

function autoStyle(slotsFor: (t: ThemeName) => Slots): string {
  const light = slotsFor('light');
  const dark = slotsFor('dark');
  const rule = (s: Slots) =>
    `.c-bg{fill:${s.bg}}.c-border{stroke:${s.border}}.c-ring{stroke:${s.ring}}` +
    `.c-dot{fill:${s.dot}}.c-label{fill:${s.label}}.c-muted{fill:${s.muted}}`;
  // Light is the in-file fallback (no preference); dark applies via
  // the viewer's own prefers-color-scheme, inside the file (SPEC 4.2).
  return `<style>${rule(light)}@media (prefers-color-scheme: dark){${rule(dark)}}</style>`;
}

export function renderBadgeSvg(args: {
  state: BadgeState;
  theme: ThemeSelection;
  variant: BadgeVariant;
  checkedAt: string;
  now: Date;
  labelOverride?: string;
}): string {
  const { state, theme, variant, checkedAt, now, labelOverride } = args;
  const checkedLabel = formatCheckedLabel(checkedAt, now);
  const title = `fiador badge: ${labelOverride ?? state}, checked ${checkedAt}`;
  if (variant === 'icon') {
    const aria = 'fiador agent mark';
    if (theme === 'auto') {
      const style = autoStyle((t) => {
        const p = ICON_PALETTES[t][state];
        return { ...p, label: p.ring, muted: p.ring };
      });
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 64 64" role="img" aria-label="${aria}" data-checked-at="${escapeXml(checkedAt)}">` +
        `<title>${escapeXml(title)}</title>${style}${iconInner(ICON_PALETTES.light[state], 'classes')}</svg>`
      );
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 64 64" role="img" aria-label="${aria}" data-checked-at="${escapeXml(checkedAt)}">` +
      `<title>${escapeXml(title)}</title>${iconInner(ICON_PALETTES[theme][state], 'attrs')}</svg>`
    );
  }
  const width = labelOverride ? 280 : PILL_WIDTHS[state];
  const aria = labelOverride ?? (state === 'unverified' ? 'not verified' : 'fiador');
  if (theme === 'auto') {
    const style = autoStyle((t) => PILL_PALETTES[t][state]);
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_HEIGHT}" viewBox="0 0 ${width} 28" role="img" aria-label="${aria}" data-checked-at="${escapeXml(checkedAt)}">` +
      `<title>${escapeXml(title)}</title>${style}${pillInner(PILL_PALETTES.light[state], state, checkedLabel, 'classes', labelOverride)}</svg>`
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_HEIGHT}" viewBox="0 0 ${width} 28" role="img" aria-label="${aria}" data-checked-at="${escapeXml(checkedAt)}">` +
    `<title>${escapeXml(title)}</title>${pillInner(PILL_PALETTES[theme][state], state, checkedLabel, 'attrs', labelOverride)}</svg>`
  );
}

export function badgeSvgDimensions(state: BadgeState, variant: BadgeVariant, labelOverride?: string): { width: number; height: number } {
  if (variant === 'icon') return { width: ICON_SIZE, height: ICON_SIZE };
  return { width: labelOverride ? 280 : PILL_WIDTHS[state], height: PILL_HEIGHT };
}

/** Rasterise the resolved-theme SVG at 3x (SPEC 4.5: pill height
 * 84px, transparent margin zero, same layout, no redesign). */
export function renderBadgePng(args: {
  state: BadgeState;
  theme: ThemeName;
  variant: BadgeVariant;
  checkedAt: string;
  now: Date;
  labelOverride?: string;
}): Buffer {
  const svg = renderBadgeSvg({ ...args, theme: args.theme });
  const { width } = badgeSvgDimensions(args.state, args.variant, args.labelOverride);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 3 },
    font: { loadSystemFonts: true },
  });
  return Buffer.from(resvg.render().asPng());
}
