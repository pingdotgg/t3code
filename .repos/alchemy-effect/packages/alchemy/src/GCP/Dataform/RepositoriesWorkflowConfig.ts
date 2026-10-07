import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  expandRepository,
  forEachOwnedRepository,
  hasAlchemyLabelMap,
  listWorkflowConfigs,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type InvocationTarget = {
  /** Action name within `database` and `schema`. */
  name?: string;
  /** Database (Google Cloud project id). */
  database?: string;
  /** Schema (BigQuery dataset id). */
  schema?: string;
};

export type InvocationConfig = {
  /** Include transitive dependents of included actions. */
  transitiveDependentsIncluded?: boolean;
  /** Service account used to run the invocation. */
  serviceAccount?: string;
  /**
   * Action tags to include. Alchemy ownership tags (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in because workflow
   * configs have no labels field.
   */
  includedTags?: string[];
  /** Fully refresh incremental tables. */
  fullyRefreshIncrementalTablesEnabled?: boolean;
  /** BigQuery query priority (`INTERACTIVE` or `BATCH`). */
  queryPriority?: dataform.InvocationConfigQueryPriorityEnum | (string & {});
  /** Include transitive dependencies of included actions. */
  transitiveDependenciesIncluded?: boolean;
  /** Action identifiers to include. */
  includedTargets?: InvocationTarget[];
};

export type RepositoriesWorkflowConfigProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the workflow config.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Workflow config id. If omitted, a unique RFC1035 name is generated.
   * Immutable — changing it replaces the workflow config.
   */
  workflowConfigId?: string;
  /**
   * Release config whose `releaseCompilationResult` is executed. Full
   * name `.../repositories/{repository}/releaseConfigs/{releaseConfig}`
   * or the release config id.
   */
  releaseConfig: string;
  /**
   * Cron schedule for automatic workflow invocations.
   */
  cronSchedule?: string;
  /**
   * IANA time zone used when interpreting `cronSchedule`.
   * @default "UTC"
   */
  timeZone?: string;
  /**
   * Disable automatic workflow invocations.
   * @default false
   */
  disabled?: boolean;
  /**
   * Invocation options.
   */
  invocationConfig?: InvocationConfig;
};

