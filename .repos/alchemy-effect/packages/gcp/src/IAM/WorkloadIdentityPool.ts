import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";
import { encodeOwnedDescription, hasOwnedDescription, parseOwnedDescription } from "./internal.ts";

const POOL_ID_MAX = 32;

export type WorkloadIdentityPoolProps = {
  /** Project that owns the pool. Defaults to the current GCP project. */
  project?: string;
  /**
   * Pool id: 4-32 lowercase letters, digits, or hyphens (the `gcp-` prefix is
   * reserved). If omitted, a unique id is generated. Changing it replaces the
   * pool. Deleted pools keep their id for 30 days; redeploying the same id in
   * that window restores the pool instead of creating a new one.
   */
  workloadIdentityPoolId?: string;
  /** Display name (maximum 32 characters). */
  displayName?: string;
  /**
   * Description. Pools have no labels, so Alchemy stamps ownership into a
   * `[alchemy …]` prefix and strips it from the `description` attribute. The
   * marker and this text share the API's 256-character limit; overflow is
   * truncated.
   */
  description?: string;
  /**
   * Disable the pool. Tokens cannot be exchanged while it is disabled, and
   * existing tokens grant access again once it is re-enabled.
   * @default false
   */
  disabled?: boolean;
};

export type WorkloadIdentityPool = Resource<
  "GCP.IAM.WorkloadIdentityPool",
  WorkloadIdentityPoolProps,
  {
    /**
     * Full resource name as GCP returns it, with the project number:
     * `projects/{projectNumber}/locations/global/workloadIdentityPools/{id}`.
     * Prefix it with `principalSet://iam.googleapis.com/` to grant roles to
     * federated identities.
     */
    name: string;
    /** Project that owns the pool. */
    project: string;
    /** Pool id. */
    workloadIdentityPoolId: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether the pool is disabled. */
    disabled: boolean;
    /** Pool state (`ACTIVE` or `DELETED`). */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud IAM workload identity pool: a trust boundary that lets
 * external identities (GitHub Actions, AWS, any OIDC or SAML issuer) exchange
 * their tokens for short-lived Google credentials without service-account keys.
 *
 * Add an issuer with `GCP.IAM.WorkloadIdentityProvider`, then let the
 * federated principals impersonate a service account with `GCP.IAM.Member`
 * (`roles/iam.workloadIdentityUser`).
 *
 * ### Creating a Pool
 * **Example:** Pool for GitHub Actions
 * ```typescript
 * const pool = yield* GCP.IAM.WorkloadIdentityPool("GitHub", {
 *   workloadIdentityPoolId: "github-actions",
 *   displayName: "GitHub Actions",
 * });
 * ```
 *
 * ### Impersonating a Service Account
 * **Example:** Let one repository deploy as a service account
 * ```typescript
 * const deployer = yield* GCP.IAM.ServiceAccount("Deployer", {});
 * yield* GCP.IAM.Member("GitHubDeployer", {
 *   kind: "iam.serviceAccount",
 *   name: deployer.name,
 *   role: "roles/iam.workloadIdentityUser",
 *   member: Output.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.repository/my-org/my-repo`,
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export const WorkloadIdentityPool = Resource<WorkloadIdentityPool>("GCP.IAM.WorkloadIdentityPool");

export class WorkloadIdentityPoolNotResolved extends Data.TaggedError(
  "GCP.IAM.WorkloadIdentityPoolNotResolved",
)<{ resourceName: string }> {}

const poolName = (project: string, poolId: string) =>
  `projects/${project}/locations/global/workloadIdentityPools/${poolId}`;

const lastSegment = (name: string) => name.split("/").pop() ?? name;

const toAttrs = (
  pool: iam.WorkloadIdentityPool,
  project: string,
  poolId: string,
): WorkloadIdentityPool["Attributes"] => ({
  // GCP returns the name with the project number, which `principalSet://`
  // members require.
  name: pool.name ?? poolName(project, poolId),
  project,
  workloadIdentityPoolId: poolId,
  displayName: pool.displayName || undefined,
  description: parseOwnedDescription(pool.description).description,
  disabled: pool.disabled === true,
  state: pool.state,
});

const getPool = (name: string) =>
  iam
    .getProjectsLocationsWorkloadIdentityPools({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitForPoolOperation = (operation: iam.Operation) =>
  waitForOperation(operation, (name) =>
    iam.getProjectsLocationsWorkloadIdentityPoolsOperations({ name }),
  );

const toPoolId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      prefix: `alchemy-${id}-`,
      maxLength: POOL_ID_MAX,
      lowercase: true,
      forbiddenPrefixes: ["gcp-"],
    });
  });

