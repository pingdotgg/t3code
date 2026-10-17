// @vitest-environment jsdom

import { ThreadId } from "@t3tools/contracts";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { getVcsTerminology } from "@t3tools/shared/vcs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorktreeSetupCard } from "./WorktreeSetupCard";

function snapshot(phase: WorktreeSetupSnapshot["phase"]): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("setup-thread"),
    phase,
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: phase === "running" ? null : "2026-10-17T00:00:01.000Z",
    branch: "feature",
    baseRef: "main",
    worktreePath: "/checkout",
    setupScript: null,
    stages: [],
    error: null,
    sequence: 1,
  };
}

describe("WorktreeSetupCard terminology", () => {
  it.each([
    ["git", "Worktree"],
    ["jj", "Workspace"],
  ] as const)("uses %s labels for completed and interrupted setup", (kind, title) => {
    for (const phase of ["done", "failed", "cancelled"] as const) {
      const markup = renderToStaticMarkup(
        <WorktreeSetupCard
          snapshot={snapshot(phase)}
          terminology={getVcsTerminology(kind)}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={null}
        />,
      );
      expect(markup).toContain(`aria-label="${title} setup"`);
      expect(markup).toContain(phase === "done" ? `${title} ready` : `${title} setup ${phase}`);
    }
  });

  it("keeps setup script failure visible in Jujutsu summaries", () => {
    const failedSetup = snapshot("done");
    const markup = renderToStaticMarkup(
      <WorktreeSetupCard
        snapshot={{
          ...failedSetup,
          stages: [
            {
              id: "setup-script",
              status: "failed",
              startedAt: failedSetup.startedAt,
              endedAt: failedSetup.endedAt,
              percent: null,
              detail: null,
              tail: [],
            },
          ],
        }}
        terminology={getVcsTerminology("jj")}
        embedded
        onCancel={null}
        onWorkLocally={null}
        onOpenTerminal={null}
      />,
    );
    expect(markup).toContain("Workspace ready, setup script failed");
  });
});
