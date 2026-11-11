import {
  CommandId,
  type PullRequestRef,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitManager from "../../../git/GitManager.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import { resolveTarget, type ResolvedTarget } from "../../../pullRequest/pullRequestTarget.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import { pullRequestSyncKey } from "../../../pullRequest/pullRequestSyncKey.ts";
import { sourceControlDefinitions } from "../../../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "../../../sourceControl/threadPullRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { threadNotFound } from "../../threadAccess.ts";
import {
  type ListThreadPullRequestsResult,
  PullRequestBranchHasNoneError,
  PullRequestForgeError,
  PullRequestNothingToDoError,
  type PullRequestReadSection,
  type ReadPullRequestResult,
  type ThreadPullRequestInput,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  type PullRequestTargetInput,
  PullRequestThreadRequiredError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  PullRequestsToolkit,
  type ThreadPullRequestEntry,
  CHILD_PULL_REQUEST_REPORT_NEXT,
} from "./tools.ts";

function entryOf(
  link: ThreadPullRequestLink,
  chains: ReturnType<typeof resolveThreadPullRequestChains>,
): ThreadPullRequestEntry {
  const key = threadPullRequestKeyOf(link);
  let stack: ThreadPullRequestEntry["stack"] = null;
  for (const chain of chains) {
    if (chain.layers.length < 2) continue;
    const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === key);
    if (index !== -1) {
      stack = { kind: chain.kind, position: chain.depths[index]! + 1, size: chain.layers.length };
      break;
    }
  }
  return {
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    watching: link.watch !== undefined,
    state: link.snapshot?.state ?? null,
    title: link.snapshot?.title ?? null,
    headBranch: link.snapshot?.headBranch ?? null,
    baseBranch: link.snapshot?.baseBranch ?? null,
    isDraft: link.snapshot?.isDraft ?? null,
    stack,
  };
}

export function listThreadPullRequests(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests">,
): ListThreadPullRequestsResult {
  const chains = resolveThreadPullRequestChains(thread.pullRequests ?? []);
  return {
    pullRequests: visibleThreadPullRequests(thread.pullRequests ?? []).map((link) =>
      entryOf(link, chains),
    ),
    chains: chains.map((chain) => ({
      kind: chain.kind,
      numbers: chain.layers.map((layer) => layer.number),
    })),
  };
}

