// Sandbox bootstrap. Loaded as an EXTERNAL script (script-src 'self' allows it
// even under the strict extension-pages CSP); the eval of the decrypted admin
// bundle needs the relaxed sandbox CSP (see manifest content_security_policy.sandbox).
(function () {
  window.addEventListener('message', function (ev) {
    var m = ev.data || {};
    if (m.type === 'run') {
      document.getElementById('astyle').textContent = m.css || '';
      try { (0, eval)(m.code); } // eslint-disable-line no-eval
      catch (e) { document.getElementById('root').textContent = 'admin eval error: ' + (e && e.message); }
      parent.postMessage({ type: 'admin-ready' }, '*');
    } else if (m.type === 'data') {
      if (typeof window.renderAdmin === 'function') window.renderAdmin(m.payload);
    }
  });
  parent.postMessage({ type: 'sandbox-loaded' }, '*');
})();
