import { type PullRequestFilesViewedResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const { host, setFilesViewed, toastAdd } = vi.hoisted(() => ({
  host: { data: null as unknown, refresh: vi.fn() },
  setFilesViewed: vi.fn(),
  toastAdd: vi.fn(),
}));

import {
  useReviewFileProgress,
  type PullRequestFilesViewedView,
} from "@t3tools/client-runtime/review-file-progress";

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
  function Surface({ data }: { data: PullRequestFilesViewedResult }) {
    const view = useReviewFileProgress({
      scopeKey: "pr-files-viewed-audit",
      query: {
        data,
        error: null,
        refresh: host.refresh,
      },
      save: setFilesViewed,
      onError: toastAdd,
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
      <Surface data={host.data as PullRequestFilesViewedResult} />
    </StrictMode>
  );
  // Environment reads are mocked and this hook does not navigate.
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
    await using screen = await mountFilesViewed();
    using _timers = fakeTimers();
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
    await using screen = await mountFilesViewed();
    using _timers = fakeTimers();
    screen.view().setViewed("a.ts", true);
    await act(() => vi.advanceTimersByTimeAsync(500));

    host.data = { files: [{ path: "b.ts", state: "unviewed" }], truncated: false };
    await screen.reread();
    expect(screen.view().isViewed("a.ts")).toBe(false);
    expect(screen.view().viewedCount).toBe(0);
  });
});

it("follows GitHub marks and unmarks without writing them back", async () => {
  await using screen = await mountFilesViewed();
  using _timers = fakeTimers();
  await screen.reads("viewed");
  expect(screen.view().isViewed("a.ts")).toBe(true);
  expect(screen.view().viewedCount).toBe(1);

  await screen.reads("unviewed");
  expect(screen.view().isViewed("a.ts")).toBe(false);
  expect(screen.view().viewedCount).toBe(0);
  expect(setFilesViewed).not.toHaveBeenCalled();
});
