// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off - schedule timestamps are persisted as ISO strings.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { AgentDashboardSecuritySchedule } from "@t3tools/contracts";

import * as AgentDashboardCollectors from "./AgentDashboardCollectors.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";

export const SECURITY_SCHEDULE_ID = "t3-security-collector";
export const SECURITY_INTERVAL_MINUTES = 120;

const POLL_INTERVAL = Duration.seconds(30);
const INTERVAL_MS = SECURITY_INTERVAL_MINUTES * 60_000;

export class AgentDashboardSecuritySchedulerError extends Schema.TaggedError<AgentDashboardSecuritySchedulerError>()(
  "AgentDashboardSecuritySchedulerError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardSecuritySchedulerService {
  readonly getStatus: Effect.Effect<AgentDashboardSecuritySchedule>;
  /** Runs one local security collection immediately when the schedule is free. */
  readonly runNow: Effect.Effect<
    AgentDashboardSecuritySchedule | null,
    AgentDashboardSecuritySchedulerError
  >;
}

export class AgentDashboardSecurityScheduler extends Context.Service<
  AgentDashboardSecurityScheduler,
  AgentDashboardSecuritySchedulerService
>()("t3/agentDashboard/AgentDashboardSecurityScheduler") {}

type JsonObject = Record<string, unknown>;

const isAgentDashboardSecuritySchedulerError = Schema.is(AgentDashboardSecuritySchedulerError);

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

const statusValue = (value: unknown): AgentDashboardSecuritySchedule["lastStatus"] =>
  value === "running" || value === "completed" || value === "failed" ? value : "idle";

const defaultSchedule = (now = Date.now()): AgentDashboardSecuritySchedule => ({
  id: SECURITY_SCHEDULE_ID,
  enabled: true,
  intervalMinutes: SECURITY_INTERVAL_MINUTES,
  // The first local scan is cheap and should establish collector health as
  // soon as T3 starts. Subsequent scans use the normal two-hour cadence.
  nextRunAt: isoAt(now),
  lastRunAt: null,
  lastCompletedAt: null,
  lastStatus: "idle",
  lastError: null,
  lastTarget: null,
  heartbeatAt: isoAt(now),
  runCount: 0,
});

const normalizeSchedule = (value: unknown, now = Date.now()): AgentDashboardSecuritySchedule => {
  const raw = asObject(value);
  if (!raw) return defaultSchedule(now);

  const lastStatus = statusValue(raw.lastStatus);
  const recoveredFromRestart = lastStatus === "running";
  return {
    id: SECURITY_SCHEDULE_ID,
    enabled: raw.enabled !== false,
    intervalMinutes: SECURITY_INTERVAL_MINUTES,
    nextRunAt: recoveredFromRestart ? isoAt(now) : (isoOrNull(raw.nextRunAt) ?? isoAt(now)),
    lastRunAt: isoOrNull(raw.lastRunAt),
    lastCompletedAt: isoOrNull(raw.lastCompletedAt),
    lastStatus: recoveredFromRestart ? "failed" : lastStatus,
    lastError: recoveredFromRestart
      ? "T3 restarted before the local security scan completed."
      : stringValue(raw.lastError),
    lastTarget: stringValue(raw.lastTarget),
    heartbeatAt: isoOrNull(raw.heartbeatAt) ?? isoAt(now),
    runCount:
      typeof raw.runCount === "number" && Number.isFinite(raw.runCount)
        ? Math.max(0, Math.trunc(raw.runCount))
        : 0,
  };
};

const writeAtomic = async (path: string, value: AgentDashboardSecuritySchedule): Promise<void> => {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true });
  // Heartbeats and scan state can persist concurrently. A per-write name
  // prevents one writer from renaming another writer's temporary file.
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await NodeFSP.rename(temporary, path);
};

