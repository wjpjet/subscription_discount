import { z } from 'zod';
import { generateStructured, AIDeclined, BRAIN, ZERO_USAGE, addUsage } from './llm.mjs';
import { STATES, ACTIONS, OUTCOMES } from '../../../shared/guardrails.js';
import { isSensitive, sensitiveReason } from '../../../shared/sensitive.js';
import { mockDecide, mockClassify, mockDiscover, guardPageClass, normUnit, PAGE_KINDS, ACCOUNT_TYPES, BILLED_VIA } from '../../../shared/brain-mock.js';
import { scrubSecrets, scrubPii, scrubUrl } from '../../../shared/scrub.js';

export const Decision = z.object({
  state: z.enum(STATES),
  reasoning: z.string().describe('One or two sentences: what this screen is and why this action.'),
  action: z.object({
    type: z.enum(ACTIONS),
    id: z.number().int().nullable().describe('Element id from the snapshot (click/type/select/accept_offer).'),
    text: z.string().nullable().describe('Text to type (type only).'),
    value: z.string().nullable().describe('Option to choose (select only).'),
    url: z.string().nullable().describe('Same-site URL (navigate only).'),
    direction: z.enum(['up', 'down']).nullable(),
    reason: z.string().nullable().describe('Why (back_out / wait).'),
    offer: z.object({ description: z.string(), newMonthlyPriceUsd: z.number().nullable(), discountPct: z.number().nullable(), termMonths: z.number().nullable(), freeMonths: z.number().nullable() }).nullable().describe('The offer being accepted (accept_offer only).'),
    outcome: z.enum(OUTCOMES).nullable().describe('finish only. Never choose offer_found; the system assigns it.'),
    details: z.object({ beforeMonthlyPriceUsd: z.number().nullable(), afterMonthlyPriceUsd: z.number().nullable(), termMonths: z.number().nullable(), savingsUsd: z.number().nullable(), summary: z.string() }).nullable().describe('finish only.'),
  }),
});

// Declaration order is generation order (llm.mjs emits propertyOrdering for Gemini; Anthropic keeps it): the model
// names the kind of page, and quotes why, before it reads any plan or money off it. Length limits live in the
// descriptions and are enforced in guardPageClass (a .max() may not survive the Gemini schema conversion).
export const PageClass = z.object({
  pageEvidence: z.string().describe('At most 80 chars quoting the title, heading or element that decided pageKind.'),
  pageKind: z.enum(PAGE_KINDS),
  signedIn: z.boolean().describe('True only when the page shows signed-in chrome (avatar/account menu, greeting, sign-out) or account data.'),
  accountType: z.enum(ACCOUNT_TYPES),
  billedVia: z.enum(BILLED_VIA).describe('Only from visible wording about who bills the plan.'),
  accountName: z.string().nullable().describe('Display name of the signed-in account or active profile (greeting, avatar or menu label); null on a login page.'),
  accountEmail: z.string().nullable().describe('The signed-in account email; on a login page, an email pre-filled in the form. Never a support, billing or other role address.'),
  isPlanPage: z.boolean().describe('True when this page shows the account\'s current plan, membership or billing.'),
  hasPaidPlan: z.boolean().nullable(),
  planName: z.string().nullable(),
  currentPriceIndex: z.number().int().nullable().describe('The [n] of the PRICES entry that is the current plan\'s price; null if it is not in the list.'),
  priceEvidence: z.string().nullable().describe('At most 80 chars quoting the text that shows the current plan\'s price.'),
  monthlyPriceUsd: z.number().nullable().describe('Current recurring price normalized to per month.'),
  cycleChargeUsd: z.number().nullable().describe('What is actually charged per billing cycle, not normalized: e.g. 120 for a $120/year plan, 0 during a free trial.'),
  cadence: z.enum(['month', 'year', 'week', 'unknown']),
  renewalDate: z.string().nullable().describe('Next charge / renewal date as YYYY-MM-DD when the page shows one.'),
  isTrial: z.boolean().describe('True if the plan is currently in a free or discounted trial period.'),
  trialEndsOn: z.string().nullable().describe('YYYY-MM-DD the trial ends, if shown.'),
  priceAfterTrialUsd: z.number().nullable().describe('Per-month price once the trial ends, if shown.'),
  offerApplied: z.boolean().describe('True if a promotional/loyalty price is currently applied.'),
  offerText: z.string().nullable(),
  detailsLinkId: z.number().int().nullable().describe('Element id of the same-site <a> most likely to show the current plan, price or billing; null if this page already shows them.'),
  confidence: z.number(),
  notes: z.string(),
});

