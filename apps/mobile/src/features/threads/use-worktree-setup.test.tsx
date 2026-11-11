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

function Probe(props: { preparing: boolean; seen: Array<WorktreeSetupSnapshot | null> }) {
  const { snapshot } = useWorktreeSetup({
    environmentId,
    threadId,
    preparing: props.preparing,
    hasWorktree: false,
    turnStarted: false,
    followUpSent: false,
  });
  useLayoutEffect(() => {
    props.seen.push(snapshot);
  });
  return null;
}

// A fast retry's preparing -> failed can coalesce, so the hook never renders it as preparing.
it("shows a retry's failure that arrives without a preparing render", async () => {
  mocks.server = failed;
  const seen: Array<WorktreeSetupSnapshot | null> = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe preparing seen={seen} />));
  await act(async () => root.render(<Probe preparing={false} seen={seen} />));
  expect(seen.at(-1)).toBe(failed);

  // Retention ended, so the server resets the retry's sequence.
  mocks.server = null;
  await act(async () => root.render(<Probe preparing={false} seen={seen} />));
  const retryFailed: WorktreeSetupSnapshot = {
    ...failed,
    sequence: 0,
    startedAt: "2026-10-30T00:01:00.000Z",
    endedAt: "2026-10-30T00:01:00.050Z",
    error: "Checkout failed",
  };
  mocks.server = retryFailed;
  await act(async () => root.render(<Probe preparing={false} seen={seen} />));
  expect(seen.at(-1)).toBe(retryFailed);
  act(() => root.unmount());
});
