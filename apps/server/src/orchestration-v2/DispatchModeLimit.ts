import {
  isRuntimeModeAbove,
  type OrchestrationV2DomainEvent,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Ref from "effect/Ref";

export interface DispatchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface DispatchModeRefusal extends DispatchModes {
  readonly threadId: ThreadId;
  readonly mode: "runtime" | "interaction";
}

/** Recheck target modes under the command lock; the user can raise them after preflight. */
export interface DispatchModeLimitValue extends DispatchModes {
  readonly refused?: Ref.Ref<DispatchModeRefusal | undefined>;
}

export const DispatchModeLimit = Context.Reference<DispatchModeLimitValue | undefined>(
  "t3/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

export const exceededDispatchModeLimit = (
  limit: DispatchModes,
  modes: DispatchModes,
): "runtime" | "interaction" | undefined =>
  isRuntimeModeAbove(modes.runtimeMode, limit.runtimeMode)
    ? "runtime"
    : interactionModeRank[modes.interactionMode] > interactionModeRank[limit.interactionMode]
      ? "interaction"
      : undefined;

/** The administrator's `limits.maxRuntimeMode`, which applies to every caller, the user included. */
export interface RuntimeModeCeiling {
  readonly organization: string;
  readonly maxRuntimeMode: RuntimeMode;
}

/** A caller's limit, lowered to the ceiling when the caller may otherwise go above it. */
export const narrowToCeiling = <Limit extends DispatchModes>(
  limit: Limit | undefined,
  ceiling: RuntimeModeCeiling | undefined,
): Limit | undefined =>
  limit === undefined ||
  ceiling === undefined ||
  !isRuntimeModeAbove(limit.runtimeMode, ceiling.maxRuntimeMode)
    ? limit
    : { ...limit, runtimeMode: ceiling.maxRuntimeMode };

export interface RuntimeModeCeilingRefusal {
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  /** `mode`: a thread would be created in or switched to the mode. `turn`: a turn would run in it. */
  readonly refused: "mode" | "turn";
}

/**
 * What a planned command would do above the ceiling, judged by its events so every command that
 * creates a thread, switches its mode, or starts or steers a turn is covered. `runtimeModes` holds
 * the committed mode of each thread a planned run belongs to. Lowering a mode, and commands that
 * start no work, stay open on a thread above the ceiling: they are how its user gets back under.
 */
export const runtimeModeCeilingRefusal = (
  maxRuntimeMode: RuntimeMode,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  runtimeModes: ReadonlyMap<ThreadId, RuntimeMode>,
): RuntimeModeCeilingRefusal | undefined => {
  const planned = new Map(runtimeModes);
  for (const event of events) {
    if (event.type === "thread.created" || event.type === "thread.runtime-mode-updated") {
      const { runtimeMode } = event.payload;
      planned.set(event.threadId, runtimeMode);
      if (isRuntimeModeAbove(runtimeMode, maxRuntimeMode)) {
        return { threadId: event.threadId, runtimeMode, refused: "mode" };
      }
    } else if (event.type === "run.created" || event.type === "run-attempt.created") {
      const runtimeMode = planned.get(event.threadId);
      if (runtimeMode !== undefined && isRuntimeModeAbove(runtimeMode, maxRuntimeMode)) {
        return { threadId: event.threadId, runtimeMode, refused: "turn" };
      }
    }
  }
  return undefined;
};

/** Threads whose committed mode `runtimeModeCeilingRefusal` needs: those a planned run belongs to. */
export const threadsStartingWork = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): ReadonlySet<ThreadId> => {
  const created = new Set<ThreadId>();
  const starting = new Set<ThreadId>();
  for (const event of events) {
    if (event.type === "thread.created") created.add(event.threadId);
    else if (
      (event.type === "run.created" || event.type === "run-attempt.created") &&
      !created.has(event.threadId)
    ) {
      starting.add(event.threadId);
    }
  }
  return starting;
};
