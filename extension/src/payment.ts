import { apiPost } from './api';
import { sleep } from './tabs';
import type { CheckoutResult, Settlement } from './types';

export async function startCheckout(estimatedSavingsUsd: number): Promise<{ sessionId: string; url: string; estimatedFeeUsd: number }> {
  return apiPost<{ sessionId: string; url: string; estimatedFeeUsd: number }>('/api/checkout', { estimatedSavingsUsd });
}

/**
 * Poll until the customer finishes the Stripe page (the card is saved; nothing is charged).
 * The interval backs off from 2s to a 10s ceiling, so a panel left open on this screen makes about
 * 120 calls over the whole 20-minute window instead of 400, and then stops for good.
 */
export async function waitForCheckout(sessionId: string, onTick: (msg: string) => void, timeoutMs = 20 * 60 * 1000): Promise<CheckoutResult> {
  const start = Date.now();
  let delay = 2000;
  while (Date.now() - start < timeoutMs) {
    await sleep(delay);
    delay = Math.min(10000, Math.round(delay * 1.5));
    const s = await apiPost<any>('/api/checkout-status', { sessionId }).catch(() => null);
    if (s && s.complete) return { setupIntentId: s.setupIntentId, customerId: s.customerId ?? null, paymentMethodId: s.paymentMethodId ?? null, email: s.email ?? null };
    if (s && s.status === 'expired') throw new Error("The checkout page expired — nothing was charged. Start again when you're ready.");
    onTick(`Waiting for you to finish on the Stripe page… (${Math.round((Date.now() - start) / 1000)}s)`);
  }
  throw new Error("Checkout timed out after 20 minutes — nothing was charged. Start again when you're ready.");
}

export async function settle(pay: CheckoutResult, verifiedSavingsUsd: number, estimatedSavingsUsd: number): Promise<Settlement> {
  return apiPost<Settlement>('/api/settle', { setupIntentId: pay.setupIntentId, customerId: pay.customerId, email: pay.email, verifiedSavingsUsd, estimatedSavingsUsd });
}
