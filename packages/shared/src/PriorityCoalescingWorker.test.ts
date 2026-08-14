import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makePriorityCoalescingWorker } from "./PriorityCoalescingWorker.ts";

describe("makePriorityCoalescingWorker", () => {
  it.live("runs realtime work before queued background updates and coalesces each key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const worker = yield* makePriorityCoalescingWorker<string, string, never, never>({
          mergeBackground: (_current, next) => next,
          process: (value) =>
            Effect.gen(function* () {
              processed.push(value);
              if (value === "background:first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }
            }),
        });

        yield* worker.enqueueBackground("task-1", "background:first");
        yield* Deferred.await(firstStarted);

        yield* worker.enqueueBackground("task-2", "background:stale");
        yield* worker.enqueueBackground("task-2", "background:latest");
        yield* worker.enqueueRealtime("assistant:reply");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(processed).toEqual(["background:first", "assistant:reply", "background:latest"]);
      }),
    ),
  );
});
