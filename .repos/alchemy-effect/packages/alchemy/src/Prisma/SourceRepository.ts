import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import {
  DEV_TIMESTAMP,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  type GetServicesResponse,
  type GetProjectBranchesResponse,
  type GetProjectDatabasesResponse,
  type GetProjectsResponse,
  type GetSourceRepositoriesResponse,
  deleteSourceRepository,
  getServices,
  getService,
  getDatabase,
  getProjects,
  getProjectBranches,
  getProjectDatabases,
  getSourceRepositories,
  getSourceRepository,
  createSourceRepository,
} from "@distilled.cloud/prisma/management";
import { Retry } from "@distilled.cloud/prisma";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { ObservedSourceRepository } from "./Internal/Observed.ts";
import { PrismaPaginationError } from "./Internal/Pagination.ts";

export interface SourceRepositoryProps {
  /**
   * Project ID or project output to link. Linking has Management API side
   * effects: it creates/renames the default branch and attaches currently
   * unassigned databases and apps. To order downstream resources
   * after those effects, pass this resource's `projectId` output to them.
   * Deleting this resource only disconnects the repository link; Prisma
   * preserves branches and resources that were attached while linking.
   */
  project: string | Project;
  /**
   * Git provider.
   *
   * @default "github"
   */
  provider?: "github";
  /**
   * GitHub's permanent numeric repository ID, not `owner/repo`, a Prisma
   * project ID, or an SCM installation ID. Retrieve it with:
   *
   * ```bash
   * gh api repos/OWNER/REPO --jq '.id'
   * ```
   */
  providerRepositoryId: number;
  /**
   * Optional SCM installation ID to use for linking. When omitted, Prisma
   * auto-picks the workspace's installation.
   */
  installationId?: string;
}

