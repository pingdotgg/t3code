import { Retry } from "@distilled.cloud/prisma";
import {
  type GetServicesResponse,
  getServices,
  getService,
  updateService,
  createService,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { destroyApp } from "./ComputeLifecycle.ts";
import { ensureAppImmutableIdentity } from "./internal/AppIdentity.ts";
import { desiredBranchId } from "./internal/Branches.ts";
import { DEV_TIMESTAMP, attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import type { ObservedApp } from "./internal/Observed.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./internal/Refs.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import type { PrismaRegionId } from "./Types.ts";

export class AppConflict extends Data.TaggedError("AppConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AppInvalidProps extends Data.TaggedError("AppInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AppOperationFailed extends Data.TaggedError("AppOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AppUnexpectedResponse extends Data.TaggedError("AppUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AppProps {
  /**
   * Project ID or `project.projectId` output that owns this App.
   */
  project: string | Project;
  /**
   * App display name. If omitted, Alchemy generates a stable physical name.
   */
  displayName?: string;
  /**
   * Region where the App is placed.
   *
   * @default The project's default region, falling back to "us-east-1"
   */
  regionId?: PrismaRegionId;
  /**
   * Branch ID to attach the App to. Mutually exclusive with branchGitName.
   */
  branchId?: string;
  /**
   * Branch git name to attach the App to. Mutually exclusive with branchId.
   */
  branchGitName?: string;
  /**
   * Stable identity of this declaration on the Prisma platform, unique per
   * branch. A rename in the Console does not change it. After lost state, the
   * provider finds the App by it instead of creating a second one, and
   * `--adopt` (or `adopt(true)`) takes it back over, because a logical ID alone
   * does not prove which stack owns it. Changing it updates the App in place.
   * @default the resource's fully qualified logical ID, e.g. `"web"` or `"Site/Web"`
   */
  logicalId?: string;
}

export interface App extends Resource<
  "Prisma.App",
  AppProps,
  {
    /**
     * Prisma App ID.
     */
    appId: string;
    /**
     * App display name.
     */
    name: string;
    /**
     * Project ID that owns the App.
     */
    projectId: string;
    /**
     * Region ID where the App is placed.
     */
    regionId: string;
    /**
     * Branch ID attached to the App, or null when unassigned.
     */
    branchId: string | null;
    /**
     * Latest promoted deployment ID, when available.
     */
    latestDeploymentId: string | null;
    /**
     * Stable App endpoint domain.
     */
    appEndpointDomain: string;
    /**
     * ISO timestamp when the App was created.
     */
    createdAt: string;
    /**
     * Logical ID recorded on the App, or null when none is set.
     */
    logicalId: string | null;
  },
  never,
  Providers
> {}

/**
 * A Prisma App, the long-lived application configuration that owns deployments.
 *
 * Omit `branchId` and `branchGitName` to attach the App to the project's
 * current default branch. App regions are immutable; create a second App and
 * cut traffic over when moving regions. Use `Prisma.Compute` for the usual
 * build, deployment, health-check, and promotion workflow; use `App` directly
 * when managing standalone `Prisma.Deployment` resources.
 *
 * ### Creating an App
 * **Example:** App on the default branch
 * ```typescript
 * const app = yield* Prisma.App("web", {
 *   project,
 * });
 * ```
 *
 * **Example:** App on a preview branch
 * ```typescript
 * const app = yield* Prisma.App("preview-web", {
 *   project,
 *   branchId: preview.branchId,
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const App = Resource<App>("Prisma.App");

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listApps = (filter: { projectId?: string; logicalId?: string; branchId?: string } = {}) =>
  Effect.gen(function* () {
    const apps: GetServicesResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getServices({
        limit: 100,
        ...filter,
        ...(cursor === undefined ? {} : { cursor }),
      });
      apps.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* new PrismaPaginationError({
          message:
            "Invalid Prisma Management API pagination response from getServices: hasMore was true without a non-empty nextCursor",
        });
      }
      cursor = nextCursor;
    }
    return apps;
  });

const createDisplayName = (id: string, displayName: string | undefined) =>
  displayName === undefined ? createPhysicalName({ id }) : Effect.succeed(displayName);

const findApp = Effect.fn(function* (
  projectId: string,
  displayName: string,
  props: Pick<AppProps, "branchId" | "branchGitName">,
) {
  const candidates = (yield* listApps({ projectId })).filter((app) => app.name === displayName);
  if (candidates.length === 0) return undefined;
  const branch = yield* desiredBranchId(projectId, props);
  if (!branch.resolved) return undefined;
  const matches = candidates.filter((app) => app.branchId === branch.id);
  if (matches.length > 1) {
    return yield* new AppConflict({
      message: `Prisma returned multiple Apps named '${displayName}' on branch '${branch.id}' in project '${projectId}'; refusing an ambiguous ownership match.`,
    });
  }
  return matches[0];
});

const findAppByLogicalId = Effect.fn(function* (
  projectId: string,
  logicalId: string,
  props: Pick<AppProps, "branchId" | "branchGitName">,
) {
  const branch = yield* desiredBranchId(projectId, props);
  if (!branch.resolved) return undefined;
  const apps = yield* listApps({ projectId, logicalId, branchId: branch.id });
  return apps.find((app) => app.logicalId === logicalId && app.branchId === branch.id);
});

const logicalIdTaken = (logicalId: string, branchId: string, projectId: string, cause: unknown) =>
  new Error(
    `Prisma App logical ID '${logicalId}' is already used by another App on branch '${branchId}' in project '${projectId}'. Logical IDs are unique per branch; choose a different logicalId or remove it from the other App.`,
    { cause },
  );

const attrsFrom = (app: ObservedApp): App["Attributes"] => ({
  appId: app.id,
  name: app.name,
  projectId: app.projectId,
  regionId: app.region.id,
  branchId: app.branchId,
  latestDeploymentId: app.latestDeploymentId,
  appEndpointDomain: app.appEndpointDomain,
  createdAt: app.createdAt,
  logicalId: app.logicalId ?? null,
});

const branchNeedsSync = Effect.fn(function* (projectId: string, app: ObservedApp, props: AppProps) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return app.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    const branch = yield* desiredBranchId(projectId, props);
    return !branch.resolved || app.branchId !== branch.id;
  }
  const branch = yield* desiredBranchId(projectId, props);
  return !branch.resolved || branch.id !== app.branchId;
});

const validateAppProps = (props: AppProps) =>
  Effect.gen(function* () {
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* new AppInvalidProps({
        message: "branchId and branchGitName are mutually exclusive.",
      });
    }
    if (props.branchId === null || props.branchGitName === null) {
      return yield* new AppInvalidProps({
        message:
          "Prisma.App requires an attached branch because the Management API cannot create an unassigned App atomically. Omit both fields to use the project default branch, or provide branchId/branchGitName.",
      });
    }
  });

const ProviderLive = () =>
  Provider.effect(
    App,
    Effect.gen(function* () {
      return {
        stables: ["appId"],
        list: () => listApps().pipe(Effect.map((apps) => apps.map(attrsFrom))),
        diff: Effect.fn(function* ({ id, fqn, olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.appId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (concreteIdsChanged(oldProjectId, newProjectId)) {
            return { action: "replace" } as const;
          }
          if (isResolved(news.regionId) && news.regionId !== undefined) {
            const currentRegionId = output?.regionId ?? olds.regionId;
            if (currentRegionId !== undefined && news.regionId !== currentRegionId) {
              return yield* new AppInvalidProps({
                message: `Prisma App region is immutable and the Management API cannot atomically move an App without deleting its serving endpoint first. Create a second App with a different display name in the target region, cut traffic over, then remove this App.`,
              });
            }
          }
          if (
            isResolved(news.logicalId) &&
            (news.logicalId ?? fqn) !== (output ? output.logicalId : (olds.logicalId ?? fqn))
          ) {
            return { action: "update" } as const;
          }
          const updateProps = {
            displayName: news.displayName,
            branchId: news.branchId,
            branchGitName: news.branchGitName,
          };
          if (!isResolved(updateProps)) return undefined;
          const resolvedUpdateProps = {
            ...(updateProps as Pick<AppProps, "displayName" | "branchId" | "branchGitName">),
            displayName: yield* createDisplayName(
              id,
              (updateProps as Pick<AppProps, "displayName">).displayName,
            ),
          };
          if (!output) {
            return deepEqual(resolvedUpdateProps, {
              displayName: yield* createDisplayName(id, olds.displayName),
              branchId: olds.branchId,
              branchGitName: olds.branchGitName,
            })
              ? undefined
              : ({ action: "update" } as const);
          }
          if (output.name !== resolvedUpdateProps.displayName) {
            return { action: "update" } as const;
          }
          const branch = yield* desiredBranchId(
            newProjectId ?? output.projectId,
            resolvedUpdateProps,
          );
          return !branch.resolved || output.branchId !== branch.id
            ? ({ action: "update" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, fqn, output, olds }) {
          const appId = isPrismaDevId(output?.appId) ? undefined : output?.appId;
          let provenOwned = false;
          const findAppInProject = Effect.gen(function* () {
            const projectId = unresolvedProjectIdOf(olds.project);
            if (!projectId) return undefined;
            const byLogicalId = yield* findAppByLogicalId(projectId, olds.logicalId ?? fqn, olds);
            if (byLogicalId) {
              // A logical ID alone does not prove ownership: another
              // declaration, stage, or stack on the branch can hold it.
              // The generated display name embeds this instance's ID,
              // so a match on it is this resource's interrupted create.
              provenOwned =
                olds.displayName === undefined &&
                byLogicalId.name === (yield* createDisplayName(id, undefined));
              return byLogicalId;
            }
            // An explicit logical ID is the only identity. A derived one
            // falls back to the display name for Apps created before
            // logical IDs existed.
            if (olds.logicalId !== undefined) return undefined;
            return yield* findApp(projectId, yield* createDisplayName(id, olds.displayName), olds);
          });
          const app = appId
            ? yield* getService({ serviceId: appId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : yield* findAppInProject;
          if (!app) return undefined;
          const attrs = attrsFrom(app);
          return appId || provenOwned ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, fqn, news, output }) {
          yield* validateAppProps(news);
          const projectId = yield* resolveProjectId(news.project);
          const displayName = yield* createDisplayName(id, news.displayName);
          const logicalId = news.logicalId ?? fqn;
          const branch = yield* desiredBranchId(projectId, news);
          if (!branch.resolved) {
            return yield* new AppOperationFailed({
              message:
                news.branchGitName === undefined
                  ? `Prisma project '${projectId}' has no default branch to attach App '${displayName}'. Create or promote a default branch, or specify branchId/branchGitName.`
                  : `Prisma project '${projectId}' has no branch named '${news.branchGitName}' to attach App '${displayName}'.`,
            });
          }
          const appId = isPrismaDevId(output?.appId) ? undefined : output?.appId;
          let app: ObservedApp | undefined = appId
            ? yield* getService({ serviceId: appId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;
          if (!app) {
            const result = yield* createService({
              projectId,
              displayName,
              branchId: branch.id,
              ...(news.regionId === undefined ? {} : { regionId: news.regionId }),
              logicalId,
            }).pipe(
              // A replayed create would make a second App; the retry policy
              // cannot see the request, so opt out explicitly.
              Retry.none,
              Effect.map((response) => ({
                app: response.data,
                created: true,
              })),
              Effect.catchTag("Conflict", (conflict) =>
                Effect.gen(function* () {
                  if ((yield* findAppByLogicalId(projectId, logicalId, news)) !== undefined) {
                    return yield* Effect.fail(
                      logicalIdTaken(logicalId, branch.id, projectId, conflict),
                    );
                  }
                  const app = yield* findApp(projectId, displayName, news);
                  if (app && output?.appId !== undefined && app.id === output.appId) {
                    return { app, created: false };
                  }
                  return yield* new AppConflict({
                    message: `Prisma app '${displayName}' already exists on the requested branch but is not owned by this App resource. Import it with explicit adoption or choose a different display name.`,
                    cause: conflict,
                  });
                }),
              ),
            );
            app = result.app;
          }
          yield* ensureAppImmutableIdentity(
            app,
            projectId,
            news.regionId ?? output?.regionId ?? app.region.id,
          );
          const needsBranchSync = yield* branchNeedsSync(projectId, app, news);
          if (app.name !== displayName || needsBranchSync) {
            app = yield* updateService({
              serviceId: app.id,
              displayName,
              branchId: branch.id,
            }).pipe(Effect.map((response) => response.data));
          }
          if (app.logicalId !== logicalId) {
            // The API refuses to rebind a logical ID; it must be cleared first.
            if (app.logicalId) {
              app = yield* updateService({ serviceId: app.id, logicalId: null }).pipe(
                Effect.map((response) => response.data),
              );
            }
            // The API refuses logicalId in the same request as a branch
            // move, so it is set only after the move above.
            app = yield* updateService({ serviceId: app.id, logicalId }).pipe(
              Effect.map((response) => response.data),
              Effect.catchTag("Conflict", (conflict) =>
                Effect.fail(logicalIdTaken(logicalId, branch.id, projectId, conflict)),
              ),
            );
          }
          if (app.name !== displayName || app.branchId !== branch.id) {
            return yield* new AppUnexpectedResponse({
              message: `Prisma App '${app.id}' did not converge to display name '${displayName}' and branch '${branch.id ?? "null"}'. Refusing to persist mismatched App state.`,
            });
          }
          return attrsFrom(app);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.appId)) return;
          const app = yield* getService({ serviceId: output.appId }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
          if (!app) return;
          if (app.projectId !== output.projectId || app.region.id !== output.regionId) {
            return yield* new AppConflict({
              message: `Prisma App '${app.id}' no longer matches its persisted immutable project and region identity. Refusing to delete a mismatched App.`,
            });
          }
          yield* destroyApp(output.appId);
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(App, ["appId"], ({ id, fqn, news }) => ({
    appId: devId("app", id),
    name: news.displayName ?? id,
    projectId: attrOrString(news.project, "projectId"),
    regionId: news.regionId ?? "us-east-1",
    branchId: news.branchId ?? null,
    latestDeploymentId: null,
    appEndpointDomain: "localhost",
    createdAt: DEV_TIMESTAMP,
    logicalId: news.logicalId ?? fqn,
  }));

export const AppProvider = () =>
  ProviderLayer.dual(App, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
