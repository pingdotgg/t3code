import {
  isTerminalAgentAwarenessPhase,
  projectThreadAwareness,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { after, type LiveActivity } from "expo-widgets";
import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { ManagedRelayClient } from "@t3tools/client-runtime";

import { mobileRuntime } from "../../lib/runtime";
import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";
import { registerLiveActivityPushToken } from "./remoteRegistration";

const MAX_LOCAL_LIVE_ACTIVITIES = 3;
const FINAL_ACTIVITY_DISMISSAL_MS = 5 * 60 * 1_000;
const REMOTE_TOKEN_REGISTRATION_RETRY_MS = 15_000;
const MISSING_STATE_GRACE_MS = 30_000;

interface ActiveDeviceActivity {
  readonly instance: LiveActivity<AgentActivityProps>;
  readonly props: AgentActivityProps;
  readonly lastRemoteTokenRegistrationAttemptAt: number | null;
  readonly remoteTokenRegistered: boolean;
  readonly remoteTokenRetryScheduled: boolean;
  readonly missingSince: number | null;
}

let activeActivity: ActiveDeviceActivity | null = null;
const environmentStates = new Map<EnvironmentId, ReadonlyArray<AgentAwarenessState>>();
let localLiveActivitiesEnabled = true;
const liveActivitySyncSemaphore = Effect.runSync(Semaphore.make(1));

function canUseLocalLiveActivities(): boolean {
  return localLiveActivitiesEnabled && Platform.OS === "ios";
}

function logLiveActivityDebug(context: string, details?: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.log(`[agent-awareness] ${context}`, details ?? "");
}

function logLiveActivityWarning(context: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn(
    `[agent-awareness] ${context}`,
    error instanceof Error ? error.message : String(error),
  );
}

function statusForPhase(phase: AgentAwarenessState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function epochMillis(iso: string): number {
  return Option.match(DateTime.make(iso), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
}

function currentTimeMillis(): number {
  return Date.now();
}

function currentDateTime(): DateTime.Utc {
  return DateTime.nowUnsafe();
}

function toActivityProps(states: ReadonlyArray<AgentAwarenessState>): AgentActivityProps {
  const updatedAt = states.reduce<string | null>((latest, state) => {
    if (latest === null) {
      return state.updatedAt;
    }
    return epochMillis(state.updatedAt) > epochMillis(latest) ? state.updatedAt : latest;
  }, null);

  return {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: states.length,
    updatedAt: updatedAt ?? DateTime.formatIso(currentDateTime()),
    activities: states.slice(0, MAX_LOCAL_LIVE_ACTIVITIES).map((state) => ({
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      modelTitle: state.modelTitle,
      phase: state.phase,
      status: statusForPhase(state.phase),
      updatedAt: state.updatedAt,
      deepLink: state.deepLink,
    })),
  };
}

function hasSameActivityContent(left: AgentActivityProps, right: AgentActivityProps): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortByUpdatedAtDesc(left: AgentAwarenessState, right: AgentAwarenessState): number {
  return epochMillis(right.updatedAt) - epochMillis(left.updatedAt);
}

function projectSnapshotAwareness(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}): ReadonlyArray<AgentAwarenessState> {
  const projectsById = new Map<string, OrchestrationProjectShell>(
    input.snapshot.projects.map((project) => [project.id, project]),
  );
  const states: AgentAwarenessState[] = [];

  for (const thread of input.snapshot.threads) {
    const project = projectsById.get(thread.projectId);
    if (!project) {
      continue;
    }
    const state = projectThreadAwareness({
      environmentId: input.environmentId,
      project,
      thread,
    });
    if (state) {
      states.push(state);
    }
  }

  return states;
}

export function syncAgentLiveActivitiesForSnapshot(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot | null;
}): Effect.Effect<void, unknown> {
  return enqueueLiveActivitySync(
    Effect.gen(function* () {
      if (!canUseLocalLiveActivities()) {
        return;
      }

      if (input.snapshot === null) {
        return yield* endEnvironmentLiveActivitiesNow(input.environmentId);
      }

      const states = projectSnapshotAwareness({
        environmentId: input.environmentId,
        snapshot: input.snapshot,
      });
      environmentStates.set(input.environmentId, states);
      return yield* syncAgentLiveActivities();
    }),
  );
}

export function endEnvironmentLiveActivities(
  environmentId: EnvironmentId,
): Effect.Effect<void, unknown> {
  return enqueueLiveActivitySync(endEnvironmentLiveActivitiesNow(environmentId));
}

function endEnvironmentLiveActivitiesNow(
  environmentId: EnvironmentId,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    environmentStates.delete(environmentId);
    return yield* syncAgentLiveActivities();
  });
}

