// Apply the saved theme before the page paints, to avoid a dark→light flash.
// Loaded as a blocking <script> in <head> (CSP 'self'; inline scripts are blocked).
try { if (localStorage.getItem('theme') === 'light') document.documentElement.classList.add('light'); } catch (e) {}
