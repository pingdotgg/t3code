/**
 * Restartable local worker for durable GitHub waitpoints.
 *
 * Polling happens in the T3 host process. A model turn is started only after a
 * condition is satisfied and an atomic delivery lease has been claimed.
 */
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  GitHubWaitpointRepository,
  type GitHubWaitpoint,
  type GitHubWaitpointRepositoryError,
} from "../persistence/GitHubWaitpoints.ts";
import {
  evaluateGitHubWaitpoint,
  GitHubPullRequestProbe,
  GitHubPullRequestSnapshot,
  type GitHubPullRequestProbeError,
} from "./GitHubPullRequestProbe.ts";

const DUE_BATCH_SIZE = 25;
const ACTIVE_TURN_RETRY_SECONDS = 5;
const POLL_INTERVAL_SECONDS = 30;
const DELIVERY_LEASE_SECONDS = 60;

export class GitHubWaitpointThreadUnavailableError extends Schema.TaggedErrorClass<GitHubWaitpointThreadUnavailableError>()(
  "GitHubWaitpointThreadUnavailableError",
  {
    threadId: ThreadId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot resume thread ${this.threadId}: ${this.detail}`;
  }
}

export interface GitHubWaitpointThreadStatus {
  readonly ready: boolean;
  readonly latestTurnId: string | null;
}

export interface ResumeGitHubWaitpointInput {
  readonly waitpointId: string;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly createdAt: string;
  readonly expectedLatestTurnId: string;
}

type GitHubWaitpointThreadGatewayError =
  | ProjectionRepositoryError
  | OrchestrationDispatchError
  | GitHubWaitpointThreadUnavailableError;

export class GitHubWaitpointThreadGateway extends Context.Service<
  GitHubWaitpointThreadGateway,
  {
    readonly getStatus: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<GitHubWaitpointThreadStatus>, ProjectionRepositoryError>;
    readonly resume: (
      input: ResumeGitHubWaitpointInput,
    ) => Effect.Effect<void, GitHubWaitpointThreadGatewayError>;
  }
>()("t3/github/GitHubWaitpointWorker/GitHubWaitpointThreadGateway") {}

function isThreadReady(thread: {
  readonly latestTurn: { readonly state: string } | null;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
  } | null;
}): boolean {
  return (
    thread.latestTurn?.state !== "running" &&
    thread.session?.activeTurnId == null &&
    thread.session?.status !== "starting" &&
    thread.session?.status !== "running"
  );
}

export const makeThreadGateway = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngineService;

  return GitHubWaitpointThreadGateway.of({
    getStatus: (threadId) =>
      snapshots.getThreadDetailById(threadId).pipe(
        Effect.map(
          Option.map((thread) => ({
            ready: isThreadReady(thread),
            latestTurnId: thread.latestTurn?.turnId ?? null,
          })),
        ),
      ),
    resume: Effect.fn("GitHubWaitpointThreadGateway.resume")(function* (input) {
      const threadOption = yield* snapshots.getThreadDetailById(input.threadId);
      if (Option.isNone(threadOption)) {
        return yield* new GitHubWaitpointThreadUnavailableError({
          threadId: input.threadId,
          detail: "thread no longer exists or is archived",
        });
      }
      const thread = threadOption.value;
      if (thread.latestTurn?.turnId !== input.expectedLatestTurnId) {
        return yield* new GitHubWaitpointThreadUnavailableError({
          threadId: input.threadId,
          detail: "thread advanced after the waitpoint was registered",
        });
      }
      if (!isThreadReady(thread)) {
        return yield* new GitHubWaitpointThreadUnavailableError({
          threadId: input.threadId,
          detail: "another turn is active",
        });
      }
      yield* orchestration.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`github-waitpoint:${input.waitpointId}`),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`github-waitpoint:${input.waitpointId}`),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: input.createdAt,
      });
    }),
  });
});

export const threadGatewayLayer = Layer.effect(GitHubWaitpointThreadGateway, makeThreadGateway);

type GitHubWaitpointWorkerError =
  | GitHubWaitpointRepositoryError
  | GitHubPullRequestProbeError
  | GitHubWaitpointThreadGatewayError
  | Schema.SchemaError;

export class GitHubWaitpointWorker extends Context.Service<
  GitHubWaitpointWorker,
  {
    readonly processDue: Effect.Effect<void, GitHubWaitpointWorkerError>;
  }
>()("t3/github/GitHubWaitpointWorker") {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const make = Effect.gen(function* () {
  const repository = yield* GitHubWaitpointRepository;
  const probe = yield* GitHubPullRequestProbe;
  const threads = yield* GitHubWaitpointThreadGateway;
  const decodeBaseline = Schema.decodeUnknownEffect(GitHubPullRequestSnapshot);

  const processWaitpoint = Effect.fn("GitHubWaitpointWorker.processWaitpoint")(function* (
    waitpoint: GitHubWaitpoint,
    now: DateTime.Utc,
  ) {
    const nowIso = DateTime.formatIso(now);
    if (waitpoint.deadlineAt <= nowIso) {
      yield* repository.markExpired({
        id: waitpoint.id,
        expiredAt: nowIso,
        lastError: "Waitpoint deadline elapsed.",
      });
      return;
    }

    const threadStatus = yield* threads.getStatus(waitpoint.threadId);
    if (Option.isNone(threadStatus)) {
      yield* repository.markExpired({
        id: waitpoint.id,
        expiredAt: nowIso,
        lastError: "Thread no longer exists or is archived.",
      });
      return;
    }
    if (!threadStatus.value.ready) {
      yield* repository.reschedule({
        id: waitpoint.id,
        nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: ACTIVE_TURN_RETRY_SECONDS })),
        updatedAt: nowIso,
        lastError: null,
      });
      return;
    }
    if (threadStatus.value.latestTurnId !== waitpoint.originatingTurnId) {
      yield* repository.markExpired({
        id: waitpoint.id,
        expiredAt: nowIso,
        lastError: "Thread advanced after this waitpoint was registered.",
      });
      return;
    }

    const baselineResult = yield* Effect.result(decodeBaseline(waitpoint.baseline));
    if (Result.isFailure(baselineResult)) {
      yield* repository.markExpired({
        id: waitpoint.id,
        expiredAt: nowIso,
        lastError: "Stored GitHub baseline is incompatible with this T3 Code version.",
      });
      return;
    }

    const probeResult = yield* Effect.result(
      probe.get({
        cwd: process.cwd(),
        repository: waitpoint.repository,
        pullRequestNumber: waitpoint.pullRequestNumber,
      }),
    );
    if (Result.isFailure(probeResult)) {
      yield* repository.reschedule({
        id: waitpoint.id,
        nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: POLL_INTERVAL_SECONDS })),
        updatedAt: nowIso,
        lastError: errorMessage(probeResult.failure),
      });
      return;
    }

    const evaluation = evaluateGitHubWaitpoint(
      waitpoint.condition,
      baselineResult.success,
      probeResult.success,
    );
    if (!evaluation.satisfied) {
      yield* repository.reschedule({
        id: waitpoint.id,
        nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: POLL_INTERVAL_SECONDS })),
        updatedAt: nowIso,
        lastError: null,
      });
      return;
    }

    const claim = yield* repository.claim({
      id: waitpoint.id,
      now: nowIso,
      leaseExpiresAt: DateTime.formatIso(DateTime.add(now, { seconds: DELIVERY_LEASE_SECONDS })),
    });
    if (Option.isNone(claim)) return;

    const resumeResult = yield* Effect.result(
      threads.resume({
        waitpointId: waitpoint.id,
        threadId: waitpoint.threadId,
        prompt: `${waitpoint.continuationPrompt} GitHub observation: ${evaluation.summary}`,
        createdAt: nowIso,
        expectedLatestTurnId: waitpoint.originatingTurnId,
      }),
    );
    if (Result.isFailure(resumeResult)) {
      yield* repository.reschedule({
        id: waitpoint.id,
        nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: ACTIVE_TURN_RETRY_SECONDS })),
        updatedAt: nowIso,
        lastError: errorMessage(resumeResult.failure),
      });
      return;
    }

    yield* repository.markDelivered({ id: waitpoint.id, deliveredAt: nowIso });
    yield* Effect.logInfo("github.waitpoint.delivered", {
      waitpointId: waitpoint.id,
      threadId: waitpoint.threadId,
      repository: waitpoint.repository,
      pullRequestNumber: waitpoint.pullRequestNumber,
      condition: waitpoint.condition,
    });
  });

  const processDue = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const due = yield* repository.listDue({ now: DateTime.formatIso(now), limit: DUE_BATCH_SIZE });
    yield* Effect.forEach(due, (waitpoint) => processWaitpoint(waitpoint, now), {
      concurrency: 1,
      discard: true,
    });
  });

  return GitHubWaitpointWorker.of({ processDue });
});

export const layer = Layer.effect(GitHubWaitpointWorker, make);
