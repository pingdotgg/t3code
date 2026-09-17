import {
  EnvironmentId,
  ProjectId,
  type PullRequestFilesViewedResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { host, setFilesViewed, toastAdd } = vi.hoisted(() => ({
  host: { data: null as unknown, refresh: vi.fn() },
  setFilesViewed: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { filesViewed: () => null, setFilesViewed: {} },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: host.data,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: host.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => setFilesViewed }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toastAdd } }));

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
const paths = ["a.ts"];

/** What the host answers, as a fresh object each time: a read is only a read if it is a new one. */
function answer(state: "unviewed" | "viewed" | "dismissed"): PullRequestFilesViewedResult {
  return { files: [{ path: "a.ts", state }], truncated: false };
}

let renderer: ReactTestRenderer | null = null;

function Probe(_props: { readonly view: PullRequestFilesViewedView }) {
  return null;
}

function Surface() {
  const view = usePullRequestFilesViewed({ environmentId, reference, enabled: true, paths });
  return <Probe view={view} />;
}

function view(): PullRequestFilesViewedView {
  return renderer!.root.findByType(Probe).props.view;
}

/** The host's next answer landing, which is what a `refresh` ends in. */
async function reads(state: "unviewed" | "viewed" | "dismissed") {
  host.data = answer(state);
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.data = answer("unviewed");
  host.refresh.mockReset();
  toastAdd.mockReset();
  setFilesViewed.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  act(() => {
    renderer = create(
      <StrictMode>
        <Surface />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
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

    // The push landed between the write and this read, so the host answers `dismissed` rather
    // than the `viewed` the press asked for.
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().isStale("a.ts")).toBe(true);
    expect(view().viewedCount).toBe(0);
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
  it("holds the press while the write is still out", async () => {
    let land = (_result: unknown) => {};
    setFilesViewed.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));

    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    // An answer already on its way when the box was ticked must not put it back.
    await reads("unviewed");
    expect(view().isViewed("a.ts")).toBe(true);

    await act(async () => land(AsyncResult.success(undefined)));
    expect(view().isViewed("a.ts")).toBe(true);
  });

  it("holds a press made since the read that would otherwise answer for it", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    // Pressed again before the post-write read came back. That press is the one on screen, and
    // the read that answers for the first one says nothing about it.
    view().setViewed("a.ts", true);
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(true);
    expect(view().isStale("a.ts")).toBe(false);
  });
});
