import { apiPost } from './api';
import { sleep } from './tabs';
import type { CheckoutResult, Settlement } from './types';

export async function startCheckout(estimatedSavingsUsd: number): Promise<{ sessionId: string; url: string }> {
  return apiPost<{ sessionId: string; url: string }>('/api/checkout', { estimatedSavingsUsd });
}
/** Poll until the customer completes Stripe Checkout (the $1 hold is authorized). */
export async function waitForCheckout(sessionId: string, onTick: (msg: string) => void, timeoutMs = 10 * 60 * 1000): Promise<CheckoutResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    const s = await apiPost<any>('/api/checkout-status', { sessionId }).catch(() => null);
    if (s && s.complete) return { paymentIntentId: s.paymentIntentId, customerId: s.customerId, email: s.email };
    if (s && s.status === 'expired') throw new Error('Checkout expired — nothing was charged.');
    onTick(`Waiting for you to finish checkout… (${Math.round((Date.now() - start) / 1000)}s)`);
  }
  throw new Error('Checkout timed out — nothing was charged.');
}
export async function settle(paymentIntentId: string, customerId: string, verifiedSavingsUsd: number): Promise<Settlement> {
  return apiPost<Settlement>('/api/settle', { paymentIntentId, customerId, verifiedSavingsUsd });
}