export type RepositoriesWorkflowConfig = Resource<
  "GCP.Dataform.RepositoriesWorkflowConfig",
  RepositoriesWorkflowConfigProps,
  {
    /** Full resource name `.../repositories/{repository}/workflowConfigs/{workflowConfig}`. */
    name: string;
    /** Workflow config id (last path segment). */
    workflowConfigId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Release config resource name. */
    releaseConfig: string | undefined;
    /** Cron schedule, if set. */
    cronSchedule: string | undefined;
    /** Time zone. */
    timeZone: string | undefined;
    /** Whether automatic invocations are disabled. */
    disabled: boolean;
    /** User invocation tags (Alchemy ownership tags stripped). */
    includedTags: string[] | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataform workflow configuration — executes a release config's
 * compilation result on a schedule (or on demand).
 *
 * Workflow configs have no labels field, so ownership is the parent
 * repository's Alchemy labels. Changing `workflowConfigId`,
 * `repository`, or `location` replaces the config. Release config,
 * schedule, disabled flag, and invocation options update in place.
 *
 * ### Creating a Workflow Config
 * **Example:** Run a release
 * ```typescript
 * const workflow = yield* GCP.Dataform.RepositoriesWorkflowConfig("Hourly", {
 *   repository: repo.name,
 *   releaseConfig: release.name,
 * });
 * ```
 *
 * **Example:** Disabled schedule
 * ```typescript
 * const workflow = yield* GCP.Dataform.RepositoriesWorkflowConfig("Hourly", {
 *   repository: repo.name,
 *   releaseConfig: release.name,
 *   cronSchedule: "0 * * * *",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const RepositoriesWorkflowConfig = Resource<RepositoriesWorkflowConfig>(
  "GCP.Dataform.RepositoriesWorkflowConfig",
);

export class RepositoriesWorkflowConfigNotResolved extends Data.TaggedError(
  "GCP.Dataform.RepositoriesWorkflowConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (repository: string, workflowConfigId: string) =>
  `${repository}/workflowConfigs/${workflowConfigId}`;

const invocationOf = (
  config: InvocationConfig | undefined,
): dataform.InvocationConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    transitiveDependentsIncluded: config.transitiveDependentsIncluded,
    serviceAccount: config.serviceAccount,
    includedTags: config.includedTags,
    fullyRefreshIncrementalTablesEnabled:
      config.fullyRefreshIncrementalTablesEnabled,
    queryPriority: config.queryPriority,
    transitiveDependenciesIncluded: config.transitiveDependenciesIncluded,
    includedTargets: config.includedTargets,
  };
};

const toAttrs = (
  config: dataform.WorkflowConfig,
  project: string,
  region: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "workflowConfigs", region);
  return {
    name,
    workflowConfigId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    releaseConfig: config.releaseConfig,
    cronSchedule: config.cronSchedule,
    timeZone: config.timeZone,
    disabled: config.disabled === true,
    includedTags: config.invocationConfig?.includedTags,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsRepositoriesWorkflowConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RepositoriesWorkflowConfigProvider = () =>
  Provider.succeed(RepositoriesWorkflowConfig, {
    stables: [
      "name",
      "workflowConfigId",
      "repository",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.workflowConfigId ?? output?.workflowConfigId,
        nextId:
          news.workflowConfigId ??
          olds?.workflowConfigId ??
          output?.workflowConfigId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: expandRepository(news.repository, env.project, location),
        extra:
          news.invocationConfig !== undefined &&
          olds?.invocationConfig !== undefined &&
          !sameJson(olds.invocationConfig, news.invocationConfig),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const repository = expandRepository(
        olds?.repository ??
          output?.repository ??
          parseResourceName(output?.name ?? "", "workflowConfigs", env.region)
            .parent,
        env.project,
        location,
      );
      const workflowConfigId = yield* toPhysicalId(
        id,
        olds?.workflowConfigId,
        output?.workflowConfigId,
      );
      const name = output?.name ?? resourceName(repository, workflowConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const parent = yield* dataform
        .getProjectsLocationsRepositories({ name: attrs.repository })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (parent === undefined) return Unowned(attrs);
      return hasAlchemyLabelMap(parent.labels) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const configs = yield* forEachOwnedRepository(
          env.project,
          env.region,
          (repo) => listWorkflowConfigs(repo.name ?? ""),
        );
        return configs.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const repository = expandRepository(
        news.repository,
        env.project,
        location,
      );
      const workflowConfigId = yield* toPhysicalId(
        id,
        news.workflowConfigId,
        output?.workflowConfigId,
      );
      const name = resourceName(repository, workflowConfigId);
      const resolvedRelease = news.releaseConfig.includes("/")
        ? news.releaseConfig
        : `${repository}/releaseConfigs/${news.releaseConfig}`;
      const disabled = news.disabled === true;
      const invocationConfig = invocationOf(news.invocationConfig);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          dataform.createProjectsLocationsRepositoriesWorkflowConfigs({
            parent: repository,
            workflowConfigId,
            body: {
              releaseConfig: resolvedRelease,
              cronSchedule: news.cronSchedule,
              timeZone: news.timeZone,
              disabled,
              invocationConfig,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new RepositoriesWorkflowConfigNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const releaseChanged = !sameText(current.releaseConfig, resolvedRelease);
      const cronChanged = !sameText(current.cronSchedule, news.cronSchedule);
      const zoneChanged = !sameText(current.timeZone, news.timeZone);
      const disabledChanged = (current.disabled === true) !== disabled;

      if (releaseChanged || cronChanged || zoneChanged || disabledChanged) {
        current = yield* retryTransient(
          dataform.patchProjectsLocationsRepositoriesWorkflowConfigs({
            name: currentName,
            updateMask: updateMaskOf(
              releaseChanged ? "releaseConfig" : undefined,
              cronChanged ? "cronSchedule" : undefined,
              zoneChanged ? "timeZone" : undefined,
              disabledChanged ? "disabled" : undefined,
            ),
            body: {
              releaseConfig: resolvedRelease,
              cronSchedule: news.cronSchedule,
              timeZone: news.timeZone,
              disabled,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        dataform.deleteProjectsLocationsRepositoriesWorkflowConfigs({
          name: output.name,
        }),
      ).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("BadRequest", () => Effect.void),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });
