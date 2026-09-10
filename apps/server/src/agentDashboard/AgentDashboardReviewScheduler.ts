// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardFindingType,
  RepositoryReviewSettings,
  AgentDashboardReviewSchedule,
  AgentDashboardReviewScheduleStatus,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDashboardCollectors from "./AgentDashboardCollectors.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import {
  AgentDashboardReviewJobService,
  type AgentDashboardReviewJobServiceError,
  parseReviewMetadata,
} from "./AgentDashboardReviewJobService.ts";
import type { AgentDashboardReviewRunnerError } from "./AgentDashboardReviewRunner.ts";
import { REVIEW_INTERVAL_MINUTES } from "./AgentDashboardReviewRunner.ts";
const SCHEDULE_ID = "t3-findings-portfolio";
const POLL_INTERVAL = Duration.seconds(30);
const DEFAULT_INTERVAL_MS = REVIEW_INTERVAL_MINUTES * 60_000;
const COVERED_FINDING_TYPES = [
  "bug",
  "security",
  "research",
  "improvement",
  "review",
  "operations",
] as const satisfies ReadonlyArray<AgentDashboardFindingType>;
const LOCAL_COVERED_FINDING_TYPES = [
  "security",
  "research",
  "improvement",
  "operations",
] as const satisfies ReadonlyArray<AgentDashboardFindingType>;

const isCoveredFindingType = (value: unknown): value is AgentDashboardFindingType =>
  typeof value === "string" && COVERED_FINDING_TYPES.some((candidate) => candidate === value);

export class AgentDashboardReviewSchedulerError extends Schema.TaggedError<AgentDashboardReviewSchedulerError>()(
  "AgentDashboardReviewSchedulerError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardReviewSchedulerService {
  readonly getStatus: Effect.Effect<AgentDashboardReviewSchedule>;
  /**
   * Runs local portfolio collectors and enqueues one deep review. Returns the
   * review run, or null when the schedule is disabled / not due / already busy.
   */
  readonly runNow: Effect.Effect<
    AgentDashboardAutomationRun | null,
    | AgentDashboardReviewSchedulerError
    | AgentDashboardReviewJobServiceError
    | AgentDashboardReviewRunnerError
  >;
}

export class AgentDashboardReviewScheduler extends Context.Service<
  AgentDashboardReviewScheduler,
  AgentDashboardReviewSchedulerService
>()("t3/agentDashboard/AgentDashboardReviewScheduler") {}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const stringValue = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isoOrNull = (value: unknown): string | null => {
  const candidate = stringValue(value);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
};

const isoAt = (milliseconds: number): string => new Date(milliseconds).toISOString();

const statusValue = (value: unknown): AgentDashboardReviewScheduleStatus =>
  value === "running" || value === "completed" || value === "failed" ? value : "idle";

const defaultSchedule = (now = Date.now()): AgentDashboardReviewSchedule => ({
  id: SCHEDULE_ID,
  enabled: true,
  intervalMinutes: REVIEW_INTERVAL_MINUTES,
  nextRunAt: isoAt(now),
  lastRunAt: null,
  lastCompletedAt: null,
  lastStatus: "idle",
  lastError: null,
  lastTarget: null,
  heartbeatAt: isoAt(now),
  runCount: 0,
  lastCoveredTypes: [],
  lastSuccessfulTypes: [],
  lastFindingCount: 0,
  lastReviewRunId: null,
  lastUnavailableCollectorCount: 0,
});

const normalizeSchedule = (value: unknown, now = Date.now()): AgentDashboardReviewSchedule => {
  const raw = asObject(value);
  if (!raw) return defaultSchedule(now);

  const nextRunAt = isoOrNull(raw.nextRunAt) ?? isoAt(now);
  const lastStatus = statusValue(raw.lastStatus);
  const recoveredFromRestart = lastStatus === "running";
  const retryFailedOnRestart = lastStatus === "failed";
  return {
    id: SCHEDULE_ID,
    enabled: raw.enabled !== false,
    intervalMinutes: REVIEW_INTERVAL_MINUTES,
    nextRunAt: recoveredFromRestart || retryFailedOnRestart ? isoAt(now) : nextRunAt,
    lastRunAt: isoOrNull(raw.lastRunAt),
    lastCompletedAt: isoOrNull(raw.lastCompletedAt),
    lastStatus: recoveredFromRestart ? "failed" : lastStatus,
    lastError: recoveredFromRestart
      ? "T3 restarted before the findings portfolio cycle completed."
      : stringValue(raw.lastError),
    lastTarget: stringValue(raw.lastTarget),
    heartbeatAt: isoOrNull(raw.heartbeatAt) ?? isoAt(now),
    runCount:
      typeof raw.runCount === "number" && Number.isFinite(raw.runCount)
        ? Math.max(0, Math.trunc(raw.runCount))
        : 0,
    lastCoveredTypes: Array.isArray(raw.lastCoveredTypes)
      ? raw.lastCoveredTypes.filter(isCoveredFindingType)
      : [],
    lastSuccessfulTypes: Array.isArray(raw.lastSuccessfulTypes)
      ? raw.lastSuccessfulTypes.filter(isCoveredFindingType)
      : [],
    lastFindingCount:
      typeof raw.lastFindingCount === "number" && Number.isFinite(raw.lastFindingCount)
        ? Math.max(0, Math.trunc(raw.lastFindingCount))
        : 0,
    lastReviewRunId: stringValue(raw.lastReviewRunId),
    lastUnavailableCollectorCount:
      typeof raw.lastUnavailableCollectorCount === "number" &&
      Number.isFinite(raw.lastUnavailableCollectorCount)
        ? Math.max(0, Math.trunc(raw.lastUnavailableCollectorCount))
        : 0,
  };
};

