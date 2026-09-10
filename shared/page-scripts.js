// Functions that run INSIDE the merchant page. They are serialized (executeScript / page.evaluate),
// so they must be fully self-contained: no imports, no closures over module scope.

/** Build a compact, model-readable snapshot of the current page. Tags interactive elements with data-wa-id. */
export function snapshotPage(opts) {
  opts = opts || {};
  var maxEl = opts.maxElements || 120, textChars = opts.textChars || 4000;
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function txt(el) {
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t && el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) t = el.value || '';
    return t.slice(0, 120);
  }
  var old = document.querySelectorAll('[data-wa-id]');
  for (var k = 0; k < old.length; k++) old[k].removeAttribute('data-wa-id');
  var sel = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="radio"],[role="checkbox"],[onclick],summary';
  var nodes = document.querySelectorAll(sel);
  var els = [], id = 0, vh = window.innerHeight;
  for (var i = 0; i < nodes.length && els.length < maxEl; i++) {
    var el = nodes[i];
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (el.closest('[data-wa-ignore]')) continue;
    if (!visible(el)) continue;
    var r = el.getBoundingClientRect();
    id++;
    el.setAttribute('data-wa-id', String(id));
    var e = { id: id, tag: el.tagName.toLowerCase(), text: txt(el) };
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (label) e.label = label.slice(0, 80);
    var role = el.getAttribute('role'); if (role) e.role = role;
    if (el.tagName === 'A' && el.href) e.href = String(el.href).slice(0, 200);
    if (el.tagName === 'INPUT') {
      e.type = el.type; if (el.name) e.name = el.name; if (el.placeholder) e.placeholder = el.placeholder;
      if (el.type !== 'password' && el.value) e.value = String(el.value).slice(0, 60);
      if (el.type === 'checkbox' || el.type === 'radio') { e.checked = !!el.checked; var lab = el.labels && el.labels[0]; if (lab && !e.text) e.text = (lab.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120); }
    }
    if (el.tagName === 'TEXTAREA') { if (el.name) e.name = el.name; if (el.placeholder) e.placeholder = el.placeholder; }
    if (el.tagName === 'SELECT') { e.value = el.value; e.options = Array.prototype.slice.call(el.options, 0, 20).map(function (o) { return o.text.slice(0, 40); }); }
    if (el.disabled) e.disabled = true;
    if (r.top > vh || r.bottom < 0) e.offscreen = true;
    els.push(e);
  }
  var body = document.body;
  var text = '';
  if (body) {
    var kids = body.children, parts = [];
    for (var c = 0; c < kids.length; c++) { if (!kids[c].hasAttribute('data-wa-ignore')) parts.push(kids[c].innerText || ''); }
    text = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }
  var hs = document.querySelectorAll('h1,h2,h3');
  var heads = [];
  for (var h = 0; h < hs.length && heads.length < 12; h++) { if (visible(hs[h])) { var ht = (hs[h].innerText || '').trim().slice(0, 100); if (ht) heads.push(ht); } }
  var prices = [];
  var re = /(?:US)?\$\s?(\d{1,4}(?:\.\d{2})?)\s*(?:\/|per\s*|a\s*)?\s*(month|mo\b|year|yr\b|annually|week|wk\b)?/gi;
  var m, g = 0;
  while ((m = re.exec(text)) && g++ < 100) prices.push({ amount: parseFloat(m[1]), unit: (m[2] || '').toLowerCase(), context: text.slice(Math.max(0, m.index - 70), m.index + 45).replace(/\n/g, ' ') });
  return { url: location.href, title: document.title, headings: heads, text: text.slice(0, textChars), textLength: text.length, hasPassword: !!document.querySelector('input[type="password"]'), prices: prices, elements: els, scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight, viewportHeight: vh };
}

/** Read the CURRENT text of a tagged element right before acting (guards against swapped buttons). */
export function readElement(id) {
  var el = document.querySelector('[data-wa-id="' + id + '"]');
  if (!el) return null;
  return { text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 160), type: el.type || '', name: el.name || '', tag: el.tagName.toLowerCase(), disabled: !!el.disabled };
}

/** Perform one in-page action. Returns {ok, note}. */
export function performAction(action) {
  function byId(id) { return document.querySelector('[data-wa-id="' + id + '"]'); }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  try {
    if (action.type === 'click' || action.type === 'accept_offer') {
      var el = byId(action.id); if (!el) return { ok: false, note: 'element not found' };
      var text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      el.scrollIntoView({ block: 'center' });
      if (el.tagName === 'LABEL') { var inp = el.control || el.querySelector('input'); if (inp) { inp.click(); return { ok: true, note: 'clicked label → ' + text }; } }
      el.click();
      return { ok: true, note: 'clicked "' + text + '"' };
    }
    if (action.type === 'type') {
      var t = byId(action.id); if (!t) return { ok: false, note: 'element not found' };
      if (t.type === 'password') return { ok: false, note: 'refused: password field' };
      t.focus();
      var proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(t, action.text || ''); else t.value = action.text || '';
      fire(t, 'input'); fire(t, 'change');
      return { ok: true, note: 'typed into ' + (t.name || t.placeholder || 'field') };
    }
    if (action.type === 'select') {
      var s = byId(action.id); if (!s || s.tagName !== 'SELECT') return { ok: false, note: 'select not found' };
      var want = String(action.value || '').toLowerCase();
      var opts = Array.prototype.slice.call(s.options);
      var o = null; for (var i = 0; i < opts.length; i++) { if (opts[i].value.toLowerCase() === want || opts[i].text.toLowerCase().indexOf(want) !== -1) { o = opts[i]; break; } }
      if (!o) return { ok: false, note: 'option not found' };
      s.value = o.value; fire(s, 'input'); fire(s, 'change');
      return { ok: true, note: 'selected ' + o.text };
    }
    if (action.type === 'scroll') {
      window.scrollBy({ top: (action.direction === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.8), behavior: 'instant' });
      return { ok: true, note: 'scrolled ' + (action.direction || 'down') };
    }
    return { ok: false, note: 'not an in-page action: ' + action.type };
  } catch (e) { return { ok: false, note: String((e && e.message) || e) }; }
}
