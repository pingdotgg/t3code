export const PRODUCT_DOMAIN_PATHS = {
  dev: "/",
  marketing: "/marketing",
} as const;

export const PRODUCT_DOMAIN_ROUTE_IDS = {
  marketing: "/marketing",
} as const;

export type ProductDomain = keyof typeof PRODUCT_DOMAIN_PATHS;
export type ProductDomainPath = (typeof PRODUCT_DOMAIN_PATHS)[ProductDomain];
export type MarketingRoutePath = `/marketing${"" | `/${string}`}`;

/** Unknown and absent values deliberately preserve native T3 Dev. */
export function resolveProductDomain(value: unknown): ProductDomain {
  return value === "marketing" ? "marketing" : "dev";
}

/** Marketing is active only when the router actually matched its reserved parent route. */
export function resolveProductDomainFromRouteIds(routeIds: ReadonlyArray<string>): ProductDomain {
  return routeIds.includes(PRODUCT_DOMAIN_ROUTE_IDS.marketing) ? "marketing" : "dev";
}

export function productDomainPath(productDomain: ProductDomain): ProductDomainPath {
  return PRODUCT_DOMAIN_PATHS[productDomain];
}

/** Accept only a local, canonical Marketing pathname for a post-pair return. */
export function resolveMarketingReturnPath(value: unknown): MarketingRoutePath | undefined {
  if (typeof value !== "string" || value.length > 2_048) {
    return undefined;
  }
  if (value === PRODUCT_DOMAIN_PATHS.marketing || value === `${PRODUCT_DOMAIN_PATHS.marketing}/`) {
    return PRODUCT_DOMAIN_PATHS.marketing;
  }
  if (!value.startsWith(`${PRODUCT_DOMAIN_PATHS.marketing}/`)) {
    return undefined;
  }
  if (!/^\/marketing(?:\/[A-Za-z0-9._~-]+)+$/u.test(value)) {
    return undefined;
  }

  const segments = value.slice(`${PRODUCT_DOMAIN_PATHS.marketing}/`.length).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return value as MarketingRoutePath;
}

export interface PairRouteSearch {
  readonly marketingReturnTo?: MarketingRoutePath;
}

export function parsePairRouteSearch(search: Record<string, unknown>): PairRouteSearch {
  const marketingReturnTo = resolveMarketingReturnPath(search.marketingReturnTo);
  return marketingReturnTo === undefined ? {} : { marketingReturnTo };
}
