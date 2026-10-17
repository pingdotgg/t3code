import { ThreadId } from "@t3tools/contracts";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { getVcsTerminology } from "@t3tools/shared/vcs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import "../../index.css";

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

let root: Root | null = null;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
});

async function renderCard(setup: WorktreeSetupSnapshot, kind: "git" | "jj") {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <WorktreeSetupCard
        snapshot={setup}
        terminology={getVcsTerminology(kind)}
        embedded
        onCancel={null}
        onWorkLocally={null}
        onOpenTerminal={null}
      />,
    ),
  );
}

describe("WorktreeSetupCard terminology", () => {
  it.each([
    ["git", "Worktree"],
    ["jj", "Workspace"],
  ] as const)("uses %s labels for completed and interrupted setup", async (kind, title) => {
    for (const phase of ["done", "failed", "cancelled"] as const) {
      await renderCard(snapshot(phase), kind);
      expect(container.querySelector(`[aria-label="${title} setup"]`)).not.toBeNull();
      expect(container.textContent).toContain(
        phase === "done" ? `${title} ready` : `${title} setup ${phase}`,
      );
      await act(async () => root?.unmount());
      root = null;
      container.remove();
    }
  });

  it("keeps setup script failure visible in Jujutsu summaries", async () => {
    const failedSetup = snapshot("done");
    await renderCard(
      {
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
      },
      "jj",
    );
    expect(container.textContent).toContain("Workspace ready, setup script failed");
  });
});
