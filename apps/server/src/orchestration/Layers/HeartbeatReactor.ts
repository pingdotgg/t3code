import { CommandId, MessageId } from "@t3tools/contracts";
import { Effect, Layer, Schedule } from "effect";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { HeartbeatReactor, type HeartbeatReactorShape } from "../Services/HeartbeatReactor.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;

  const tick = Effect.gen(function* () {
    const readModel = yield* engine.getReadModel();
    const now = new Date();

    for (const thread of readModel.threads) {
      if (!thread.heartbeat || !thread.heartbeat.enabled) {
        continue;
      }

      // Only send if the session is ready for more input or idle
      // We don't want to interrupt a running turn.
      if (thread.session?.status !== "ready" && thread.session?.status !== "idle") {
        continue;
      }

      const lastSent = thread.heartbeat.lastSentAt ? new Date(thread.heartbeat.lastSentAt) : new Date(0);
      const elapsed = now.getTime() - lastSent.getTime();

      if (elapsed >= thread.heartbeat.intervalMs) {
        yield* Effect.logInfo("sending heartbeat to thread", { threadId: thread.id });

        const nowIso = now.toISOString();
        const turnStartCommandId = serverCommandId("heartbeat-turn-start");
        const heartbeatSentCommandId = serverCommandId("heartbeat-sent");

        // 1. Mark as sent immediately to prevent re-triggering in next tick if dispatch is slow
        yield* engine.dispatch({
          type: "thread.heartbeat.sent",
          commandId: heartbeatSentCommandId,
          threadId: thread.id,
          sentAt: nowIso,
          createdAt: nowIso,
        });

        // 2. Start turn with heartbeat prompt
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: turnStartCommandId,
          threadId: thread.id,
          message: {
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: "user",
            text: thread.heartbeat.prompt,
            attachments: [],
          },
          createdAt: nowIso,
        });
      }
    }
  });

  const start: HeartbeatReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.logInfo("heartbeat reactor starting");
    yield* Effect.forkScoped(
      Effect.repeat(tick, Schedule.spaced("10 seconds"))
    );
  });

  return {
    start,
  } satisfies HeartbeatReactorShape;
});

export const HeartbeatReactorLive = Layer.effect(HeartbeatReactor, make);
