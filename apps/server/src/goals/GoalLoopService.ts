import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { suppressedWakeNotice, wakeSwitch } from "../orchestration-v2/NotificationMailbox.ts";
import * as ServerSettings from "../serverSettings.ts";

export const GOAL_CONTINUE_MESSAGE = "Continue working toward the thread goal.";

const BLOCKED_FALLBACK_REASON = "Agent reported it is blocked";
const GOAL_COMPLETE_PATTERN = /<goal_complete\s*\/?>/gi;
const GOAL_BLOCKED_PATTERN = /<goal_blocked>([\s\S]*?)<\/goal_blocked>/gi;

export type GoalSignal =
  | { readonly kind: "complete" }
  | { readonly kind: "blocked"; readonly reason: string };

interface GoalLoopThreadState {
  readonly goal?: string | null | undefined;
  readonly goalLoop?: ThreadGoalLoop | null | undefined;
  readonly activeRunId: unknown | null;
  readonly pendingRuntimeRequest: unknown | null;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks?: ReadonlyArray<unknown> | undefined;
  readonly archivedAt: unknown | null;
  readonly deletedAt: unknown | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: unknown | null;
  readonly snoozedUntil?: unknown | null | undefined;
}

interface GoalLoopProjectionState {
  readonly subagents: ReadonlyArray<{
    readonly status: string;
    readonly completionDelivery?: { readonly state: string } | null | undefined;
  }>;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly requestedAt: DateTime.Utc;
    readonly status: string;
  }>;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly runId: string | null;
    readonly text: string;
  }>;
}

export function scanGoalSignal(text: string): GoalSignal | null {
  let bestIndex = -1;
  let best: GoalSignal | null = null;
  for (const match of text.matchAll(GOAL_COMPLETE_PATTERN)) {
    if (match.index >= bestIndex) {
      bestIndex = match.index;
      best = { kind: "complete" };
    }
  }
  for (const match of text.matchAll(GOAL_BLOCKED_PATTERN)) {
    if (match.index >= bestIndex) {
      bestIndex = match.index;
      best = { kind: "blocked", reason: match[1]?.trim() || BLOCKED_FALLBACK_REASON };
    }
  }
  return best;
}

export function canDriveGoalLoop<T extends GoalLoopThreadState>(
  thread: T,
): thread is T & { readonly goalLoop: ThreadGoalLoop } {
  const loop = thread.goalLoop;
  return (
    thread.goal != null &&
    loop != null &&
    loop.mode === "t3" &&
    (loop.state === "idle" || loop.state === "running") &&
    thread.activeRunId === null &&
    thread.pendingRuntimeRequest === null &&
    !thread.hasActionableProposedPlan &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    thread.settledAt === null &&
    thread.snoozedUntil == null
  );
}

type GoalLoopPlan =
  | { readonly type: "hold" }
  | { readonly type: "send"; readonly advance: boolean; readonly key: string }
  | {
      readonly type: "update";
      readonly state: "blocked" | "completed" | "capped";
      readonly key: string;
      readonly reason?: string;
    };

function hasRequiredChildWork(projection: GoalLoopProjectionState): boolean {
  return projection.subagents.some(
    (task) =>
      task.status === "pending" ||
      task.status === "running" ||
      task.status === "waiting" ||
      task.completionDelivery?.state === "pending" ||
      task.completionDelivery?.state === "claimed",
  );
}

export function planGoalLoop(
  thread: { readonly goalLoop: ThreadGoalLoop },
  projection: GoalLoopProjectionState,
): GoalLoopPlan {
  const loop = thread.goalLoop;
  if (hasRequiredChildWork(projection)) return { type: "hold" };
  if (loop.state === "idle") {
    return { type: "send", advance: true, key: `resume:${DateTime.formatIso(loop.updatedAt)}` };
  }

  const latestRun = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (latestRun === undefined) {
    return { type: "send", advance: false, key: `recover:${DateTime.formatIso(loop.updatedAt)}` };
  }
  if (DateTime.toEpochMillis(loop.updatedAt) > DateTime.toEpochMillis(latestRun.requestedAt)) {
    return { type: "send", advance: false, key: `recover:${DateTime.formatIso(loop.updatedAt)}` };
  }
  if (latestRun.status !== "completed") return { type: "hold" };

  const assistantText = projection.messages
    .toReversed()
    .find((message) => message.role === "assistant" && message.runId === latestRun.id)?.text;
  const signal = assistantText === undefined ? null : scanGoalSignal(assistantText);
  if (signal?.kind === "complete") {
    return { type: "update", state: "completed", key: latestRun.id };
  }
  if (signal?.kind === "blocked") {
    return { type: "update", state: "blocked", key: latestRun.id, reason: signal.reason };
  }
  if (loop.iterations >= loop.maxIterations) {
    return {
      type: "update",
      state: "capped",
      key: latestRun.id,
      reason: `Reached ${loop.maxIterations} iterations.`,
    };
  }
  return { type: "send", advance: true, key: latestRun.id };
}

