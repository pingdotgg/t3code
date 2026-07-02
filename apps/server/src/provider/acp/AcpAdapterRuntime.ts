import {
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as EffectAcpSchema from "effect-acp/schema";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

export interface AcpAdapterPromptContext {
  readonly acpSessionId: string;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  promptsInFlight: number;
}

export interface AcpAdapterPromptTurnStore {
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
}

export interface AcpPromptSettlementOptions {
  readonly errorMessage?: string;
  readonly completedStopReason?: EffectAcpSchema.StopReason | null;
  readonly emitTurnCompletion?: boolean;
  /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
  readonly settleAllPrompts?: boolean;
}

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAcpResume(
  raw: unknown,
  schemaVersion: number,
): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== schemaVersion) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export function appendPromptResultToTurn(
  ctx: AcpAdapterPromptTurnStore,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

export function acpPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export const makeAcpThreadLock = Effect.fn("makeAcpThreadLock")(function* () {
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(threadId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  return <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));
});

export function makeAcpPromptSettler<
  Ctx extends AcpAdapterPromptContext,
  ENow = never,
  RNow = never,
  EStamp = never,
  RStamp = never,
  EOffer = never,
  ROffer = never,
>(input: {
  readonly provider: ProviderDriverKind;
  readonly sessions: ReadonlyMap<ThreadId, Ctx>;
  readonly nowIso: Effect.Effect<string, ENow, RNow>;
  readonly makeEventStamp: () => Effect.Effect<
    {
      readonly eventId: EventId;
      readonly createdAt: string;
    },
    EStamp,
    RStamp
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
}) {
  return (
    threadId: ThreadId,
    turnId: TurnId,
    expectedAcpSessionId: string,
    options?: AcpPromptSettlementOptions,
  ) =>
    Effect.gen(function* () {
      const liveCtx = input.sessions.get(threadId);
      if (!liveCtx) {
        return;
      }
      const settlementBelongsToLiveContext = acpPromptSettlementBelongsToContext({
        liveAcpSessionId: liveCtx.acpSessionId,
        expectedAcpSessionId,
        liveActiveTurnId: liveCtx.activeTurnId,
        liveSessionActiveTurnId: liveCtx.session.activeTurnId,
        turnId,
      });
      if (!settlementBelongsToLiveContext) {
        if (
          liveCtx.acpSessionId !== expectedAcpSessionId ||
          liveCtx.interruptedTurnIds.has(turnId)
        ) {
          return;
        }
        if (options?.emitTurnCompletion !== false) {
          if (options?.errorMessage !== undefined) {
            yield* input.offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* input.makeEventStamp()),
              provider: input.provider,
              threadId,
              turnId,
              payload: {
                state: "failed",
                errorMessage: options.errorMessage,
              },
            });
          } else if (options?.completedStopReason !== undefined) {
            yield* input.offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* input.makeEventStamp()),
              provider: input.provider,
              threadId,
              turnId,
              payload: {
                state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: options.completedStopReason ?? null,
              },
            });
          }
        }
        return;
      }
      let settleTurnId = turnId;
      if (options?.settleAllPrompts) {
        liveCtx.promptsInFlight = 0;
        if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
          const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
          if (!fallbackTurnId) {
            if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
              const updatedAt = yield* input.nowIso;
              const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
              liveCtx.activeTurnId = undefined;
              liveCtx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
            return;
          }
          settleTurnId = fallbackTurnId;
        }
      } else {
        const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
        if (
          remainingPrompts > 0 ||
          liveCtx.activeTurnId !== settleTurnId ||
          liveCtx.session.activeTurnId !== settleTurnId
        ) {
          liveCtx.promptsInFlight = remainingPrompts;
          return;
        }
        liveCtx.promptsInFlight = remainingPrompts;
      }
      const updatedAt = yield* input.nowIso;
      const canEmitTurnCompletion =
        liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
      const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
      const shouldEmitCompletedTurn =
        options?.completedStopReason !== undefined && canEmitTurnCompletion;
      const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
      liveCtx.activeTurnId = undefined;
      liveCtx.session = {
        ...readySession,
        status: "ready",
        updatedAt,
      };
      if (options?.emitTurnCompletion === false) {
        return;
      }
      if (shouldEmitFailedTurn) {
        yield* input.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* input.makeEventStamp()),
          provider: input.provider,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: "failed",
            errorMessage: options.errorMessage,
          },
        });
      } else if (shouldEmitCompletedTurn) {
        yield* input.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* input.makeEventStamp()),
          provider: input.provider,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: options.completedStopReason ?? null,
          },
        });
      }
    });
}
