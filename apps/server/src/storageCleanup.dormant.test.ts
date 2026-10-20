import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type * as JjRepo from "./vcs/JjRepo.ts";
import { describeJj, runJj } from "./vcs/testing/JjTestSupport.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

vi.mock("./vcs/JjRepo.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof JjRepo>()),
  JJ_REPOSITORY_DETECTION_ENABLED: false,
}));

describeJj("dormant Jujutsu cleanup preservation", () => {
  it.live("keeps a Git worktree converted to jj while detection is off", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        yield* runJj(fixture.worktree, ["git", "init", "--colocate"]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("Jujutsu"),
        });
        expect(yield* fixture.fs.exists(`${fixture.worktree}/.jj`)).toBe(true);
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "original\n",
        );
      }),
    ),
  );
});
