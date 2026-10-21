type OAuthOpen = (url: string) => Promise<{ callbackUrl: string }>;

/**
 * Lets the app cancel the Clerk OAuth flow the renderer is waiting on. The
 * system browser never reports a closed tab, so an abandoned sign-in would
 * otherwise keep Clerk's sheet spinning until Clerk's 180s timeout.
 *
 * Pass `wrapOpen` to `exposeClerkBridge` as `wrapOAuthOpen`. Cancelling only
 * rejects the renderer's promise; the patched main process replaces the stale
 * flow when the next attempt starts.
 */
export function createClerkOAuthCancel() {
  let cancelPending: (() => void) | null = null;
  const listeners = new Set<(pending: boolean) => void>();
  const setCancelPending = (cancel: (() => void) | null) => {
    cancelPending = cancel;
    for (const listener of listeners) listener(cancel !== null);
  };

  return {
    wrapOpen:
      (open: OAuthOpen): OAuthOpen =>
      (url) => {
        cancelPending?.();
        return new Promise((resolve, reject) => {
          const settle = () => {
            if (cancelPending === cancel) setCancelPending(null);
          };
          const cancel = () => {
            settle();
            reject(new Error("Clerk: OAuth flow was cancelled."));
          };
          setCancelPending(cancel);
          open(url).then(resolve, reject).finally(settle);
        });
      },
    isPending: () => cancelPending !== null,
    onPendingChange: (listener: (pending: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel: () => cancelPending?.(),
  };
}