export interface SourceRepository extends Resource<
  "Prisma.SourceRepository",
  SourceRepositoryProps,
  {
    /**
     * Prisma source repository link ID.
     */
    sourceRepositoryId: string;
    /**
     * Project ID linked to the repository.
     */
    projectId: string;
    /**
     * Numeric provider repository ID.
     */
    repoId: number;
    /**
     * Source control provider.
     */
    provider: "github";
    /**
     * Full repository name, for example "owner/repo".
     */
    repoFullName: string;
    /**
     * Default repository branch.
     */
    defaultBranch: string;
    /**
     * Whether the repository is private.
     */
    isPrivate: boolean;
    /**
     * Link status.
     */
    status: "active" | "archived";
    /**
     * SCM installation ID used for the link.
     */
    installationId: string;
    /**
     * ISO timestamp when the link was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the link was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A linked source repository for Prisma apps.
 *
 * GitHub is currently the only supported provider. Linking requires an
 * existing Prisma SCM installation. `providerRepositoryId` is GitHub's
 * permanent numeric repository ID; retrieve it with
 * `gh api repos/OWNER/REPO --jq '.id'`. When `installationId` is omitted,
 * Prisma selects the workspace installation.
 *
 * Linking creates or renames the repository-owned default branch. Observe
 * that branch through the Management API; do not declare it again as a
 * separate `Prisma.Branch` resource. Use this resource's outputs to order
 * downstream databases and apps after the link side effects complete.
 * Deleting the link does not roll those side effects back: existing branches,
 * databases, and apps remain in the project.
 *
 * The project, repository ID, provider, and installation form an immutable
 * link identity. Alchemy refuses an automatic relink because unlinking cannot
 * roll back branch and resource attachments. Existing links require explicit
 * adoption.
 *
 * ### Finding the Repository ID
 * **Example:** Read the numeric GitHub repository ID
 * ```bash
 * gh api repos/OWNER/REPO --jq '.id'
 * ```
 *
 * ### Linking a Repository
 * **Example:** GitHub repository
 * ```typescript
 * const repo = yield* Prisma.SourceRepository("repo", {
 *   project: project.projectId,
 *   // Replace with the value returned by the GitHub command above.
 *   providerRepositoryId: 123456789,
 * });
 * const database = yield* Prisma.Database("database", {
 *   project: repo.projectId,
 *   branchGitName: repo.defaultBranch,
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const SourceRepository = Resource<SourceRepository>(
  "Prisma.SourceRepository",
);

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listSourceRepositories = (projectId: string) =>
  Effect.gen(function* () {
    const repos: GetSourceRepositoriesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getSourceRepositories(
        cursor === undefined
          ? { projectId, limit: 100 }
          : { projectId, limit: 100, cursor },
      );
      repos.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* Effect.fail(
          new PrismaPaginationError({
            message:
              "Invalid Prisma Management API pagination response from getSourceRepositories: hasMore was true without a non-empty nextCursor",
          }),
        );
      }
      cursor = nextCursor;
    }
    return repos;
  });

const findRepository = (projectId: string) =>
  listSourceRepositories(projectId).pipe(
    Effect.flatMap((repos) => {
      const active = repos.filter(
        (repo: ObservedSourceRepository) => repo.status === "active",
      );
      return active.length > 1
        ? Effect.fail(
            new Error(
              `Prisma project '${projectId}' has multiple active source repositories; refusing to select one arbitrarily.`,
            ),
          )
        : Effect.succeed(active[0]);
    }),
  );

const matchesDesiredRepository = (
  repo: ObservedSourceRepository,
  projectId: string,
  props: SourceRepositoryProps,
) =>
  repo.status === "active" &&
  repo.projectId === projectId &&
  repo.repoId === props.providerRepositoryId &&
  repo.provider === (props.provider ?? "github") &&
  (props.installationId === undefined ||
    repo.installationId === props.installationId);

const attrsFrom = (
  repo: ObservedSourceRepository,
): SourceRepository["Attributes"] => ({
  sourceRepositoryId: repo.id,
  projectId: repo.projectId,
  repoId: repo.repoId,
  provider: repo.provider,
  repoFullName: repo.repoFullName,
  defaultBranch: repo.defaultBranch,
  isPrivate: repo.isPrivate,
  status: repo.status,
  installationId: repo.installationId,
  createdAt: repo.createdAt,
  updatedAt: repo.updatedAt,
});

class SourceRepositoryLinkNotReady extends Error {}

const sourceRepositoryConsistencySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(5),
]);

const verifyRepositoryLink = Effect.fn(function* (
  repo: ObservedSourceRepository,
  expectedAppIds: readonly string[] = [],
  expectedDatabaseIds: readonly string[] = [],
) {
  const observed = (yield* getSourceRepository({ id: repo.id })).data;
  if (
    observed.status !== "active" ||
    observed.projectId !== repo.projectId ||
    observed.repoId !== repo.repoId ||
    observed.provider !== repo.provider ||
    observed.installationId !== repo.installationId
  ) {
    return yield* Effect.fail(
      new SourceRepositoryLinkNotReady(
        `Prisma source repository link '${repo.id}' has not converged to its requested immutable identity.`,
      ),
    );
  }
  const branches = yield* Effect.gen(function* () {
    const items: GetProjectBranchesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getProjectBranches(
        cursor === undefined
          ? {
              projectId: repo.projectId,
              gitName: observed.defaultBranch,
              limit: 100,
            }
          : {
              projectId: repo.projectId,
              gitName: observed.defaultBranch,
              limit: 100,
              cursor,
            },
      );
      items.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* Effect.fail(
          new PrismaPaginationError({
            message:
              "Invalid Prisma Management API pagination response from getProjectBranches: hasMore was true without a non-empty nextCursor",
          }),
        );
      }
      cursor = nextCursor;
    }
    return items;
  });
  const defaults = branches.filter(
    (branch) =>
      branch.gitName === observed.defaultBranch && branch.isDefault === true,
  );
  if (defaults.length !== 1) {
    return yield* Effect.fail(
      new SourceRepositoryLinkNotReady(
        `Prisma source repository link '${repo.id}' did not produce exactly one default branch named '${observed.defaultBranch}'.`,
      ),
    );
  }
  const branchId = defaults[0]!.id;
  yield* Effect.forEach(
    expectedAppIds,
    (appId) =>
      getService({ serviceId: appId }).pipe(
        Effect.map((response) => response.data),
        Effect.flatMap((app) =>
          app.branchId === branchId
            ? Effect.void
            : Effect.fail(
                new SourceRepositoryLinkNotReady(
                  `Prisma App '${appId}' was not attached to repository branch '${branchId}'.`,
                ),
              ),
        ),
      ),
    { concurrency: 8 },
  );
  yield* Effect.forEach(
    expectedDatabaseIds,
    (databaseId) =>
      getDatabase({ databaseId }).pipe(
        Effect.map((response) => response.data),
        Effect.flatMap((database) =>
          database.branchId === branchId
            ? Effect.void
            : Effect.fail(
                new SourceRepositoryLinkNotReady(
                  `Prisma database '${databaseId}' was not attached to repository branch '${branchId}'.`,
                ),
              ),
        ),
      ),
    { concurrency: 8 },
  );
  return observed;
});

const ProviderLive = () =>
  Provider.effect(
    SourceRepository,
    Effect.gen(function* () {
      return {
        stables: ["sourceRepositoryId"],
        list: Effect.fn(function* () {
          const projects = yield* Effect.gen(function* () {
            const items: GetProjectsResponse["data"][number][] = [];
            let cursor: string | undefined;
            while (true) {
              const page = yield* getProjects(
                cursor === undefined ? {} : { cursor },
              );
              items.push(...page.data);
              const nextCursor = page.pagination.nextCursor;
              if (!page.pagination.hasMore) break;
              if (nextCursor === null) {
                return yield* Effect.fail(
                  new PrismaPaginationError({
                    message:
                      "Invalid Prisma Management API pagination response from getProjects: hasMore was true without a non-empty nextCursor",
                  }),
                );
              }
              cursor = nextCursor;
            }
            return items;
          });
          const repositories = yield* Effect.forEach(
            projects,
            (project) =>
              listSourceRepositories(project.id).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              ),
            { concurrency: 8 },
          );
          return repositories.flat().map(attrsFrom);
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.sourceRepositoryId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          const newRepositoryId = isResolved(news.providerRepositoryId)
            ? news.providerRepositoryId
            : undefined;
          const observedMismatch =
            output &&
            ((newProjectId !== undefined &&
              output.projectId !== newProjectId) ||
              (newRepositoryId !== undefined &&
                output.repoId !== newRepositoryId) ||
              (isResolved(news.provider) &&
                output.provider !== (news.provider ?? "github")) ||
              (isResolved(news.installationId) &&
                news.installationId !== undefined &&
                output.installationId !== news.installationId) ||
              output.status !== "active");
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (isResolved(news.provider) &&
              (news.provider ?? "github") !== (olds.provider ?? "github")) ||
            (isResolved(news.providerRepositoryId) &&
              news.providerRepositoryId !== olds.providerRepositoryId) ||
            (isResolved(news.installationId) &&
              news.installationId !== olds.installationId) ||
            observedMismatch
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma source repository links cannot be replaced atomically: unlinking mutates branch/resource attachments and a failed relink cannot restore them. Create a new project or explicitly unlink and relink in separate reviewed deployments.`,
              ),
            );
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const sourceRepositoryId = isPrismaDevId(output?.sourceRepositoryId)
            ? undefined
            : output?.sourceRepositoryId;
          const repo = sourceRepositoryId
            ? yield* getSourceRepository({
                id: sourceRepositoryId,
              }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId ? yield* findRepository(projectId) : undefined;
              });
          if (!repo) return undefined;
          const attrs = attrsFrom(repo);
          return sourceRepositoryId === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const projectId = yield* resolveProjectId(news.project);
          const sourceRepositoryId = isPrismaDevId(output?.sourceRepositoryId)
            ? undefined
            : output?.sourceRepositoryId;
          let repo = sourceRepositoryId
            ? yield* getSourceRepository({
                id: sourceRepositoryId,
              }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;
          if (repo && !matchesDesiredRepository(repo, projectId, news)) {
            return yield* Effect.fail(
              new Error(
                `Prisma project '${projectId}' is already linked to '${repo.repoFullName}'. The Management API has no atomic relink or rollback operation, so this provider will not delete the live link during reconcile. Explicitly unlink it in a separate reviewed deployment before linking repository '${news.providerRepositoryId}'.`,
              ),
            );
          }
          if (!repo) {
            const previouslyUnassignedApps = (yield* Effect.gen(function* () {
              const items: GetServicesResponse["data"][number][] = [];
              let cursor: string | undefined;
              while (true) {
                const page = yield* getServices(
                  cursor === undefined
                    ? { projectId, branchId: "unassigned", limit: 100 }
                    : { projectId, branchId: "unassigned", limit: 100, cursor },
                );
                items.push(...page.data);
                const nextCursor = page.pagination.nextCursor;
                if (!page.pagination.hasMore) break;
                if (nextCursor === null) {
                  return yield* Effect.fail(
                    new PrismaPaginationError({
                      message:
                        "Invalid Prisma Management API pagination response from getServices: hasMore was true without a non-empty nextCursor",
                    }),
                  );
                }
                cursor = nextCursor;
              }
              return items;
            })).map((app) => app.id);
            const previouslyUnassignedDatabases = (yield* Effect.gen(
              function* () {
                const items: GetProjectDatabasesResponse["data"][number][] = [];
                let cursor: string | undefined;
                while (true) {
                  const page = yield* getProjectDatabases(
                    cursor === undefined
                      ? { projectId, limit: 100 }
                      : { projectId, limit: 100, cursor },
                  );
                  items.push(...page.data);
                  const nextCursor = page.pagination.nextCursor;
                  if (!page.pagination.hasMore) break;
                  if (nextCursor === null) {
                    return yield* Effect.fail(
                      new PrismaPaginationError({
                        message:
                          "Invalid Prisma Management API pagination response from getProjectDatabases: hasMore was true without a non-empty nextCursor",
                      }),
                    );
                  }
                  cursor = nextCursor;
                }
                return items;
              },
            ))
              .filter((database) => database.branchId === null)
              .map((database) => database.id);
            repo = yield* createSourceRepository({
              projectId,
              provider: news.provider ?? "github",
              providerRepositoryId: news.providerRepositoryId,
              ...(news.installationId === undefined
                ? {}
                : { installationId: news.installationId }),
            }).pipe(
              // A replayed create would link the repository twice; the retry
              // policy cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => response.data),
              Effect.catchTag("Conflict", () =>
                Effect.fail(
                  new Error(
                    `Prisma source repository '${news.providerRepositoryId}' appeared after the adoption check. Refusing to take over the project link; rerun with adoption enabled if it is the intended repository.`,
                  ),
                ),
              ),
            );
            repo = yield* verifyRepositoryLink(
              repo,
              previouslyUnassignedApps,
              previouslyUnassignedDatabases,
            ).pipe(
              Effect.retry({
                while: (error) => error instanceof SourceRepositoryLinkNotReady,
                schedule: sourceRepositoryConsistencySchedule,
              }),
              Effect.mapError(
                (error) =>
                  new Error(
                    `Prisma source repository link '${repo!.id}' was created but its branch/resource side effects did not converge. The link was not deleted because unlinking cannot roll back partial attachments; inspect it and adopt after repair.`,
                    { cause: error },
                  ),
              ),
            );
          } else {
            repo = yield* verifyRepositoryLink(repo);
          }
          return attrsFrom(repo);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.sourceRepositoryId)) return;
          const repo = yield* getSourceRepository({
            id: output.sourceRepositoryId,
          }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!repo) return;
          if (
            repo.projectId !== output.projectId ||
            repo.repoId !== output.repoId ||
            repo.provider !== output.provider ||
            repo.installationId !== output.installationId
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma source repository '${repo.id}' no longer matches its persisted project/repository/installation identity. Refusing to delete a mismatched link.`,
              ),
            );
          }
          yield* deleteSourceRepository({ id: repo.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(SourceRepository, ["sourceRepositoryId"], ({ id, news }) => ({
    sourceRepositoryId: devId("source-repository", id),
    projectId: attrOrString(news.project, "projectId"),
    repoId: news.providerRepositoryId,
    provider: news.provider ?? "github",
    repoFullName: `dev/${id}`,
    defaultBranch: "main",
    isPrivate: false,
    status: "active",
    installationId: devId("installation", id),
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

export const SourceRepositoryProvider = () =>
  ProviderLayer.dual(SourceRepository, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
