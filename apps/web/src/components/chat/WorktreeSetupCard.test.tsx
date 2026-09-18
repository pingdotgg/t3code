import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { WorktreeSetupCard } from "./WorktreeSetupCard";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("keeps setup details reachable when the live stage folds after a failed script", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const snapshot: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("setup"),
    phase: "running",
    startedAt: "2026-09-17T12:00:00Z",
    endedAt: null,
    branch: "feature/setup",
    baseRef: "main",
    worktreePath: "/worktrees/setup",
    setupScript: { name: "Install dependencies", command: "vp i", terminalId: "setup" },
    stages: [
      {
        id: "setup-script",
        status: "running",
        startedAt: "2026-09-17T12:00:00Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: ["old", "line 1", "line 2", "line 3", "line 4"],
      },
    ],
    error: null,
    sequence: 1,
  };
  const render = (snapshot: WorktreeSetupSnapshot) => (
    <WorktreeSetupCard
      snapshot={snapshot}
      embedded
      onCancel={vi.fn()}
      onOpenTerminal={vi.fn()}
      onWorkLocally={null}
    />
  );
  await act(async () => {
    renderer = create(render(snapshot));
  });
  const text = () =>
    renderer!.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ");
  expect(text()).toContain("Install dependencies");
  expect(text()).toContain("Cancel");
  expect(renderer!.root.findByType("pre").children).toHaveLength(4);
  expect(text()).not.toContain("old");

  await act(async () => {
    renderer!.update(
      render({
        ...snapshot,
        phase: "done",
        endedAt: "2026-09-17T12:00:02Z",
        stages: snapshot.stages.map((stage) => ({ ...stage, status: "failed" })),
      }),
    );
  });
  expect(text()).toContain("Worktree ready, setup script failed");
  expect(text()).not.toContain("Install dependencies");
  expect(text()).not.toContain("Cancel");
  expect(text()).toContain("Open terminal");
  await act(async () => {
    renderer!.root.findByProps({ "aria-expanded": false }).props.onClick();
  });
  expect(text()).toContain("feature/setup");
  expect(text()).toContain("vp i");
  await act(async () => {
    renderer!.root.findByProps({ "aria-expanded": true }).props.onClick();
  });
  expect(text()).not.toContain("feature/setup");
});