const OTHER_KINDS = ['adtech_tracking', 'infrastructure', 'employer_or_work', 'retail_travel', 'social_or_media_free', 'financial_or_health', 'unknown'];
// Two lists so non-subscriptions cost a few tokens each instead of a full object (most domains sent are ad-tech).
export const Discovery = z.object({
  subscriptions: z.array(z.object({
    domain: z.string(),
    name: z.string().describe('The brand people know, e.g. "ChatGPT" or "Walmart"; never a plan name.'),
    canonicalService: z.string().describe('Lower-case slug shared by every domain that reaches the same account and bill, e.g. amazon-prime for amazon.com and primevideo.com.'),
    audience: z.enum(['consumer', 'business', 'both']),
    billingModel: z.enum(['subscription', 'usage', 'in_person_membership', 'one_time', 'free']),
    payLikelihood: z.number().describe('0..1: how likely one individual with a signed-in session here pays for it personally.'),
    regulatedFinancialOrHealth: z.boolean().describe('True for a bank, lender, brokerage, card issuer, payment app, insurer, health provider or health-insurance portal.'),
    category: z.string(),
    accountUrl: z.string().nullable().describe('The signed-in plan/billing page, only if you are confident this exact URL exists today on the service\'s current domain; else null. Never a login, sign-up, pricing or marketing page; never a path or subdomain made up by pattern.'),
    typicalMonthlyPriceUsd: z.number().nullable(),
    makesRetentionOffers: z.enum(['likely', 'unlikely', 'unknown']).describe('Does this service show a discount/loyalty offer during its cancellation flow?'),
    typicalOfferDiscountPct: z.number().nullable().describe('If known: typical discount as a fraction of the monthly price, e.g. 0.5.'),
    typicalOfferTermMonths: z.number().nullable().describe('If known: how many months the offer usually lasts.'),
    confidence: z.number(),
    notes: z.string(),
  })),
  others: z.array(z.object({ domain: z.string(), kind: z.enum(OTHER_KINDS) })),
});

const HUNT_SYSTEM = `You are Walkaway, an agent operating a signed-in browser tab on a subscription service, on the user's behalf.

MISSION
Find the subscription/billing settings, begin the cancellation flow, and proceed through its steps (reason surveys, "are you sure" interstitials) ONLY until one of these happens:
 (a) A retention / loyalty offer appears that keeps the SAME subscription active at a lower price or with free months → call accept_offer on the button that accepts it. Then, on the confirmation screen, call finish with outcome discount_applied and the numbers.
 (b) You reach the final confirmation step and no such offer was made → call back_out. Do not press anything on that screen.
The user wants to KEEP the subscription. Finalizing a cancellation is a failure, never a success.

HARD RULES
- Never click anything that confirms, completes, or proceeds with cancellation, declines an offer ("no thanks", "continue cancelling"), turns off auto-renew, pauses, downgrades, or deletes/closes the account. If the only options are those, call back_out.
- Once an offer is on screen, the only valid actions are accept_offer or back_out.
- Do not accept pauses, downgrades, plan switches, or offers that change the product. Only discounts / free months on the current plan. If several qualifying offers exist, pick the largest saving.
- Never type into password or payment fields. If a login page appears, finish with outcome blocked_needs_you.
- navigate only to URLs on this service's own site (the SERVICE domain or a listed site domain). Prefer clicking visible elements; use navigate for obvious account/settings paths when no link is visible.
- One action per step. If nothing changed after an action, try a different element; after three fruitless steps, back_out.
- Classify the screen honestly in "state". Use about_to_finalize_cancel when the screen's primary purpose is confirming cancellation. Use ambiguous when unsure — ambiguity resolves to back_out, never forward.

OUTPUT
Return exactly one decision: the screen state, a one-sentence reasoning, and one action. Element ids refer to the numbered elements in the snapshot.`;

