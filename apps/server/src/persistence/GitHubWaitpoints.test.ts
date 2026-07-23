import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe } from "vite-plus/test";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { GitHubWaitpointRepository, layer } from "./GitHubWaitpoints.ts";

const repositoryLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const registeredWaitpoint = {
  id: "github:thread-1:call-1",
  threadId: ThreadId.make("thread-1"),
  originatingTurnId: "turn-1",
  repository: "pingdotgg/t3code",
  pullRequestNumber: 4262,
  condition: "checks_settled" as const,
  baseline: { headSha: "abc", checksPending: 2 },
  continuationPrompt: "Checks settled. Continue the pull request task.",
  nextPollAt: "2026-07-22T12:00:30.000Z",
  deadlineAt: "2026-07-23T12:00:00.000Z",
  createdAt: "2026-07-22T12:00:00.000Z",
};

describe("GitHubWaitpointRepository", () => {
  it.effect("persists a waitpoint and treats its originating tool call as idempotent", () =>
    Effect.gen(function* () {
      const repository = yield* GitHubWaitpointRepository;

      yield* repository.register(registeredWaitpoint);
      yield* repository.register({
        ...registeredWaitpoint,
        continuationPrompt: "A duplicate call must not replace the original.",
      });

      const result = yield* repository.getById({ id: registeredWaitpoint.id });
      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) return;

      assert.deepStrictEqual(result.value, {
        ...registeredWaitpoint,
        state: "pending",
        deliveryLeaseExpiresAt: null,
        attemptCount: 0,
        lastError: null,
        updatedAt: registeredWaitpoint.createdAt,
        deliveredAt: null,
      });
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("claims due work once and recovers a delivery after its lease expires", () =>
    Effect.gen(function* () {
      const repository = yield* GitHubWaitpointRepository;
      const claimWaitpoint = { ...registeredWaitpoint, id: "github:thread-1:call-claim" };
      yield* repository.register(claimWaitpoint);

      assert.deepStrictEqual(
        yield* repository.listDue({ now: "2026-07-22T12:00:29.999Z", limit: 10 }),
        [],
      );
      assert.lengthOf(yield* repository.listDue({ now: "2026-07-22T12:00:30.000Z", limit: 10 }), 1);

      const firstClaim = yield* repository.claim({
        id: claimWaitpoint.id,
        now: "2026-07-22T12:00:30.000Z",
        leaseExpiresAt: "2026-07-22T12:01:30.000Z",
      });
      const duplicateClaim = yield* repository.claim({
        id: claimWaitpoint.id,
        now: "2026-07-22T12:00:31.000Z",
        leaseExpiresAt: "2026-07-22T12:01:31.000Z",
      });
      assert.isTrue(Option.isSome(firstClaim));
      assert.isTrue(Option.isNone(duplicateClaim));

      assert.lengthOf(yield* repository.listDue({ now: "2026-07-22T12:01:30.000Z", limit: 10 }), 1);
      const recoveredClaim = yield* repository.claim({
        id: claimWaitpoint.id,
        now: "2026-07-22T12:01:30.000Z",
        leaseExpiresAt: "2026-07-22T12:02:30.000Z",
      });
      assert.isTrue(Option.isSome(recoveredClaim));

      yield* repository.markDelivered({
        id: claimWaitpoint.id,
        deliveredAt: "2026-07-22T12:01:31.000Z",
      });
      assert.deepStrictEqual(
        yield* repository.listDue({ now: "2026-07-22T12:03:00.000Z", limit: 10 }),
        [],
      );
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("reschedules transient failures and expires waits that reach their deadline", () =>
    Effect.gen(function* () {
      const repository = yield* GitHubWaitpointRepository;
      const retryWaitpoint = { ...registeredWaitpoint, id: "github:thread-1:call-retry" };
      yield* repository.register(retryWaitpoint);

      yield* repository.reschedule({
        id: retryWaitpoint.id,
        nextPollAt: "2026-07-22T12:02:00.000Z",
        updatedAt: "2026-07-22T12:01:00.000Z",
        lastError: "GitHub is temporarily unavailable.",
      });
      const rescheduled = yield* repository.getById({ id: retryWaitpoint.id });
      assert.isTrue(Option.isSome(rescheduled));
      if (Option.isNone(rescheduled)) return;
      assert.deepInclude(rescheduled.value, {
        state: "pending",
        nextPollAt: "2026-07-22T12:02:00.000Z",
        lastError: "GitHub is temporarily unavailable.",
        deliveryLeaseExpiresAt: null,
      });

      yield* repository.markExpired({
        id: retryWaitpoint.id,
        expiredAt: "2026-07-22T12:02:01.000Z",
        lastError: "Waitpoint deadline elapsed.",
      });
      const expired = yield* repository.getById({ id: retryWaitpoint.id });
      assert.isTrue(Option.isSome(expired));
      if (Option.isNone(expired)) return;
      assert.deepInclude(expired.value, {
        state: "expired",
        lastError: "Waitpoint deadline elapsed.",
      });
    }).pipe(Effect.provide(repositoryLayer)),
  );
});
