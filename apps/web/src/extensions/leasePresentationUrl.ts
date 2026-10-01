import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { RESOURCES_LEASE } from "@t3tools/extension-sdk/catalogue";
import type { Json } from "@t3tools/extension-sdk/contracts";

/**
 * The server mints `t3.resources/lease` presentation URLs server-relative
 * (`/api/assets/<token>/…`) because it cannot know how each client reaches it.
 * A pack loads that URL from its own document, which is the environment only
 * for a same-origin web client: desktop's `t3code://app` renderer, app.t3.codes
 * and every remote environment would resolve it against the wrong origin. The
 * host knows the environment's HTTP base, so it resolves the URL here, the
 * same way native previews do.
 *
 * `browser-surface` URLs are claim credentials the pack hands back to the
 * server (browser frames, `releasePresentation`), never loaded, so they stay
 * in the minted form the server parses.
 */
export function resolveLeasePresentationUrl(
  request: { readonly id: string; readonly method: string },
  result: Json,
  httpBaseUrl: string,
): Json {
  if (request.id !== RESOURCES_LEASE || request.method !== "createPresentationUrl") return result;
  if (typeof result !== "object" || result === null || !("url" in result)) return result;
  if (typeof result.url !== "string" || result.kind === "browser-surface") return result;
  const url = resolveAssetUrl(httpBaseUrl, result.url);
  return url === null ? result : { ...result, url };
}
