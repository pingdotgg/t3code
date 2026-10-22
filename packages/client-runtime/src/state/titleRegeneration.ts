import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";

/** Call before sending the command; abort when it is rejected. A missing shell
    (undefined while disconnected, null while absent from the index) is watched until the
    deadline, so a reconnect or index refresh can still deliver the failure. */
export function waitForTitleRegenerationFailure(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atom: Atom.Atom<EnvironmentThreadShell | null | undefined>;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  let unsubscribe: (() => void) | undefined;
  let deadlineElapsed = false;
  const observation = Effect.callback<string | null>((resume) => {
    let sawInFlight = false;
    const inspect = (thread: EnvironmentThreadShell | null | undefined) => {
      if (thread == null) {
        if (deadlineElapsed) resume(Effect.succeed(null));
        return;
      }
      if (thread.titleRegenerationFailure?.requestId === input.requestId) {
        return resume(Effect.succeed(thread.titleRegenerationFailure.message));
      }
      if (thread.titleRegeneration?.requestId === input.requestId) {
        sawInFlight = true;
      } else if (sawInFlight) {
        resume(Effect.succeed(null));
      }
    };
    unsubscribe = input.registry.subscribe(input.atom, inspect);
    inspect(input.registry.get(input.atom));
  }).pipe(Effect.ensuring(Effect.sync(() => unsubscribe?.())));
  // Live queued generations may outlast the deadline, but disconnected clients
  // must release their subscriptions even when a cached marker is still in flight.
  const unobserved = Effect.sleep(input.timeoutMs).pipe(
    Effect.andThen(() => {
      deadlineElapsed = true;
      return input.registry.get(input.atom)?.titleRegeneration?.requestId === input.requestId
        ? Effect.never
        : Effect.succeed(null);
    }),
  );
  return Effect.runPromiseExit(Effect.raceFirst(observation, unobserved), {
    signal: input.signal,
  }).then((exit) => (Exit.isSuccess(exit) ? exit.value : null));
}
