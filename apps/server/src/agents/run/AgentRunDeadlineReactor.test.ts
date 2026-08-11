import {
  AgentProfileId,
  AgentProfileRevision,
  AgentProfileRef,
  AgentRunId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { AgentRun, AgentRunEvent } from "./AgentRun.ts";
import type { AgentRunRepository } from "./AgentRunRepository.ts";
import * as AgentRunRepositoryService from "./AgentRunRepository.ts";
import {
  deadlineAtMillis,
  expireRun,
  isDeadlineExpired,
  layer,
} from "./AgentRunDeadlineReactor.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";

const requestedAt = "2026-08-07T12:00:00.000Z";
const runId = AgentRunId.make("deadline-run");
const childThreadId = ThreadId.make("deadline-child");
const profile = AgentProfileRef.make({
  id: AgentProfileId.make("deadline-profile"),
  scope: "environment",
  revision: AgentProfileRevision.make("a".repeat(64)),
});

const run: AgentRun = {
  id: runId,
  profile,
  budget: {
    maxRuns: 4,
    maxConcurrency: 2,
    maxDepth: 2,
    maxWallTimeMinutes: 1,
  },
  status: "running",
  revision: 1,
  childThreadId,
  parentRunId: null,
  rootRunId: runId,
  depth: 0,
  detached: false,
  parentThreadId: ThreadId.make("deadline-parent"),
  projectId: ProjectId.make("deadline-project"),
  modelSelection: ModelSelection.make({
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  }),
  instanceId: ProviderInstanceId.make("codex"),
  workspaceMode: "shared",
  requestedAt,
  wallTimeOriginAt: requestedAt,
  startedAt: requestedAt,
  activeTurnId: TurnId.make("deadline-turn"),
  finishedAt: null,
  updatedAt: requestedAt,
  usage: undefined,
  consumedTokens: 0,
  consumedEstimatedCostUsd: 0,
  failure: undefined,
  waitingForChildren: false,
  integrationTargetThreadId: null,
};

const repositoryFor = (
  getRun: () => AgentRun | null,
  dispatch: (
    command: Parameters<AgentRunRepository["Service"]["dispatch"]>[0],
  ) => ReadonlyArray<AgentRunEvent>,
): AgentRunRepository["Service"] =>
  ({
    get: () => Effect.succeed(Option.fromNullishOr(getRun())),
    dispatch: (command) => Effect.succeed(dispatch(command)),
    listActive: () => Effect.succeed([]),
    listByLineage: () => Effect.succeed([]),
    listByParentThread: () => Effect.succeed([]),
    getByChildThread: () => Effect.succeed(Option.none()),
    putProfileSnapshot: () => Effect.void,
    getProfileSnapshot: () => Effect.succeed(Option.none()),
    waitForAdvance: () => Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  }) as AgentRunRepository["Service"];

const providerFor = (interrupt: () => void): ProviderServiceShape =>
  ({ interruptTurn: () => Effect.sync(interrupt) }) as unknown as ProviderServiceShape;

it("derives and recognizes a persisted wall-time deadline", () => {
  assert.equal(deadlineAtMillis(run), Date.parse(requestedAt) + 60_000);
  assert.isFalse(isDeadlineExpired(run, Date.parse(requestedAt) + 59_999));
  assert.isTrue(isDeadlineExpired(run, Date.parse(requestedAt) + 60_000));
});

it("measures wall time from the request even when provider startup is delayed", () => {
  const delayedStart = { ...run, startedAt: "2026-08-07T12:00:30.000Z" };
  assert.equal(deadlineAtMillis(delayedStart), Date.parse(requestedAt) + 60_000);
});

it("keeps a delayed child on the root wall-time deadline", () => {
  const delayedChild = {
    ...run,
    id: AgentRunId.make("deadline-child-run"),
    parentRunId: runId,
    requestedAt: "2026-08-07T12:00:30.000Z",
  };
  assert.equal(deadlineAtMillis(delayedChild), Date.parse(requestedAt) + 60_000);
  assert.isTrue(isDeadlineExpired(delayedChild, Date.parse(requestedAt) + 60_000));
});

it.effect("cancels and interrupts once when a running run reaches its deadline", () =>
  Effect.gen(function* () {
    let dispatchCount = 0;
    let interruptCount = 0;
    const repository = repositoryFor(
      () => run,
      (command) => {
        dispatchCount += 1;
        assert.equal(command.type, "agent-run.cancel");
        if (command.type !== "agent-run.cancel") return [];
        assert.equal(command.reason, "Wall-time budget exhausted after 1 minute.");
        return [
          {
            type: "agent-run.cancelled",
            runId,
            revision: 2,
            occurredAt: requestedAt,
            reason: command.reason,
          },
        ] as unknown as ReadonlyArray<AgentRunEvent>;
      },
    );

    yield* TestClock.setTime(deadlineAtMillis(run));
    assert.isTrue(
      yield* expireRun(
        runId,
        repository,
        providerFor(() => (interruptCount += 1)),
      ),
    );
    // A second expiry observes the same durable run but an empty cancellation
    // transition, representing a concurrent terminalizer that already won.
    const racedRepository = repositoryFor(
      () => run,
      () => [],
    );
    assert.isFalse(
      yield* expireRun(
        runId,
        racedRepository,
        providerFor(() => (interruptCount += 1)),
      ),
    );
    assert.equal(dispatchCount, 1);
    assert.equal(interruptCount, 1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not cancel before the deadline", () =>
  Effect.gen(function* () {
    let dispatchCount = 0;
    const repository = repositoryFor(
      () => run,
      () => {
        dispatchCount += 1;
        return [];
      },
    );
    yield* TestClock.setTime(deadlineAtMillis(run) - 1);
    assert.isFalse(
      yield* expireRun(
        runId,
        repository,
        providerFor(() => undefined),
      ),
    );
    assert.equal(dispatchCount, 0);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("interrupts the provider after its own terminal notification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cancellationPersisted = yield* Deferred.make<void>();
      const providerInterrupted = yield* Deferred.make<void>();
      const expiredRun: AgentRun = {
        ...run,
        requestedAt: "1970-01-01T00:00:00.000Z",
        startedAt: "1970-01-01T00:00:01.000Z",
      };
      const cancelledRun: AgentRun = {
        ...expiredRun,
        status: "cancelled",
        revision: expiredRun.revision + 1,
      };
      const repository = {
        ...repositoryFor(
          () => expiredRun,
          () => [],
        ),
        listActive: () => Effect.succeed([expiredRun]),
        subscribeChanges: Effect.succeed(
          Stream.fromEffect(Deferred.await(cancellationPersisted).pipe(Effect.as(cancelledRun))),
        ),
        dispatch: () =>
          Deferred.succeed(cancellationPersisted, undefined).pipe(
            Effect.as([
              {
                type: "agent-run.cancelled",
                runId,
                revision: cancelledRun.revision,
                occurredAt: cancelledRun.updatedAt,
              } as AgentRunEvent,
            ]),
          ),
      } satisfies AgentRunRepository["Service"];
      const provider = {
        interruptTurn: () => Deferred.succeed(providerInterrupted, undefined),
      } as unknown as ProviderServiceShape;

      yield* TestClock.setTime(deadlineAtMillis(expiredRun));
      yield* Layer.build(layer).pipe(
        Effect.provideService(AgentRunRepositoryService.AgentRunRepository, repository),
        Effect.provideService(ProviderService.ProviderService, provider),
      );
      yield* Deferred.await(providerInterrupted);
    }),
  ),
);

it.effect("surfaces a transient deadline persistence failure so the scheduler can retry it", () =>
  Effect.gen(function* () {
    const repository = {
      ...repositoryFor(
        () => run,
        () => [],
      ),
      dispatch: () =>
        Effect.fail(
          new AgentRunRepositoryService.AgentRunRepositoryDecodeError({
            operation: "test",
            detail: "temporary persistence failure",
            cause: {},
          }),
        ),
    } as unknown as AgentRunRepository["Service"];
    yield* TestClock.setTime(deadlineAtMillis(run));
    const result = yield* Effect.result(
      expireRun(
        runId,
        repository,
        providerFor(() => undefined),
      ),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(TestClock.layer())),
);
