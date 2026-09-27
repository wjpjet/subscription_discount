import { redactForLog } from '../../../../shared/scrub.js';
export { redactForLog };
export function trace(kind, data = {}) { (globalThis.__events ||= []).push({ kind, ...data }); }
export function snapSummary(s) { return { url: s && s.url }; }
export function maskForLog(e) { return e ? '***' : null; }
