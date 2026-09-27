export interface CatalogEntry { id: string; name: string; domains: string[]; accountUrl: string; altUrls?: string[] }
export const CATALOG: CatalogEntry[];
/** Matched by registrable domain; accepts a domain, host or URL. */
export function catalogFor(domainOrHost: string | null | undefined): CatalogEntry | null;
export function canonicalKey(domainOrHost: string | null | undefined): string | null;
