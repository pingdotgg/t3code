import { assert, it } from "@effect/vitest";
import {
  GitHubWaitpointId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as GitHubPullRequestProbe from "./GitHubPullRequestProbe.ts";
import * as GitHubWaitpointService from "./GitHubWaitpointService.ts";
import * as GitHubWaitpointStore from "./GitHubWaitpointStore.ts";

const pending: GitHubPullRequestProbe.GitHubPullRequestSnapshot = {
  url: "https://github.com/pingdotgg/t3code/pull/2829",
  state: "open",
  headSha: "abc123",
  mergedAt: null,
  updatedAt: "2026-07-30T11:16:04.000Z",
  checks: [{ name: "test", status: "pending", conclusion: null }],
  reviewActivity: [],
};
const settled: GitHubPullRequestProbe.GitHubPullRequestSnapshot = {
  ...pending,
  checks: [{ name: "test", status: "completed", conclusion: "failure" }],
};

function projection(
  status: "completed" | "interrupted" = "completed",
): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: RunId.make("run-1"),
        ordinal: 1,
        status,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

it.effect("registers once and queues one V2 continuation when GitHub satisfies the condition", () =>
  Effect.gen(function* () {
    const probeCalls = yield* Ref.make(0);
    const sends = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const storeLayer = GitHubWaitpointStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const probeLayer = Layer.succeed(
      GitHubPullRequestProbe.GitHubPullRequestProbe,
      GitHubPullRequestProbe.GitHubPullRequestProbe.of({
        get: () =>
          Ref.getAndUpdate(probeCalls, (count) => count + 1).pipe(
            Effect.map((count) => (count === 0 ? pending : settled)),
          ),
      }),
    );
    const threadsLayer = Layer.succeed(
      ThreadManagementService.ThreadManagementService,
      ThreadManagementService.ThreadManagementService.of({
        getThreadProjection: () => Effect.succeed(projection()),
        sendToThread: (input: unknown) =>
          Ref.update(sends, (current) => [...current, input]).pipe(Effect.as({} as never)),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    );
    const cryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
    );
    const serviceLayer = GitHubWaitpointService.layer.pipe(
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(probeLayer),
      Layer.provideMerge(threadsLayer),
      Layer.provideMerge(cryptoLayer),
    );

    yield* Effect.gen(function* () {
      const service = yield* GitHubWaitpointService.GitHubWaitpointService;
      const id = GitHubWaitpointId.make("github-waitpoint:1");
      const registered = yield* service.register({
        id,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        originatingRunId: RunId.make("run-1"),
        repository: "pingdotgg/t3code",
        pullRequestNumber: 2829,
        condition: "checks_settled",
        timeoutMinutes: 60,
        reason: "Fix any failed checks.",
      });
      const duplicate = yield* service.register({
        id,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        originatingRunId: RunId.make("run-1"),
        repository: "pingdotgg/t3code",
        pullRequestNumber: 2829,
        condition: "checks_settled",
        timeoutMinutes: 60,
        reason: "A retry must reuse the existing wait.",
      });

      assert.deepStrictEqual(duplicate, registered);
      assert.equal(yield* Ref.get(probeCalls), 1);
      assert.equal(registered.nextPollAt, "1970-01-01T00:00:30.000Z");

      yield* TestClock.adjust("30 seconds");
      yield* service.processDue;
      yield* service.processDue;

      const delivered = yield* service.get(id);
      const sent = yield* Ref.get(sends);
      assert.lengthOf(sent, 1);
      assert.equal(delivered.state, "delivered");
      assert.equal(yield* Ref.get(probeCalls), 2);
      assert.deepInclude(sent[0], {
        projectId: "project-1",
        commandId: "github-waitpoint:github-waitpoint%3A1",
        threadId: "thread-1",
        messageId: "github-waitpoint:github-waitpoint%3A1",
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      });
    }).pipe(Effect.provide(Layer.mergeAll(serviceLayer, TestClock.layer())));
  }),
);

it.effect("reclaims an expired delivery lease without rechecking a now-advanced thread", () =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projectionReads = yield* Ref.make(0);
    const storeLayer = GitHubWaitpointStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const probeLayer = Layer.succeed(
      GitHubPullRequestProbe.GitHubPullRequestProbe,
      GitHubPullRequestProbe.GitHubPullRequestProbe.of({
        get: () => Effect.die("A durable delivery retry must not re-probe GitHub."),
      }),
    );
    const threadsLayer = Layer.succeed(
      ThreadManagementService.ThreadManagementService,
      ThreadManagementService.ThreadManagementService.of({
        getThreadProjection: () =>
          Ref.update(projectionReads, (count) => count + 1).pipe(
            Effect.andThen(Effect.die("A durable delivery retry must not recheck thread state.")),
          ),
        sendToThread: (input: unknown) =>
          Ref.update(sends, (current) => [...current, input]).pipe(Effect.as({} as never)),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    );
    const cryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(2),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
    );
    const serviceLayer = GitHubWaitpointService.layer.pipe(
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(probeLayer),
      Layer.provideMerge(threadsLayer),
      Layer.provideMerge(cryptoLayer),
    );

    yield* Effect.gen(function* () {
      const service = yield* GitHubWaitpointService.GitHubWaitpointService;
      const store = yield* GitHubWaitpointStore.GitHubWaitpointStore;
      const id = GitHubWaitpointId.make("github-waitpoint:recovery");
      yield* store.register({
        id,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        originatingRunId: RunId.make("run-1"),
        repository: "pingdotgg/t3code",
        pullRequestNumber: 2829,
        condition: "checks_settled",
        baseline: pending,
        continuationPrompt: "Continue after GitHub settles.",
        nextPollAt: "1970-01-01T00:00:00.000Z",
        deadlineAt: "1970-01-01T01:00:00.000Z",
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      yield* store.claim({
        id,
        now: "1970-01-01T00:00:00.000Z",
        leaseToken: "abandoned-lease",
        leaseExpiresAt: "1970-01-01T00:01:00.000Z",
        deliveryPrompt: "The observed checks settled. Continue now.",
      });

      yield* TestClock.adjust("60 seconds");
      yield* service.processDue;

      const delivered = yield* service.get(id);
      assert.equal(delivered.state, "delivered");
      assert.equal(delivered.attemptCount, 2);
      assert.equal(yield* Ref.get(projectionReads), 0);
      assert.lengthOf(yield* Ref.get(sends), 1);
    }).pipe(Effect.provide(Layer.mergeAll(serviceLayer, storeLayer, TestClock.layer())));
  }),
);

it.effect("retries a failed delivery without rechecking the satisfied condition", () =>
  Effect.gen(function* () {
    const probeCalls = yield* Ref.make(0);
    const projectionReads = yield* Ref.make(0);
    const sendAttempts = yield* Ref.make(0);
    const storeLayer = GitHubWaitpointStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const probeLayer = Layer.succeed(
      GitHubPullRequestProbe.GitHubPullRequestProbe,
      GitHubPullRequestProbe.GitHubPullRequestProbe.of({
        get: () =>
          Ref.getAndUpdate(probeCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              if (count === 0) return Effect.succeed(pending);
              if (count === 1) return Effect.succeed(settled);
              return Effect.die("A durable delivery retry must not re-probe GitHub.");
            }),
          ),
      }),
    );
    const threadsLayer = Layer.succeed(
      ThreadManagementService.ThreadManagementService,
      ThreadManagementService.ThreadManagementService.of({
        getThreadProjection: () =>
          Ref.update(projectionReads, (count) => count + 1).pipe(
            Effect.andThen(Effect.succeed(projection())),
          ),
        sendToThread: () =>
          Ref.getAndUpdate(sendAttempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 0
                ? Effect.fail(
                    new ThreadManagementService.ThreadManagementThreadNotFoundError({
                      projectId: ProjectId.make("project-1"),
                      threadId: ThreadId.make("thread-1"),
                    }),
                  )
                : Effect.succeed({} as never),
            ),
          ),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    );
    const cryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(4),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
    );
    const serviceLayer = GitHubWaitpointService.layer.pipe(
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(probeLayer),
      Layer.provideMerge(threadsLayer),
      Layer.provideMerge(cryptoLayer),
    );

    yield* Effect.gen(function* () {
      const service = yield* GitHubWaitpointService.GitHubWaitpointService;
      const id = GitHubWaitpointId.make("github-waitpoint:delivery-retry");
      yield* service.register({
        id,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        originatingRunId: RunId.make("run-1"),
        repository: "pingdotgg/t3code",
        pullRequestNumber: 2829,
        condition: "checks_settled",
        timeoutMinutes: 60,
      });

      yield* TestClock.adjust("30 seconds");
      yield* service.processDue;

      const retrying = yield* service.get(id);
      assert.equal(retrying.state, "delivering");
      assert.isNotNull(retrying.deliveryPrompt);
      assert.equal(retrying.deliveryLeaseExpiresAt, "1970-01-01T00:00:35.000Z");
      assert.equal(yield* Ref.get(probeCalls), 2);
      assert.equal(yield* Ref.get(projectionReads), 1);
      assert.equal(yield* Ref.get(sendAttempts), 1);

      yield* TestClock.adjust("5 seconds");
      yield* service.processDue;

      const delivered = yield* service.get(id);
      assert.equal(delivered.attemptCount, 2);
      assert.equal(delivered.state, "delivered");
      assert.equal(yield* Ref.get(probeCalls), 2);
      assert.equal(yield* Ref.get(projectionReads), 1);
      assert.equal(yield* Ref.get(sendAttempts), 2);
    }).pipe(Effect.provide(Layer.mergeAll(serviceLayer, TestClock.layer())));
  }),
);

it.effect("expires a wait when its originating run was interrupted", () =>
  Effect.gen(function* () {
    const probeCalls = yield* Ref.make(0);
    const sends = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const storeLayer = GitHubWaitpointStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    const probeLayer = Layer.succeed(
      GitHubPullRequestProbe.GitHubPullRequestProbe,
      GitHubPullRequestProbe.GitHubPullRequestProbe.of({
        get: () => Ref.update(probeCalls, (count) => count + 1).pipe(Effect.as(pending)),
      }),
    );
    const threadsLayer = Layer.succeed(
      ThreadManagementService.ThreadManagementService,
      ThreadManagementService.ThreadManagementService.of({
        getThreadProjection: () => Effect.succeed(projection("interrupted")),
        sendToThread: (input: unknown) =>
          Ref.update(sends, (current) => [...current, input]).pipe(Effect.as({} as never)),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    );
    const cryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(3),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
    );
    const serviceLayer = GitHubWaitpointService.layer.pipe(
      Layer.provideMerge(storeLayer),
      Layer.provideMerge(probeLayer),
      Layer.provideMerge(threadsLayer),
      Layer.provideMerge(cryptoLayer),
    );

    yield* Effect.gen(function* () {
      const service = yield* GitHubWaitpointService.GitHubWaitpointService;
      const id = GitHubWaitpointId.make("github-waitpoint:interrupted");
      yield* service.register({
        id,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        originatingRunId: RunId.make("run-1"),
        repository: "pingdotgg/t3code",
        pullRequestNumber: 2829,
        condition: "checks_settled",
        timeoutMinutes: 60,
      });

      yield* TestClock.adjust("30 seconds");
      yield* service.processDue;

      const expired = yield* service.get(id);
      assert.equal(expired.state, "expired");
      assert.include(expired.lastError ?? "", "interrupted");
      assert.equal(yield* Ref.get(probeCalls), 1);
      assert.lengthOf(yield* Ref.get(sends), 0);
    }).pipe(Effect.provide(Layer.mergeAll(serviceLayer, TestClock.layer())));
  }),
);
