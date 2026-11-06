import {
  type GracefulShutdownId,
  type GracefulShutdownPhase,
  type GracefulShutdownScope,
  type GracefulShutdownStatus,
  type MessageId,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface GracefulShutdownGateState {
  readonly phase: Exclude<GracefulShutdownPhase, "idle"> | "idle";
  readonly shutdownId: GracefulShutdownId | null;
  readonly scope: GracefulShutdownScope | null;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly saveWorkPrompted: boolean;
  readonly saveWorkMessageIds: ReadonlySet<MessageId>;
  readonly saveWorkThreadIds: ReadonlySet<ThreadId>;
}

const IDLE_STATE: GracefulShutdownGateState = {
  phase: "idle",
  shutdownId: null,
  scope: null,
  reason: null,
  startedAt: null,
  deadlineAt: null,
  saveWorkPrompted: false,
  saveWorkMessageIds: new Set(),
  saveWorkThreadIds: new Set(),
};

export function isDrainActive(state: GracefulShutdownGateState): boolean {
  return state.phase === "draining" || state.phase === "quiesced" || state.phase === "timed_out";
}

export class GracefulShutdownGate extends Context.Service<
  GracefulShutdownGate,
  {
    readonly getState: Effect.Effect<GracefulShutdownGateState>;
    readonly setState: (state: GracefulShutdownGateState) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
    readonly isSaveWorkMessage: (messageId: MessageId) => Effect.Effect<boolean>;
    /** True when new turns for this thread must queue (steers still allowed). */
    readonly shouldQueueNewTurns: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId | null;
      readonly providerSessionIds: ReadonlyArray<ProviderSessionId>;
      readonly messageId?: MessageId;
    }) => Effect.Effect<boolean>;
    readonly toStatus: (activeRunCount: number) => Effect.Effect<GracefulShutdownStatus>;
  }
>()("t3/orchestration-v2/GracefulShutdownGate") {}

const make = Effect.fn("GracefulShutdownGate.make")(function* () {
  const stateRef = yield* Ref.make<GracefulShutdownGateState>(IDLE_STATE);

  const getState = Ref.get(stateRef);
  const setState = (state: GracefulShutdownGateState) => Ref.set(stateRef, state);
  const clear = Ref.set(stateRef, IDLE_STATE);

  const isSaveWorkMessage = Effect.fn("GracefulShutdownGate.isSaveWorkMessage")(function* (
    messageId: MessageId,
  ) {
    const state = yield* getState;
    return state.saveWorkMessageIds.has(messageId);
  });

  const shouldQueueNewTurns = Effect.fn("GracefulShutdownGate.shouldQueueNewTurns")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId | null;
      readonly providerSessionIds: ReadonlyArray<ProviderSessionId>;
      readonly messageId?: MessageId;
    }) {
      const state = yield* getState;
      if (!isDrainActive(state) || state.scope === null) return false;
      if (input.messageId !== undefined && state.saveWorkMessageIds.has(input.messageId)) {
        return false;
      }
      const scope = state.scope;
      if (scope.type === "environment") return true;
      if (scope.type === "provider") {
        return (
          input.providerInstanceId !== null && scope.providerInstanceId === input.providerInstanceId
        );
      }
      return input.providerSessionIds.includes(scope.providerSessionId);
    },
  );

  const toStatus = Effect.fn("GracefulShutdownGate.toStatus")(function* (activeRunCount: number) {
    const state = yield* getState;
    return {
      phase: state.phase === "idle" ? ("idle" as const) : state.phase,
      ...(state.shutdownId !== null ? { shutdownId: state.shutdownId } : {}),
      ...(state.scope !== null ? { scope: state.scope } : {}),
      ...(state.reason !== null ? { reason: state.reason } : {}),
      ...(state.startedAt !== null ? { startedAt: state.startedAt } : {}),
      ...(state.deadlineAt !== null ? { deadlineAt: state.deadlineAt } : {}),
      activeRunCount,
      saveWorkPrompted: state.saveWorkPrompted,
      saveWorkTurnCount: state.saveWorkMessageIds.size,
    };
  });

  return GracefulShutdownGate.of({
    getState,
    setState,
    clear,
    isSaveWorkMessage,
    shouldQueueNewTurns,
    toStatus,
  });
});

export const layer = Layer.effect(GracefulShutdownGate, make());
