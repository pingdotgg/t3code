import {
  EnvironmentId,
  ProjectId,
  type PullRequestFilesViewedResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let root: Root;
let current: PullRequestFilesViewedView;

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

const view = () => current;
const render = () =>
  act(async () =>
    root.render(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );

async function reads(state: "unviewed" | "viewed" | "dismissed") {
  host.data = answer(state);
  await render();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.data = answer("unviewed");
  host.refresh.mockReset();
  toastAdd.mockReset();
  setFilesViewed.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  root = createRoot(document.createElement("div"));
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a mark whose file was pushed to before the read that followed it", () => {
  it("gives way to the host and shows the file as changed", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(setFilesViewed).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { ...reference, files: [{ path: "a.ts", viewed: true }] },
    });
    expect(host.refresh).toHaveBeenCalled();

    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().isStale("a.ts")).toBe(true);
  });

  it("stays given way to on every later read, having nothing left to recover", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await reads("dismissed");

    view().refresh();
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().isStale("a.ts")).toBe(true);
  });
});

describe("a mark the host has not answered for yet", () => {
  it("keeps a saved mark through a truncated read until that file is answered", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    host.data = { files: [{ path: "b.ts", state: "unviewed" }], truncated: true };
    await render();
    expect(view().isViewed("a.ts")).toBe(true);
    expect(view().viewedCount).toBe(1);

    await reads("dismissed");
    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().isStale("a.ts")).toBe(true);
  });

  it("accepts a complete response that no longer includes a saved mark", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    host.data = { files: [{ path: "b.ts", state: "unviewed" }], truncated: false };
    await render();
    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().viewedCount).toBe(0);
  });

  it("holds the press while the write is still out", async () => {
    let land = (_result: unknown) => {};
    setFilesViewed.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));

    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    await reads("unviewed");
    expect(view().isViewed("a.ts")).toBe(true);

    await act(async () => land(AsyncResult.success(undefined)));
    expect(view().isViewed("a.ts")).toBe(true);
  });

  it("holds a press made since the read that would otherwise answer for it", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    view().setViewed("a.ts", true);
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(true);
    expect(view().isStale("a.ts")).toBe(false);
  });
});

describe("a failed batch that the host partly applied", () => {
  it("refreshes the host and accepts the applied marks", async () => {
    setFilesViewed.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("partial batch"))),
    );
    host.refresh.mockImplementation(() => {
      host.data = answer("viewed");
      root.render(
        <StrictMode>
          <Surface />
        </StrictMode>,
      );
    });
    act(() => {
      view().setViewed("a.ts", true);
      view().setViewed("b.ts", true);
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(view().isViewed("a.ts")).toBe(true);
    expect(view().isViewed("b.ts")).toBe(false);
  });
});

it("follows GitHub marks and unmarks without writing them back", async () => {
  await reads("viewed");
  expect(view().isViewed("a.ts")).toBe(true);
  expect(view().viewedCount).toBe(1);

  await reads("unviewed");
  expect(view().isViewed("a.ts")).toBe(false);
  expect(view().viewedCount).toBe(0);
  expect(setFilesViewed).not.toHaveBeenCalled();
});