function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // Match the guide service's host-level repository key, including Azure DevOps org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    const projectKey =
      project.repositoryIdentity == null
        ? null
        : pullRequestSyncKey(
            {
              projectId: project.id,
              repository:
                sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? "",
              number: 1,
            },
            project.repositoryIdentity,
          );
    return (
      own !== null &&
      projectKey !== null &&
      own.host === projectKey.host &&
      own.repository === projectKey.repository
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
  const watches = yield* PullRequestWatchService.PullRequestWatchService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitManager.GitManager;

  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;

  const commandId = (tag: string, threadId: ThreadId) =>
    random.uuidV4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("PullRequestsToolkit.requireThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestListFailedError
      | typeof PullRequestForgeError,
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new PullRequestThreadRequiredError();
    }
    const thread = yield* engine.getThreadShell(threadId).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.mapError((cause) => new Failure({ cause })),
    );
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* threadNotFound(engine, threadId, `Thread ${threadId} was not found.`);
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestForgeError,
  ) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new Failure({ cause })),
    );

  const dispatchFailure =
    (Failure: typeof PullRequestLinkFailedError | typeof PullRequestUnlinkFailedError) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<never, PullRequestLinkFailedError | PullRequestUnlinkFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  // The domain service owns the registration span.
  const setWatching = Effect.fnUntraced(function* (
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new PullRequestThreadRequiredError();
    return yield* watches.setWatching({ threadId, target: input, watching }).pipe(
      Effect.catchTags({
        PullRequestWatchThreadNotFoundError: (error) =>
          threadNotFound(engine, error.threadId, error.message),
      }),
    );
  });

  const locateAll = Effect.fn("PullRequestsToolkit.locateAll")(function* (
    targets: ReadonlyArray<Omit<PullRequestTargetInput, "threadId">>,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const callerThread =
      scope.thread === undefined
        ? undefined
        : yield* engine.getThreadShell(scope.thread.threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((shell) => shell ?? undefined),
          );
    const known = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    const callerProject = known.find((project) => project.id === callerThread?.projectId);
    // A pull request named by host and repository builds its URL through the project that holds
    // it, which need not be the caller's.
    const urlProject = (input: PullRequestTargetInput) =>
      input.url === undefined && input.host !== undefined && input.repository !== undefined
        ? (projectForPullRequest(
            known,
            { host: input.host, repository: input.repository },
            callerProject,
          ) ?? callerProject)
        : callerProject;
    return yield* Effect.forEach(targets, (input) =>
      resolveTarget(input, urlProject(input)).pipe(
        Effect.map((target) => ({
          input,
          target,
          project: projectForPullRequest(known, target, callerProject),
          failure: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({ input, target: null, project: undefined, failure: error.message }),
        ),
      ),
    );
  });

  const guideReference = (
    project: OrchestrationProjectShell,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  const guideFailureDetail = (error: { readonly message: string }) =>
    "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  const forgeFailure = (error: { readonly message: string }) =>
    new PullRequestForgeError({ detail: error.message, cause: error });

  /** The thread's checkout, its project, and the PR the input names (default: the branch's). */
  const locate = Effect.fn("PullRequestsToolkit.locate")(function* (input: ThreadPullRequestInput) {
    const thread = yield* requireThread(PullRequestForgeError, undefined);
    const project = yield* projectOf(thread, PullRequestForgeError);
    if (project === undefined) {
      return yield* new PullRequestProjectNotFoundError({ repository: input.repository ?? "" });
    }
    // Status sync sets branchPullRequest later, so a PR this thread just opened counts too,
    // unless it is another branch's.
    const opened =
      thread.branchPullRequest === null || thread.branchPullRequest === undefined
        ? threadPullRequestsOf(thread).findLast(
            (link) =>
              link.source === "created" &&
              (link.snapshot === null || link.snapshot.headBranch === thread.branch),
          )
        : undefined;
    const branchPullRequest = thread.branchPullRequest ?? opened ?? null;
    const branchRepository =
      project.repositoryIdentity == null
        ? undefined
        : (sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? undefined);
    const named =
      input.number !== undefined
        ? { number: input.number, repository: input.repository ?? branchRepository }
        : branchPullRequest === null
          ? null
          : { number: branchPullRequest.number, repository: branchPullRequest.repository };
    if (named === null) return yield* new PullRequestBranchHasNoneError();
    const target = yield* resolveTarget(named, project);
    const ref: PullRequestRef = {
      projectId: project.id,
      host: target.host,
      repository: target.repository,
      number: target.number,
    };
    if (input.number === undefined && opened !== undefined && opened.snapshot === null) {
      // Not synced yet, so only the host knows which branch it was opened from.
      const summary = yield* pullRequests.summary(ref).pipe(Effect.mapError(forgeFailure));
      if (summary.headBranch !== thread.branch) return yield* new PullRequestBranchHasNoneError();
    }
    return { thread, project, target, ref };
  });

  const identityOf = (target: ResolvedTarget) => ({
    host: target.host,
    repository: target.repository,
    number: target.number,
    url: target.url,
  });

  const readSections = Effect.fn("PullRequestsToolkit.readSections")(function* (
    ref: PullRequestRef,
    sections: ReadonlyArray<PullRequestReadSection>,
    includeResolved: boolean,
    diffCursor: string | undefined,
  ) {
    const wants = (section: PullRequestReadSection) => sections.includes(section);
    const [detail, activity, diff] = yield* Effect.all(
      [
        // Agents pin merges to this headSha, so it must not come from a stale snapshot.
        wants("summary") || wants("checks")
          ? pullRequests.detail({ ...ref, allowStale: false }).pipe(Effect.asSome)
          : Effect.succeedNone,
        wants("conversation") ? pullRequests.activity(ref).pipe(Effect.asSome) : Effect.succeedNone,
        wants("diff")
          ? pullRequests
              .diff({ ...ref, ...(diffCursor === undefined ? {} : { cursor: diffCursor }) })
              .pipe(Effect.asSome)
          : Effect.succeedNone,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(forgeFailure));
    const result: Omit<ReadPullRequestResult, "host" | "repository" | "number" | "url"> = {
      ...(Option.isSome(detail) && wants("summary")
        ? {
            summary: {
              title: detail.value.title,
              body: detail.value.body,
              state: detail.value.state,
              isDraft: detail.value.isDraft,
              author: detail.value.author?.login ?? null,
              headBranch: detail.value.headBranch,
              baseBranch: detail.value.baseBranch,
              headSha: detail.value.headSha ?? null,
              mergeability: detail.value.mergeability,
              behindBy: detail.value.behindBy ?? null,
              autoMergeEnabled: detail.value.autoMergeEnabled ?? null,
              additions: detail.value.additions,
              deletions: detail.value.deletions,
              changedFiles: detail.value.changedFiles,
              labels: detail.value.labels.map((label) => label.name),
              reviewers: detail.value.reviewers.map((reviewer) => reviewer.login),
            },
          }
        : {}),
      ...(Option.isSome(detail) && wants("checks") ? { checks: detail.value.checks } : {}),
      ...(Option.isSome(activity)
        ? {
            conversation: {
              comments: activity.value.comments.map((comment) => ({
                id: comment.id,
                kind: comment.kind,
                author: comment.author?.login ?? null,
                body: comment.body,
                createdAt: comment.createdAt,
                path: comment.path,
                reviewState: comment.reviewState,
              })),
              reviewThreads: activity.value.reviewThreads
                .filter((thread) => includeResolved || !thread.isResolved)
                .map((thread) => ({
                  id: thread.id,
                  path: thread.path,
                  line: thread.line,
                  isResolved: thread.isResolved,
                  isOutdated: thread.isOutdated,
                  comments: thread.comments.map((comment) => ({
                    author: comment.author?.login ?? null,
                    body: comment.body,
                    createdAt: comment.createdAt,
                  })),
                  moreComments: thread.nextCommentsCursor !== undefined,
                })),
              hiddenResolvedThreads: includeResolved
                ? 0
                : activity.value.reviewThreads.filter((thread) => thread.isResolved).length,
              truncated:
                activity.value.commentsTruncated || activity.value.reviewThreadsTruncated === true,
            },
          }
        : {}),
      ...(Option.isSome(diff)
        ? {
            diff: {
              patch: diff.value.patch,
              truncated: diff.value.truncated,
              nextCursor: diff.value.nextCursor,
            },
          }
        : {}),
    };
    return result;
  });

  const linkToThread = Effect.fn("PullRequestsToolkit.linkToThread")(function* (
    thread: OrchestrationV2ThreadShell,
    target: ResolvedTarget,
  ) {
    if (
      threadPullRequestsOf(thread).some(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      )
    ) {
      return;
    }
    yield* engine
      .dispatch({
        type: "thread.pull-request.link",
        commandId: yield* commandId("mcp-pr-create", thread.id),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        url: target.url,
        source: "created",
      })
      .pipe(Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)));
  });

  return {
    link_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const next =
          thread.lineage.relationshipToParent === "subagent"
            ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
            : {};
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
        const existing = threadPullRequestsOf(thread).find((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (existing && existing.source !== "stack-dismissed")
          return { ...target, alreadyLinked: true, ...next };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: yield* commandId("mcp-pr-link", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
            source: "agent",
          })
          .pipe(
            Effect.as(false),

            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked, ...next };
      }),
    ),
    link_pull_requests: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const targets: Array<ResolvedTarget> = [];
        const invalidUrls: Array<string> = [];
        for (const url of input.urls) {
          const target = yield* resolveTarget({ url }, undefined).pipe(Effect.option);
          if (Option.isNone(target)) invalidUrls.push(url);
          else if (!targets.some((seen) => threadPullRequestKeysEqual(seen, target.value)))
            targets.push(target.value);
        }
        const links = threadPullRequestsOf(thread);
        const isLinked = (target: ResolvedTarget) =>
          links.some(
            (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
          );
        const fresh = targets.filter((target) => !isLinked(target));
        const alreadyLinked = targets.filter(isLinked);
        yield* Effect.forEach(fresh, (target) =>
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.pull-request.link",
              commandId: yield* commandId("mcp-pr-link", thread.id),
              threadId: thread.id,
              host: target.host,
              repository: target.repository,
              number: target.number,
              url: target.url,
              source: "agent",
            });
          }).pipe(Effect.catchCause(dispatchFailure(PullRequestLinkFailedError))),
        );
        const byRepository = (prs: ReadonlyArray<ResolvedTarget>) =>
          [...Map.groupBy(prs, (pr) => `${pr.host}/${pr.repository}`).values()].map((group) => ({
            host: group[0]!.host,
            repository: group[0]!.repository,
            numbers: group.map((pr) => pr.number),
          }));
        return {
          linked: byRepository(fresh),
          alreadyLinked: byRepository(alreadyLinked),
          linkedCount: targets.length,
          ...(invalidUrls.length > 0 ? { invalidUrls } : {}),
          ...(thread.lineage.relationshipToParent === "subagent"
            ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
            : {}),
        };
      }),
    ),
    unlink_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
        const target = yield* resolveTarget(input, project);
        if (
          !threadPullRequestsOf(thread).some(
            (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
          )
        )
          return {
            host: target.host,
            repository: target.repository,
            number: target.number,
            wasLinked: false,
          };
        const wasLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.unlink",
            commandId: yield* commandId("mcp-pr-unlink", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
          })
          .pipe(
            Effect.as(true),

            Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError)),
          );
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked,
        };
      }),
    ),
    unlink_pull_requests: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const visible = visibleThreadPullRequests(threadPullRequestsOf(thread));
        const matching = visible.flatMap((link) => {
          const state = link.snapshot?.state;
          return state !== undefined && input.states.includes(state)
            ? [{ ...normalizeThreadPullRequestKey(link), state }]
            : [];
        });
        yield* Effect.forEach(matching, ({ host, repository, number }) =>
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.pull-request.unlink",
              commandId: yield* commandId("mcp-pr-unlink", thread.id),
              threadId: thread.id,
              host,
              repository,
              number,
            });
          }).pipe(Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError))),
        );
        // Numbers grouped by repository and state keep a large batch's result small.
        const groups = Map.groupBy(matching, (pr) => `${pr.host}/${pr.repository}/${pr.state}`);
        return {
          unlinked: [...groups.values()].map((prs) => ({
            host: prs[0]!.host,
            repository: prs[0]!.repository,
            state: prs[0]!.state,
            numbers: prs.map((pr) => pr.number),
          })),
          unlinkedCount: matching.length,
          remaining: visible.length - matching.length,
        };
      }),
    ),
    list_thread_pull_requests: McpToolAccess.reads((input) =>
      requireThread(PullRequestListFailedError, input.threadId).pipe(
        Effect.map(listThreadPullRequests),
      ),
    ),
    watch_pull_request: writesThread((input) => setWatching(input, true)),
    unwatch_pull_request: writesThread((input) => setWatching(input, false)),
    write_pull_request_guides: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const located = yield* locateAll(input.pullRequests);
        const guides = yield* Effect.forEach(
          located,
          (entry) =>
            Effect.gen(function* () {
              if (entry.target === null) {
                return {
                  host: entry.input.host ?? "",
                  repository: entry.input.repository ?? "",
                  number: entry.input.number ?? 0,
                  url: entry.input.url ?? "",
                  outcome: "failed" as const,
                  detail: entry.failure,
                };
              }
              const identity = {
                host: entry.target.host,
                repository: entry.target.repository,
                number: entry.target.number,
                url: entry.target.url,
              };
              if (entry.project === undefined) {
                return {
                  ...identity,
                  outcome: "failed" as const,
                  detail: new PullRequestProjectNotFoundError({
                    repository: entry.target.repository,
                  }).message,
                };
              }
              return yield* reviewGuides.generate(guideReference(entry.project, entry.target)).pipe(
                Effect.map((result) => ({
                  ...identity,
                  outcome: result.started ? ("started" as const) : ("running" as const),
                  detail: null,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    ...identity,
                    outcome: "failed" as const,
                    detail: guideFailureDetail(error),
                  }),
                ),
              );
            }),
          { concurrency: 4 },
        );
        return { guides };
      }),
    ),
    read_pull_request_guide: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const [entry] = yield* locateAll([input]);
        if (entry !== undefined && entry.target === null) {
          return yield* new PullRequestGuideFailedError({ detail: entry.failure ?? "" });
        }
        if (entry === undefined || entry.target === null || entry.project === undefined) {
          return yield* new PullRequestProjectNotFoundError({
            repository: entry?.target.repository ?? input.repository ?? "",
          });
        }
        const result = yield* reviewGuides.get(guideReference(entry.project, entry.target)).pipe(
          Effect.mapError(
            (error) =>
              new PullRequestGuideFailedError({
                detail: guideFailureDetail(error),
                cause: error,
              }),
          ),
        );
        return {
          host: entry.target.host,
          repository: entry.target.repository,
          number: entry.target.number,
          url: entry.target.url,
          guide: result.guide,
          run: result.run,
          currentHeadSha: result.currentHeadSha,
          stale:
            result.guide !== null &&
            result.currentHeadSha !== null &&
            result.guide.headSha !== result.currentHeadSha,
        };
      }),
    ),
    pull_request_read: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locate(input);
        const sections = input.sections ?? ["summary", "checks"];
        return {
          ...identityOf(target),
          ...(yield* readSections(ref, sections, input.includeResolved === true, input.diffCursor)),
        };
      }),
    ),
    pull_request_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestForgeError, undefined);
        const listed = yield* pullRequests
          .list({
            projectId: thread.projectId,
            state: input.state ?? "open",
            involvement: input.involvement ?? "all",
            limit: input.limit ?? 30,
            ...(input.query === undefined ? {} : { query: input.query }),
          })
          .pipe(Effect.mapError(forgeFailure));
        const failure = listed.errors[0];
        if (listed.entries.length === 0 && failure !== undefined) {
          return yield* new PullRequestForgeError({ detail: failure.message });
        }
        return {
          pullRequests: listed.entries.map((entry) => ({
            number: entry.number,
            title: entry.title,
            url: entry.url,
            author: entry.author?.login ?? null,
            headBranch: entry.headBranch,
            baseBranch: entry.baseBranch,
            state: entry.state,
            isDraft: entry.isDraft,
            reviewDecision: entry.reviewDecision ?? null,
            checksState: entry.checksState ?? null,
            updatedAt: entry.updatedAt,
          })),
          truncated: listed.truncated,
        };
      }),
    ),
    pull_request_create: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestForgeError, undefined);
        const project = yield* projectOf(thread, PullRequestForgeError);
        if (project === undefined) {
          return yield* new PullRequestProjectNotFoundError({ repository: "" });
        }
        const created = yield* git
          .createPullRequest({
            cwd: thread.worktreePath ?? project.workspaceRoot,
            title: input.title,
            body: input.body,
            baseBranch: input.base,
          })
          .pipe(Effect.mapError(forgeFailure));
        if (created.url === undefined) {
          return yield* new PullRequestForgeError({
            detail:
              "The host accepted the PR but does not list it yet. Find it with pull_request_list.",
          });
        }
        const target = yield* resolveTarget({ url: created.url }, project);
        yield* linkToThread(thread, target);
        const ref = {
          projectId: project.id,
          host: target.host,
          repository: target.repository,
          number: target.number,
        };
        // A retry after a failed draft finds the PR it opened, so it checks the draft state.
        const needsDraft =
          input.draft === true &&
          (created.status === "created" ||
            !(yield* pullRequests
              .summary({ ...ref, allowStale: false })
              .pipe(Effect.mapError(forgeFailure))).isDraft);
        if (needsDraft) {
          yield* pullRequests
            .runAction({ ...ref, action: "draft" })
            .pipe(Effect.mapError(forgeFailure));
        }
        return {
          ...identityOf(target),
          created: created.status === "created",
          ...(thread.lineage.relationshipToParent === "subagent"
            ? { next: CHILD_PULL_REQUEST_REPORT_NEXT }
            : {}),
        };
      }),
    ),
    pull_request_update: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        if (input.title === undefined && input.body === undefined && input.ready === undefined) {
          return yield* new PullRequestNothingToDoError({ detail: "Pass title, body, or ready." });
        }
        const { target, ref } = yield* locate(input);
        if (input.title !== undefined || input.body !== undefined) {
          yield* pullRequests
            .update({
              ...ref,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            })
            .pipe(Effect.mapError(forgeFailure));
        }
        if (input.ready !== undefined) {
          yield* pullRequests
            .runAction({ ...ref, action: input.ready ? "ready" : "draft" })
            .pipe(Effect.mapError(forgeFailure));
        }
        return identityOf(target);
      }),
    ),
    pull_request_respond: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        if (
          input.body === undefined &&
          (input.reviewThreadId === undefined || input.resolved === undefined)
        ) {
          return yield* new PullRequestNothingToDoError({
            detail: "Pass body, or reviewThreadId with resolved.",
          });
        }
        if (input.reviewThreadId === undefined && input.resolved !== undefined) {
          return yield* new PullRequestNothingToDoError({
            detail: "resolved needs reviewThreadId.",
          });
        }
        const { target, ref } = yield* locate(input);
        const reviewThreadId = input.reviewThreadId;
        if (input.body !== undefined) {
          yield* (
            reviewThreadId === undefined
              ? pullRequests.comment({ ...ref, body: input.body })
              : pullRequests.replyToThread({ ...ref, threadId: reviewThreadId, body: input.body })
          ).pipe(Effect.mapError(forgeFailure));
        }
        if (reviewThreadId !== undefined && input.resolved !== undefined) {
          yield* pullRequests
            .setThreadResolution({ ...ref, threadId: reviewThreadId, resolved: input.resolved })
            .pipe(
              Effect.mapError((error) =>
                input.body === undefined
                  ? forgeFailure(error)
                  : new PullRequestForgeError({
                      // A retry with the body would post the reply twice.
                      detail: `The reply was posted, but setting resolved failed: ${error.message} Retry without body.`,
                      cause: error,
                    }),
              ),
            );
        }
        return {
          ...identityOf(target),
          replied: input.body !== undefined,
          resolved: input.resolved ?? null,
        };
      }),
    ),
    pull_request_merge: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const { target, ref } = yield* locate(input);
        yield* pullRequests
          .runAction({
            ...ref,
            action: input.auto === true ? "enable-auto-merge" : "merge",
            expectedHeadSha: input.expectedHeadSha,
            ...(input.method === undefined ? {} : { mergeMethod: input.method }),
          })
          .pipe(Effect.mapError(forgeFailure));
        const after = yield* pullRequests
          .summary({ ...ref, allowStale: false })
          .pipe(Effect.mapError(forgeFailure));
        return { ...identityOf(target), state: after.state };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PullRequestsToolkit, make);
