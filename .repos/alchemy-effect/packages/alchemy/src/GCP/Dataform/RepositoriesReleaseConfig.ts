import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandRepository,
  forEachOwnedRepository,
  hasAlchemyLabelMap,
  listReleaseConfigs,
  mergeOwnedVars,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type NotebookRuntimeOptions = {
  /** Colab runtime template resource name. */
  aiPlatformNotebookRuntimeTemplate?: string;
  /** GCS bucket for notebook output (`gs://bucket`). */
  gcsOutputBucket?: string;
};

export type CodeCompilationConfig = {
  /** Prefix prepended to table names. */
  tablePrefix?: string;
  /** Default notebook runtime options. */
  defaultNotebookRuntimeOptions?: NotebookRuntimeOptions;
  /** Default BigQuery location. Defaults to `US`. */
  defaultLocation?: string;
  /** Prefix prepended to built-in assertion names. */
  builtinAssertionNamePrefix?: string;
  /**
   * User-defined compilation variables. Alchemy ownership keys
   * (`alchemy-stack`, `alchemy-stage`, `alchemy-id`) are merged in
   * automatically because release configs have no labels field.
   */
  vars?: Record<string, string>;
  /** Default schema for assertions. */
  assertionSchema?: string;
  /** Suffix appended to database (project id) names. */
  databaseSuffix?: string;
  /** Suffix appended to schema (dataset) names. */
  schemaSuffix?: string;
  /** Default schema (BigQuery dataset id). */
  defaultSchema?: string;
  /** Default database (Google Cloud project id). */
  defaultDatabase?: string;
};

export type RepositoriesReleaseConfigProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the release config.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Release config id. If omitted, a unique RFC1035 name is generated.
   * Immutable — changing it replaces the release config.
   */
  releaseConfigId?: string;
  /**
   * Git commit, tag, or branch compiled by this release
   * (`main`, `12ade345`, `tag1`).
   */
  gitCommitish: string;
  /**
   * IANA time zone used when interpreting `cronSchedule`.
   * @default "UTC"
   */
  timeZone?: string;
  /**
   * Cron schedule for automatic compilation-result creation.
   */
  cronSchedule?: string;
  /**
   * Disable automatic compilation-result creation.
   * @default false
   */
  disabled?: boolean;
  /**
   * Compilation overrides. Alchemy ownership vars are merged in.
   */
  codeCompilationConfig?: CodeCompilationConfig;
  /**
   * Currently released compilation result
   * (`.../repositories/{repository}/compilationResults/{result}`).
   */
  releaseCompilationResult?: string;
};

