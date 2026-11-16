import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Effect from "effect/Effect";

import type { FyiDeliveryShape } from "./FyiDelivery.ts";

/** Explicit, so the margin below does not rest on Claude Code's default hook timeout. */
const FYI_HOOK_TIMEOUT_SECONDS = 120;
/**
 * No bind starts after this. Claude Code goes on without the output of a hook it timed out, so a
 * bind it abandoned would leave an FYI sent in a run that may still complete.
 */
const FYI_HOOK_BIND_DEADLINE_MS = 10_000;

/**
 * Claude Code hook that hands a running main agent its waiting FYI messages once its tool calls
 * resolve, before the next model request. It adds context to that request and never starts one, so
 * an FYI cannot become another reply that replaces the run's result. Subagents get nothing.
 */
export const claudeFyiHooks = (input: {
  readonly fyi: FyiDeliveryShape | undefined;
  readonly threadId: ThreadId;
  readonly activeTurn: Effect.Effect<
    | (Pick<ProviderAdapter.ProviderAdapterV2TurnInput, "threadId" | "runId" | "rootNodeId"> & {
        readonly providerThread: Pick<OrchestrationV2ProviderThread, "id">;
      })
    | undefined
  >;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
  const { fyi, threadId, activeTurn, runPromise } = input;
  return fyi === undefined
    ? {}
    : {
        PostToolBatch: [
          {
            timeout: FYI_HOOK_TIMEOUT_SECONDS,
            hooks: [
              async (hookInput, _toolUseId, { signal }) => {
                const late = AbortSignal.timeout(FYI_HOOK_BIND_DEADLINE_MS);
                if (
                  hookInput.hook_event_name !== "PostToolBatch" ||
                  hookInput.agent_id !== undefined
                )
                  return {};
                const turn = await runPromise(activeTurn);
                if (turn === undefined || turn.threadId !== threadId) return {};
                const text = await runPromise(
                  fyi.forToolBatch({
                    threadId,
                    carrier: {
                      runId: turn.runId,
                      nodeId: turn.rootNodeId,
                      providerThreadId: turn.providerThread.id,
                    },
                    stop: () => signal.aborted || late.aborted,
                  }),
                );
                return text === undefined
                  ? {}
                  : {
                      hookSpecificOutput: {
                        hookEventName: "PostToolBatch",
                        additionalContext: text,
                      },
                    };
              },
            ],
          },
        ],
      };
};
