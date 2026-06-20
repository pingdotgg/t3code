import {
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";

export class RuntimeRequestResponseExecutionError extends Schema.TaggedErrorClass<RuntimeRequestResponseExecutionError>()(
  "RuntimeRequestResponseExecutionError",
  {
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface RuntimeRequestServiceV2Shape {
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly answers?: ProviderUserInputAnswers;
  }) => Effect.Effect<void, RuntimeRequestResponseExecutionError>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("t3/orchestration-v2/RuntimeRequestService/RuntimeRequestServiceV2") {}

export const layer: Layer.Layer<
  RuntimeRequestServiceV2,
  never,
  ProjectionStoreV2 | ProviderSessionManagerV2
> = Layer.effect(
  RuntimeRequestServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;

    return RuntimeRequestServiceV2.of({
      respond: (input) =>
        Effect.gen(function* () {
          const projection = yield* projections.getThreadProjection(input.threadId);
          const request = projection.runtimeRequests.find(
            (candidate) => candidate.id === input.requestId,
          );
          if (request === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: "The runtime request no longer exists.",
            });
          }
          if (
            request.responseCapability.type !== "live" ||
            request.responseCapability.providerSessionId !== input.providerSessionId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: "The runtime request is not resumable on the recorded provider session.",
            });
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            return yield* new RuntimeRequestResponseExecutionError({
              threadId: input.threadId,
              requestId: input.requestId,
              cause: `Provider session ${input.providerSessionId} is not active.`,
            });
          }
          yield* session.value.respondToRuntimeRequest({
            requestId: input.requestId,
            ...(input.decision === undefined ? {} : { decision: input.decision }),
            ...(input.answers === undefined ? {} : { answers: input.answers }),
          });
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(RuntimeRequestResponseExecutionError)(cause)
              ? cause
              : new RuntimeRequestResponseExecutionError({
                  threadId: input.threadId,
                  requestId: input.requestId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