export type RepositoriesReleaseConfig = Resource<
  "GCP.Dataform.RepositoriesReleaseConfig",
  RepositoriesReleaseConfigProps,
  {
    /** Full resource name `.../repositories/{repository}/releaseConfigs/{releaseConfig}`. */
    name: string;
    /** Release config id (last path segment). */
    releaseConfigId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Git commitish. */
    gitCommitish: string;
    /** Cron schedule, if set. */
    cronSchedule: string | undefined;
    /** Time zone. */
    timeZone: string | undefined;
    /** Whether automatic releases are disabled. */
    disabled: boolean;
    /** User compilation vars (Alchemy ownership keys stripped). */
    vars: Record<string, string>;
    /** Currently released compilation result, if any. */
    releaseCompilationResult: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataform release configuration — compiles a Git commitish on a
 * schedule (or on demand) into a compilation result.
 *
 * Release configs have no labels field, so Alchemy stamps ownership
 * into `codeCompilationConfig.vars`. Changing `releaseConfigId`,
 * `repository`, or `location` replaces the config. Commitish, schedule,
 * disabled flag, vars, and the current compilation result update in
 * place.
 *
 * ### Creating a Release Config
 * **Example:** Compile `main`
 * ```typescript
 * const release = yield* GCP.Dataform.RepositoriesReleaseConfig("Prod", {
 *   repository: repo.name,
 *   gitCommitish: "main",
 * });
 * ```
 *
 * **Example:** Nightly release
 * ```typescript
 * const release = yield* GCP.Dataform.RepositoriesReleaseConfig("Nightly", {
 *   repository: repo.name,
 *   gitCommitish: "main",
 *   cronSchedule: "0 8 * * *",
 *   timeZone: "America/Los_Angeles",
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const RepositoriesReleaseConfig = Resource<RepositoriesReleaseConfig>(
  "GCP.Dataform.RepositoriesReleaseConfig",
);

export class RepositoriesReleaseConfigNotResolved extends Data.TaggedError(
  "GCP.Dataform.RepositoriesReleaseConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (repository: string, releaseConfigId: string) =>
  `${repository}/releaseConfigs/${releaseConfigId}`;

const compilationOf = (
  config: CodeCompilationConfig | undefined,
  ownership: Record<string, string>,
): dataform.CodeCompilationConfig => ({
  tablePrefix: config?.tablePrefix,
  defaultNotebookRuntimeOptions: config?.defaultNotebookRuntimeOptions,
  defaultLocation: config?.defaultLocation,
  builtinAssertionNamePrefix: config?.builtinAssertionNamePrefix,
  vars: mergeOwnedVars(config?.vars, ownership),
  assertionSchema: config?.assertionSchema,
  databaseSuffix: config?.databaseSuffix,
  schemaSuffix: config?.schemaSuffix,
  defaultSchema: config?.defaultSchema,
  defaultDatabase: config?.defaultDatabase,
});

const toAttrs = (
  config: dataform.ReleaseConfig,
  project: string,
  region: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "releaseConfigs", region);
  return {
    name,
    releaseConfigId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    gitCommitish: config.gitCommitish ?? "",
    cronSchedule: config.cronSchedule,
    timeZone: config.timeZone,
    disabled: config.disabled === true,
    vars: userLabels(config.codeCompilationConfig?.vars),
    releaseCompilationResult: config.releaseCompilationResult,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsRepositoriesReleaseConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isOwnedConfig = (config: dataform.ReleaseConfig) =>
  hasAlchemyLabelMap(config.codeCompilationConfig?.vars);

export const RepositoriesReleaseConfigProvider = () =>
  Provider.succeed(RepositoriesReleaseConfig, {
    stables: ["name", "releaseConfigId", "repository", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.releaseConfigId ?? output?.releaseConfigId,
        nextId:
          news.releaseConfigId ??
          olds?.releaseConfigId ??
          output?.releaseConfigId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: expandRepository(news.repository, env.project, location),
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
          parseResourceName(output?.name ?? "", "releaseConfigs", env.region)
            .parent,
        env.project,
        location,
      );
      const releaseConfigId = yield* toPhysicalId(
        id,
        olds?.releaseConfigId,
        output?.releaseConfigId,
      );
      const name = output?.name ?? resourceName(repository, releaseConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const labeled = yield* hasAlchemyLabels(
        id,
        existing.codeCompilationConfig?.vars,
      );
      return labeled || isOwnedConfig(existing) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const configs = yield* forEachOwnedRepository(
          env.project,
          env.region,
          (repo) => listReleaseConfigs(repo.name ?? ""),
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
      const releaseConfigId = yield* toPhysicalId(
        id,
        news.releaseConfigId,
        output?.releaseConfigId,
      );
      const name = resourceName(repository, releaseConfigId);
      const ownership = yield* createInternalLabels(id);
      const codeCompilationConfig = compilationOf(
        news.codeCompilationConfig,
        ownership,
      );
      const disabled = news.disabled === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          dataform.createProjectsLocationsRepositoriesReleaseConfigs({
            parent: repository,
            releaseConfigId,
            body: {
              gitCommitish: news.gitCommitish,
              timeZone: news.timeZone,
              cronSchedule: news.cronSchedule,
              disabled,
              codeCompilationConfig,
              releaseCompilationResult: news.releaseCompilationResult,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new RepositoriesReleaseConfigNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const gitChanged = !sameText(current.gitCommitish, news.gitCommitish);
      const zoneChanged = !sameText(current.timeZone, news.timeZone);
      const cronChanged = !sameText(current.cronSchedule, news.cronSchedule);
      const disabledChanged = (current.disabled === true) !== disabled;
      const compilationChanged = !sameJson(
        {
          ...current.codeCompilationConfig,
          vars: mergeOwnedVars(
            userLabels(current.codeCompilationConfig?.vars),
            ownership,
          ),
        },
        codeCompilationConfig,
      );
      const resultChanged = !sameText(
        current.releaseCompilationResult,
        news.releaseCompilationResult,
      );

      if (
        gitChanged ||
        zoneChanged ||
        cronChanged ||
        disabledChanged ||
        compilationChanged ||
        resultChanged
      ) {
        current = yield* retryTransient(
          dataform.patchProjectsLocationsRepositoriesReleaseConfigs({
            name: currentName,
            updateMask: updateMaskOf(
              gitChanged ? "gitCommitish" : undefined,
              zoneChanged ? "timeZone" : undefined,
              cronChanged ? "cronSchedule" : undefined,
              disabledChanged ? "disabled" : undefined,
              compilationChanged ? "codeCompilationConfig" : undefined,
              resultChanged ? "releaseCompilationResult" : undefined,
            ),
            body: {
              gitCommitish: news.gitCommitish,
              timeZone: news.timeZone,
              cronSchedule: news.cronSchedule,
              disabled,
              codeCompilationConfig,
              releaseCompilationResult: news.releaseCompilationResult,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        dataform.deleteProjectsLocationsRepositoriesReleaseConfigs({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