export class GoalLoopService extends Context.Service<
  GoalLoopService,
  {
    readonly runDueWork: Effect.Effect<
      void,
      ThreadManagement.ThreadManagementError | Orchestrator.OrchestratorV2Error
    >;
  }
>()("t3/goals/GoalLoopService") {}

const make = Effect.fn("GoalLoopService.make")(function* (options: {
  /** Reads the `t3GoalContinuation` setting per check; on when omitted. */
  readonly continueGoals?: Effect.Effect<boolean>;
}) {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const runThread = Effect.fn("GoalLoopService.runThread")(function* (
    thread: OrchestrationV2ThreadShell & { readonly goalLoop: ThreadGoalLoop },
  ) {
    const projection = yield* threads.getThreadProjection(thread.id);
    const plan = planGoalLoop(thread, projection);
    if (plan.type === "hold") return;

    const loop = thread.goalLoop;
    if (plan.type === "update") {
      yield* threads.dispatch({
        type: "thread.goal.loop",
        commandId: CommandId.make(`server:goal-${plan.state}:${thread.id}:${plan.key}`),
        threadId: thread.id,
        action: "sync",
        state: plan.state,
        ...(plan.reason === undefined ? {} : { reason: plan.reason }),
        goalLoopGuard: { updatedAt: loop.updatedAt },
      });
      return;
    }

    // Checked before the iteration advances, so the goal stays where it is and continues from
    // here once the switch is back on. The id is this turn's, so every later check records nothing new.
    if (!(yield* options.continueGoals ?? Effect.succeed(true))) {
      yield* threads.dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make(`server:goal-not-continued:${thread.id}:${plan.key}`),
        threadId: thread.id,
        notification: suppressedWakeNotice(
          "Goal not continued",
          `${GOAL_CONTINUE_MESSAGE}\n\nTo continue, send a message or turn goal continuation back on in Settings.`,
        ),
      });
      return;
    }
    const expectedIterations = plan.advance ? loop.iterations + 1 : loop.iterations;
    if (plan.advance) {
      yield* threads.dispatch({
        type: "thread.goal.loop",
        commandId: CommandId.make(`server:goal-advance:${thread.id}:${plan.key}`),
        threadId: thread.id,
        action: "sync",
        state: "running",
        iterations: expectedIterations,
        goalLoopGuard: { updatedAt: loop.updatedAt },
      });
    }

    const current = yield* threads.getThreadShell(thread.id);
    if (
      current === null ||
      current.goal !== thread.goal ||
      current.goalLoop?.state !== "running" ||
      current.goalLoop.iterations !== expectedIterations ||
      !canDriveGoalLoop(current)
    ) {
      return;
    }
    const identity = `${thread.id}:${plan.key}`;
    yield* threads.sendToThread({
      projectId: thread.projectId,
      commandId: CommandId.make(`server:goal-continue:${identity}`),
      threadId: thread.id,
      messageId: MessageId.make(`goal-continue:${identity}`),
      text: GOAL_CONTINUE_MESSAGE,
      attachments: [],
      modelSelection: current.modelSelection,
      mode: "auto",
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const runDueWork = Effect.gen(function* () {
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    yield* Effect.forEach(
      snapshot.threads.filter(canDriveGoalLoop),
      (thread) =>
        runThread(thread).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("goal loop failed to evaluate thread", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  return GoalLoopService.of({ runDueWork });
});

export const layerWith = (
  options: Parameters<typeof make>[0],
): Layer.Layer<GoalLoopService, never, ThreadManagement.ThreadManagementService> =>
  Layer.effect(GoalLoopService, make(options));

export const layer = layerWith({});

/** The layer the server runs: follows the `t3GoalContinuation` setting. */
export const layerLive = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return layerWith({ continueGoals: wakeSwitch(settings, "t3GoalContinuation") });
  }),
);
