// Sites Walkaway must never touch: banks, credit unions, card issuers, brokerages, crypto exchanges,
// payment apps, lenders, credit bureaus, insurers, health portals, payroll, tax and government.
//
// None of these has a subscription to "save", and on them the buttons that matter ("Cancel payment",
// "Stop autopay", "Close card") are exactly what an agent must never press. So they are excluded by
// deterministic rules, not by the model's judgement: their names are withheld before discovery (never
// sent anywhere), their pages are never classified, and a walk that reaches one stops.
//
// Over-matching is cheap (a subscription site wrongly listed here is merely skipped). Under-matching is
// what the page check (financialPageReason) and the model's own verdict are there to catch.
import { etld1 } from './domains.js';

const DOMAINS = new Set([
  // banks and credit unions
  'chase.com', 'jpmorgan.com', 'jpmorganchase.com', 'bankofamerica.com', 'bofa.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'usbank.com',
  'pnc.com', 'truist.com', 'tdbank.com', 'td.com', 'capitalone.com', 'ally.com', 'citizensbank.com', 'fifththird.com', '53.com', 'keybank.com',
  'regions.com', 'huntington.com', 'mtb.com', 'santanderbank.com', 'bmo.com', 'bmoharris.com', 'hsbc.com', 'barclays.com', 'barclaycardus.com',
  'goldmansachs.com', 'marcus.com', 'navyfederal.org', 'penfed.org', 'usaa.com', 'becu.org', 'schoolsfirstfcu.org', 'alliantcreditunion.org',
  'firstrepublic.com', 'svb.com', 'discover.com', 'americanexpress.com', 'amex.com', 'synchrony.com', 'mysynchrony.com', 'syf.com',
  'sofi.com', 'chime.com', 'varomoney.com', 'current.com', 'axosbank.com', 'discoverbank.com', 'capitalone360.com', 'rbcroyalbank.com',
  'scotiabank.com', 'cibc.com', 'lloydsbank.com', 'natwest.com', 'monzo.com', 'starlingbank.com',
  // brokerages, investing, retirement
  'fidelity.com', 'vanguard.com', 'schwab.com', 'etrade.com', 'morganstanley.com', 'merrilledge.com', 'ml.com', 'robinhood.com', 'webull.com',
  'interactivebrokers.com', 'betterment.com', 'wealthfront.com', 'acorns.com', 'stash.com', 'public.com', 'm1finance.com', 'm1.com',
  'tiaa.org', 'principal.com', 'empower.com', 'empower-retirement.com', 'troweprice.com', 'edwardjones.com', 'ameriprise.com',
  // crypto
  'coinbase.com', 'kraken.com', 'binance.com', 'binance.us', 'gemini.com', 'crypto.com', 'blockchain.com', 'bitstamp.net', 'kucoin.com',
  // payments, transfers, buy-now-pay-later
  'paypal.com', 'venmo.com', 'cash.app', 'squareup.com', 'zellepay.com', 'wise.com', 'revolut.com', 'remitly.com', 'westernunion.com',
  'moneygram.com', 'xoom.com', 'affirm.com', 'klarna.com', 'afterpay.com', 'sezzle.com', 'zip.co',
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
  // payroll, HR, tax
  'adp.com', 'workday.com', 'myworkday.com', 'gusto.com', 'paychex.com', 'paycom.com', 'rippling.com', 'trinet.com', 'justworks.com',
  'hrblock.com', 'taxact.com', 'freetaxusa.com', 'taxslayer.com',
  // identity
  'id.me', 'login.gov',
]);

/** Government, military, banks' own TLD, education, insurance TLD; and country forms like gov.uk. */
const TLD_RE = /(^|\.)(gov|mil|bank|insurance|edu)$|(^|\.)(gov|mil|edu|ac|police|nhs)\.[a-z]{2}$/i;
/** Words in a site's own name that almost always mean a financial institution. */
const NAME_RE = /(bank|banking|creditunion|fcu|federalcu|brokerage|securities|mortgage|lending)/i;

/** Why this domain or host is off limits, or null when it's fine to scan. */
export function sensitiveReason(hostOrDomain) {
  const host = String(hostOrDomain || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host) return null;
  const d = etld1(host);
  if (DOMAINS.has(d) || DOMAINS.has(host)) return 'financial, government, health or payroll site (built-in list)';
  if (TLD_RE.test(host) || TLD_RE.test(d)) return 'government, military, bank or education domain';
  const name = d.split('.')[0] || '';
  if (NAME_RE.test(name)) return 'looks like a financial institution (name)';
  return null;
}
export const isSensitive = (hostOrDomain) => sensitiveReason(hostOrDomain) != null;

/** The model's own category words that mean the same thing, as a second net over its verdicts. */
export const SENSITIVE_CATEGORY_RE = /\b(bank|banking|credit union|credit card|financ|brokerage|invest|crypto|payment|lend|loan|mortgage|insur|health|medical|government|tax|payroll)/i;

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
