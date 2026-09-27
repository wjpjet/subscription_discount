const store = {};
export const browser = {
  storage: { local: { async get(k) { return typeof k === 'string' ? { [k]: store[k] } : { ...store }; }, async set(o) { Object.assign(store, o); }, async remove(ks) { for (const k of [].concat(ks)) delete store[k]; } } },
  cookies: { async getAll() { return globalThis.__cookies || []; } },
};
