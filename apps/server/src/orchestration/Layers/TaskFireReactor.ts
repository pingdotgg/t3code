import { CommandId, MessageId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { TaskFireReactor, type TaskFireReactorShape } from "../Services/TaskFireReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type TaskFiredEvent = Extract<OrchestrationEvent, { type: "task.fired" }>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const processTaskFired = Effect.fn("processTaskFired")(function* (event: TaskFiredEvent) {
    const { taskId, threadId, prompt, dueAt, firedAt } = event.payload;
    // Deterministic per due slot: a reactor retry after a crash re-dispatches
    // the identical command, which the engine's receipt dedupe collapses.
    const turnCommandId = CommandId.make(`server:task-turn:${taskId}:${dueAt}`);
    const messageId = yield* crypto.randomUUIDv4.pipe(Effect.map(MessageId.make));

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: turnCommandId,
      threadId,
      message: {
        messageId,
        role: "user",
        text: prompt,
        attachments: [],
      },
      runtimeMode: event.payload.runtimeMode,
      interactionMode: event.payload.interactionMode,
      createdAt: firedAt,
    });

    yield* Effect.logDebug("task.fire-reactor.turn-started", {
      taskId,
      threadId,
      dueAt,
    });
  });

  const processTaskFiredSafely = (event: TaskFiredEvent) =>
    processTaskFired(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // A fire whose anchor thread vanished (deleted between scheduling and
        // firing) logs and moves on: the task's nextFireAt already advanced,
        // so it stays armed for its next slot.
        return Effect.logWarning("task fire reactor failed to start turn", {
          eventType: event.type,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processTaskFiredSafely);

  const start: TaskFireReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "task.fired") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies TaskFireReactorShape;
});

export const TaskFireReactorLive = Layer.effect(TaskFireReactor, make);
