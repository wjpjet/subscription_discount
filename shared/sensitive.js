// Sites Walkaway must never touch: banks, credit unions, card issuers, brokerages, crypto exchanges,
// payment apps, lenders, credit bureaus, insurers, health portals, telehealth, pharmacies, therapy, reproductive
// health and genetic testing, payroll and HR, tax, government, and the identity and fraud-check vendors that only
// show up after money or ID checks.
//
// None of these has a subscription to "save", and on them the buttons that matter ("Cancel payment",
// "Stop autopay", "Close card") are exactly what an agent must never press. So they are excluded by
// deterministic rules, not by the model's judgement: a matching cookie domain is withheld before discovery
// (the extension never sends the name; the backend refuses it again if a client does), a probe checks the
// account URL's host before opening it and never classifies a page that lands on one, and a walk stops there. The rules only know what is written here: a site
// they miss can still reach the model by name, which is why the page check (financialPageReason) and the
// model's own verdict back them up. The first live run sent seven such names (HSA, patient portal, equity
// plan, a "banco") because the lists were exact-match only.
//
// Over-matching costs a real subscription that is then silently skipped (and blockReason can't be
// overridden), so generic words stay out: 'discover' would take Discovery+, 'health' Men's Health.
import { etld1 } from './domains.js';

const DOMAINS = new Set([
  // banks and credit unions
  'chase.com', 'jpmorgan.com', 'jpmorganchase.com', 'bankofamerica.com', 'bofa.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'usbank.com',
  'pnc.com', 'truist.com', 'tdbank.com', 'td.com', 'capitalone.com', 'ally.com', 'citizensbank.com', 'fifththird.com', '53.com', 'keybank.com',
  'regions.com', 'huntington.com', 'mtb.com', 'santanderbank.com', 'bmo.com', 'bmoharris.com', 'hsbc.com', 'barclays.com', 'barclaycardus.com',
  'goldmansachs.com', 'marcus.com', 'navyfederal.org', 'penfed.org', 'usaa.com', 'becu.org', 'schoolsfirstfcu.org', 'alliantcreditunion.org',
  'firstrepublic.com', 'svb.com', 'discover.com', 'americanexpress.com', 'amex.com', 'synchrony.com', 'mysynchrony.com', 'syf.com',
  'sofi.com', 'chime.com', 'varomoney.com', 'current.com', 'axosbank.com', 'discoverbank.com', 'capitalone360.com', 'rbcroyalbank.com',
  'scotiabank.com', 'cibc.com', 'lloydsbank.com', 'natwest.com', 'monzo.com', 'starlingbank.com', 'bancoplata.mx', 'plaid.com',
  // brokerages, investing, retirement
  'fidelity.com', 'vanguard.com', 'schwab.com', 'etrade.com', 'morganstanley.com', 'merrilledge.com', 'ml.com', 'robinhood.com', 'webull.com',
  'interactivebrokers.com', 'betterment.com', 'wealthfront.com', 'acorns.com', 'stash.com', 'public.com', 'm1finance.com', 'm1.com',
  'tiaa.org', 'principal.com', 'empower.com', 'empower-retirement.com', 'troweprice.com', 'edwardjones.com', 'ameriprise.com',
  // employee equity and stock plans
  'morganstanleyclientserv.com', 'stockplanconnect.com', 'solium.com', 'shareworks.com', 'carta.com', 'computershare.com', 'netbenefits.com',
  // crypto
  'coinbase.com', 'kraken.com', 'binance.com', 'binance.us', 'gemini.com', 'crypto.com', 'blockchain.com', 'bitstamp.net', 'kucoin.com',
  // payments, transfers, buy-now-pay-later
  'paypal.com', 'venmo.com', 'cash.app', 'squareup.com', 'zellepay.com', 'wise.com', 'revolut.com', 'remitly.com', 'westernunion.com',
  'moneygram.com', 'xoom.com', 'affirm.com', 'klarna.com', 'afterpay.com', 'sezzle.com', 'zip.co',
  // card networks and bank wallets
  'visa.com', 'mastercard.com', 'paze.com',
  // lenders, mortgages, student loans
  'rocketmortgage.com', 'quickenloans.com', 'mrcooper.com', 'salliemae.com', 'navient.com', 'nelnet.com', 'mohela.com', 'aidvantage.com',
  'lendingclub.com', 'prosper.com', 'upstart.com', 'onemainfinancial.com',
  // credit bureaus and credit monitoring
  'experian.com', 'equifax.com', 'transunion.com', 'creditkarma.com', 'annualcreditreport.com', 'myfico.com',
  // insurance
  'geico.com', 'progressive.com', 'statefarm.com', 'allstate.com', 'libertymutual.com', 'nationwide.com', 'farmers.com', 'travelers.com',
  'lemonade.com', 'root.com', 'metlife.com', 'prudential.com', 'newyorklife.com', 'northwesternmutual.com', 'aflac.com',
  // health and health insurance
  'anthem.com', 'uhc.com', 'unitedhealthcare.com', 'myuhc.com', 'aetna.com', 'cigna.com', 'humana.com', 'kaiserpermanente.org', 'kp.org',
  'bcbs.com', 'bluecrossca.com', 'bluecrossma.com', 'mychart.com', 'mychart.org', 'healthcare.gov', 'cvs.com', 'walgreens.com', 'zocdoc.com',
  'healthequity.com', 'hsabank.com', 'wageworks.com', 'optum.com', 'optumbank.com', 'athenahealth.com', 'followmyhealth.com', 'labcorp.com', 'questdiagnostics.com',
  // telehealth and online prescribers: monthly plans, but the account page lists treatments and medication.
  // No NAME_RE stem reaches these names, so without the list they went to discovery by name.
  'teladoc.com', 'teladochealth.com', 'amwell.com', 'mdlive.com', 'doctorondemand.com', 'plushcare.com', 'sesamecare.com', 'khealth.com', 'lemonaidhealth.com',
  'onemedical.com', 'carbonhealth.com', 'hims.com', 'forhims.com', 'hers.com', 'forhers.com', 'ro.co', 'getroman.com', 'keeps.com', 'thirtymadison.com',
  'henrymeds.com', 'joinfound.com', 'joincalibrate.com',
  // DTC and mail-order pharmacies, drug-price cards
  'goodrx.com', 'capsule.com', 'alto.com', 'costplusdrugs.com', 'blinkhealth.com', 'honeybeehealth.com', 'pillpack.com', 'optumrx.com', 'express-scripts.com',
  'caremark.com', 'riteaid.com',
  // mental health care (therapy and psychiatry; meditation apps like Calm and Headspace are ordinary subscriptions)
  'betterhelp.com', 'talkspace.com', 'cerebral.com', 'brightside.com', 'lyrahealth.com', 'springhealth.com', 'regain.us', 'talkiatry.com', 'headway.co',
  'helloalma.com', 'rula.com', 'donefirst.com',
  // reproductive and sexual health, fertility
  'plannedparenthood.org', 'nurx.com', 'thepillclub.com', 'pandiahealth.com', 'hellowisp.com', 'simplehealth.com', 'kindbody.com', 'progyny.com', 'modernfertility.com',
  // genetic testing and at-home labs (genealogy subscriptions like Ancestry stay scannable)
  '23andme.com', 'nebula.org', 'invitae.com', 'color.com', 'everlywell.com', 'letsgetchecked.com',
  // payroll, HR, tax
  'adp.com', 'workday.com', 'myworkday.com', 'gusto.com', 'paychex.com', 'paycom.com', 'rippling.com', 'trinet.com', 'justworks.com',
  'successfactors.com', 'ultipro.com', 'ukg.com', 'bamboohr.com', 'paylocity.com', 'paycor.com', 'dayforcehcm.com', 'myworkdayjobs.com', 'greenhouse.io', 'lever.co',
  'hrblock.com', 'taxact.com', 'freetaxusa.com', 'taxslayer.com',
  // identity verification and fraud checks: never a subscription, only a sign that money or ID changed hands
  'id.me', 'login.gov', 'socure.io', 'online-metrix.net', 'threatmetrix.com', 'cardinaltrusted.com', 'cardinalcommerce.com', 'riskid.security',
  'signifyd.com', 'nsureapi.com', 'transmitsecurity.io', 'kaptcha.com', 'iovation.com', 'forter.com', 'riskified.com', 'withpersona.com',
  'onfido.com', 'jumio.com', 'veriff.com',
  // single hosts on otherwise ordinary sites (exact host match)
  'wallet.google.com', 'pharmacy.amazon.com',
]);
// Distinctive brand stems matched against the start of the registrable name, so a sister site the list
// doesn't name is caught too (morganstanleyclientserv.com, wellsfargoadvisors.com). Hand-picked: never a
// generic word ('discover' → discoveryplus.com, 'farmers' → thefarmersdog.com, 'empower', 'principal',
// 'progressive', 'public', 'current', 'root').
const BRAND_PREFIXES = ['morganstanley', 'wellsfargo', 'bankofamerica', 'jpmorgan', 'americanexpress', 'goldmansachs', 'fidelity', 'schwab', 'charlesschwab',
  'vanguard', 'etrade', 'merrilledge', 'merrilllynch', 'troweprice', 'edwardjones', 'ameriprise', 'northwesternmutual', 'capitalone', 'citibank',
  'unitedhealth', 'kaiserpermanente', 'healthequity', 'bluecross', 'blueshield'];

