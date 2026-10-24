import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { threadKey } from "./entities.ts";

export type ThreadHistoryLoadEarlierResult =
  | { readonly _tag: "loaded" }
  | { readonly _tag: "noop" }
  | { readonly _tag: "busy" }
  | { readonly _tag: "error"; readonly message: string };

export type ThreadHistoryHandler = {
  readonly loadEarlier: (throughEntryId?: string) => Effect.Effect<ThreadHistoryLoadEarlierResult>;
  readonly reconcilePendingWork: () => Effect.Effect<void>;
};

export type ThreadHistoryRegistration = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly handler: ThreadHistoryHandler;
};

export class ThreadHistoryController extends Context.Service<
  ThreadHistoryController,
  {
    readonly register: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      handler: ThreadHistoryHandler,
    ) => Effect.Effect<ThreadHistoryRegistration>;
    readonly unregister: (registration: ThreadHistoryRegistration) => Effect.Effect<void>;
    readonly loadEarlier: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
      throughEntryId?: string,
    ) => Effect.Effect<ThreadHistoryLoadEarlierResult>;
    readonly reconcilePendingWork: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/state/threadHistoryController") {}

export const layer: Layer.Layer<ThreadHistoryController> = Layer.effect(
  ThreadHistoryController,
  Effect.gen(function* () {
    const handlers = yield* Ref.make(new Map<string, ThreadHistoryHandler>());
    return ThreadHistoryController.of({
      register: (environmentId, threadId, handler) =>
        Ref.update(handlers, (current) => {
          const next = new Map(current);
          next.set(threadKey({ environmentId, threadId }), handler);
          return next;
        }).pipe(
          Effect.as({
            environmentId,
            threadId,
            handler,
          } satisfies ThreadHistoryRegistration),
        ),
      unregister: (registration) =>
        Ref.update(handlers, (current) => {
          const key = threadKey({
            environmentId: registration.environmentId,
            threadId: registration.threadId,
          });
          // Only remove when this registration still owns the slot. An older
          // fiber finalizer must not delete a newer handler for the same key.
          if (current.get(key) !== registration.handler) {
            return current;
          }
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
      loadEarlier: (environmentId, threadId, throughEntryId) =>
        Ref.get(handlers).pipe(
          Effect.flatMap((current) => {
            const handler = current.get(threadKey({ environmentId, threadId }));
            if (handler === undefined) {
              return Effect.succeed({ _tag: "noop" } satisfies ThreadHistoryLoadEarlierResult);
            }
            return handler.loadEarlier(throughEntryId);
          }),
        ),
      reconcilePendingWork: (environmentId, threadId) =>
        Ref.get(handlers).pipe(
          Effect.flatMap(
            (current) =>
              current.get(threadKey({ environmentId, threadId }))?.reconcilePendingWork() ??
              Effect.void,
          ),
        ),
    });
  }),
);
