import {
  CommandId,
  type OrchestrationThread,
  type OrchestrationReadModel,
  type PendingPullRequestAssociation,
  type ThreadId,
} from "@t3tools/contracts";
import { sameThreadPullRequest } from "@t3tools/shared/threadPullRequests";
import { extractToolCommandInput } from "@t3tools/shared/toolActivity";
import { Effect, Layer, PubSub, Result, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PullRequestCreationAutomation } from "./PullRequestCreationAutomation.ts";
import { isReviewWorkflowThread } from "./reviewWorkflowThread.ts";
import {
  pullRequestAssociationBlockReason,
  pullRequestAssociationRetryAt,
} from "./pullRequestAssociationValidation.ts";

const PULL_REQUEST_URL =
  /(?<=^|[\s(<"'`])https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?=$|[\s)>"'`\]?#.,])/g;
const GH_PR_CREATE = /(?:^|[\s;&|(])gh\s+pr\s+create(?=\s|$)/;
const GH_API_INVOCATION = /(?:^|[\s;&|])gh\s+api\b(?<args>[^;&|]*)/giu;
const CURL_INVOCATION = /(?:^|[\s;&|])curl\b(?<args>[^;&|]*)/giu;
const PULL_REQUESTS_ENDPOINT =
  /(?:^|[\s"'`])(?:https?:\/\/[^/\s"'`]+)?\/?(?:api\/v3\/)?repos\/(?:[\w.-]+|\{[\w.-]+\})\/(?:[\w.-]+|\{[\w.-]+\})\/pulls(?=$|[\s?#"'`])/iu;
const REQUEST_METHOD = /(?:^|\s)(?:--method|--request|-X)(?:=|\s+)?["']?([a-z]+)/giu;

const pullRequestUrls = (text: string) =>
  Array.from(text.matchAll(PULL_REQUEST_URL), (match) => match[0]);

function explicitRequestMethod(args: string): string | null {
  const methods = Array.from(args.matchAll(REQUEST_METHOD), (match) =>
    (match[1] ?? "").toUpperCase(),
  );
  return methods.at(-1) ?? null;
}

function createsPullRequestViaRest(command: string): boolean {
  for (const match of command.matchAll(GH_API_INVOCATION)) {
    const args = match.groups?.args ?? "";
    if (!PULL_REQUESTS_ENDPOINT.test(args)) continue;
    const method = explicitRequestMethod(args);
    if (
      method !== null
        ? method === "POST"
        : /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:=|\s)/iu.test(args)
    ) {
      return true;
    }
  }

  for (const match of command.matchAll(CURL_INVOCATION)) {
    const args = match.groups?.args ?? "";
    if (!PULL_REQUESTS_ENDPOINT.test(args)) continue;
    const method = explicitRequestMethod(args);
    if (method !== null) {
      if (method === "POST") return true;
      continue;
    }
    if (
      !/(?:^|\s)(?:-G|--get)(?=\s|$)/iu.test(args) &&
      /(?:^|\s)(?:-d|-F|--data(?:-[\w-]+)?|--form(?:-string)?|--json)(?:=|\s)/iu.test(args)
    ) {
      return true;
    }
  }

  return false;
}

// A branch match alone is not association intent. Require an unambiguous PR URL
// reported by the assistant, then independently verify it against the checkout.
export function reportedPullRequestUrl(
  thread: Pick<OrchestrationThread, "messages">,
): string | null {
  const message = thread.messages.findLast(
    (entry) => entry.role === "assistant" && !entry.streaming,
  );
  if (!message) return null;
  const urls = new Set(pullRequestUrls(message.text));
  return urls.size === 1 ? (urls.values().next().value ?? null) : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectStrings(value: unknown, output: string[], depth: number): void {
  if (depth > 6 || output.length >= 64) return;
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output, depth + 1);
  } else {
    const record = asRecord(value);
    if (record) for (const entry of Object.values(record)) collectStrings(entry, output, depth + 1);
  }
}

// Activity arrays are replaced on every projection change, so unchanged threads
// cost one lookup per sweep instead of a payload scan.
const createdPullRequestUrlsCache = new WeakMap<
  OrchestrationThread["activities"],
  ReadonlyArray<string>
>();

/**
 * PR URLs printed by this thread's own successful PR-creation commands, oldest first.
 * Creation provenance comes from the executed command, never from how the assistant
 * phrased its report. URLs quoted in the command or echoed back are not evidence.
 */
function threadCreatedPullRequestUrls(
  thread: Pick<OrchestrationThread, "activities">,
): ReadonlyArray<string> {
  const cached = createdPullRequestUrlsCache.get(thread.activities);
  if (cached) return cached;
  const urls: string[] = [];
  for (const activity of thread.activities) {
    if (activity.kind !== "tool.completed") continue;
    const payload = asRecord(activity.payload);
    if (payload?.itemType !== "command_execution" || payload.status === "failed") continue;
    const commandInput = extractToolCommandInput(asRecord(payload.data));
    const command = Array.isArray(commandInput) ? commandInput.join(" ") : commandInput;
    if (!command || (!GH_PR_CREATE.test(command) && !createsPullRequestViaRest(command))) continue;
    const quoted = new Set(pullRequestUrls(command));
    const texts: string[] = [];
    collectStrings([payload.detail, payload.data], texts, 0);
    for (const text of texts) {
      if (command.startsWith(text.trimStart().slice(0, 32))) continue;
      for (const url of pullRequestUrls(text)) {
        if (!quoted.has(url) && !urls.includes(url)) urls.push(url);
      }
    }
  }
  createdPullRequestUrlsCache.set(thread.activities, urls);
  return urls;
}

interface RecoveryCandidate {
  readonly reference: string;
  readonly createdByThread: boolean;
}

// Pure snapshot check so sweeps only spend Git/GitHub lookups on actionable threads.
function recoveryCandidate(thread: OrchestrationThread): RecoveryCandidate | null {
  const created = threadCreatedPullRequestUrls(thread);
  for (const reference of [reportedPullRequestUrl(thread), created.at(-1)]) {
    if (!reference) continue;
    const number = Number(reference.slice(reference.lastIndexOf("/") + 1));
    if (
      thread.pullRequest &&
      !sameThreadPullRequest(thread.pullRequest, { url: reference, number })
    )
      continue;
    const createdByThread = created.includes(reference);
    const existingLink = thread.pullRequests?.find((link) => link.pullRequest.url === reference);
    if (existingLink && (existingLink.source !== "recovered" || !createdByThread)) continue;
    return { reference, createdByThread };
  }
  return null;
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
        const currentPending = currentThread.pendingPullRequestAssociation;
        if (
          !currentPending ||
          currentPending.status !== "pending" ||
          currentPending.reference !== pending.reference ||
          currentPending.requestedAt !== pending.requestedAt
        ) {
          return;
        }
        if (
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
          pullRequestSource: "agent",
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
      const candidate = recoveryCandidate(thread);
      if (!candidate) return;
      const { reference, createdByThread } = candidate;
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
      // Serialized dispatch checks the snapshot version: explicit associations,
      // workspace handoffs, and archival that race the lookup always win.
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:recover-pr:${crypto.randomUUID()}`),
        threadId,
        expectedUpdatedAt: thread.updatedAt,
        expectedWorkspaceCwd: cwd,
        pullRequest: status.pr,
        pullRequestSource: createdByThread ? "agent" : "recovered",
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
            (!thread.pendingPullRequestAssociation && recoveryCandidate(thread) !== null)),
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
    const creationAutomation = yield* PullRequestCreationAutomation;
    const recovery = yield* makePullRequestAssociationRecovery();
    const subscription = yield* engine.acquireDomainEventSubscription;
    yield* Effect.forkScoped(
      Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
        Stream.runForEach((event) =>
          event.type === "thread.message-sent" &&
          event.payload.role === "assistant" &&
          !event.payload.streaming
            ? recovery.recoverSafely(event.payload.threadId)
            : event.type === "thread.activity-appended" &&
                threadCreatedPullRequestUrls({ activities: [event.payload.activity] }).length > 0
              ? recovery.recoverSafely(event.payload.threadId)
              : Effect.void,
        ),
      ),
    );
    // Persisted messages and explicit intents are the retry source after a server restart.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* recovery.sweep;
          yield* creationAutomation.recoverPending();
          yield* Effect.sleep("60 seconds");
        }),
      ),
    );
  }),
);
