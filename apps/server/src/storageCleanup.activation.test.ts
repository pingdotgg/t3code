import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { expect, it, describe } from "@effect/vitest";
import { describeJj, runJj } from "./vcs/testing/JjTestSupport.ts";
import { workspaceNameForRef } from "./jj/JjWorkspaces.ts";
import {
  NOW_MS,
  DAY_MS,
  at,
  shell,
  cleanupFixture,
  pausedMeasurementFixture,
  runCleanupTest,
} from "./storageCleanup.testkit.ts";

describe("orphan Jujutsu workspace reports", () => {
  it.live.each(["nested", "direct"] as const)(
    "reports a non-colocated jj workspace without treating its contents as groups (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const workspace = `${fixture.config.worktreesDir}/${location === "nested" ? "repository/" : ""}jj-workspace`;
          yield* fixture.fs.makeDirectory(`${workspace}/.jj`, { recursive: true });
          yield* fixture.fs.writeFileString(`${workspace}/.jj/repo`, "/repository/.jj/repo");
          yield* fixture.fs.makeDirectory(`${workspace}/src/nested`, { recursive: true });
          yield* fixture.fs.writeFileString(`${workspace}/src/nested/file`, "data");
          yield* fixture.fs.utimes(workspace, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toEqual([
            expect.objectContaining({
              path: workspace,
              outcome: "kept",
              reason: "No thread uses this worktree",
            }),
          ]);
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${workspace}/src/nested/file`)).toBe("data");
        }),
      ),
  );

  it.live.each(["nested", "direct"] as const)(
    "does not report a primary jj repository as an orphan workspace (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const repository = `${fixture.config.worktreesDir}/${location === "nested" ? "group/" : ""}jj-repository`;
          yield* fixture.fs.makeDirectory(`${repository}/.jj/repo`, { recursive: true });
          yield* fixture.fs.makeDirectory(`${repository}/src/nested`, { recursive: true });
          yield* fixture.fs.writeFileString(`${repository}/src/nested/file`, "data");
          yield* fixture.fs.utimes(repository, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toEqual([]);
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${repository}/src/nested/file`)).toBe("data");
        }),
      ),
  );

  it.live("reports an incomplete jj workspace as a kept folder", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const workspace = `${fixture.config.worktreesDir}/incomplete-jj`;
        yield* fixture.fs.makeDirectory(`${workspace}/.jj`, { recursive: true });
        yield* fixture.fs.utimes(workspace, 1, 1);
        expect((yield* fixture.service.runNow).entries).toEqual([
          expect.objectContaining({
            path: workspace,
            outcome: "kept",
            reason: "No thread uses this folder, and it isn't a git worktree",
          }),
        ]);
        expect(yield* fixture.fs.exists(workspace)).toBe(true);
      }),
    ),
  );
});

it.live.each([true, false])(
  "keeps malformed Jujutsu metadata out of Git cleanup (jj: %s)",
  (hasJj) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, fullStatusCalls, gitExecuteCalls } = yield* cleanupFixture();
        if (hasJj) yield* fs.makeDirectory(`${worktree}/.jj`);

        const report = yield* service.runNow;

        expect(report.entries[0]).toMatchObject(
          hasJj ? { outcome: "failed" } : { outcome: "removed" },
        );
        expect(yield* fs.exists(`${worktree}/.git`)).toBe(hasJj);
        if (hasJj) {
          expect(fullStatusCalls()).toBe(0);
          expect(gitExecuteCalls()).toBe(0);
        }
      }),
    ),
);

