import {
  CommandId,
  GitHubWaitpointId,
  MessageId,
  type OrchestratorMcpGitHubWaitCondition,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitHubPullRequestProbe from "./GitHubPullRequestProbe.ts";
import * as GitHubWaitpointStore from "./GitHubWaitpointStore.ts";

const FIRST_POLL_DELAY_SECONDS = 30;
const POLL_INTERVAL_SECONDS = 30;
const ACTIVE_RUN_RETRY_SECONDS = 5;
const DELIVERY_RETRY_SECONDS = 5;
const DELIVERY_LEASE_SECONDS = 60;
const DUE_BATCH_SIZE = 25;
const WORKER_TICK_INTERVAL = "5 seconds" as const;

export interface RegisterGitHubWaitpointInput {
  readonly id: GitHubWaitpointId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly originatingRunId: RunId;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly condition: OrchestratorMcpGitHubWaitCondition;
  readonly timeoutMinutes: number;
  readonly reason?: string;
}

export class GitHubWaitpointNotFoundError extends Schema.TaggedErrorClass<GitHubWaitpointNotFoundError>()(
  "GitHubWaitpointNotFoundError",
  {
    waitpointId: GitHubWaitpointId,
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return `GitHub waitpoint ${this.waitpointId} was not found.`;
  }
}

export class GitHubWaitpointServiceError extends Schema.TaggedErrorClass<GitHubWaitpointServiceError>()(
  "GitHubWaitpointServiceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub waitpoint operation ${this.operation} failed.`;
  }
}

export type GitHubWaitpointMutationError =
  | GitHubWaitpointStore.GitHubWaitpointStoreError
  | GitHubPullRequestProbe.GitHubPullRequestProbeError
  | GitHubWaitpointNotFoundError
  | GitHubWaitpointServiceError;

