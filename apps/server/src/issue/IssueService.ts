/**
 * Issues across the workspace's projects, read through whichever tracker each project resolves
 * to. The service owns resolution and permission; trackers own their APIs.
 *
 * Resolution: a git-host project resolves to the tracker of the same kind as its remote, with the
 * remote's host and `owner/repo` as the scope. A project bound to a standalone tracker (Linear,
 * Jira) in settings resolves to that too, beside the git host's: a GitHub repository whose work
 * is planned in Linear lists both, and a reference names which by its `tracker`.
 *
 * An issue whose scope is not any project's own can still be read through a project on the same
 * tracker and host — a frontend project reading a backend issue, or an external URL — but is
 * read-only: every write checks `writable` first.
 *
 * @module issue/IssueService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  issueListCursorKey,
  issueHostKey,
  issueScopeKeyOf,
  issueTrackerHostKey,
  IssueOperationError,
  IssueTrackerKind,
  IssueUnavailableError,
  pullRequestHostOf,
  SourceControlProviderKind,
  type IssueCandidates,
  type IssueDependenciesInput,
  type IssueDependenciesPage,
  type IssueSetDependencyInput,
  type IssueCandidatesInput,
  type IssueAssigneeCandidatesPage,
  type IssueEditCommentInput,
  type IssueHierarchyPage,
  type IssueHistoryPage,
  type IssueHistoryInput,
  type IssueLabelCandidatesPage,
  type IssueLinkedPullRequestsPage,
  type IssuePageRef,
  type IssueScopePageRef,
  type IssueSetParentInput,
  type IssueCommentInput,
  type IssueCommentsPage,
  type IssueCommentsPageInput,
  type IssueCreateInput,
  type IssueCreateResult,
  type IssueDetail,
  type IssueError,
  type IssueListEntry,
  type IssueListInput,
  type IssueListProjectError,
  type IssueListResult,
  type IssueReactionInput,
  type IssueRef,
  type IssueScopeRef,
  type IssueSetStateInput,
  type IssueTemplateList,
  type IssueTemplatesInput,
  type IssueTrackerSummary,
  type IssueTrackerProjectBinding,
  type IssueUpdateInput,
  type IssueViewerPermissions,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { azureDevOpsIssueScope, parseIssueUrl } from "@t3tools/shared/issueUrl";
import { parseForgejoRemote } from "@t3tools/source-control-forgejo/server/ForgejoCli";
import {
  IssueTrackerError,
  isStandaloneIssueTracker,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const DEFAULT_LIST_LIMIT = 50;
const SCOPE_CONCURRENCY = 4;

/** One project's resolved tracker: which driver, where it is served from, and its container. */
export interface ProjectTrackerBinding {
  readonly tracker: IssueTrackerKind;
  readonly host: string;
  readonly scope: string;
  readonly connectionId?: string | undefined;
}

/** A project the registry has a tracker for, ready to serve reads and writes. */
interface SupportedProject extends ProjectTrackerBinding {
  readonly project: OrchestrationProjectShell;
  readonly api: IssueTrackerApi;
}

/**
 * Azure work items belong to the project, not the repository, so the scope is
 * `organization/project` out of the remote's `organization/project/_git/repository` path. The
 * source control selector answers only the repository name there, which addresses no work item.
 */
function azureDevOpsProjectScope(host: string, displayName: string | undefined): string | null {
  const segments = (displayName ?? "").split("/").filter((part) => part.length > 0);
  const marker = segments.indexOf("_git");
  const authority = URL.parse("https://" + host);
  if (
    authority === null ||
    authority.username ||
    authority.password ||
    authority.pathname !== "/" ||
    authority.search ||
    authority.hash
  )
    return null;
  if (authority.hostname.endsWith(".visualstudio.com")) {
    if (marker !== 1 && !(marker === 2 && segments[0]?.toLowerCase() === "defaultcollection"))
      return null;
    const project = segments[marker - 1];
    return project
      ? azureDevOpsIssueScope(authority.hostname.slice(0, -".visualstudio.com".length), project)
      : null;
  }
  const [organization, project] = marker === 2 ? segments : [];
  return organization && project ? azureDevOpsIssueScope(organization, project) : null;
}

/**
 * The git-host path of resolution: the tracker is the host's own, named like the remote's
 * provider kind. Null for a project with no remote or a kind no tracker claims.
 */
export function resolveGitHostBinding(
  project: OrchestrationProjectShell,
): ProjectTrackerBinding | null {
  const identity = project.repositoryIdentity;
  const kind = identity?.provider;
  if (!identity || kind === undefined || kind === "unknown") return null;
  if (kind === "forgejo" && identity.webUrl !== undefined) {
    const remote = parseForgejoRemote(identity.webUrl);
    if (remote !== null)
      return {
        tracker: IssueTrackerKind.make(kind),
        host: remote.host,
        scope: issueScopeKeyOf({ tracker: kind, scope: remote.path }),
      };
  }
  let host = pullRequestHostOf(identity, SourceControlProviderKind.make(kind));
  if (kind === "gitlab") {
    const remote = URL.parse(identity.locator.remoteUrl);
    if (remote?.protocol === "http:" || remote?.protocol === "https:")
      host = remote.host.toLowerCase();
  }
  const scope =
    kind === "azure-devops"
      ? azureDevOpsProjectScope(host, identity.displayName)
      : sourceControlRepositorySelector(identity);
  if (scope === null) return null;
  return {
    tracker: IssueTrackerKind.make(kind),
    host,
    scope,
  };
}

function isTrackerUnusable(error: IssueTrackerError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

function toIssueError(operation: string): (error: IssueTrackerError) => IssueError {
  return (error) =>
    isTrackerUnusable(error)
      ? new IssueUnavailableError({
          reason: error.reason === "missing-tool" ? "tool-missing" : "unauthenticated",
          tracker: error.tracker,
          cause: error,
        })
      : new IssueOperationError({
          operation,
          detail: error.detail,
          ...(error.reason === "not-found" || error.reason === "rate-limited"
            ? { reason: error.reason }
            : {}),
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          cause: error,
        });
}

const readOnly = (operation: string) =>
  new IssueOperationError({
    operation,
    reason: "read-only",
    detail:
      "This issue belongs to a repository outside the selected project and cannot be changed from here.",
  });

const unsupported = (operation: string, what: string) =>
  new IssueOperationError({ operation, detail: `This tracker does not support ${what}.` });

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly sources: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ProjectTrackerBinding>, IssueError>;
    readonly listSources: (input: {
      readonly projectId?: ProjectId | undefined;
      readonly tracker?: IssueTrackerKind | undefined;
      readonly host?: string | undefined;
      readonly scope?: string | undefined;
      readonly connectionId?: string | undefined;
    }) => Effect.Effect<NonNullable<IssueListResult["sources"]>, IssueError>;
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly comments: (
      input: IssueCommentsPageInput,
    ) => Effect.Effect<IssueCommentsPage, IssueError>;
    readonly history: (input: IssueHistoryInput) => Effect.Effect<IssueHistoryPage, IssueError>;
    readonly linkedPullRequests: (
      input: IssuePageRef,
    ) => Effect.Effect<IssueLinkedPullRequestsPage, IssueError>;
    readonly dependencies: (
      input: IssueDependenciesInput,
    ) => Effect.Effect<IssueDependenciesPage, IssueError>;
    readonly setDependency: (input: IssueSetDependencyInput) => Effect.Effect<void, IssueError>;
    readonly hierarchy: (input: IssuePageRef) => Effect.Effect<IssueHierarchyPage, IssueError>;
    readonly labelCandidates: (
      input: IssueScopePageRef,
    ) => Effect.Effect<IssueLabelCandidatesPage, IssueError>;
    readonly assigneeCandidates: (
      input: IssueScopePageRef,
    ) => Effect.Effect<IssueAssigneeCandidatesPage, IssueError>;
    readonly editComment: (input: IssueEditCommentInput) => Effect.Effect<void, IssueError>;
    readonly setParent: (input: IssueSetParentInput) => Effect.Effect<void, IssueError>;
    readonly templates: (
      input: IssueTemplatesInput,
    ) => Effect.Effect<IssueTemplateList, IssueError>;
    readonly candidates: (
      input: IssueCandidatesInput,
    ) => Effect.Effect<IssueCandidates, IssueError>;
    readonly create: (input: IssueCreateInput) => Effect.Effect<IssueCreateResult, IssueError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueError>;
    readonly update: (input: IssueUpdateInput) => Effect.Effect<void, IssueError>;
    readonly setState: (input: IssueSetStateInput) => Effect.Effect<void, IssueError>;
    readonly react: (input: IssueReactionInput) => Effect.Effect<void, IssueError>;
    /**
     * The reference behind an issue URL: served by the project whose binding is that host and
     * scope, else read-only through any project on the same tracker and host. `preferredProjectId`
     * wins among equals, so a thread's own project serves its own issues.
     */
    readonly resolveUrl: (
      url: string,
      preferredProjectId?: ProjectId,
      connectionId?: string,
    ) => Effect.Effect<
      IssueRef & { readonly host: string; readonly writable: boolean },
      IssueError
    >;
  }
>()("t3/issue/IssueService") {}

