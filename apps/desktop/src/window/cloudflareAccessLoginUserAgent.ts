const KEPT_PRODUCTS = new Set(["Mozilla", "AppleWebKit", "Chrome", "Safari"]);

/**
 * Identity providers such as Google refuse sign-in from user agents that name an embedding app,
 * so drop every product token except the ones a plain Chrome sends.
 */
export const embeddedSignInUserAgent = (userAgent: string): string =>
  userAgent
    .replace(/(^|\s)([A-Za-z][\w.-]*)\/\S+/g, (token, _space: string, product: string) =>
      KEPT_PRODUCTS.has(product) ? token : "",
    )
    .trim();
