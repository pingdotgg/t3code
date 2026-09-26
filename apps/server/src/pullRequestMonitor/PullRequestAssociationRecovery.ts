import {
  CommandId,
  type OrchestrationThread,
  type OrchestrationReadModel,
  type PendingPullRequestAssociation,
  type ThreadId,
} from "@t3tools/contracts";
import { sameThreadPullRequest } from "@t3tools/shared/threadPullRequests";
import { Effect, Layer, PubSub, Result, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { isReviewWorkflowThread } from "./reviewWorkflowThread.ts";
import {
  pullRequestAssociationBlockReason,
  pullRequestAssociationRetryAt,
} from "./pullRequestAssociationValidation.ts";

// A branch match alone is not association intent. Require an unambiguous PR URL
// reported by the assistant, then independently verify it against the checkout.
export function reportedPullRequestUrl(
  thread: Pick<OrchestrationThread, "messages">,
): string | null {
  const message = thread.messages.findLast(
    (entry) => entry.role === "assistant" && !entry.streaming,
  );
  if (!message) return null;
  const urls = new Set(
    Array.from(
      message.text.matchAll(
        /(?<=^|[\s(<"'`])https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?=$|[\s)>"'`\]?#.,])/g,
      ),
      (match) => match[0],
    ),
  );
  return urls.size === 1 ? (urls.values().next().value ?? null) : null;
}

function reportsCreatedPullRequest(
  thread: Pick<OrchestrationThread, "messages">,
  url: string,
): boolean {
  return thread.messages.some(
    (message) =>
      message.role === "assistant" &&
      !message.streaming &&
      message.text.split(/\r?\n/).some((line) => {
        const urlIndex = line.indexOf(url);
        if (urlIndex < 0) return false;
        if (/^\s*(?:[-*]\s*)?(?:\*\*)?Created(?:\*\*)?(?::|\s)/i.test(line)) {
          return true;
        }
        const prefix = line.slice(0, urlIndex);
        return /\b(?:created|opened)\b(?:\s+(?:a|the))?(?:\s+new)?\s*(?:\*\*)?\[?\s*(?:pull request|pr)\b/i.test(
          prefix,
        );
      }),
  );
}

function recoverablePullRequestUrl(thread: OrchestrationThread): string | null {
  return (
    reportedPullRequestUrl(thread) ??
    thread.pullRequests?.find(
      (link) =>
        link.source === "recovered" &&
        thread.pullRequest &&
        sameThreadPullRequest(link.pullRequest, thread.pullRequest) &&
        reportsCreatedPullRequest(thread, link.pullRequest.url),
    )?.pullRequest.url ??
    null
  );
}

export const makePullRequestAssociationRecovery = (nowMs: () => number = Date.now) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const git = yield* GitManager;

    const updatePending = (
      thread: OrchestrationThread,
      previous: Extract<PendingPullRequestAssociation, { status: "pending" }>,
      next: PendingPullRequestAssociation,
      cwd?: string,
    ) => {
      if (thread.pendingPullRequestAssociation?.requestId !== previous.requestId) {
        return Effect.void;
      }
      return engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:associate-pr:${crypto.randomUUID()}`),
        threadId: thread.id,
        expectedUpdatedAt: thread.updatedAt,
        ...(cwd ? { expectedWorkspaceCwd: cwd } : {}),
        pendingPullRequestAssociation: next,
      });
    };

    const setBlocked = (
      thread: OrchestrationThread,
      pending: Extract<PendingPullRequestAssociation, { status: "pending" }>,
      reason: Extract<PendingPullRequestAssociation, { status: "blocked" }>["reason"],
      cwd?: string,
    ) =>
      updatePending(
        thread,
        pending,
        {
          requestId: pending.requestId,
          reference: pending.reference,
          requestedAt: pending.requestedAt,
          status: "blocked",
          reason,
        },
        cwd,
      );

    const recoverPending = (
      snapshot: OrchestrationReadModel,
      thread: OrchestrationThread,
      pending: Extract<PendingPullRequestAssociation, { status: "pending" }>,
    ) =>
      Effect.gen(function* () {
        if (Date.parse(pending.nextAttemptAt) > nowMs()) return;
        const cwd = resolveThreadWorkspaceCwd({ thread, projects: snapshot.projects });
        if (!cwd) {
          yield* setBlocked(thread, pending, "workspace-changed");
          return;
        }

        yield* git.invalidateLocalStatus(cwd);
        const localStatus = yield* git.localStatus({ cwd });
        if (
          !localStatus.isRepo ||
          !localStatus.hasOriginRemote ||
          localStatus.isDefaultBranch ||
          localStatus.branch !== thread.branch
        ) {
          yield* setBlocked(thread, pending, "workspace-changed", cwd);
          return;
        }

        const resolution = yield* Effect.result(
          git.resolvePullRequest({ cwd, reference: pending.reference }),
        );
        if (Result.isFailure(resolution)) {
          const retryAt = pullRequestAssociationRetryAt(resolution.failure, nowMs());
          if (retryAt) {
            yield* updatePending(thread, pending, { ...pending, nextAttemptAt: retryAt }, cwd);
          } else {
            yield* setBlocked(thread, pending, "resolve-failed", cwd);
          }
          return;
        }

        yield* git.invalidateLocalStatus(cwd);
        const latestLocalStatus = yield* git.localStatus({ cwd });
        const currentSnapshot = yield* engine.getReadModel();
        const currentThread = currentSnapshot.threads.find((entry) => entry.id === thread.id);
        if (
          !currentThread ||
          currentThread.deletedAt ||
          currentThread.archivedAt ||
          currentThread.pendingPullRequestAssociation?.requestId !== pending.requestId
        ) {
          return;
        }
        if (
          currentThread.updatedAt !== thread.updatedAt ||
          currentThread.branch !== thread.branch ||
          currentThread.worktreePath !== thread.worktreePath ||
          resolveThreadWorkspaceCwd({
            thread: currentThread,
            projects: currentSnapshot.projects,
          }) !== cwd
        ) {
          yield* setBlocked(currentThread, pending, "thread-changed", cwd);
          return;
        }

        const project = currentSnapshot.projects.find(
          (entry) => entry.id === currentThread.projectId,
        );
        const reason = pullRequestAssociationBlockReason({
          thread: currentThread,
          project,
          localStatus: latestLocalStatus,
          pullRequest: resolution.success.pullRequest,
        });
        if (reason) {
          yield* setBlocked(currentThread, pending, reason, cwd);
          return;
        }

        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`server:associate-pr:${crypto.randomUUID()}`),
          threadId: currentThread.id,
          expectedUpdatedAt: currentThread.updatedAt,
          expectedWorkspaceCwd: cwd,
          pullRequest: resolution.success.pullRequest,
          pullRequestOwnership: "transfer",
          pendingPullRequestAssociation: null,
        });
      });

    const recover = Effect.fn("recoverPullRequestAssociation")(function* (threadId: ThreadId) {
      const snapshot = yield* engine.getReadModel();
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      if (!thread || thread.deletedAt || thread.archivedAt || isReviewWorkflowThread(thread))
        return;

      const pending = thread.pendingPullRequestAssociation;
      if (pending) {
        if (pending.status === "pending") yield* recoverPending(snapshot, thread, pending);
        return;
      }
      const reference = recoverablePullRequestUrl(thread);
      if (!reference) return;
      const createdByAgent = reportsCreatedPullRequest(thread, reference);
      const existingLink = thread.pullRequests?.find((link) => link.pullRequest.url === reference);
      if (existingLink && (existingLink.source !== "recovered" || !createdByAgent)) return;
      const cwd = resolveThreadWorkspaceCwd({ thread, projects: snapshot.projects });
      if (!cwd) return;

      yield* git.invalidateStatus(cwd);
      const status = yield* git.status({ cwd });
      if (
        !status.pr ||
        status.pr.url !== reference ||
        status.isDefaultBranch ||
        status.branch !== thread.branch ||
        status.pr.headBranch !== thread.branch
      ) {
        return;
      }
      if (thread.pullRequest && !sameThreadPullRequest(thread.pullRequest, status.pr)) return;
      // Serialized dispatch checks the snapshot version: explicit associations,
      // workspace handoffs, and archival that race the lookup always win.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:recover-pr:${crypto.randomUUID()}`),
        threadId,
        expectedUpdatedAt: thread.updatedAt,
        expectedWorkspaceCwd: cwd,
        pullRequest: status.pr,
        pullRequestSource: createdByAgent ? "agent" : "recovered",
      });
    });

    const sweep = Effect.gen(function* () {
      const snapshot = yield* engine.getReadModel();
      const candidates = snapshot.threads.filter(
        (thread) =>
          !thread.deletedAt &&
          !thread.archivedAt &&
          !isReviewWorkflowThread(thread) &&
          (thread.pendingPullRequestAssociation?.status === "pending" ||
            (!thread.pendingPullRequestAssociation && recoverablePullRequestUrl(thread) !== null)),
      );
      yield* Effect.forEach(candidates, (thread) => recoverSafely(thread.id), {
        concurrency: 4,
        discard: true,
      });
    });
    const recoverSafely = (threadId: ThreadId) =>
      recover(threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("PR association recovery failed; retrying on the next sweep", {
            threadId,
            error: error._tag,
          }),
        ),
      );

    return { recover, recoverSafely, sweep };
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const recovery = yield* makePullRequestAssociationRecovery();
    const subscription = yield* engine.acquireDomainEventSubscription;
    yield* Effect.forkScoped(
      Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
        Stream.runForEach((event) =>
          event.type === "thread.message-sent" &&
          event.payload.role === "assistant" &&
          !event.payload.streaming
            ? recovery.recoverSafely(event.payload.threadId)
            : Effect.void,
        ),
      ),
    );
    // Persisted messages and explicit intents are the retry source after a server restart.
    yield* Effect.forkScoped(
      Effect.forever(recovery.sweep.pipe(Effect.andThen(Effect.sleep("60 seconds")))),
    );
  }),
);
