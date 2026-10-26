import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { showMode } from '../src/modes.js';

const html = readFileSync(new URL('../verify/index.html', import.meta.url), 'utf8');

describe('HTML input modes', () => {
  it('disables hidden invalid controls so the selected mode can submit', () => {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const form = document.getElementById('check-form') as HTMLFormElement;
    const application = document.getElementById('application-id') as HTMLInputElement;
    const url = document.getElementById('attestation-url') as HTMLInputElement;
    const payload = document.getElementById('payload') as HTMLTextAreaElement;
    const file = document.getElementById('payload-file') as HTMLInputElement;

    application.value = 'invalid application id';
    url.value = 'not a URL';
    showMode(document);
    expect(form.checkValidity()).toBe(false);
    expect(application.disabled).toBe(false);
    expect(url.disabled).toBe(true);

    (document.querySelector('input[name="mode"][value="paste"]') as HTMLInputElement).checked = true;
    showMode(document);
    expect(application.disabled).toBe(true);
    expect(url.disabled).toBe(true);
    expect(payload.disabled).toBe(false);
    expect(file.disabled).toBe(false);
    expect(form.checkValidity()).toBe(true);

    (document.getElementById('mode-url-choice') as HTMLInputElement).checked = true;
    showMode(document);
    expect(application.disabled).toBe(true);
    expect(url.disabled).toBe(false);
    expect(payload.disabled).toBe(true);
    expect(form.checkValidity()).toBe(false);
  });
});
