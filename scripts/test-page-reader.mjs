// Headless-Chrome test for the in-page reader (shared/page-scripts.js): visible text only and in priority order,
// which elements get ids (and that stale ids are refused), prices, identity hints and the readiness probe.
// Every fixture is local HTML (page.setContent); all network requests are aborted.
//   npm run test:reader        (CHROME_PATH overrides the Chrome binary)
import puppeteer from 'puppeteer-core';
import { snapshotPage, readElement, performAction, readinessProbe } from '../shared/page-scripts.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };
const count = (s, sub) => s.split(sub).length - 1;
const el = (snap, text) => snap.elements.find((e) => e.text === text || e.label === text);
const short = (v) => String(JSON.stringify(v)).slice(0, 160);
const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 800 });
await page.setRequestInterception(true);
page.on('request', (r) => (/^(data|about):/.test(r.url()) ? r.continue() : r.abort()));
// about:blank first: setContent alone keeps the old window, so globals from one fixture would leak into the next.
const load = async (html) => { await page.goto('about:blank'); await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body>${html}</body></html>`, { waitUntil: 'load' }); };
const snap = (opts = {}) => page.evaluate(snapshotPage, opts);
// Web components for the shadow-DOM cases: <x-box data-html="..."> renders its data-html into an open shadow root.
const XBOX = `<script>customElements.define('x-box', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = this.getAttribute('data-html'); } });</script>`;

try {
  console.log('Visible text only (K1)');
  await load(`${XBOX}
    <div style="display: contents">
      <header><a href="/">Brand</a></header>
      <main><h1>Your plan</h1><p>Premium $9.99/month</p><button>Manage plan</button></main>
    </div>
    <script>window.__STATE__ = {"props":{"hasSubscriptionInfo":false,"product_id":"0"}}; var LEAKJS = 1;</script>
    <script type="application/json">{"csrfToken":"JSONLEAK"}</script>
    <noscript>Enable JavaScript NOSCRIPT_LEAK</noscript>
    <div hidden>{"hidden_json": "HIDDEN_LEAK"}</div>
    <code style="display:none">{"code_json": "CODE_LEAK"}</code>
    <template><p>TEMPLATE_LEAK</p></template>
    <div style="display:none"><div style="display:contents">CONTENTS_UNDER_NONE<script>var NESTED_LEAK = 2</script></div></div>
    <x-box data-html="<div style='display:contents'><p>Shadow plan $5.00/mo</p></div><script>var SHADOW_SCRIPT_LEAK=1</script>"></x-box>
    <x-box style="display:none" data-html="<p>HIDDEN_HOST_LEAK</p>"></x-box>
    <div style="display:none"><x-box style="display:contents" data-html="<p>CONTENTS_HOST_LEAK</p>"></x-box></div>`);
  let s = await snap();
  check('display:contents wrapper: plan text kept', s.text.includes('Your plan') && s.text.includes('Premium $9.99/month'), short(s.text));
  check('display:contents wrapper: price found', s.prices.some((p) => p.amount === 9.99 && p.currency === 'USD' && p.unit === 'month'), short(s.prices));
  check('shadow root display:contents child kept (text + price)', s.text.includes('Shadow plan $5.00/mo') && s.prices.some((p) => p.amount === 5 && p.unit === 'month'));
  for (const leak of ['hasSubscriptionInfo', 'LEAKJS', 'JSONLEAK', 'NOSCRIPT_LEAK', 'HIDDEN_LEAK', 'CODE_LEAK', 'TEMPLATE_LEAK', 'CONTENTS_UNDER_NONE', 'NESTED_LEAK', 'SHADOW_SCRIPT_LEAK', 'HIDDEN_HOST_LEAK', 'CONTENTS_HOST_LEAK'])
    check(`not in text: ${leak}`, !s.text.includes(leak));
  check('textLength is the visible text only', s.textLength < 200, String(s.textLength));
  check('button under display:contents collected, region main', el(s, 'Manage plan')?.region === 'main', short(el(s, 'Manage plan')));
  check('gen returned and written to <html data-wa-gen>', !!s.gen && s.gen === await page.evaluate(() => document.documentElement.getAttribute('data-wa-gen')));

  console.log('\n[data-wa-ignore] overlays');
  await load(`<main><p>Real content</p><button>Real button</button></main>
    <div data-wa-ignore id="devbar" style="display:grid !important">DEVBAR_TEXT <button>Reset state</button></div>
    <div data-wa-ignore id="devbar2">DEVBAR2_TEXT</div>`);
  s = await snap();
  check('ignored overlay text excluded', !s.text.includes('DEVBAR') && s.text.includes('Real content'), short(s.text));
  check('ignored overlay buttons excluded', !el(s, 'Reset state') && !!el(s, 'Real button'));
  const st = await page.evaluate(() => [document.getElementById('devbar').style.getPropertyValue('display'), document.getElementById('devbar').style.getPropertyPriority('display'), document.getElementById('devbar2').getAttribute('style')]);
  check('ignored overlay styles restored exactly', st[0] === 'grid' && st[1] === 'important' && !st[2], short(st));

  console.log('\nPriority order: dialog → main → rest → nav');
  const navLinks = Array.from({ length: 30 }, (_, i) => `<a href="/n${i}">Nav link ${i}</a>`).join('');
  await load(`<header><nav>${navLinks}</nav><button aria-haspopup="menu">Menu</button></header>
    <main><h2>Account settings</h2><p>Main text line</p><button>Main button</button>
      <div role="dialog"><p>Inline dialog X</p></div><p>Main tail</p></main>
    <footer><a href="/help">Help center</a></footer>
    <div role="dialog" aria-modal="true"><h2>Before you go</h2><p>Get 50% off for 3 months</p><button>Keep my discount</button><button>Continue to cancel</button></div>`);
  s = await snap({ maxElements: 5 });
  check('text starts with the modal dialog', s.text.startsWith('Before you go'), short(s.text.slice(0, 60)));
  check('dialog nested in main appears once, before main', count(s.text, 'Inline dialog X') === 1 && s.text.indexOf('Inline dialog X') < s.text.indexOf('Main text line'));
  check('main before nav', s.text.indexOf('Main text line') < s.text.indexOf('Nav link 0') && s.text.indexOf('Main tail') < s.text.indexOf('Nav link 0'), short(s.text));
  check('main text kept contiguous without the dialog', s.text.includes('Account settings\nMain text line\nMain button\nMain tail'), short(s.text));
  check('elements: dialog buttons first (ids 1, 2)', s.elements[0]?.text === 'Keep my discount' && s.elements[0].region === 'dialog' && s.elements[1]?.text === 'Continue to cancel', short(s.elements.slice(0, 3)));
  check('elements: main button survives the cap', s.elements.some((e) => e.text === 'Main button' && e.region === 'main'), short(s.elements));
  check('elements: cap respected, ids 1..N in order', s.elements.length === 5 && s.elements.every((e, i) => e.id === i + 1));
  check('headings: dialog heading first', s.headings[0] === 'Before you go', short(s.headings));
  const tag1 = await page.evaluate(() => document.querySelector('[data-wa-id$=":1"]').textContent);
  check('data-wa-id "<gen>:1" is on the first listed element', tag1 === 'Keep my discount');

  console.log('\nHeader account links on a long page (R25)');
  const feed = Array.from({ length: 120 }, (_, i) => `<article><a href="/story/${i}">Story ${i}: a headline about something that happened in the city today</a></article>`).join('');
  await load(`<header><nav><ul><li><a href="/">Home</a></li><li><a href="/news">News</a></li><li><a href="/account">My Account</a></li><li><a href="/account/subscription">Subscription</a></li><li><a href="/logout">Log out</a></li></ul></nav></header><main>${feed}</main>`);
  s = await snap({ maxElements: 80, textChars: 4000 });
  check('elements: header My Account / Subscription / Log out keep ids past a 120-link main', ['My Account', 'Subscription', 'Log out'].every((t) => el(s, t)?.region === 'nav') && s.elements.length === 80 && s.elements.every((e, i) => e.id === i + 1) && !el(s, 'News'), short(s.elements.slice(-4)));
  const head3500 = s.text.slice(0, 3500);
  check('text: those nav lines move up after main\'s head (once), other nav lines do not', head3500.startsWith('Story 0') && head3500.includes('\nLog out\n') && head3500.includes('\nSubscription\n') && count(s.text, 'Log out') === 1 && !head3500.includes('\nNews'), short(s.text.slice(1400, 1800)));
  const faq = Array.from({ length: 90 }, (_, i) => `<a href="/faq/${i}">Question ${i} about the plans</a>`).join(' ');
  await load(`<header><a href="/">Brand</a><a href="/login">Log in</a></header><main><h1>Plans</h1>${faq}</main>`);
  s = await snap({ maxElements: 80 });
  check('elements: a signed-out page keeps its header "Log in" past 90 main links', el(s, 'Log in')?.region === 'nav' && s.elements.length === 80, short(s.elements.slice(-3)));

  console.log('\nRepeated lines, nav cap, <select> options');
  const channels = Array.from({ length: 120 }, (_, i) => `<a href="/c${i}">Channel ${i}</a>`).join('<br>');
  const opts60 = Array.from({ length: 60 }, (_, i) => `<option${i === 7 ? ' selected' : ''}>Department ${i}</option>`).join('');
  await load(`<main><h1>Subscriptions</h1>${'<p>Use the Right Arrow Key to show more information</p>'.repeat(10)}<p>Your subscriptions: none</p></main>
    <div><select>${opts60}</select></div><aside>${channels}</aside>`);
  s = await snap();
  check('a line repeated 10× is kept at most twice', count(s.text, 'Use the Right Arrow Key') === 2, String(count(s.text, 'Use the Right Arrow Key')));
  check('aside/nav block moved last and capped (~800 chars)', s.text.includes('Channel 1\n') && !s.text.includes('Channel 119') && s.text.length < 1000, String(s.text.length));
  await page.evaluate(() => { document.querySelector('aside').innerHTML = Array.from({ length: 200 }, (_, i) => '<a href="/i' + i + '">Inline ' + i + '</a>').join(' '); });
  const s3 = await snap();
  check('a single nav line longer than the cap is truncated, not dropped', s3.text.includes('Inline 0 Inline 1') && !s3.text.includes('Inline 199'), String(s3.text.length));
  check('<select> in text: only the chosen option', s.text.includes('Department 7') && !s.text.includes('Department 30'), short(s.text));
  check('<select> element text is the chosen option', s.elements.some((e) => e.tag === 'select' && e.text === 'Department 7' && e.options.length === 20));

  console.log('\nCustom survey controls');
  await load(`<main><h1>Why are you leaving?</h1>
    <label><input type="radio" name="reason" value="price" style="display:none"> Too expensive</label>
    <label><input type="radio" name="reason" value="usage" style="display:none"> Not using it enough</label>
    <input type="radio" id="r3" name="reason" value="other" style="opacity:0;position:absolute"><label for="r3">Other reason</label>
    <label><input type="checkbox" name="ack"> I understand</label>
    <div role="switch" aria-checked="false" tabindex="0" id="sw">Email me offers</div>
    <div role="option" aria-selected="true">Monthly</div>
    <div tabindex="0" id="cont">Continue to cancel</div>
    <a id="nohref" tabindex="0">Keep membership</a>
    <div tabindex="0">${'A long scrolling carousel of shows you might like. '.repeat(4)}</div>
    <label>Card number</label><input type="text" name="card"><label style="cursor:pointer">Pick this plan</label>
    <button>Native</button></main>
    <script>document.getElementById('sw').addEventListener('click', function () { this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true')); });</script>`);
  s = await snap();
  const lab = el(s, 'Too expensive');
  check('label around a display:none radio is collected as a radio', lab?.tag === 'label' && lab.type === 'radio' && lab.name === 'reason' && lab.checked === false, short(lab));
  check('label[for] of an opacity:0 radio is collected', el(s, 'Other reason')?.tag === 'label', short(el(s, 'Other reason')));
  check('visible checkbox collected once (input, not its label)', s.elements.filter((e) => e.text === 'I understand').length === 1 && el(s, 'I understand').tag === 'input');
  check('role=switch collected with aria-checked state', el(s, 'Email me offers')?.checked === false && el(s, 'Email me offers').role === 'switch');
  check('role=option collected, aria-selected → checked', el(s, 'Monthly')?.checked === true);
  check('tabindex=0 div collected', el(s, 'Continue to cancel')?.tag === 'div');
  check('a without href but tabindex collected', el(s, 'Keep membership')?.tag === 'a');
  check('long tabindex container not collected', !s.elements.some((e) => /carousel/.test(e.text)));
  check('caption <label> without a control is not a click target', !el(s, 'Card number') && s.elements.some((e) => e.tag === 'input' && e.name === 'card'));
  check('clickable-looking <label> without a control is collected', el(s, 'Pick this plan')?.tag === 'label');
  let r = await page.evaluate(performAction, { type: 'click', id: lab.id, gen: s.gen });
  check('clicking the label selects the hidden radio', r.ok && await page.evaluate(() => document.querySelector('input[value=price]').checked), r.note);
  const live = await page.evaluate(readElement, lab.id, s.gen);
  check('readElement names the label like the snapshot', live?.text === 'Too expensive' && live.type === 'radio' && live.checked === true, short(live));
  r = await page.evaluate(performAction, { type: 'click', id: el(s, 'Email me offers').id });
  s = await snap();
  check('switch click (no gen passed) works and state re-reads', r.ok && el(s, 'Email me offers')?.checked === true, r.note);

  console.log('\nPage-wide tabindex wrapper');
  await load(`<div tabindex="0" id="wrap"><main><p>Plan: Premium</p><button>Cancel membership</button><a href="/billing">Billing</a></main></div>`);
  s = await snap();
  check('real buttons inside a tabindex wrapper are collected', !!el(s, 'Cancel membership') && !!el(s, 'Billing'), short(s.elements));
  check('the wrapper itself is not collected', !s.elements.some((e) => e.tag === 'div'));

  console.log('\nARIA state and names');
  await load(`<main>
    <div role="button" aria-disabled="true">Pause membership</div>
    <div role="checkbox" aria-checked="true">Send reminders</div>
    <button aria-expanded="false">More options</button>
    <a href="/profile"><img alt="Profile of Jane" src="${GIF}" width="24" height="24"></a>
    <span id="lbl">Close dialog</span><button aria-labelledby="lbl"><svg width="16" height="16"></svg></button>
    <label for="em">Email address</label><input id="em" type="email">
    <a href="/x"><span>Visible</span><button>Inner button</button></a>
  </main>`);
  s = await snap();
  check('aria-disabled → disabled', el(s, 'Pause membership')?.disabled === true);
  check('aria-checked → checked', el(s, 'Send reminders')?.checked === true);
  check('aria-expanded → expanded', el(s, 'More options')?.expanded === false);
  check('img alt names an icon link', s.elements.some((e) => e.href && e.href.endsWith('/profile') && e.label === 'Profile of Jane'), short(s.elements));
  const lb = s.elements.find((e) => e.label === 'Close dialog');
  check('aria-labelledby names an icon button', lb?.tag === 'button' && lb.text === '');
  check('input named by its <label>', s.elements.some((e) => e.tag === 'input' && e.label === 'Email address'));
  check('button inside a collected link is not listed twice', !el(s, 'Inner button'));
  const lv = await page.evaluate(readElement, lb.id, s.gen);
  check('readElement gives the icon button the same name', lv?.text === 'Close dialog', short(lv));
  const dv = await page.evaluate(readElement, el(s, 'Pause membership').id);
  check('readElement reports aria-disabled', dv?.disabled === true);

  console.log('\nVisibility rules');
  const many = Array.from({ length: 6 }, (_, i) => `<a href="/v${i}">Visible ${i}</a>`).join(' ');
  await load(`<a href="#main" style="position:absolute;left:-10000px">Skip to content</a>
    <a href="/sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Screen reader link</a>
    <div style="opacity:0"><a href="/ghost">Ghost link</a></div>
    <main>${many}<a href="/far" style="position:absolute;left:1500px;top:10px">Far right</a></main>
    <form><input type="password" style="display:none"></form>`);
  s = await snap();
  check('off-document skip link excluded', !el(s, 'Skip to content'));
  check('1px screen-reader link excluded', !el(s, 'Screen reader link'));
  check('link in an opacity:0 parent excluded', !el(s, 'Ghost link') && !s.opacityFallback);
  check('horizontally off-viewport element flagged offscreen', el(s, 'Far right')?.offscreen === true, short(el(s, 'Far right')));
  check('hidden password field → hasPassword false', s.hasPassword === false);
  await load(`<div style="opacity:0"><main><button>Fading A</button><button>Fading B</button><button>Fading C</button></main></div><a href="/x">Solid</a>`);
  s = await snap();
  check('opacity rule dropped when it would hide most of the page', s.opacityFallback === true && !!el(s, 'Fading A'), short(s.elements));
  await load(`${XBOX}<main><p>Sign in again</p><x-box data-html="<input type='password' name='pw'>"></x-box></main>`);
  s = await snap();
  check('password field inside a shadow root → hasPassword true', s.hasPassword === true);

  console.log('\nStale ids (generations)');
  await load(`${XBOX}<x-box id="A" data-html="<button onclick='window.__clicks.push(&quot;A&quot;)'>Keep subscription</button>"></x-box>
    <x-box id="B" data-html="<button onclick='window.__clicks.push(&quot;B&quot;)'>Continue</button>"></x-box><script>window.__clicks = [];</script>`);
  const s1 = await snap();
  check('snapshot 1 tags both shadow buttons', s1.elements.length === 2 && s1.elements[0].text === 'Keep subscription', short(s1.elements));
  await page.evaluate(() => { document.getElementById('A').shadowRoot.querySelector('button').style.display = 'none'; });
  const s2 = await snap();
  check('snapshot 2 has a new gen and only "Continue" as id 1', s2.gen !== s1.gen && s2.elements.length === 1 && s2.elements[0].text === 'Continue', short(s2.elements));
  check('old tags cleared inside shadow roots', await page.evaluate(() => !document.getElementById('A').shadowRoot.querySelector('[data-wa-id]')));
  check('readElement with the old gen → null', (await page.evaluate(readElement, 1, s1.gen)) === null);
  r = await page.evaluate(performAction, { type: 'click', id: 1, gen: s1.gen });
  check('performAction with the old gen is refused', r.ok === false && r.note === 'page changed since it was read', r.note);
  r = await page.evaluate(performAction, { type: 'type', id: 1, gen: s1.gen, text: 'x' });
  check('type with the old gen is refused too', r.ok === false && r.note === 'page changed since it was read');
  check('readElement without gen resolves the CURRENT id 1', (await page.evaluate(readElement, 1))?.text === 'Continue');
  r = await page.evaluate(performAction, { type: 'click', id: 1, gen: s2.gen });
  const clicks = await page.evaluate(() => window.__clicks);
  check('click with the current gen hits the right element', r.ok && clicks.join() === 'B', short(clicks));

  console.log('\nClick-time label check (expect)');
  await load(`<main><button id="b" onclick="window.__clicks.push(this.textContent)">Continue</button>
    <button id="ic" aria-label="Close" onclick="window.__clicks.push('close')"><svg width="16" height="16"></svg></button></main><script>window.__clicks = [];</script>`);
  s = await snap();
  const cb = el(s, 'Continue'), seen1 = await page.evaluate(readElement, cb.id, s.gen);
  await page.evaluate(() => { document.getElementById('b').textContent = 'Confirm cancellation'; });   // re-rendered in place: same node, same tag
  r = await page.evaluate(performAction, { type: 'click', id: cb.id, gen: s.gen, expect: seen1.text });
  const r2 = await page.evaluate(performAction, { type: 'accept_offer', id: cb.id, gen: s.gen, expect: seen1.text });
  check('a click whose label changed since readElement is refused and nothing is clicked', r.ok === false && r.note === 'page changed since it was read' && r2.ok === false && (await page.evaluate(() => window.__clicks.length)) === 0, `${r.note} / ${r2.note}`);
  await page.evaluate(() => { document.getElementById('b').textContent = '  Continue\n  '; });
  r = await page.evaluate(performAction, { type: 'click', id: cb.id, gen: s.gen, expect: ' Continue ' });
  const icon = el(s, 'Close'), seen2 = await page.evaluate(readElement, icon.id, s.gen);
  const r3 = await page.evaluate(performAction, { type: 'click', id: icon.id, gen: s.gen, expect: seen2.text });
  check('a matching label (whitespace aside, or an icon button\'s aria-label) clicks', r.ok && r3.ok && (await page.evaluate(() => window.__clicks.length)) === 2, `${r.note} / ${r3.note}`);

  console.log('\nPrices');
  await load(`<header><div>Cart</div><div>0</div><div>$0.00</div></header>
    <main>
      <p>Pro annual $1,299.99/year</p><p>Starter USD 9.99 per month</p><p>Euro plan €9,99</p><p>UK plan £7.99 a month</p>
      <p>Team 12.99 USD/month</p><p>Japan ¥1,500</p><p>Canada CA$12.99/mo</p><p>Brazil R$ 99,90</p>
      <p>Monthly $14.99 billed monthly</p><p>Yearly $120 billed annually</p>
      <pre>self.__next_f.push([1,"[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\\"$L7\\"}]"])</pre>
      <p>Buy $8 100 credits</p><p>Founded 2024 USD rates</p><p>Premium ($17.49/month)</p><p>Plus $20 USD/month</p>
      <p>Intro: $1 for 3 months</p><p>Premium $17.49/month again</p><div><b>$6</b><div>/month</div></div>
      <p>Questions? Visit our help center any time.</p><p>Save $2 today on popcorn at the snack bar with a coupon</p>
    </main>`);
  s = await snap();
  const has = (amount, currency, unit) => s.prices.some((p) => p.amount === amount && p.currency === currency && p.unit === unit);
  check('$1,299.99/year → 1299.99 USD year', has(1299.99, 'USD', 'year'));
  check('USD 9.99 per month', has(9.99, 'USD', 'month'));
  check('€9,99 → 9.99 EUR', has(9.99, 'EUR', ''));
  check('£7.99 a month', has(7.99, 'GBP', 'month'));
  check('12.99 USD/month', has(12.99, 'USD', 'month'));
  check('¥1,500 → 1500 JPY', has(1500, 'JPY', ''));
  check('CA$12.99/mo → CAD month', has(12.99, 'CAD', 'month'));
  check('R$ 99,90 → 99.9 BRL (the next line\'s "Monthly" is not its unit)', has(99.9, 'BRL', ''), short(s.prices.find((p) => p.amount === 99.9)));
  check('$14.99 billed monthly', has(14.99, 'USD', 'month'));
  check('$120 billed annually', has(120, 'USD', 'year'));
  check('RSC tokens "$1" / $L7 ignored', s.prices.filter((p) => p.amount === 1).every((p) => /Intro: \$1 for/.test(p.context)) && !s.prices.some((p) => p.amount === 7), short(s.prices.map((p) => p.amount)));
  check('"$6" then "/month" on the next line → month', has(6, 'USD', 'month'));
  check('cart $0.00 ignored', !s.prices.some((p) => p.amount === 0));
  check('$8 100 credits is 8, not 8100', has(8, 'USD', '') && !s.prices.some((p) => p.amount === 8100));
  check('2024 USD is not a price', !s.prices.some((p) => p.amount === 2024));
  check('($17.49/month) in parentheses kept', has(17.49, 'USD', 'month'));
  check('$20 USD/month gets its unit', has(20, 'USD', 'month'));
  check('bare "$2" with no plan context dropped', !s.prices.some((p) => p.amount === 2));
  check('"$1 for 3 months" intro offer kept', s.prices.some((p) => p.amount === 1 && /Intro/.test(p.context)));
  check('duplicate amount+unit listed once', s.prices.filter((p) => p.amount === 17.49).length === 1);
  check('every price has a context', s.prices.every((p) => typeof p.context === 'string' && p.context.length > 3));
  // R23: a card phrase 51–117 chars before a price (the old 70-char cut landed inside it at ~64–72) stays whole, so
  // the scrubber sees 'Visa ending in 4242'; and no context starts or ends inside a word.
  const gaps = Array.from({ length: 34 }, (_, i) => 10 + 2 * i);   // phrase starts 41 + gap chars before the price
  await load(`<main>${gaps.map((g, i) => `<p>Filler paragraph ${i} with plain words only and nothing else in it, just some padding text to keep samples apart.</p><p>Visa ending in 4242 · Default · ${'x'.repeat(g)} Premium $${(10 + i / 100).toFixed(2)}/month</p>`).join('')}</main>`);
  s = await snap({ textChars: 20000 });
  const toks = new Set(s.text.split(/\s+/)), cards = s.prices.filter((p) => p.amount >= 10 && p.amount < 11);
  check('price context: a card phrase up to ~117 chars back is kept whole (never "ng in 4242")', cards.length === gaps.length && cards.every((p) => p.context.includes('Visa ending in 4242')), short(cards.filter((p) => !p.context.includes('Visa ending in 4242')).map((p) => p.context)));
  check('price context: whole words at both edges', cards.every((p) => { const w = p.context.trim().split(/\s+/); return toks.has(w[0]) && toks.has(w[w.length - 1]); }), short(cards.map((p) => p.context).find((c) => { const w = c.trim().split(/\s+/); return !toks.has(w[0]) || !toks.has(w[w.length - 1]); })));

  console.log('\nIdentity');
  await load(`<header><a href="/"><img src="${GIF}" alt="" width="20" height="20">Streamly</a>
      <button id="avatar" aria-haspopup="menu" aria-controls="acct-menu" aria-expanded="false" title="Account"><img src="${GIF}" alt="Profile of Jane Doe" width="30" height="30"></button>
      <button aria-haspopup="menu">Products</button>
      <div id="acct-menu" role="menu" hidden><div>Signed in as</div><div>jane.doe@example.com</div>
        <span>logo@2x.png</span><span>billing@streamly.example</span><span>staff@streamly.example</span>
        <a href="mailto:helpdesk@othermail.example">helpdesk@othermail.example</a><script>var x = "script-in-menu@example.com";</script>
        <a role="menuitem" href="/settings">Settings</a></div></header>
    <main><p>Premium plan</p></main>
    <footer><a href="mailto:support@streamly.example">support@streamly.example</a> · <span>contact@streamly.example</span></footer>`);
  s = await snap({ domain: 'streamly.example' });
  check('hidden account-menu email found', s.identity.emails.some((e) => e.value === 'jane.doe@example.com' && e.source === 'account-menu'), short(s.identity));
  check('only that email (traps ignored: @2x.png, same-domain, mailto, script, footer)', s.identity.emails.length === 1, short(s.identity.emails));
  check('avatar hint from title + img alt', s.identity.hints[0]?.source === 'account-menu' && /Profile of Jane Doe/.test(s.identity.hints[0].text), short(s.identity.hints));
  check('generic nav trigger ("Products") is not a hint', !s.identity.hints.some((h) => h.text === 'Products'));
  check('hidden menu email is not in the page text', !s.text.includes('jane.doe@example.com'));
  await load(`<header><a href="/acct" aria-label="Google Account: Jane Doe (jane.d@gmail.com)"><img src="${GIF}" alt="" width="30" height="30"></a></header><main><p>Home</p></main>`);
  s = await snap({ domain: 'google.com' });
  check('email in an account link aria-label found', s.identity.emails[0]?.value === 'jane.d@gmail.com', short(s.identity));
  await load(`<header><button aria-label="Account menu for pat@outlook.com">P</button></header><main><p>Outlook</p></main>`);
  s = await snap({ domain: 'outlook.com' });
  check('same-domain address kept when the service is a mail provider', s.identity.emails[0]?.value === 'pat@outlook.com', short(s.identity));
  // One page-data identity per page: two distinct addresses are a list of people (checked further down).
  await load(`<main><p>Welcome back</p></main>
    <script type="application/json" id="app-state">{"session":{"user":{"email":"pat@example.org","id":"u_1"}},"csrfToken":"0123456789abcdef0123456789abcdef"}</script>
    <script type="application/ld+json">{"@type":"Organization","contactPoint":{"contactType":"customer service","email":"help@shop.example"}}</script>
    <script>window.config = {"theme":"dark","locale":"en","email":"orphan@example.net"};</script>`);
  s = await snap({ domain: 'shop.example' });
  check('page-data: session user email found', s.identity.emails.some((e) => e.value === 'pat@example.org' && e.source === 'page-data'), short(s.identity));
  check('page-data: role address and email without a user/session key ignored', !s.identity.emails.some((e) => /help@|orphan@/.test(e.value)), short(s.identity.emails));
  check('page-data never reaches the text', !s.text.includes('pat@example.org') && !s.text.includes('csrfToken'));
  await load(`<main><p>Welcome back</p></main><script>self.__next_f.push([1,"{\\"viewer\\":{\\"email\\":\\"rsc.user@example.com\\"}}"])</script>`);
  s = await snap({ domain: 'shop.example' });
  check('page-data: escaped RSC viewer email found', s.identity.emails.some((e) => e.value === 'rsc.user@example.com'), short(s.identity));

  // R15: only the object a singular identity key owns, never an array element's, never a list, never after the menu.
  const pageData = async (json, head = '') => { await load(`<header>${head}</header><main><p>Dashboard</p></main><script type="application/json">${json}</script>`); return (await snap({ domain: 'shop.example' })).identity.emails; };
  let em = await pageData('{"user":{"id":"u_1"},"team":{"teamMembers":[{"email":"alice.coworker@acme.example"},{"email":"bob.coworker@acme.example"}]}}');
  check('page-data: teammates in an array next to "user" are not the identity', em.length === 0, short(em));
  em = await pageData('{"viewer":{"id":"v1"},"recentOrders":[{"id":"o1","customer":{"email":"pat.customer@example.org"}}]}');
  check('page-data: a customer inside an order list is not the identity (even a single one)', em.length === 0, short(em));
  em = await pageData('{"session":{"id":"s1"},"gifts":[{"email":"harry.recipient@example.com"}]}');
  check('page-data: a gift recipient near "session" is not the identity', em.length === 0, short(em));
  em = await pageData('{"user":{"email":"pat@example.org"},"account":{"email":"other.person@example.net"}}');
  check('page-data: two distinct identity-key addresses → none', em.length === 0, short(em));
  em = await pageData('{"user":{"email":"someone.else@example.net"}}', '<button aria-label="Account menu for pat@outlook.com">P</button>');
  check('page-data skipped once the account menu named someone', em.length === 1 && em[0].value === 'pat@outlook.com' && em[0].source === 'account-menu', short(em));

  // R17: tabs, notification/share/help panels and collaborator avatars are other people, not the account menu.
  await load(`<header>
      <div role="tablist"><button role="tab" aria-controls="p-members" aria-selected="false">Members</button><button role="tab" aria-controls="p-general" aria-selected="true">General</button></div>
      <button aria-controls="notif" aria-label="Notifications"><img src="${GIF}" alt="" width="20" height="20"></button>
      <div id="notif" hidden>carol.inviter@example.net invited you to a project</div>
      <button aria-haspopup="dialog">Share</button><div role="dialog" hidden>Shared with dave.collab@example.net and erin.collab@example.net</div>
      <img class="avatar" title="frank.teammate@acme.example" src="${GIF}" width="24" height="24"><img class="avatar" title="grace.teammate@acme.example" src="${GIF}" width="24" height="24">
      <span data-testid="user-avatar-chip" title="kim.collab@example.net">K</span><span data-testid="user-avatar-chip" title="lee.collab@example.net">L</span>
    </header>
    <nav><button aria-haspopup="menu" aria-controls="help-menu">Help</button><div id="help-menu" role="menu" hidden>helpdesk@svc-mail.example media@svc-mail.example</div></nav>
    <main><div id="p-members" role="tabpanel" hidden>ivan.teammate@acme.example judy.teammate@acme.example</div><div id="p-general" role="tabpanel"><p>Project settings</p></div></main>`);
  s = await snap({ domain: 'app.example' });
  check('account-menu: tab panel, notifications, share dialog, help menu and repeated avatars give no email', s.identity.emails.length === 0, short(s.identity));
  check('account-menu: a tab ("Members"), "Share" and collaborator avatars are not hints', !s.identity.hints.some((h) => /Members|Share|frank|grace|kim|lee/.test(h.text)), short(s.identity.hints));
  await load(`<header><a href="/acct" aria-label="Account: Pat Doe (pat.doe@example.com)" aria-controls="sw"><img src="${GIF}" alt="" width="30" height="30"></a>
    <div id="sw" hidden>pat.doe@example.com · Switch to pat.work@example.net · Add another account</div></header><main><p>Home</p></main>`);
  s = await snap({ domain: 'service.example' });
  check('account-menu: the trigger label email is kept; a menu listing two addresses adds none', s.identity.emails.length === 1 && s.identity.emails[0].value === 'pat.doe@example.com', short(s.identity.emails));
  await load(`<header><button title="Profile: sam.one@example.com">S</button><button title="Profile: tia.two@example.com">T</button></header><main><p>Team</p></main>`);
  s = await snap({ domain: 'service.example' });
  check('account-menu: account triggers naming two different addresses give none (no email, no hint)', s.identity.emails.length === 0 && !s.identity.hints.some((h) => /@/.test(h.text)), short(s.identity));
  await load(`<header><button class="avatar-btn" aria-haspopup="menu" aria-controls="um"><img src="${GIF}" alt="Pat" width="30" height="30"></button>
    <div id="um" role="menu" hidden><div>pat.doe@example.com</div><a role="menuitem" href="/settings">Settings</a></div></header><main><p>Home</p></main>`);
  s = await snap({ domain: 'service.example' });
  check('account-menu: a lone avatar button still has its menu read', s.identity.emails[0]?.value === 'pat.doe@example.com' && s.identity.emails[0].source === 'account-menu' && s.identity.hints[0]?.text === 'Pat', short(s.identity));
  await load(`<main><form><input type="email" name="email" value="remembered@example.com"><input type="password" name="pw"><button>Sign in</button></form></main>`);
  s = await snap({ domain: 'shop.example' });
  check('prefilled login email tagged login-form; visible password → hasPassword', s.identity.emails[0]?.value === 'remembered@example.com' && s.identity.emails[0].source === 'login-form' && s.hasPassword === true, short(s.identity));

  console.log('\nFrames (diagnostic only)');
  await load(`<main><p>Billing</p><iframe srcdoc="<p>framed</p>" width="400" height="300"></iframe><iframe src="https://billing.example.com/embed" width="500" height="400"></iframe><iframe width="1" height="1"></iframe></main>`);
  s = await snap();
  check('visible frames ≥ 200×100 recorded with host', s.frames.length === 2 && s.frames[0].host === 'srcdoc' && s.frames[1].host === 'billing.example.com' && s.frames[1].w >= 500, short(s.frames));
  check('frame text is never read', !s.text.includes('framed'));

  console.log('\nreadinessProbe');
  const probe = () => page.evaluate(readinessProbe);
  await load(`<div id="root">Loading…</div>`);
  let p = await probe();
  check('"Loading" shell → loadingText, nothing interactive', p.loadingText === true && p.interactiveCount === 0 && p.challenge === false, short(p));
  await load(`<h1>Opening Discord App.</h1>`);
  check('"Opening … App." → loadingText', (await probe()).loadingText === true);
  await load(`<h1>shop.example</h1><p>Verify you are human by completing the action below.</p><div id="cf-chl-widget-abc"></div>`);
  p = await probe();
  check('Cloudflare-style challenge page → challenge', p.challenge === true, short(p));
  await load(`<div id="challenge-container"></div><script>window.AwsWafIntegration = { getToken: function () {} };</script>`);
  check('AWS WAF interstitial (global, near-empty page) → challenge', (await probe()).challenge === true);
  // R24: Turnstile on ordinary forms is not a robot check; the interstitial is found by its own markers.
  await load(`<main><h1>Billing</h1><p>${'Your Premium plan renews monthly and you can change or cancel it at any time. '.repeat(6)}</p><p>Premium $15.99/month</p>
    <button>Change plan</button><button>Cancel plan</button><a href="/invoices">Invoices</a></main>
    <footer><form><input type="email" name="newsletter"><iframe id="cf-chl-widget-x9y8z" src="about:blank" width="300" height="65"></iframe><input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-x9y8z_response"><button>Subscribe</button></form></footer>
    <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`);
  p = await probe();
  check('Turnstile widget + jsd script on an ordinary billing page → not a challenge', p.challenge === false, short(p));
  await load(`<main><form><h1>Sign in</h1><input type="email"><input type="password"><div id="cf-chl-widget-a1"><input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-a1_response"></div><button>Sign in</button></form></main>`);
  check('Turnstile inside a sign-in form → not a challenge', (await probe()).challenge === false);
  await load(`<div id="cf-chl-widget-q"></div><input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-q_response">`);
  check('Turnstile alone on a near-empty page → challenge', (await probe()).challenge === true);
  await load(`<div class="main-wrapper"><h1>shop.example</h1><p>${'Wir prüfen kurz, ob die Verbindung sicher ist, bevor es weitergeht. '.repeat(4)}</p></div><script>window._cf_chl_opt = { cType: 'managed', cRay: 'x' };</script>`);
  p = await probe();
  check('localized Cloudflare interstitial (_cf_chl_opt, text over 200 chars) → challenge', p.challenge === true && p.visibleTextLen > 200, short(p));
  await load(`<p>${'Einen Moment bitte, die Seite wird gleich geladen und geprüft. '.repeat(4)}</p><script>document.title = 'Just a moment...';</script>`);
  check('"Just a moment..." title → challenge', (await probe()).challenge === true);
  await load(`<header><nav><a href="/">Home</a><a href="/account">Account</a></nav></header><main><h1>Your membership</h1><p>${'Premium plan, renews on the 3rd. '.repeat(10)}</p><button>Manage</button>
    <div role="progressbar" style="display:none"></div><iframe src="https://www.example.com/recaptcha/api2/anchor?size=normal" width="256" height="60"></iframe></main>`);
  p = await probe();
  check('rendered account page → ready signals', p.interactiveCount >= 3 && p.visibleTextLen > 120 && !p.loadingText && !p.challenge && !p.busy && p.readyState === 'complete', short(p));
  check('small captcha frame on a full page is not a challenge; hidden progressbar not busy', p.challenge === false && p.busy === false);
  await load(`<main aria-busy="true"><p>${'Fetching your plan details now. '.repeat(5)}</p></main><div role="progressbar" style="width:100px;height:4px"></div>`);
  check('aria-busy main / visible progressbar → busy', (await probe()).busy === true);
  await load(`<main><p>Account</p></main><div role="dialog" aria-modal="true"><p>Wait! Here is 50% off your next 3 months.</p><button>Accept</button></div>`);
  check('topmost open dialog text reported', (await probe()).dialog.startsWith('Wait! Here is 50% off'));
  await load(`${XBOX}<x-box data-html="<h1>Account</h1><p>${'Your plan and billing live in this web component. '.repeat(4)}</p><button>Manage plan</button><input type='password'>"></x-box>`);
  p = await probe();
  check('web-component page: shadow text, controls and password counted', p.visibleTextLen >= 120 && p.interactiveCount >= 1 && p.hasPassword === true, short(p));
  await load(`<form style="display:none"><input type="password"></form><p>Hello</p>`);
  check('hidden password field → hasPassword false', (await probe()).hasPassword === false);

  console.log('\nRobustness');
  await load('');
  s = await snap();
  check('empty page snapshots without throwing', s.text === '' && s.elements.length === 0 && Array.isArray(s.prices) && !!s.gen);
} catch (e) {
  check('test run threw', false, String((e && e.stack) || e));
} finally { await browser.close(); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
