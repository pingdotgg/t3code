/**
 * Issues across the workspace's projects, read through whichever tracker each project resolves
 * to. The service owns resolution and permission; trackers own their APIs.
 *
 * Resolution: a git-host project resolves to the tracker of the same kind as its remote, with the
 * remote's host and `owner/repo` as the scope. A standalone tracker (Linear, Jira) will resolve
 * from a per-project binding in settings through the same `resolveProjectTracker` hook; only the
 * git-host path exists today.
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
  type IssueTrackerSummary,
  type IssueUpdateInput,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

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
 * The git-host path of resolution: the tracker is the host's own, named like the remote's
 * provider kind. Null for a project with no remote or a kind no tracker claims.
 */
function resolveGitHostBinding(project: OrchestrationProjectShell): ProjectTrackerBinding | null {
  const identity = project.repositoryIdentity;
  const scope = sourceControlRepositorySelector(identity);
  const kind = identity?.provider;
  if (!identity || kind === undefined || kind === "unknown" || scope === null) return null;
  return {
    tracker: IssueTrackerKind.make(kind),
    host: pullRequestHostOf(identity, SourceControlProviderKind.make(kind)),
    scope,
  };
}

function listCursorKey(host: string, scope: string): string {
  return `${host} ${scope}`;
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
  }
>()("t3/issue/IssueService") {}

export const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  /** Where a project's issues live. The one place a standalone tracker's binding will plug in. */
  const resolveProjectTracker = (
    project: OrchestrationProjectShell,
  ): Effect.Effect<ProjectTrackerBinding | null> =>
    (project.repositoryIdentity != null
      ? Effect.succeed(project.repositoryIdentity)
      : repositoryIdentities.resolve(project.workspaceRoot)
    ).pipe(
      Effect.map((repositoryIdentity) => resolveGitHostBinding({ ...project, repositoryIdentity })),
    );

  const listProjects = (filter: {
    readonly projectId?: IssueListInput["projectId"];
    readonly host?: string | undefined;
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
              Effect.map((binding) => (binding === null ? [] : [{ project, ...binding }])),
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
          if (host !== undefined && candidate.host !== host) continue;
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
   * served by the project but marked read-only.
   */
  const requireProject = (
    ref: IssueScopeRef,
  ): Effect.Effect<SupportedProject & { readonly writable: boolean }, IssueError> =>
    listProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }) => {
        const own = supported[0];
        if (own === undefined || own.tracker !== ref.tracker) {
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
      Effect.flatMap((project) =>
        project.writable ? Effect.succeed(project) : Effect.fail(readOnly(operation)),
      ),
    );

  const list: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const { supported, unimplemented } = yield* listProjects(input);
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      // Worktrees of one repository are separate projects; read each scope once.
      const scopes = new Map<string, SupportedProject>();
      for (const project of supported) {
        const key = listCursorKey(project.host, project.scope);
        if (!scopes.has(key)) scopes.set(key, project);
      }
      const continuing = input.cursors;
      const viewers = new Map<string, string>();
      const trackers = new Map<string, IssueTrackerSummary>();
      const entries: IssueListEntry[] = [];
      const errors: IssueListProjectError[] = [];
      const nextCursors: Record<string, string> = {};

      const viewerFor = (project: SupportedProject) =>
        Effect.suspend(() => {
          const known = viewers.get(project.host);
          return known === undefined
            ? project.api
                .getViewer({ cwd: project.project.workspaceRoot, host: project.host })
                .pipe(Effect.tap((viewer) => Effect.sync(() => viewers.set(project.host, viewer))))
            : Effect.succeed(known);
        });

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
          trackers.set(project.host, { ...existing, configured: false, detail: failure.detail });
      };

      yield* Effect.forEach(
        scopes,
        ([key, project]) =>
          Effect.gen(function* () {
            // A continuation names the scopes it wants; one not named has nothing to add.
            if (continuing !== undefined && continuing[key] === undefined) return;
            const cursor = continuing?.[key];
            const page = yield* viewerFor(project).pipe(
              Effect.flatMap((viewer) =>
                project.api.listIssues({
                  cwd: project.project.workspaceRoot,
                  host: project.host,
                  scope: project.scope,
                  state: input.state,
                  involvement: input.involvement ?? "all",
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
        const { capabilities } = project.api;
        const target = capabilities.states.find((state) => state.name === input.state);
        if (project.api.setState === undefined || target === undefined)
          return Effect.fail(unsupported("setState", `the state "${input.state}"`));
        if (
          input.closeReason !== undefined &&
          (target.category !== "closed" || !capabilities.closeReasons.includes(input.closeReason))
        )
          return Effect.fail(unsupported("setState", `the close reason "${input.closeReason}"`));
        return project.api
          .setState({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
            state: input.state,
            closeReason: input.closeReason,
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

  return IssueService.of({
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
  });
});

export const layer = Layer.effect(IssueService, make);
