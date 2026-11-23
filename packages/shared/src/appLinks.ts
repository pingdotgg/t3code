/** Schemes the browser engine loads itself; every other scheme names an app the OS opens. */
const BROWSER_PROTOCOLS = [
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "http:",
  "https:",
  "javascript:",
  "view-source:",
];

const browserProtocols: ReadonlySet<string> = new Set(BROWSER_PROTOCOLS);

/** The normalized URL when it is an app link, such as `obsidian:` or `mailto:`, otherwise null. */
export function appLinkUrl(rawUrl: string): string | null {
  const url = URL.parse(rawUrl);
  return url === null || browserProtocols.has(url.protocol) ? null : url.href;
}
