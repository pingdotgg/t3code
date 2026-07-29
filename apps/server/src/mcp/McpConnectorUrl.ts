/**
 * Connector URL format for remote MCP clients.
 *
 * ChatGPT's Developer Mode connector UI collects a Server URL and an auth
 * mode, but it has no field for a custom header — so the `Authorization:
 * Bearer …` scheme the local MCP transport uses is unreachable there. The only
 * way to authenticate a chatgpt.com connector is to carry the credential in
 * the URL itself and register the connector as "No authentication".
 *
 * That is a real tradeoff, not a shortcut: a URL-borne token is visible to
 * anything that logs URLs. It is accepted here under three conditions, all
 * enforced elsewhere in this module's callers:
 *
 *   - the token is per-thread, expiring, and revocable (`McpSessionRegistry`),
 *   - it grants only the read-only `workspace` capability, never `agents`,
 *   - SergeCode's own log lines run the URL through `redactConnectorToken`
 *     first.
 *
 * The last point covers this server's logging, not the world's. Effect's
 * built-in HTTP request logger (enabled by `logWebSocketEvents`) and any
 * intermediary — tunnel, proxy, browser history — still sees the raw query
 * string. That is inherent to URL-borne credentials and is why the token is
 * short-lived and read-only rather than merely secret.
 *
 * @module mcp/McpConnectorUrl
 */

/**
 * Query parameter carrying the credential. Short because the whole URL is
 * pasted by hand into a settings field.
 */
export const MCP_TOKEN_QUERY_PARAM = "k";

const REDACTED = "REDACTED";

/**
 * Builds the URL a user pastes into ChatGPT's connector settings.
 *
 * `publicBaseUrl` is the externally reachable origin for this server — a
 * tunnel hostname, since OpenAI's backend, not the browser, dials the
 * endpoint. Returns `undefined` when no usable base URL is configured, so
 * callers surface "not exposed yet" rather than advertising a loopback
 * address that will never resolve for the caller.
 */
export const buildConnectorUrl = (input: {
  readonly publicBaseUrl: string;
  readonly token: string;
}): string | undefined => {
  const trimmed = input.publicBaseUrl.trim();
  if (trimmed.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  // Accept a base origin ("https://host"), the mount point ("…/mcp"), or a
  // previously-issued connector URL, and always land on exactly one "/mcp".
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = basePath.endsWith("/mcp") ? basePath : `${basePath}/mcp`;
  url.search = "";
  url.hash = "";
  url.searchParams.set(MCP_TOKEN_QUERY_PARAM, input.token);
  return url.toString();
};

/**
 * Replaces the credential in a URL or request line so it can be logged.
 *
 * Operates on the raw string rather than parsing, because the value reaching
 * a log sink is often a path-and-query fragment that `new URL` cannot parse on
 * its own, and a redactor that silently no-ops on unparseable input is worse
 * than none.
 */
export const redactConnectorToken = (value: string): string =>
  value.replace(new RegExp(`([?&]${MCP_TOKEN_QUERY_PARAM}=)[^&\\s]+`, "g"), `$1${REDACTED}`);
