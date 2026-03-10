import { CommandId, EventId, type OrchestrationThreadActivity, type ThreadId, type TurnId } from "@t3tools/contracts";
import { derivePendingUserInputs } from "@t3tools/shared/pendingUserInput";
import { Cause, Effect, Layer } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ColdStartLifecycle, type ColdStartLifecycleShape } from "../Services/ColdStartLifecycle.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const appendExpiredUserInputActivity = (input: {
  readonly orchestrationEngine: typeof OrchestrationEngineService.Service;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}) =>
  input.orchestrationEngine.dispatch({
    type: "thread.activity.append",
    commandId: serverCommandId("expire-stale-user-input"),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(`server:user-input-expired:${crypto.randomUUID()}`),
      tone: "info",
      kind: "user-input.expired",
      summary: "Pending question expired after app restart",
      payload: {
        requestId: input.requestId,
        reason: "server-restart",
        detail:
          "This pending question could not be resumed after app restart. Re-run the action if you still want to answer it.",
      },
      turnId: input.turnId,
      createdAt: input.createdAt,
    } satisfies OrchestrationThreadActivity,
    createdAt: input.createdAt,
  });

const expireStalePendingUserInputsOnColdBoot = (input: {
  readonly orchestrationEngine: typeof OrchestrationEngineService.Service;
}) =>
  Effect.gen(function* () {
    const readModel = yield* input.orchestrationEngine.getReadModel();

    for (const thread of readModel.threads) {
      const pendingPrompts = derivePendingUserInputs(thread.activities);
      for (const prompt of pendingPrompts) {
        const expiredAt = new Date().toISOString();
        yield* appendExpiredUserInputActivity({
          orchestrationEngine: input.orchestrationEngine,
          threadId: thread.id,
          requestId: prompt.requestId,
          turnId: prompt.turnId,
          createdAt: expiredAt,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to expire stale pending user-input request on cold boot", {
              threadId: thread.id,
              requestId: prompt.requestId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    }
  });

const makeColdStartLifecycle = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const run: ColdStartLifecycleShape["run"] = Effect.gen(function* () {
    const activeSessions = yield* providerService.listSessions();
    if (activeSessions.length > 0) {
      return;
    }

    const tasks = [expireStalePendingUserInputsOnColdBoot({ orchestrationEngine })];
    yield* Effect.forEach(tasks, (task) => task).pipe(Effect.asVoid);
  });

  return {
    run,
  } satisfies ColdStartLifecycleShape;
});

export const ColdStartLifecycleLive = Layer.effect(ColdStartLifecycle, makeColdStartLifecycle);
