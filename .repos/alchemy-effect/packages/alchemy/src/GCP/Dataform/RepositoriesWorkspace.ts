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
  listWorkspaces,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type RepositoriesWorkspaceProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the workspace.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Workspace id (the `{workspace}` segment). If omitted, a unique
   * RFC1035 name is generated. Immutable — changing it replaces the
   * workspace. Workspaces have no labels field; ownership is the
   * generated physical id and the parent repository's Alchemy labels.
   */
  workspaceId?: string;
  /**
   * When true, the workspace is deleted instead of moved if its
   * repository is moved. Immutable after create.
   * @default false
   */
  disableMoves?: boolean;
};

export type RepositoriesWorkspace = Resource<
  "GCP.Dataform.RepositoriesWorkspace",
  RepositoriesWorkspaceProps,
  {
    /** Full resource name `.../repositories/{repository}/workspaces/{workspace}`. */
    name: string;
    /** Workspace id (last path segment). */
    workspaceId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Whether the workspace is deleted on repository move. */
    disableMoves: boolean;
    /** Whether the workspace is user-scoped. */
    userScoped: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataform Git workspace inside a repository.
 *
 * Workspaces have no update API. Changing `workspaceId`, `repository`,
 * `location`, or `disableMoves` replaces the workspace. Ownership for
 * `list` / nuke is the parent repository's Alchemy labels.
 *
 * ### Creating a Workspace
 * **Example:** Generated name
 * ```typescript
 * const workspace = yield* GCP.Dataform.RepositoriesWorkspace("Dev", {
 *   repository: repo.name,
 * });
 * ```
 *
 * **Example:** Named workspace
 * ```typescript
 * const workspace = yield* GCP.Dataform.RepositoriesWorkspace("Dev", {
 *   repository: repo.name,
 *   workspaceId: "dev",
 * });
 * ```
 *
 * @resource
 * @category Dataform
 */
export const RepositoriesWorkspace = Resource<RepositoriesWorkspace>(
  "GCP.Dataform.RepositoriesWorkspace",
);

export class RepositoriesWorkspaceNotResolved extends Data.TaggedError(
  "GCP.Dataform.RepositoriesWorkspaceNotResolved",
)<{
  name: string;
}> {}

const resourceName = (repository: string, workspaceId: string) =>
  `${repository}/workspaces/${workspaceId}`;

const toAttrs = (
  workspace: dataform.Workspace,
  project: string,
  region: string,
) => {
  const name = workspace.name ?? "";
  const parsed = parseResourceName(name, "workspaces", region);
  return {
    name,
    workspaceId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    disableMoves: workspace.disableMoves === true,
    userScoped: workspace.privateResourceMetadata?.userScoped,
    createTime: workspace.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataform
        .getProjectsLocationsRepositoriesWorkspaces({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RepositoriesWorkspaceProvider = () =>
  Provider.succeed(RepositoriesWorkspace, {
    stables: [
      "name",
      "workspaceId",
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
      const previousRepo = olds?.repository ?? output?.repository;
      const nextRepo = expandRepository(news.repository, env.project, location);
      const previousMoves = olds?.disableMoves ?? output?.disableMoves;
      return replaceOnIdentity({
        previousId: olds?.workspaceId ?? output?.workspaceId,
        nextId: news.workspaceId ?? olds?.workspaceId ?? output?.workspaceId,
        previousLocation: olds?.location ?? output?.location,
        nextLocation: news.location ?? olds?.location ?? output?.location,
        previousParent: previousRepo,
        nextParent: nextRepo,
        extra:
          previousMoves !== undefined &&
          news.disableMoves !== undefined &&
          news.disableMoves !== previousMoves,
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
          parseResourceName(output?.name ?? "", "workspaces", env.region)
            .parent,
        env.project,
        location,
      );
      const workspaceId = yield* toPhysicalId(
        id,
        olds?.workspaceId,
        output?.workspaceId,
      );
      const name = output?.name ?? resourceName(repository, workspaceId);
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
        const workspaces = yield* forEachOwnedRepository(
          env.project,
          env.region,
          (repo) => listWorkspaces(repo.name ?? ""),
        );
        return workspaces.map((item) => toAttrs(item, env.project, env.region));
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
      const workspaceId = yield* toPhysicalId(
        id,
        news.workspaceId,
        output?.workspaceId,
      );
      const name = resourceName(repository, workspaceId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          dataform.createProjectsLocationsRepositoriesWorkspaces({
            parent: repository,
            workspaceId,
            body: {
              disableMoves: news.disableMoves === true ? true : undefined,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new RepositoriesWorkspaceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        dataform.deleteProjectsLocationsRepositoriesWorkspaces({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