/** Government, military, banks' own TLD, education, insurance TLD; and country forms like gov.uk, gob.mx, gc.ca. */
const TLD_RE = /(^|\.)(gov|mil|bank|insurance|edu)$|(^|\.)(gov|gob|gouv|mil|edu|ac|police|nhs)\.[a-z]{2}$|(^|\.)(gc\.ca|nic\.in|go\.jp|go\.kr|go\.id|go\.th)$/i;
/** Words in a site's own name that almost always mean a financial institution or a care provider. Narrow health
 *  stems only: bare 'health', 'medical' or 'pharma' would drop fitness apps and magazines (menshealth.com). */
const NAME_RE = /(bank|banking|banco|banque|bancorp|sparkasse|raiffeisen|creditunion|fcu|federalcu|brokerage|securities|mortgage|lending|patient|clinic|hospital(?!ity)|pharmacy|healthsystem)/i;

/** Why this domain or host is off limits, or null when it's fine to scan. */
export function sensitiveReason(hostOrDomain) {
  const host = String(hostOrDomain || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host) return null;
  const d = etld1(host);
  if (DOMAINS.has(d) || DOMAINS.has(host)) return 'financial, government, health or payroll site (built-in list)';
  if (TLD_RE.test(host) || TLD_RE.test(d)) return 'government, military, bank or education domain';
  const name = d.split('.')[0] || '';
  if (BRAND_PREFIXES.some((p) => name.startsWith(p))) return 'financial or health brand (built-in list)';
  if (NAME_RE.test(name)) return 'looks like a financial institution or care provider (name)';
  return null;
}
export const isSensitive = (hostOrDomain) => sensitiveReason(hostOrDomain) != null;