const writeAtomic = async (path: string, value: AgentDashboardReviewSchedule): Promise<void> => {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await NodeFSP.rename(temporary, path);
};

const readSchedule = async (path: string): Promise<AgentDashboardReviewSchedule> => {
  try {
    return normalizeSchedule(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return defaultSchedule();
    // A truncated or hand-edited schedule must not disable the job forever.
    return defaultSchedule();
  }
};

/** Read-only status access for dashboard snapshots; the scheduler itself owns writes. */
export const readPersistedStatus = (
  stateDir: string,
): Effect.Effect<AgentDashboardReviewSchedule> =>
  Effect.tryPromise({
    try: () => readSchedule(NodePath.join(stateDir, "agent-dashboard", "review-schedule.json")),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => defaultSchedule()));

const scheduleStatusFromRun = (
  run: AgentDashboardAutomationRun,
): AgentDashboardReviewScheduleStatus => {
  switch (run.status) {
    case "queued":
    case "running":
    case "ingesting":
      return "running";
    case "succeeded":
    case "partial":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
  }
};

const scheduleFromRun = (
  current: AgentDashboardReviewSchedule,
  run: AgentDashboardAutomationRun,
  startedAtMs: number,
  startedAt: string,
  intervalMs = DEFAULT_INTERVAL_MS,
): AgentDashboardReviewSchedule => {
  const status = scheduleStatusFromRun(run);
  const completed =
    run.status === "succeeded" ||
    run.status === "partial" ||
    run.status === "failed" ||
    run.status === "cancelled";
  const completedAtMs = completed ? Date.parse(run.completedAt ?? run.updatedAt) : Number.NaN;
  return {
    ...current,
    lastStatus: status,
    lastRunAt: current.lastRunAt ?? startedAt,
    lastCompletedAt: completed ? (run.completedAt ?? run.updatedAt) : current.lastCompletedAt,
    lastError: completed ? run.error : current.lastError,
    lastTarget: run.target ?? current.lastTarget,
    nextRunAt: completed
      ? isoAt(
          Math.max(
            Number.isFinite(completedAtMs) ? completedAtMs : startedAtMs,
            startedAtMs + intervalMs,
          ),
        )
      : current.nextRunAt,
    heartbeatAt: run.updatedAt,
    runCount: current.runCount,
    lastCoveredTypes: completed ? [...COVERED_FINDING_TYPES] : current.lastCoveredTypes,
    lastSuccessfulTypes:
      run.status === "succeeded" ? [...COVERED_FINDING_TYPES] : current.lastSuccessfulTypes,
    lastFindingCount:
      completed && current.lastReviewRunId !== run.id
        ? current.lastFindingCount + run.findingCount
        : current.lastFindingCount,
    lastReviewRunId: completed ? run.id : current.lastReviewRunId,
  };
};

const syncScheduleSettings = (
  current: AgentDashboardReviewSchedule,
  automationSettings: RepositoryReviewSettings,
  nowMs: number,
): AgentDashboardReviewSchedule => {
  const enabledNow = !current.enabled && automationSettings.enabled;
  const cadenceChanged = current.intervalMinutes !== automationSettings.intervalMinutes;
  const currentNextRunMs = Date.parse(current.nextRunAt);
  const nextRunAt = enabledNow
    ? isoAt(nowMs)
    : cadenceChanged && automationSettings.enabled
      ? isoAt(
          Number.isFinite(currentNextRunMs) && currentNextRunMs <= nowMs
            ? nowMs
            : nowMs + automationSettings.intervalMinutes * 60_000,
        )
      : current.nextRunAt;
  return {
    ...current,
    enabled: automationSettings.enabled,
    intervalMinutes: automationSettings.intervalMinutes,
    nextRunAt,
    heartbeatAt: isoAt(nowMs),
  };
};

const modifyPersistedSchedule = <A, E, R>(
  stateRef: SynchronizedRef.SynchronizedRef<AgentDashboardReviewSchedule>,
  persist: (state: AgentDashboardReviewSchedule) => Effect.Effect<void, E, R>,
  transition: (
    state: AgentDashboardReviewSchedule,
  ) => readonly [result: A, state: AgentDashboardReviewSchedule],
): Effect.Effect<A, E, R> =>
  SynchronizedRef.modifyEffect(stateRef, (current) => {
    const [result, next] = transition(current);
    return persist(next).pipe(Effect.as([result, next] as const));
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const jobService = yield* AgentDashboardReviewJobService;
  const dashboardStore = AgentDashboardStore.getStore(config.stateDir);
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const schedulerScope = yield* Effect.scope;
  const schedulePath = NodePath.join(config.stateDir, "agent-dashboard", "review-schedule.json");
  const stateRef = yield* SynchronizedRef.make<AgentDashboardReviewSchedule>(
    yield* Effect.tryPromise({
      try: () => readSchedule(schedulePath),
      catch: (cause) =>
        new AgentDashboardReviewSchedulerError({
          operation: "read schedule",
          message: "Failed to initialize the T3 findings portfolio schedule.",
          cause,
        }),
    }),
  );

  const persist = (state: AgentDashboardReviewSchedule) =>
    Effect.tryPromise({
      try: () => writeAtomic(schedulePath, state),
      catch: (cause) =>
        new AgentDashboardReviewSchedulerError({
          operation: "write schedule",
          message: "Failed to persist the T3 findings portfolio schedule.",
          cause,
        }),
    });

  const initial = yield* SynchronizedRef.get(stateRef);
  yield* persist(initial);

  const collectPortfolio = (observedAt: string) =>
    Effect.gen(function* () {
      const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardReviewSchedulerError({
              operation: "load portfolio repositories",
              message: "Failed to load repositories for the findings portfolio cycle.",
              cause,
            }),
        ),
      );
      const collected = yield* Effect.tryPromise({
        try: () =>
          AgentDashboardCollectors.collectAgentDashboardData({
            stateDir: config.stateDir,
            projects: shellSnapshot.projects,
            kind: "all",
            observedAt,
          }),
        catch: (cause) =>
          new AgentDashboardReviewSchedulerError({
            operation: "collect portfolio findings",
            message: "The scheduled findings portfolio collectors failed.",
            cause,
          }),
      });
      const findingCount = yield* dashboardStore.appendFindings(collected.findings).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardReviewSchedulerError({
              operation: "persist portfolio findings",
              message: "Failed to persist scheduled portfolio findings.",
              cause,
            }),
        ),
      );
      yield* Effect.forEach(
        collected.states,
        (state) =>
          dashboardStore.writeCollectorState(state).pipe(
            Effect.mapError(
              (cause) =>
                new AgentDashboardReviewSchedulerError({
                  operation: "persist portfolio collector state",
                  message: "Failed to persist scheduled collector health.",
                  cause,
                }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      return {
        findingCount,
        successfulTypes: [
          ...(collected.states.some(
            (state) => state.kind === "security" && state.status === "available",
          )
            ? (["security"] as const)
            : []),
          ...(collected.states.some(
            (state) => state.kind === "research" && state.status === "available",
          )
            ? (["research"] as const)
            : []),
        ] satisfies ReadonlyArray<AgentDashboardFindingType>,
        unavailableCollectorCount: collected.states.filter(
          (state) => state.status === "unavailable",
        ).length,
      };
    });

  const run = (force: boolean): AgentDashboardReviewSchedulerService["runNow"] =>
    Effect.gen(function* () {
      const automationSettings = yield* settings.getSettings.pipe(
        Effect.map((current) => current.repositoryReview),
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.repositoryReview),
      );
      const intervalMs = automationSettings.intervalMinutes * 60_000;
      const startedAtTime = yield* DateTime.now;
      const startedAtMs = DateTime.toEpochMillis(startedAtTime);
      const startedAt = DateTime.formatIso(startedAtTime);
      const claimed = yield* modifyPersistedSchedule(stateRef, persist, (state) => {
        if (
          !automationSettings.enabled ||
          state.lastStatus === "running" ||
          (!force && Date.parse(state.nextRunAt) > startedAtMs)
        ) {
          return [
            false,
            {
              ...state,
              enabled: automationSettings.enabled,
              intervalMinutes: automationSettings.intervalMinutes,
            },
          ] as const;
        }
        return [
          true,
          {
            ...state,
            lastStatus: "running" as const,
            lastRunAt: startedAt,
            lastError: null,
            heartbeatAt: startedAt,
            runCount: state.runCount + 1,
            enabled: true,
            intervalMinutes: automationSettings.intervalMinutes,
          },
        ] as const;
      });
      if (!claimed) return null;

      yield* collectPortfolio(startedAt).pipe(
        Effect.tap((result) =>
          modifyPersistedSchedule(stateRef, persist, (current) => [
            undefined,
            {
              ...current,
              lastCoveredTypes: [...LOCAL_COVERED_FINDING_TYPES],
              lastSuccessfulTypes: [...result.successfulTypes],
              lastFindingCount: result.findingCount,
              lastUnavailableCollectorCount: result.unavailableCollectorCount,
              heartbeatAt: startedAt,
            },
          ]),
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const nowIso = DateTime.formatIso(now);
            yield* modifyPersistedSchedule(stateRef, persist, (current) => [
              undefined,
              {
                ...current,
                lastStatus: "failed",
                lastError: cause.message,
                nextRunAt: isoAt(DateTime.toEpochMillis(now) + intervalMs),
                heartbeatAt: nowIso,
              },
            ]);
            return yield* cause;
          }),
        ),
      );

      const run = yield* jobService
        .enqueueReview({
          trigger: force ? "manual" : "scheduled",
          // Shared key so schedule ticks and manual force do not pile up.
          idempotencyKey: force ? "manual:repository-review" : "scheduled:repository-review",
        })
        .pipe(
          Effect.tap((enqueued) =>
            modifyPersistedSchedule(stateRef, persist, (current) => [
              undefined,
              scheduleFromRun(current, enqueued, startedAtMs, startedAt, intervalMs),
            ]),
          ),
          Effect.tap((enqueued) =>
            // Follow the job until terminal so schedule lastStatus is truthful.
            Effect.gen(function* () {
              for (;;) {
                const runs = yield* jobService.listRuns.pipe(Effect.orElseSucceed(() => []));
                const current = runs.find((item) => item.id === enqueued.id);
                if (!current) return;
                yield* modifyPersistedSchedule(stateRef, persist, (schedule) => [
                  undefined,
                  scheduleFromRun(schedule, current, startedAtMs, startedAt, intervalMs),
                ]);
                if (
                  current.status === "succeeded" ||
                  current.status === "partial" ||
                  current.status === "failed" ||
                  current.status === "cancelled"
                ) {
                  return;
                }
                yield* Effect.sleep(Duration.seconds(1));
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("T3 schedule follow-up for review job failed", {
                  runId: enqueued.id,
                  cause,
                }),
              ),
              Effect.forkIn(schedulerScope),
            ),
          ),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const nowIso = DateTime.formatIso(now);
              yield* modifyPersistedSchedule(stateRef, persist, (current) => [
                undefined,
                {
                  ...current,
                  lastStatus: "failed",
                  lastError:
                    "message" in cause ? String(cause.message) : "Findings portfolio cycle failed.",
                  nextRunAt: isoAt(DateTime.toEpochMillis(now) + intervalMs),
                  heartbeatAt: nowIso,
                },
              ]);
              return yield* cause;
            }),
          ),
        );

      return run;
    });

  const runNow = run(true);
  const runScheduled = run(false).pipe(Effect.asVoid);

  const touchHeartbeat = Effect.gen(function* () {
    const automationSettings = yield* settings.getSettings.pipe(
      Effect.map((current) => current.repositoryReview),
      Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.repositoryReview),
    );
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    yield* modifyPersistedSchedule(stateRef, persist, (current) => [
      undefined,
      syncScheduleSettings(current, automationSettings, nowMs),
    ]);
  });

  const tick = Effect.gen(function* () {
    yield* touchHeartbeat;
    yield* runScheduled;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("T3 scheduled findings portfolio cycle failed", { cause }).pipe(
        Effect.asVoid,
      ),
    ),
  );
  yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  return {
    getStatus: SynchronizedRef.get(stateRef),
    runNow,
  } satisfies AgentDashboardReviewSchedulerService;
});

export const layer = Layer.effect(AgentDashboardReviewScheduler, make);

export const __testing = {
  defaultSchedule,
  normalizeSchedule,
  parseReviewMetadata: (text: string) => {
    const parsed = parseReviewMetadata(text);
    if (parsed.kind === "parsed") return parsed.findings;
    if (parsed.kind === "missing") return null;
    return [];
  },
  scheduleStatusFromRun,
  scheduleFromRun,
  syncScheduleSettings,
  modifyPersistedSchedule,
  intervalMs: DEFAULT_INTERVAL_MS,
};