export function endAllAgentLiveActivities(): Effect.Effect<void, unknown> {
  return enqueueLiveActivitySync(endAllAgentLiveActivitiesNow());
}

function endAllAgentLiveActivitiesNow(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    environmentStates.clear();
    return yield* endActiveActivity(null, "all-ended");
  });
}

function enqueueLiveActivitySync<T, R>(
  operation: Effect.Effect<T, unknown, R>,
): Effect.Effect<T, unknown, R> {
  return liveActivitySyncSemaphore.withPermits(1)(operation);
}

function syncAgentLiveActivities(): Effect.Effect<void, unknown> {
  const states = [...environmentStates.values()].flat().sort(sortByUpdatedAtDesc);
  const activeNonTerminalStates = states.filter(
    (state) => !isTerminalAgentAwarenessPhase(state.phase),
  );
  const terminalState = states.find((state) => isTerminalAgentAwarenessPhase(state.phase)) ?? null;

  if (activeNonTerminalStates.length === 0) {
    if (!activeActivity) {
      return Effect.void;
    }
    if (terminalState) {
      return endActiveActivity(terminalState, "terminal-state");
    }
    const now = currentTimeMillis();
    if (activeActivity.missingSince === null) {
      activeActivity = { ...activeActivity, missingSince: now };
      logLiveActivityDebug("live activity missing state; waiting before ending", {
        graceMs: MISSING_STATE_GRACE_MS,
      });
      return Effect.void;
    }
    if (now - activeActivity.missingSince >= MISSING_STATE_GRACE_MS) {
      return endActiveActivity(null, "missing-state");
    }
    return Effect.void;
  }

  return startOrUpdateActivity(activeNonTerminalStates);
}

function startOrUpdateActivity(
  states: ReadonlyArray<AgentAwarenessState>,
): Effect.Effect<void, unknown> {
  const props = toActivityProps(states);
  const primaryState = states[0];
  if (activeActivity) {
    const active = activeActivity;
    if (!hasSameActivityContent(active.props, props)) {
      logLiveActivityDebug("updating live activity", {
        activeCount: props.activeCount,
        primaryThreadId: primaryState?.threadId ?? null,
      });
      return runLiveActivityOperation(
        "update",
        Effect.tryPromise({
          try: () => active.instance.update(props),
          catch: (error) => error,
        }),
      ).pipe(
        Effect.flatMap((updated) =>
          Effect.sync(() => {
            if (!updated.ok) {
              activeActivity = null;
              return;
            }
            activeActivity = { ...active, props, missingSince: null };
            retryRemoteTokenRegistration(activeActivity.instance);
          }),
        ),
      );
    } else if (activeActivity.missingSince !== null) {
      activeActivity = { ...activeActivity, missingSince: null };
    }
    retryRemoteTokenRegistration(activeActivity.instance);
    return Effect.void;
  }

  return adoptExistingActivity(props, primaryState).pipe(
    Effect.flatMap((adopted) => {
      if (adopted) {
        return Effect.void;
      }

      logLiveActivityDebug("starting live activity", {
        activeCount: props.activeCount,
        primaryThreadId: primaryState?.threadId ?? null,
      });
      return runLiveActivityOperation(
        "start",
        Effect.try({
          try: () => AgentActivity.start(props, Linking.createURL(primaryState?.deepLink ?? "/")),
          catch: (error) => error,
        }),
      ).pipe(
        Effect.flatMap((started) =>
          Effect.sync(() => {
            const instance = started.ok ? started.value : undefined;
            if (instance) {
              logLiveActivityDebug("live activity started", {
                primaryThreadId: primaryState?.threadId ?? null,
                localActivityCount: AgentActivity.getInstances().length,
                rowCount: props.activeCount,
              });
              activeActivity = {
                instance,
                props,
                lastRemoteTokenRegistrationAttemptAt: null,
                remoteTokenRegistered: false,
                remoteTokenRetryScheduled: false,
                missingSince: null,
              };
              retryRemoteTokenRegistration(instance);
            }
          }),
        ),
      );
    }),
  );
}

