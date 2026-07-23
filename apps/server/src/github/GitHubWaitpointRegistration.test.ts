import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  GitHubWaitpointRepository,
  layer as repositoryLayer,
} from "../persistence/GitHubWaitpoints.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  GitHubPullRequestProbe,
  type GitHubPullRequestSnapshot,
} from "./GitHubPullRequestProbe.ts";
import { GitHubWaitpointRegistration, layer } from "./GitHubWaitpointRegistration.ts";

const baseline: GitHubPullRequestSnapshot = {
  url: "https://github.com/pingdotgg/t3code/pull/4262",
  state: "open",
  headSha: "abc123",
  mergedAt: null,
  updatedAt: "2026-07-22T11:16:04.000Z",
  checks: [{ name: "test", status: "pending", conclusion: null }],
  reviewActivity: [],
};

const persistence = repositoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
let probeCalls = 0;
const probe = Layer.succeed(
  GitHubPullRequestProbe,
  GitHubPullRequestProbe.of({
    get: () =>
      Effect.sync(() => {
        probeCalls += 1;
        return baseline;
      }),
  }),
);
const snapshots = Layer.succeed(ProjectionSnapshotQuery, {
  getThreadDetailById: () =>
    Effect.succeed(
      Option.some({
        latestTurn: { turnId: "t3-turn-1" },
      }),
    ),
} as unknown as ProjectionSnapshotQuery["Service"]);
const registrationLayer = layer.pipe(
  Layer.provideMerge(persistence),
  Layer.provideMerge(probe),
  Layer.provideMerge(snapshots),
);
const test = it.layer(Layer.mergeAll(registrationLayer, persistence, TestClock.layer()));

test("GitHubWaitpointRegistration", (it) => {
  it.effect("captures an initial snapshot and persists a bounded durable wait", () =>
    Effect.gen(function* () {
      const registration = yield* GitHubWaitpointRegistration;
      const repository = yield* GitHubWaitpointRepository;

      const result = yield* registration.register({
        idempotencyKey: "call-1",
        threadId: ThreadId.make("thread-1"),
        cwd: "/tmp/project",
        repository: "pingdotgg/t3code",
        pullRequestNumber: 4262,
        condition: "checks_settled",
        timeoutMinutes: 60,
        reason: "Address any failed checks.",
      });
      const duplicate = yield* registration.register({
        idempotencyKey: "call-1",
        threadId: ThreadId.make("thread-1"),
        cwd: "/tmp/project",
        repository: "pingdotgg/t3code",
        pullRequestNumber: 4262,
        condition: "checks_settled",
        timeoutMinutes: 60,
        reason: "This retry must not replace the original waitpoint.",
      });

      assert.deepStrictEqual(result, { id: "github:thread-1:call-1" });
      assert.deepStrictEqual(duplicate, result);
      assert.equal(probeCalls, 1);
      const stored = yield* repository.getById({ id: result.id });
      assert.isTrue(Option.isSome(stored));
      if (Option.isNone(stored)) return;

      assert.deepInclude(stored.value, {
        baseline,
        originatingTurnId: "t3-turn-1",
        nextPollAt: "1970-01-01T00:00:30.000Z",
        deadlineAt: "1970-01-01T01:00:00.000Z",
        state: "pending",
      });
      assert.match(stored.value.continuationPrompt, /Address any failed checks/);
      assert.match(stored.value.continuationPrompt, /pingdotgg\/t3code#4262/);
    }),
  );
});
