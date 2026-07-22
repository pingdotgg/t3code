import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import type { ThreadId } from "@t3tools/contracts";

import type { GitHubWaitpointCondition } from "../../persistence/GitHubWaitpoints.ts";

export const T3_CODEX_DYNAMIC_TOOL_NAMESPACE = "t3";
export const T3_CODEX_WAIT_TOOL_NAME = "wait";
export const T3_CODEX_GITHUB_WAIT_TOOL_NAME = "await_github";
export const T3_CODEX_WAIT_MIN_DURATION_MS = 1_000;
export const T3_CODEX_WAIT_MAX_DURATION_MS = 3_600_000;
export const T3_CODEX_GITHUB_WAIT_DEFAULT_TIMEOUT_MINUTES = 24 * 60;
export const T3_CODEX_GITHUB_WAIT_MAX_TIMEOUT_MINUTES = 7 * 24 * 60;

const T3CodexWaitArguments = Schema.Struct({
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(T3_CODEX_WAIT_MIN_DURATION_MS)).check(
    Schema.isLessThanOrEqualTo(T3_CODEX_WAIT_MAX_DURATION_MS),
  ),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
const decodeT3CodexWaitArguments = Schema.decodeUnknownEffect(T3CodexWaitArguments);
const T3CodexGitHubWaitArguments = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^/\s]+$/)).check(
    Schema.isMaxLength(200),
  ),
  pullRequestNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  condition: Schema.Literals(["checks_settled", "new_review_activity", "pull_request_closed"]),
  timeoutMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).check(
      Schema.isLessThanOrEqualTo(T3_CODEX_GITHUB_WAIT_MAX_TIMEOUT_MINUTES),
    ),
  ),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
const decodeT3CodexGitHubWaitArguments = Schema.decodeUnknownEffect(T3CodexGitHubWaitArguments);

export interface RegisterGitHubWaitpointInput {
  readonly idempotencyKey: string;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly condition: GitHubWaitpointCondition;
  readonly timeoutMinutes: number;
  readonly reason?: string;
}

export interface T3CodexDynamicToolContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly registerGitHubWaitpoint: (
    input: RegisterGitHubWaitpointInput,
  ) => Effect.Effect<{ readonly id: string }, { readonly message: string }>;
}

export const T3_CODEX_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: T3_CODEX_DYNAMIC_TOOL_NAMESPACE,
    description: "T3 Code host lifecycle tools that can pause work without model polling.",
    tools: [
      {
        type: "function",
        name: T3_CODEX_WAIT_TOOL_NAME,
        description:
          "Wait inside T3 Code without using model inference. Use this for an intentional idle period while external work is running, then check the work once after the wait completes. The wait only lasts while this live T3 provider session remains connected; it is cancelled if the turn is interrupted or the session closes.",
        inputSchema: {
          type: "object",
          properties: {
            durationMs: {
              type: "integer",
              minimum: T3_CODEX_WAIT_MIN_DURATION_MS,
              maximum: T3_CODEX_WAIT_MAX_DURATION_MS,
              description: "How long T3 should wait, in milliseconds.",
            },
            reason: {
              type: "string",
              maxLength: 500,
              description: "Optional short explanation of the external work being awaited.",
            },
          },
          required: ["durationMs"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: T3_CODEX_GITHUB_WAIT_TOOL_NAME,
        description:
          "Register a durable T3 Code waitpoint for a GitHub pull request. T3 polls GitHub locally through the authenticated gh CLI without model inference, survives a T3 restart, and starts one continuation turn when the condition is met. After registration, finish the current turn instead of polling.",
        inputSchema: {
          type: "object",
          properties: {
            repository: {
              type: "string",
              pattern: "^[^/\\s]+/[^/\\s]+$",
              maxLength: 200,
              description: "GitHub repository in owner/name form.",
            },
            pullRequestNumber: {
              type: "integer",
              minimum: 1,
              description: "Pull request number to watch.",
            },
            condition: {
              type: "string",
              enum: ["checks_settled", "new_review_activity", "pull_request_closed"],
              description: "GitHub condition that should resume this thread.",
            },
            timeoutMinutes: {
              type: "integer",
              minimum: 1,
              maximum: T3_CODEX_GITHUB_WAIT_MAX_TIMEOUT_MINUTES,
              default: T3_CODEX_GITHUB_WAIT_DEFAULT_TIMEOUT_MINUTES,
              description: "Stop watching after this many minutes (default 24 hours).",
            },
            reason: {
              type: "string",
              maxLength: 500,
              description: "Optional short explanation of the work to continue.",
            },
          },
          required: ["repository", "pullRequestNumber", "condition"],
          additionalProperties: false,
        },
      },
    ],
  },
] as const satisfies ReadonlyArray<EffectCodexSchema.V2ThreadStartParams__DynamicToolSpec>;

function textResponse(success: boolean, text: string): EffectCodexSchema.DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

