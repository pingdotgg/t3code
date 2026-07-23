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
});
