/**
 * Periodically removes managed worktrees that the inventory proves are safe
 * and inactive according to the server policy.
 *
 * The reaper never removes a worktree directly. Every candidate is handed to
 * WorktreeService.pruneWorktrees, which recomputes safety immediately before
 * invoking non-forced Git removal.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { ServerSettingsService } from "../serverSettings.ts";
import { WorktreeService } from "./WorktreeService.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorktreeReaperOptions {
  readonly sweepIntervalMs?: number;
  readonly initialDelayMs?: number;
}

export class WorktreeReaper extends Context.Service<
  WorktreeReaper,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void, never>;
  }
>()("t3/vcs/WorktreeReaper") {}

export const make = (options?: WorktreeReaperOptions) =>
  Effect.gen(function* () {
    const worktrees = yield* WorktreeService;
    const settings = yield* ServerSettingsService;
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const initialDelayMs = Math.max(0, options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);

    const runSweep = Effect.gen(function* () {
      const policy = (yield* settings.getSettings).worktrees;
      if (policy.autoPruneAfterDays === null && !policy.deleteOrphanedImmediately) {
        return;
      }

      const { worktrees: inventory } = yield* worktrees.listWorktrees({});
      const now = yield* Clock.currentTimeMillis;
      const cutoffMs =
        policy.autoPruneAfterDays === null ? null : now - policy.autoPruneAfterDays * DAY_MS;
      const candidates = inventory.filter((worktree) => {
        if (!worktree.safeToPrune) return false;
        if (policy.deleteOrphanedImmediately && worktree.orphaned) return true;
        if (cutoffMs === null || worktree.lastActivityAt === null) return false;
        const lastActivityMs = Date.parse(worktree.lastActivityAt);
        return !Number.isNaN(lastActivityMs) && lastActivityMs < cutoffMs;
      });
      if (candidates.length === 0) return;

      const result = yield* worktrees.pruneWorktrees({
        paths: candidates.map((worktree) => worktree.path),
      });
      yield* Effect.logInfo("worktree.reaper.sweep-complete", {
        candidateCount: candidates.length,
        removedCount: result.removed.length,
        skippedCount: result.skipped.length,
        autoPruneAfterDays: policy.autoPruneAfterDays,
        deleteOrphanedImmediately: policy.deleteOrphanedImmediately,
      });
    });

    const sweep = runSweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("worktree.reaper.sweep-failed", { cause })),
    );

    const start = () =>
      Effect.forkScoped(
        Effect.sleep(Duration.millis(initialDelayMs)).pipe(
          Effect.andThen(
            sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
          ),
        ),
      ).pipe(Effect.asVoid);

    return WorktreeReaper.of({ start, sweep });
  });

export const layer = Layer.effect(WorktreeReaper, make());

export const layerWith = (options: WorktreeReaperOptions) =>
  Layer.effect(WorktreeReaper, make(options));
