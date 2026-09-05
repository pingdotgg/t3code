import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  {
    readonly withLock: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly withProjectLock: <A, E, R>(
      projectId: ProjectId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

const make = Effect.gen(function* () {
  const executor = yield* makeKeyedSerialExecutor<string>();
  const withLock: ThreadCommandExecutor["Service"]["withLock"] = (threadId, effect) =>
    executor.withLock(`thread:${threadId}`, effect);
  const withProjectLock: ThreadCommandExecutor["Service"]["withProjectLock"] = (
    projectId,
    effect,
  ) => executor.withLock(`project:${projectId}`, effect);
  return ThreadCommandExecutor.of({
    withLock,
    withProjectLock,
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
