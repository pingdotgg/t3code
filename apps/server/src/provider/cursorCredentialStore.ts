const CACHE_MS = 5 * 60_000;

/** Share one Keychain request across usage history and limits in this server process. */
export function makeCachedCursorAccessTokenReader(
  read: () => Promise<string | null>,
  now: () => number = Date.now,
): () => Promise<string | null> {
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string | null> | null = null;
  return () => {
    if (cached && cached.until > now()) return Promise.resolve(cached.token);
    if (pending) return pending;
    pending = read()
      .then((token) => {
        cached = token ? { token, until: now() + CACHE_MS } : null;
        return token;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/** Read the Cursor CLI's default macOS credential without invoking the shared security binary. */
export const readMacCursorAccessToken = makeCachedCursorAccessTokenReader(async () => {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return (await new AsyncEntry("cursor-access-token", "cursor-user").getPassword()) ?? null;
});
