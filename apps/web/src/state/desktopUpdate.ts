import { useAtomValue } from "@effect/atom-react";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Atom } from "effect/unstable/reactivity";

type DesktopUpdateBridge = Pick<DesktopBridge, "getUpdateState" | "onUpdateState">;

const INITIAL_STATE_READ_ATTEMPT_COUNT = 3;

export class DesktopUpdateStateReadError extends Schema.TaggedErrorClass<DesktopUpdateStateReadError>()(
  "DesktopUpdateStateReadError",
  {
    attemptCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the initial desktop update state after ${this.attemptCount} attempts.`;
  }
}

function getDesktopUpdateBridge(): DesktopUpdateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createDesktopUpdateStateAtom(getBridge: () => DesktopUpdateBridge | undefined) {
  const updates = Stream.callback<DesktopUpdateState | null>((queue) =>
    Effect.gen(function* () {
      const bridge = getBridge();
      if (!bridge) {
        Queue.offerUnsafe(queue, null);
        return yield* Effect.never;
      }

      let receivedUpdate = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onUpdateState((state) => {
            receivedUpdate = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );

      const initialState = yield* Effect.tryPromise({
        try: () => bridge.getUpdateState(),
        catch: (cause) =>
          new DesktopUpdateStateReadError({
            attemptCount: INITIAL_STATE_READ_ATTEMPT_COUNT,
            cause,
          }),
      }).pipe(
        Effect.retry({ times: INITIAL_STATE_READ_ATTEMPT_COUNT - 1 }),
        Effect.catchTags({
          DesktopUpdateStateReadError: (error) =>
            Effect.logError(error.message, {
              error,
              errorTag: error._tag,
              attemptCount: error.attemptCount,
            }).pipe(Effect.as(null)),
        }),
      );
      if (!receivedUpdate && initialState !== null) {
        Queue.offerUnsafe(queue, initialState);
      }

      return yield* Effect.never;
    }),
  );

  return Atom.make(updates, { initialValue: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:update-state"),
  );
}

const desktopUpdateStateAtom = createDesktopUpdateStateAtom(getDesktopUpdateBridge);

export function useDesktopUpdateState(): DesktopUpdateState | null {
  return AsyncResult.getOrElse(useAtomValue(desktopUpdateStateAtom), () => null);
}
