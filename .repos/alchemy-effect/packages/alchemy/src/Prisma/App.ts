import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
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
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import { destroyApp } from "./ComputeLifecycle.ts";
import { ensureAppImmutableIdentity } from "./Internal/AppIdentity.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { App as ApiApp, PrismaRegionId } from "./Types.ts";

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
 */
export const App = Resource<App>("Prisma.App");

const desiredBranchId = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  props: Pick<AppProps, "branchId" | "branchGitName">,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return { resolved: true as const, id: props.branchId };
  }
  if (props.branchGitName !== undefined) {
    const branches = yield* client.listBranches(projectId, {
      gitName: props.branchGitName,
      limit: 100,
    });
    if (branches.length > 1) {
      return yield* Effect.fail(
        new Error(
          `Prisma returned multiple branches named '${props.branchGitName}' in project '${projectId}'; refusing an ambiguous App match.`,
        ),
      );
    }
    return branches[0]
      ? { resolved: true as const, id: branches[0].id }
      : { resolved: false as const };
  }
  const branches = yield* client.listBranches(projectId, { limit: 100 });
  const defaults = branches.filter((branch) => branch.isDefault);
  if (defaults.length > 1) {
    return yield* Effect.fail(
      new Error(
        `Prisma returned multiple default branches for project '${projectId}'; refusing an ambiguous App match.`,
      ),
    );
  }
  const defaultBranch = defaults[0];
  return defaultBranch
    ? { resolved: true as const, id: defaultBranch.id }
    : { resolved: false as const };
});

const createDisplayName = (id: string, displayName: string | undefined) =>
  displayName === undefined
    ? createPhysicalName({ id })
    : Effect.succeed(displayName);

const findApp = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  displayName: string,
  props: Pick<AppProps, "branchId" | "branchGitName">,
) {
  const candidates = (yield* client.listApps({
    projectId,
    limit: 100,
  })).filter((app) => app.name === displayName);
  if (candidates.length === 0) return undefined;
  const branch = yield* desiredBranchId(client, projectId, props);
  if (!branch.resolved) return undefined;
  const matches = candidates.filter((app) => app.branchId === branch.id);
  if (matches.length > 1) {
    return yield* Effect.fail(
      new Error(
        `Prisma returned multiple Apps named '${displayName}' on branch '${branch.id}' in project '${projectId}'; refusing an ambiguous ownership match.`,
      ),
    );
  }
  return matches[0];
});

const attrsFrom = (app: ApiApp): App["Attributes"] => ({
  appId: app.id,
  name: app.name,
  projectId: app.projectId,
  regionId: app.region.id,
  branchId: app.branchId,
  latestDeploymentId: app.latestDeploymentId,
  appEndpointDomain: app.appEndpointDomain,
  createdAt: app.createdAt,
});

const branchNeedsSync = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  app: ApiApp,
  props: AppProps,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return app.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    const branch = yield* desiredBranchId(client, projectId, props);
    return !branch.resolved || app.branchId !== branch.id;
  }
  const branch = yield* desiredBranchId(client, projectId, props);
  return !branch.resolved || branch.id !== app.branchId;
});

const validateAppProps = (props: AppProps) =>
  Effect.gen(function* () {
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* Effect.fail(
        new Error("branchId and branchGitName are mutually exclusive."),
      );
    }
    if (props.branchId === null || props.branchGitName === null) {
      return yield* Effect.fail(
        new Error(
          "Prisma.App requires an attached branch because the Management API cannot create an unassigned App atomically. Omit both fields to use the project default branch, or provide branchId/branchGitName.",
        ),
      );
    }
  });

