import { assert, it } from "@effect/vitest";
import { GitHubWaitpointId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { GitHubPullRequestSnapshot } from "./GitHubPullRequestProbe.ts";
import * as GitHubWaitpointStore from "./GitHubWaitpointStore.ts";

const baseline: GitHubPullRequestSnapshot = {
  url: "https://github.com/pingdotgg/t3code/pull/2829",
  state: "open",
  headSha: "abc123",
  mergedAt: null,
  updatedAt: "2026-07-30T11:16:04.000Z",
  checks: [{ name: "test", status: "pending", conclusion: null }],
  reviewActivity: [],
};

const storeLayer = GitHubWaitpointStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("fences a recovered delivery lease from stale workers", () =>
  Effect.gen(function* () {
    const store = yield* GitHubWaitpointStore.GitHubWaitpointStore;
    const id = GitHubWaitpointId.make("github-waitpoint:test");
    const input: GitHubWaitpointStore.RegisterGitHubWaitpointInput = {
      id,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      originatingRunId: RunId.make("run-1"),
      repository: "pingdotgg/t3code",
      pullRequestNumber: 2829,
      condition: "checks_settled",
      baseline,
      continuationPrompt: "Continue after CI settles.",
      nextPollAt: "2026-07-30T12:00:00.000Z",
      deadlineAt: "2026-07-31T12:00:00.000Z",
      createdAt: "2026-07-30T11:59:00.000Z",
    };

    const registered = yield* store.register(input);
    const duplicate = yield* store.register({
      ...input,
      continuationPrompt: "A retry must not replace the original prompt.",
    });
    assert.equal(registered.continuationPrompt, "Continue after CI settles.");
    assert.deepStrictEqual(duplicate, registered);

    const first = yield* store.claim({
      id,
      now: "2026-07-30T12:00:00.000Z",
      leaseToken: "lease-1",
      leaseExpiresAt: "2026-07-30T12:01:00.000Z",
      deliveryPrompt: "CI settled. Continue.",
    });
    assert.isTrue(Option.isSome(first));

    assert.isTrue(
      yield* store.rescheduleClaim({
        id,
        leaseToken: "lease-1",
        nextPollAt: "2026-07-30T12:00:05.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
        lastError: "Transient delivery failure.",
      }),
    );
    const retrying = yield* store.get(id);
    assert.isTrue(Option.isSome(retrying));
    if (Option.isSome(retrying)) {
      assert.equal(retrying.value.state, "delivering");
      assert.equal(retrying.value.deliveryLeaseToken, "lease-1");
      assert.equal(retrying.value.deliveryLeaseExpiresAt, "2026-07-30T12:00:05.000Z");
      assert.equal(retrying.value.deliveryPrompt, "CI settled. Continue.");
    }

    const recovered = yield* store.claim({
      id,
      now: "2026-07-30T12:01:00.000Z",
      leaseToken: "lease-2",
      leaseExpiresAt: "2026-07-30T12:02:00.000Z",
      deliveryPrompt: "CI settled. Continue.",
    });
    assert.isTrue(Option.isSome(recovered));

    assert.isFalse(
      yield* store.markDelivered({
        id,
        leaseToken: "lease-1",
        completedAt: "2026-07-30T12:01:01.000Z",
      }),
    );
    assert.isTrue(
      yield* store.markDelivered({
        id,
        leaseToken: "lease-2",
        completedAt: "2026-07-30T12:01:02.000Z",
      }),
    );

    const stored = yield* store.get(id);
    assert.isTrue(Option.isSome(stored));
    if (Option.isSome(stored)) {
      assert.equal(stored.value.state, "delivered");
      assert.equal(stored.value.attemptCount, 2);
      assert.equal(stored.value.completedAt, "2026-07-30T12:01:02.000Z");
    }
  }).pipe(Effect.provide(storeLayer)),
);