describeJj("Jujutsu storage cleanup policies", () => {
  it.live("keeps a managed Git worktree initialized with jj without a pointer failure", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        yield* runJj(fixture.worktree, ["git", "init", "--colocate"]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          path: fixture.worktree,
          outcome: "kept",
          reason: expect.stringContaining("Jujutsu inside a Git linked worktree is not supported"),
        });
        expect(report.entries[0]?.reason).not.toContain("colocation enable");
        expect(report.counts).toEqual({ removed: 0, kept: 1, failed: 0 });
        expect(yield* fixture.fs.exists(`${fixture.worktree}/.jj/repo`)).toBe(true);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe("original\n");
        expect((yield* runJj(fixture.worktree, ["root"])).trim()).toBe(fixture.worktree);
        expect(fixture.gitExecuteCalls()).toBe(0);
      }),
    ),
  );

  it.live.each(["missing", "old"] as const)(
    "keeps a converted Git worktree when jj is %s",
    (availability) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          yield* runJj(fixture.worktree, ["git", "init", "--colocate"]);
          const bin = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-jj-path-" });
          yield* fixture.fs.symlink("/usr/bin/git", `${bin}/git`);
          if (availability === "old") {
            yield* fixture.fs.writeFileString(`${bin}/jj`, "#!/bin/sh\nprintf 'jj 0.45.0\\n'\n");
            yield* fixture.fs.chmod(`${bin}/jj`, 0o755);
          }
          const previousPath = process.env.PATH;
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              process.env.PATH = bin;
            }),
            () =>
              fixture.service.runNow.pipe(
                Effect.tap((report) =>
                  Effect.gen(function* () {
                    expect(report.entries[0]).toMatchObject({
                      outcome: "kept",
                      reason: expect.stringContaining("Jujutsu"),
                    });
                    expect(yield* fixture.fs.exists(`${fixture.worktree}/.jj`)).toBe(true);
                    expect(
                      yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`),
                    ).toBe("original\n");
                  }),
                ),
              ),
            () =>
              Effect.sync(() => {
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
              }),
          );
        }),
      ),
  );

  it.live("removes an integrated workspace with only the unchanged rule enabled", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(
          {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeAfterDays: null,
            worktreeSettledAfterDays: null,
            worktreeOnDelete: false,
            worktreeOnMerge: false,
            worktreeUnchanged: true,
          },
          { runJj },
        );
        const remote = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-jj-remote-" });
        yield* fixture.command(remote, ["init", "--bare", "-b", "main"]);
        yield* runJj(fixture.repo, ["git", "remote", "add", "origin", remote]);
        yield* runJj(fixture.repo, ["git", "push", "--bookmark", "main", "--remote", "origin"]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "removed",
          reason: "No commits beyond the default branch",
          path: fixture.worktree,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
        expect(yield* fixture.fs.exists(`${fixture.repo}/.jj`)).toBe(true);
      }),
    ),
  );

  it.effect.each([
    ["before the threshold", -8 * DAY_MS + 1, "kept"],
    ["at the threshold", -8 * DAY_MS, "removed"],
  ] as const)("applies settled-only jj retention %s", ([, settledOffset, outcome]) =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture(
          {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeAfterDays: null,
            worktreeSettledAfterDays: 8,
            worktreeOnDelete: false,
            worktreeOnMerge: false,
            worktreeUnchanged: false,
          },
          { runJj },
        );
        fixture.setThreads([
          shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            settledAt: at(settledOffset),
          }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome,
          reason: outcome === "removed" ? "Settled for 8 days" : "Settled for 7 of 8 days",
          path: fixture.worktree,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(outcome === "kept");
      }),
    ),
  );

  it.live("removes an idle clean managed workspace without removing the main workspace", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, { runJj });
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "removed",
          path: fixture.worktree,
          threadId: "thread-1",
        });
        expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
        expect(yield* fixture.fs.readFileString(`${fixture.repo}/tracked.txt`)).toBe("original\n");
        expect(yield* runJj(fixture.repo, ["workspace", "list"])).not.toContain(
          workspaceNameForRef("feature"),
        );
        expect(fixture.fullStatusCalls()).toBe(0);
      }),
    ),
  );

  it.live("keeps a dirty workspace and its unsnapshotted tracked edits", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, { runJj });
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "keep my edits\n");
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("uncommitted changes"),
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "keep my edits\n",
        );
        expect(fixture.fullStatusCalls()).toBe(0);
      }),
    ),
  );

  it.live("keeps a clean workspace with a stranded unbookmarked ancestor", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, { runJj });
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "private commit\n");
        yield* runJj(fixture.worktree, ["commit", "-m", "unbookmarked work"]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("not reachable from any bookmark"),
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "private commit\n",
        );
        expect(
          yield* runJj(fixture.worktree, ["log", "--no-graph", "-r", "@-", "-T", "description"]),
        ).toBe("unbookmarked work\n");
      }),
    ),
  );

  it.live.each(["active thread", "live provider session"] as const)(
    "keeps a clean workspace with an %s",
    (activity) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture(undefined, { runJj });
          if (activity === "active thread") {
            fixture.setThreads([
              shell({ branch: "feature", worktreePath: fixture.worktree, status: "running" }),
            ]);
          } else {
            fixture.setOpenSessionCwd(fixture.worktree);
          }
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason:
              activity === "active thread"
                ? "Thread is running or has pending work"
                : "Provider session is still open",
          });
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/.jj`)).toBe(true);
          if (activity === "live provider session") {
            fixture.setSessionLive(false);
            expect((yield* fixture.service.runNow).entries[0]).toMatchObject({
              outcome: "removed",
            });
            expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
          }
        }),
      ),
  );

  it.live("keeps a main jj workspace even when its path is inside the managed root", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(undefined, { runJj });
        const mainWorkspace = `${fixture.config.worktreesDir}/main-workspace`;
        yield* fixture.fs.makeDirectory(mainWorkspace);
        yield* runJj(mainWorkspace, ["git", "init", "--colocate"]);
        fixture.setThreads([shell({ branch: "feature", worktreePath: mainWorkspace })]);
        fixture.setStoredWorktreePaths([fixture.worktree, mainWorkspace]);
        const report = yield* fixture.service.runNow;
        expect(report.entries.find((entry) => entry.path === mainWorkspace)).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("main Jujutsu workspace"),
        });
        expect(yield* fixture.fs.exists(`${mainWorkspace}/.jj/repo`)).toBe(true);
        expect(yield* fixture.fs.exists(`${mainWorkspace}/.git`)).toBe(true);
      }),
    ),
  );

  it.live.each(["tracked edit", "active thread", "live provider session"] as const)(
    "keeps a workspace when a %s appears during size measurement",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture(undefined, { runJj });
          const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          if (change === "tracked edit") {
            yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "late edit\n");
          } else if (change === "active thread") {
            fixture.setThreads([
              shell({ branch: "feature", worktreePath: fixture.worktree, status: "running" }),
            ]);
          } else {
            fixture.setOpenSessionCwd(fixture.worktree);
          }
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(cleanup);
          expect(report.entries[0]).toMatchObject({ outcome: "kept", bytes: null });
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.exists(`${fixture.worktree}/.jj`)).toBe(true);
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
            change === "tracked edit" ? "late edit\n" : "original\n",
          );
        }),
      ),
  );
});
