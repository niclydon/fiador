export type InputMode = 'application' | 'url' | 'paste';

export function selectedMode(root: Document): InputMode {
  const value = root.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value;
  return value === 'url' || value === 'paste' ? value : 'application';
}

/** Hidden controls must also be disabled so HTML validation ignores them. */
export function showMode(root: Document): void {
  const active = selectedMode(root);
  for (const mode of ['application', 'url', 'paste'] as const) {
    const panel = root.getElementById(`mode-${mode}`);
    if (!panel) throw new Error(`Missing input mode: ${mode}`);
    const inactive = mode !== active;
    panel.hidden = inactive;
    panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')
      .forEach((control) => { control.disabled = inactive; });
  }
}
