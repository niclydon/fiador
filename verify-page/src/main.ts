import { createVerifier } from '@fiador/verify';
import { worldchain } from 'viem/chains';
import { normalizeEntries, type RegistryEntry } from '../../link-preview/src/registry.js';
import { checkAttestation, stateResult, type PageResult, type ResultState } from './check.js';
import { selectedMode, showMode } from './modes.js';

const MAX_JSON_BYTES = 64 * 1024;
const THEME_KEY = 'fiador-theme';
const stateAssets: Record<ResultState, string> = {
  claim_unconfirmed: 'unverified',
  expired: 'expired',
  unverified: 'unverified',
  revoked: 'unverified',
  not_found: 'unverified',
  could_not_check: 'unverified',
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing page element: ${id}`);
  return found as T;
}

function publicUrl(value: string): string {
  if (value.length > 2048) throw new Error('The URL is longer than 2,048 characters.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a complete HTTPS URL.'); }
  const localPreview = url.origin === location.origin &&
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if ((!localPreview && url.protocol !== 'https:') || url.username || url.password || url.hash) {
    throw new Error('Use an HTTPS URL without credentials or a fragment.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // These are browser requests, not server-side fetches. Still avoid
  // automatically probing obvious private targets from a shared link.
  if (!localPreview && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host))) {
    throw new Error('Use a public HTTPS hostname, not a local or IP address.');
  }
  return url.href;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'omit',
    mode: 'cors',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error(`The host returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_JSON_BYTES) throw new Error('The JSON file is larger than 64 KiB.');
  if (!response.body) throw new Error('The host returned an empty body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw new Error('The JSON file is larger than 64 KiB.');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try { return JSON.parse(body) as unknown; }
  catch { throw new Error('The host did not return valid JSON.'); }
}

function entryForId(value: unknown, id: string): RegistryEntry | null {
  const entries = normalizeEntries(value as Parameters<typeof normalizeEntries>[0]);
  const matches = entries.filter((entry) => entry.discord_application_id === id);
  if (matches.length > 1) throw new Error('The registry has multiple entries for this application ID.');
  return matches[0] ?? null;
}

function entryForUrl(value: unknown, url: string): RegistryEntry | null {
  const entries = normalizeEntries(value as Parameters<typeof normalizeEntries>[0]);
  const matches = entries.filter((entry) => entry.attestation_url === url);
  if (matches.length > 1) throw new Error('The registry has multiple entries for this attestation URL.');
  return matches[0] ?? null;
}

function addField(list: HTMLElement, label: string, value: string | undefined): void {
  if (!value) return;
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  list.append(dt, dd);
}

function render(result: PageResult): void {
  const panel = element<HTMLElement>('result');
  const badge = element<HTMLImageElement>('result-badge');
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  badge.src = `/assets/badges/fiador-pill-${theme}-${stateAssets[result.state]}.svg`;
  badge.alt = `${result.heading} badge`;
  element<HTMLElement>('result-title').textContent = result.heading;
  element<HTMLElement>('result-verdict').textContent = result.verdict;
  element<HTMLElement>('result-note').textContent = result.note ?? '';
  const fields = element<HTMLElement>('result-fields');
  fields.replaceChildren();
  addField(fields, 'Application', result.applicationName);
  addField(fields, 'Application ID', result.applicationId);
  addField(fields, 'Bot user ID', result.botUserId);
  addField(fields, 'Wallet', result.addressTruncated);
  addField(fields, 'Human hash', result.humanHashTruncated);
  addField(fields, 'Expires', result.expiresAt);
  addField(fields, 'Operator (self-asserted)', result.operatorName);
  addField(fields, result.state === 'could_not_check' ? 'Attempted at' : 'Checked at', result.checkedAt);
  panel.dataset.state = result.state;
  panel.hidden = false;
  element<HTMLElement>('status').textContent = `${result.heading}. ${result.verdict}`;
}

function updateTheme(theme: 'light' | 'dark', persist: boolean): void {
  document.documentElement.dataset.theme = theme;
  element<HTMLButtonElement>('theme-toggle').textContent = `Use ${theme === 'dark' ? 'light' : 'dark'} mode`;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private browsing */ }
  }
  const panel = element<HTMLElement>('result');
  if (!panel.hidden) {
    const badge = element<HTMLImageElement>('result-badge');
    const state = panel.dataset.state as ResultState;
    badge.src = `/assets/badges/fiador-pill-${theme}-${stateAssets[state]}.svg`;
  }
}

