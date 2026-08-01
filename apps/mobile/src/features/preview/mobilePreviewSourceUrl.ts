/**
 * A Connect gateway intentionally renders at the environment origin. Preserve
 * the preview's original origin in model context while following in-page path,
 * query, and hash navigation from the isolated WebView.
 */
export function mobilePreviewAnnotationUrl(input: {
  readonly documentUrl: string;
  readonly gatewayUrl?: string;
  readonly sourceUrl: string;
  readonly isolatedGateway: boolean;
}): string {
  if (!input.isolatedGateway) return input.documentUrl;
  try {
    const documentUrl = new URL(input.documentUrl);
    const gatewayUrl = new URL(input.gatewayUrl ?? "");
    const sourceUrl = new URL(input.sourceUrl);
    if (documentUrl.origin !== gatewayUrl.origin) return documentUrl.toString();
    if (documentUrl.pathname === gatewayUrl.pathname && documentUrl.search === gatewayUrl.search) {
      return sourceUrl.toString();
    }
    sourceUrl.pathname = documentUrl.pathname;
    sourceUrl.search = documentUrl.search;
    sourceUrl.hash = documentUrl.hash;
    return sourceUrl.toString();
  } catch {
    return input.sourceUrl;
  }
}
