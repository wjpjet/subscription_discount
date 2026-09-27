// The real mockClassify, then an optional per-test overlay that plays the real model's quirks (an /error URL is
// not_found; accountType missed; billed via the App Store), re-checked by the real guardPageClass.
import * as real from '../../../../shared/brain-mock.js';
export * from '../../../../shared/brain-mock.js';
export function mockClassify(snap, domain) {
  const c = real.mockClassify(snap, domain);
  const o = globalThis.__overlay && globalThis.__overlay(snap, { ...c });
  return o ? real.guardPageClass(o, snap, domain) : c;
}