export const CLASSIFY_SYSTEM = `You read a snapshot of one page of a subscription service, opened in the user's own browser, and report what it shows about the user's account and subscription. Fill the fields in order; judge only from what is visible on the page (URL, title, headings, elements, page text), never from embedded JSON, scripts or state data.

1. pageKind FIRST, from the URL, TITLE and HEADINGS before anything else; pageEvidence quotes (at most 80 chars) the title, heading or element that decided it.
- not_found: "404", "not found", "page could not be found", "doesn't exist", "uh-oh", "you're lost", or a URL path ending in /error or /404 — even when the header shows the user signed in. Exception: a page asking the user to switch to or sign in with a personal account is account_other with accountType work_or_team, even on an /error URL.
- error: "something went wrong", "there's been a glitch", "try again later", or another application error.
- loading: "Loading…", "Opening … app", a spinner or redirect shell, or a near-empty page with almost no text and no controls.
- bot_challenge: a robot, captcha or firewall check ("verify you are human", "are you a robot", "just a moment", "press and hold", "checking your browser").
- login: a sign-in or sign-up form, or a sign-in wall, with no signed-in chrome.
- reauth: signed-in chrome (avatar, profile name, "Log out") together with a password prompt asking the user to confirm who they are.
- marketing: a public pricing, plans, landing or sales page with no marker of the user's own current plan.
- account_billing: the user's plan, membership, subscription or billing page.
- account_other: any other page of the signed-in account (profile, settings, dashboard, home feed).
- other: anything else.
2. signedIn=true only when the page shows signed-in chrome or account data: an avatar or account menu, a greeting with the user's name, "Sign out"/"Log out", or this account's own plan or settings. A user menu with no "Log in" control counts, even on a sales page. Otherwise false.
3. accountType=work_or_team when the account is owned or administered by an employer or organization: Google Workspace ("Manage Google Workspace account", "managed by your organization"), team or enterprise admin navigation (Team settings, Members & groups, Invite teammates, SSO/SAML), an organization or company name next to the user, billing managed by an administrator, or a page asking to switch to or sign in with a personal account. Name the organization in notes. Family and household plans are personal. A custom email domain alone is not evidence. personal when it is clearly an individual's own account; otherwise unknown.
4. billedVia from visible wording only: app_store (billed through Apple, the App Store or Google Play), carrier (a phone, cable or internet provider), bundle_or_partner (included with or billed by another company: a bundle, Amazon Channels, a card or retail perk), employer (the organization pays), direct (the service bills the user's own payment method), else unknown.
5. accountName and accountEmail belong to the signed-in account. Prefer the IDENTITY HINTS from the account menu. Never a support, billing, sales or other role address, and never one from a mailto link or the footer. On a login page, an email pre-filled in the sign-in form may be reported as accountEmail. If the visible profile or name clearly belongs to a different person than the email, say so in notes.
6. isPlanPage=true when this page shows the account's current plan, membership or billing.
7. hasPaidPlan:
- true when the page shows this account's current paid membership: a named plan with its price, a renewal or next-charge date, a payment method billed for it, or controls to manage or cancel that named membership (e.g. "Prime membership — Manage, update, or cancel"); planName is that membership. A free or discounted trial that will convert to a paid plan counts. Upsells for add-ons or higher tiers never make it false.
- false ONLY when the page says so explicitly: a free plan marked current, "not subscribed", "no active subscriptions", "not supporting any creators", or another empty state.
- null otherwise: not the plan page, a list that has not rendered, or an error, loading or login page; when the text is mostly code, also confidence at most 0.5. A generic "Manage plan", "Upgrade" or "Join" link alone is not evidence.
8. Money, renewal and trial fields describe ONLY the plan this account has now. Never take them from comparison tables, Upgrade/Subscribe/Try cards, purchase or rental history, cart totals or add-ons. Unless hasPaidPlan is true, leave them null (isTrial=false, offerApplied=false, cadence unknown). currentPriceIndex is the [n] of the PRICES entry that is the current plan's price (null if the price is not in that list); priceEvidence quotes the text that shows it. monthlyPriceUsd is per month in USD (a yearly price divided by 12). cycleChargeUsd is what is charged per billing cycle (120 for $120/year; 0 during a free trial, with isTrial=true and priceAfterTrialUsd the per-month price afterwards). renewalDate and trialEndsOn as YYYY-MM-DD. offerApplied and offerText when a promotional or loyalty price applies now.
9. detailsLinkId: when this page does not show the plan or its price, the element id of the <a> link on this site most likely to show them (Billing, Membership, Plan, Subscription, Manage membership). Never a cancel, sign-out, delete, upgrade or checkout link. Null when this page already shows them.
10. confidence (0 to 1) in the whole reading; notes: one or two sentences on what the page is and why.`;

