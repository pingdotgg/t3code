import {
  EnvironmentId,
  ProjectId,
  type PullRequestFilesViewedResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const { host, setFilesViewed, toastAdd } = vi.hoisted(() => ({
  host: { data: null as unknown, refresh: vi.fn() },
  setFilesViewed: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: host.data,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: host.refresh,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => setFilesViewed) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toastAdd } as never };
});

import {
  usePullRequestFilesViewed,
  type PullRequestFilesViewedView,
} from "./usePullRequestFilesViewed";

const environmentId = EnvironmentId.make("pr-files-viewed-audit");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project-a"),
  repository: "acme/web",
  number: 42,
};

function answer(state: "unviewed" | "viewed" | "dismissed"): PullRequestFilesViewedResult {
  return {
    files: [
      { path: "a.ts", state },
      { path: "b.ts", state: "unviewed" },
    ],
    truncated: false,
  };
}

async function mountFilesViewed() {
  host.data = answer("unviewed");
  host.refresh.mockReset();
  toastAdd.mockReset();
  setFilesViewed.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  let current: PullRequestFilesViewedView | undefined;
  function Surface() {
    const view = usePullRequestFilesViewed({
      environmentId,
      reference,
      enabled: true,
      paths: ["a.ts"],
    });
    useEffect(() => {
      current = view;
    });
    return null;
  }
  // A fresh element each time, so the hook reads the host's latest answer.
  const ui = () => (
    <StrictMode>
      <Surface />
    </StrictMode>
  );
  const screen = await render(ui(), { router: false });
  const reread = () => screen.rerender(ui());
  return Object.assign(screen, {
    view: () => current!,
    reread,
    async reads(state: "unviewed" | "viewed" | "dismissed") {
      host.data = answer(state);
      await reread();
    },
  });
}

describe("a mark the host has not answered for yet", () => {
  it("keeps a saved mark through a truncated read until that file is answered", async () => {
    using _timers = fakeTimers();
    await using screen = await mountFilesViewed();
    screen.view().setViewed("a.ts", true);
    await act(() => vi.advanceTimersByTimeAsync(500));

    host.data = { files: [{ path: "b.ts", state: "unviewed" }], truncated: true };
    await screen.reread();
    expect(screen.view().isViewed("a.ts")).toBe(true);
    expect(screen.view().viewedCount).toBe(1);

    await screen.reads("dismissed");
    expect(screen.view().isViewed("a.ts")).toBe(false);
    expect(screen.view().isStale("a.ts")).toBe(true);
  });

  it("accepts a complete response that no longer includes a saved mark", async () => {
    using _timers = fakeTimers();
    await using screen = await mountFilesViewed();
    screen.view().setViewed("a.ts", true);
    await act(() => vi.advanceTimersByTimeAsync(500));

    host.data = { files: [{ path: "b.ts", state: "unviewed" }], truncated: false };
    await screen.reread();
    expect(screen.view().isViewed("a.ts")).toBe(false);
    expect(screen.view().viewedCount).toBe(0);
  });
});

it("follows GitHub marks and unmarks without writing them back", async () => {
  using _timers = fakeTimers();
  await using screen = await mountFilesViewed();
  await screen.reads("viewed");
  expect(screen.view().isViewed("a.ts")).toBe(true);
  expect(screen.view().viewedCount).toBe(1);

  await screen.reads("unviewed");
  expect(screen.view().isViewed("a.ts")).toBe(false);
  expect(screen.view().viewedCount).toBe(0);
  expect(setFilesViewed).not.toHaveBeenCalled();
});
