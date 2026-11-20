import {
  CommandId,
  OrchestrationDispatchCommandError,
  type OrchestrationV2ParentSettlement,
  type OrchestrationV2ParentSettlementResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/**
 * Children here of chats on another environment follow a manual settle or un-settle of those
 * chats, sent by that environment's RemoteSettlementCascade over a link or through an app.
 */
export class ParentSettlementFollow extends Context.Service<
  ParentSettlementFollow,
  {
    readonly follow: (
      settlement: OrchestrationV2ParentSettlement,
    ) => Effect.Effect<OrchestrationV2ParentSettlementResult, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration-v2/ParentSettlementFollow") {}

export const layer = Layer.effect(
  ParentSettlementFollow,
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const random = yield* SecureRandom.SecureRandom;

    const follow = Effect.fn("ParentSettlementFollow.follow")(
      function* (settlement: OrchestrationV2ParentSettlement) {
        const settledAt = DateTime.makeUnsafe(settlement.settledAt);
        const waiting: Array<ThreadId> = [];
        for (const parentThreadId of settlement.parentThreadIds) {
          const children = yield* projections.getChildThreads(parentThreadId);
          for (const child of children) {
            if (child.parentEnvironmentId !== settlement.parentEnvironmentId) continue;
            yield* orchestrator.dispatch({
              type: "thread.settlement.follow",
              commandId: CommandId.make(`server:parent-settlement:${yield* random.uuidV4()}`),
              threadId: child.id,
              action: settlement.action,
              settledBy: settlement.settledBy,
              settledAt,
            });
            if (settlement.action === "settle") {
              const after = yield* projections.getThread(child.id);
              if (after.settledOverride !== "settled") waiting.push(child.id);
            }
          }
        }
        return { waiting };
      },
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: `Could not follow the parent's settlement: ${cause.message}`,
            cause,
          }),
      ),
    );

    return ParentSettlementFollow.of({ follow });
  }),
);
