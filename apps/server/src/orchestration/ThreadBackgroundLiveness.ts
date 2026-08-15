/**
 * ThreadBackgroundLivenessService - in-memory per-thread background liveness
 * for the sidebar status pill.
 *
 * The turn can settle while native background work runs on (subagent fleets,
 * workflow runs, Monitor watch loops); the shell previously showed nothing.
 * Ingestion records task lifecycle transitions and the shell query reads the
 * derived state at mapping time — no persistence, no migration. After a
 * server restart the registry is empty until new task events arrive, which
 * matches reality: orphaned background work is not live.
 *
 * "monitoring" is reserved for watch loops (monitor tasks and background
 * shells) when they are the ONLY live work; any agent work presents as
 * "working".
 *
 * @module ThreadBackgroundLivenessService
 */
import { INERT_TASK_TYPES, MONITOR_TASK_TYPES } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";

export type ThreadBackgroundLiveness = "working" | "monitoring" | null;

interface ThreadLivenessState {
  readonly agents: Map<
    string,
    {
      readonly startedActivityId?: string;
      readonly latestUpdatedActivityId?: string;
    }
  >;
  readonly monitors: Set<string>;
}

// Classification sets are the shared contracts copies (MONITOR_TASK_TYPES:
// watch loops — monitor tasks plus background shells, which in practice are
// PR babysitting/log tails since pacing sleeps complete inside the turn;
// INERT_TASK_TYPES: plan-mode bookkeeping) so this registry, ingestion's
// agentKind stamp, and the client fold can never drift apart.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);
const TERMINAL_TOMBSTONE_CAPACITY = 10_000;
const TERMINAL_TOMBSTONE_TTL_MS = 2 * 60 * 60 * 1_000;

interface TerminalTombstone {
  readonly threadId: string;
  readonly expiresAt: number;
}

export interface ThreadLiveAgentAnchors {
  readonly taskId: string;
  readonly activityIds: ReadonlyArray<string>;
}

export class ThreadBackgroundLivenessService extends Context.Service<
  ThreadBackgroundLivenessService,
  {
    /**
     * Feed one task lifecycle transition. taskType may be absent on
     * synthesized rows (workflow members, Codex children) — those count as
     * agents. agentId marks a task launched from inside a subagent: its
     * internal shells are covered by the owning agent's liveness, but a
     * NESTED AGENT (agentId + agent-flavored taskType) still counts — it
     * can outlive its parent and must keep the thread Working.
     */
    readonly recordTaskLiveness: (input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly taskType: string | undefined;
      readonly status: string | undefined;
      readonly kind: "started" | "progress" | "updated" | "completed";
      readonly agentId?: string | undefined;
      readonly activityId?: string | undefined;
    }) => void;

    /** Session death orphans all of a thread's background work. */
    readonly clearThreadLiveness: (threadId: string) => void;

    /** Rebuild one thread after revert from the lifecycle rows that survived pruning. */
    readonly rebuildThreadLiveness: (
      threadId: string,
      activities: ReadonlyArray<{
        readonly activityId: string;
        readonly kind: string;
        readonly payload: unknown;
      }>,
    ) => void;

    /**
     * Two-state vocabulary by design: any live agent work is "working";
     * "monitoring" only when watch loops are the ONLY live work.
     */
    readonly getThreadBackgroundLiveness: (threadId: string) => ThreadBackgroundLiveness;

    /** Stable copy of live agent task IDs for cold-start projection anchors. */
    readonly getThreadLiveAgentIds: (threadId: string) => ReadonlySet<string>;

    /** Indexed lifecycle row IDs retained at constant cost per live agent. */
    readonly getThreadLiveAgentActivityIds: (threadId: string) => ReadonlySet<string>;

    /** Live-agent anchors grouped newest-first for bounded projection reads. */
    readonly getThreadLiveAgentAnchors: (threadId: string) => ReadonlyArray<ThreadLiveAgentAnchors>;
  }
>()("t3/orchestration/ThreadBackgroundLiveness/ThreadBackgroundLivenessService") {}

