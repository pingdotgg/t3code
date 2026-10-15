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
  issueScopeKeyOf,
  issueTrackerHostKey,
  IssueOperationError,
  IssueTrackerKind,
  IssueUnavailableError,
  pullRequestHostOf,
  SourceControlProviderKind,
  type IssueCandidates,
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
  if (host.endsWith(".visualstudio.com")) {
    if (marker !== 1 && !(marker === 2 && segments[0]?.toLowerCase() === "defaultcollection"))
      return null;
    const project = segments[marker - 1];
    return project
      ? azureDevOpsIssueScope(host.slice(0, -".visualstudio.com".length), project)
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
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly comments: (
      input: IssueCommentsPageInput,
    ) => Effect.Effect<IssueCommentsPage, IssueError>;
    readonly templates: (
      input: IssueTemplatesInput,
    ) => Effect.Effect<IssueTemplateList, IssueError>;
    readonly candidates: (input: IssueScopeRef) => Effect.Effect<IssueCandidates, IssueError>;
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
  const resolveStandaloneBinding = (
    project: OrchestrationProjectShell,
  ): Effect.Effect<ProjectTrackerBinding | null> =>
    bindings.list.pipe(
      Effect.map((bound) => {
        const binding = bound.get(project.id);
        const api = binding === undefined ? null : registry.get(binding.tracker);
        if (binding === undefined || api === null || !isStandaloneIssueTracker(api)) return null;
        const host = binding.host ?? api.standalone.host;
        if (host === null) return null;
        return { tracker: binding.tracker, host: host.trim().toLowerCase(), scope: binding.scope };
      }),
      Effect.orElseSucceed(() => null),
    );

  /** Where a project's issues live: its git host's tracker, its bound standalone one, or both. */
  const resolveProjectTracker = (
    project: OrchestrationProjectShell,
    refreshRepository = false,
  ): Effect.Effect<ReadonlyArray<ProjectTrackerBinding>> =>
    Effect.all([
      (refreshRepository
        ? repositoryIdentities.resolve(project.workspaceRoot, { refresh: true })
        : project.repositoryIdentity != null
          ? Effect.succeed(project.repositoryIdentity)
          : repositoryIdentities.resolve(project.workspaceRoot)
      ).pipe(
        Effect.map((repositoryIdentity) =>
          resolveGitHostBinding({ ...project, repositoryIdentity }),
        ),
      ),
      resolveStandaloneBinding(project),
    ]).pipe(Effect.map((resolved) => resolved.filter((binding) => binding !== null)));

  const listProjects = (filter: {
    readonly projectId?: IssueListInput["projectId"];
    readonly host?: string | undefined;
    readonly refreshRepository?: boolean;
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
        Effect.forEach(
          shells,
          (project) =>
            resolveProjectTracker(project, filter.refreshRepository).pipe(
              Effect.map((bindings) => bindings.map((binding) => ({ project, ...binding }))),
            ),
          { concurrency: SCOPE_CONCURRENCY },
        ),
      ),
      Effect.map((bound) => {
        const host = filter.host?.trim().toLowerCase();
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { tracker: IssueTrackerKind; host: string; projectCount: number }
        >();
        for (const candidate of bound.flat()) {
          if (host !== undefined && candidate.host !== host) continue;
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
        if (own === undefined) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        const host = ref.host?.trim().toLowerCase() ?? own.host;
        if (host !== own.host) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        const scope = ref.scope.trim();
        const writable = issueScopeKeyOf({ tracker: own.tracker, scope }) === issueScopeKeyOf(own);
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
        supported.map(({ tracker, host, scope }) => ({ tracker, host, scope })),
      ),
    );

  const list: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const { supported, unimplemented } = yield* listProjects(input);
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
        project.tracker === "forgejo"
          ? issueListCursorKey({
              ...project,
              scope: issueScopeKeyOf(project).split("/").slice(0, -2).join("/"),
            })
          : issueTrackerHostKey(project);
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
              project.api.getViewer({ cwd: project.project.workspaceRoot, host: project.host }),
            );
            viewerReads.set(key, read);
          }
          const viewer = yield* read;
          if (project.tracker === "forgejo") viewers.set(issueListCursorKey(project), viewer);
          const hostKey = issueTrackerHostKey(project);
          if (viewerInstances.get(hostKey)!.size === 1) viewers.set(hostKey, viewer);
          return viewer;
        });

      // Every project counts, including worktrees of a scope read once below.
      for (const project of supported) {
        const existing = trackers.get(issueTrackerHostKey(project));
        trackers.set(
          issueTrackerHostKey(project),
          existing === undefined
            ? {
                tracker: project.tracker,
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
        const existing = trackers.get(issueTrackerHostKey(project));
        if (existing !== undefined && isTrackerUnusable(failure))
          trackers.set(issueTrackerHostKey(project), {
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
                host: project.host,
                message: `This tracker does not support ${involvement} issue lists.`,
              });
              return;
            }
            const cursor = continuing?.[key];
            const page = yield* viewerFor(project).pipe(
              Effect.flatMap((viewer) =>
                project.api.listIssues({
                  cwd: project.project.workspaceRoot,
                  host: project.host,
                  scope: project.scope,
                  state: input.state,
                  involvement,
                  viewer,
                  limit,
                  query: input.query,
                  cursor,
                }),
              ),
              Effect.result,
            );
            if (page._tag === "Failure") {
              recordFailure(project, page.failure);
              errors.push({
                projectId: project.project.id,
                projectTitle: project.project.title,
                tracker: project.tracker,
                host: project.host,
                message: page.failure.detail,
              });
              return;
            }
            for (const item of page.success.items) {
              entries.push({
                ...item,
                tracker: project.tracker,
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
      entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        sources: supported.map((project) => ({
          projectId: project.project.id,
          projectTitle: project.project.title,
          tracker: project.tracker,
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
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
          })
          .pipe(
            Effect.mapError(toIssueError("detail")),
            Effect.map((issue): IssueDetail => ({
              ...issue,
              tracker: project.tracker,
              host: project.host,
              scope: project.scope,
              projectId: project.project.id,
              projectTitle: project.project.title,
              writable: project.writable,
              capabilities: project.api.capabilities,
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
            cursor: input.cursor,
            ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
          })
          .pipe(Effect.mapError(toIssueError("comments"))),
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
              .pipe(Effect.mapError(toIssueError("templates"))),
      ),
    );

  const candidates: IssueService["Service"]["candidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listCandidates === undefined ||
        !(
          project.api.capabilities.labels ||
          project.api.capabilities.assignees ||
          project.api.capabilities.createIssueTypes
        )
          ? Effect.fail(unsupported("candidates", "labels, assignees, or issue types"))
          : project.api
              .listCandidates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
              })
              .pipe(Effect.mapError(toIssueError("candidates"))),
      ),
    );

  const create: IssueService["Service"]["create"] = (input) =>
    requireWritable(input, "create", true).pipe(
      Effect.flatMap((project) =>
        project.api.create === undefined || !project.api.capabilities.create
          ? Effect.fail(unsupported("create", "filing issues"))
          : input.issueType !== undefined && !project.api.capabilities.createIssueTypes
            ? Effect.fail(unsupported("create", "selecting an issue type"))
            : project.api.capabilities.maxAssignees !== undefined &&
                input.assignees.length > project.api.capabilities.maxAssignees
              ? Effect.fail(
                  new IssueOperationError({
                    operation: "create",
                    detail: "The issue has more assignees than this tracker allows.",
                  }),
                )
              : project.api
                  .create({
                    cwd: project.project.workspaceRoot,
                    host: project.host,
                    scope: project.scope,
                    title: input.title,
                    body: input.body,
                    labels: input.labels,
                    assignees: input.assignees,
                    ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
                  })
                  .pipe(Effect.mapError(toIssueError("create"))),
      ),
    );

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
                  .pipe(Effect.mapError(toIssueError("comment"))),
              ),
            );
      }),
    );

  const update: IssueService["Service"]["update"] = (input) =>
    requireWritable(input, "update").pipe(
      Effect.flatMap((project) => {
        const { capabilities } = project.api;
        const wantsWords = input.title !== undefined || input.body !== undefined;
        if (!wantsWords && input.labels === undefined && input.assignees === undefined) {
          return Effect.fail(
            new IssueOperationError({ operation: "update", detail: "Nothing to change." }),
          );
        }
        if (project.api.update === undefined) return Effect.fail(unsupported("update", "edits"));
        if (wantsWords && !capabilities.edit)
          return Effect.fail(unsupported("update", "editing the title or body"));
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
                labels: input.labels,
                assignees: input.assignees,
              })
              .pipe(Effect.mapError(toIssueError("update"))),
          ),
        );
      }),
    );

  const setState: IssueService["Service"]["setState"] = (input) =>
    requireWritable(input, "setState").pipe(
      Effect.flatMap((project) => {
        const { capabilities } = project.api;
        const target = capabilities.states.find((state) => state.name === input.state);
        if (
          project.api.setState === undefined ||
          (target === undefined && project.tracker !== "azure-devops")
        )
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
                closeReason: input.closeReason,
              })
              .pipe(Effect.mapError(toIssueError("setState"))),
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
        .pipe(Effect.mapError(toIssueError("react")));
    });

  const resolveUrl: IssueService["Service"]["resolveUrl"] = (url, preferredProjectId) =>
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
      const { supported } = yield* listProjects({ host: target.host.toLowerCase() });
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
      const onTracker = supported.filter((project) => project.tracker === parsed.tracker);
      const preferFirst = (projects: ReadonlyArray<SupportedProject>) =>
        projects.find((project) => project.project.id === preferredProjectId) ?? projects[0];
      const legacyScope =
        parsed.workspace === undefined
          ? undefined
          : parsed.scope.slice(parsed.workspace.length + 1);
      const own =
        preferFirst(
          onTracker.filter(
            (project) =>
              issueScopeKeyOf(project) === issueScopeKeyOf({ tracker: project.tracker, scope }),
          ),
        ) ??
        (legacyScope === undefined
          ? undefined
          : preferFirst(
              onTracker.filter(
                (project) =>
                  isStandaloneIssueTracker(project.api) &&
                  !project.scope.includes("/") &&
                  project.scope.toLowerCase() === legacyScope,
              ),
            ));
      const lender =
        own ??
        preferFirst(
          onTracker.filter(
            (project) =>
              !isStandaloneIssueTracker(project.api) ||
              project.tracker === "jira" ||
              (project.tracker === "linear" &&
                parsed.workspace !== undefined &&
                project.scope.includes("/") &&
                project.scope.split("/")[0]?.toLowerCase() === parsed.workspace),
          ),
        );
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
          .pipe(Effect.mapError(toIssueError("resolveUrl")));
        const canonical = parseIssueUrl(issue.url);
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
        host: lender.host,
        scope:
          own?.scope ??
          (parsed.tracker === "jira"
            ? parsed.scope.toUpperCase()
            : issueScopeKeyOf({ tracker: parsed.tracker, scope })),
        key: parsed.key,
        writable: own !== undefined,
      };
    });

  return IssueService.of({
    sources,
    list,
    detail,
    comments,
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