/** The model's own category words that mean the same thing, as a second net over its verdicts. */
// Institutions, not topics: "Banking" or "Health insurance" are dropped, but "Financial news" (Seeking Alpha),
// "Fitness/Health" (Oura), "Personal finance app" (Monarch) or "Investing research" are real subscriptions.
// The first live run dropped Oura and Seeking Alpha with the older, topic-level rule.
// Care delivered online counts (telehealth, online therapy, prescriptions), but never bare "mental health": the model
// files Calm and Headspace there, and meditation apps are ordinary subscriptions. Prescription eyewear and lenses too.
export const SENSITIVE_CATEGORY_RE = /\b(bank(ing)?\b|credit union|credit card|card issuer|brokerage|crypto(currency)? exchange|payment (app|processor|service|platform)|money transfer|lend(er|ing)\b|loan servic|student loans?\b|mortgage|insur(ance|er)\b|hospital|patient portal|pharmacy|health ?care provider|medical (provider|group|records)|tele(health|medicine|therapy)|online therapy|prescription(?! (eye|glasses|sunglasses|lens|contact))|government|tax (filing|preparation|prep|service)|payroll)/i;

// Page-level phrases. Two distinct phrases are required, because a streaming or phone billing page can
// say "current balance" or "statement" once, but will not also say "routing number" or "credit limit".
const PAGE_PHRASES = [
  /routing number/i, /available balance/i, /current balance/i, /account balance/i, /ledger balance/i,
  /wire transfer/i, /transfer money/i, /transfer funds/i, /send money/i, /\bzelle\b/i, /external accounts?/i,
  /direct deposit/i, /mobile deposit/i, /deposit a check/i, /checking account/i, /savings account/i, /money market/i,
  /statement balance/i, /minimum payment/i, /credit limit/i, /available credit/i, /cash advance/i,
  /buying power/i, /\bholdings\b/i, /\bpositions\b/i, /portfolio value/i, /brokerage account/i, /\b401\(?k\)?/i, /\broth ira\b|\btraditional ira\b/i,
  /loan balance/i, /payoff amount/i, /principal balance/i, /\bescrow\b/i, /amortization/i,
  /policy number/i, /\bdeductible\b/i, /claims? status/i, /file a claim/i, /premium due/i,
  /explanation of benefits/i, /\bcopay\b/i, /prior authori[sz]ation/i,
  /social security/i, /tax return/i, /\bw-2\b/i, /\b1099\b/i, /adjusted gross income/i,
];
/** Why a page's text reads like banking, credit, investing, insurance, health or government, or null. */
export function financialPageReason(text) {
  const t = String(text || '');
  const hits = PAGE_PHRASES.map((re) => (t.match(re) || [])[0]).filter(Boolean);
  return hits.length >= 2 ? `page reads like a financial or sensitive account ("${hits.slice(0, 4).join('", "')}")` : null;
}