function adoptExistingActivity(
  props: AgentActivityProps,
  primaryState: AgentAwarenessState | undefined,
): Effect.Effect<boolean, unknown> {
  const existingActivity = AgentActivity.getInstances()[0];
  if (!existingActivity) {
    return Effect.succeed(false);
  }

  logLiveActivityDebug("adopting existing live activity", {
    activeCount: props.activeCount,
    primaryThreadId: primaryState?.threadId ?? null,
  });
  return runLiveActivityOperation(
    "update",
    Effect.tryPromise({
      try: () => existingActivity.update(props),
      catch: (error) => error,
    }),
  ).pipe(
    Effect.flatMap((updated) =>
      Effect.sync(() => {
        if (!updated.ok) {
          return false;
        }

        activeActivity = {
          instance: existingActivity,
          props,
          lastRemoteTokenRegistrationAttemptAt: null,
          remoteTokenRegistered: false,
          remoteTokenRetryScheduled: false,
          missingSince: null,
        };
        retryRemoteTokenRegistration(existingActivity);
        return true;
      }),
    ),
  );
}

function retryRemoteTokenRegistration(activity: LiveActivity<AgentActivityProps>): void {
  if (!activeActivity) {
    return;
  }

  if (activeActivity.remoteTokenRegistered) {
    return;
  }
  const now = currentTimeMillis();
  if (
    activeActivity.lastRemoteTokenRegistrationAttemptAt !== null &&
    now - activeActivity.lastRemoteTokenRegistrationAttemptAt < REMOTE_TOKEN_REGISTRATION_RETRY_MS
  ) {
    return;
  }

  activeActivity = {
    ...activeActivity,
    lastRemoteTokenRegistrationAttemptAt: now,
  };
  void mobileRuntime
    .runPromise(
      registerRemoteActivityToken(activity).pipe(
        Effect.flatMap((registered) =>
          Effect.sync(() => {
            if (!registered) {
              scheduleRemoteTokenRegistrationRetry(activity);
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            logLiveActivityWarning(
              "live activity token registration failed; retry scheduled",
              error,
            );
            scheduleRemoteTokenRegistrationRetry(activity);
          }),
        ),
      ),
    )
    .catch((error: unknown) => {
      logLiveActivityWarning("unexpected live activity token registration failure", error);
    });
}

function registerRemoteActivityToken(
  activity: LiveActivity<AgentActivityProps>,
): Effect.Effect<boolean, unknown, ManagedRelayClient> {
  return registerLiveActivityPushToken({ activity }).pipe(
    Effect.flatMap((registered) =>
      Effect.sync(() => {
        if (registered && activeActivity?.instance === activity) {
          activeActivity = {
            ...activeActivity,
            remoteTokenRegistered: true,
            remoteTokenRetryScheduled: false,
          };
        }
        return registered;
      }),
    ),
  );
}

function scheduleRemoteTokenRegistrationRetry(activity: LiveActivity<AgentActivityProps>): void {
  if (
    !activeActivity ||
    activeActivity.instance !== activity ||
    activeActivity.remoteTokenRegistered ||
    activeActivity.remoteTokenRetryScheduled
  ) {
    return;
  }

  activeActivity = {
    ...activeActivity,
    remoteTokenRetryScheduled: true,
  };

  void mobileRuntime
    .runPromise(
      Effect.sleep(Duration.millis(REMOTE_TOKEN_REGISTRATION_RETRY_MS)).pipe(
        Effect.flatMap(() =>
          enqueueLiveActivitySync(
            Effect.sync(() => {
              if (!activeActivity || activeActivity.instance !== activity) {
                return;
              }
              activeActivity = {
                ...activeActivity,
                remoteTokenRetryScheduled: false,
                lastRemoteTokenRegistrationAttemptAt: null,
              };
              retryRemoteTokenRegistration(activity);
            }),
          ),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            logLiveActivityWarning("live activity token retry failed", error);
          }),
        ),
      ),
    )
    .catch((error: unknown) => {
      logLiveActivityWarning("unexpected live activity token retry failure", error);
    });
}

