import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  expandNamed,
  hasAlchemyActuationId,
  lastSegment,
  listAtNested,
  listPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  resourceNameFromOperation,
  ResourceNotResolved,
  toActuationId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ActuationOutput = {
  /** Blueprint Controller deployment and revision resource. */
  blueprintId?: string;
  /** Terraform template used. */
  terraformTemplate?: string;
  /** Cloud Storage file that stores build logs. */
  actuateLogs?: string;
  /** Error code when actuation failed. */
  errorCode?: string;
  /** Error message returned from Ansible. */
  ansibleError?: string;
  /** Error message returned from Terraform. */
  terraformError?: string;
  /** Cloud Build instance UUID. */
  cloudbuildId?: string;
  /** Failed Ansible task names. */
  ansibleFailedTask?: string[];
  /** Link to the actuation Cloud Build log. */
  errorLogs?: string;
  /** Whether the error message is user facing. */
  hasUserFacingErrorMsg?: boolean;
};

export type DeploymentOutput = {
  /** Type of the deployed resource. */
  type?: string;
  /** Name of the deployed resource. */
  name?: string;
};

export type DeploymentsActuationProps = {
  /**
   * Parent Deployment. Full name
   * `projects/{project}/locations/{location}/deployments/{deployment}`
   * or the deployment id (combined with `location`). Immutable —
   * changing it replaces the actuation.
   */
  deployment: string;
  /**
   * Region used when `deployment` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Actuation id (the `{actuation}` segment). If omitted, a unique
   * RFC1035 name prefixed `alch-` is generated from the stack, stage,
   * and logical id so `list` / nuke can find it (actuations have no
   * labels or description). Immutable — changing it replaces the
   * actuation. The API has no patch — actuations are existence-only.
   */
  actuationId?: string;
};

export type DeploymentsActuation = Resource<
  "GCP.WorkloadManager.DeploymentsActuation",
  DeploymentsActuationProps,
  {
    /** Full resource name. */
    name: string;
    /** Actuation id (last path segment). */
    actuationId: string;
    /** Parent Deployment name. */
    deployment: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Server-reported actuation state. */
    state: string | undefined;
    /** Actuation output (logs, errors, Cloud Build id). */
    actuationOutput: ActuationOutput | undefined;
    /** Resources produced by the deployment. */
    deploymentOutput: DeploymentOutput[];
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Workload Manager actuation — a bootstrap run of a Deployment that
 * applies Terraform/Ansible and records infrastructure output.
 *
 * Actuations have no labels, description, or patch API. Identity is
 * `deployment` + `location` + `actuationId`; changing any replaces the
 * actuation. Generated ids are prefixed `alch-` so `list` / nuke can
 * find Alchemy-owned rows.
 *
 * ### Creating an Actuation
 * **Example:** Generated name
 * ```typescript
 * const actuation = yield* GCP.WorkloadManager.DeploymentsActuation(
 *   "Bootstrap",
 *   { deployment: existingDeployment.name },
 * );
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const actuation = yield* GCP.WorkloadManager.DeploymentsActuation(
 *   "Bootstrap",
 *   {
 *     deployment: existingDeployment.name,
 *     actuationId: "alch-bootstrap-1",
 *   },
 * );
 * ```
 *
 * @resource
 * @category WorkloadManager
 */
export const DeploymentsActuation = Resource<DeploymentsActuation>(
  "GCP.WorkloadManager.DeploymentsActuation",
);

const resourceName = (deployment: string, actuationId: string) =>
  `${deployment}/actuations/${actuationId}`;

const toOutput = (
  output: workloadmanager.ActuationOutput | undefined,
): ActuationOutput | undefined =>
  output === undefined
    ? undefined
    : {
        blueprintId: output.blueprintId,
        terraformTemplate: output.terraformTemplate,
        actuateLogs: output.actuateLogs,
        errorCode: output.errorCode,
        ansibleError: output.ansibleError,
        terraformError: output.terraformError,
        cloudbuildId: output.cloudbuildId,
        ansibleFailedTask: output.ansibleFailedTask,
        errorLogs: output.errorLogs,
        hasUserFacingErrorMsg: output.hasUserFacingErrorMsg,
      };

const toAttrs = (
  item: workloadmanager.Actuation,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "actuations", region);
  return {
    name,
    actuationId: parsed.id,
    deployment: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    state: item.state,
    actuationOutput: toOutput(item.actuationOutput),
    deploymentOutput: (item.deploymentOutput ?? []).map((entry) => ({
      type: entry.type,
      name: entry.name,
    })),
    startTime: item.startTime,
    endTime: item.endTime,
  };
};

const getByName = (name: string) =>
  workloadmanager
    .getProjectsLocationsDeploymentsActuations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtNested(project, region, "deployments/-", (parent) =>
    listPages(
      workloadmanager.listProjectsLocationsDeploymentsActuations.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.actuations,
      (item) => hasAlchemyActuationId(lastSegment(item.name ?? "")),
    ),
  );

export const DeploymentsActuationProvider = () =>
  Provider.succeed(DeploymentsActuation, {
    stables: [
      "name",
      "actuationId",
      "deployment",
      "project",
      "location",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousParent =
        (olds?.deployment ?? output?.deployment)
          ? expandNamed(
              olds?.deployment ?? output?.deployment ?? "",
              env.project,
              previousLocation,
              "deployments",
            )
          : undefined;
      const nextParent = expandNamed(
        news.deployment,
        env.project,
        nextLocation,
        "deployments",
      );
      return replaceOnIdentity({
        previousId: olds?.actuationId ?? output?.actuationId,
        nextId: news.actuationId ?? olds?.actuationId ?? output?.actuationId,
        previousLocation,
        nextLocation,
        previousParent,
        nextParent,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const actuationId = yield* toActuationId(
        id,
        olds?.actuationId,
        output?.actuationId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const deployment = expandNamed(
        olds?.deployment ?? output?.deployment ?? "",
        env.project,
        location,
        "deployments",
      );
      const name = output?.name ?? resourceName(deployment, actuationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, env.region);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const actuationId = yield* toActuationId(
        id,
        news.actuationId,
        output?.actuationId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const deployment = expandNamed(
        news.deployment,
        env.project,
        location,
        "deployments",
      );
      const name = resourceName(deployment, actuationId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* workloadmanager
          .createProjectsLocationsDeploymentsActuations({
            parent: deployment,
            body: { name },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
          const fromOp = resourceNameFromOperation(created);
          current = yield* waitUntilExists(
            getByName(fromOp ?? name),
            fromOp ?? name,
          );
        } else {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* workloadmanager
        .deleteProjectsLocationsDeploymentsActuations({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
