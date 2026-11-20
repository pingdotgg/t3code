import { BlenderRequestError, type ServerSettingsError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

export class BlenderWorkflow extends Context.Service<
  BlenderWorkflow,
  {
    readonly changes: Stream.Stream<void>;
    readonly isActive: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly setActive: (
      threadId: ThreadId,
      active: boolean,
    ) => Effect.Effect<boolean, BlenderRequestError | ServerSettingsError>;
  }
>()("t3/blender/BlenderWorkflow") {}

const MAX_ACTIVE_THREADS = 256;

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const activeThreads = new Set<ThreadId>();
  const changes = yield* PubSub.sliding<void>(1);
  const writes = yield* Semaphore.make(1);

  const isActive = Effect.fn("BlenderWorkflow.isActive")(function* (threadId: ThreadId) {
    if (!activeThreads.has(threadId)) return false;
    const enabled = yield* settings.getSettings.pipe(
      Effect.map(({ blender }) => blender.enabled),
      Effect.orElseSucceed(() => false),
    );
    return enabled && activeThreads.has(threadId);
  });

  const setActive = Effect.fn("BlenderWorkflow.setActive")(function* (
    threadId: ThreadId,
    active: boolean,
  ) {
    if (!active) {
      if (activeThreads.delete(threadId)) yield* PubSub.publish(changes, undefined);
      return false;
    }
    const thread = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) {
      return yield* new BlenderRequestError({ reason: "thread-not-found" });
    }
    if (!(yield* settings.getSettings).blender.enabled) {
      return yield* new BlenderRequestError({ reason: "disabled" });
    }
    if (activeThreads.size >= MAX_ACTIVE_THREADS && !activeThreads.has(threadId)) {
      return yield* new BlenderRequestError({
        reason: "invalid-request",
        detail: "Deactivate Blender in another thread first.",
      });
    }
    if (!activeThreads.has(threadId)) {
      activeThreads.add(threadId);
      yield* PubSub.publish(changes, undefined);
    }
    return true;
  }, writes.withPermit);

  const engine = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
  if (Option.isSome(engine)) {
    yield* engine.value.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "thread.archived" || event.type === "thread.deleted"),
      Stream.runForEach((event) => setActive(event.threadId, false).pipe(Effect.ignore)),
      Effect.forkScoped,
    );
  }
  return BlenderWorkflow.of({ changes: Stream.fromPubSub(changes), isActive, setActive });
});

export const layer = Layer.effect(BlenderWorkflow, make);
