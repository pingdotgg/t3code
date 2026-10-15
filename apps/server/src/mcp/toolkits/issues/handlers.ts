import {
  threadIssueKeysEqual,
  type IssueDetail,
  type IssueRef,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueService from "../../../issue/IssueService.ts";
import { resolveGitHostBinding } from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  IssueLinkFailedError,
  IssueProjectNotFoundError,
  IssueProjectRequiredError,
  IssuesToolkit,
  IssueTargetIncompleteError,
  type IssueTargetInput,
  IssueThreadNotFoundError,
  IssueThreadRequiredError,
  type ListThreadIssuesResult,
} from "./tools.ts";

/** A resolved reference, with the host the link stores and whether it may be written. */
interface ResolvedTarget extends IssueRef {
  readonly host: string;
  readonly url: string | null;
  readonly writable: boolean;
}

/** What the tools report from a thread shell; exported so the shape is testable without a layer. */
function listThreadIssues(
  thread: Pick<OrchestrationV2ThreadShell, "issues">,
): ListThreadIssuesResult {
  return {
    issues: (thread.issues ?? []).map((link) => ({
      projectId: link.projectId,
      tracker: link.tracker,
      host: link.host,
      scope: link.scope,
      key: link.key,
      url: link.url,
      source: link.source,
      displayKey: link.snapshot?.displayKey ?? null,
      title: link.snapshot?.title ?? null,
      state: link.snapshot?.state ?? null,
    })),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const issues = yield* IssueService.IssueService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const projects = yield* ProjectService.ProjectService;

  /** The caller's own thread, read when a tool defaults to it. */
  const callerThread = Effect.fn("IssuesToolkit.callerThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    return scope.thread === undefined
      ? undefined
      : yield* engine.getThreadShell(scope.thread.threadId).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((shell) => shell ?? undefined),
        );
  });

  const requireThread = Effect.fn("IssuesToolkit.requireThread")(function* (
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new IssueThreadRequiredError();
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.map(Option.fromNullishOr))
      .pipe(Effect.mapError((cause) => new IssueLinkFailedError({ cause })));
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new IssueThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  /** The project a key-only reference is read through: named, or the caller's thread's own. */
  const requireProject = Effect.fn("IssuesToolkit.requireProject")(function* (
    requested: ProjectId | undefined,
  ) {
    const projectId = requested ?? (yield* callerThread())?.projectId;
    if (projectId === undefined) return yield* new IssueProjectRequiredError();
    const project = yield* projects
      .getShell(projectId)
      .pipe(Effect.mapError((cause) => new IssueLinkFailedError({ cause })));
    const binding = Option.isSome(project) ? resolveGitHostBinding(project.value) : null;
    if (Option.isNone(project) || binding === null) {
      return yield* new IssueProjectNotFoundError({ projectId });
    }
    return { project: project.value, binding };
  });

  /**
   * Turns whichever shape the agent passed into one reference. A URL resolves through whichever
   * project here is a checkout of its repository; a key is completed with the named project's
   * binding, or the caller's thread's project.
   */
  const resolveTarget = Effect.fn("IssuesToolkit.resolveTarget")(function* (
    input: IssueTargetInput,
  ) {
    if (input.url !== undefined) {
      const preferred = input.projectId ?? (yield* callerThread())?.projectId;
      const resolved = yield* issues.resolveUrl(input.url, preferred);
      return { ...resolved, url: input.url } satisfies ResolvedTarget;
    }
    if (input.key === undefined) return yield* new IssueTargetIncompleteError();
    const { project, binding } = yield* requireProject(input.projectId);
    return {
      projectId: project.id,
      tracker: binding.tracker,
      host: binding.host,
      scope: binding.scope,
      key: input.key,
      url: null,
      writable: true,
    } satisfies ResolvedTarget;
  });

  const identityOf = (target: ResolvedTarget, detail?: Pick<IssueDetail, "url">) => ({
    projectId: target.projectId,
    tracker: target.tracker,
    host: target.host,
    scope: target.scope,
    key: target.key,
    url: target.url ?? detail?.url ?? "",
  });

  const refOf = (target: ResolvedTarget): IssueRef & { readonly host: string } => ({
    projectId: target.projectId,
    tracker: target.tracker,
    host: target.host,
    scope: target.scope,
    key: target.key,
  });

  /** A link needs the issue's URL, which a key-only reference does not carry; one read fills it. */
  const urlFor = (target: ResolvedTarget) =>
    target.url !== null
      ? Effect.succeed(target.url)
      : issues.detail(refOf(target)).pipe(Effect.map((detail) => detail.url));

  const linkFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new IssueLinkFailedError({ cause }));

  /** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    list_issues: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project } = yield* requireProject(input.projectId);
        const result = yield* issues.list({
          projectId: project.id,
          state: input.state ?? "open",
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursors === undefined ? {} : { cursors: input.cursors }),
        });
        return {
          issues: result.entries.map((entry) => ({
            projectId: entry.projectId,
            tracker: entry.tracker,
            host: entry.host,
            scope: entry.scope,
            key: entry.key,
            url: entry.url,
            displayKey: entry.displayKey,
            title: entry.title,
            state: entry.state,
            author: entry.author?.login ?? null,
            assignees: entry.assignees.map((actor) => actor.login),
            labels: entry.labels.map((label) => label.name),
            updatedAt: entry.updatedAt,
            commentCount: entry.commentCount,
          })),
          nextCursors: result.nextCursors,
          errors: result.errors.map((error) => ({
            projectId: error.projectId,
            message: error.message,
          })),
        };
      }),
    ),
    read_issue: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const detail = yield* issues.detail(refOf(target));
        return {
          ...identityOf(target, detail),
          displayKey: detail.displayKey,
          title: detail.title,
          state: detail.state,
          writable: detail.writable,
          capabilities: detail.capabilities,
          author: detail.author?.login ?? null,
          assignees: detail.assignees.map((actor) => actor.login),
          labels: detail.labels.map((label) => label.name),
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          closedAt: detail.closedAt,
          body: detail.body,
          comments: detail.comments.map((comment) => ({
            id: comment.id,
            author: comment.author?.login ?? null,
            body: comment.body,
            createdAt: comment.createdAt,
          })),
          commentsTruncated: detail.commentsCursor !== null,
          linkedPullRequests: detail.linkedPullRequests.map((pullRequest) => ({
            url: pullRequest.url,
            title: pullRequest.title,
            state: pullRequest.state,
            closesIssue: pullRequest.closesIssue,
          })),
        };
      }),
    ),
    create_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireProject(input.projectId);
        const created = yield* issues.create({
          projectId: project.id,
          ...binding,
          title: input.title,
          body: input.body ?? "",
          labels: input.labels ?? [],
          assignees: input.assignees ?? [],
        });
        return {
          projectId: project.id,
          ...binding,
          key: created.key,
          url: created.url,
          displayKey: created.displayKey,
        };
      }),
    ),
    comment_on_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.comment({ ...refOf(target), body: input.body });
        return identityOf(target);
      }),
    ),
    set_issue_state: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.setState({
          ...refOf(target),
          state: input.state,
          ...(input.closeReason === undefined ? {} : { closeReason: input.closeReason }),
        });
        return identityOf(target);
      }),
    ),
    link_issue: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(input.threadId);
        const target = yield* resolveTarget({
          ...input,
          projectId: input.projectId ?? thread.projectId,
        });
        const url = yield* urlFor(target);
        const { alreadyLinked } = yield* threadIssues
          .link({ threadId: thread.id, ref: refOf(target), url, source: "agent" })
          .pipe(Effect.catchCause(linkFailure));
        return { ...identityOf(target), url, alreadyLinked };
      }),
    ),
    unlink_issue: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(input.threadId);
        const target = yield* resolveTarget({
          ...input,
          projectId: input.projectId ?? thread.projectId,
        });
        const existing = (thread.issues ?? []).find((link) => threadIssueKeysEqual(link, target));
        if (existing === undefined) return { ...identityOf(target), wasLinked: false };
        const { wasLinked } = yield* threadIssues
          .unlink({ threadId: thread.id, key: target })
          .pipe(Effect.catchCause(linkFailure));
        return { ...identityOf(target), url: existing.url, wasLinked };
      }),
    ),
    list_thread_issues: McpToolAccess.reads((input) =>
      requireThread(input.threadId).pipe(Effect.map(listThreadIssues)),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssuesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssuesToolkit, make);
