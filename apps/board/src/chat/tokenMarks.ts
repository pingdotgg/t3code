import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

// The lanes that time tokens set this flag, so an ordinary session does not collect marks.
export const MARK_TOKENS = localStorage.getItem("board:token-marks") === "1";

/** The length of the newest reply, which is what a token's arrival and its paint share. */
function streamedLength(state: EnvironmentThreadState): number {
  const items = Option.getOrNull(state.data)?.visibleTurnItems ?? [];
  const reply = items.findLast(({ item }) => item.type === "assistant_message");
  return reply?.item.type === "assistant_message" ? reply.item.text.length : 0;
}

/** Marks `board:token-received` each time the newest reply grows. Returns the unsubscribe. */
export function watchTokens(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, unknown>>,
): () => void {
  let seen = 0;
  return registry.subscribe(atom, (result) => {
    const length = streamedLength(
      AsyncResult.getOrElse(result, () => EMPTY_ENVIRONMENT_THREAD_STATE),
    );
    if (length > seen) performance.mark("board:token-received", { detail: { length } });
    seen = length;
  });
}

/** Marks `board:token-painted` two frames after a reply of this length committed: the first commits it, the second follows its paint. */
export function markPainted(length: number): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => performance.mark("board:token-painted", { detail: { length } })),
  );
}
