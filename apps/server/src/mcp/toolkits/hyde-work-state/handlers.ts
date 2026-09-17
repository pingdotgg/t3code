import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as HydeAgentWorkState from "../../../roy/autonomy/HydeAgentWorkState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  increment,
  mcpToolCallDuration,
  mcpToolCallsTotal,
  mcpWorkStateResultsTotal,
  withMetrics,
} from "../../../observability/Metrics.ts";
import { HydeWorkStateToolkit } from "./tools.ts";

const isRevisionConflictError = Schema.is(
  HydeAgentWorkState.HydeAgentWorkStateRevisionConflictError,
);
const isUnavailableError = Schema.is(HydeAgentWorkState.HydeAgentWorkStateUnavailableError);

type WorkStateOperation = "read" | "checkpoint";
type WorkStateResult =
  | "present"
  | "absent"
  | "changed"
  | "noop"
  | "revision_conflict"
  | HydeAgentWorkState.HydeAgentWorkStateUnavailableReason;

const requireWorkStateCapability = Effect.fn("HydeWorkStateToolkit.requireCapability")(
  function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("work_state")) {
      return yield* new HydeAgentWorkState.HydeAgentWorkStateUnavailableError({
        reason: "capability_unavailable",
      });
    }
    return invocation;
  },
);

const resultForError = (error: unknown): WorkStateResult | undefined => {
  if (isRevisionConflictError(error)) {
    return "revision_conflict";
  }
  if (isUnavailableError(error)) {
    return error.reason;
  }
  return undefined;
};

const recordResult = (operation: WorkStateOperation, result: WorkStateResult) =>
  increment(mcpWorkStateResultsTotal, { operation, result });

const withWorkStateTelemetry = <A, E, R>(input: {
  readonly operation: WorkStateOperation;
  readonly effect: Effect.Effect<A, E, R>;
  readonly resultForValue: (value: A) => WorkStateResult | undefined;
}): Effect.Effect<A, E, R> =>
  withMetrics(
    input.effect.pipe(
      Effect.tap((value) => {
        const result = input.resultForValue(value);
        return result === undefined ? Effect.void : recordResult(input.operation, result);
      }),
      Effect.tapError((error) => {
        const result = resultForError(error);
        return result === undefined ? Effect.void : recordResult(input.operation, result);
      }),
      Effect.withSpan("t3.mcp.tool", {
        attributes: {
          "mcp.tool.family": "work_state",
          "mcp.tool.operation": input.operation,
        },
      }),
    ),
    {
      counter: mcpToolCallsTotal,
      timer: mcpToolCallDuration,
      attributes: { family: "work_state", operation: input.operation },
    },
  );

export const HydeWorkStateToolkitHandlersLive = HydeWorkStateToolkit.toLayer({
  hyde_work_state_read: () =>
    withWorkStateTelemetry({
      operation: "read",
      effect: Effect.gen(function* () {
        const invocation = yield* requireWorkStateCapability();
        const service = yield* HydeAgentWorkState.HydeAgentWorkStateService;
        return yield* service.read(invocation.threadId);
      }),
      resultForValue: (result) => (result.present ? "present" : "absent"),
    }),
  hyde_work_state_checkpoint: (input) =>
    withWorkStateTelemetry({
      operation: "checkpoint",
      effect: Effect.gen(function* () {
        const invocation = yield* requireWorkStateCapability();
        const service = yield* HydeAgentWorkState.HydeAgentWorkStateService;
        return yield* service.checkpoint(
          invocation.threadId,
          invocation.providerSessionId,
          String(invocation.providerInstanceId),
          input,
        );
      }),
      resultForValue: (result) => (result.changed ? "changed" : "noop"),
    }),
});