export const handleT3CodexDynamicToolCall = Effect.fn("handleT3CodexDynamicToolCall")(function* (
  payload: EffectCodexSchema.DynamicToolCallParams,
  cancelled: Effect.Effect<void> = Effect.never,
  context?: T3CodexDynamicToolContext,
): Effect.fn.Return<EffectCodexSchema.DynamicToolCallResponse> {
  if (payload.namespace !== T3_CODEX_DYNAMIC_TOOL_NAMESPACE) {
    return textResponse(
      false,
      `Unknown T3 Code dynamic tool: ${payload.namespace ?? "<none>"}.${payload.tool}`,
    );
  }

  if (payload.tool === T3_CODEX_GITHUB_WAIT_TOOL_NAME) {
    if (context === undefined) {
      return textResponse(false, "Durable GitHub waits are unavailable in this T3 Code runtime.");
    }
    const decoded = yield* Effect.result(decodeT3CodexGitHubWaitArguments(payload.arguments));
    if (Result.isFailure(decoded)) {
      return textResponse(
        false,
        "Invalid GitHub wait arguments. Use owner/repository, a positive pull request number, and a supported condition.",
      );
    }
    const registration = yield* Effect.result(
      context.registerGitHubWaitpoint({
        idempotencyKey: payload.callId,
        threadId: context.threadId,
        cwd: context.cwd,
        repository: decoded.success.repository,
        pullRequestNumber: decoded.success.pullRequestNumber,
        condition: decoded.success.condition,
        timeoutMinutes:
          decoded.success.timeoutMinutes ?? T3_CODEX_GITHUB_WAIT_DEFAULT_TIMEOUT_MINUTES,
        ...(decoded.success.reason === undefined ? {} : { reason: decoded.success.reason }),
      }),
    );
    if (Result.isFailure(registration)) {
      return textResponse(false, `Could not register GitHub wait: ${registration.failure.message}`);
    }
    return textResponse(
      true,
      `GitHub wait registered as ${registration.success.id}. Finish this turn now; T3 Code will resume the thread when the condition is met.`,
    );
  }

  if (payload.tool !== T3_CODEX_WAIT_TOOL_NAME) {
    return textResponse(
      false,
      `Unknown T3 Code dynamic tool: ${payload.namespace ?? "<none>"}.${payload.tool}`,
    );
  }

  const decoded = yield* Effect.result(decodeT3CodexWaitArguments(payload.arguments));
  if (Result.isFailure(decoded)) {
    return textResponse(
      false,
      `Invalid wait arguments. durationMs must be an integer from ${T3_CODEX_WAIT_MIN_DURATION_MS} through ${T3_CODEX_WAIT_MAX_DURATION_MS}.`,
    );
  }

  const outcome = yield* Effect.sleep(Duration.millis(decoded.success.durationMs)).pipe(
    Effect.as("elapsed" as const),
    Effect.raceFirst(cancelled.pipe(Effect.as("cancelled" as const))),
  );

  return outcome === "elapsed"
    ? textResponse(true, `Wait completed after ${decoded.success.durationMs} ms.`)
    : textResponse(false, "Wait cancelled because the turn was interrupted or the session closed.");
});

interface PendingWait {
  readonly turnId: string;
  readonly cancelled: Deferred.Deferred<void>;
}

interface WaitRegistryState {
  readonly pending: Map<string, PendingWait>;
  readonly cancelledTurnIds: Set<string>;
  readonly closed: boolean;
}

export interface T3CodexDynamicToolWaitRegistry {
  readonly handle: (
    payload: EffectCodexSchema.DynamicToolCallParams,
  ) => Effect.Effect<EffectCodexSchema.DynamicToolCallResponse>;
  readonly cancelTurn: (turnId: string) => Effect.Effect<void>;
  readonly cancelAll: Effect.Effect<void>;
}

export const makeT3CodexDynamicToolWaitRegistry = Effect.fn("makeT3CodexDynamicToolWaitRegistry")(
  function* (
    context?: T3CodexDynamicToolContext,
  ): Effect.fn.Return<T3CodexDynamicToolWaitRegistry> {
    const stateRef = yield* Ref.make<WaitRegistryState>({
      pending: new Map(),
      cancelledTurnIds: new Set(),
      closed: false,
    });

    const completeCancellations = (pendingWaits: ReadonlyArray<PendingWait>) =>
      Effect.forEach(
        pendingWaits,
        (pending) => Deferred.succeed(pending.cancelled, undefined).pipe(Effect.ignore),
        { discard: true },
      );

    return {
      handle: (payload) =>
        Effect.gen(function* () {
          const cancelled = yield* Deferred.make<void>();
          const registered = yield* Ref.modify(stateRef, (current) => {
            if (current.closed || current.cancelledTurnIds.has(payload.turnId)) {
              return [false, current] as const;
            }
            const pending = new Map(current.pending);
            pending.set(payload.callId, { turnId: payload.turnId, cancelled });
            return [true, { ...current, pending }] as const;
          });

          return yield* handleT3CodexDynamicToolCall(
            payload,
            registered ? Deferred.await(cancelled) : Effect.void,
            context,
          ).pipe(
            Effect.ensuring(
              Ref.update(stateRef, (current) => {
                if (!current.pending.has(payload.callId)) {
                  return current;
                }
                const pending = new Map(current.pending);
                pending.delete(payload.callId);
                return { ...current, pending };
              }),
            ),
          );
        }),
      cancelTurn: (turnId) =>
        Ref.modify(stateRef, (current) => {
          const cancelledTurnIds = new Set(current.cancelledTurnIds);
          cancelledTurnIds.add(turnId);
          const pending = Array.from(current.pending.values()).filter(
            (wait) => wait.turnId === turnId,
          );
          return [pending, { ...current, cancelledTurnIds }] as const;
        }).pipe(Effect.flatMap(completeCancellations)),
      cancelAll: Ref.modify(stateRef, (current) => [
        Array.from(current.pending.values()),
        { ...current, closed: true },
      ]).pipe(Effect.flatMap(completeCancellations)),
    };
  },
);
