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
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { assertTargetWithinLimits } from "../../threadAccess.ts";
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
  });
});

export const layer = PullRequestsToolkit.toLayer(make);
