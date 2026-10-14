import {
  threadPullRequestsOf,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import {
  CommandId,
  pullRequestHostOf,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type SourceControlProviderKind,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import { pullRequestSyncKey } from "../../../pullRequest/pullRequestSyncKey.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type ListThreadPullRequestsResult,
  PullRequestLinkFailedError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotOpenError,
  type PullRequestTargetInput,
  PullRequestWatchFailedError,
  PullRequestWatchFromSubagentError,
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  PullRequestsToolkit,
  type ThreadPullRequestEntry,
} from "./tools.ts";

interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/** The project's host and provider supply defaults for a repository-and-number input. */
function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = (identity?.provider as SourceControlProviderKind | undefined) ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: pullRequestHostOf(identity, kind),
    kind,
  };
}

/**
 * Turns whichever shape the agent passed into one host-level identity. A URL
 * wins outright; otherwise the repository and number are completed with the
 * thread's project host, which is where an agent working in that checkout
 * almost always opened the pull request.
 */
const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTargetInput,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = parseChangeRequestUrl(input.url);
    if (parsed === null) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return { ...normalizeThreadPullRequestKey(parsed), url: input.url } satisfies ResolvedTarget;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const projectHost = projectHostAndProvider(project);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = input.repository.toLowerCase();
  const url =
    changeRequestUrlFor(
      // The project's kind only describes its own host; another host gets no URL guess.
      host === projectHost.host ? projectHost.kind : null,
      host,
      repository,
      input.number,
      project?.repositoryIdentity?.locator.remoteUrl,
    ) ?? `https://${host}/${repository}/pull/${input.number}`;
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url,
  } satisfies ResolvedTarget;
});

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
      stack = { kind: chain.kind, position: index + 1, size: chain.layers.length };
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

/** What the tools report from a thread shell; exported so the shape is testable without a layer. */
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

/**
 * The project a pull request is read through: the caller's own when its checkout is that
 * repository, else the first project here whose checkout is. Host reads are scoped to a project,
 * so a repository with no checkout in this environment cannot be guided from it.
 */
function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // The same rule the guide service uses: a pull request reads through a project whose checkout
  // names it with the same host-level key, which also maps Azure DevOps' org/project/_git/repo.
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
              repository: sourceControlRepositorySelector(project.repositoryIdentity) ?? "",
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

  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("PullRequestsToolkit.requireThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestListFailedError
      | typeof PullRequestWatchFailedError,
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new PullRequestThreadRequiredError();
    }
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.map(Option.fromNullishOr))
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new PullRequestThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestWatchFailedError,
  ) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new Failure({ cause })),
    );

  const dispatchFailure =
    (
      Failure:
        | typeof PullRequestLinkFailedError
        | typeof PullRequestUnlinkFailedError
        | typeof PullRequestWatchFailedError,
    ) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<
      never,
      PullRequestLinkFailedError | PullRequestUnlinkFailedError | PullRequestWatchFailedError
    > =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  /**
   * Starts or stops a watch. One command links an unlinked pull request and watches it, and the
   * result reports the state the thread holds afterwards.
   */
  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireThread(PullRequestWatchFailedError, input.threadId);
    const project = yield* projectOf(thread, PullRequestWatchFailedError);
    const target = yield* resolveTarget(input, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    // A merged pull request cannot reopen. A closed one can, and its saved state may be stale,
    // so the watch starts and its first read ends it if the host still says closed.
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: yield* commandId("mcp-pr-watch", thread.id),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(Effect.catchCause(dispatchFailure(PullRequestWatchFailedError)));
    const after = yield* requireThread(PullRequestWatchFailedError, thread.id);
    return {
      host: target.host,
      repository: target.repository,
      number: target.number,
      url: target.url,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
  });

  /**
   * Resolves each requested pull request and the project it is read through. The caller's own
   * project wins where it is a checkout of that repository; with no thread, any project here may.
   */
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
    // Each target resolves on its own, so one bad URL in a batch is that entry's failure only.
    return yield* Effect.forEach(targets, (input) =>
      resolveTarget(input, callerProject).pipe(
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

  /** The service reads a pull request through one project's checkout and credentials. */
  const guideReference = (
    project: OrchestrationProjectShell,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  /** A host or service error, said as its own detail rather than its operation's wrapper. */
  const guideFailureDetail = (error: { readonly message: string }) =>
    "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

  /** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
        const existing = threadPullRequestsOf(thread).find((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (existing && existing.source !== "stack-dismissed")
          return { ...target, alreadyLinked: true };
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
            // The decider rejects a second link of the same PR; for the agent that is
            // the outcome it asked for, not an error.

            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked };
      }),
    ),
    unlink_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
        const target = yield* resolveTarget(input, project);
        if (!threadPullRequestsOf(thread).some((link) => threadPullRequestKeysEqual(link, target)))
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
        // One pull request that cannot be guided does not stop the rest; it reports why.
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
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PullRequestsToolkit, make);