export const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;

  /**
   * The standalone tracker a project is bound to in settings, as a binding like the git host's.
   * Read fresh per resolution so a binding saved in Settings applies without a restart; a binding
   * to a tracker this build does not ship is dropped rather than reported, since there is nothing
   * the user can do about it here.
   */
  const resolveStandaloneBindings = (
    project: OrchestrationProjectShell,
    bound: ReadonlyMap<ProjectId, ReadonlyArray<IssueTrackerProjectBinding>>,
  ): ReadonlyArray<ProjectTrackerBinding> =>
    (bound.get(project.id) ?? []).flatMap((binding) => {
      const api = registry.get(binding.tracker);
      if (api === null || !isStandaloneIssueTracker(api)) return [];
      const host = binding.host ?? api.standalone.host;
      return host === null
        ? []
        : [
            {
              tracker: binding.tracker,
              host: issueHostKey(host),
              scope: binding.scope,
              ...(binding.connectionId === undefined ? {} : { connectionId: binding.connectionId }),
            },
          ];
    });

  const resolveProjectTracker = (
    project: OrchestrationProjectShell,
    bound: ReadonlyMap<ProjectId, ReadonlyArray<IssueTrackerProjectBinding>>,
    refreshRepository = false,
  ): Effect.Effect<ReadonlyArray<ProjectTrackerBinding>> =>
    (refreshRepository
      ? repositoryIdentities.resolve(project.workspaceRoot, { refresh: true })
      : project.repositoryIdentity != null
        ? Effect.succeed(project.repositoryIdentity)
        : repositoryIdentities.resolve(project.workspaceRoot)
    ).pipe(
      Effect.map((repositoryIdentity) => {
        const git = resolveGitHostBinding({ ...project, repositoryIdentity });
        return [...(git === null ? [] : [git]), ...resolveStandaloneBindings(project, bound)];
      }),
    );

  const withConnection = (project: ProjectTrackerBinding) =>
    Effect.provideService(IssueTrackerHost.ConnectionId, project.connectionId);
  const accountFields = (project: ProjectTrackerBinding) =>
    project.connectionId === undefined ? {} : { connectionId: project.connectionId };
  const trackerKeyOf = (project: ProjectTrackerBinding) =>
    project.connectionId === undefined
      ? issueTrackerHostKey(project)
      : issueListCursorKey({ ...project, scope: "" });

  const listProjects = (filter: {
    readonly projectId?: IssueListInput["projectId"];
    readonly host?: string | undefined;
    readonly refreshRepository?: boolean;
    readonly connectionId?: string | undefined;
  }) =>
    (filter.projectId === undefined
      ? projects.listShells()
      : projects.getShell(filter.projectId).pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IssueOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause,
          }),
      ),
      Effect.flatMap((shells) =>
        bindings.list.pipe(
          Effect.orElseSucceed(
            () => new Map<ProjectId, ReadonlyArray<IssueTrackerProjectBinding>>(),
          ),
          Effect.flatMap((bound) =>
            Effect.forEach(
              shells,
              (project) =>
                resolveProjectTracker(project, bound, filter.refreshRepository).pipe(
                  Effect.map((bindings) => bindings.map((binding) => ({ project, ...binding }))),
                ),
              { concurrency: SCOPE_CONCURRENCY },
            ),
          ),
        ),
      ),
      Effect.map((bound) => {
        const host = filter.host === undefined ? undefined : issueHostKey(filter.host);
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { tracker: IssueTrackerKind; host: string; projectCount: number }
        >();
        for (const candidate of bound.flat()) {
          if (host !== undefined && candidate.host !== host) continue;
          if (filter.connectionId !== undefined && candidate.connectionId !== filter.connectionId)
            continue;
          const api = registry.get(candidate.tracker);
          if (api === null) {
            const key = issueTrackerHostKey(candidate);
            const counted = unimplemented.get(key);
            if (counted === undefined)
              unimplemented.set(key, {
                tracker: candidate.tracker,
                host: candidate.host,
                projectCount: 1,
              });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({ ...candidate, api });
        }
        return { supported, unimplemented };
      }),
    );

  /**
   * The project whose checkout and credentials serve a reference, and whether the reference is
   * the project's own scope. A reference naming another scope on the same tracker and host is
   * served by the project but marked read-only. A project with two trackers serves the one the
   * reference names.
   */
  const requireProject = (
    ref: IssueScopeRef,
    refreshRepository = false,
  ): Effect.Effect<SupportedProject & { readonly writable: boolean }, IssueError> =>
    listProjects({ projectId: ref.projectId, refreshRepository }).pipe(
      Effect.flatMap(({ supported }) => {
        const own = supported.find((candidate) => candidate.tracker === ref.tracker);
        if (own === undefined || own.connectionId !== ref.connectionId) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        const host = ref.host === undefined ? own.host : issueHostKey(ref.host);
        if (host !== own.host) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        const scope = ref.scope.trim();
        const writable =
          !(own.tracker === "gitlab" && scope.toLowerCase().startsWith("group:")) &&
          issueScopeKeyOf({ tracker: own.tracker, scope }) === issueScopeKeyOf(own);
        if (
          own.tracker === "linear" &&
          own.scope.includes("/") &&
          (!scope.includes("/") ||
            scope.split("/")[0]?.toLowerCase() !== own.scope.split("/")[0]?.toLowerCase())
        ) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        return Effect.succeed({ ...own, scope, writable });
      }),
    );

  const requireWritable = (ref: IssueScopeRef, operation: string, refreshRepository = false) => {
    const api = registry.get(ref.tracker);
    return requireProject(
      ref,
      refreshRepository && api !== null && !isStandaloneIssueTracker(api),
    ).pipe(
      Effect.flatMap((project) =>
        project.writable ? Effect.succeed(project) : Effect.fail(readOnly(operation)),
      ),
    );
  };

  const requirePermissions = (
    project: SupportedProject,
    ref: IssueRef,
    operation: string,
    allowed: (permissions: IssueViewerPermissions) => boolean,
  ) =>
    project.api
      .getViewerPermissions({
        cwd: project.project.workspaceRoot,
        host: project.host,
        scope: project.scope,
        key: ref.key,
      })
      .pipe(
        withConnection(project),
        Effect.mapError(toIssueError(operation)),
        Effect.flatMap((permissions) =>
          !allowed(permissions)
            ? Effect.fail(
                new IssueOperationError({
                  operation,
                  detail: "The signed-in account cannot make this change.",
                }),
              )
            : requireWritable(ref, operation, !isStandaloneIssueTracker(project.api)).pipe(
                Effect.flatMap((current) =>
                  current.tracker === project.tracker &&
                  current.host === project.host &&
                  current.scope === project.scope &&
                  current.connectionId === project.connectionId &&
                  current.project.workspaceRoot === project.project.workspaceRoot
                    ? Effect.void
                    : Effect.fail(readOnly(operation)),
                ),
              ),
        ),
      );

  const sources: IssueService["Service"]["sources"] = (projectId) =>
    listProjects({ projectId }).pipe(
      Effect.map(({ supported }) =>
        supported.map((project) => ({
          tracker: project.tracker,
          host: project.host,
          scope: project.scope,
          ...accountFields(project),
        })),
      ),
    );

  const listSources: IssueService["Service"]["listSources"] = (input) =>
    listProjects(input).pipe(
      Effect.map(({ supported }) =>
        supported
          .filter(
            (project) =>
              (input.tracker === undefined || project.tracker === input.tracker) &&
              (input.scope === undefined ||
                issueScopeKeyOf(project) ===
                  issueScopeKeyOf({ tracker: project.tracker, scope: input.scope })),
          )
          .map(({ project, api, tracker, host, scope, connectionId }) => ({
            ...(connectionId === undefined ? {} : { connectionId }),
            projectId: project.id,
            projectTitle: project.title,
            tracker,
            host,
            scope,
            capabilities: api.capabilities,
          })),
      ),
    );

  const list: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* listProjects(input);
      let supported = resolved.supported.filter(
        (project) => input.tracker === undefined || project.tracker === input.tracker,
      );
      const unimplemented = new Map(
        [...resolved.unimplemented].filter(
          ([, source]) => input.tracker === undefined || source.tracker === input.tracker,
        ),
      );
      if (input.scope !== undefined) {
        const scope = input.scope;
        const own = supported.filter(
          (project) =>
            issueScopeKeyOf(project) === issueScopeKeyOf({ tracker: project.tracker, scope }),
        );
        const lenders =
          own.length > 0
            ? own
            : supported.filter(
                (project) =>
                  !isStandaloneIssueTracker(project.api) &&
                  (project.tracker !== "forgejo" ||
                    issueScopeKeyOf(project).split("/").slice(0, -2).join("/") ===
                      issueScopeKeyOf({ tracker: project.tracker, scope })
                        .split("/")
                        .slice(0, -2)
                        .join("/")),
              );
        if (lenders.length === 0)
          return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
        if (new Set(lenders.map(trackerKeyOf)).size > 1)
          return yield* new IssueOperationError({
            operation: "list",
            detail: "Choose one tracker, host and saved account for this scope.",
          });
        supported =
          own.length > 0
            ? own
            : lenders.map((project) => ({
                ...project,
                scope: issueScopeKeyOf({ tracker: project.tracker, scope }),
              }));
      }
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      // Worktrees of one repository are separate projects; read each scope once.
      const scopes = new Map<string, SupportedProject>();
      for (const project of supported) {
        const key = issueListCursorKey(project);
        if (!scopes.has(key)) scopes.set(key, project);
      }
      const continuing = input.cursors === undefined ? undefined : { ...input.cursors };
      if (continuing !== undefined) {
        const legacySources =
          input.projectId !== undefined &&
          [...scopes.values()].some(
            (project) => continuing[`${project.host} ${project.scope}`] !== undefined,
          )
            ? yield* listProjects({ host: input.host })
            : { supported, unimplemented };
        const trackersByHost = new Map<string, Set<IssueTrackerKind>>();
        for (const source of [
          ...legacySources.supported,
          ...legacySources.unimplemented.values(),
        ]) {
          const kinds = trackersByHost.get(source.host) ?? new Set<IssueTrackerKind>();
          kinds.add(source.tracker);
          trackersByHost.set(source.host, kinds);
        }
        for (const [key, project] of scopes) {
          if (project.connectionId !== undefined) continue;
          const legacy = continuing[`${project.host} ${project.scope}`];
          if (legacy === undefined || continuing[key] !== undefined) continue;
          if (trackersByHost.get(project.host)!.size > 1)
            return yield* new IssueOperationError({
              operation: "list",
              detail: "This issue cursor does not identify one tracker. Refresh the issue list.",
            });
          continuing[key] = legacy;
        }
      }
      const viewers = new Map<string, string>();
      const viewerReads = new Map<string, Effect.Effect<string, IssueTrackerError>>();
      const viewerKeyOf = (project: SupportedProject) =>
        project.tracker === "azure-devops"
          ? issueListCursorKey({
              ...project,
              host: new URL("https://" + project.host).host,
              scope: issueScopeKeyOf(project).split("/")[0] ?? "",
            })
          : project.tracker === "forgejo"
            ? issueListCursorKey({
                ...project,
                scope: issueScopeKeyOf(project).split("/").slice(0, -2).join("/"),
              })
            : trackerKeyOf(project);
      const viewerInstances = new Map<string, Set<string>>();
      for (const project of supported) {
        const hostKey = issueTrackerHostKey(project);
        const instances = viewerInstances.get(hostKey) ?? new Set<string>();
        instances.add(viewerKeyOf(project));
        viewerInstances.set(hostKey, instances);
      }
      const trackers = new Map<string, IssueTrackerSummary>();
      const entries: IssueListEntry[] = [];
      const errors: IssueListProjectError[] = [];
      const nextCursors: Record<string, string> = {};

      const viewerFor = (project: SupportedProject) =>
        Effect.gen(function* () {
          const key = viewerKeyOf(project);
          let read = viewerReads.get(key);
          if (read === undefined) {
            read = yield* Effect.cached(
              project.api
                .getViewer({
                  cwd: project.project.workspaceRoot,
                  host: project.host,
                  ...(project.tracker === "azure-devops" ? { scope: project.scope } : {}),
                })
                .pipe(withConnection(project)),
            );
            viewerReads.set(key, read);
          }
          const viewer = yield* read;
          if (
            project.tracker === "forgejo" ||
            project.tracker === "azure-devops" ||
            project.connectionId !== undefined ||
            viewerInstances.get(issueTrackerHostKey(project))!.size > 1
          )
            viewers.set(issueListCursorKey(project), viewer);
          const hostKey = issueTrackerHostKey(project);
          if (viewerInstances.get(hostKey)!.size === 1) viewers.set(hostKey, viewer);
          return viewer;
        });

      // Every project counts, including worktrees of a scope read once below.
      for (const project of supported) {
        const existing = trackers.get(trackerKeyOf(project));
        trackers.set(
          trackerKeyOf(project),
          existing === undefined
            ? {
                tracker: project.tracker,
                ...accountFields(project),
                host: project.host,
                projectCount: 1,
                capabilities: project.api.capabilities,
                configured: true,
                detail: null,
              }
            : { ...existing, projectCount: existing.projectCount + 1 },
        );
      }
      const recordFailure = (project: SupportedProject, failure: IssueTrackerError) => {
        const existing = trackers.get(trackerKeyOf(project));
        if (existing !== undefined && isTrackerUnusable(failure))
          trackers.set(trackerKeyOf(project), {
            ...existing,
            configured: false,
            detail: failure.detail,
          });
      };

      yield* Effect.forEach(
        scopes,
        ([key, project]) =>
          Effect.gen(function* () {
            // A continuation names the scopes it wants; one not named has nothing to add.
            if (continuing !== undefined && continuing[key] === undefined) return;
            const involvement = input.involvement ?? "all";
            if (
              project.api.capabilities.involvements !== undefined &&
              !project.api.capabilities.involvements.includes(involvement)
            ) {
              errors.push({
                projectId: project.project.id,
                projectTitle: project.project.title,
                tracker: project.tracker,
                ...accountFields(project),
                host: project.host,
                message: `This tracker does not support ${involvement} issue lists.`,
              });
              return;
            }
            const unsupportedSort =
              input.sort !== undefined &&
              project.api.capabilities.listSorts !== undefined &&
              !project.api.capabilities.listSorts.includes(input.sort);
            const unsupportedOrder =
              input.order !== undefined &&
              project.api.capabilities.listOrders !== undefined &&
              !project.api.capabilities.listOrders.includes(input.order);
            if (unsupportedSort || unsupportedOrder) {
              errors.push({
                projectId: project.project.id,
                projectTitle: project.project.title,
                tracker: project.tracker,
                ...accountFields(project),
                host: project.host,
                message: "This tracker does not support the selected issue order.",
              });
              return;
            }
            const cursor = continuing?.[key];
            const page = yield* viewerFor(project).pipe(
              Effect.flatMap((viewer) =>
                project.api
                  .listIssues({
                    cwd: project.project.workspaceRoot,
                    host: project.host,
                    scope: project.scope,
                    state: input.state,
                    ...(input.stateCategories === undefined
                      ? {}
                      : { stateCategories: input.stateCategories }),
                    ...(input.sort === undefined ? {} : { sort: input.sort }),
                    ...(input.order === undefined ? {} : { order: input.order }),
                    involvement,
                    viewer,
                    limit,
                    query: input.query,
                    cursor,
                  })
                  .pipe(withConnection(project)),
              ),
              Effect.result,
            );
            if (page._tag === "Failure") {
              recordFailure(project, page.failure);
              errors.push({
                projectId: project.project.id,
                projectTitle: project.project.title,
                tracker: project.tracker,
                ...accountFields(project),
                host: project.host,
                message: page.failure.detail,
              });
              return;
            }
            for (const item of page.success.items) {
              entries.push({
                ...item,
                tracker: project.tracker,
                ...accountFields(project),
                host: project.host,
                scope: project.scope,
                projectId: project.project.id,
                projectTitle: project.project.title,
              });
            }
            if (page.success.nextCursor !== null) nextCursors[key] = page.success.nextCursor;
          }),
        { concurrency: SCOPE_CONCURRENCY, discard: true },
      );

      for (const source of unimplemented.values()) {
        const { host, tracker, projectCount } = source;
        trackers.set(issueTrackerHostKey(source), {
          tracker,
          host,
          projectCount,
          capabilities: null,
          configured: false,
          detail: "Issues cannot be browsed for this host yet.",
        });
      }
      entries.sort((a, b) => {
        const difference =
          input.sort === "comments"
            ? (b.commentCount ?? 0) - (a.commentCount ?? 0)
            : input.sort === "created"
              ? b.createdAt.localeCompare(a.createdAt)
              : b.updatedAt.localeCompare(a.updatedAt);
        return input.order === "asc" ? -difference : difference;
      });
      return {
        sources: supported.map((project) => ({
          projectId: project.project.id,
          projectTitle: project.project.title,
          tracker: project.tracker,
          ...accountFields(project),
          host: project.host,
          scope: project.scope,
          capabilities: project.api.capabilities,
        })),
        viewers: Object.fromEntries(viewers),
        trackers: [...trackers.values()],
        entries,
        errors,
        nextCursors,
      };
    });

  const detail: IssueService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getIssue({
            ...accountFields(project),
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
          })
          .pipe(
            withConnection(project),
            Effect.mapError(toIssueError("detail")),
            Effect.map((issue): IssueDetail => ({
              ...issue,
              tracker: project.tracker,
              ...accountFields(project),
              host: project.host,
              scope: project.scope,
              projectId: project.project.id,
              projectTitle: project.project.title,
              writable: project.writable,
              capabilities: issue.capabilities ?? project.api.capabilities,
            })),
          ),
      ),
    );

  const comments: IssueService["Service"]["comments"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getComments({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
            ...accountFields(project),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            order: input.order ?? "desc",
            ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
          })
          .pipe(withConnection(project), Effect.mapError(toIssueError("comments"))),
      ),
    );

  const history: IssueService["Service"]["history"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.getHistory === undefined || !project.api.capabilities.events
          ? Effect.fail(unsupported("history", "issue history"))
          : project.api
              .getHistory({
                ...accountFields(project),
                order: input.order ?? "desc",
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                limit: input.limit ?? DEFAULT_LIST_LIMIT,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("history"))),
      ),
    );

  const linkedPullRequests: IssueService["Service"]["linkedPullRequests"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.getLinkedPullRequests === undefined ||
        !project.api.capabilities.linkedPullRequests
          ? Effect.fail(unsupported("linkedPullRequests", "linked pull requests"))
          : project.api
              .getLinkedPullRequests({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                limit: input.limit ?? DEFAULT_LIST_LIMIT,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("linkedPullRequests"))),
      ),
    );

  const dependencies: IssueService["Service"]["dependencies"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.getDependencies === undefined || !project.api.capabilities.dependencies
          ? Effect.fail(unsupported("dependencies", "dependencies"))
          : project.api
              .getDependencies({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                direction: input.direction,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("dependencies"))),
      ),
    );

  const setDependency: IssueService["Service"]["setDependency"] = (input) =>
    Effect.gen(function* () {
      const project = yield* requireWritable(input, "setDependency");
      if (project.api.setDependency === undefined || !project.api.capabilities.dependencies)
        return yield* unsupported("setDependency", "dependencies");
      yield* requirePermissions(
        project,
        input,
        "setDependency",
        (permissions) => permissions.updateDependencies ?? permissions.edit,
      );
      yield* project.api
        .setDependency({
          cwd: project.project.workspaceRoot,
          host: project.host,
          scope: project.scope,
          key: input.key,
          direction: input.direction,
          targetScope: input.targetScope,
          targetKey: input.targetKey,
          linked: input.linked,
        })
        .pipe(withConnection(project), Effect.mapError(toIssueError("setDependency")));
    });

  const hierarchy: IssueService["Service"]["hierarchy"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.getHierarchy === undefined || !project.api.capabilities.subIssues
          ? Effect.fail(unsupported("hierarchy", "sub-issues"))
          : project.api
              .getHierarchy({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                limit: input.limit ?? DEFAULT_LIST_LIMIT,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("hierarchy"))),
      ),
    );

  const labelCandidates: IssueService["Service"]["labelCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listLabelCandidates === undefined || !project.api.capabilities.labels
          ? Effect.fail(unsupported("labelCandidates", "label choices"))
          : project.api
              .listLabelCandidates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                limit: input.limit ?? DEFAULT_LIST_LIMIT,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("labelCandidates"))),
      ),
    );

  const assigneeCandidates: IssueService["Service"]["assigneeCandidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listAssigneeCandidates === undefined || !project.api.capabilities.assignees
          ? Effect.fail(unsupported("assigneeCandidates", "assignee choices"))
          : project.api
              .listAssigneeCandidates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                limit: input.limit ?? DEFAULT_LIST_LIMIT,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("assigneeCandidates"))),
      ),
    );

  const templates: IssueService["Service"]["templates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listTemplates === undefined || !project.api.capabilities.templates
          ? Effect.fail(unsupported("templates", "issue templates"))
          : project.api
              .listTemplates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                ...(input.metadataOnly === undefined ? {} : { metadataOnly: input.metadataOnly }),
                ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("templates"))),
      ),
    );

  const candidates: IssueService["Service"]["candidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listCandidates === undefined ||
        !(
          project.api.capabilities.labels ||
          project.api.capabilities.assignees ||
          project.api.capabilities.createIssueTypes ||
          project.api.capabilities.createFields ||
          project.api.capabilities.stateFields
        )
          ? Effect.fail(unsupported("candidates", "labels, assignees, or issue types"))
          : project.api
              .listCandidates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                ...(input.key === undefined ? {} : { key: input.key }),
                ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("candidates"))),
      ),
    );

  const create: IssueService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const project = yield* requireWritable(input, "create", true);
      const { capabilities } = project.api;
      if (project.api.create === undefined || !capabilities.create)
        return yield* unsupported("create", "filing issues");
      if (input.fieldValues !== undefined && !capabilities.createFields)
        return yield* unsupported("create", "native create fields");
      if (input.issueType !== undefined && !capabilities.createIssueTypes)
        return yield* unsupported("create", "selecting an issue type");
      if (input.parentKey !== undefined && !capabilities.createSubIssue)
        return yield* unsupported("create", "creating sub-issues");
      if (input.templateKey !== undefined && !capabilities.templates)
        return yield* unsupported("create", "issue templates");
      if (
        capabilities.maxAssignees !== undefined &&
        input.assignees.length > capabilities.maxAssignees
      )
        return yield* new IssueOperationError({
          operation: "create",
          detail: "The issue has more assignees than this tracker allows.",
        });
      return yield* project.api
        .create({
          cwd: project.project.workspaceRoot,
          host: project.host,
          scope: project.scope,
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees,
          ...(input.fieldValues === undefined ? {} : { fieldValues: input.fieldValues }),
          ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
          ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
          ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
        })
        .pipe(withConnection(project), Effect.mapError(toIssueError("create")));
    });

  const comment: IssueService["Service"]["comment"] = (input) =>
    requireWritable(input, "comment").pipe(
      Effect.flatMap((project) => {
        if (input.body.trim().length === 0) {
          return Effect.fail(
            new IssueOperationError({ operation: "comment", detail: "A comment needs some text." }),
          );
        }
        return project.api.comment === undefined || !project.api.capabilities.comment
          ? Effect.fail(unsupported("comment", "comments"))
          : requirePermissions(
              project,
              input,
              "comment",
              (permissions) => permissions.comment,
            ).pipe(
              Effect.andThen(
                project.api
                  .comment({
                    cwd: project.project.workspaceRoot,
                    host: project.host,
                    scope: project.scope,
                    key: input.key,
                    body: input.body,
                  })
                  .pipe(withConnection(project), Effect.mapError(toIssueError("comment"))),
              ),
            );
      }),
    );

  const update: IssueService["Service"]["update"] = (input) =>
    requireWritable(input, "update").pipe(
      Effect.flatMap((project) => {
        const { capabilities } = project.api;
        const wantsWords =
          input.title !== undefined || input.body !== undefined || input.richBody !== undefined;
        if (!wantsWords && input.labels === undefined && input.assignees === undefined) {
          return Effect.fail(
            new IssueOperationError({ operation: "update", detail: "Nothing to change." }),
          );
        }
        if (project.api.update === undefined) return Effect.fail(unsupported("update", "edits"));
        if (wantsWords && !capabilities.edit)
          return Effect.fail(unsupported("update", "editing the title or body"));
        if (input.richBody !== undefined && !capabilities.richText)
          return Effect.fail(unsupported("update", "rich text"));
        if (input.labels !== undefined && !capabilities.labels)
          return Effect.fail(unsupported("update", "labels"));
        if (input.assignees !== undefined && !capabilities.assignees)
          return Effect.fail(unsupported("update", "assignees"));
        if (
          input.assignees !== undefined &&
          capabilities.maxAssignees !== undefined &&
          input.assignees.length > capabilities.maxAssignees
        )
          return Effect.fail(
            new IssueOperationError({
              operation: "update",
              detail: "The issue has more assignees than this tracker allows.",
            }),
          );
        return requirePermissions(
          project,
          input,
          "update",
          (permissions) =>
            (!wantsWords || permissions.edit) &&
            (input.labels === undefined || permissions.labels) &&
            (input.assignees === undefined || permissions.assignees),
        ).pipe(
          Effect.andThen(
            project.api
              .update({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                title: input.title,
                body: input.body,
                ...(input.richBody === undefined ? {} : { richBody: input.richBody }),
                labels: input.labels,
                assignees: input.assignees,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("update"))),
          ),
        );
      }),
    );

  const setState: IssueService["Service"]["setState"] = (input) =>
    requireWritable(input, "setState").pipe(
      Effect.flatMap((project) => {
        const { capabilities } = project.api;
        const target = capabilities.states.find(
          (state) => state.name === input.state || state.id === input.state,
        );
        if (
          (input.fieldValues !== undefined || input.transitionId !== undefined) &&
          !capabilities.stateFields
        )
          return Effect.fail(unsupported("setState", "native transition fields"));
        if (project.api.setState === undefined)
          return Effect.fail(unsupported("setState", `the state "${input.state}"`));
        if (
          input.closeReason !== undefined &&
          (target?.category !== "closed" || !capabilities.closeReasons.includes(input.closeReason))
        )
          return Effect.fail(unsupported("setState", `the close reason "${input.closeReason}"`));
        return requirePermissions(
          project,
          input,
          "setState",
          (permissions) => permissions.setState,
        ).pipe(
          Effect.andThen(
            project.api
              .setState({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                state: input.state,
                ...(input.transitionId === undefined ? {} : { transitionId: input.transitionId }),
                ...(input.fieldValues === undefined ? {} : { fieldValues: input.fieldValues }),
                closeReason: input.closeReason,
              })
              .pipe(withConnection(project), Effect.mapError(toIssueError("setState"))),
          ),
        );
      }),
    );

  const react: IssueService["Service"]["react"] = (input) =>
    Effect.gen(function* () {
      const api = registry.get(input.tracker);
      if (api === null) return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      const { capabilities } = api;
      const supported =
        input.subjectId === undefined
          ? capabilities.reactions
          : (capabilities.commentReactions ?? capabilities.reactions);
      if (api.setReaction === undefined || !supported)
        return yield* unsupported("react", "reactions");
      if (
        capabilities.reactionContents !== undefined &&
        !capabilities.reactionContents.includes(input.content)
      )
        return yield* unsupported("react", `the reaction "${input.content}"`);
      const project = yield* requireWritable(input, "react", true);
      yield* api
        .setReaction({
          cwd: project.project.workspaceRoot,
          host: project.host,
          scope: project.scope,
          key: input.key,
          subjectId: input.subjectId,
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(withConnection(project), Effect.mapError(toIssueError("react")));
    });

  const editComment: IssueService["Service"]["editComment"] = (input) =>
    Effect.gen(function* () {
      const project = yield* requireWritable(input, "editComment", true);
      if (project.api.editComment === undefined || !project.api.capabilities.editComment)
        return yield* unsupported("editComment", "editing comments");
      if (input.richBody !== undefined && !project.api.capabilities.richText)
        return yield* unsupported("editComment", "rich text");
      if (input.body.trim().length === 0 && input.richBody === undefined)
        return yield* new IssueOperationError({
          operation: "editComment",
          detail: "A comment needs some text.",
        });
      yield* project.api
        .editComment({
          cwd: project.project.workspaceRoot,
          host: project.host,
          scope: project.scope,
          key: input.key,
          commentId: input.commentId,
          body: input.body,
          ...(input.richBody === undefined ? {} : { richBody: input.richBody }),
        })
        .pipe(withConnection(project), Effect.mapError(toIssueError("editComment")));
    });

  const setParent: IssueService["Service"]["setParent"] = (input) =>
    Effect.gen(function* () {
      const project = yield* requireWritable(input, "setParent");
      if (project.api.setParent === undefined || !project.api.capabilities.updateParent)
        return yield* unsupported("setParent", "changing parent issues");
      if (input.parentKey === input.key)
        return yield* new IssueOperationError({
          operation: "setParent",
          detail: "An issue cannot be its own parent.",
        });
      yield* requirePermissions(
        project,
        input,
        "setParent",
        (permissions) => permissions.updateParent ?? permissions.edit,
      );
      yield* project.api
        .setParent({
          cwd: project.project.workspaceRoot,
          host: project.host,
          scope: project.scope,
          key: input.key,
          parentKey: input.parentKey,
        })
        .pipe(withConnection(project), Effect.mapError(toIssueError("setParent")));
    });

  const resolveUrl: IssueService["Service"]["resolveUrl"] = (
    url,
    preferredProjectId,
    connectionId,
  ) =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => new URL(url),
        catch: () =>
          new IssueOperationError({
            operation: "resolveUrl",
            reason: "not-found",
            detail: "This is not a recognised issue URL.",
          }),
      });
      const available = yield* listProjects({});
      const supported = available.supported.filter(
        (project) => project.host.split("/")[0] === target.host.toLowerCase(),
      );
      const parsed =
        supported.map((project) => parseIssueUrl(url, project)).find((link) => link !== null) ??
        parseIssueUrl(url);
      if (parsed === null) {
        return yield* new IssueOperationError({
          operation: "resolveUrl",
          reason: "not-found",
          detail: "This is not a recognised issue URL.",
        });
      }
      const scope =
        parsed.tracker === "forgejo"
          ? parseForgejoRemote(target.href)!
              .path.split("/")
              .slice(0, parsed.scope.split("/").length)
              .join("/")
          : parsed.scope;
      const preferred = supported.find(
        (project) =>
          project.project.id === preferredProjectId && project.tracker === parsed.tracker,
      );
      if (preferred !== undefined && preferred.host !== parsed.host)
        return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      const selectedAccount = connectionId ?? preferred?.connectionId;
      const onTracker = supported.filter(
        (project) =>
          project.tracker === parsed.tracker &&
          project.host === parsed.host &&
          ((connectionId === undefined && preferred === undefined) ||
            project.connectionId === selectedAccount),
      );
      if (
        connectionId !== undefined &&
        preferredProjectId !== undefined &&
        !onTracker.some((project) => project.project.id === preferredProjectId)
      )
        return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      const preferFirst = (projects: ReadonlyArray<SupportedProject>) =>
        projects.find((project) => project.project.id === preferredProjectId) ?? projects[0];
      const legacyScope =
        parsed.workspace === undefined
          ? undefined
          : parsed.scope.slice(parsed.workspace.length + 1);
      const canonicalProjects = onTracker.filter(
        (project) =>
          issueScopeKeyOf(project) === issueScopeKeyOf({ tracker: project.tracker, scope }),
      );
      const ownProjects =
        canonicalProjects.length > 0
          ? canonicalProjects
          : legacyScope === undefined
            ? []
            : onTracker.filter(
                (project) =>
                  isStandaloneIssueTracker(project.api) &&
                  !project.scope.includes("/") &&
                  project.scope.toLowerCase() === legacyScope,
              );
      const own = preferFirst(ownProjects);
      const lenders =
        own === undefined
          ? onTracker.filter(
              (project) =>
                !isStandaloneIssueTracker(project.api) ||
                project.tracker === "jira" ||
                (project.tracker === "linear" &&
                  parsed.workspace !== undefined &&
                  project.scope.includes("/") &&
                  project.scope.split("/")[0]?.toLowerCase() === parsed.workspace),
            )
          : ownProjects;
      if (new Set(lenders.map((project) => project.connectionId)).size > 1)
        return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      const lender = own ?? preferFirst(lenders);
      if (lender === undefined) {
        return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      }
      if (parsed.workspace !== undefined && !lender.scope.includes("/")) {
        const issue = yield* lender.api
          .getIssue({
            cwd: lender.project.workspaceRoot,
            host: lender.host,
            scope: lender.scope,
            key: parsed.key,
          })
          .pipe(withConnection(lender), Effect.mapError(toIssueError("resolveUrl")));
        const canonical = parseIssueUrl(issue.url, lender);
        if (
          canonical === null ||
          canonical.tracker !== parsed.tracker ||
          canonical.host !== parsed.host ||
          canonical.scope !== parsed.scope ||
          canonical.key !== parsed.key ||
          canonical.workspace !== parsed.workspace
        ) {
          return yield* new IssueOperationError({
            operation: "resolveUrl",
            reason: "not-found",
            detail: "This URL does not match the issue returned by the configured tracker.",
          });
        }
      }
      return {
        projectId: lender.project.id,
        tracker: lender.tracker,
        ...accountFields(lender),
        host: lender.host,
        scope:
          own?.scope ??
          (parsed.tracker === "jira"
            ? parsed.scope.toUpperCase()
            : issueScopeKeyOf({ tracker: parsed.tracker, scope })),
        key: parsed.key,
        writable:
          own !== undefined &&
          !(parsed.tracker === "gitlab" && scope.toLowerCase().startsWith("group:")),
      };
    });

  return IssueService.of({
    sources,
    listSources,
    list,
    detail,
    comments,
    history,
    linkedPullRequests,
    dependencies,
    setDependency,
    hierarchy,
    labelCandidates,
    assigneeCandidates,
    editComment,
    setParent,
    templates,
    candidates,
    create,
    comment,
    update,
    setState,
    react,
    resolveUrl,
  });
});

export const layer = Layer.effect(IssueService, make);
