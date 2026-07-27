import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";

import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

describe("AutoReviewJobStore in-memory", () => {
  it("dedupes open_or_push jobs for the same head sha", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const first = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      const second = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("allows mention re-review with a new comment id after success", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const first = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "mention",
        commentId: "c1",
        modelSelection,
      });
      yield* store.update(first.job.id, { status: "succeeded" });
      const second = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "mention",
        commentId: "c2",
        modelSelection,
      });
      expect(second.created).toBe(true);
      expect(second.job.id).not.toBe(first.job.id);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("claims oldest queued job and requeues running on restart", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const older = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "a",
        trigger: "open_or_push",
        modelSelection,
      });
      yield* store.enqueue({
        projectId: "proj",
        prNumber: 2,
        headSha: "b",
        trigger: "open_or_push",
        modelSelection,
      });
      const claimed = yield* store.claimNext();
      expect(claimed?.id).toBe(older.job.id);
      expect(claimed?.status).toBe("running");
      const requeued = yield* store.requeueRunning();
      expect(requeued).toBe(1);
      const again = yield* store.get(older.job.id);
      expect(again?.status).toBe("queued");
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("retries a failed job up to maxAttempts then stops re-enqueueing", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const first = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
        maxAttempts: 2,
      });
      expect(first.created).toBe(true);
      expect(first.job.attempt).toBe(1);
      yield* store.update(first.job.id, { status: "failed", error: "boom" });

      const retry = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
        maxAttempts: 2,
      });
      expect(retry.created).toBe(true);
      expect(retry.job.attempt).toBe(2);
      expect(retry.job.id).not.toBe(first.job.id);
      yield* store.update(retry.job.id, { status: "failed", error: "boom again" });

      const capped = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
        maxAttempts: 2,
      });
      expect(capped.created).toBe(false);
      expect(capped.job.status).toBe("failed");
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("defaults to two attempts when maxAttempts is omitted", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const first = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      yield* store.update(first.job.id, { status: "failed", error: "boom" });
      const retry = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      expect(retry.created).toBe(true);
      expect(retry.job.attempt).toBe(2);
      yield* store.update(retry.job.id, { status: "failed", error: "boom" });
      const capped = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });
      expect(capped.created).toBe(false);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("starts a fresh attempt chain for a new head sha or mention comment", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const failed = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
        maxAttempts: 1,
      });
      yield* store.update(failed.job.id, { status: "failed", error: "boom" });

      const newSha = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "def",
        trigger: "open_or_push",
        modelSelection,
        maxAttempts: 1,
      });
      expect(newSha.created).toBe(true);
      expect(newSha.job.attempt).toBe(1);

      const mention = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "mention",
        commentId: "c1",
        modelSelection,
        maxAttempts: 1,
      });
      expect(mention.created).toBe(true);
      expect(mention.job.attempt).toBe(1);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });
});

describe("AutoReviewJobStore claimNextBatch", () => {
  it("claims several PRs at once and marks them running", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      for (const prNumber of [1, 2, 3]) {
        yield* store.enqueue({
          projectId: "proj",
          prNumber,
          headSha: `sha-${prNumber}`,
          trigger: "open_or_push",
          modelSelection,
        });
      }

      const claimed = yield* store.claimNextBatch(2);

      expect(claimed.map((job) => job.prNumber)).toEqual([1, 2]);
      expect(claimed.every((job) => job.status === "running")).toBe(true);
      // The claim is persisted, so a second batch cannot re-claim them.
      const next = yield* store.claimNextBatch(2);
      expect(next.map((job) => job.prNumber)).toEqual([3]);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("never claims a second job for a PR that is already running", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "sha-a",
        trigger: "open_or_push",
        modelSelection,
      });
      const first = yield* store.claimNextBatch(4);
      expect(first).toHaveLength(1);

      // A push lands a new head sha while the first review is still running.
      yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "sha-b",
        trigger: "open_or_push",
        modelSelection,
      });

      expect(yield* store.claimNextBatch(4)).toHaveLength(0);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("persists the fix model selection on the job", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      const fixModelSelection = {
        instanceId: ProviderInstanceId.make("claude"),
        model: "opus-5",
      };
      const { job } = yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
        fixModelSelection,
      });
      expect(job.fixModelSelection).toEqual(fixModelSelection);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });
});

describe("AutoReviewJobStore claim atomicity", () => {
  /**
   * Selection and the running-transition share one `Ref` snapshot, so no
   * concurrent claimer can select from state another call is about to
   * overwrite. This does not fail against a `Ref.get`/`Ref.update` pair
   * today — nothing between the two suspends, so a fiber runs the window to
   * completion — but that is an accident of the effects involved, not a
   * property of the pattern. This holds the invariant if that changes.
   */
  it("never hands the same job to two concurrent claimers", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      for (const prNumber of [1, 2, 3, 4]) {
        yield* store.enqueue({
          projectId: "proj",
          prNumber,
          headSha: `sha-${prNumber}`,
          trigger: "open_or_push",
          modelSelection,
        });
      }

      const batches = yield* Effect.forEach([1, 2, 3, 4], () => store.claimNextBatch(4), {
        concurrency: 4,
      });

      const ids = batches.flat().map((job) => job.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
      const jobs = yield* store.list({});
      expect(jobs.every((job) => job.status === "running")).toBe(true);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });

  it("claims each PR once when many claimers race a single queued job", async () => {
    await Effect.gen(function* () {
      const store = yield* AutoReviewJobStore.AutoReviewJobStore;
      yield* store.enqueue({
        projectId: "proj",
        prNumber: 1,
        headSha: "abc",
        trigger: "open_or_push",
        modelSelection,
      });

      const batches = yield* Effect.forEach([1, 2, 3, 4, 5, 6], () => store.claimNextBatch(2), {
        concurrency: 6,
      });

      expect(batches.flat()).toHaveLength(1);
    }).pipe(Effect.provide(AutoReviewJobStore.layerInMemory), Effect.runPromise);
  });
});