export function make(
  currentTimeMillis: () => number = () => 0,
): ThreadBackgroundLivenessService["Service"] {
  const stateByThreadId = new Map<string, ThreadLivenessState>();
  const terminalTombstones = new Map<string, TerminalTombstone>();

  const taskKey = (threadId: string, taskId: string) => `${threadId}\0${taskId}`;

  const rememberTerminal = (threadId: string, taskId: string, now: number) => {
    const key = taskKey(threadId, taskId);
    terminalTombstones.delete(key);
    terminalTombstones.set(key, { threadId, expiresAt: now + TERMINAL_TOMBSTONE_TTL_MS });
    while (terminalTombstones.size > TERMINAL_TOMBSTONE_CAPACITY) {
      const oldestKey = terminalTombstones.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      terminalTombstones.delete(oldestKey);
    }
  };

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Map(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without
  // a taskType may later reveal itself as a shell, become inert, or turn out
  // to be agent-owned. Every path drops any prior entry for the taskId so a
  // stale bucket assignment can't pin the thread's status (review finding).
  const drop = (threadId: string, taskId: string) => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  const recordTaskLiveness: ThreadBackgroundLivenessService["Service"]["recordTaskLiveness"] = (
    input,
  ) => {
    const now = currentTimeMillis();
    const tombstoneKey = taskKey(input.threadId, input.taskId);
    const tombstone = terminalTombstones.get(tombstoneKey);
    if (tombstone !== undefined && tombstone.expiresAt <= now) {
      terminalTombstones.delete(tombstoneKey);
    }
    const previousAgent = stateByThreadId.get(input.threadId)?.agents.get(input.taskId);
    const terminal =
      input.kind === "completed" ||
      input.status === "idle" ||
      (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
    if (terminal) {
      drop(input.threadId, input.taskId);
      rememberTerminal(input.threadId, input.taskId, now);
      return;
    }

    if (terminalTombstones.has(tombstoneKey)) {
      if (input.kind !== "started") {
        return;
      }
      terminalTombstones.delete(tombstoneKey);
    }

    const taskType = input.taskType;
    if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
      drop(input.threadId, input.taskId);
      return;
    }
    // Nested agents can outlive their parents; only their internal work is covered.
    if (
      input.agentId !== undefined &&
      (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
    ) {
      drop(input.threadId, input.taskId);
      return;
    }

    drop(input.threadId, input.taskId);
    const state = stateFor(input.threadId);
    if (taskType !== undefined && MONITOR_TASK_TYPES.has(taskType)) {
      state.monitors.add(input.taskId);
    } else {
      const startedActivityId =
        previousAgent?.startedActivityId ??
        (input.kind === "started" ? input.activityId : undefined);
      const latestUpdatedActivityId =
        input.kind === "updated" && input.activityId
          ? input.activityId
          : previousAgent?.latestUpdatedActivityId;
      state.agents.set(input.taskId, {
        ...(startedActivityId ? { startedActivityId } : {}),
        ...(latestUpdatedActivityId ? { latestUpdatedActivityId } : {}),
      });
    }
  };

  const clearThreadLiveness = (threadId: string) => {
    stateByThreadId.delete(threadId);
    for (const [key, tombstone] of terminalTombstones) {
      if (tombstone.threadId === threadId) {
        terminalTombstones.delete(key);
      }
    }
  };

  return {
    recordTaskLiveness,

    clearThreadLiveness,

    rebuildThreadLiveness: (threadId, activities) => {
      clearThreadLiveness(threadId);
      for (const activity of activities) {
        const kind =
          activity.kind === "task.started"
            ? "started"
            : activity.kind === "task.progress"
              ? "progress"
              : activity.kind === "task.updated"
                ? "updated"
                : activity.kind === "task.completed"
                  ? "completed"
                  : null;
        if (kind === null || !Predicate.isObject(activity.payload)) {
          continue;
        }
        const taskId = activity.payload.taskId;
        if (!Predicate.isString(taskId)) {
          continue;
        }
        const taskType = activity.payload.taskType;
        const status = activity.payload.status;
        const agentId = activity.payload.agentId;
        recordTaskLiveness({
          threadId,
          taskId,
          taskType: Predicate.isString(taskType) ? taskType : undefined,
          status: Predicate.isString(status) ? status : undefined,
          agentId: Predicate.isString(agentId) ? agentId : undefined,
          activityId: activity.activityId,
          kind,
        });
      }
    },

    getThreadBackgroundLiveness: (threadId) => {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0) {
        return "working";
      }
      if (state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },

    getThreadLiveAgentIds: (threadId) =>
      new Set(stateByThreadId.get(threadId)?.agents.keys() ?? []),

    getThreadLiveAgentActivityIds: (threadId) => {
      const activityIds = new Set<string>();
      for (const agent of stateByThreadId.get(threadId)?.agents.values() ?? []) {
        if (agent.startedActivityId) activityIds.add(agent.startedActivityId);
        if (agent.latestUpdatedActivityId) activityIds.add(agent.latestUpdatedActivityId);
      }
      return activityIds;
    },

    getThreadLiveAgentAnchors: (threadId) => {
      const agents = stateByThreadId.get(threadId)?.agents;
      if (!agents) {
        return [];
      }
      return [...agents.entries()].toReversed().map(([taskId, agent]) => ({
        taskId,
        activityIds: [agent.latestUpdatedActivityId, agent.startedActivityId].filter(
          (activityId): activityId is string => activityId !== undefined,
        ),
      }));
    },
  };
}

export const layer = Layer.effect(
  ThreadBackgroundLivenessService,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    return make(() => clock.currentTimeMillisUnsafe());
  }),
);
