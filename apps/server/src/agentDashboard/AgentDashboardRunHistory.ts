// @effect-diagnostics nodeBuiltinImport:off - durable run history is a local JSON document at the Node filesystem boundary.
// @effect-diagnostics globalDate:off - run records persist ISO timestamps.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AgentDashboardAutomationRun,
  AgentDashboardAutomationRunStatus,
  AgentDashboardAutomationRunTrigger,
} from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";

const MAX_RUNS = 2_000;
const HISTORY_FILENAME = "automation-runs.json";

export class AgentDashboardRunHistoryError extends Schema.TaggedError<AgentDashboardRunHistoryError>()(
  "AgentDashboardRunHistoryError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardRunHistoryService {
  readonly list: Effect.Effect<
    ReadonlyArray<AgentDashboardAutomationRun>,
    AgentDashboardRunHistoryError
  >;
  readonly get: (
    id: string,
  ) => Effect.Effect<AgentDashboardAutomationRun | null, AgentDashboardRunHistoryError>;
  readonly upsert: (
    run: AgentDashboardAutomationRun,
  ) => Effect.Effect<AgentDashboardAutomationRun, AgentDashboardRunHistoryError>;
  readonly replaceAll: (
    runs: ReadonlyArray<AgentDashboardAutomationRun>,
  ) => Effect.Effect<ReadonlyArray<AgentDashboardAutomationRun>, AgentDashboardRunHistoryError>;
}

export class AgentDashboardRunHistory extends Context.Service<
  AgentDashboardRunHistory,
  AgentDashboardRunHistoryService
>()("t3/agentDashboard/AgentDashboardRunHistory") {}

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

const nonNegativeInt = (value: unknown, fallback = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
};

