export interface SnapshotElement { id: number; tag: string; text: string; label?: string; role?: string; href?: string; type?: string; name?: string; placeholder?: string; value?: string; checked?: boolean; options?: string[]; disabled?: boolean; offscreen?: boolean }
export interface PagePrice { amount: number; unit: string; context: string }
export interface PageSnapshot { url: string; title: string; headings: string[]; text: string; textLength: number; hasPassword: boolean; prices: PagePrice[]; elements: SnapshotElement[]; scrollY: number; scrollHeight: number; viewportHeight: number }
export function snapshotPage(opts?: { maxElements?: number; textChars?: number }): PageSnapshot;
export function readElement(id: number): { text: string; type: string; name: string; tag: string; disabled: boolean } | null;
export function performAction(action: { type: string; id?: number | null; text?: string | null; value?: string | null; direction?: string | null }): { ok: boolean; note: string };
