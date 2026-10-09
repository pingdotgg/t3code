/** Accept an origin only, so proxying cannot discard an upstream base path. */
export function parseOrigin(value: string, allowLocal = false): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== value.trim() ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Expected an HTTPS origin without credentials, path, query, or fragment.");
  }
  return url;
}