const DISCOVER_SYSTEM = `You classify website domains for ONE individual person: they come from that person's own browser, where they have cookies. For each domain decide whether it is a service with recurring paid plans that this person could be paying for personally (streaming, news, music, software, AI assistants, VPN, fitness apps, dating, cloud storage, memberships, etc.). Use your knowledge of the company.

Return two lists; every domain goes in exactly one, spelled exactly as given.
- subscriptions: services with recurring paid plans for individuals, with full details.
- others: everything else, with its kind: adtech_tracking (ads, analytics, identity sync, fraud or bot detection), infrastructure (CDNs, APIs, sign-in and payment providers, hosting), employer_or_work (a company's own sites and internal tools), retail_travel (shops, marketplaces, airlines, hotels, delivery without a paid membership), social_or_media_free (free social networks, forums, blogs and sites without a paid plan), financial_or_health, unknown.

Rules:
- Financial institutions of any kind (banks, credit unions, credit cards, brokerages, crypto exchanges, payment apps, lenders, credit bureaus), insurers, health providers and health-insurance portals, payroll, tax and government sites are NEVER subscriptions here: always others, kind financial_or_health. Apps ABOUT money or health (budgeting, investing research, financial news, fitness trackers, meditation) are ordinary subscriptions with regulatedFinancialOrHealth=false.
- The person is an individual, not a company. Team, enterprise and developer tools that employers usually buy are audience=business (both when individuals also commonly buy a personal plan). A platform whose paying customers are merchants, creators, publishers or businesses (store builders, course platforms, booking tools, comment widgets, e-signature) is not a subscription for this person: the cookie usually means they bought from, studied on or signed through a site built on it. Usage-billed APIs, shops, blogs and gyms whose membership is run in the club are not subscriptions either; if you list a borderline one, say so in billingModel.
- These ARE subscriptions: wine, coffee, meal-kit and subscription-box clubs; cloud gaming and game passes (GeForce NOW, Xbox Game Pass, PlayStation Plus); paid airline-lounge and hotel memberships. Free loyalty, rewards and frequent-flyer programs are not.
- Free social apps with an optional paid tier (Snapchat+, Reddit Premium, Meta Verified, X Premium) are subscriptions with a LOW payLikelihood (about 0.05 to 0.2).
- Use each domain's CURRENT product and owner (threads.com is Meta's Threads, a free social app).
- name is the brand people know ("ChatGPT", "Walmart"), never a plan name.
- canonicalService is a lower-case slug shared by every domain that reaches the same account and bill: amazon-prime for amazon.com and primevideo.com, apple for apple.com and icloud.com, microsoft for microsoft.com and live.com, chatgpt for openai.com and chatgpt.com, claude for claude.ai and claude.com, cursor for cursor.sh and cursor.com. Separately billed products get their own slug (youtube-premium is not google-one; amazon-music is not amazon-prime).
- accountUrl: only a page you are confident exists today on the service's CURRENT domain and brand and shows the signed-in plan or billing; if you are not sure of the exact URL, null. Never a login, sign-up, pricing or marketing page. Never build /account, /billing or /subscription paths by analogy with other sites, and never invent a subdomain.
- Also give a typical monthly price in USD, whether the service is known to present a discount or loyalty offer during its cancellation flow, and if known the typical discount fraction and term in months.`;

