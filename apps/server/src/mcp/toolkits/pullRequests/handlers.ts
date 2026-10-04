import {
  threadPullRequestsOf,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import {
  CommandId,
  OrchestratorMcpFailure,
  pullRequestHostOf,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type PullRequestCheck,
  type PullRequestRef,
  type PullRequestReviewThread,
  type PullRequestThreadComment,
  type SourceControlProviderKind,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
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
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  assertTargetWithinLimits,
  readFullAccessCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
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
  PullRequestThreadNotFoundError,
  PullRequestThreadAboveLimitsError,
  PullRequestThreadRequiredError,
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

const DEFAULT_PULL_REQUEST_CHARACTERS = 20_000;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The host's own refusal (a missing label, no permission) is what the agent needs to recover. */
const hostFailure = (error: PullRequestService.PullRequestError) =>
  error._tag === "PullRequestUnavailableError"
    ? new OrchestratorMcpFailure({ code: "provider_unavailable", message: error.message })
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: error.message.slice(0, 2000),
      });

/** Cuts text to one character budget shared by a whole response, spent in the order asked. */
function textBudget(maxCharacters: number) {
  let remaining = maxCharacters;
  let truncated = false;
  return {
    take: (text: string) => {
      const kept = text.slice(0, remaining);
      remaining -= kept.length;
      if (kept.length < text.length) truncated = true;
      return kept;
    },
    get truncated() {
      return truncated;
    },
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

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;

  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
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

  /**
   * A thread whose pull requests the caller may change: its own, or one that
   * runs within the caller's modes.
   */
  const requireWritableThread = Effect.fn("PullRequestsToolkit.requireWritableThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestWatchFailedError,
    requested: ThreadId | undefined,
  ) {
    const thread = yield* requireThread(Failure, requested);
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (thread.id === scope.thread?.threadId) return thread;
    const limits =
      scope.thread === undefined
        ? {
            runtimeMode: scope.client?.runtimeModeCeiling ?? ("approval-required" as const),
            interactionMode: "default" as const,
          }
        : yield* engine.getThreadShell(scope.thread.threadId).pipe(
            Effect.mapError((cause) => new Failure({ cause })),
            Effect.map((caller) =>
              // A thread caller changes other threads only while its own run is live.
              caller === null ||
              caller.archivedAt !== null ||
              caller.activeRunId === null ||
              caller.providerInstanceId !== scope.thread?.providerInstanceId
                ? undefined
                : { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
            ),
          );
    if (limits === undefined) {
      return yield* new PullRequestThreadAboveLimitsError({ threadId: thread.id });
    }
    yield* assertTargetWithinLimits(limits, thread).pipe(
      Effect.mapError(() => new PullRequestThreadAboveLimitsError({ threadId: thread.id })),
    );
    return thread;
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
    const thread = yield* requireWritableThread(PullRequestWatchFailedError, input.threadId);
    const project = yield* projectOf(thread, PullRequestWatchFailedError);
    const target = yield* resolveTarget(input, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    const before = watchedLink(thread);
    const state = before?.snapshot?.state;
    if (watching && state !== undefined && state !== "open") {
      return yield* new PullRequestNotOpenError({ state });
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
   * The host pull request a host-facing tool addresses. The thread only picks the project whose
   * checkout and credentials the host CLI runs with, so writes are gated on full access rather
   * than on the thread.
   */
  const resolveHostRef = Effect.fn("PullRequestsToolkit.resolveHostRef")(function* (
    input: PullRequestTargetInput,
    writable: boolean,
  ) {
    yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot use pull requests.",
          }),
      ),
    );
    if (writable)
      yield* readFullAccessCaller(
        "Pull request writes require a live full-access/default thread or a full-access client.",
      );
    const {
      projection: { thread },
    } = yield* readThread(input.threadId);
    const project = yield* projects
      .getShell(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(unavailable));
    const target = yield* resolveTarget(input, project).pipe(
      Effect.mapError((error) => invalid(error.message)),
    );
    const ref: PullRequestRef = {
      projectId: thread.projectId,
      host: target.host,
      repository: target.repository,
      number: target.number,
    };
    return { target, ref, service: yield* PullRequestService.PullRequestService };
  });

  return PullRequestsToolkit.of({
    link_pull_request: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireWritableThread(PullRequestLinkFailedError, input.threadId);
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
    unlink_pull_request: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireWritableThread(PullRequestUnlinkFailedError, input.threadId);
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
    list_thread_pull_requests: (input) =>
      requireThread(PullRequestListFailedError, input.threadId).pipe(
        Effect.map(listThreadPullRequests),
      ),
    watch_pull_request: (input) => setWatching(input, true),
    unwatch_pull_request: (input) => setWatching(input, false),
    t3_pull_request_read: (input) =>
      Effect.gen(function* () {
        const { target, ref, service } = yield* resolveHostRef(input, false);
        const budget = textBudget(input.maxCharacters ?? DEFAULT_PULL_REQUEST_CHARACTERS);
        const empty = { overview: null, checks: null, conversation: null, reviewThread: null };
        const login = (actor: { readonly login: string } | null | undefined) =>
          actor?.login ?? null;
        const checkOf = (check: PullRequestCheck) => ({
          ...check,
          description: check.description === null ? null : budget.take(check.description),
        });
        const threadComment = (comment: PullRequestThreadComment) => ({
          id: comment.id,
          author: login(comment.author),
          body: budget.take(comment.body),
          createdAt: comment.createdAt,
          url: comment.url,
        });
        switch (input.section ?? "overview") {
          case "overview": {
            const detail = yield* service.detail(ref).pipe(Effect.mapError(hostFailure));
            const overview = {
              title: detail.title,
              body: budget.take(detail.body),
              state: detail.state,
              isDraft: detail.isDraft,
              author: login(detail.author),
              headBranch: detail.headBranch,
              baseBranch: detail.baseBranch,
              mergeability: detail.mergeability,
              baseComparison: detail.baseComparison ?? null,
              autoMergeEnabled: detail.autoMergeEnabled ?? null,
              additions: detail.additions,
              deletions: detail.deletions,
              changedFiles: detail.changedFiles,
              createdAt: detail.createdAt,
              updatedAt: detail.updatedAt,
              reviewers: detail.reviewers.map((reviewer) => reviewer.login),
              labels: detail.labels.map((label) => label.name),
              checks: detail.checks.map(checkOf),
            };
            return { ...target, ...empty, overview, truncated: budget.truncated };
          }
          case "checks": {
            const result = yield* service.checks(ref).pipe(Effect.mapError(hostFailure));
            const checks = (result?.checks ?? []).map(checkOf);
            return { ...target, ...empty, checks, truncated: budget.truncated };
          }
          case "conversation": {
            const activity = yield* service.activity(ref).pipe(Effect.mapError(hostFailure));
            const reviewThreadOf = (thread: PullRequestReviewThread) => ({
              id: thread.id,
              path: thread.path,
              line: thread.line,
              side: thread.side,
              isResolved: thread.isResolved,
              isOutdated: thread.isOutdated,
              comments: thread.comments.map(threadComment),
              nextCommentsCursor: thread.nextCommentsCursor ?? null,
            });
            // Budget order: unresolved threads, then comments newest first, then resolved threads.
            const unresolved = new Map(
              activity.reviewThreads
                .filter((thread) => !thread.isResolved)
                .map((thread) => [thread.id, reviewThreadOf(thread)] as const),
            );
            const comments = activity.comments
              .toReversed()
              .map((comment) => ({
                ...threadComment(comment),
                kind: comment.kind,
                path: comment.path,
                reviewState: comment.reviewState,
              }))
              .toReversed();
            const reviewThreads = activity.reviewThreads.map(
              (thread) => unresolved.get(thread.id) ?? reviewThreadOf(thread),
            );
            return {
              ...target,
              ...empty,
              conversation: { commentCount: activity.commentCount, comments, reviewThreads },
              truncated: budget.truncated || activity.commentsTruncated,
            };
          }
          case "review_thread": {
            if (input.reviewThreadId === undefined || input.cursor === undefined)
              return yield* invalid("Pass reviewThreadId and cursor for review_thread.");
            const page = yield* service
              .threadComments({ ...ref, threadId: input.reviewThreadId, cursor: input.cursor })
              .pipe(Effect.mapError(hostFailure));
            const reviewThread = {
              comments: page.comments.map(threadComment),
              nextCursor: page.nextCursor,
            };
            return { ...target, ...empty, reviewThread, truncated: budget.truncated };
          }
        }
      }),
    t3_pull_request_update: (input) =>
      Effect.gen(function* () {
        const { target, ref, service } = yield* resolveHostRef(input, true);
        const required = <A>(value: A | undefined, name: string) =>
          value === undefined
            ? Effect.fail(invalid(`Pass ${name} for ${input.action}.`))
            : Effect.succeed(value);
        switch (input.action) {
          case "comment":
            yield* service
              .comment({ ...ref, body: yield* required(input.body, "body") })
              .pipe(Effect.mapError(hostFailure));
            break;
          case "reply":
            yield* service
              .replyToThread({
                ...ref,
                threadId: yield* required(input.reviewThreadId, "reviewThreadId"),
                body: yield* required(input.body, "body"),
              })
              .pipe(Effect.mapError(hostFailure));
            break;
          case "resolve":
          case "unresolve":
            yield* service
              .setThreadResolution({
                ...ref,
                threadId: yield* required(input.reviewThreadId, "reviewThreadId"),
                resolved: input.action === "resolve",
              })
              .pipe(Effect.mapError(hostFailure));
            break;
          case "request_reviewers":
          case "unrequest_reviewers": {
            const named = yield* required(input.reviewers, "reviewers");
            // Hosts address reviewers by their own ids (GitLab a numeric id, Bitbucket a uuid), so
            // a login is matched against the candidates the reviewer menu would offer. A host with
            // no candidate list (Azure DevOps) takes the name as given, as the page does.
            const { capabilities, provider } = yield* service
              .detail(ref)
              .pipe(Effect.mapError(hostFailure));
            const list = capabilities.reviewers.listCandidates
              ? yield* service.reviewerCandidates(ref).pipe(Effect.mapError(hostFailure))
              : undefined;
            const candidates = list?.candidates;
            // GitHub and Forgejo take logins and team slugs as given; the candidate list also omits
            // teams not yet requested. Other hosts want their own ids, which a truncated list may
            // not reach, so an unmatched name passes through only when the list is incomplete.
            const passUnmatched =
              provider === "github" || provider === "forgejo" || list?.truncated === true;
            const reviewers = [];
            for (const reviewer of named) {
              if (candidates === undefined) {
                reviewers.push({ id: reviewer.id, kind: reviewer.kind ?? ("user" as const) });
                continue;
              }
              const name = reviewer.id.toLowerCase();
              const match = candidates.find(
                (candidate) =>
                  (reviewer.kind === undefined || candidate.kind === reviewer.kind) &&
                  (candidate.id.toLowerCase() === name || candidate.login.toLowerCase() === name),
              );
              if (match !== undefined) {
                reviewers.push({ id: match.id, kind: match.kind });
                continue;
              }
              // An unmatched name would be silently ignored by hosts that want their own ids.
              if (!passUnmatched)
                return yield* invalid(
                  `${reviewer.id} is not a reviewer this host offers; pass the host's reviewer id.`,
                );
              reviewers.push({ id: reviewer.id, kind: reviewer.kind ?? ("user" as const) });
            }
            yield* service
              .requestReviewers({
                ...ref,
                reviewers,
                requested: input.action === "request_reviewers",
              })
              .pipe(Effect.mapError(hostFailure));
            break;
          }
          case "add_labels":
          case "remove_labels":
            yield* service
              .setLabels({
                ...ref,
                labels: yield* required(input.labels, "labels"),
                applied: input.action === "add_labels",
              })
              .pipe(Effect.mapError(hostFailure));
            break;
        }
        return { ...target, action: input.action };
      }),
  });
});

export const PullRequestsToolkitHandlersLive = PullRequestsToolkit.toLayer(make);
