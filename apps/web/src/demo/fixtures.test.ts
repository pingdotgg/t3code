import { describe, expect, it } from "vite-plus/test";

import {
  demoEnvironments,
  DEMO_METRICS_WORKTREE_PATH,
  demoProjectFaviconUrlByCwd,
  demoReviewDiffPreview,
  demoThreadDetails,
  demoThreadDiff,
  demoVcsStatusByCwd,
} from "./fixtures";

function shellThread(threadId: string) {
  const thread = demoEnvironments
    .flatMap((environment) => environment.shellSnapshot.threads)
    .find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`Missing demo thread ${threadId}`);
  return thread;
}

describe("demo fixture turn state", () => {
  it("uses the actual latest turn id for completed and running threads", () => {
    expect(shellThread("thread-flaky").latestTurn?.turnId).toBe("thread-flaky-turn-2");
    expect(shellThread("thread-metrics").latestTurn?.turnId).toBe("thread-metrics-turn-2");
    expect(shellThread("thread-metrics").session?.activeTurnId).toBe("thread-metrics-turn-2");
  });

  it("advances checkpoint turn counts", () => {
    expect(
      demoThreadDetails["thread-composer"]?.checkpoints.map(
        (checkpoint) => checkpoint.checkpointTurnCount,
      ),
    ).toEqual([1, 2]);
    expect(
      demoThreadDetails["thread-flaky"]?.checkpoints.map(
        (checkpoint) => checkpoint.checkpointTurnCount,
      ),
    ).toEqual([1, 2]);
  });

  it("uses a matching VCS checkout for the metrics thread", () => {
    expect(shellThread("thread-metrics").worktreePath).toBe(DEMO_METRICS_WORKTREE_PATH);

    const status = demoVcsStatusByCwd[DEMO_METRICS_WORKTREE_PATH];
    expect(status?._tag).toBe("snapshot");
    if (status?._tag !== "snapshot") throw new Error("Missing metrics VCS snapshot");
    expect(status.local.refName).toBe("feat/crash-dashboard");
  });
});

describe("demo project artwork", () => {
  it("uses the bundled T3 Code icon instead of a remote favicon lookup", () => {
    const faviconUrl = demoProjectFaviconUrlByCwd["~/code/t3code"];

    expect(faviconUrl).toBeDefined();
    expect(new URL(faviconUrl ?? "", "https://demo.test").pathname).toBe("/favicon-32x32.png");
    expect(faviconUrl).not.toContain("google.com");
  });
});

describe("demo diff fixtures", () => {
  it("returns checkpoint-specific files for each thread and turn range", () => {
    const firstComposerTurn = demoThreadDiff("thread-composer", 0, 1).diff;
    const secondComposerTurn = demoThreadDiff("thread-composer", 1, 2).diff;
    const flakyTurn = demoThreadDiff("thread-flaky", 1, 2).diff;

    expect(firstComposerTurn).toContain("ChatComposer.tsx");
    expect(firstComposerTurn).not.toContain("DropOverlay.tsx");
    expect(secondComposerTurn).toContain("DropOverlay.tsx");
    expect(flakyTurn).toContain("GitManager.test.ts");
    expect(flakyTurn).not.toContain("ChatComposer.tsx");
  });

  it("matches review previews to their checkout", () => {
    const flaky = demoReviewDiffPreview("~/code/t3code-worktrees/git-manager-test");
    expect(flaky.sources[0]?.headRef).toBe("fix/git-manager-test");
    expect(flaky.sources[0]?.diff).toContain("GitManager.test.ts");

    const metrics = demoReviewDiffPreview(DEMO_METRICS_WORKTREE_PATH);
    expect(metrics.sources[0]?.headRef).toBe("feat/crash-dashboard");
    expect(metrics.sources[0]?.diff).toContain("src/pages/dashboard.tsx");

    expect(demoReviewDiffPreview("~/code/mobile-app").sources).toEqual([]);
  });
});
