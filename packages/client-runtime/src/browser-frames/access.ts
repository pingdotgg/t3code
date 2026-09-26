/** Credentials for browser-frame requests that cannot set bearer or DPoP headers. */
export interface BrowserFrameAccess {
  /** Absolute environment URL ending in `/api/browser-frames`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /**
   * Extra query params applied to every request — `wsTicket` for bearer/DPoP
   * sessions, `hostId` when the descriptor names a specific engine host.
   */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
}

export const withBrowserFramesQuery = (
  url: string,
  access: BrowserFrameAccess,
  extra?: Readonly<Record<string, string>>,
): string => {
  const params = new URLSearchParams(access.query);
  if (extra) {
    for (const [name, value] of Object.entries(extra)) params.set(name, value);
  }
  const encoded = params.toString();
  if (encoded.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${encoded}`;
};
