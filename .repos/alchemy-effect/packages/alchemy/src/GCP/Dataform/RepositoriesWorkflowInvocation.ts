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
  listWorkflowInvocations,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  waitUntilGone,
} from "./internal.ts";
import type { InvocationConfig } from "./RepositoriesWorkflowConfig.ts";

export type RepositoriesWorkflowInvocationProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the invocation.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Compilation result to invoke
   * (`.../repositories/{repository}/compilationResults/{result}`).
   * Mutually exclusive with `workflowConfig`. Immutable.
   */
  compilationResult?: string;
  /**
   * Workflow config to invoke
   * (`.../repositories/{repository}/workflowConfigs/{workflowConfig}`).
   * Mutually exclusive with `compilationResult`. Immutable.
   */
  workflowConfig?: string;
  /**
   * Invocation options. Immutable — changing them replaces the
   * invocation.
   */
  invocationConfig?: InvocationConfig;
};

export type RepositoriesWorkflowInvocation = Resource<
  "GCP.Dataform.RepositoriesWorkflowInvocation",
  RepositoriesWorkflowInvocationProps,
  {
    /** Full resource name `.../repositories/{repository}/workflowInvocations/{invocation}`. */
    name: string;
    /** Workflow invocation id (last path segment). */
    workflowInvocationId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Compilation result used, if any. */
    compilationResult: string | undefined;
    /** Workflow config used, if any. */
    workflowConfig: string | undefined;
    /** Resolved compilation result. */
    resolvedCompilationResult: string | undefined;
    /** Current state (`RUNNING`, `SUCCEEDED`, `FAILED`, …). */
    state: string | undefined;
    /** Inclusive start of the invocation. */
    startTime: string | undefined;
    /** Exclusive end of the invocation. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataform workflow invocation — a single run of a compilation
 * result (directly or via a workflow config).
 *
 * Invocations have no update API and no labels. Identity is
 * server-assigned; changing `repository`, `compilationResult`,
 * `workflowConfig`, or `invocationConfig` replaces the invocation.
 * `list` / nuke finds invocations under Alchemy-labeled repositories.
 * A running invocation is cancelled before delete.
 *
 * ### Creating a Workflow Invocation
 * **Example:** Invoke a compilation result
 * ```typescript
 * const run = yield* GCP.Dataform.RepositoriesWorkflowInvocation("Run", {
 *   repository: repo.name,
 *   compilationResult: compilation.name,
 * });
 * ```
 *
 * **Example:** Invoke a workflow config
 * ```typescript
 * const run = yield* GCP.Dataform.RepositoriesWorkflowInvocation("Run", {
 *   repository: repo.name,
 *   workflowConfig: workflow.name,
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const RepositoriesWorkflowInvocation =
  Resource<RepositoriesWorkflowInvocation>(
    "GCP.Dataform.RepositoriesWorkflowInvocation",
  );

export class RepositoriesWorkflowInvocationNotResolved extends Data.TaggedError(
  "GCP.Dataform.RepositoriesWorkflowInvocationNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  invocation: dataform.WorkflowInvocation,
  project: string,
  region: string,
) => {
  const name = invocation.name ?? "";
  const parsed = parseResourceName(name, "workflowInvocations", region);
  return {
    name,
    workflowInvocationId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    compilationResult: invocation.compilationResult,
    workflowConfig: invocation.workflowConfig,
    resolvedCompilationResult: invocation.resolvedCompilationResult,
    state: invocation.state,
    startTime: invocation.invocationTiming?.startTime,
    endTime: invocation.invocationTiming?.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsRepositoriesWorkflowInvocations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const invocationBody = (
  news: RepositoriesWorkflowInvocationProps,
): dataform.WorkflowInvocation => ({
  compilationResult: news.compilationResult,
  workflowConfig: news.workflowConfig,
  invocationConfig: news.invocationConfig
    ? {
        transitiveDependentsIncluded:
          news.invocationConfig.transitiveDependentsIncluded,
        serviceAccount: news.invocationConfig.serviceAccount,
        includedTags: news.invocationConfig.includedTags,
        fullyRefreshIncrementalTablesEnabled:
          news.invocationConfig.fullyRefreshIncrementalTablesEnabled,
        queryPriority: news.invocationConfig.queryPriority,
        transitiveDependenciesIncluded:
          news.invocationConfig.transitiveDependenciesIncluded,
        includedTargets: news.invocationConfig.includedTargets,
      }
    : undefined,
});

export const RepositoriesWorkflowInvocationProvider = () =>
  Provider.succeed(RepositoriesWorkflowInvocation, {
    stables: [
      "name",
      "workflowInvocationId",
      "repository",
      "project",
      "location",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const compilationChanged =
        (olds?.compilationResult ?? output?.compilationResult) !== undefined &&
        news.compilationResult !== undefined &&
        news.compilationResult !==
          (olds?.compilationResult ?? output?.compilationResult);
      const workflowChanged =
        (olds?.workflowConfig ?? output?.workflowConfig) !== undefined &&
        news.workflowConfig !== undefined &&
        news.workflowConfig !==
          (olds?.workflowConfig ?? output?.workflowConfig);
      const configChanged =
        news.invocationConfig !== undefined &&
        olds?.invocationConfig !== undefined &&
        !sameJson(olds.invocationConfig, news.invocationConfig);
      return replaceOnIdentity({
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: expandRepository(news.repository, env.project, location),
        extra: compilationChanged || workflowChanged || configChanged,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
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
        const invocations = yield* forEachOwnedRepository(
          env.project,
          env.region,
          (repo) => listWorkflowInvocations(repo.name ?? ""),
        );
        return invocations.map((item) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
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

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        current = yield* retryTransient(
          dataform.createProjectsLocationsRepositoriesWorkflowInvocations({
            parent: repository,
            body: invocationBody(news),
          }),
        );
      }

      if (current === undefined) {
        return yield* new RepositoriesWorkflowInvocationNotResolved({
          name: output?.name ?? `${repository}/workflowInvocations`,
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const current = yield* getByName(output.name);
      if (
        current?.state === "RUNNING" ||
        current?.state === "CANCELING" ||
        current?.state === "STATE_UNSPECIFIED"
      ) {
        yield* retryTransient(
          dataform.cancelProjectsLocationsRepositoriesWorkflowInvocations({
            name: output.name,
            body: {},
          }),
        ).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
        );
      }
      yield* retryTransient(
        dataform.deleteProjectsLocationsRepositoriesWorkflowInvocations({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
