/** A resolved CLIProxyAPI endpoint for one provider instance. Secrets are already filled in. */
export interface ProviderProxyRoute {
  /** Origin plus any base path, without a trailing slash or `/v1`. */
  readonly url: string;
  readonly apiKey: string;
}

/** Accepts the forms users paste: with or without a trailing slash or `/v1`. */
export const normalizeProviderProxyUrl = (url: string): string =>
  url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

// Harnesses refuse to send requests without a credential; a proxy with no API keys ignores it.
const KEYLESS_PROXY_TOKEN = "t3-proxy";

/** The credential to send: the proxy's key, or a placeholder for a keyless proxy. */
export const providerProxyToken = (route: ProviderProxyRoute): string =>
  route.apiKey === "" ? KEYLESS_PROXY_TOKEN : route.apiKey;

/** The OpenAI- and Anthropic-compatible API root. */
export const providerProxyApiUrl = (route: ProviderProxyRoute): string => `${route.url}/v1`;

export const PROXY_AUTH_METADATA = { type: "proxy", label: "Via proxy" } as const;

// The harness never sees which pooled account served a request, so it cannot report limits.
export const PROXY_LIMITS_MESSAGE =
  "This instance uses the proxy's accounts. Add the proxy's management key to see them under Limits.";
