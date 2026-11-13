/**
 * Preview teardown.
 */
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { SessionOps } from "./session.ts";
import type { TabsOps } from "./tabs.ts";
import type { State } from "./state.ts";

export const makeDestroyOps = (deps: State & SessionOps & TabsOps) => {
  const {
    tabsRef,
    listenersRef,
    pointerEventListenersRef,
    openLinkListenersRef,
    recordingInputListenersRef,
  } = deps;
  const m = deps.mutable;
  const destroy = Effect.fn("PreviewManager.destroy")(function* () {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(tabs.keys(), deps.closeTab, { discard: true });
    yield* Effect.all(
      [
        Ref.set(listenersRef, new Set()),
        Ref.set(pointerEventListenersRef, new Set()),
        Ref.set(openLinkListenersRef, new Set()),
        Ref.set(recordingInputListenersRef, new Set()),
      ],
      { discard: true },
    );
  });

  return { destroy };
};

export type DestroyOps = ReturnType<typeof makeDestroyOps>;