export const WorkloadIdentityPoolProvider = () =>
  Provider.succeed(WorkloadIdentityPool, {
    stables: ["name", "project", "workloadIdentityPoolId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = olds?.project ?? output?.project ?? env.project;
      const previousPoolId = olds?.workloadIdentityPoolId ?? output?.workloadIdentityPoolId;
      if (
        (news.project !== undefined && news.project !== previousProject) ||
        (news.workloadIdentityPoolId !== undefined &&
          news.workloadIdentityPoolId !== previousPoolId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const poolId = yield* toPoolId(
        id,
        olds?.workloadIdentityPoolId,
        output?.workloadIdentityPoolId,
      );
      const existing = yield* getPool(poolName(project, poolId));
      // A deleted pool is recoverable for 30 days but is not a live resource.
      if (existing === undefined || existing.state === "DELETED") return undefined;
      const attrs = toAttrs(existing, project, poolId);
      const { labels } = parseOwnedDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* iam.listProjectsLocationsWorkloadIdentityPools
          .pages({
            parent: `projects/${env.project}/locations/global`,
            pageSize: 100,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.workloadIdentityPools ?? [])),
            Stream.filter(
              (pool) => pool.state !== "DELETED" && hasOwnedDescription(pool.description),
            ),
            Stream.map((pool) => toAttrs(pool, env.project, lastSegment(pool.name ?? ""))),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as WorkloadIdentityPool["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? output?.project ?? env.project;
      const poolId = yield* toPoolId(
        id,
        news.workloadIdentityPoolId,
        output?.workloadIdentityPoolId,
      );
      const name = poolName(project, poolId);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnedDescription(internal, news.description);
      const desiredDisabled = news.disabled === true;

      // Observe
      let current = yield* getPool(name);

      // Ensure — the id stays reserved for 30 days after delete, so a
      // soft-deleted pool is restored rather than re-created.
      if (current === undefined) {
        const operation = yield* iam.createProjectsLocationsWorkloadIdentityPools({
          parent: `projects/${project}/locations/global`,
          workloadIdentityPoolId: poolId,
          body: {
            displayName: news.displayName,
            description: desiredDescription,
            disabled: desiredDisabled,
          },
        });
        yield* waitForPoolOperation(operation);
      } else if (current.state === "DELETED") {
        const operation = yield* iam.undeleteProjectsLocationsWorkloadIdentityPools({
          name,
          body: {},
        });
        yield* waitForPoolOperation(operation);
      }
      current = yield* getPool(name).pipe(
        Effect.flatMap((pool) =>
          pool === undefined || pool.state !== "ACTIVE"
            ? Effect.fail(new WorkloadIdentityPoolNotResolved({ resourceName: name }))
            : Effect.succeed(pool),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.IAM.WorkloadIdentityPoolNotResolved",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

      // Sync display name, description, and disabled against observed state.
      const updateMask = [
        (current.displayName ?? "") !== (news.displayName ?? "") ? "displayName" : undefined,
        (current.description ?? "") !== desiredDescription ? "description" : undefined,
        (current.disabled === true) !== desiredDisabled ? "disabled" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (updateMask.length > 0) {
        const operation = yield* iam.patchProjectsLocationsWorkloadIdentityPools({
          name,
          updateMask: updateMask.join(","),
          body: {
            displayName: news.displayName ?? "",
            description: desiredDescription,
            disabled: desiredDisabled,
          },
        });
        yield* waitForPoolOperation(operation);
        current = {
          ...current,
          displayName: news.displayName,
          description: desiredDescription,
          disabled: desiredDisabled,
        };
      }
      return toAttrs(current, project, poolId);
    }),

    // Soft delete: the pool is recoverable (and its id reserved) for 30 days.
    delete: Effect.fn(function* ({ output }) {
      // Reads lag behind create, so a NotFound here is not proof the
      // resource is gone; only an observed DELETED state skips the call.
      const current = yield* getPool(output.name);
      if (current?.state === "DELETED") return;
      const operation = yield* iam
        .deleteProjectsLocationsWorkloadIdentityPools({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) yield* waitForPoolOperation(operation);
    }),
  });
