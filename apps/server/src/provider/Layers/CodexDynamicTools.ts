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

export interface T3CodexDynamicToolWaitRegistry {
  readonly handle: (
    payload: EffectCodexSchema.DynamicToolCallParams,
  ) => Effect.Effect<EffectCodexSchema.DynamicToolCallResponse>;
  readonly cancelTurn: (turnId: string) => Effect.Effect<void>;
  readonly cancelAll: Effect.Effect<void>;
}

export const makeT3CodexDynamicToolWaitRegistry = Effect.fn("makeT3CodexDynamicToolWaitRegistry")(
  function* (): Effect.fn.Return<T3CodexDynamicToolWaitRegistry> {
    const pendingRef = yield* Ref.make(new Map<string, PendingWait>());

    const cancelWhere = (predicate: (pending: PendingWait) => boolean) =>
      Ref.get(pendingRef).pipe(
        Effect.flatMap((pendingWaits) =>
          Effect.forEach(
            Array.from(pendingWaits.values()),
            (pending) =>
              predicate(pending)
                ? Deferred.succeed(pending.cancelled, undefined).pipe(Effect.ignore)
                : Effect.void,
            { discard: true },
          ),
        ),
      );

    return {
      handle: (payload) =>
        Effect.gen(function* () {
          const cancelled = yield* Deferred.make<void>();
          yield* Ref.update(pendingRef, (current) => {
            const next = new Map(current);
            next.set(payload.callId, { turnId: payload.turnId, cancelled });
            return next;
          });

          return yield* handleT3CodexDynamicToolCall(payload, Deferred.await(cancelled)).pipe(
            Effect.ensuring(
              Ref.update(pendingRef, (current) => {
                const next = new Map(current);
                next.delete(payload.callId);
                return next;
              }),
            ),
          );
        }),
      cancelTurn: (turnId) => cancelWhere((pending) => pending.turnId === turnId),
      cancelAll: cancelWhere(() => true),
    };
  },
);