// Defense in depth: the extension already sanitizes what it sends; these run again before the model sees it. scrubPii
// too (card tails, expiry, addresses): history targets, click notes and dialogs come from raw page text, and its
// markers ([card], [exp]) are not matched again, so a second pass over text the extension scrubbed is safe.
const clean = (t) => scrubPii(scrubSecrets(String(t || '')));
export function renderSnapshot(s) {
  const lines = [`URL: ${scrubUrl(String(s.url || ''))}`, `TITLE: ${clean(s.title)}`];
  if (s.headings && s.headings.length) lines.push(`HEADINGS: ${s.headings.map(clean).join(' | ')}`);
  if (s.hasPassword) lines.push('NOTE: a password field is visible');
  // Numbered so the classifier can cite the current plan's price (currentPriceIndex); the guard checks the same 12.
  if (s.prices && s.prices.length) lines.push('PRICES: ' + s.prices.slice(0, 12).map((p, i) => { const u = normUnit(p.unit); return `[${i}] ${p.currency || 'USD'} ${p.amount}${u ? '/' + u : ''} («${clean(p.context).replace(/\s+/g, ' ').trim()}»)`; }).join(' ; '));
  const idn = s.identity || {}, hints = (idn.hints || []).slice(0, 4), emails = (idn.emails || []).slice(0, 3);
  if (hints.length || emails.length) {
    lines.push('IDENTITY HINTS:');
    for (const h of hints) lines.push(`  ${h.source || 'page'}: "${clean(h.text).replace(/\s+/g, ' ').trim().slice(0, 100)}"`);
    for (const e of emails) lines.push(`  email (${e.source || 'page'}): ${String(e.value || '').slice(0, 120)}`);
  }
  if (s.frames && s.frames.length) lines.push('FRAMES: ' + s.frames.slice(0, 6).map((f) => `${f.host} ${f.w}×${f.h}`).join(' ; '));
  lines.push('ELEMENTS:');
  for (const e of s.elements || []) {
    const bits = [`[${e.id}] <${e.tag}${e.role ? ' role=' + e.role : ''}${e.type ? ' type=' + e.type : ''}${e.region && e.region !== 'page' ? ' region=' + e.region : ''}>`];
    if (e.text) bits.push(`"${clean(e.text)}"`);
    if (e.label && e.label !== e.text) bits.push(`label="${clean(e.label)}"`);
    if (e.href) bits.push(`href=${scrubUrl(String(e.href))}`);
    if (e.name) bits.push(`name=${e.name}`);
    if (e.placeholder) bits.push(`placeholder="${clean(e.placeholder)}"`);
    if (e.value) bits.push(`value="${clean(e.value)}"`);
    if (e.checked != null) bits.push(e.checked ? 'checked' : 'unchecked');
    if (e.expanded != null) bits.push(e.expanded ? 'expanded' : 'collapsed');
    if (e.options) bits.push(`options=${JSON.stringify(e.options)}`);
    if (e.disabled) bits.push('DISABLED');
    if (e.offscreen) bits.push('(offscreen)');
    lines.push('  ' + bits.join(' '));
  }
  lines.push('PAGE TEXT (truncated):', clean(String(s.text || '').slice(0, 4000)).slice(0, 3500));
  return lines.join('\n');
}
/** One line of the extension's readiness probe, so the classifier knows a page was still loading or challenged. */
export function renderReadiness(r) {
  if (!r || typeof r !== 'object') return null;
  const yn = (b) => (b ? 'yes' : 'no'), n = (v) => (typeof v === 'number' && isFinite(v) ? v : '?');
  return `READINESS: readyState=${String(r.readyState || '?').slice(0, 20)}, visible text ${n(r.visibleTextLen)} chars, ${n(r.interactiveCount)} controls, busy=${yn(r.busy)}, loading text=${yn(r.loadingText)}, robot check=${yn(r.challenge)}, password field=${yn(r.hasPassword)}${r.dialog ? `, open dialog: "${clean(r.dialog).slice(0, 80)}"` : ''}`;
}
/** The walk so far. Targets and notes are the clicked element's own label (a row can read "Visa ending in 4242"). */
export function renderHistory(history) {
  if (!history || !history.length) return '(none)';
  return history.slice(-12).map((h) => `step ${h.step}: [${h.state}] ${h.action ? h.action.type : ''}${h.action && h.action.id != null ? ' #' + h.action.id : ''}${h.target ? ' "' + clean(h.target) + '"' : ''}${h.note ? ' — ' + clean(h.note) : ''} @ ${h.url ? scrubUrl(String(h.url)) : ''}`).join('\n');
}
/** An earlier walk's route to the offer (element labels), or null when there is none. */
export function renderPriorPath(priorPath) {
  return Array.isArray(priorPath) && priorPath.length ? `PRIOR PATH (an earlier walk reached the offer this way; prefer the same route):\n${priorPath.map((p) => '- ' + clean(p)).join('\n')}` : null;
}
const NULLS = { id: null, text: null, value: null, url: null, direction: null, reason: null, offer: null, outcome: null, details: null };

