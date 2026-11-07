import type { ProviderAuthState } from "@t3tools/contracts";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

// The server abandons a sign-in after five minutes; stop shortly after that.
const WATCH_TIMEOUT_MS = 330_000;

/**
 * Hands over the Google link of this client's sign-in. It can arrive a minute later, after Settings
 * closed, so the watcher holds its own subscription. Calls `onEnd` if the sign-in ends or vanishes
 * without a link or the watch times out. The returned function stops it without calling either.
 */
export function watchProviderSignInLink(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<ProviderAuthState, unknown>>;
  readonly flowId: string;
  readonly open: (url: string) => void;
  readonly onEnd?: () => void;
  readonly timeoutMs?: number;
}): () => void {
  let stopped = false;
  let seenFlow = false;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    if (stopped) return false;
    stopped = true;
    clearTimeout(timeout);
    unsubscribe?.();
    return true;
  };
  // Callbacks run inside registry notification; a throw must not break the shared subscription.
  const call = (callback: () => void) => {
    try {
      callback();
    } catch {}
  };
  const end = () => {
    if (stop() && input.onEnd) call(input.onEnd);
  };
  const timeout = setTimeout(end, input.timeoutMs ?? WATCH_TIMEOUT_MS);
  unsubscribe = input.registry.subscribe(
    input.atom,
    (result) => {
      const auth = AsyncResult.getOrElse(result, () => null);
      if (stopped || !auth) return;
      if (auth.flowId !== input.flowId) {
        // Snapshots can predate this flow. Once it has been seen, anything else means it is gone.
        if (seenFlow) end();
        return;
      }
      seenFlow = true;
      const link = auth.authorizationUrl;
      if (link) {
        stop();
        call(() => input.open(link));
      } else if (auth.phase !== "starting" && auth.phase !== "waiting") {
        end();
      }
    },
    { immediate: true },
  );
  if (stopped) unsubscribe();
  return () => {
    stop();
  };
}
