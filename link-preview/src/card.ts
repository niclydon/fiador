// The /v/ card (DESIGN §6.4): a 1200×630 SVG rendered in the Nova Glass
// language, colours and states matching the §6.2 badge set. One designed
// artifact, no theme variant (the page it leads to is both-modes, §6.0).
//
// Rendering discipline: every interpolated string is XML-escaped, the
// operator display name appears only when the attestation carries it
// (the §3.1.1 opt-in), and no address beyond the verify core's own
// truncated form — and no humanId in any form — is ever drawn here.

export type CardState =
  | 'verified'
  | 'claim_unconfirmed'
  | 'expired'
  | 'unverified'
  | 'revoked'
  | 'not_found'
  | 'could_not_check';

export const DESCRIPTOR = 'Fiador — human-backed attestation for Discord bots';

// Nova Glass tokens (§5.3).
export const TOKENS = {
  starfield: '#0A0B13',
  graphite: '#1C1C1E',
  cerulean: '#4A7FA5',
  labelCyan: '#8ABAD3',
  eyeGold: '#D4A55D',
  amber: '#C9933A',
  grey: '#8A8F98',
  revoked: '#B5534D',
  text: '#EDEFF2',
} as const;

export const STATE_WORD: Record<CardState, string> = {
  verified: 'Verified',
  claim_unconfirmed: 'Claim unconfirmed',
  expired: 'Expired',
  unverified: 'Not verified',
  revoked: 'Revoked',
  not_found: 'Attestation not found',
  could_not_check: 'Could not check',
};

export const DEFAULT_VERDICT: Record<CardState, string> = {
  verified: 'Verified: a unique human backs this Discord application.',
  claim_unconfirmed:
    'Wallet signature and AgentBook registration passed; Discord application control is not established.',
  expired: 'This attestation has expired and no longer verifies.',
  unverified: 'This attestation does not currently verify.',
  revoked: 'This attestation has been revoked by its operator.',
  not_found: 'No attestation in the Fiador registry matches this link.',
  could_not_check:
    'The check itself could not be completed at crawl time. This is not a verdict.',
};

export function stateAccent(state: CardState): string {
  switch (state) {
    case 'verified':
      return TOKENS.eyeGold;
    case 'expired':
    case 'could_not_check':
      return TOKENS.amber;
    case 'revoked':
      return TOKENS.revoked;
    default:
      return TOKENS.grey;
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** '2026-10-26T04:00:00.000Z' -> '2026-10-26 04:00:00 UTC' */
export function formatChecked(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
}

/** Greedy word wrap at a character budget (SVG text has no auto-wrap). */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.slice(0, 3);
}

/**
 * The eye glyph, drawn from primitives only (no external assets): an
 * almond outline, a pupil, and — for verified — a gold check through it.
 * `dim` renders the closed/struck variant used by the failure states.
 */
function eyeGlyph(cx: number, cy: number, state: CardState): string {
  const accent = stateAccent(state);
  const parts: string[] = [];
  parts.push(
    `<path d="M ${cx - 95} ${cy} Q ${cx} ${cy - 72} ${cx + 95} ${cy} Q ${cx} ${cy + 72} ${cx - 95} ${cy} Z" fill="none" stroke="${accent}" stroke-width="7"/>`,
  );
  if (state === 'revoked') {
    parts.push(
      `<line x1="${cx - 105}" y1="${cy + 58}" x2="${cx + 105}" y2="${cy - 58}" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>`,
    );
    parts.push(`<circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="${accent}" stroke-width="6"/>`);
  } else if (state === 'not_found' || state === 'could_not_check') {
    parts.push(
      `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="52" fill="${accent}">?</text>`,
    );
  } else {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="30" fill="${accent}"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="13" fill="${TOKENS.starfield}"/>`);
    if (state === 'verified') {
      parts.push(
        `<path d="M ${cx - 21} ${cy + 2} L ${cx - 6} ${cy + 17} L ${cx + 23} ${cy - 15}" fill="none" stroke="${TOKENS.starfield}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  }
  return parts.join('\n      ');
}

export interface CardOptions {
  applicationName?: string;
  /** Shown ONLY when the attestation itself carries it (opt-in, §3.1.1). */
  operatorDisplayName?: string;
  /** ISO 8601 crawl time; the card carries it because previews go stale. */
  checkedAt: string;
  /** Overrides the state's default verdict sentence. */
  verdict?: string;
}

export function renderCard(state: CardState, opts: CardOptions): string {
  const accent = stateAccent(state);
  const verdict = opts.verdict ?? DEFAULT_VERDICT[state];
  const verdictLines = wrapText(verdict, 52);
  const appName = opts.applicationName ?? 'Discord application';

  const textBlock: string[] = [];
  let y = 218;
  textBlock.push(
    `<text x="400" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="27" letter-spacing="3" fill="${TOKENS.labelCyan}">FIADOR</text>`,
  );
  y += 78;
  textBlock.push(
    `<text x="400" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="76" font-weight="bold" fill="${accent}">${escapeXml(STATE_WORD[state])}</text>`,
  );
  y += 58;
  textBlock.push(
    `<text x="400" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="${TOKENS.text}">${escapeXml(appName)}</text>`,
  );
  if (opts.operatorDisplayName) {
    y += 40;
    textBlock.push(
      `<text x="400" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="${TOKENS.labelCyan}">Operator (self-asserted): ${escapeXml(opts.operatorDisplayName)}</text>`,
    );
  }
  y += 52;
  for (const line of verdictLines) {
    textBlock.push(
      `<text x="400" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="25" fill="${TOKENS.text}">${escapeXml(line)}</text>`,
    );
    y += 34;
  }

  // A sparse field of stars on the starfield ground, positions fixed so
  // the card is deterministic for a given verdict.
  const stars = [
    [90, 80], [210, 500], [1080, 90], [1140, 540], [60, 330],
    [1010, 560], [1150, 200], [150, 140], [980, 60], [40, 560],
  ]
    .map(
      ([sx, sy]) =>
        `<circle cx="${sx}" cy="${sy}" r="2" fill="${TOKENS.labelCyan}" opacity="0.5"/>`,
    )
    .join('\n      ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(`Fiador: ${STATE_WORD[state]}`)}">
  <rect width="1200" height="630" fill="${TOKENS.starfield}"/>
      ${stars}
  <rect x="56" y="56" width="1088" height="518" rx="26" fill="${TOKENS.graphite}" stroke="${TOKENS.cerulean}" stroke-width="2"/>
      ${eyeGlyph(228, 300, state)}
      ${textBlock.join('\n      ')}
  <text x="400" y="520" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="${TOKENS.labelCyan}">${escapeXml(DESCRIPTOR)}</text>
  <text x="1144" y="520" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="${TOKENS.grey}">Checked ${escapeXml(formatChecked(opts.checkedAt))}</text>
</svg>`;
}
