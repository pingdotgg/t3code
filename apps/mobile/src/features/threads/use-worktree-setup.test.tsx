import { EnvironmentId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  server: null as WorktreeSetupSnapshot | null,
}));

vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { worktreeSetup: () => "worktree-setup" },
}));
// The server only pushes snapshots to an open subscription.
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data: atom === "worktree-setup" ? mocks.server : null,
    isPending: false,
    refresh: () => {},
  }),
}));

import { useWorktreeSetup } from "./use-worktree-setup";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("setup-thread");
const failed: WorktreeSetupSnapshot = {
  threadId,
  sequence: 2,
  phase: "failed",
  startedAt: "2026-10-30T00:00:00.000Z",
  endedAt: "2026-10-30T00:00:00.980Z",
  branch: "feature",
  baseRef: "origin/main",
  worktreePath: null,
  setupScript: null,
  stages: [],
  error: "Fetch base branch failed",
};

it("shows the retry's progress after a failed worktree setup", async () => {
  mocks.server = failed;
  const seen: Array<WorktreeSetupSnapshot | null> = [];
  function Probe(props: { preparing: boolean }) {
    const { snapshot } = useWorktreeSetup({
      environmentId,
      threadId,
      preparing: props.preparing,
      turnStarted: false,
      followUpSent: false,
    });
    useLayoutEffect(() => {
      seen.push(snapshot);
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe preparing />));
  await act(async () => root.render(<Probe preparing={false} />));
  expect(seen.at(-1)).toBe(failed);

  const retry: WorktreeSetupSnapshot = {
    ...failed,
    sequence: 3,
    phase: "running",
    startedAt: "2026-10-30T00:01:00.000Z",
    endedAt: null,
    error: null,
  };
  mocks.server = retry;
  await act(async () => root.render(<Probe preparing />));
  expect(seen.at(-1)).toBe(retry);
  act(() => root.unmount());
});
