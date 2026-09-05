import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

interface ThreadCommandExecutorShape {
  readonly withLock: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly withProjectLock: <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/** Shared by thread commands and project deletion so both plan against current thread state. */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  ThreadCommandExecutorShape
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

const make = Effect.gen(function* () {
  const executor = yield* makeKeyedSerialExecutor<string>();
  return {
    withLock: (threadId, effect) => executor.withLock(`thread:${threadId}`, effect),
    withProjectLock: (projectId, effect) => executor.withLock(`project:${projectId}`, effect),
  } satisfies ThreadCommandExecutorShape;
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
