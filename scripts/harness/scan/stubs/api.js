export async function apiAvailable() { return !!globalThis.__api; }
export async function apiPost(path, body) { return globalThis.__api(path, body); }
