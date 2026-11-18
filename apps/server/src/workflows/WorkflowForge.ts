// Issues and pull requests for workflows: the same trackers and hosts the app's own Issues and
// Pull requests pages read, through the project's credentials. A step names a project the way
// an agent step does, by id or by folder.
import {
  IssueDetail,
  IssueListEntry,
  type IssueCreateResult,
  type IssueListState,
  type IssueRef,
  type PullRequestAction,
  type PullRequestDetail,
  PullRequestListEntry,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestRef,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";
import { isProjectPath } from "./WorkflowAgents.ts";

export class WorkflowForgeError extends Schema.TaggedError<WorkflowForgeError>()(
  "WorkflowForgeError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** What an issue trigger gives its run, and what `issues.list` returns rows of. */
export const Issue = IssueListEntry;
export type Issue = typeof Issue.Type;
/** What a pull request trigger gives its run, and what `pullRequests.list` returns rows of. */
export const PullRequest = PullRequestListEntry;
export type PullRequest = typeof PullRequest.Type;
export { IssueDetail };

/** An issue by its web address, or as a trigger or a listing gave it. */
export type IssueAddress =
  | { readonly project: string; readonly url: string }
  | Pick<Issue, "projectId" | "tracker" | "host" | "scope" | "key">;
/** A pull request by its web address, or as a trigger or a listing gave it. */
export type PullRequestAddress =
  | { readonly project: string; readonly url: string }
  | Pick<PullRequest, "projectId" | "host" | "repository" | "number">;

/** Where a pull request stands, as a wait on it gives it. */
export const PullRequestStanding = Schema.Struct({
  state: Schema.Literals(["open", "closed", "merged"]),
  /** `none` when the host lists no checks for it. */
  checks: Schema.Literals(["passing", "failing", "pending", "none"]),
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  url: Schema.String,
});
export type PullRequestStanding = typeof PullRequestStanding.Type;
export type PullRequestUntil = "checks" | "merged" | "closed";
/** What a wait on a pull request keeps for the engine to look at. */
export interface PullRequestWatch {
  readonly kind: "pullRequest";
  readonly until: PullRequestUntil;
  readonly pullRequest:
    | { readonly project: string; readonly url: string }
    | {
        readonly projectId: string;
        readonly host: string;
        readonly repository: string;
        readonly number: number;
      };
}

// Checks take a moment to be listed after a push, so "none" only counts once it has stayed none.
const NO_CHECKS_AFTER_MS = 2 * 60_000;

/** Required checks decide when the host marks any as required; otherwise all of them do. */
export const standingOf = (
  detail: Pick<PullRequestDetail, "state" | "checks" | "mergeability" | "url">,
): PullRequestStanding => {
  const listed = detail.checks.filter((check) => check.placeholder !== true);
  const counted = listed.some((check) => check.required === true)
    ? listed.filter((check) => check.required === true)
    : listed;
  const failing = counted.some(
    (check) =>
      check.status === "failure" ||
      check.status === "cancelled" ||
      // Nothing moves it but a person, so a run waiting for it would wait for good.
      check.status === "action-required",
  );
  const pending = counted.some((check) => check.status === "pending");
  return {
    state: detail.state,
    checks: counted.length === 0 ? "none" : failing ? "failing" : pending ? "pending" : "passing",
    mergeability: detail.mergeability,
    url: detail.url,
  };
};

/** Whether a wait `until` this is over, having waited `waitedMs`. */
export const isSettled = (
  until: PullRequestUntil,
  standing: PullRequestStanding,
  waitedMs: number,
): boolean => {
  if (standing.state !== "open") return true;
  if (until !== "checks") return false;
  if (standing.checks === "none") return waitedMs >= NO_CHECKS_AFTER_MS;
  return standing.checks !== "pending";
};

export interface IssueQuery {
  readonly project: string;
  /** Defaults to open. */
  readonly state?: IssueListState | undefined;
  /** Label names an issue must carry, every one of them. */
  readonly labels?: ReadonlyArray<string> | undefined;
  /** Free text the tracker matches itself. */
  readonly query?: string | undefined;
  readonly assignee?: string | undefined;
  readonly sort?: "updated" | "created" | undefined;
  readonly limit?: number | undefined;
}
export interface PullRequestQuery {
  readonly project: string;
  /** Defaults to open. */
  readonly state?: PullRequestListState | undefined;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}

export class WorkflowForge extends Context.Service<
  WorkflowForge,
  {
    readonly issues: {
      readonly list: (query: IssueQuery) => Effect.Effect<ReadonlyArray<Issue>, WorkflowForgeError>;
      readonly read: (issue: IssueAddress) => Effect.Effect<IssueDetail, WorkflowForgeError>;
      readonly comment: (
        issue: IssueAddress,
        body: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly setState: (
        issue: IssueAddress,
        state: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly create: (input: {
        readonly project: string;
        readonly title: string;
        readonly body?: string | undefined;
        readonly labels?: ReadonlyArray<string> | undefined;
        readonly assignees?: ReadonlyArray<string> | undefined;
      }) => Effect.Effect<IssueCreateResult, WorkflowForgeError>;
    };
    readonly pullRequests: {
      readonly list: (
        query: PullRequestQuery,
      ) => Effect.Effect<ReadonlyArray<PullRequest>, WorkflowForgeError>;
      readonly read: (
        pullRequest: PullRequestAddress,
      ) => Effect.Effect<PullRequestDetail, WorkflowForgeError>;
      readonly comment: (
        pullRequest: PullRequestAddress,
        body: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly act: (
        pullRequest: PullRequestAddress,
        action: PullRequestAction,
        options?: { readonly mergeMethod?: PullRequestMergeMethod | undefined },
      ) => Effect.Effect<void, WorkflowForgeError>;
    };
  }
>()("t3/workflows/WorkflowForge") {}

const failed =
  (what: string) =>
  (cause: unknown): WorkflowForgeError =>
    new WorkflowForgeError({
      reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

const missing = (what: string) => () =>
  Effect.fail(
    new WorkflowForgeError({
      reason: `${what} are not available to workflows on this server.`,
    }),
  );
/** For an engine with no trackers behind it: every call says so. */
export const unavailable = WorkflowForge.of({
  issues: {
    list: missing("Issues"),
    read: missing("Issues"),
    comment: missing("Issues"),
    setState: missing("Issues"),
    create: missing("Issues"),
  },
  pullRequests: {
    list: missing("Pull requests"),
    read: missing("Pull requests"),
    comment: missing("Pull requests"),
    act: missing("Pull requests"),
  },
});

export const layer = Layer.effect(
  WorkflowForge,
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const projects = yield* ProjectService.ProjectService;

    const projectIdOf = Effect.fn("WorkflowForge.projectIdOf")(function* (project: string) {
      if (!isProjectPath(project)) return ProjectId.make(project);
      const found = yield* projects
        .getByWorkspaceRoot(project)
        .pipe(Effect.mapError(failed("Could not read the project")));
      if (Option.isNone(found)) {
        return yield* new WorkflowForgeError({ reason: `No project is registered at ${project}.` });
      }
      return found.value.id;
    });

    const issueRef = Effect.fn("WorkflowForge.issueRef")(function* (issue: IssueAddress) {
      if (!("project" in issue)) {
        return {
          projectId: issue.projectId,
          tracker: issue.tracker,
          host: issue.host,
          scope: issue.scope,
          key: issue.key,
        } satisfies IssueRef;
      }
      const resolved = yield* issues
        .resolveUrl(issue.url, yield* projectIdOf(issue.project))
        .pipe(Effect.mapError(failed(`Could not find the issue at ${issue.url}`)));
      return {
        projectId: resolved.projectId,
        tracker: resolved.tracker,
        host: resolved.host,
        scope: resolved.scope,
        key: resolved.key,
      } satisfies IssueRef;
    });

    const pullRequestRef = Effect.fn("WorkflowForge.pullRequestRef")(function* (
      pullRequest: PullRequestAddress,
    ) {
      if (!("project" in pullRequest)) {
        return {
          projectId: pullRequest.projectId,
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
        } satisfies PullRequestRef;
      }
      const parsed = sourceControlDefinitions.parseChangeRequestUrl(pullRequest.url)?.link;
      if (parsed === undefined) {
        return yield* new WorkflowForgeError({
          reason: `${pullRequest.url} is not a pull request address.`,
        });
      }
      const key = normalizeThreadPullRequestKey(parsed);
      return {
        projectId: yield* projectIdOf(pullRequest.project),
        host: key.host,
        repository: key.repository,
        number: key.number,
      } satisfies PullRequestRef;
    });

    return WorkflowForge.of({
      issues: {
        list: Effect.fn("WorkflowForge.issues.list")(function* (query) {
          const result = yield* issues
            .list({
              projectId: yield* projectIdOf(query.project),
              state: query.state ?? "open",
              ...(query.labels === undefined ? {} : { labels: [...query.labels] }),
              ...(query.query === undefined ? {} : { query: query.query }),
              ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
              ...(query.sort === undefined ? {} : { sort: query.sort }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            })
            .pipe(Effect.mapError(failed("Could not list issues")));
          // A listing answers with what it could read. One that read nothing is a failure.
          const problem = result.errors[0];
          if (result.entries.length === 0 && problem !== undefined) {
            return yield* new WorkflowForgeError({
              reason: `Could not list issues: ${problem.message}`,
            });
          }
          return result.entries;
        }),
        read: Effect.fn("WorkflowForge.issues.read")(function* (issue) {
          return yield* issues
            .detail(yield* issueRef(issue))
            .pipe(Effect.mapError(failed("Could not read the issue")));
        }),
        comment: Effect.fn("WorkflowForge.issues.comment")(function* (issue, body) {
          yield* issues
            .comment({ ...(yield* issueRef(issue)), body })
            .pipe(Effect.mapError(failed("Could not comment on the issue")));
        }),
        setState: Effect.fn("WorkflowForge.issues.setState")(function* (issue, state) {
          yield* issues
            .setState({ ...(yield* issueRef(issue)), state })
            .pipe(Effect.mapError(failed("Could not change the issue's state")));
        }),
        create: Effect.fn("WorkflowForge.issues.create")(function* (input) {
          const scope = yield* issues
            .projectScope(yield* projectIdOf(input.project))
            .pipe(Effect.mapError(failed("Could not find the project's issue tracker")));
          return yield* issues
            .create({
              projectId: scope.projectId,
              tracker: scope.tracker,
              host: scope.host,
              scope: scope.scope,
              title: input.title,
              body: input.body ?? "",
              labels: [...(input.labels ?? [])],
              assignees: [...(input.assignees ?? [])],
            })
            .pipe(Effect.mapError(failed("Could not file the issue")));
        }),
      },
      pullRequests: {
        list: Effect.fn("WorkflowForge.pullRequests.list")(function* (query) {
          const result = yield* pullRequests
            .list({
              projectId: yield* projectIdOf(query.project),
              state: query.state ?? "open",
              ...(query.query === undefined ? {} : { query: query.query }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            })
            .pipe(Effect.mapError(failed("Could not list pull requests")));
          const problem = result.errors[0];
          if (result.entries.length === 0 && problem !== undefined) {
            return yield* new WorkflowForgeError({
              reason: `Could not list pull requests: ${problem.message}`,
            });
          }
          return result.entries;
        }),
        read: Effect.fn("WorkflowForge.pullRequests.read")(function* (pullRequest) {
          return yield* pullRequests
            .detail(yield* pullRequestRef(pullRequest))
            .pipe(Effect.mapError(failed("Could not read the pull request")));
        }),
        comment: Effect.fn("WorkflowForge.pullRequests.comment")(function* (pullRequest, body) {
          yield* pullRequests
            .comment({ ...(yield* pullRequestRef(pullRequest)), body })
            .pipe(Effect.mapError(failed("Could not comment on the pull request")));
        }),
        act: Effect.fn("WorkflowForge.pullRequests.act")(function* (pullRequest, action, options) {
          yield* pullRequests
            .runAction({
              ...(yield* pullRequestRef(pullRequest)),
              action,
              ...(options?.mergeMethod === undefined ? {} : { mergeMethod: options.mergeMethod }),
            })
            .pipe(Effect.mapError(failed(`Could not ${action} the pull request`)));
        }),
      },
    });
  }),
);
