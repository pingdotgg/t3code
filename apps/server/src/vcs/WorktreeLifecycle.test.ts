import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";

it.effect("publishes the current inventory revision to a new subscriber", () =>
  Effect.gen(function* () {
    const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;

    const initialChange = yield* Stream.runHead(lifecycle.changes);
    assert.deepEqual(Option.getOrThrow(initialChange), { revision: 0 });

    yield* lifecycle.markInventoryChanged;
    const changed = yield* Stream.runHead(lifecycle.changes);
    assert.deepEqual(Option.getOrThrow(changed), { revision: 1 });
    assert.equal(yield* lifecycle.revision, 1);
  }).pipe(Effect.provide(WorktreeLifecycle.layer)),
);
