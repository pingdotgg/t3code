// A project bound to a standalone tracker (Linear) in settings lists it beside its git host's.
// References outside the project's canonical repository may be read on the same host,
// but every write must pass through requireWritable.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  IssueOperationError,
  IssueTrackerKind,
  IssueUnavailableError,
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
  type IssueTrackerSummary,
  type IssueUpdateInput,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  IssueTrackerError,
  isStandaloneIssueTracker,
  type IssueInvolvementFilter,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import { parseUrl } from "@t3tools/shared/url";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const DEFAULT_LIST_LIMIT = 50;
const SCOPE_CONCURRENCY = 4;

const interactive =
  <I, A>(call: (input: I) => Effect.Effect<A, IssueError>) =>
  (input: I) =>
    call(input).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));

const traced =
  <I, A>(operation: string, call: (input: I) => Effect.Effect<A, IssueError>) =>
  (input: I) =>
    call(input).pipe(Effect.withSpan(`IssueService.${operation}`));

/** A tracker may fail with no detail; the wire errors carry a non-empty one. */
export function trackerDetail(error: IssueTrackerError): string {
  return error.detail.trim() || "The issue tracker request failed.";
}

/** One project's resolved tracker: which driver, where it is served from, and its container. */
interface ProjectTrackerBinding {
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
 * The git-host path of resolution: the tracker is the host's own, named like the remote's
 * provider kind. Null for a project with no remote or a kind no tracker claims.
 */
function resolveGitHostBinding(project: OrchestrationProjectShell): ProjectTrackerBinding | null {
  const identity = project.repositoryIdentity;
  const scope = sourceControlDefinitions.issueScope(identity);
  const kind = identity?.provider;
  if (!identity || kind === undefined || kind === "unknown" || scope === null) return null;
  return {
    tracker: IssueTrackerKind.make(kind),
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    scope,
  };
}

function findStandaloneIssueUrl(trackers: ReadonlyArray<StandaloneIssueTrackerApi>, value: string) {
  const url = parseUrl(value);
  if (url === null) return null;
  for (const api of trackers) {
    const link = api.parseIssueUrl(url);
    if (link !== null) return { api, tracker: api.kind, link };
  }
  return null;
}

/** Lower case, so a scope keeps its cursor whichever project's spelling of it is read. */
function listCursorKey(host: string, scope: string): string {
  return `${host} ${scope.toLowerCase()}`;
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
          detail: trackerDetail(error),
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
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly comments: (
      input: IssueCommentsPageInput,
    ) => Effect.Effect<IssueCommentsPage, IssueError>;
    readonly templates: (input: IssueScopeRef) => Effect.Effect<IssueTemplateList, IssueError>;
    readonly candidates: (input: IssueScopeRef) => Effect.Effect<IssueCandidates, IssueError>;
    readonly create: (input: IssueCreateInput) => Effect.Effect<IssueCreateResult, IssueError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueError>;
    readonly update: (input: IssueUpdateInput) => Effect.Effect<void, IssueError>;
    readonly setState: (input: IssueSetStateInput) => Effect.Effect<void, IssueError>;
    readonly react: (input: IssueReactionInput) => Effect.Effect<void, IssueError>;
    /** The tracker and container a project's own issues live in. */
    readonly projectScope: (
      projectId: ProjectId,
    ) => Effect.Effect<IssueScopeRef & { readonly host: string }, IssueError>;
    /**
     * Resolve through a matching project, preferring `preferredProjectId`; other scopes are read-only.
     * Standalone links must match the workspace in the issue's canonical URL from the connected tracker.
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

const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;

  // Read per resolution so a binding saved in Settings applies without a restart.
  const resolveStandaloneBinding = (
    project: OrchestrationProjectShell,
  ): Effect.Effect<ProjectTrackerBinding | null, IssueOperationError> =>
    bindings.list.pipe(
      Effect.map((bound) => {
        const binding = bound.get(project.id);
        const api = binding === undefined ? null : registry.get(binding.tracker);
        if (binding === undefined || api === null || !isStandaloneIssueTracker(api)) return null;
        return {
          tracker: binding.tracker,
          host: api.standalone.host,
          scope: binding.scope,
        };
      }),
      // A failed read is not an unbound project: that would list the git host's issues alone.
      Effect.mapError(
        (cause) =>
          new IssueOperationError({
            operation: "listProjects",
            detail: "The project's issue tracker binding could not be read.",
            cause,
          }),
      ),
    );

  /**
   * Where a project's issues live: its bound standalone tracker, its git host's, or both. The
   * tracker bound in Settings leads, as the one the user chose for the project.
   */
  const resolveProjectTracker = (
    project: OrchestrationProjectShell,
  ): Effect.Effect<ReadonlyArray<ProjectTrackerBinding>, IssueOperationError> =>
    Effect.all([
      resolveStandaloneBinding(project),
      (project.repositoryIdentity != null
        ? Effect.succeed(project.repositoryIdentity)
        : repositoryIdentities.resolve(project.workspaceRoot)
      ).pipe(
        Effect.map((repositoryIdentity) =>
          resolveGitHostBinding({ ...project, repositoryIdentity }),
        ),
      ),
    ]).pipe(Effect.map((resolved) => resolved.filter((binding) => binding !== null)));

  const listProjects = (filter: {
    readonly projectId?: IssueListInput["projectId"];
    readonly host?: string | undefined;
    /** The link's `host:port`, for a host whose binding keeps its port. */
    readonly authority?: string | undefined;
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
            resolveProjectTracker(project).pipe(
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
          { tracker: IssueTrackerKind; projectCount: number }
        >();
        for (const candidate of bound.flat()) {
          if (host !== undefined && candidate.host !== host && candidate.host !== filter.authority)
            continue;
          const api = registry.get(candidate.tracker);
          if (api === null) {
            const counted = unimplemented.get(candidate.host);
            if (counted === undefined)
              unimplemented.set(candidate.host, { tracker: candidate.tracker, projectCount: 1 });
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
  ): Effect.Effect<SupportedProject & { readonly writable: boolean }, IssueError> =>
    listProjects({ projectId: ref.projectId }).pipe(
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
        const writable = scope.toLowerCase() === own.scope.toLowerCase();
        return Effect.succeed({ ...own, scope, writable });
      }),
    );

  const requireWritable = (ref: IssueScopeRef, operation: string) =>
    requireProject(ref).pipe(
      Effect.filterOrFail(
        (project) => project.writable,
        () => readOnly(operation),
      ),
    );

  const list: IssueService["Service"]["list"] = Effect.fn("IssueService.list")(function* (input) {
    // Trackers name every host so a client narrowed to one can switch to another; only the
    // narrowed host's scopes are read.
    const { supported, unimplemented } = yield* listProjects({ projectId: input.projectId });
    const host = input.host?.trim().toLowerCase();
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    // Worktrees of one repository are separate projects, and every repository of an Azure
    // DevOps project shares its work items; read each scope once.
    const scopes = new Map<string, SupportedProject>();
    for (const project of supported) {
      if (host !== undefined && project.host !== host) continue;
      const key = listCursorKey(project.host, project.scope);
      if (!scopes.has(key)) scopes.set(key, project);
    }
    const continuing = input.cursors;
    const viewers = new Map<string, string>();
    const trackers = new Map<string, IssueTrackerSummary>();
    const entries: IssueListEntry[] = [];
    const errors: IssueListProjectError[] = [];
    const nextCursors: Record<string, string> = {};

    const involvement = input.involvement ?? "all";
    // Only a narrowed listing compares against the signed-in account; `all` never reads it.
    const viewerRequests = new Map<string, Effect.Effect<string, IssueTrackerError>>();
    for (const project of involvement === "all" ? [] : scopes.values()) {
      if (viewerRequests.has(project.host)) continue;
      const request = yield* Effect.cached(
        project.api
          .getViewer({ cwd: project.project.workspaceRoot, host: project.host })
          .pipe(Effect.tap((viewer) => Effect.sync(() => viewers.set(project.host, viewer)))),
      );
      viewerRequests.set(project.host, request);
    }

    // Every project counts, including worktrees of a scope read once below.
    for (const project of supported) {
      const existing = trackers.get(project.host);
      trackers.set(
        project.host,
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
      const existing = trackers.get(project.host);
      if (existing !== undefined && isTrackerUnusable(failure))
        trackers.set(project.host, {
          ...existing,
          configured: false,
          detail: trackerDetail(failure),
        });
    };

    yield* Effect.forEach(
      scopes.values(),
      (project) =>
        Effect.gen(function* () {
          const key = listCursorKey(project.host, project.scope);
          // A continuation names the scopes it wants; one not named has nothing to add.
          if (continuing !== undefined && continuing[key] === undefined) return;
          const cursor = continuing?.[key];
          const filter: Effect.Effect<IssueInvolvementFilter, IssueTrackerError> =
            involvement === "all"
              ? Effect.succeed({ involvement })
              : viewerRequests
                  .get(project.host)!
                  .pipe(Effect.map((viewer) => ({ involvement, viewer })));
          const page = yield* filter.pipe(
            Effect.flatMap((filter) =>
              project.api.listIssues({
                ...filter,
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                state: input.state,
                limit,
                query: input.query,
                labels: input.labels,
                assignee: input.assignee,
                sort: input.sort ?? "updated",
                cursor,
              }),
            ),
            Effect.result,
          );
          if (page._tag === "Failure") {
            if (cursor !== undefined) nextCursors[key] = cursor;
            recordFailure(project, page.failure);
            errors.push({
              projectId: project.project.id,
              projectTitle: project.project.title,
              message: trackerDetail(page.failure),
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

    for (const [host, { tracker, projectCount }] of unimplemented) {
      trackers.set(host, {
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
      viewers: Object.fromEntries(viewers),
      trackers: [...trackers.values()],
      entries,
      errors,
      nextCursors,
      scopes: [...scopes.values()].map((project) => ({
        projectId: project.project.id,
        tracker: project.tracker,
        host: project.host,
        scope: project.scope,
      })),
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
              })
              .pipe(Effect.mapError(toIssueError("templates"))),
      ),
    );

  const candidates: IssueService["Service"]["candidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listCandidates === undefined ||
        !(project.api.capabilities.labels || project.api.capabilities.assignees)
          ? Effect.fail(unsupported("candidates", "labels or assignees"))
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
    requireWritable(input, "create").pipe(
      Effect.flatMap((project) =>
        project.api.create === undefined || !project.api.capabilities.create
          ? Effect.fail(unsupported("create", "filing issues"))
          : project.api
              .create({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                title: input.title,
                body: input.body,
                labels: input.labels,
                assignees: input.assignees,
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
          : project.api
              .comment({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                body: input.body,
              })
              .pipe(Effect.mapError(toIssueError("comment")));
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
        return project.api
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
          .pipe(Effect.mapError(toIssueError("update")));
      }),
    );

  const setState: IssueService["Service"]["setState"] = (input) =>
    requireWritable(input, "setState").pipe(
      Effect.flatMap((project) => {
        if (project.api.setState === undefined)
          return Effect.fail(unsupported("setState", "changing an issue's state"));
        return project.api
          .setState({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
            state: input.state,
          })
          .pipe(Effect.mapError(toIssueError("setState")));
      }),
    );

  const react: IssueService["Service"]["react"] = (input) =>
    requireWritable(input, "react").pipe(
      Effect.flatMap((project) =>
        project.api.setReaction === undefined || !project.api.capabilities.reactions
          ? Effect.fail(unsupported("react", "reactions"))
          : project.api
              .setReaction({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                subjectId: input.subjectId,
                content: input.content,
                reacted: input.reacted,
              })
              .pipe(Effect.mapError(toIssueError("react"))),
      ),
    );

  const projectScope: IssueService["Service"]["projectScope"] = Effect.fn(
    "IssueService.projectScope",
  )(function* (projectId) {
    const { supported } = yield* listProjects({ projectId });
    const [own] = supported;
    if (own === undefined) {
      return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
    }
    return { projectId, tracker: own.tracker, host: own.host, scope: own.scope };
  });

  /** A host whose hostname does not name it, such as GitHub Enterprise Server, is vouched for by a project on it. */
  const parseOnProjectHost = (value: string) => {
    const url = parseUrl(value);
    if (url === null) return Effect.succeed(null);
    return listProjects({ host: url.hostname, authority: url.host.toLowerCase() }).pipe(
      Effect.map(({ supported }) => {
        for (const project of supported) {
          const parsed = sourceControlDefinitions.parseIssueUrl(
            value,
            SourceControlProviderKind.make(project.tracker),
          );
          if (parsed !== null) return parsed;
        }
        return null;
      }),
    );
  };

  const resolveUrl: IssueService["Service"]["resolveUrl"] = Effect.fn("IssueService.resolveUrl")(
    function* (url, preferredProjectId) {
      const recognized = sourceControlDefinitions.parseIssueUrl(url);
      const standalone =
        recognized === null ? findStandaloneIssueUrl(registry.standalone, url) : null;
      const gitHost = recognized ?? (standalone === null ? yield* parseOnProjectHost(url) : null);
      const parsed =
        gitHost === null
          ? standalone
          : { tracker: IssueTrackerKind.make(gitHost.definition.kind), link: gitHost.link };
      if (parsed === null) {
        return yield* new IssueOperationError({
          operation: "resolveUrl",
          reason: "not-found",
          detail: "This is not a recognised issue URL.",
        });
      }
      const { tracker, link } = parsed;
      // A link names its server's port; a binding does only when its remote or web URL did.
      const authority = new URL(url).host.toLowerCase();
      const { supported } = yield* listProjects({ host: link.host, authority });
      const onHost = supported.filter((project) => project.tracker === tracker);
      const onAuthority = onHost.filter((project) => project.host === authority);
      const onTracker = onAuthority.length > 0 ? onAuthority : onHost;
      const preferFirst = (projects: ReadonlyArray<SupportedProject>) =>
        projects.find((project) => project.project.id === preferredProjectId) ?? projects[0];
      const own = preferFirst(
        onTracker.filter((project) => project.scope.toLowerCase() === link.scope.toLowerCase()),
      );
      const lender = own ?? preferFirst(onTracker);
      if (lender === undefined) {
        return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      }
      if (standalone !== null) {
        // Team keys repeat across workspaces; only the credential's canonical issue URL identifies one.
        const issue = yield* lender.api
          .getIssue({
            cwd: lender.project.workspaceRoot,
            host: lender.host,
            scope: link.scope,
            key: link.key,
          })
          .pipe(Effect.mapError(toIssueError("resolveUrl")));
        const canonicalUrl = parseUrl(issue.url);
        const canonical = canonicalUrl === null ? null : standalone.api.parseIssueUrl(canonicalUrl);
        if (canonical === null || canonical.workspace !== standalone.link.workspace) {
          return yield* new IssueOperationError({
            operation: "resolveUrl",
            reason: "not-found",
            detail: "This issue URL does not belong to the connected workspace.",
          });
        }
      }
      return {
        projectId: lender.project.id,
        tracker: lender.tracker,
        host: lender.host,
        scope: own === undefined ? link.scope : lender.scope,
        key: link.key,
        writable: own !== undefined,
      };
    },
  );

  return IssueService.of({
    list,
    detail: traced("detail", detail),
    comments: traced("comments", comments),
    templates: traced("templates", templates),
    candidates: interactive(traced("candidates", candidates)),
    create: interactive(traced("create", create)),
    comment: interactive(traced("comment", comment)),
    update: interactive(traced("update", update)),
    setState: interactive(traced("setState", setState)),
    react: interactive(traced("react", react)),
    projectScope,
    resolveUrl,
  });
});

export const layer = Layer.effect(IssueService, make);
