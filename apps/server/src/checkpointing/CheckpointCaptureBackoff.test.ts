import { it } from "@effect/vitest";
import { ThreadId, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "./CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

const CWD = "/repo/huge-monorepo";
const THREAD_ID = ThreadId.make("thread-checkpoint-backoff");

const captureTimeout = new VcsProcessTimeoutError({
  operation: "GitVcsDriver.checkpoints.captureCheckpoint",
  command: "git add",
  cwd: CWD,
  timeoutMs: 30_000,
});

/**
 * A driver whose capture always exceeds the process timeout, matching a
 * repository too large for a full-tree `git add -A` to finish in time.
 */
function makeAlwaysTimingOutRegistry(captureAttempts: { count: number }) {
  const checkpoints = {
    captureCheckpoint: () =>
      Effect.sync(() => {
        captureAttempts.count += 1;
      }).pipe(Effect.andThen(Effect.fail(captureTimeout))),
    hasCheckpointRef: () => Effect.succeed(false),
    restoreCheckpoint: () => Effect.succeed(false),
    diffCheckpoints: () => Effect.succeed(""),
    deleteCheckpointRefs: () => Effect.void,
  } as unknown as VcsDriver.VcsCheckpointOps;

  const handle = {
    kind: "git" as const,
    repository: {
      kind: "git" as const,
      rootPath: CWD,
      metadataPath: `${CWD}/.git`,
      freshness: { source: "cache" as const, checkedAt: 0 },
    },
    driver: { checkpoints } as unknown as VcsDriver.VcsDriver["Service"],
  } as unknown as VcsDriverRegistry.VcsDriverHandle;

  return Layer.succeed(
    VcsDriverRegistry.VcsDriverRegistry,
    VcsDriverRegistry.VcsDriverRegistry.of({
      get: () => Effect.succeed(handle.driver),
      detect: () => Effect.succeed(handle),
      resolve: () => Effect.succeed(handle),
    }),
  );
}

describe("checkpoint capture backoff", () => {
  it.effect("stops re-running a capture that keeps timing out", () => {
    const captureAttempts = { count: 0 };
    let nowMs = 0;

    return Effect.gen(function* () {
      const store = yield* CheckpointStore.CheckpointStore;
      const capture = (turn: number) =>
        store
          .captureCheckpoint({
            cwd: CWD,
            checkpointRef: checkpointRefForThreadTurn(THREAD_ID, turn),
          })
          .pipe(Effect.flip);

      // The first three turns each pay for a real capture attempt.
      for (let turn = 1; turn <= 3; turn += 1) {
        nowMs = turn * 1_000;
        const error = yield* capture(turn);
        expect(error._tag).toBe("VcsProcessTimeoutError");
      }
      expect(captureAttempts.count).toBe(3);

      // Subsequent turns inside the cooldown replay the same failure without
      // spawning git again.
      for (let turn = 4; turn <= 10; turn += 1) {
        nowMs = turn * 1_000;
        const error = yield* capture(turn);
        expect(error).toBe(captureTimeout);
      }
      expect(captureAttempts.count).toBe(3);

      // Once the cooldown lapses the workspace is retried exactly once.
      nowMs = 6 * 60_000;
      yield* capture(11);
      expect(captureAttempts.count).toBe(4);
    }).pipe(
      Effect.provide(
        CheckpointStore.layerWith({ now: () => nowMs }).pipe(
          Layer.provide(makeAlwaysTimingOutRegistry(captureAttempts)),
        ),
      ),
    );
  });
});