async function runCheck(): Promise<void> {
  const run = ++currentRun;
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  const status = element<HTMLElement>('status');
  const button = element<HTMLButtonElement>('check-button');
  button.disabled = true;
  status.textContent = 'Checking…';
  element<HTMLElement>('result').hidden = true;
  try {
    const rpcUrl = publicUrl(element<HTMLInputElement>('rpc-url').value.trim());
    const mode = selectedMode(document);
    let attestation: unknown;
    let entry: RegistryEntry | null = null;
    let fetchedUrl: string | undefined;
    let registryChecked = false;
    if (mode === 'application') {
      const registryUrl = publicUrl(element<HTMLInputElement>('registry-url').value.trim());
      const id = element<HTMLInputElement>('application-id').value.trim();
      if (!/^\d{17,20}$/.test(id)) throw new Error('Enter a 17–20 digit Discord application ID.');
      const registry = await fetchJson(registryUrl, controller.signal);
      entry = entryForId(registry, id);
      if (!entry) { render(stateResult('not_found', 'No attestation in this registry matches that application ID.')); return; }
      if (entry.status === 'revoked') { render(stateResult('revoked', 'This registry entry has been revoked by its operator.')); return; }
      fetchedUrl = publicUrl(entry.attestation_url);
      registryChecked = true;
      attestation = await fetchJson(fetchedUrl, controller.signal);
    } else if (mode === 'url') {
      const registryUrl = publicUrl(element<HTMLInputElement>('registry-url').value.trim());
      fetchedUrl = publicUrl(element<HTMLInputElement>('attestation-url').value.trim());
      const registry = await fetchJson(registryUrl, controller.signal);
      entry = entryForUrl(registry, fetchedUrl);
      if (entry?.status === 'revoked') { render(stateResult('revoked', 'This registry entry has been revoked by its operator.')); return; }
      registryChecked = entry !== null;
      attestation = await fetchJson(fetchedUrl, controller.signal);
    } else {
      const payload = element<HTMLTextAreaElement>('payload').value;
      if (new TextEncoder().encode(payload).byteLength > MAX_JSON_BYTES) throw new Error('The pasted JSON is larger than 64 KiB.');
      try { attestation = JSON.parse(payload) as unknown; }
      catch { throw new Error('Paste a valid signed attestation JSON document.'); }
    }
    const verifier = createVerifier({ rpcUrl });
    const result = await checkAttestation({
      attestation,
      verifier,
      ...(entry ? { entry } : {}),
      ...(fetchedUrl ? { fetchedUrl } : {}),
      registryChecked,
      signal: controller.signal,
    });
    if (run === currentRun) render(result);
  } catch (error) {
    if (run !== currentRun) return;
    const message = error instanceof Error ? error.message : 'The check could not complete.';
    const safeMessage = error instanceof TypeError
      ? 'The browser could not fetch a required file. The host may be unreachable or may block cross-origin requests; try the paste mode.'
      : message;
    render(stateResult('could_not_check', safeMessage));
  } finally {
    if (run === currentRun) button.disabled = false;
  }
}

let currentRun = 0;
let currentController: AbortController | null = null;

try {
  const saved = localStorage.getItem(THEME_KEY);
  updateTheme(saved === 'light' || saved === 'dark'
    ? saved
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
} catch {
  updateTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', false);
}
element<HTMLButtonElement>('theme-toggle').addEventListener('click', () => {
  updateTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
});
document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => radio.addEventListener('change', () => showMode(document)));
showMode(document);
element<HTMLFormElement>('check-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runCheck();
});
element<HTMLInputElement>('registry-url').value = new URL('/registry.json', location.origin).href;
element<HTMLInputElement>('rpc-url').value = worldchain.rpcUrls.default.http[0] ?? '';
const file = element<HTMLInputElement>('payload-file');
file.addEventListener('change', async () => {
  const selected = file.files?.[0];
  if (!selected) return;
  if (selected.size > MAX_JSON_BYTES) {
    render(stateResult('could_not_check', 'The selected JSON file is larger than 64 KiB.'));
    return;
  }
  element<HTMLTextAreaElement>('payload').value = await selected.text();
});
const drop = element<HTMLElement>('mode-paste');
drop.addEventListener('dragover', (event) => { event.preventDefault(); });
drop.addEventListener('drop', async (event) => {
  event.preventDefault();
  const selected = event.dataTransfer?.files[0];
  if (!selected) return;
  if (!selected.name.toLowerCase().endsWith('.json') || selected.size > MAX_JSON_BYTES) {
    render(stateResult('could_not_check', 'Drop a .json file no larger than 64 KiB.'));
    return;
  }
  element<HTMLTextAreaElement>('payload').value = await selected.text();
});

// /v/ redirects here with this parameter. Opening the page starts a fresh
// browser check; no crawler verdict is trusted or copied into the UI.
const prefilled = new URL(location.href).searchParams.get('attestation');
if (prefilled !== null) {
  element<HTMLInputElement>('mode-url-choice').checked = true;
  element<HTMLInputElement>('attestation-url').value = prefilled;
  showMode(document);
  void runCheck();
}