export async function decide(input) {
  if (BRAIN === 'mock') return mockDecide(input);
  const { merchant, goal, step, maxSteps, history, snapshot, priorPath } = input;
  // The service's site set (e.g. primevideo.com's account lives on amazon.com): the guardrail allows navigating to any of them.
  const sites = [...new Set((Array.isArray(merchant.siteDomains) ? merchant.siteDomains : []).filter((d) => typeof d === 'string' && d && d !== merchant.domain))].slice(0, 5);
  // 'find' uses the hunt instructions unchanged: the model proposes the accept, the guardrail turns it into a pause.
  const user = [
    `SERVICE: ${merchant.name || merchant.domain} (${merchant.domain}${sites.length ? '; site: ' + sites.join(', ') : ''})`,
    `GOAL: ${goal === 'verify' ? 'VERIFY — this is the account/billing page after the run. Do not act; call finish with the current monthly price and whether a promotional price is applied.' : 'HUNT — reach the loyalty offer and accept it; never finalize a cancellation.'}`,
    `STEP: ${step} of ${maxSteps}`,
    renderPriorPath(priorPath),
    `HISTORY:\n${renderHistory(history)}`, `CURRENT PAGE:\n${renderSnapshot(snapshot)}`,
  ].filter(Boolean).join('\n\n');
  try {
    const { output, provider, model, usage } = await generateStructured({ system: HUNT_SYSTEM, user, schema: Decision, maxTokens: 8000, tier: 'main' });
    return { ...output, _provider: provider, _model: model, _usage: usage };
  } catch (e) {
    if (e instanceof AIDeclined) return { state: 'ambiguous', reasoning: e.message, action: { ...NULLS, type: 'back_out', reason: 'ai_declined: ' + e.message }, _provider: 'none' };
    throw e; // outage → HTTP 500 → the extension retries, then stops without acting
  }
}

