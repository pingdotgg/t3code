import { APP_SCHEME, isAppLinkProtocol } from "./appScheme.ts";

export const CLOUDFLARE_ACCESS_LOGIN_PATH = "/api/auth/cloudflare-access";

/** Where the server sends an app's sign-in; the credential rides only in the fragment. */
export const CLOUDFLARE_ACCESS_APP_CALLBACK_URL = `${APP_SCHEME}://cloudflare-access`;

/**
 * The https origin an app signs in to for a typed address, or null when it has none.
 */
export const cloudflareAccessLoginOrigin = (host: string): string | null => {
  const trimmed = host.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    // A public name is needed: no localhost and no IP literals, which never sit behind Access.
    const named = url.hostname.includes(".") && !/^[\d.]+$|^\[/.test(url.hostname);
    return url.protocol === "https:" && named ? url.origin : null;
  } catch {
    return null;
  }
};

export const cloudflareAccessAppLoginUrl = (origin: string): string =>
  `${origin}${CLOUDFLARE_ACCESS_LOGIN_PATH}?client=app`;

/**
 * The pairing credential in a sign-in callback, or null for any other URL. Any app scheme reads as
 * one, as for pairing links: mobile bundles do not know the scheme their native build registers.
 */
export const readCloudflareAccessAppCallback = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isAppLinkProtocol(url.protocol) || url.host !== "cloudflare-access") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return new URLSearchParams(url.hash.slice(1)).get("token")?.trim() || null;
};
