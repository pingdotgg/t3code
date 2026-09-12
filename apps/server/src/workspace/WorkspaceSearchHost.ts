import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  startSearchProcess,
  WorkspaceSearchProcessFailed,
  type SearchProcess,
} from "./WorkspaceSearchProcess.ts";
import type { WorkspaceSearchIndexVariant } from "./WorkspaceSearchIndexService.ts";
import type { SearchOperation } from "./workspaceSearchProtocol.ts";

const make = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  let current: { process: SearchProcess; indexes: Set<number> } | undefined;
  let activeIndex: number | undefined;
  let nextId = 0;
  let closed = false;
  const stop = Effect.fn("WorkspaceSearchHost.stop")(function* () {
    const previous = current;
    current = undefined;
    if (previous) yield* previous.process.stop;
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* stop();
    }),
  );

  const open = Effect.fn("WorkspaceSearchHost.open")(function* (
    cwd: string,
    variant: WorkspaceSearchIndexVariant,
  ) {
    const id = ++nextId;
    let released = false;
    const initialize: SearchOperation = { method: "initialize", cwd, variant };
    const run = Effect.fn("WorkspaceSearchHost.request")(
      function* (operation: SearchOperation) {
        yield* Effect.annotateCurrentSpan({ cwd, variant, operation: operation.method });
        if (closed || released)
          return yield* new WorkspaceSearchProcessFailed({
            cause: new Error("Workspace search index is closed."),
          });
        activeIndex = id;
        return yield* Effect.gen(function* () {
          const active = yield* Effect.gen(function* () {
            if (current) return current;
            const process = yield* startSearchProcess();
            current = { process, indexes: new Set<number>() };
            return current;
          }).pipe(Effect.uninterruptible);
          if (!active.indexes.has(id)) {
            yield* active.process.request({ id, operation: initialize });
            active.indexes.add(id);
          }
          return operation.method === "initialize"
            ? null
            : yield* active.process.request({ id, operation });
        }).pipe(
          Effect.onError(stop),
          Effect.ensuring(
            Effect.sync(() => {
              activeIndex = undefined;
            }),
          ),
        );
      },
      semaphore.withPermits(1),
      Effect.timeout("20 seconds"),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        released = true;
        if (activeIndex === id) yield* stop();
        // Give unrelated requests their own deadline. The shorter disposal
        // deadline bounds the native destructor, not another workspace's scan.
        yield* Effect.gen(function* () {
          if (!current?.indexes.has(id)) return;
          current.indexes.delete(id);
          if (current.indexes.size === 0) return yield* stop();
          yield* current.process.request({ id, operation: { method: "dispose" } });
        }).pipe(
          Effect.timeout("1 second"),
          Effect.onError(stop),
          semaphore.withPermits(1),
          Effect.catchCause(() => Effect.void),
        );
      }),
    );
    yield* run(initialize);
    return { request: run };
  });
  return { open };
});

export class WorkspaceSearchHost extends Context.Service<
  WorkspaceSearchHost,
  Effect.Success<typeof make>
>()("t3/workspace/WorkspaceSearchHost") {
  static readonly layer = Layer.effect(WorkspaceSearchHost, make);
}
