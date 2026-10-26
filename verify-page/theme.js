const themeButton = document.getElementById('theme-toggle');
function setTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = `Use ${theme === 'dark' ? 'light' : 'dark'} mode`;
  if (persist) {
    try { localStorage.setItem('fiador-theme', theme); } catch { /* private browsing */ }
  }
}
let saved;
try { saved = localStorage.getItem('fiador-theme'); } catch { /* private browsing */ }
setTheme(saved === 'light' || saved === 'dark'
  ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
themeButton.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
});