const ProviderLive = () =>
  Provider.effect(
    App,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["appId"],
        list: () =>
          client.listApps().pipe(Effect.map((apps) => apps.map(attrsFrom))),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.appId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (concreteIdsChanged(oldProjectId, newProjectId)) {
            return { action: "replace" } as const;
          }
          if (isResolved(news.regionId) && news.regionId !== undefined) {
            const currentRegionId = output?.regionId ?? olds.regionId;
            if (
              currentRegionId !== undefined &&
              news.regionId !== currentRegionId
            ) {
              return yield* Effect.fail(
                new Error(
                  `Prisma App region is immutable and the Management API cannot atomically move an App without deleting its serving endpoint first. Create a second App with a different display name in the target region, cut traffic over, then remove this App.`,
                ),
              );
            }
          }
          const updateProps = {
            displayName: news.displayName,
            branchId: news.branchId,
            branchGitName: news.branchGitName,
          };
          if (!isResolved(updateProps)) return undefined;
          const resolvedUpdateProps = {
            ...(updateProps as Pick<
              AppProps,
              "displayName" | "branchId" | "branchGitName"
            >),
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
            client,
            newProjectId ?? output.projectId,
            resolvedUpdateProps,
          );
          return !branch.resolved || output.branchId !== branch.id
            ? ({ action: "update" } as const)
            : undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const appId = isPrismaDevId(output?.appId)
            ? undefined
            : output?.appId;
          const app = appId
            ? yield* client
                .getApp(appId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findApp(
                      client,
                      projectId,
                      yield* createDisplayName(id, olds.displayName),
                      olds,
                    )
                  : undefined;
              });
          if (!app) return undefined;
          const attrs = attrsFrom(app);
          return appId ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          yield* validateAppProps(news);
          const projectId = yield* resolveProjectId(news.project);
          const displayName = yield* createDisplayName(id, news.displayName);
          const branch = yield* desiredBranchId(client, projectId, news);
          if (!branch.resolved) {
            return yield* Effect.fail(
              new Error(
                news.branchGitName === undefined
                  ? `Prisma project '${projectId}' has no default branch to attach App '${displayName}'. Create or promote a default branch, or specify branchId/branchGitName.`
                  : `Prisma project '${projectId}' has no branch named '${news.branchGitName}' to attach App '${displayName}'.`,
              ),
            );
          }
          const appId = isPrismaDevId(output?.appId)
            ? undefined
            : output?.appId;
          let app = appId
            ? yield* client
                .getApp(appId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : undefined;
          if (!app) {
            const result = yield* client
              .createApp({
                projectId,
                displayName,
                regionId: news.regionId,
                branchId: branch.id,
                branchGitName: undefined,
              })
              .pipe(
                Effect.map((app: ApiApp) => ({
                  app,
                  created: true,
                })),
                Effect.catchIf(isConflict, (conflict) =>
                  findApp(client, projectId, displayName, news).pipe(
                    Effect.flatMap((app) =>
                      app &&
                      output?.appId !== undefined &&
                      app.id === output.appId
                        ? Effect.succeed({ app, created: false })
                        : Effect.fail(
                            new Error(
                              `Prisma app '${displayName}' already exists on the requested branch but is not owned by this App resource. Import it with explicit adoption or choose a different display name.`,
                              { cause: conflict },
                            ),
                          ),
                    ),
                  ),
                ),
              );
            app = result.app;
          }
          yield* ensureAppImmutableIdentity(
            app,
            projectId,
            news.regionId ?? output?.regionId ?? app.region.id,
          );
          const needsBranchSync = yield* branchNeedsSync(
            client,
            projectId,
            app,
            news,
          );
          if (app.name !== displayName || needsBranchSync) {
            app = yield* client.updateApp(app.id, {
              displayName,
              branchId: branch.id,
              branchGitName: undefined,
            });
          }
          if (app.name !== displayName || app.branchId !== branch.id) {
            return yield* Effect.fail(
              new Error(
                `Prisma App '${app.id}' did not converge to display name '${displayName}' and branch '${branch.id ?? "null"}'. Refusing to persist mismatched App state.`,
              ),
            );
          }
          return attrsFrom(app);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.appId)) return;
          const app = yield* client
            .getApp(output.appId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!app) return;
          if (
            app.projectId !== output.projectId ||
            app.region.id !== output.regionId
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma App '${app.id}' no longer matches its persisted immutable project and region identity. Refusing to delete a mismatched App.`,
              ),
            );
          }
          yield* destroyApp(client, output.appId);
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(App, ["appId"], ({ id, news }) => ({
    appId: devId("app", id),
    name: news.displayName ?? id,
    projectId: attrOrString(news.project, "projectId"),
    regionId: news.regionId ?? "us-east-1",
    branchId: news.branchId ?? null,
    latestDeploymentId: null,
    appEndpointDomain: "localhost",
    createdAt: DEV_TIMESTAMP,
  }));

export const AppProvider = () =>
  ProviderLayer.dual(App, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
