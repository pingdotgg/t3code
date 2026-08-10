export const PRODUCT_DOMAIN_PATHS = {
  dev: "/",
  marketing: "/marketing",
} as const;

export type ProductDomain = keyof typeof PRODUCT_DOMAIN_PATHS;
export type ProductDomainPath = (typeof PRODUCT_DOMAIN_PATHS)[ProductDomain];

/** Unknown and absent values deliberately preserve native T3 Dev. */
export function resolveProductDomain(value: unknown): ProductDomain {
  return value === "marketing" ? "marketing" : "dev";
}

/**
 * The URL is the complete client-side domain state. Marketing has one explicit
 * namespace; every other pathname remains native Dev.
 */
export function resolveProductDomainFromPathname(pathname: string): ProductDomain {
  return pathname === PRODUCT_DOMAIN_PATHS.marketing ||
    pathname.startsWith(`${PRODUCT_DOMAIN_PATHS.marketing}/`)
    ? "marketing"
    : "dev";
}

export function productDomainPath(productDomain: ProductDomain): ProductDomainPath {
  return PRODUCT_DOMAIN_PATHS[productDomain];
}
