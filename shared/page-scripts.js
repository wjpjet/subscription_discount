// Functions that run INSIDE the merchant page. They are serialized (executeScript / page.evaluate),
// so they must be fully self-contained: no imports, no closures over module scope, ES5 style.

/**
 * Build a compact, model-readable snapshot of the current page: visible text in priority order, prices, identity
 * hints and the interactive elements, tagged data-wa-id="<gen>:<id>" so readElement/performAction can find them.
 */
export function snapshotPage(opts) {
  opts = opts || {};
  var maxEl = opts.maxElements || 120, textChars = opts.textChars || 4000;
  var de = document.documentElement, body = document.body, vh = window.innerHeight, vw = window.innerWidth;
  var sx = window.scrollX || 0, sy = window.scrollY || 0, CV = typeof de.checkVisibility === 'function';
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function up(n) { return n.parentElement || (n.parentNode && n.parentNode.host) || null; }   // crosses shadow boundaries
  function ignored(el) { for (var n = el; n; n = up(n)) { if (n.hasAttribute && n.hasAttribute('data-wa-ignore')) return true; } return false; }

  // Every open shadow root (web components); queries below cover the document and all of them.
  var roots = [document];
  (function walk(root) { var all = root.querySelectorAll('*'); for (var i = 0; i < all.length; i++) { if (all[i].shadowRoot) { roots.push(all[i].shadowRoot); walk(all[i].shadowRoot); } } })(document);
  function qa(sel, lightOnly) { var out = [], n = lightOnly ? 1 : roots.length; for (var i = 0; i < n; i++) { var l = roots[i].querySelectorAll(sel); for (var j = 0; j < l.length; j++) out.push(l[j]); } return out; }

  // A new generation per snapshot, and old tags cleared everywhere (shadow roots too): an id from an older
  // snapshot can never resolve to a different element that happens to carry the same number.
  window.__waGenN = (window.__waGenN || 0) + 1;
  var gen = Date.now().toString(36) + window.__waGenN.toString(36);
  if (gen === de.getAttribute('data-wa-gen')) gen += 'b';
  var old = qa('[data-wa-id]'); for (var k = 0; k < old.length; k++) old[k].removeAttribute('data-wa-id');
  de.setAttribute('data-wa-gen', gen);

  // Visibility. Boxes under 2px or parked above/left of the document are skip links and screen-reader text.
  function boxOk(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right + sx <= 0 || r.bottom + sy <= 0) return null;
    if (CV) return el.checkVisibility({ visibilityProperty: true }) ? r : null;
    var s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' ? r : null;
  }
  function faded(el) { return CV ? !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : getComputedStyle(el).opacity === '0'; }

  // Open dialogs, topmost first: modal before non-modal, cookie/consent banners last, later in the DOM first.
  var DLG = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  var dl = qa(DLG), dlgs = [];
  for (var di = 0; di < dl.length; di++) {
    var d = dl[di]; if (ignored(d) || !boxOk(d)) continue;
    var dt = (d.innerText || '').slice(0, 600);
    var cookie = /\bcookies?\b|\bconsent\b/i.test(dt) && !/subscription|membership|cancel|billing|offer/i.test(dt);
    var modal = d.getAttribute('aria-modal') === 'true'; if (!modal && d.tagName === 'DIALOG') { try { modal = d.matches(':modal'); } catch (err) { modal = false; } }
    dlgs.push({ el: d, rank: (cookie ? 2 : 0) + (modal ? 0 : 1), i: di, cookie: cookie });
  }
  dlgs.sort(function (a, b) { return (a.rank - b.rank) || (b.i - a.i); });
  var dlgEls = []; for (var dj = 0; dj < dlgs.length; dj++) dlgEls.push(dlgs[dj].el);

  // Region of a node: dialog (0) > main (1) > page (2) > nav/header/footer/aside (3). The nearest landmark decides;
  // a <header>/<footer> only counts when it is top-level (not an article's or section's header).
  function sectioned(n) { for (var p = up(n); p; p = up(p)) { var t = p.tagName; if (t === 'ARTICLE' || t === 'SECTION' || t === 'MAIN' || t === 'ASIDE' || t === 'NAV' || p.getAttribute('role') === 'main') return true; } return false; }
  function where(el) {
    var near = '';
    for (var n = el; n && n.nodeType === 1; n = up(n)) {
      var dx = dlgEls.indexOf(n); if (dx !== -1) return ['dialog', dlgs[dx].cookie ? 0.5 : 0];
      if (near) continue;
      var t = n.tagName, role = n.getAttribute('role');
      if (t === 'MAIN' || role === 'main') near = 'main';
      else if (t === 'NAV' || t === 'ASIDE' || role === 'navigation' || role === 'complementary' || role === 'banner' || role === 'contentinfo') near = 'nav';
      else if ((t === 'HEADER' || t === 'FOOTER') && !sectioned(n)) near = 'nav';
    }
    return near === 'main' ? ['main', 1] : near === 'nav' ? ['nav', 3] : ['page', 2];
  }

  // ---- Interactive elements -------------------------------------------------------------------------------
  var SEL = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="radio"],[role="checkbox"],[role="option"],[role="switch"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="combobox"],[role="treeitem"],a:not([href])[tabindex],[onclick]';
  var GENERIC = '[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[contenteditable=""]';
  var NATIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"],[role="menuitem"],[role="tab"]';
  var HOLD = 'button,a[href],label,select,[role="button"],[role="link"],[role="option"],[role="menuitem"]';
  var cand = qa(SEL + ',' + GENERIC), info = [], nBox = 0, nFaded = 0;
  for (var ci = 0; ci < cand.length; ci++) {
    var ce = cand[ci];
    if ((ce.tagName === 'INPUT' && ce.type === 'hidden') || ignored(ce)) continue;
    var cr = boxOk(ce); if (!cr) continue;
    var cx = { el: ce, r: cr, faded: faded(ce), reg: where(ce) };
    nBox++; if (cx.faded && cx.reg[0] !== 'dialog') nFaded++;
    info.push(cx);
  }
  // An ancestor at opacity 0 usually means hidden; but when that would remove most of the page, an entrance
  // animation has stalled (background tabs don't run requestAnimationFrame), so the rule is dropped. Open dialogs
  // are exempt for the same reason: a fade-in modal is exactly what the flow is waiting on.
  var opacityFallback = nFaded * 2 > nBox;
  function shown(x) { return !x.faded || opacityFallback || x.reg[0] === 'dialog'; }
  function shownEl(el) { for (var q = 0; q < info.length; q++) { if (info[q].el === el) return shown(info[q]); } return false; }
  function smallLeaf(el) {   // a generic match counts only as a short leaf, never as a wrapper around real controls
    if (clean(el.innerText).length > 80) return false;
    var inner = el.querySelectorAll(NATIVE); for (var q = 0; q < inner.length; q++) { if (shownEl(inner[q])) return false; }
    return true;
  }
  var kept = [], keptEls = [];
  for (var ki = 0; ki < info.length; ki++) {
    var x = info[ki], el = x.el, ctl = null;
    if (!shown(x)) continue;
    if (el.tagName === 'LABEL') {
      // Custom radios/checkboxes hide the native input; the label is then the thing to click.
      ctl = el.control || el.querySelector('input:not([type="hidden"]),select,textarea');
      if (ctl && shownEl(ctl)) continue;
      if (!ctl && (getComputedStyle(el).cursor !== 'pointer' || !smallLeaf(el))) continue;   // a bare caption, not a control
    } else if (!el.matches(SEL) && !smallLeaf(el)) continue;
    var held = false;
    for (var p = up(el); p && !held; p = up(p)) { if (p.nodeType === 1 && p.matches(HOLD) && keptEls.indexOf(p) !== -1) held = true; }
    if (held) continue;
    x.ctl = ctl; x.i = kept.length; kept.push(x); keptEls.push(el);
  }
  kept.sort(function (a, b) { return (a.reg[1] - b.reg[1]) || (a.i - b.i); });
  // Which ones get an id: open dialogs first, then up to RES header/nav/page controls that name the account or sign
  // in/out (then billing/plan words), then the rest in order. Without the reserve a site root's long feed in <main>
  // fills the cap and the header's 'My Account' / 'Log out' / 'Log in' (the hop to the plan page) never make it.
  var RES = Math.min(15, Math.floor(maxEl / 5)), ACC1 = /account|profile|sign[ _-]?(in|out)|log[ _-]?(in|out)/i, ACC2 = /billing|membership|subscri|\bplans?\b/i;
  function words(el) { var im = el.querySelector('img[alt]'); return [String(el.innerText || '').slice(0, 200), el.getAttribute('aria-label'), el.getAttribute('title'), im && im.getAttribute('alt'), el.tagName === 'A' ? el.getAttribute('href') : ''].join(' '); }
  var room = maxEl, resN = 0;
  for (var k1 = 0; k1 < kept.length && room > 0; k1++) { if (kept[k1].reg[0] === 'dialog') { kept[k1].take = true; room--; } }
  for (var pass = 0; pass < 2; pass++) {
    for (var k2 = 0; k2 < kept.length && resN < RES && resN < room; k2++) {
      var kx = kept[k2]; if (kx.take || (kx.reg[0] !== 'nav' && kx.reg[0] !== 'page')) continue;
      if (kx.words == null) kx.words = words(kx.el);
      if ((pass ? ACC2 : ACC1).test(kx.words)) { kx.take = true; resN++; }
    }
  }
  room -= resN;
  for (var k3 = 0; k3 < kept.length && room > 0; k3++) { if (!kept[k3].take) { kept[k3].take = true; room--; } }

  function txt(el) {
    var t;
    if (el.tagName === 'SELECT') { var so = el.options[el.selectedIndex]; t = so ? so.text : ''; }
    else t = el.innerText != null ? el.innerText : el.textContent;
    t = clean(t);
    if (!t && el.tagName === 'INPUT') {
      if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') t = clean(el.value);
      else if ((el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels[0]) t = clean(el.labels[0].innerText);
    }
    return t.slice(0, 120);
  }
  function accName(el, t) {
    var a = clean(el.getAttribute('aria-label')); if (a) return a;
    var lb = el.getAttribute('aria-labelledby');
    if (lb) { var rt = el.getRootNode(), ids = lb.split(/\s+/), ps = []; for (var q = 0; q < ids.length; q++) { var le = ids[q] && (rt.getElementById ? rt.getElementById(ids[q]) : document.getElementById(ids[q])); if (le) ps.push(le.innerText || le.textContent); } a = clean(ps.join(' ')); if (a) return a; }
    if (el.labels && el.labels.length && el.type !== 'checkbox' && el.type !== 'radio') { a = clean(el.labels[0].innerText); if (a) return a; }
    a = clean(el.getAttribute('title')); if (a || t) return a;
    var im = el.tagName === 'IMG' ? el : el.querySelector('img[alt]'); a = im ? clean(im.getAttribute('alt')) : ''; if (a) return a;
    var st = el.querySelector('svg title'); a = st ? clean(st.textContent) : ''; if (a) return a;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : clean(el.getAttribute('placeholder') || el.getAttribute('name'));
  }
  var els = [], hasPassword = false;
  for (var hp = 0; hp < info.length; hp++) { if (info[hp].el.tagName === 'INPUT' && info[hp].el.type === 'password' && shown(info[hp])) hasPassword = true; }
  for (var ei = 0; ei < kept.length; ei++) {
    if (!kept[ei].take) continue;
    var y = kept[ei], ye = y.el, r = y.r, id = els.length + 1, fld = y.ctl || ye;
    ye.setAttribute('data-wa-id', gen + ':' + id);
    var e = { id: id, tag: ye.tagName.toLowerCase(), text: txt(ye) };
    var nm = accName(ye, e.text); if (nm && nm !== e.text) e.label = nm.slice(0, 80);
    var role = ye.getAttribute('role'); if (role) e.role = role;
    if (ye.tagName === 'A' && ye.href) { e.href = String(ye.href).slice(0, 200); if (/^_blank$/i.test(ye.getAttribute('target') || '')) e.newTab = true; }
    if (fld.tagName === 'INPUT') {
      e.type = fld.type; if (fld.name) e.name = fld.name; if (fld.placeholder) e.placeholder = fld.placeholder;
      if (fld.type !== 'password' && fld.value) e.value = String(fld.value).slice(0, 60);
      if (fld.type === 'checkbox' || fld.type === 'radio') e.checked = !!fld.checked;
    }
    if (ye.tagName === 'TEXTAREA') { if (ye.name) e.name = ye.name; if (ye.placeholder) e.placeholder = ye.placeholder; }
    if (ye.tagName === 'SELECT') { e.value = ye.value; e.options = Array.prototype.slice.call(ye.options, 0, 20).map(function (o) { return o.text.slice(0, 40); }); }
    if (e.checked == null) {
      var ac = ye.getAttribute('aria-checked'), as = ye.getAttribute('aria-selected');
      if (ac === 'true' || ac === 'false') e.checked = ac === 'true'; else if (as === 'true' || as === 'false') e.checked = as === 'true';
    }
    var ax = ye.getAttribute('aria-expanded'); if (ax === 'true' || ax === 'false') e.expanded = ax === 'true';
    if (ye.matches(':disabled') || ye.getAttribute('aria-disabled') === 'true' || (y.ctl && y.ctl.disabled)) e.disabled = true;
    if (r.top > vh || r.bottom < 0 || r.right <= 0 || r.left >= vw) e.offscreen = true;
    e.region = y.reg[0];
    els.push(e);
  }

  // ---- Visible text, in priority order: open dialogs → main → the rest → nav/aside (capped) ------------------
  // Only body.innerText: it leaves out <script>, <noscript>, <template> and hidden nodes, and keeps display:contents
  // wrappers (SvelteKit's shell). Per-child innerText is wrong: a non-rendered child returns its raw source.
  var NOT_TEXT = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1, IFRAME: 1, OBJECT: 1, SVG: 1 };
  function norm(s) { var ls = String(s || '').split('\n'), o = []; for (var q = 0; q < ls.length; q++) { var l = ls[q].replace(/[ \t]+/g, ' ').trim(); if (l) o.push(l); } return o.join('\n'); }
  function cut(R, blk, rep, lines) {   // remove a block from R as whole lines (optionally line by line when not contiguous)
    if (!blk || !R) return R;
    var S = '\n' + R + '\n', at = S.indexOf('\n' + blk + '\n');
    if (at !== -1) return (S.slice(0, at) + (rep ? '\n' + rep : '') + S.slice(at + blk.length + 1)).replace(/^\n+|\n+$/g, '');
    if (!lines) return R;
    var L = R.split('\n'), B = blk.split('\n');
    for (var q = 0; q < B.length; q++) { var ix = L.indexOf(B[q]); if (ix !== -1) L.splice(ix, 1); }
    return L.join('\n');
  }
  function hostRendered(h) {
    var n = h; while (n && n.nodeType === 1 && getComputedStyle(n).display === 'contents') n = up(n);
    if (!n || n.nodeType !== 1) return true;
    return CV ? n.checkVisibility({ visibilityProperty: true }) : getComputedStyle(n).display !== 'none';
  }
  function shadowText(par, out) {   // body.innerText never includes shadow roots; walk them by hand
    for (var c = par.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (c.nodeValue && c.nodeValue.trim()) out.push(c.nodeValue); continue; }
      if (c.nodeType !== 1 || NOT_TEXT[c.tagName.toUpperCase()] || c.hasAttribute('data-wa-ignore')) continue;
      if (c.tagName === 'SLOT') { if (!c.assignedNodes().length) shadowText(c, out); continue; }   // slotted light nodes are in body.innerText
      var cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      if (cs.display === 'contents') { shadowText(c, out); continue; }
      if (CV ? !c.checkVisibility({ visibilityProperty: true }) : cs.visibility === 'hidden') continue;
      out.push(c.innerText || '');
    }
    return out;
  }
  var sec = { dialog: [], main: [], page: [], nav: [] }, text = '';
  var ign = qa('[data-wa-ignore]'), saved = [];
  try {
    // Our own overlays (the testbed devbar) are hidden while reading, then restored exactly.
    for (var z = 0; z < ign.length; z++) { saved.push([ign[z].style.getPropertyValue('display'), ign[z].style.getPropertyPriority('display')]); ign[z].style.setProperty('display', 'none', 'important'); }
    // A <select> contributes every option to innerText (Amazon's ~60 departments); keep only the chosen one.
    var selBlocks = [], sl = document.querySelectorAll('select');
    for (var s1 = 0; s1 < sl.length; s1++) { if (sl[s1].options.length > 3) { var sb = norm(sl[s1].innerText), so = sl[s1].options[sl[s1].selectedIndex]; if (sb) selBlocks.push([sb, so ? clean(so.text) : '']); } }
    var tidy = function (s) { s = norm(s); for (var q = 0; q < selBlocks.length; q++) s = cut(s, selBlocks[q][0], selBlocks[q][1], false); return s; };
    var inDlg = function (n) { return where(n)[0] === 'dialog'; };
    var dT = [], lightD = [];
    for (var a1 = 0; a1 < dlgs.length; a1++) {
      var dd = dlgs[a1].el, nested = false;
      for (var pp = up(dd); pp; pp = up(pp)) { if (dlgEls.indexOf(pp) !== -1) { nested = true; break; } }
      if (nested) continue;
      var dtx = tidy(dd.innerText); if (!dtx) continue;
      dT.push(dtx); sec.dialog.push(dtx); if (dd.getRootNode() === document) lightD.push([dd, dtx]);
    }
    var minus = function (el, s) { for (var q = 0; q < lightD.length; q++) { if (el.contains(lightD[q][0])) s = cut(s, lightD[q][1], '', true); } return s; };
    var rest = body ? tidy(body.innerText) : '';
    for (var a2 = 0; a2 < lightD.length; a2++) rest = cut(rest, lightD[a2][1], '', true);
    var blocks = function (sel, skipIn) {
      var l = document.querySelectorAll(sel), o = [];
      for (var q = 0; q < l.length; q++) {
        var b = l[q]; if (inDlg(b) || !boxOk(b) || ignored(b)) continue;
        var par = false; for (var pq = up(b); pq; pq = up(pq)) { if (pq.matches(sel) || (skipIn && pq.matches(skipIn))) { par = true; break; } }
        if (!par) o.push(b);
      }
      return o;
    };
    var mains = blocks('main,[role="main"]', '');
    for (var a3 = 0; a3 < mains.length; a3++) { var mt = minus(mains[a3], tidy(mains[a3].innerText)); if (mt) { sec.main.push(mt); rest = cut(rest, mt, '', true); } }
    var navs = blocks('nav,aside,[role="navigation"],[role="complementary"]', 'main,[role="main"]');
    for (var a4 = 0; a4 < navs.length; a4++) { var nt = minus(navs[a4], tidy(navs[a4].innerText)); if (nt) { sec.nav.push(nt); rest = cut(rest, nt, '', true); } }
    sec.page.push(rest);
    for (var a5 = 1; a5 < roots.length; a5++) {
      var host = roots[a5].host; if (!host || ignored(host) || !hostRendered(host)) continue;
      var chunk = tidy(shadowText(roots[a5], []).join('\n'));
      for (var q5 = 0; q5 < dT.length && chunk; q5++) chunk = cut(chunk, dT[q5], '', false);
      if (chunk) sec[where(host)[0]].push(chunk);
    }
    // A line that already appeared twice adds nothing (Twitch repeats one screen-reader hint 24 times).
    var seen = {}, out = [];
    var add = function (parts, cap) {
      var ls = parts.join('\n').split('\n'), used = 0;
      for (var q = 0; q < ls.length; q++) {
        var ln = ls[q], key = '~' + ln, n = seen[key] || 0; if (!ln || n >= 2) continue;
        if (cap && used + ln.length + 1 > cap) { if (cap - used > 40) out.push(ln.slice(0, cap - used - 1)); break; }
        seen[key] = n + 1; out.push(ln); used += ln.length + 1;
      }
    };
    // On a long page (a site root's feed) the header's 'My Account' / 'Log out' / 'Log in' lines would fall past the
    // cut, and they say who is signed in: short such lines from the rest and nav move up, after main's first ~1500
    // chars. A short page keeps its order.
    var early = [], mainLs = sec.main.join('\n').split('\n'), mq = 0;
    if (sec.dialog.join('\n').length + mainLs.join('\n').length + sec.page.join('\n').length + Math.min(800, sec.nav.join('\n').length) > 3000) {
      var cl = (sec.page.join('\n') + '\n' + sec.nav.join('\n')).split('\n'), eu = 0;
      for (var q6 = 0; q6 < cl.length && early.length < 12; q6++) {
        var l6 = cl[q6]; if (!l6 || l6.length > 60 || !(ACC1.test(l6) || ACC2.test(l6)) || early.indexOf(l6) !== -1 || eu + l6.length > 400) continue;
        early.push(l6); eu += l6.length + 1;
      }
      for (var mu = 0; mq < mainLs.length && mu < 1500; mq++) mu += mainLs[mq].length + 1;
    }
    add(sec.dialog); add(mainLs.slice(0, early.length ? mq : mainLs.length));
    for (var q7 = 0; q7 < early.length; q7++) { if (!seen['~' + early[q7]]) { out.push(early[q7]); seen['~' + early[q7]] = 2; } }   // moved, not repeated
    if (early.length) add(mainLs.slice(mq));
    add(sec.page); add(sec.nav, 800);
    text = out.join('\n');
  } finally {
    for (var z2 = 0; z2 < saved.length; z2++) { if (saved[z2][0]) ign[z2].style.setProperty('display', saved[z2][0], saved[z2][1]); else ign[z2].style.removeProperty('display'); }
  }

  var hs = qa('h1,h2,h3'), hl = [];
  for (var h = 0; h < hs.length; h++) {
    var he = hs[h]; if (ignored(he) || !boxOk(he)) continue;
    var hw = where(he); if (faded(he) && !opacityFallback && hw[0] !== 'dialog') continue;
    var ht = clean(he.innerText).slice(0, 100); if (ht) hl.push({ t: ht, p: hw[1], i: h });
  }
  hl.sort(function (a, b) { return (a.p - b.p) || (a.i - b.i); });
  var heads = []; for (var h2 = 0; h2 < hl.length && heads.length < 12; h2++) heads.push(hl[h2].t);

  // ---- Prices, from the visible text only ---------------------------------------------------------------
  // Currency before or after the number, thousands separators (never a plain space: '$8 100 credits' is 8),
  // and guards so JS/RSC tokens like "$1" can't match. Codes are case-sensitive ('2024 usd' is not a price).
  var CODES = 'USD|EUR|GBP|CAD|AUD|NZD|BRL|MXN|HKD|SGD|JPY|INR|CHF|SEK|NOK|DKK|PLN';
  var SYM = 'US\\$|CA\\$|C\\$|AU\\$|A\\$|NZ\\$|R\\$|MX\\$|HK\\$|S\\$|\\$|€|£|¥|₹';
  var NUM = '(\\d{1,3}(?:[,.\'\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  var PRE = new RegExp('(?<![\\w"\'\\\\$])(?:(' + SYM + '|' + CODES + ')[ \\u00a0]?' + NUM + '|' + NUM + '[ \\u00a0]?(' + CODES + '|€|£|¥|₹))(?![\\w"\']|[.,\'\\u00a0\\u202f]\\d)', 'g');
  // The unit follows on the same line ('$9.99/mo', '$20 USD per month', '$14.99 billed monthly'), or on the next line
  // only as '/month', 'per month' or a bare 'monthly' line ('$8\n/month'): never the next item's 'Monthly plan'.
  var U = '(month(?:ly)?|mo\\b\\.?|mth\\b|year(?:ly)?|annual(?:ly)?|yr\\b\\.?|week(?:ly)?|wk\\b|quarter(?:ly)?)', LINK = '(?:\\/|per\\b|an?\\b|every\\b|each\\b|billed\\b|charged\\b|paid\\b)';
  var HEAD = '^[ \\t\\u00a0]*(?:(?:' + CODES + ')\\b)?[ \\t\\u00a0]*';
  var UNIT = new RegExp(HEAD + '(?:' + LINK + '\\s*)?' + U, 'i'), UNIT2 = new RegExp(HEAD + '\\n\\s*(?:' + LINK + '\\s*' + U + '|' + U + '[ \\t\\u00a0.]*(?:\\n|$))', 'i');
  var CUR = { 'US$': 'USD', '$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'NZ$': 'NZD', 'R$': 'BRL', 'MX$': 'MXN', 'HK$': 'HKD', 'S$': 'SGD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
  var prices = [], pkeys = {}, m, guard = 0;
  // Context: ~120 chars before (sanitizeSnapshot scrubs it whole, so 'Visa ending in 4242' is never cut to 'ng in 4242'
  // before scrubbing, then trims the head) and 45 after, minus a word cut at either edge.
  function ctx(a, b) {
    var s = Math.max(0, a - 120), e = Math.min(text.length, b + 45), c = text.slice(s, e), h;
    if (s > 0 && /\S/.test(text.charAt(s - 1)) && (h = c.search(/\s/)) !== -1 && h < a - s) c = c.slice(h + 1);
    if (e < text.length && /\S/.test(text.charAt(e)) && (h = c.search(/\s\S*$/)) !== -1 && h >= c.length - (e - b)) c = c.slice(0, h);
    return c.replace(/\n/g, ' ');
  }
  while ((m = PRE.exec(text)) && guard++ < 400 && prices.length < 40) {
    var num = m[2] || m[3], sym = m[1] || m[4], at = m.index, end = at + m[0].length;
    var dm = /[.,](\d{1,2})$/.exec(num), amount = parseFloat(num.slice(0, dm ? dm.index : num.length).replace(/\D/g, '') + (dm ? '.' + dm[1] : ''));
    var tail = text.slice(end, end + 30), um = UNIT.exec(tail) || UNIT2.exec(tail), u = um ? (um[1] || um[2] || '').toLowerCase() : '';
    var unit = !u ? '' : /^(mo|mth)/.test(u) ? 'month' : /^(y|an)/.test(u) ? 'year' : /^w/.test(u) ? 'week' : 'quarter';
    var grouped = /[,.'\u00a0\u202f]/.test(num);
    if (m[3] && /^[A-Z]/.test(sym) && !grouped && !unit) continue;   // '2024 USD'
    if (amount < 5 && !dm && !unit && !/month|year|plan|billed|membership|subscription/i.test(text.slice(Math.max(0, at - 40), end + 40))) continue;
    if (/\b(cart|bag|basket)\b/i.test(text.slice(Math.max(0, at - 40), end + 20))) continue;
    var currency = CUR[sym] || sym, pk = amount + '|' + currency + '|' + unit;
    if (pkeys[pk]) continue; pkeys[pk] = 1;
    prices.push({ amount: amount, currency: currency, unit: unit, context: ctx(at, end) });
  }

  // ---- Identity: who is signed in. Scoped sources only; script text only through the narrow page-data rule ----
  var EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,24}', ONE = new RegExp('^' + EMAIL + '$');
  var ROLE = /^(support|help|billing|invoices?|noreply|no-reply|no_reply|donotreply|do-not-reply|privacy|legal|info|contact|hello|team|sales|press|security|abuse|feedback|jobs|careers|admin|service|care|accounts?|notifications?|postmaster|webmaster)$/;
  var MAIL = /(^|\.)(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|msn\.com|icloud\.com|me\.com|mac\.com|yahoo\.com|ymail\.com|aol\.com|proton\.me|protonmail\.com|pm\.me|gmx\.(com|net|de)|fastmail\.com|hey\.com|zoho\.com|yandex\.(com|ru)|mail\.com|duck\.com|tutanota\.com|qq\.com|163\.com)$/;
  var site = String(opts.domain || '').toLowerCase().replace(/^www\./, '');
  var emails = [], hints = [];
  function okEmail(v) {   // the address lowercased, or '' for a role/staff address or a file name
    v = String(v).toLowerCase(); var ix = v.lastIndexOf('@'), local = v.slice(0, ix), dom = v.slice(ix + 1);
    if (!ONE.test(v) || ROLE.test(local)) return '';
    if (/\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?)$/.test(dom) || /^\d+x\./.test(dom)) return '';   // retina file names ('logo@2x.png')
    if (site && (dom === site || dom.slice(-site.length - 1) === '.' + site) && !MAIL.test(site)) return '';   // the service's own staff/role addresses
    return v;
  }
  function addEmail(v, src) {
    v = okEmail(v); if (!v || emails.length >= 3) return;
    for (var q = 0; q < emails.length; q++) { if (emails[q].value === v) return; }
    emails.push({ value: v, source: src });
  }
  function mailsIn(s, out) { var re = new RegExp(EMAIL, 'g'), mm, v; while ((mm = re.exec(s || ''))) { v = okEmail(mm[0]); if (v && out.indexOf(v) === -1) out.push(v); } return out; }
  function mailto(n) { return n.tagName === 'A' && /^mailto:/i.test(n.getAttribute('href') || ''); }
  function banner(el) { for (var n = el; n && n.nodeType === 1; n = up(n)) { var t = n.tagName, rl = n.getAttribute('role'); if (t === 'HEADER' || t === 'NAV' || rl === 'banner' || rl === 'navigation') return true; } return false; }
  function textOf(el, cap) {   // textContent (hidden menus count) minus script/style/template and mailto links
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), n, out = '';
    while ((n = w.nextNode()) && out.length < cap) {
      var ok = true;
      for (var p2 = n.parentNode; p2 && p2 !== el && ok; p2 = p2.parentNode) { if (p2.nodeType === 1 && (NOT_TEXT[p2.tagName.toUpperCase()] || mailto(p2))) ok = false; }
      if (ok) out += n.nodeValue + ' ';
    }
    return out.slice(0, cap);
  }
  function refs(el, attr) {   // the elements an aria-controls / aria-owns id list points to
    var ids = (el.getAttribute(attr) || '').split(/\s+/), rt = el.getRootNode(), o = [];
    for (var q = 0; q < ids.length; q++) { var te = ids[q] && (rt.getElementById ? rt.getElementById(ids[q]) : document.getElementById(ids[q])); if (te) o.push(te); }
    return o;
  }
  // (a) account triggers in the header/nav or the top 200px: their names are hints, their own labels may hold the
  // email. A tab (or a trigger for a tab panel) is never one: a settings strip's hidden Members panel lists teammates.
  var NAMED = '[data-testid*="account" i],[data-testid*="profile" i],[aria-label*="account" i],[aria-label*="profile" i],[title*="account" i],[title*="profile" i]';
  var AVATAR = '[data-testid*="avatar" i],[class*="avatar" i]', USER = '[data-testid*="user" i]';
  var STOP = /^(menu|more|search|close|open menu|main menu|toggle navigation|products?|solutions?|resources|platform|company|developers?|pricing|features|help|support|language|english|notifications?|settings|cart|bag|basket|shop|explore|browse|categories|all|share|invite|upgrade|apps)$/i;
  var ICON = /notif|bell|alert|inbox|message|cart|bag|basket|search|help|menu|setting|language|share|invite|apps|grid|logo|home/i;
  var tr = qa('[aria-haspopup]:not([aria-haspopup="false"]),[aria-controls],' + NAMED + ',' + AVATAR + ',' + USER), ti = [];
  for (var t1 = 0; t1 < tr.length && ti.length < 40; t1++) {
    var tg = tr[t1]; if (ignored(tg) || tg.getAttribute('role') === 'tab') continue;
    var tp = refs(tg, 'aria-controls'), tab = false; for (var t0 = 0; t0 < tp.length; t0++) { if (tp[t0].getAttribute('role') === 'tabpanel') tab = true; } if (tab) continue;
    var mt2 = false; for (var p3 = tg; p3 && !mt2; p3 = up(p3)) { if (p3.nodeType === 1 && mailto(p3)) mt2 = true; } if (mt2) continue;
    var tb = tg.getBoundingClientRect(); if (!tb.width || !tb.height || !(banner(tg) || tb.top + sy < 200)) continue;
    var im2 = tg.tagName === 'IMG' ? tg : tg.querySelector('img[alt]'), lab = clean(tg.getAttribute('aria-label')), ttl = clean(tg.getAttribute('title'));
    var alt = im2 ? clean(im2.getAttribute('alt')) : '', itx = clean(tg.innerText);
    var parts = [], cands = [lab, ttl, alt, itx.length <= 100 ? itx : ''];
    for (var c2 = 0; c2 < cands.length; c2++) { if (cands[c2] && parts.indexOf(cands[c2]) === -1) parts.push(cands[c2]); }
    var hx = parts.join(' · ').slice(0, 100), own = mailsIn([lab, ttl, alt, itx].join(' '), []);
    // Named for the account/profile (a 'user' test id only when it is not an avatar: 'user-avatar' repeats per person);
    // or avatar-like: an avatar, a picture that is not an icon, or an address as its name.
    var named = tg.matches(NAMED) || /account|profile|signed in/i.test(lab + ' ' + ttl) || (tg.matches(USER) && !tg.matches(AVATAR));
    var avatar = !named && (tg.matches(AVATAR) || /avatar/i.test(lab + ' ' + ttl) || own.length > 0 || (!!im2 && !ICON.test(hx + ' ' + (im2.getAttribute('src') || ''))));
    ti.push({ el: tg, hx: hx, own: own, rank: named ? 0 : avatar ? 1 : 2, i: t1 });
  }
  // Every named trigger speaks for the account, and the first avatar-like one; avatar-likes that carry more than one
  // distinct address are other people (collaborators, a Share list), and then none of them does. The same holds for
  // the account triggers' own labels together (Google's 'Google Account: Name (email)' is one address).
  var avMail = [], acctT = [], ownMail = [], firstAv = null, hc = [];
  for (var t2 = 0; t2 < ti.length; t2++) { if (ti[t2].rank === 1) { for (var q2 = 0; q2 < ti[t2].own.length; q2++) { if (avMail.indexOf(ti[t2].own[q2]) === -1) avMail.push(ti[t2].own[q2]); } } }
  for (var t3 = 0; t3 < ti.length; t3++) {
    var tt = ti[t3];
    if (tt.rank === 1) { if (firstAv || avMail.length > 1) continue; firstAv = tt; }   // repeated avatars: no email, hint or menu
    if (tt.rank < 2) { acctT.push(tt); for (var q3 = 0; q3 < tt.own.length; q3++) { if (ownMail.indexOf(tt.own[q3]) === -1) ownMail.push(tt.own[q3]); } }
    if (tt.hx && (tt.rank < 2 || (tt.hx.length >= 2 && tt.hx.length <= 60 && !STOP.test(tt.hx)))) hc.push(tt);
  }
  if (ownMail.length === 1) addEmail(ownMail[0], 'account-menu');
  hc.sort(function (a, b) { return (a.rank - b.rank) || (a.i - b.i); });
  for (var h3 = 0; h3 < hc.length && hints.length < 4; h3++) {
    if (hc[h3].own.length && ownMail.length > 1) continue;   // its label names one of several people
    var dup = false; for (var h4 = 0; h4 < hints.length; h4++) { if (hints[h4].text === hc[h3].hx) dup = true; } if (!dup) hints.push({ source: 'account-menu', text: hc[h3].hx });
  }
  // (b) the menus the account triggers open — emails only. A menu that lists more than one address (an account
  // switcher, a team) names no one.
  var tgts = [], inMenu = [];
  for (var t4 = 0; t4 < acctT.length; t4++) {
    var rf = refs(acctT[t4].el, 'aria-controls').concat(refs(acctT[t4].el, 'aria-owns'));
    for (var t5 = 0; t5 < rf.length; t5++) { if (tgts.indexOf(rf[t5]) === -1 && rf[t5].getAttribute('role') !== 'tabpanel' && !ignored(rf[t5])) tgts.push(rf[t5]); }
  }
  for (var t6 = 0; t6 < tgts.length && t6 < 20; t6++) mailsIn(textOf(tgts[t6], 2000), inMenu);
  if (inMenu.length === 1) addEmail(inMenu[0], 'account-menu');
  // (c) email/username fields: a prefilled login form shows the remembered account, not a signed-in one.
  var fi = qa('input[type="email"],input[autocomplete~="email"],input[autocomplete~="username"]');
  for (var f1 = 0; f1 < fi.length; f1++) { if (!ignored(fi[f1])) addEmail(clean(fi[f1].value), hasPassword ? 'login-form' : 'form'); }
  // (d) page-data: an "email" key in inline JSON/JS whose own object is the value of a singular identity key
  // ("user":{…,"email":…}, the escaped RSC form too) and is not itself an array element ("recentOrders":[{"customer":
  // {…}}] is someone else). A second distinct address means a list of people, so none is kept; and once the account
  // menu has named someone, script data adds nothing.
  var OWNER = /\\?"(user|viewer|currentUser|current_user|me|account|profile|customer|member)\\?"\s*:\s*\{[^{}\[\]]*$/, ELEM = /\[\s*\{[^{}\[\]]*$/;
  var menuMail = false; for (var e1 = 0; e1 < emails.length; e1++) { if (emails[e1].source === 'account-menu') menuMail = true; }
  var scs = menuMail ? [] : document.querySelectorAll('script:not([src])'), budget = 300000, pd = [];
  var KEY = /\\?"(email|emailAddress|email_address|user_email|userEmail|primaryEmail|primary_email)\\?"\s*:\s*\\?"([^"\\\s]{1,64}@[^"\\\s]{1,255})\\?"/g;
  for (var s2 = 0; s2 < scs.length && budget > 0 && pd.length < 2; s2++) {
    var sty = (scs[s2].getAttribute('type') || '').toLowerCase();
    if (sty && !/^(text\/javascript|application\/javascript|application\/json|application\/ld\+json|module)$/.test(sty)) continue;
    var src = (scs[s2].textContent || '').slice(0, budget), km; budget -= src.length; KEY.lastIndex = 0;
    while ((km = KEY.exec(src)) && pd.length < 2) {
      var pre = src.slice(Math.max(0, km.index - 400), km.index), om = OWNER.exec(pre), pv;
      if (om && !ELEM.test(pre.slice(0, om.index)) && (pv = okEmail(km[2])) && pd.indexOf(pv) === -1) pd.push(pv);
    }
  }
  if (pd.length === 1) addEmail(pd[0], 'page-data');

  // Iframes are recorded, never read: this only shows whether account content ever lives in one.
  var frames = [], ifr = qa('iframe');
  for (var f2 = 0; f2 < ifr.length && frames.length < 8; f2++) {
    var fe = ifr[f2], fr = fe.getBoundingClientRect();
    if (fr.width < 200 || fr.height < 100 || ignored(fe) || (CV && !fe.checkVisibility({ visibilityProperty: true, opacityProperty: true }))) continue;
    var fh = ''; try { var fs = fe.getAttribute('src') || ''; if (fs && !/^(about|javascript|data):/i.test(fs)) fh = new URL(fs, location.href).host; } catch (err) { fh = ''; }
    frames.push({ host: fh || (fe.hasAttribute('srcdoc') ? 'srcdoc' : 'about:blank'), w: Math.round(fr.width), h: Math.round(fr.height) });
  }

  var snap = { url: location.href, title: document.title, headings: heads, text: text.slice(0, textChars), textLength: text.length, hasPassword: hasPassword, prices: prices, elements: els, gen: gen, identity: { emails: emails, hints: hints }, frames: frames, scrollY: window.scrollY, scrollHeight: de.scrollHeight, viewportHeight: vh };
  if (opacityFallback) snap.opacityFallback = true;
  return snap;
}

/**
 * Read the CURRENT name/state of a tagged element right before acting (guards against swapped buttons). The name
 * uses the same rules as snapshotPage, so the click-time guard sees what the model saw. A gen from an older
 * snapshot (or a replaced document) returns null. performAction's liveText repeats the `text` rules: keep them in step.
 */
export function readElement(id, gen) {
  var cur = document.documentElement.getAttribute('data-wa-gen') || '';
  if (gen && gen !== cur) return null;
  var s = '[data-wa-id="' + (gen || cur) + ':' + String(id).replace(/[^\w-]/g, '') + '"]';
  var el = document.querySelector(s);
  if (!el) (function walk(root) { var all = root.querySelectorAll('*'); for (var i = 0; i < all.length && !el; i++) { if (all[i].shadowRoot) { el = all[i].shadowRoot.querySelector(s); if (!el) walk(all[i].shadowRoot); } } })(document);
  if (!el) return null;
  function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
  var t;
  if (el.tagName === 'SELECT') { var so = el.options[el.selectedIndex]; t = clean(so ? so.text : ''); }
  else t = clean(el.innerText != null ? el.innerText : el.textContent);
  if (!t && el.tagName === 'INPUT') {
    if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') t = clean(el.value);
    else if ((el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels[0]) t = clean(el.labels[0].innerText);
  }
  var a = clean(el.getAttribute('aria-label')), lb = el.getAttribute('aria-labelledby');
  if (!a && lb) { var rt = el.getRootNode(), ids = lb.split(/\s+/), ps = []; for (var q = 0; q < ids.length; q++) { var le = ids[q] && (rt.getElementById ? rt.getElementById(ids[q]) : document.getElementById(ids[q])); if (le) ps.push(le.innerText || le.textContent); } a = clean(ps.join(' ')); }
  if (!a && el.labels && el.labels.length && el.type !== 'checkbox' && el.type !== 'radio') a = clean(el.labels[0].innerText);
  if (!a) a = clean(el.getAttribute('title'));
  if (!a && !t) { var im = el.tagName === 'IMG' ? el : el.querySelector('img[alt]'); a = im ? clean(im.getAttribute('alt')) : ''; }
  if (!a && !t) { var st = el.querySelector('svg title'); a = st ? clean(st.textContent) : ''; }
  var ctl = el.tagName === 'LABEL' ? (el.control || el.querySelector('input,select,textarea')) : el;
  var text = t || a || (el.tagName === 'INPUT' && el.type !== 'password' ? clean(el.value) : '');
  var res = { text: text.slice(0, 160), label: a.slice(0, 80), type: (ctl && ctl.type) || el.type || '', name: (ctl && ctl.name) || el.name || '', tag: el.tagName.toLowerCase(),
    disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || (ctl && ctl !== el && ctl.disabled)) };
  var ac = el.getAttribute('aria-checked');
  if (ctl && (ctl.type === 'checkbox' || ctl.type === 'radio')) res.checked = !!ctl.checked; else if (ac === 'true' || ac === 'false') res.checked = ac === 'true';
  return res;
}

/**
 * Perform one in-page action. Returns {ok, note}. A gen from an older snapshot is refused (the page changed), and so
 * is a click whose `expect` (readElement's text, checked by the caller) no longer matches the element.
 */
export function performAction(action) {
  var cur = document.documentElement.getAttribute('data-wa-gen') || '';
  function byId(id) {
    var s = '[data-wa-id="' + (action.gen || cur) + ':' + String(id).replace(/[^\w-]/g, '') + '"]';
    var e = document.querySelector(s); if (e) return e;
    var f = null; (function walk(root) { if (f) return; var all = root.querySelectorAll('*'); for (var i = 0; i < all.length && !f; i++) { if (all[i].shadowRoot) { f = all[i].shadowRoot.querySelector(s); if (!f) walk(all[i].shadowRoot); } } })(document); return f;
  }
  function name(el) { return String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 120); }
  function clean(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
  // The element's `text` exactly as readElement names it (keep the two in step): the caller checked that text, then
  // spent up to seconds before this click, and an SPA can re-render the same tagged node ('Continue' → 'Confirm
  // cancellation') in between.
  function liveText(el) {
    var t;
    if (el.tagName === 'SELECT') { var so = el.options[el.selectedIndex]; t = clean(so ? so.text : ''); }
    else t = clean(el.innerText != null ? el.innerText : el.textContent);
    if (!t && el.tagName === 'INPUT') {
      if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') t = clean(el.value);
      else if ((el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels[0]) t = clean(el.labels[0].innerText);
    }
    if (t) return t.slice(0, 160);
    var a = clean(el.getAttribute('aria-label')), lb = el.getAttribute('aria-labelledby');
    if (!a && lb) { var rt = el.getRootNode(), ids = lb.split(/\s+/), ps = []; for (var q = 0; q < ids.length; q++) { var le = ids[q] && (rt.getElementById ? rt.getElementById(ids[q]) : document.getElementById(ids[q])); if (le) ps.push(le.innerText || le.textContent); } a = clean(ps.join(' ')); }
    if (!a && el.labels && el.labels.length && el.type !== 'checkbox' && el.type !== 'radio') a = clean(el.labels[0].innerText);
    if (!a) a = clean(el.getAttribute('title'));
    if (!a) { var im = el.tagName === 'IMG' ? el : el.querySelector('img[alt]'); a = im ? clean(im.getAttribute('alt')) : ''; }
    if (!a) { var st = el.querySelector('svg title'); a = st ? clean(st.textContent) : ''; }
    return (a || (el.tagName === 'INPUT' && el.type !== 'password' ? clean(el.value) : '')).slice(0, 160);
  }
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  try {
    var t = action.type;
    if ((t === 'click' || t === 'accept_offer' || t === 'type' || t === 'select') && action.gen && action.gen !== cur) return { ok: false, note: 'page changed since it was read' };
    if (t === 'click' || t === 'accept_offer') {
      var el = byId(action.id); if (!el) return { ok: false, note: 'element not found' };
      if (typeof action.expect === 'string' && liveText(el) !== clean(action.expect).slice(0, 160)) return { ok: false, note: 'page changed since it was read' };
      var text = name(el);
      el.scrollIntoView({ block: 'center' });
      if (el.tagName === 'LABEL') { var inp = el.control || el.querySelector('input'); if (inp) { inp.click(); return { ok: true, note: 'clicked label → ' + text }; } }
      // A person's click: pointer and mouse down/up at the element's centre, then click. Some menus open on pointerdown
      // and never see a bare click() (the walk read those as "no visible effect").
      var rc = el.getBoundingClientRect(), cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
      var seq = [['pointerdown', 1], ['mousedown', 1], ['pointerup', 0], ['mouseup', 0]];   // no hover: it opens and closes menus
      for (var si = 0; si < seq.length; si++) {
        var init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: seq[si][1] };
        var isPtr = seq[si][0].indexOf('pointer') === 0;
        if (isPtr) { init.pointerId = 1; init.pointerType = 'mouse'; init.isPrimary = true; }
        try { el.dispatchEvent(isPtr && typeof PointerEvent === 'function' ? new PointerEvent(seq[si][0], init) : new MouseEvent(seq[si][0], init)); } catch (err) { /* an engine without the constructor */ }
      }
      // A same-site link that opens a new window: without a real gesture Chrome blocks the popup, so open it here instead.
      var tgt = action.sameTab && el.tagName === 'A' ? el.getAttribute('target') : null;
      if (tgt != null) el.removeAttribute('target');
      el.click();
      if (tgt != null) el.setAttribute('target', tgt);
      return { ok: true, note: 'clicked "' + text + '"' + (tgt != null ? ' (opened here, not in a new tab)' : '') };
    }
    if (t === 'type') {
      var tf = byId(action.id); if (!tf) return { ok: false, note: 'element not found' };
      if (tf.type === 'password') return { ok: false, note: 'refused: password field' };
      tf.focus();
      if (tf.isContentEditable) { tf.textContent = action.text || ''; fire(tf, 'input'); return { ok: true, note: 'typed into field' }; }
      var proto = tf.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(tf, action.text || ''); else tf.value = action.text || '';
      fire(tf, 'input'); fire(tf, 'change');
      return { ok: true, note: 'typed into ' + (tf.name || tf.placeholder || 'field') };
    }
    if (t === 'select') {
      var s = byId(action.id); if (!s || s.tagName !== 'SELECT') return { ok: false, note: 'select not found' };
      var want = String(action.value || '').toLowerCase();
      var opts = Array.prototype.slice.call(s.options);
      var o = null; for (var i = 0; i < opts.length; i++) { if (opts[i].value.toLowerCase() === want || opts[i].text.toLowerCase().indexOf(want) !== -1) { o = opts[i]; break; } }
      if (!o) return { ok: false, note: 'option not found' };
      s.value = o.value; fire(s, 'input'); fire(s, 'change');
      return { ok: true, note: 'selected ' + o.text };
    }
    if (t === 'scroll') {
      window.scrollBy({ top: (action.direction === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.8), behavior: 'instant' });
      return { ok: true, note: 'scrolled ' + (action.direction || 'down') };
    }
    return { ok: false, note: 'not an in-page action: ' + t };
  } catch (e) { return { ok: false, note: String((e && e.message) || e) }; }
}

/**
 * Cheap "has this page rendered yet?" probe, polled by waitForContent (tabs.ts). No tagging, no DOM changes.
 */
export function readinessProbe() {
  var de = document.documentElement, body = document.body, CV = typeof de.checkVisibility === 'function';
  function vis(el, opacity) {
    var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    if (CV) return el.checkVisibility({ visibilityProperty: true, opacityProperty: !!opacity });
    var s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden';
  }
  var raw = ''; try { raw = body ? body.innerText || '' : ''; } catch (e) { raw = ''; }
  var visibleTextLen = raw.trim().length, t = raw.replace(/\s+/g, ' ').trim();
  var IA = 'a[href],button,input:not([type="hidden"]),select,[role="button"]', n = 0, pw = false;
  function scan(root) {
    var l = root.querySelectorAll(IA); for (var i = 0; i < l.length && n < 300; i++) { if (vis(l[i])) n++; }
    var p = root.querySelectorAll('input[type="password"]'); for (var j = 0; j < p.length && !pw; j++) { if (vis(p[j], true)) pw = true; }
  }
  scan(document);
  // Pages built from web components keep their text in shadow roots; look there only when the light DOM is sparse.
  if (visibleTextLen < 200 || n < 2) {
    var roots = [];
    (function walk(root) { var all = root.querySelectorAll('*'); for (var a = 0; a < all.length && roots.length < 200; a++) { if (all[a].shadowRoot) { roots.push(all[a].shadowRoot); walk(all[a].shadowRoot); } } })(document);
    for (var r = 0; r < roots.length; r++) {
      var sr = roots[r], c = sr.children;
      if (!vis(sr.host) && getComputedStyle(sr.host).display !== 'contents') continue;
      for (var k = 0; k < c.length; k++) { if (!/^(SCRIPT|STYLE|TEMPLATE|LINK|NOSCRIPT)$/.test(c[k].tagName) && vis(c[k])) visibleTextLen += (c[k].innerText || '').trim().length; }
      scan(sr);
    }
  }
  var busy = !!(body && body.getAttribute('aria-busy') === 'true') || !!document.querySelector('main[aria-busy="true"],[role="main"][aria-busy="true"]');
  if (!busy) { var pb = document.querySelectorAll('[role="progressbar"]'); for (var b = 0; b < pb.length && b < 20 && !busy; b++) { if (vis(pb[b], true)) busy = true; } }
  var loadingText = t.length < 60 && /^(loading|opening .* app)|just a moment|checking your browser|please wait|enable javascript/i.test(t);
  var short = visibleTextLen < 200 && !pw;
  // A Cloudflare interstitial is known by its own markers (a localized one runs just over 200 chars of text). Never by
  // a bare cf-chl id: Turnstile puts cf-chl-widget-* into ordinary forms (handled with the frames below), and the
  // challenge-platform "jsd" script ships on ordinary pages; only the interstitial loads an orchestrate/ script.
  var challenge = /verify(ing)? (that )?you('re| are) (not a robot|human)|are you a robot|checking your browser|press (and|&) hold|performing security verification/i.test(t.slice(0, 3000))
    || /^just a moment\b/i.test(String(document.title || '').trim())
    || !!document.querySelector('#challenge-form,#challenge-stage,#challenge-running,#cf-challenge-running,script[src*="/cdn-cgi/challenge-platform/h/"][src*="orchestrate/"]');
  if (!challenge) { var sc = document.querySelectorAll('script:not([src])'); for (var si = 0; si < sc.length && si < 30 && !challenge; si++) { if ((sc[si].textContent || '').indexOf('_cf_chl_opt') !== -1) challenge = true; } }
  // AWS WAF: the global only exists in the page's own world (page.evaluate), so its script is checked too. Both
  // also ship on ordinary pages that merely integrate the SDK, hence "and the page is nearly empty" (and no login form).
  if (!challenge && short) {
    challenge = typeof window.AwsWafIntegration !== 'undefined' || !!document.querySelector('script[src*="awswaf"]');
    if (!challenge) { var ss = document.querySelectorAll('script:not([src])'); for (var s = 0; s < ss.length && s < 30 && !challenge; s++) { if ((ss[s].textContent || '').indexOf('AwsWafIntegration') !== -1) challenge = true; } }
  }
  // Captcha/Turnstile frames and widgets also sit inside ordinary forms (sign-in, newsletter, support; reCAPTCHA v3's
  // badge on every page): they mean a robot check only on a nearly empty page without a login form, or when the frame
  // is the image challenge.
  if (!challenge) {
    var fr = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="captcha"],[id^="cf-chl-widget"]:not(input)');
    for (var f = 0; f < fr.length && !challenge; f++) {
      var src = fr[f].getAttribute('src') || '', box = fr[f].getBoundingClientRect();
      if (/size=invisible/.test(src) || !vis(fr[f], true)) continue;
      if (short || (box.width >= 250 && box.height >= 250)) challenge = true;
    }
    if (!challenge && short && document.querySelector('input[name="cf-turnstile-response"],input[id^="cf-chl-widget"]')) challenge = true;
  }
  var dialog = '', dl = document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'), best = null, bestRank = 9;
  for (var d = dl.length - 1; d >= 0; d--) {   // later in the DOM is usually on top; modal beats non-modal
    if (!vis(dl[d])) continue;
    var modal = dl[d].getAttribute('aria-modal') === 'true'; if (!modal && dl[d].tagName === 'DIALOG') { try { modal = dl[d].matches(':modal'); } catch (err) { modal = false; } }
    var rank = modal ? 0 : 1;
    if (rank < bestRank) { best = dl[d]; bestRank = rank; }
  }
  if (best) dialog = (best.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { url: location.href, readyState: document.readyState, visibleTextLen: visibleTextLen, interactiveCount: n, hasPassword: pw, busy: busy, loadingText: loadingText, challenge: challenge, dialog: dialog };
}