export class GitHubWaitpointService extends Context.Service<
  GitHubWaitpointService,
  {
    readonly register: (
      input: RegisterGitHubWaitpointInput,
    ) => Effect.Effect<GitHubWaitpointStore.GitHubWaitpoint, GitHubWaitpointMutationError>;
    readonly get: (
      id: GitHubWaitpointId,
    ) => Effect.Effect<GitHubWaitpointStore.GitHubWaitpoint, GitHubWaitpointMutationError>;
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<GitHubWaitpointStore.GitHubWaitpoint>,
      GitHubWaitpointStore.GitHubWaitpointStoreError
    >;
    readonly cancel: (input: {
      readonly id: GitHubWaitpointId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<GitHubWaitpointStore.GitHubWaitpoint, GitHubWaitpointMutationError>;
    readonly processDue: Effect.Effect<void, GitHubWaitpointStore.GitHubWaitpointStoreError>;
  }
>()("t3/github/GitHubWaitpointService") {}

function conditionLabel(condition: OrchestratorMcpGitHubWaitCondition): string {
  switch (condition) {
    case "checks_settled":
      return "all reported checks have settled";
    case "new_review_activity":
      return "new review or comment activity is available";
    case "pull_request_closed":
      return "the pull request has merged or closed";
  }
}

function continuationPrompt(input: RegisterGitHubWaitpointInput): string {
  const reason = input.reason?.trim();
  return [
    `T3 GitHub watcher observed that ${conditionLabel(input.condition)} for ${input.repository}#${input.pullRequestNumber}.`,
    "Re-read the pull request and continue the task from the latest GitHub state.",
    ...(reason ? [`Original reason for waiting: ${reason}`] : []),
  ].join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function continuationIds(waitpointId: GitHubWaitpointId): {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
} {
  const value = `github-waitpoint:${encodeURIComponent(waitpointId)}`;
  return {
    commandId: CommandId.make(value),
    messageId: MessageId.make(value),
  };
}

export const layer = Layer.effect(
  GitHubWaitpointService,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const probe = yield* GitHubPullRequestProbe.GitHubPullRequestProbe;
    const store = yield* GitHubWaitpointStore.GitHubWaitpointStore;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    const get: GitHubWaitpointService["Service"]["get"] = (id) =>
      store.get(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new GitHubWaitpointNotFoundError({ waitpointId: id })),
            onSome: Effect.succeed,
          }),
        ),
      );

    const expirePending = (
      waitpoint: GitHubWaitpointStore.GitHubWaitpoint,
      now: string,
      reason: string,
    ) =>
      store.expirePending({
        id: waitpoint.id,
        completedAt: now,
        lastError: reason,
      });

    const reschedulePending = (
      waitpoint: GitHubWaitpointStore.GitHubWaitpoint,
      now: DateTime.Utc,
      seconds: number,
      lastError: string | null,
    ) =>
      store.reschedulePending({
        id: waitpoint.id,
        nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds })),
        updatedAt: DateTime.formatIso(now),
        lastError,
      });

    const deliverClaim = Effect.fn("GitHubWaitpointService.deliverClaim")(function* (
      waitpoint: GitHubWaitpointStore.GitHubWaitpoint,
      leaseToken: string,
      now: DateTime.Utc,
    ) {
      const nowIso = DateTime.formatIso(now);
      const prompt = waitpoint.deliveryPrompt;
      if (prompt === null) {
        yield* store.expireClaim({
          id: waitpoint.id,
          leaseToken,
          completedAt: nowIso,
          lastError: "Claimed waitpoint has no durable delivery prompt.",
        });
        return;
      }
      const ids = continuationIds(waitpoint.id);
      const delivered = yield* Effect.result(
        threads.sendToThread({
          projectId: waitpoint.projectId,
          commandId: ids.commandId,
          threadId: waitpoint.threadId,
          messageId: ids.messageId,
          text: prompt,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        }),
      );
      if (Result.isFailure(delivered)) {
        yield* store.rescheduleClaim({
          id: waitpoint.id,
          leaseToken,
          nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: DELIVERY_RETRY_SECONDS })),
          updatedAt: nowIso,
          lastError: errorMessage(delivered.failure),
        });
        return;
      }
      const marked = yield* store.markDelivered({
        id: waitpoint.id,
        leaseToken,
        completedAt: nowIso,
      });
      if (marked) {
        yield* Effect.logInfo("github.waitpoint.delivered", {
          waitpointId: waitpoint.id,
          threadId: waitpoint.threadId,
          repository: waitpoint.repository,
          pullRequestNumber: waitpoint.pullRequestNumber,
          condition: waitpoint.condition,
        });
      }
    });

    const claimAndDeliver = Effect.fn("GitHubWaitpointService.claimAndDeliver")(function* (
      waitpoint: GitHubWaitpointStore.GitHubWaitpoint,
      deliveryPrompt: string,
      now: DateTime.Utc,
    ) {
      const leaseToken = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new GitHubWaitpointServiceError({
              operation: "claim:lease-token",
              cause,
            }),
        ),
      );
      const claimed = yield* store.claim({
        id: waitpoint.id,
        now: DateTime.formatIso(now),
        leaseToken,
        leaseExpiresAt: DateTime.formatIso(DateTime.add(now, { seconds: DELIVERY_LEASE_SECONDS })),
        deliveryPrompt,
      });
      if (Option.isNone(claimed)) return;
      yield* deliverClaim(claimed.value, leaseToken, now);
    });

    const processPending = Effect.fn("GitHubWaitpointService.processPending")(function* (
      waitpoint: GitHubWaitpointStore.GitHubWaitpoint,
      now: DateTime.Utc,
    ) {
      const nowIso = DateTime.formatIso(now);
      if (waitpoint.deadlineAt <= nowIso) {
        yield* expirePending(waitpoint, nowIso, "GitHub waitpoint deadline elapsed.");
        return;
      }

      const projectionResult = yield* Effect.result(
        threads.getThreadProjection(waitpoint.threadId),
      );
      if (Result.isFailure(projectionResult)) {
        yield* reschedulePending(
          waitpoint,
          now,
          ACTIVE_RUN_RETRY_SECONDS,
          errorMessage(projectionResult.failure),
        );
        return;
      }
      const projection = projectionResult.success;
      if (
        projection.thread.projectId !== waitpoint.projectId ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null
      ) {
        yield* expirePending(waitpoint, nowIso, "Thread no longer exists or is archived.");
        return;
      }
      const originatingRun = projection.runs.find((run) => run.id === waitpoint.originatingRunId);
      if (originatingRun === undefined) {
        yield* expirePending(waitpoint, nowIso, "Originating run no longer exists.");
        return;
      }
      if (
        originatingRun.status === "queued" ||
        ThreadManagementService.isActiveRun(originatingRun)
      ) {
        yield* reschedulePending(waitpoint, now, ACTIVE_RUN_RETRY_SECONDS, null);
        return;
      }
      if (originatingRun.status !== "completed") {
        yield* expirePending(
          waitpoint,
          nowIso,
          `Originating run ended as ${originatingRun.status}.`,
        );
        return;
      }
      if (projection.runs.some((run) => run.ordinal > originatingRun.ordinal)) {
        yield* expirePending(
          waitpoint,
          nowIso,
          "Thread advanced after this GitHub waitpoint was registered.",
        );
        return;
      }

      const observed = yield* Effect.result(
        probe.get({
          cwd: process.cwd(),
          repository: waitpoint.repository,
          pullRequestNumber: waitpoint.pullRequestNumber,
        }),
      );
      if (Result.isFailure(observed)) {
        yield* reschedulePending(
          waitpoint,
          now,
          POLL_INTERVAL_SECONDS,
          errorMessage(observed.failure),
        );
        return;
      }
      const evaluation = GitHubPullRequestProbe.evaluateGitHubWaitpoint(
        waitpoint.condition,
        waitpoint.baseline,
        observed.success,
      );
      if (!evaluation.satisfied) {
        yield* reschedulePending(waitpoint, now, POLL_INTERVAL_SECONDS, null);
        return;
      }
      yield* claimAndDeliver(
        waitpoint,
        `${waitpoint.continuationPrompt} GitHub observation: ${evaluation.summary}`,
        now,
      );
    });

    const processWaitpoint = Effect.fn("GitHubWaitpointService.processWaitpoint")(function* (
      waitpoint: GitHubWaitpointStore.GitHubWaitpoint,
      now: DateTime.Utc,
    ) {
      if (waitpoint.state === "delivering") {
        yield* claimAndDeliver(
          waitpoint,
          waitpoint.deliveryPrompt ?? waitpoint.continuationPrompt,
          now,
        );
        return;
      }
      if (waitpoint.state === "pending") {
        yield* processPending(waitpoint, now);
      }
    });

    const processDue = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const due = yield* store.listDue({
        now: DateTime.formatIso(now),
        limit: DUE_BATCH_SIZE,
      });
      yield* Effect.forEach(
        due,
        (waitpoint) =>
          processWaitpoint(waitpoint, now).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("github.waitpoint.process-failed", {
                waitpointId: waitpoint.id,
                cause,
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    return GitHubWaitpointService.of({
      register: Effect.fn("GitHubWaitpointService.register")(function* (input) {
        const existing = yield* store.get(input.id);
        if (Option.isSome(existing)) return existing.value;
        const baseline = yield* probe.get({
          cwd: process.cwd(),
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
        });
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        const waitpoint = yield* store.register({
          id: input.id,
          projectId: input.projectId,
          threadId: input.threadId,
          originatingRunId: input.originatingRunId,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          condition: input.condition,
          baseline,
          continuationPrompt: continuationPrompt(input),
          nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: FIRST_POLL_DELAY_SECONDS })),
          deadlineAt: DateTime.formatIso(DateTime.add(now, { minutes: input.timeoutMinutes })),
          createdAt,
        });
        yield* Effect.logInfo("github.waitpoint.registered", {
          waitpointId: waitpoint.id,
          threadId: waitpoint.threadId,
          repository: waitpoint.repository,
          pullRequestNumber: waitpoint.pullRequestNumber,
          condition: waitpoint.condition,
        });
        return waitpoint;
      }),
      get,
      listForThread: store.listForThread,
      cancel: Effect.fn("GitHubWaitpointService.cancel")(function* ({ id, threadId }) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const waitpoint = yield* store.cancel({ id, threadId, completedAt: now });
        if (Option.isNone(waitpoint)) {
          return yield* new GitHubWaitpointNotFoundError({ waitpointId: id, threadId });
        }
        return waitpoint.value;
      }),
      processDue,
    });
  }),
);

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* GitHubWaitpointService;
    const tick = service.processDue.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("github.waitpoint.worker.tick-failed", { cause }),
      ),
    );
    yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(WORKER_TICK_INTERVAL))));
  }),
);

export const runtimeLayer = Layer.merge(layer, workerLive.pipe(Layer.provide(layer)));