const STATUS_VALUES = new Set<AgentDashboardAutomationRunStatus>([
  "queued",
  "running",
  "ingesting",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

const TRIGGER_VALUES = new Set<AgentDashboardAutomationRunTrigger>([
  "manual",
  "scheduled",
  "retry",
]);

const isActiveStatus = (status: AgentDashboardAutomationRunStatus): boolean =>
  status === "queued" || status === "running" || status === "ingesting";

export const recoverInterruptedRuns = (
  runs: ReadonlyArray<AgentDashboardAutomationRun>,
  nowIso: string,
  error = "T3 restarted before the automation run completed.",
  shouldRecover: (run: AgentDashboardAutomationRun) => boolean = () => true,
): ReadonlyArray<AgentDashboardAutomationRun> =>
  runs.map((run) =>
    shouldRecover(run) && isActiveStatus(run.status)
      ? {
          ...run,
          status: "failed" as const,
          error,
          updatedAt: nowIso,
          completedAt: nowIso,
        }
      : run,
  );

const normalizeRun = (value: unknown): AgentDashboardAutomationRun | null => {
  const raw = asObject(value);
  if (!raw) return null;
  const id = stringValue(raw.id);
  const status = stringValue(raw.status);
  const trigger = stringValue(raw.trigger);
  const kind = stringValue(raw.kind) ?? "repository-review";
  const repository = asObject(raw.repository);
  const projectId = stringValue(repository?.projectId);
  const createdAt = isoOrNull(raw.createdAt);
  const updatedAt = isoOrNull(raw.updatedAt);
  if (
    !id ||
    !status ||
    !STATUS_VALUES.has(status as AgentDashboardAutomationRunStatus) ||
    !trigger ||
    !TRIGGER_VALUES.has(trigger as AgentDashboardAutomationRunTrigger) ||
    !projectId ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }

  const threadId = stringValue(raw.threadId);

  return {
    id,
    status: status as AgentDashboardAutomationRunStatus,
    trigger: trigger as AgentDashboardAutomationRunTrigger,
    kind,
    repository: { projectId: ProjectId.make(projectId) },
    target: stringValue(raw.target),
    threadId: threadId === null ? null : ThreadId.make(threadId),
    jobId: stringValue(raw.jobId),
    model: stringValue(raw.model),
    retryCount: nonNegativeInt(raw.retryCount),
    findingCount: nonNegativeInt(raw.findingCount),
    costUnits:
      raw.costUnits === null || raw.costUnits === undefined
        ? null
        : nonNegativeInt(raw.costUnits, 0),
    error: stringValue(raw.error),
    createdAt,
    startedAt: isoOrNull(raw.startedAt),
    updatedAt,
    completedAt: isoOrNull(raw.completedAt),
  };
};

const historyPathFor = (stateDir: string): string =>
  NodePath.join(stateDir, "agent-dashboard", HISTORY_FILENAME);

const writeAtomic = async (
  path: string,
  runs: ReadonlyArray<AgentDashboardAutomationRun>,
): Promise<void> => {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const payload = {
    runs: runs.slice(0, MAX_RUNS),
    updated_at: new Date().toISOString(),
  };
  await NodeFSP.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await NodeFSP.rename(temporary, path);
};

const readRuns = async (path: string): Promise<Array<AgentDashboardAutomationRun>> => {
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
    const root = asObject(parsed);
    const rawRuns = Array.isArray(parsed) ? parsed : Array.isArray(root?.runs) ? root.runs : null;
    if (rawRuns === null) {
      throw new TypeError("Automation run history does not contain a runs array.");
    }
    const normalized = rawRuns.map(normalizeRun);
    if (normalized.some((run) => run === null)) {
      throw new TypeError("Automation run history contains an invalid run record.");
    }
    return normalized.slice(0, MAX_RUNS) as Array<AgentDashboardAutomationRun>;
  } catch (cause) {
    const code = asObject(cause)?.code;
    if (code === "ENOENT") return [];
    throw cause;
  }
};

/** Read-only access for dashboard snapshots; the job service owns writes. */
export const readPersistedRuns = (
  stateDir: string,
): Effect.Effect<ReadonlyArray<AgentDashboardAutomationRun>> =>
  Effect.tryPromise({
    try: () => readRuns(historyPathFor(stateDir)),
    catch: (cause) =>
      new AgentDashboardRunHistoryError({
        operation: "read runs",
        message: "Failed to read Agent Dashboard automation run history.",
        cause,
      }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("T3 could not read automation run history", { cause }).pipe(
        Effect.as([] as ReadonlyArray<AgentDashboardAutomationRun>),
      ),
    ),
  );

const makeForStateDir = (stateDir: string): Effect.Effect<AgentDashboardRunHistoryService> =>
  Effect.sync(() => {
    const path = historyPathFor(stateDir);
    let mutation: Promise<unknown> = Promise.resolve();

    const withMutation = <A>(task: () => Promise<A>): Promise<A> => {
      const next = mutation.then(task, task);
      mutation = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const list = Effect.tryPromise({
      try: () => readRuns(path),
      catch: (cause) =>
        new AgentDashboardRunHistoryError({
          operation: "list runs",
          message: "Failed to read Agent Dashboard automation run history.",
          cause,
        }),
    });

    const get = (id: string) =>
      list.pipe(Effect.map((runs) => runs.find((run) => run.id === id) ?? null));

    const upsert = (run: AgentDashboardAutomationRun) =>
      Effect.tryPromise({
        try: () =>
          withMutation(async () => {
            const existing = await readRuns(path);
            const without = existing.filter((item) => item.id !== run.id);
            const next = [run, ...without].slice(0, MAX_RUNS);
            await writeAtomic(path, next);
            return run;
          }),
        catch: (cause) =>
          new AgentDashboardRunHistoryError({
            operation: "upsert run",
            message: "Failed to persist an Agent Dashboard automation run.",
            cause,
          }),
      });

    const replaceAll = (runs: ReadonlyArray<AgentDashboardAutomationRun>) =>
      Effect.tryPromise({
        try: () =>
          withMutation(async () => {
            const next = runs.slice(0, MAX_RUNS);
            await writeAtomic(path, next);
            return next;
          }),
        catch: (cause) =>
          new AgentDashboardRunHistoryError({
            operation: "replace runs",
            message: "Failed to replace Agent Dashboard automation run history.",
            cause,
          }),
      });

    return { list, get, upsert, replaceAll } satisfies AgentDashboardRunHistoryService;
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* makeForStateDir(config.stateDir);
});

export const layer = Layer.effect(AgentDashboardRunHistory, make);

export const layerForStateDir = (stateDir: string) =>
  Layer.effect(AgentDashboardRunHistory, makeForStateDir(stateDir));

export const __testing = {
  normalizeRun,
  recoverInterruptedRuns,
  isActiveStatus,
  maxRuns: MAX_RUNS,
  historyFilename: HISTORY_FILENAME,
};
