/**
 * Cloud port-preview URL builder for the Aether provider driver.
 *
 * Mirrors the Aether platform contract (`@aether/domain-types`
 * `buildWorkspacePreviewUrl`, which this fork cannot import): the preview
 * token rides the SUBDOMAIN — `{port}-{workspaceId prefix}-{token}` — so the
 * URL opens in any browser with no cookies or app session; the preview
 * gateway routes on the subdomain token.
 *
 * @module provider/Layers/aether/portPreview
 */

/** The gateway contract: a 32-char lowercase-alnum preview token. */
const PREVIEW_TOKEN_PATTERN = /^[a-z0-9]{32}$/;

/**
 * Derive the preview domain from the instance API base URL by swapping a
 * leading `api.` host label for `preview.` (`api.runaether.dev` →
 * `preview.runaether.dev`). A host without an `api.` prefix is returned
 * unchanged (best-effort for staging / self-hosted); an unparseable URL falls
 * back to the production preview domain.
 */
export function deriveAetherPreviewDomain(apiBaseUrl: string): string {
  try {
    const host = new URL(apiBaseUrl).host;
    return host.startsWith("api.") ? `preview.${host.slice("api.".length)}` : host;
  } catch {
    return "preview.runaether.dev";
  }
}

/**
 * Build a workspace port-preview URL, or `undefined` when the preview token is
 * malformed or absent. Port previews are best-effort — the caller skips
 * surfacing the port rather than failing a turn.
 */
export function buildAetherPreviewUrl(input: {
  readonly apiBaseUrl: string;
  readonly workspaceId: string;
  readonly port: number;
  readonly previewToken: string;
}): string | undefined {
  if (!PREVIEW_TOKEN_PATTERN.test(input.previewToken)) {
    return undefined;
  }
  const domain = deriveAetherPreviewDomain(input.apiBaseUrl);
  const subdomain = `${input.port}-${input.workspaceId.slice(0, 8)}-${input.previewToken}`;
  const protocol = domain.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${subdomain}.${domain}`;
}
