import { assert, describe, it } from "@effect/vitest";
import { PipelineError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PipelineService from "../pipelines/PipelineService.ts";
import * as LinearLinkStore from "./LinearLinkStore.ts";
import * as LinearPipelineCommentReactor from "./LinearPipelineCommentReactor.ts";
import * as LinearService from "./LinearService.ts";

const stored = {
  link: { linkId: "link-1" },
  threadUrl: "https://t3.example/env/thread-1",
  commentBodyHash: null,
} as unknown as LinearLinkStore.StoredLink;

describe("LinearPipelineCommentReactor", () => {
  it.effect("keeps syncing finished runs and survives a failed pipeline read", () =>
    Effect.gen(function* () {
      const synced = yield* Queue.unbounded<string>();
      let subscriptions = 0;
      const layer = LinearPipelineCommentReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(LinearService.LinearService)({
              syncPipelineComment: (link) =>
                Queue.offer(synced, link.link.linkId).pipe(Effect.asVoid),
            }),
            Layer.mock(LinearLinkStore.LinearLinkStore)({
              listByCommentMode: () => Effect.succeed([stored]),
            }),
            Layer.mock(PipelineService.PipelineService)({
              subscribeLiveRuns: () =>
                Stream.unwrap(
                  Effect.sync(() => {
                    subscriptions += 1;
                    return subscriptions === 1
                      ? Stream.fail(new PipelineError({ message: "database locked" }))
                      : Stream.never;
                  }),
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Queue.take(synced), "link-1");
        // The link is synced again on the next pass even though nothing marks it unfinished.
        yield* TestClock.adjust("1 minute");
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Queue.take(synced), "link-1");
        assert.strictEqual(subscriptions, 2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("never syncs a link whose run is on another machine", () =>
    Effect.gen(function* () {
      const synced = yield* Queue.unbounded<string>();
      const remote = {
        ...stored,
        link: { linkId: "link-remote", environmentId: "env-b" },
      } as unknown as LinearLinkStore.StoredLink;
      const local = {
        ...stored,
        link: { linkId: "link-local", environmentId: null },
      } as unknown as LinearLinkStore.StoredLink;
      const layer = LinearPipelineCommentReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(LinearService.LinearService)({
              syncPipelineComment: (link) =>
                Queue.offer(synced, link.link.linkId).pipe(Effect.asVoid),
            }),
            Layer.mock(LinearLinkStore.LinearLinkStore)({
              listByCommentMode: () => Effect.succeed([remote, local]),
            }),
            Layer.mock(PipelineService.PipelineService)({
              subscribeLiveRuns: () => Stream.never,
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Queue.take(synced), "link-local");
        assert.strictEqual(yield* Queue.size(synced), 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
