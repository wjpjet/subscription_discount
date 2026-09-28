// The safety lock is hunt.ts's business; the scan only clears stale locks when the panel opens.
export async function unlockAllExcept(keep) { (globalThis.__unlockCalls ||= []).push([...keep]); return 0; }
export async function lockTab() { return true; }
export async function unlockTab() {}
export const isLocked = () => false;