const readSchedule = async (path: string): Promise<AgentDashboardSecuritySchedule> => {
  try {
    return normalizeSchedule(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  } catch (cause) {
    if (asObject(cause)?.code === "ENOENT") return defaultSchedule();
    // A truncated or hand-edited schedule must not disable security scans.
    return defaultSchedule();
  }
};

/** Read-only status access for dashboard snapshots; the scheduler owns writes. */
export const readPersistedStatus = (
  stateDir: string,
): Effect.Effect<AgentDashboardSecuritySchedule> =>
  Effect.tryPromise({
    try: () => readSchedule(NodePath.join(stateDir, "agent-dashboard", "security-schedule.json")),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => defaultSchedule()));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const dashboardStore = AgentDashboardStore.getStore(config.stateDir);
  const schedulePath = NodePath.join(config.stateDir, "agent-dashboard", "security-schedule.json");
  const stateRef = yield* Ref.make<AgentDashboardSecuritySchedule>(
    yield* Effect.tryPromise({
      try: () => readSchedule(schedulePath),
      catch: (cause) =>
        new AgentDashboardSecuritySchedulerError({
          operation: "read schedule",
          message: "Failed to initialize the T3 security collector schedule.",
          cause,
        }),
    }),
  );

  const persist = (state: AgentDashboardSecuritySchedule) =>
    Effect.tryPromise({
      try: () => writeAtomic(schedulePath, state),
      catch: (cause) =>
        new AgentDashboardSecuritySchedulerError({
          operation: "write schedule",
          message: "Failed to persist the T3 security collector schedule.",
          cause,
        }),
    });

  yield* persist(yield* Ref.get(stateRef));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const collectAndPersist = (
    observedAt: string,
  ): Effect.Effect<
    { readonly findingCount: number; readonly target: string },
    AgentDashboardSecuritySchedulerError
  > =>
    Effect.gen(function* () {
      const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardSecuritySchedulerError({
              operation: "load repositories",
              message: "Failed to load repositories for the scheduled security scan.",
              cause,
            }),
        ),
      );
      const collected = yield* Effect.tryPromise({
        try: () =>
          AgentDashboardCollectors.collectAgentDashboardData({
            stateDir: config.stateDir,
            projects: shellSnapshot.projects,
            kind: "security",
            observedAt,
          }),
        catch: (cause) =>
          new AgentDashboardSecuritySchedulerError({
            operation: "collect security findings",
            message: "The scheduled security collector failed.",
            cause,
          }),
      });
      const findingCount = yield* dashboardStore.appendFindings(collected.findings).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardSecuritySchedulerError({
              operation: "persist security findings",
              message: "Failed to persist scheduled security findings.",
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
                new AgentDashboardSecuritySchedulerError({
                  operation: "persist collector state",
                  message: "Failed to persist scheduled security collector health.",
                  cause,
                }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      return {
        findingCount,
        target:
          collected.states.length > 0
            ? `${collected.states.length} repository security collector(s)`
            : "portfolio",
      };
    });

  const run = (force: boolean): AgentDashboardSecuritySchedulerService["runNow"] =>
    Effect.gen(function* () {
      const startedAtTime = yield* DateTime.now;
      const startedAtMs = DateTime.toEpochMillis(startedAtTime);
      const startedAt = DateTime.formatIso(startedAtTime);
      const claimed = yield* Ref.modify(stateRef, (state) => {
        if (
          !state.enabled ||
          state.lastStatus === "running" ||
          (!force && Date.parse(state.nextRunAt) > startedAtMs)
        ) {
          return [false, state] as const;
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
          },
        ] as const;
      });
      if (!claimed) return null;

      yield* persist(yield* Ref.get(stateRef));
      const result = yield* Effect.exit(collectAndPersist(startedAt));
      if (Exit.isFailure(result)) {
        const cause = Cause.squash(result.cause);
        const failure = isAgentDashboardSecuritySchedulerError(cause)
          ? cause
          : new AgentDashboardSecuritySchedulerError({
              operation: "run security scan",
              message: cause instanceof Error ? cause.message : "Scheduled security scan failed.",
              cause,
            });
        const now = yield* DateTime.now;
        const failedAt = DateTime.formatIso(now);
        const current = yield* Ref.get(stateRef);
        const failed: AgentDashboardSecuritySchedule = {
          ...current,
          lastStatus: "failed",
          lastError: failure.message,
          nextRunAt: isoAt(DateTime.toEpochMillis(now) + INTERVAL_MS),
          heartbeatAt: failedAt,
        };
        yield* Ref.set(stateRef, failed);
        yield* persist(failed).pipe(Effect.ignore);
        return yield* failure;
      }

      const completedAtTime = yield* DateTime.now;
      const completedAt = DateTime.formatIso(completedAtTime);
      const completedAtMs = DateTime.toEpochMillis(completedAtTime);
      const current = yield* Ref.get(stateRef);
      const completed: AgentDashboardSecuritySchedule = {
        ...current,
        lastStatus: "completed",
        lastCompletedAt: completedAt,
        lastError: null,
        lastTarget: result.value.target,
        nextRunAt: isoAt(Math.max(completedAtMs, startedAtMs + INTERVAL_MS)),
        heartbeatAt: completedAt,
      };
      yield* Ref.set(stateRef, completed);
      yield* persist(completed);
      return completed;
    });

  const runNow = run(true);
  const runScheduled = run(false).pipe(Effect.asVoid);

  const touchHeartbeat = Effect.gen(function* () {
    const heartbeatAt = yield* nowIso;
    const current = yield* Ref.get(stateRef);
    const nextState = { ...current, heartbeatAt };
    yield* Ref.set(stateRef, nextState);
    yield* persist(nextState);
  });

  const tick = Effect.gen(function* () {
    yield* touchHeartbeat;
    yield* runScheduled;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("T3 scheduled security collection failed", { cause }).pipe(Effect.asVoid),
    ),
  );
  yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  return {
    getStatus: Ref.get(stateRef),
    runNow,
  } satisfies AgentDashboardSecuritySchedulerService;
});

export const layer = Layer.effect(AgentDashboardSecurityScheduler, make);

export const __testing = {
  defaultSchedule,
  normalizeSchedule,
  intervalMs: INTERVAL_MS,
};
