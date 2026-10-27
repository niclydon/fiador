// The explainer page at `/` (SPEC 4.2). A verify surface under the
// standing both-themes rule: light and dark both ship, the first
// visit follows prefers-color-scheme, a visible toggle switches,
// and the choice persists (localStorage). Its badge examples are
// live calls to this service's own badge routes for a synthetic
// example subject, each labelled with the theme it is fixed to,
// plus one auto example, so the page is its own theme documentation.

export function explainerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fiador badge: what it means</title>
<style>
  :root { --bg:#ffffff; --fg:#1c1c1e; --muted:#6e6e73; --card:#f5f5f7; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0a0b13; --fg:#f5f5f7; --muted:#9aa0a6; --card:#1c1c1e; }
  }
  :root[data-theme="light"] { --bg:#ffffff; --fg:#1c1c1e; --muted:#6e6e73; --card:#f5f5f7; }
  :root[data-theme="dark"] { --bg:#0a0b13; --fg:#f5f5f7; --muted:#9aa0a6; --card:#1c1c1e; }
  body { background:var(--bg); color:var(--fg); font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif; margin:2rem auto; max-width:44rem; padding:0 1rem; line-height:1.55; }
  .muted { color:var(--muted); }
  .card { background:var(--card); border-radius:12px; padding:1rem 1.25rem; margin:1rem 0; }
  pre { overflow-x:auto; background:var(--card); padding:0.75rem 1rem; border-radius:8px; }
  button { font:inherit; padding:0.35rem 0.9rem; border-radius:999px; border:1px solid var(--muted); background:transparent; color:var(--fg); cursor:pointer; }
  img.badge { vertical-align:middle; }
</style>
</head>
<body>
<header>
  <h1>What the Fiador badge means</h1>
  <button id="theme-toggle" type="button">Switch theme</button>
</header>
<p>A Fiador badge names the subject in its URL and shows when its
status was checked. A verified wallet badge means that wallet was
registered in AgentBook on World Chain when checked. A Discord
application badge stays neutral even when its operator's wallet
passes: the check does not prove that signer controls the named
application. It does not endorse a bot or prove who wrote a message.</p>
<p>Copying a badge URL to a different bot's page still reports the
original subject. Copying the image file is only a stale screenshot;
the check time printed on the pill says how stale. Grey does not
always mean a claim failed. A valid operator claim stays grey on a
Discord application badge because control of that app has not been
confirmed. Unregistered, invalid, and incomplete checks also use
neutral artwork. Expired claims have their own muted style.</p>
<div class="card">
  <p>Live examples, for a synthetic example subject (it is not
  registered, so these honestly render <em>not verified</em>):</p>
  <p>Fixed dark: <img class="badge" alt="badge fixed to dark theme" src="/badge/discord_application/example.svg?theme=dark"></p>
  <p>Fixed light: <img class="badge" alt="badge fixed to light theme" src="/badge/discord_application/example.svg?theme=light"></p>
  <p>Auto (your system setting decides, inside the file): <img class="badge" alt="badge with automatic theme" src="/badge/discord_application/example.svg?theme=auto"></p>
</div>
<h2>Embed it</h2>
<p>On an HTML page, prefer a <code>&lt;picture&gt;</code> element so
the page's own context chooses between the two fixed renderings:</p>
<pre>&lt;picture&gt;
  &lt;source media="(prefers-color-scheme: dark)" srcset="/badge/discord_application/APP_ID.svg?theme=dark"&gt;
  &lt;img alt="Fiador badge" src="/badge/discord_application/APP_ID.svg?theme=light"&gt;
&lt;/picture&gt;</pre>
<p>In Markdown and other image-only surfaces, use the auto SVG; the
file itself switches with the viewer's system setting:</p>
<pre>![Fiador badge](/badge/discord_application/APP_ID.svg?theme=auto)</pre>
<p class="muted">Machine-readable status, in the public shape only,
is at <code>/v1/status/:subjectType/:subjectId</code>. The badge
image itself carries no human identifier, no hash, and no wallet
address: state, palette, and check time only.</p>
<script>
  (function () {
    var stored = null;
    try { stored = localStorage.getItem('fiador-badge-theme'); } catch (e) {}
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
    }
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      if (!current) {
        current = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('fiador-badge-theme', next); } catch (e) {}
    });
  })();
</script>
</body>
</html>
`;
}
