/* Runs synchronously in <head> (before first paint) so the saved theme never flashes.
   External file because the Content-Security-Policy forbids inline scripts. */
try {
  const saved = localStorage.getItem('urlpulse.theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch (e) {
  /* storage blocked: fall back to the OS preference */
}