export function refreshActiveLiveActivityRemoteRegistration(): Effect.Effect<
  void,
  unknown,
  ManagedRelayClient
> {
  return enqueueLiveActivitySync(
    Effect.gen(function* () {
      if (!activeActivity || !canUseLocalLiveActivities()) {
        return;
      }
      const activity = activeActivity.instance;
      activeActivity = {
        ...activeActivity,
        remoteTokenRegistered: false,
        remoteTokenRetryScheduled: false,
        lastRemoteTokenRegistrationAttemptAt: currentTimeMillis(),
      };
      yield* registerRemoteActivityToken(activity).pipe(
        Effect.flatMap((registered) =>
          Effect.sync(() => {
            if (!registered) {
              scheduleRemoteTokenRegistrationRetry(activity);
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            logLiveActivityWarning("live activity token refresh failed; retry scheduled", error);
            scheduleRemoteTokenRegistrationRetry(activity);
          }),
        ),
      );
    }),
  );
}

function endActiveActivity(
  finalState: AgentAwarenessState | null,
  reason: string,
): Effect.Effect<void, unknown> {
  const active = activeActivity;
  if (!active) {
    return Effect.void;
  }

  activeActivity = null;
  logLiveActivityDebug("ending live activity", {
    reason,
    finalPhase: finalState?.phase ?? null,
  });
  if (finalState) {
    const now = currentDateTime();
    return runLiveActivityOperation(
      "end",
      Effect.tryPromise({
        try: () =>
          active.instance.end(
            after(
              DateTime.toDateUtc(DateTime.add(now, { milliseconds: FINAL_ACTIVITY_DISMISSAL_MS })),
            ),
            toActivityProps([finalState]),
            DateTime.toDateUtc(now),
          ),
        catch: (error) => error,
      }),
    ).pipe(Effect.asVoid);
  }

  return runLiveActivityOperation(
    "end",
    Effect.tryPromise({
      try: () => active.instance.end("immediate"),
      catch: (error) => error,
    }),
  ).pipe(Effect.asVoid);
}

type LiveActivityOperationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
    };

function runLiveActivityOperation<T>(
  operationName: "start" | "update" | "end",
  operation: Effect.Effect<T, unknown>,
): Effect.Effect<LiveActivityOperationResult<T>> {
  return operation.pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true, value }) as const,
      onFailure: (error): LiveActivityOperationResult<T> => {
        if (
          (operationName === "end" || operationName === "update") &&
          isMissingNativeLiveActivityError(error)
        ) {
          logLiveActivityWarning(
            `live activity ${operationName} skipped; native activity was already gone`,
            error,
          );
          return { ok: false };
        }

        logLiveActivityWarning(
          "live activity operation failed; disabling local live activities",
          error,
        );
        localLiveActivitiesEnabled = false;
        activeActivity = null;
        environmentStates.clear();
        return { ok: false };
      },
    }),
  );
}

function isMissingNativeLiveActivityError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Can't find live activity with id:");
}

export function __resetAgentLiveActivitiesForTest(): void {
  localLiveActivitiesEnabled = true;
  activeActivity = null;
  environmentStates.clear();
}