/** input: { domain, name?, snapshot, readiness? }. Every answer (model, mock, fallback) passes guardPageClass. */
export async function classify(input) {
  const { snapshot } = input, domain = String(input.domain || ''), name = String(input.name || '').slice(0, 120);
  if (BRAIN === 'mock') return { ...mockClassify(snapshot, domain), _provider: 'mock' };
  const user = [`SERVICE: ${name || domain} (${domain})`, renderReadiness(input.readiness), renderSnapshot(snapshot)].filter(Boolean).join('\n\n');
  try {
    const { output, provider, usage } = await generateStructured({ system: CLASSIFY_SYSTEM, user, schema: PageClass, maxTokens: 3000, tier: 'fast' });
    return { ...guardPageClass(output, snapshot, domain), _provider: provider, _usage: usage };
  } catch (e) {
    console.error('[classify] falling back to heuristics:', e.message);
    // Regex-level reading of a real site: capped below the extension's 0.6 bar, so it is reported, never walked.
    const h = mockClassify(snapshot, domain);
    return { ...h, confidence: Math.min(h.confidence, 0.5), notes: `heuristic fallback: ${e.message} · ${h.notes}`, _provider: 'fallback' };
  }
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || null;
const unit01 = (v) => { const n = typeof v === 'number' && isFinite(v) ? v : 0; return Math.max(0, Math.min(1, n > 1 && n <= 100 ? n / 100 : n)); };
const webUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const domainKey = (d) => String(d || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
/** A non-subscription row in the DiscoveredService shape: category = kind, name = domain. */
const otherRow = (domain, kind, confidence, notes) => ({ domain, isSubscription: false, name: domain, category: kind, accountUrl: null, typicalMonthlyPriceUsd: null, makesRetentionOffers: 'unknown', typicalOfferDiscountPct: null, typicalOfferTermMonths: null, confidence, notes,
  canonicalService: null, audience: null, billingModel: null, payLikelihood: 0, regulatedFinancialOrHealth: kind === 'financial_or_health', kind });
const subRow = (domain, s) => ({ domain, isSubscription: true, name: String(s.name || '').trim() || domain, category: s.category || '', accountUrl: webUrl(s.accountUrl), typicalMonthlyPriceUsd: s.typicalMonthlyPriceUsd ?? null,
  makesRetentionOffers: s.makesRetentionOffers || 'unknown', typicalOfferDiscountPct: s.typicalOfferDiscountPct ?? null, typicalOfferTermMonths: s.typicalOfferTermMonths ?? null, confidence: s.confidence ?? 0.5, notes: s.notes || '',
  canonicalService: slug(s.canonicalService), audience: s.audience || null, billingModel: s.billingModel || null, payLikelihood: unit01(s.payLikelihood), regulatedFinancialOrHealth: s.regulatedFinancialOrHealth === true, kind: null });

const discoverCache = new Map();
/** The model answers in two lists (subscriptions / others); the response keeps one DiscoveredService row per domain. */
export async function discover(domains) {
  // Backstop: never-touch sites are answered here, without asking the model (the extension withholds them already).
  const held = (domains || []).filter((d) => isSensitive(d)).map((d) => ({ ...otherRow(d, 'financial_or_health', 1, sensitiveReason(d)), category: 'sensitive (withheld)', regulatedFinancialOrHealth: true }));
  domains = (domains || []).filter((d) => !isSensitive(d));
  if (BRAIN === 'mock') return { services: [...mockDiscover(domains), ...held], usage: ZERO_USAGE };
  const out = [], todo = []; let usage = ZERO_USAGE;
  for (const d of domains) { if (discoverCache.has(d)) out.push(discoverCache.get(d)); else todo.push(d); }
  for (let i = 0; i < todo.length; i += 25) {   // small chunks: each call stays well under a 10s function timeout
    const chunk = todo.slice(i, i + 25);
    const { output, usage: u } = await generateStructured({ system: DISCOVER_SYSTEM, user: `Classify these domains:\n${chunk.join('\n')}`, schema: Discovery, maxTokens: 6000, tier: 'fast' });
    usage = addUsage(usage, u);
    const subs = new Map((output.subscriptions || []).map((s) => [domainKey(s.domain), s]));
    const others = new Map((output.others || []).map((o) => [domainKey(o.domain), o]));
    for (const d of chunk) {
      const k = domainKey(d), s = subs.get(k), o = others.get(k);   // a domain in both lists counts as a subscription
      const r = s ? subRow(d, s) : o ? otherRow(d, OTHER_KINDS.includes(o.kind) ? o.kind : 'unknown', 0.8, '') : otherRow(d, 'unknown', 0.1, 'not returned by model');
      discoverCache.set(d, r); out.push(r);
    }
  }
  return { services: [...out, ...held], usage };
}
