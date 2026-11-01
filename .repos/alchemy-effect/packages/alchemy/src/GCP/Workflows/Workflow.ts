import * as workflows from "@distilled.cloud/gcp/workflows_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 64;

export type CallLogLevel = workflows.WorkflowCallLogLevelEnum | (string & {});
export type ExecutionHistoryLevel =
  | workflows.WorkflowExecutionHistoryLevelEnum
  | (string & {});

export type WorkflowProps = {
  /**
   * Workflow id (the `{workflow}` segment of
   * `projects/{project}/locations/{location}/workflows/{workflow}`). If
   * omitted, a unique name is generated from the stack, stage, and logical
   * id. Must match `[A-Za-z][A-Za-z0-9_-]{0,62}[A-Za-z0-9]` (1–64
   * characters, start with a letter, end with a letter or number).
   * Immutable — changing it replaces the workflow.
   */
  workflowId?: string;
  /**
   * Workflows location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the workflow. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Workflow YAML/JSON source. Max 128KB. Updating this creates a new
   * revision used by subsequent executions.
   */
  sourceContents: string;
  /**
   * Human-readable description (max 1000 Unicode characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Service account the workflow runs as. Format
   * `projects/{project}/serviceAccounts/{account}` or an email. Defaults
   * to the project's Compute Engine default service account. Updating this
   * creates a new revision.
   */
  serviceAccount?: string;
  /**
   * Platform logging for `call` steps and responses.
   * `LOG_ALL_CALLS`, `LOG_ERRORS_ONLY`, or `LOG_NONE`.
   */
  callLogLevel?: CallLogLevel;
  /**
   * User-defined environment variables for this revision. At most 20
   * entries; each value up to 4KiB. Keys cannot be empty or start with
   * `GOOGLE` or `WORKFLOWS`. Updating this creates a new revision.
   */
  userEnvVars?: Record<string, string>;
  /**
   * Execution history recorded for runs of this workflow.
   * `EXECUTION_HISTORY_BASIC` or `EXECUTION_HISTORY_DETAILED`.
   */
  executionHistoryLevel?: ExecutionHistoryLevel;
  /**
   * Cloud KMS key used to encrypt workflow and execution data, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  cryptoKeyName?: string;
};

export type Workflow = Resource<
  "GCP.Workflows.Workflow",
  WorkflowProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/workflows/{workflow}`. */
    name: string;
    /** Workflow id (last path segment). */
    workflowId: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Project id. */
    project: string;
    /** Workflow YAML/JSON source of the latest revision. */
    sourceContents: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Service account the latest revision runs as. */
    serviceAccount: string | undefined;
    /** Call logging level. */
    callLogLevel: string | undefined;
    /** User environment variables on the latest revision. */
    userEnvVars: Record<string, string>;
    /** Execution history level. */
    executionHistoryLevel: string | undefined;
    /** CMEK key, if any. */
    cryptoKeyName: string | undefined;
    /** CMEK key version currently in use. */
    cryptoKeyVersion: string | undefined;
    /** Latest revision id (`000001-a4d`). */
    revisionId: string | undefined;
    /** RFC3339 timestamp of the latest revision. */
    revisionCreateTime: string | undefined;
    /** Server-reported deployment state (`ACTIVE`, `UNAVAILABLE`). */
    state: string | undefined;
    /** Error details when `state` is `UNAVAILABLE`. */
    stateError: workflows.StateError | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Workflows workflow — YAML or JSON orchestration that
 * Workflows executes as a revisioned program.
 *
 * Changing `workflowId` or `location` replaces the workflow. Updating
 * source, service account, or environment variables creates a new
 * revision; already-running executions keep the old revision.
 *
 * ### Creating a Workflow
 * **Example:** Generated name
 * ```typescript
 * const greet = yield* GCP.Workflows.Workflow("Greet", {
 *   sourceContents: `main:
 *   steps:
 *     - done:
 *         return: hello
 * `,
 * });
 * ```
 *
 * **Example:** Named workflow with labels and env vars
 * ```typescript
 * const greet = yield* GCP.Workflows.Workflow("Greet", {
 *   workflowId: "order-greet",
 *   location: "us-central1",
 *   description: "say hello",
 *   labels: { env: "prod" },
 *   callLogLevel: "LOG_ERRORS_ONLY",
 *   userEnvVars: { greeting: "hello" },
 *   sourceContents: `main:
 *   steps:
 *     - done:
 *         return: hello
 * `,
 * });
 * ```
 *
 * ### Executing a Workflow
 * **Example:** Start an execution
 * ```typescript
 * const createExecution = yield* GCP.Workflows.CreateExecution(greet);
 * const execution = yield* createExecution({
 *   body: { argument: JSON.stringify({ name: "world" }) },
 * });
 * ```
 *
 * @resource
 * @category Workflows
 */
export const Workflow = Resource<Workflow>("GCP.Workflows.Workflow");

export class WorkflowNotResolved extends Data.TaggedError(
  "GCP.Workflows.WorkflowNotResolved",
)<{
  name: string;
}> {}

/** The deployed workflow is in state `UNAVAILABLE` (see `stateError`). */
export class WorkflowUnavailable extends Data.TaggedError(
  "GCP.Workflows.WorkflowUnavailable",
)<{
  name: string;
  message: string;
}> {}

export class WorkflowStillExists extends Data.TaggedError(
  "GCP.Workflows.WorkflowStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined, fallback: string) =>
  lastSegment(location ?? fallback).toLowerCase();

const resourceName = (project: string, location: string, workflowId: string) =>
  `projects/${project}/locations/${location}/workflows/${workflowId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const workflowsAt = parts.lastIndexOf("workflows");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    workflowId:
      workflowsAt >= 0 && parts[workflowsAt + 1]
        ? parts[workflowsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const userMap = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(map);

const toId = (id: string, workflowId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      workflowId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

const mapJson = (map: Record<string, string | undefined> | null | undefined) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(map ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );

const logLevelOf = (value: string | undefined) =>
  !value || value === "CALL_LOG_LEVEL_UNSPECIFIED" ? undefined : value;

const historyLevelOf = (value: string | undefined) =>
  !value || value === "EXECUTION_HISTORY_LEVEL_UNSPECIFIED" ? undefined : value;

const toAttrs = (workflow: workflows.Workflow, project: string) => {
  const name = workflow.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    workflowId: parsed.workflowId,
    location: parsed.location,
    project: parsed.project || project,
    sourceContents: workflow.sourceContents,
    description: workflow.description,
    labels: userLabels(workflow.labels),
    serviceAccount: workflow.serviceAccount,
    callLogLevel: workflow.callLogLevel,
    userEnvVars: userMap(workflow.userEnvVars),
    executionHistoryLevel: workflow.executionHistoryLevel,
    cryptoKeyName: workflow.cryptoKeyName,
    cryptoKeyVersion: workflow.cryptoKeyVersion,
    revisionId: workflow.revisionId,
    revisionCreateTime: workflow.revisionCreateTime,
    state: workflow.state,
    stateError: workflow.stateError,
    createTime: workflow.createTime,
    updateTime: workflow.updateTime,
  };
};

const getByName = (name: string) =>
  workflows
    .getProjectsLocationsWorkflows({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Wait for a workflow operation. ALREADY_EXISTS (code 6) counts as success
 * (create race); with `notFoundOk`, so does NOT_FOUND (code 5, delete race)
 * and an operation that is already gone.
 */
const waitForOperation = (
  operation: workflows.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => workflows.getProjectsLocationsOperations({ name }),
    { budget: "5 minutes", interval: "2 seconds" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (workflow): workflow is workflows.Workflow => workflow !== undefined,
      () => new WorkflowNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (workflow) => workflow.state !== "UNAVAILABLE",
      (workflow) =>
        new WorkflowUnavailable({
          name,
          message: workflow.stateError?.details ?? "workflow is UNAVAILABLE",
        }),
    ),
    Effect.filterOrFail(
      (workflow) => workflow.state === "ACTIVE" || workflow.state === undefined,
      () => new WorkflowNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Workflows.WorkflowNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((workflow) =>
      workflow === undefined
        ? Effect.void
        : Effect.fail(new WorkflowStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Workflows.WorkflowStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const WorkflowProvider = () =>
  Provider.succeed(Workflow, {
    stables: ["name", "workflowId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.workflowId ?? output?.workflowId;
      const nextId = news.workflowId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const locationChanged = previousLocation !== nextLocation;

      if (idChanged || locationChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const workflowId = yield* toId(id, olds?.workflowId, output?.workflowId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, workflowId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* workflows.listProjectsLocationsWorkflows
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.workflows ?? [])),
            Stream.filter((workflow) =>
              Object.keys(workflow.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((workflow) => toAttrs(workflow, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const workflowId = yield* toId(id, news.workflowId, output?.workflowId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, workflowId);
      const parent = parentOf(env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredBody = compact({
        sourceContents: news.sourceContents,
        description: news.description,
        labels: desiredLabels,
        serviceAccount: news.serviceAccount,
        callLogLevel: news.callLogLevel,
        userEnvVars: news.userEnvVars,
        executionHistoryLevel: news.executionHistoryLevel,
        cryptoKeyName: news.cryptoKeyName,
      }) as workflows.Workflow;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* workflows
          .createProjectsLocationsWorkflows({
            parent,
            workflowId,
            body: desiredBody,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new WorkflowNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const sourceChanged =
        (current.sourceContents ?? "") !== news.sourceContents;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const serviceAccountChanged =
        news.serviceAccount !== undefined &&
        lastSegment(current.serviceAccount ?? "") !==
          lastSegment(news.serviceAccount);
      const callLogLevelChanged =
        news.callLogLevel !== undefined &&
        logLevelOf(current.callLogLevel) !== logLevelOf(news.callLogLevel);
      const envVarsChanged =
        news.userEnvVars !== undefined &&
        mapJson(current.userEnvVars) !== mapJson(news.userEnvVars);
      const historyChanged =
        news.executionHistoryLevel !== undefined &&
        historyLevelOf(current.executionHistoryLevel) !==
          historyLevelOf(news.executionHistoryLevel);
      const cryptoKeyChanged =
        news.cryptoKeyName !== undefined &&
        (current.cryptoKeyName ?? "") !== news.cryptoKeyName;

      const updateMask = [
        labelsChanged ? "labels" : undefined,
        sourceChanged ? "sourceContents" : undefined,
        descriptionChanged ? "description" : undefined,
        serviceAccountChanged ? "serviceAccount" : undefined,
        callLogLevelChanged ? "callLogLevel" : undefined,
        envVarsChanged ? "userEnvVars" : undefined,
        historyChanged ? "executionHistoryLevel" : undefined,
        cryptoKeyChanged ? "cryptoKeyName" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const operation = yield* workflows
          .patchProjectsLocationsWorkflows({
            name,
            updateMask: updateMask.join(","),
            body: desiredBody,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation === undefined) {
          const created = yield* workflows
            .createProjectsLocationsWorkflows({
              parent,
              workflowId,
              body: desiredBody,
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
          if (created !== undefined) {
            yield* waitForOperation(created);
          }
        } else {
          yield* waitForOperation(operation);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new WorkflowNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* workflows
        .deleteProjectsLocationsWorkflows({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
