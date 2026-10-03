// @effect-diagnostics globalTimers:off - Promise helper for UI callers, outside an Effect runtime.
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";

/**
 * Waits for title regeneration `requestId` to settle on the thread shell in
 * `atom`. Resolves with the server's failure reason, or null once the request
 * finishes without failing, the thread goes away, `signal` aborts, or
 * `timeoutMs` elapses.
 *
 * Start it before sending the regeneration command, and abort it if the command
 * is rejected. A success is only recognized after this client saw the request
 * in flight, so a watcher started late waits for its timeout. A failure keeps
 * the request id and is reported either way.
 */
export function waitForTitleRegenerationFailure(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atom: Atom.Atom<EnvironmentThreadShell | null>;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let sawInFlight = false;
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const abort = () => finish(null);
    const finish = (failure: string | null) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      input.signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      resolve(failure);
    };
    if (input.signal?.aborted) return finish(null);
    input.signal?.addEventListener("abort", abort, { once: true });
    const inspect = (thread: EnvironmentThreadShell | null) => {
      if (thread === null) return finish(null);
      if (thread.titleRegenerationFailure?.requestId === input.requestId) {
        return finish(thread.titleRegenerationFailure.message);
      }
      if (thread.titleRegeneration?.requestId === input.requestId) {
        sawInFlight = true;
      } else if (sawInFlight) {
        finish(null);
      }
    };

    unsubscribe = input.registry.subscribe(input.atom, inspect);
    if (settled) {
      unsubscribe();
      return;
    }
    inspect(input.registry.get(input.atom));
    if (!settled) {
      timeoutId = globalThis.setTimeout(() => finish(null), input.timeoutMs);
    }
  });
}
