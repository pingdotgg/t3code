import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  GitHubWaitpointRepository,
  layer as repositoryLayer,
} from "../persistence/GitHubWaitpoints.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  GitHubPullRequestProbe,
  type GitHubPullRequestSnapshot,
} from "./GitHubPullRequestProbe.ts";
import {
  GitHubWaitpointThreadGateway,
  GitHubWaitpointWorker,
  layer,
} from "./GitHubWaitpointWorker.ts";

const baseline: GitHubPullRequestSnapshot = {
  url: "https://github.com/pingdotgg/t3code/pull/4262",
  state: "open",
  headSha: "abc123",
  mergedAt: null,
  updatedAt: "2026-07-22T11:16:04.000Z",
  checks: [{ name: "test", status: "pending", conclusion: null }],
  reviewActivity: [],
};
const settled: GitHubPullRequestSnapshot = {
  ...baseline,
  checks: [{ name: "test", status: "completed", conclusion: "failure" }],
};

it.effect("resumes a ready thread exactly once when its GitHub condition is satisfied", () =>
  Effect.gen(function* () {
    const resumed = yield* Ref.make<
      ReadonlyArray<{ readonly id: string; readonly prompt: string }>
    >([]);
    const persistence = repositoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const probe = Layer.succeed(
      GitHubPullRequestProbe,
      GitHubPullRequestProbe.of({ get: () => Effect.succeed(settled) }),
    );
    const gateway = Layer.succeed(
      GitHubWaitpointThreadGateway,
      GitHubWaitpointThreadGateway.of({
        getStatus: () => Effect.succeed(Option.some({ ready: true, latestTurnId: "turn-1" })),
        resume: (input) =>
          Ref.update(resumed, (current) => [
            ...current,
            { id: input.waitpointId, prompt: input.prompt },
          ]),
      }),
    );
    const workerLayer = layer.pipe(
      Layer.provideMerge(persistence),
      Layer.provideMerge(probe),
      Layer.provideMerge(gateway),
    );
    const programLayer = Layer.mergeAll(workerLayer, persistence, TestClock.layer());

    yield* Effect.gen(function* () {
      const repository = yield* GitHubWaitpointRepository;
      const worker = yield* GitHubWaitpointWorker;
      yield* repository.register({
        id: "github:thread-1:call-1",
        threadId: ThreadId.make("thread-1"),
        originatingTurnId: "turn-1",
        repository: "pingdotgg/t3code",
        pullRequestNumber: 4262,
        condition: "checks_settled",
        baseline,
        continuationPrompt: "Continue the pull request task.",
        nextPollAt: "1970-01-01T00:00:00.000Z",
        deadlineAt: "1970-01-01T01:00:00.000Z",
        createdAt: "1970-01-01T00:00:00.000Z",
      });

      yield* worker.processDue;
      yield* worker.processDue;

      const stored = yield* repository.getById({ id: "github:thread-1:call-1" });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;
      assert.equal(stored.value.state, "delivered");
      assert.deepStrictEqual(yield* Ref.get(resumed), [
        {
          id: "github:thread-1:call-1",
          prompt:
            "Continue the pull request task. GitHub observation: 1 checks settled (1 unsuccessful).",
        },
      ]);
    }).pipe(Effect.provide(programLayer));
  }),
);

it.effect("does not probe or resume until the originating provider turn has settled", () =>
  Effect.gen(function* () {
    const probes = yield* Ref.make(0);
    const persistence = repositoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const probe = Layer.succeed(
      GitHubPullRequestProbe,
      GitHubPullRequestProbe.of({
        get: () => Ref.update(probes, (count) => count + 1).pipe(Effect.as(settled)),
      }),
    );
    const gateway = Layer.succeed(
      GitHubWaitpointThreadGateway,
      GitHubWaitpointThreadGateway.of({
        getStatus: () => Effect.succeed(Option.some({ ready: false, latestTurnId: "turn-1" })),
        resume: () => Effect.die("resume must not run while the thread is active"),
      }),
    );
    const workerLayer = layer.pipe(
      Layer.provideMerge(persistence),
      Layer.provideMerge(probe),
      Layer.provideMerge(gateway),
    );
    const programLayer = Layer.mergeAll(workerLayer, persistence, TestClock.layer());

    yield* Effect.gen(function* () {
      const repository = yield* GitHubWaitpointRepository;
      const worker = yield* GitHubWaitpointWorker;
      yield* repository.register({
        id: "github:thread-1:call-active",
        threadId: ThreadId.make("thread-1"),
        originatingTurnId: "turn-1",
        repository: "pingdotgg/t3code",
        pullRequestNumber: 4262,
        condition: "checks_settled",
        baseline,
        continuationPrompt: "Continue.",
        nextPollAt: "1970-01-01T00:00:00.000Z",
        deadlineAt: "1970-01-01T01:00:00.000Z",
        createdAt: "1970-01-01T00:00:00.000Z",
      });

      yield* worker.processDue;

      assert.equal(yield* Ref.get(probes), 0);
      const stored = yield* repository.getById({ id: "github:thread-1:call-active" });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.equal(stored.value.state, "pending");
        assert.equal(stored.value.nextPollAt, "1970-01-01T00:00:05.000Z");
      }
    }).pipe(Effect.provide(programLayer));
  }),
);
