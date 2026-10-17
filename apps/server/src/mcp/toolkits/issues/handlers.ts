import {
  IssueOperationError,
  threadIssueKeysEqual,
  type IssueDetail,
  type IssueRef,
  type IssueTrackerKind,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  IssueLinkFailedError,
  IssueProjectNotFoundError,
  IssueProjectRequiredError,
  IssueSourceSelectionError,
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

function listThreadIssues(
  thread: Pick<OrchestrationV2ThreadShell, "issues">,
): ListThreadIssuesResult {
  return {
    issues: (thread.issues ?? []).map((link) => ({
      projectId: link.projectId,
      tracker: link.tracker,
      ...(link.connectionId === undefined ? {} : { connectionId: link.connectionId }),
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
    yield* McpInvocationContext.requireMcpCapability("issues");
    const projectId = requested ?? (yield* callerThread())?.projectId;
    if (projectId === undefined) return yield* new IssueProjectRequiredError();
    const project = yield* projects
      .getShell(projectId)
      .pipe(Effect.mapError((cause) => new IssueLinkFailedError({ cause })));
    if (Option.isNone(project)) {
      return yield* new IssueProjectNotFoundError({ projectId });
    }
    return { project: project.value };
  });

  const requireSource = Effect.fn("IssuesToolkit.requireSource")(function* (
    requestedProject: ProjectId | undefined,
    requestedTracker: IssueTrackerKind | undefined,
    connectionId: string | undefined,
  ) {
    const { project } = yield* requireProject(requestedProject);
    const sources = yield* issues.sources(project.id);
    if (sources.length === 0)
      return yield* new IssueProjectNotFoundError({ projectId: project.id });
    const matches =
      requestedTracker === undefined
        ? sources
        : sources.filter((source) => source.tracker === requestedTracker);
    const selected = matches.filter((source) => source.connectionId === connectionId);
    const binding = selected.length === 1 ? selected[0] : undefined;
    if (binding === undefined)
      return yield* new IssueSourceSelectionError({
        projectId: project.id,
        ...(requestedTracker === undefined ? {} : { tracker: requestedTracker }),
        sources,
      });
    return { project, binding };
  });

  /**
   * Turns whichever shape the agent passed into one reference. A URL resolves through whichever
   * project here is a checkout of its repository; a key is completed with the named project's
   * binding, or the caller's thread's project.
   */
  const resolveTarget = Effect.fn("IssuesToolkit.resolveTarget")(function* (
    input: IssueTargetInput,
  ) {
    yield* McpInvocationContext.requireMcpCapability("issues");
    if (input.url !== undefined) {
      const preferred = input.projectId ?? (yield* callerThread())?.projectId;
      const resolved = yield* issues.resolveUrl(input.url, preferred, input.connectionId);
      return { ...resolved, url: input.url } satisfies ResolvedTarget;
    }
    if (input.key === undefined) return yield* new IssueTargetIncompleteError();
    if (input.scope !== undefined && input.tracker !== undefined && input.host !== undefined) {
      const { project } = yield* requireProject(input.projectId);
      return {
        projectId: project.id,
        tracker: input.tracker,
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
        host: input.host,
        scope: input.scope,
        key: input.key,
        url: null,
        writable: false,
      } satisfies ResolvedTarget;
    }
    const { project, binding } = yield* requireSource(
      input.projectId,
      input.tracker,
      input.connectionId,
    );
    return {
      projectId: project.id,
      tracker: binding.tracker,
      ...(binding.connectionId === undefined ? {} : { connectionId: binding.connectionId }),
      host: input.host ?? binding.host,
      scope: input.scope ?? binding.scope,
      key: input.key,
      url: null,
      writable: true,
    } satisfies ResolvedTarget;
  });

  const identityOf = (
    target: Omit<ResolvedTarget, "writable">,
    detail?: Pick<IssueDetail, "url">,
  ) => ({
    projectId: target.projectId,
    tracker: target.tracker,
    ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
    host: target.host,
    scope: target.scope,
    key: target.key,
    url: target.url ?? detail?.url ?? "",
  });

  const refOf = (target: ResolvedTarget): IssueRef & { readonly host: string } => ({
    projectId: target.projectId,
    tracker: target.tracker,
    ...(target.connectionId === undefined ? {} : { connectionId: target.connectionId }),
    host: target.host,
    scope: target.scope,
    key: target.key,
  });

  const linkFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new IssueLinkFailedError({ cause }));

  /** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    list_issue_sources: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("issues");
        const projectId = input.projectId ?? (yield* callerThread())?.projectId;
        if (projectId !== undefined) yield* requireProject(projectId);
        else if (scope.thread !== undefined) return yield* new IssueProjectRequiredError();
        return {
          sources: yield* issues.listSources({
            ...input,
            ...(projectId === undefined ? {} : { projectId }),
          }),
        };
      }),
    ),
    read_issue_history: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        return yield* issues.history({
          ...refOf(target),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    read_issue_dependencies: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        return yield* issues.dependencies({
          ...refOf(target),
          direction: input.direction,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    set_issue_dependency: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.setDependency({
          ...refOf(target),
          direction: input.direction,
          targetScope: input.targetScope,
          targetKey: input.targetKey,
          linked: input.linked,
        });
        return identityOf(target);
      }),
    ),
    read_issue_hierarchy: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        return yield* issues.hierarchy({
          ...refOf(target),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    read_issue_linked_pull_requests: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        return yield* issues.linkedPullRequests({
          ...refOf(target),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    read_issue_templates: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.templates({
          projectId: project.id,
          ...binding,
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.metadataOnly === undefined ? {} : { metadataOnly: input.metadataOnly }),
          ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
        });
      }),
    ),
    list_issue_labels: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.labelCandidates({
          projectId: project.id,
          ...binding,
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    list_issue_assignees: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.assigneeCandidates({
          projectId: project.id,
          ...binding,
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
      }),
    ),
    update_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.update({
          ...refOf(target),
          ...(input.richBody === undefined ? {} : { richBody: input.richBody }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        });
        return identityOf(target);
      }),
    ),
    edit_issue_comment: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.editComment({
          ...refOf(target),
          commentId: input.commentId,
          body: input.body,
          ...(input.richBody === undefined ? {} : { richBody: input.richBody }),
        });
        return identityOf(target);
      }),
    ),
    set_issue_reaction: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.react({
          ...refOf(target),
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        });
        return identityOf(target);
      }),
    ),
    set_issue_labels: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.update({ ...refOf(target), labels: input.labels });
        return identityOf(target);
      }),
    ),
    set_issue_assignees: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.update({ ...refOf(target), assignees: input.assignees });
        return identityOf(target);
      }),
    ),
    set_issue_parent: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        yield* issues.setParent({ ...refOf(target), parentKey: input.parentKey });
        return identityOf(target);
      }),
    ),
    list_issues: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project } = yield* requireProject(input.projectId);
        const result = yield* issues.list({
          projectId: project.id,
          state: input.state ?? "open",
          ...(input.tracker === undefined ? {} : { tracker: input.tracker }),
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
          ...(input.stateCategories === undefined
            ? {}
            : { stateCategories: input.stateCategories }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.involvement === undefined ? {} : { involvement: input.involvement }),
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursors === undefined ? {} : { cursors: input.cursors }),
        });
        return {
          issues: result.entries.map((entry) => ({
            projectId: entry.projectId,
            tracker: entry.tracker,
            ...(entry.connectionId === undefined ? {} : { connectionId: entry.connectionId }),
            host: entry.host,
            scope: entry.scope,
            key: entry.key,
            url: entry.url,
            ...(entry.itemType === undefined ? {} : { itemType: entry.itemType }),
            displayKey: entry.displayKey,
            title: entry.title,
            state: entry.state,
            author: entry.author?.login ?? null,
            authorDetails: entry.author,
            assigneeDetails: entry.assignees,
            assignees: entry.assignees.map((actor) => actor.login),
            labels: entry.labels.map((label) => label.name),
            labelDetails: entry.labels,
            ...(entry.labelsTruncated === undefined
              ? {}
              : { labelsTruncated: entry.labelsTruncated }),
            ...(entry.milestone === undefined ? {} : { milestone: entry.milestone }),
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            closedAt: entry.closedAt,
            commentCount: entry.commentCount,
            ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }),
            ...(entry.reactionsTruncated === undefined
              ? {}
              : { reactionsTruncated: entry.reactionsTruncated }),
          })),
          nextCursors: result.nextCursors,
          errors: result.errors.map((error) => ({
            projectId: error.projectId,
            ...(error.connectionId === undefined ? {} : { connectionId: error.connectionId }),
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
          ...(detail.itemType === undefined ? {} : { itemType: detail.itemType }),
          displayKey: detail.displayKey,
          title: detail.title,
          state: detail.state,
          writable: detail.writable,
          capabilities: detail.capabilities,
          ...(detail.states === undefined ? {} : { states: detail.states }),
          viewer: detail.viewer,
          viewerPermissions: detail.viewerPermissions,
          author: detail.author?.login ?? null,
          authorDetails: detail.author,
          assigneeDetails: detail.assignees,
          assignees: detail.assignees.map((actor) => actor.login),
          labels: detail.labels.map((label) => label.name),
          labelDetails: detail.labels,
          ...(detail.labelsTruncated === undefined
            ? {}
            : { labelsTruncated: detail.labelsTruncated }),
          ...(detail.milestone === undefined ? {} : { milestone: detail.milestone }),
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          closedAt: detail.closedAt,
          body: detail.body,
          ...(detail.richBody === undefined ? {} : { richBody: detail.richBody }),
          ...(detail.externalLinks === undefined ? {} : { externalLinks: detail.externalLinks }),
          ...(detail.bodyEditable === undefined ? {} : { bodyEditable: detail.bodyEditable }),
          commentCount: detail.commentCount,
          ...(detail.reactions === undefined ? {} : { reactions: detail.reactions }),
          ...(detail.reactionsTruncated === undefined
            ? {}
            : { reactionsTruncated: detail.reactionsTruncated }),
          events: detail.events,
          ...(detail.historyTruncated === undefined
            ? {}
            : { historyTruncated: detail.historyTruncated }),
          comments: detail.comments.map((comment) => ({
            id: comment.id,
            author: comment.author?.login ?? null,
            authorDetails: comment.author,
            body: comment.body,
            ...(comment.richBody === undefined ? {} : { richBody: comment.richBody }),
            ...(comment.url === undefined ? {} : { url: comment.url }),
            createdAt: comment.createdAt,
            ...(comment.editedAt === undefined ? {} : { editedAt: comment.editedAt }),
            ...(comment.canEdit === undefined ? {} : { canEdit: comment.canEdit }),
            ...(comment.reactions === undefined ? {} : { reactions: comment.reactions }),
            ...(comment.reactionsTruncated === undefined
              ? {}
              : { reactionsTruncated: comment.reactionsTruncated }),
          })),
          commentsTruncated: detail.commentsCursor !== null,
          commentsCursor: detail.commentsCursor,
          linkedPullRequests: detail.linkedPullRequests.map((pullRequest) => ({
            url: pullRequest.url,
            title: pullRequest.title,
            state: pullRequest.state,
            closesIssue: pullRequest.closesIssue,
          })),
        };
      }),
    ),
    read_issue_comments: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.tracker !== undefined && input.scope !== undefined && input.key !== undefined) {
          const { project } = yield* requireProject(input.projectId);
          return yield* issues.comments({
            projectId: project.id,
            tracker: input.tracker,
            ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
            ...(input.host === undefined ? {} : { host: input.host }),
            scope: input.scope,
            key: input.key,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.order === undefined ? {} : { order: input.order }),
            ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
          });
        }
        const target = yield* resolveTarget(input);
        return yield* issues.comments({
          ...refOf(target),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
        });
      }),
    ),
    create_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        const created = yield* issues.create({
          projectId: project.id,
          ...binding,
          title: input.title,
          body: input.body ?? "",
          labels: input.labels ?? [],
          assignees: input.assignees ?? [],
          ...(input.fieldValues === undefined ? {} : { fieldValues: input.fieldValues }),
          ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
          ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
          ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
        });
        return {
          projectId: project.id,
          ...binding,
          ...created,
        };
      }),
    ),
    read_issue_candidates: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { project, binding } = yield* requireSource(
          input.projectId,
          input.tracker,
          input.connectionId,
        );
        return yield* issues.candidates({
          projectId: project.id,
          ...binding,
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(input.issueType === undefined ? {} : { issueType: input.issueType }),
        });
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
          ...(input.transitionId === undefined ? {} : { transitionId: input.transitionId }),
          ...(input.fieldValues === undefined ? {} : { fieldValues: input.fieldValues }),
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
        const initial =
          target.url === null
            ? yield* issues
                .detail(refOf(target))
                .pipe(Effect.map((detail) => ({ url: detail.url, detail })))
            : { url: target.url };
        const { alreadyLinked } = yield* threadIssues
          .link({ threadId: thread.id, ref: refOf(target), ...initial, source: "agent" })
          .pipe(Effect.catchCause(linkFailure));
        return { ...identityOf(target), url: initial.url, alreadyLinked };
      }),
    ),
    unlink_issue: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(input.threadId);
        const matchesExplicitFields = (link: ThreadIssueLink) =>
          ((input.url !== undefined && input.projectId === undefined) ||
            link.projectId === (input.projectId ?? thread.projectId)) &&
          threadIssueKeysEqual(link, {
            tracker: input.tracker ?? link.tracker,
            ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
            host: input.host ?? link.host,
            scope: input.scope ?? link.scope,
            key: input.key ?? link.key,
          });
        const matches = (thread.issues ?? []).filter(
          (link) =>
            (input.url !== undefined ? link.url === input.url : input.key !== undefined) &&
            matchesExplicitFields(link),
        );
        if (matches.length > 1)
          return yield* new IssueOperationError({
            operation: "unlink",
            detail:
              "Multiple saved issue links match. Pass projectId, tracker and key, or a unique url from list_thread_issues.",
          });
        const target =
          matches[0] ??
          (yield* resolveTarget({
            ...input,
            projectId: input.projectId ?? thread.projectId,
          }));
        const existing =
          matches[0] ??
          (thread.issues ?? []).find(
            (link) => matchesExplicitFields(link) && threadIssueKeysEqual(link, target),
          );
        if (existing === undefined) return { ...identityOf(target), wasLinked: false };
        const { wasLinked } = yield* threadIssues
          .unlink({ threadId: thread.id, key: existing })
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
