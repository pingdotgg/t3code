import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectId, type WorktreeInfo } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeReaper from "./WorktreeReaper.ts";
import * as WorktreeService from "./WorktreeService.ts";

const makeWorktree = (overrides: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  projectId: ProjectId.make("reaper-project"),
  projectTitle: "Reaper project",
  workspaceRoot: "/repo",
  projects: [],
  path: "/worktrees/feature",
  branch: "feature/reaper",
  threads: [],
  orphaned: false,
  dirty: false,
  dirtyFileCount: 0,
  hasUpstream: false,
  upstreamGone: false,
  aheadOfUpstreamCount: null,
  behindUpstreamCount: null,
  aheadOfDefaultCount: 0,
  lastActivityAt: "2020-01-01T00:00:00.000Z",
  safeToPrune: true,
  pruneBlockers: [],
  ...overrides,
});

const makeLayer = (
  inventory: ReadonlyArray<WorktreeInfo>,
  prune: (paths: ReadonlyArray<string>) => void,
  settings: Parameters<typeof ServerSettings.layerTest>[0],
  observed?: { readonly listCalls: { value: number } },
) => {
  const worktreeLayer = Layer.succeed(
    WorktreeService.WorktreeService,
    WorktreeService.WorktreeService.of({
      listWorktrees: () =>
        Effect.sync(() => {
          if (observed !== undefined) observed.listCalls.value += 1;
          return { worktrees: [...inventory] };
        }),
      pruneWorktrees: (input) =>
        Effect.sync(() => prune(input.paths)).pipe(
          Effect.as({
            removed: [],
            skipped: [],
          }),
        ),
      pruneOrphanedWorktree: () => Effect.succeed(false),
    }),
  );
  return WorktreeReaper.layerWith({ initialDelayMs: 0, sweepIntervalMs: 60_000 }).pipe(
    Layer.provide(worktreeLayer),
    Layer.provide(ServerSettings.layerTest(settings)),
  );
};

it.effect("reaps only inactive worktrees already proven safe", () =>
  Effect.gen(function* () {
    const pruned: ReadonlyArray<string>[] = [];
    const observed = { listCalls: { value: 0 } };
    const layer = makeLayer(
      [
        makeWorktree({ path: "/worktrees/old", lastActivityAt: "1960-01-01T00:00:00.000Z" }),
        makeWorktree({
          path: "/worktrees/dirty",
          lastActivityAt: "1960-01-01T00:00:00.000Z",
          safeToPrune: false,
          pruneBlockers: ["dirty"],
        }),
        makeWorktree({ path: "/worktrees/recent", lastActivityAt: "2999-01-01T00:00:00.000Z" }),
      ],
      (paths) => pruned.push(paths),
      { worktrees: { autoPruneAfterDays: 14, deleteOrphanedImmediately: false } },
      observed,
    );

    yield* Effect.gen(function* () {
      const reaper = yield* WorktreeReaper.WorktreeReaper;
      yield* reaper.sweep;
    }).pipe(Effect.provide(layer));

    assert.equal(observed.listCalls.value, 1);
    assert.deepEqual(pruned, [["/worktrees/old"]]);
  }),
);

it.effect("can sweep safe orphans immediately and stays inert when disabled", () =>
  Effect.gen(function* () {
    const pruned: ReadonlyArray<string>[] = [];
    const layer = makeLayer(
      [makeWorktree({ path: "/worktrees/orphan", orphaned: true, lastActivityAt: null })],
      (paths) => pruned.push(paths),
      { worktrees: { autoPruneAfterDays: null, deleteOrphanedImmediately: true } },
    );

    yield* Effect.gen(function* () {
      const reaper = yield* WorktreeReaper.WorktreeReaper;
      yield* reaper.sweep;
    }).pipe(Effect.provide(layer));
    assert.deepEqual(pruned, [["/worktrees/orphan"]]);

    const disabledPruned: ReadonlyArray<string>[] = [];
    const disabledLayer = makeLayer(
      [makeWorktree({ path: "/worktrees/disabled" })],
      (paths) => disabledPruned.push(paths),
      { worktrees: { autoPruneAfterDays: null, deleteOrphanedImmediately: false } },
    );
    yield* Effect.gen(function* () {
      const reaper = yield* WorktreeReaper.WorktreeReaper;
      yield* reaper.sweep;
    }).pipe(Effect.provide(disabledLayer));
    assert.deepEqual(disabledPruned, []);
  }),
);
