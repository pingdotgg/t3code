import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

export const T3_CODEX_DYNAMIC_TOOL_NAMESPACE = "t3";
export const T3_CODEX_WAIT_TOOL_NAME = "wait";
export const T3_CODEX_WAIT_MIN_DURATION_MS = 1_000;
export const T3_CODEX_WAIT_MAX_DURATION_MS = 3_600_000;

const T3CodexWaitArguments = Schema.Struct({
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(T3_CODEX_WAIT_MIN_DURATION_MS)).check(
    Schema.isLessThanOrEqualTo(T3_CODEX_WAIT_MAX_DURATION_MS),
  ),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
const decodeT3CodexWaitArguments = Schema.decodeUnknownEffect(T3CodexWaitArguments);

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
): Effect.fn.Return<EffectCodexSchema.DynamicToolCallResponse> {
  if (
    payload.namespace !== T3_CODEX_DYNAMIC_TOOL_NAMESPACE ||
    payload.tool !== T3_CODEX_WAIT_TOOL_NAME
  ) {
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
  function* (): Effect.fn.Return<T3CodexDynamicToolWaitRegistry> {
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
