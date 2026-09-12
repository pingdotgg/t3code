import { parseDiffFromFile } from "@pierre/diffs";
import { EnvironmentId } from "@t3tools/contracts";
import { act, useEffect, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const {
  read,
  write,
  refresh,
  blockOptions,
  blocker,
  toast,
  refreshStatus,
  editorOptions,
  prepareWorkspace,
  publish,
} = vi.hoisted(() => ({
  editorOptions: vi.fn(),
  prepareWorkspace: vi.fn(),
  publish: vi.fn(),
  read: vi.fn(),
  refreshStatus: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  blockOptions: vi.fn(),
  toast: vi.fn(),
  blocker: { status: "idle", proceed: vi.fn(), reset: vi.fn() },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery: read }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { refresh } }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { refreshStatus: { run: refreshStatus } },
  vcsActionManager: { runStackedAction: () => ({ run: publish }) },
}));
vi.mock("~/state/git", () => ({
  gitEnvironment: { preparePullRequestThread: { run: prepareWorkspace } },
}));
vi.mock("@pierre/diffs/editor", () => ({ Editor: editorOptions }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => write }));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Request failed" }));
vi.mock("../files/projectFilesQueryState", () => ({ getProjectFileQueryAtom: () => "file" }));
vi.mock("./StyledDiffCodeView", () => ({ StyledDiffCodeView: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: (options: unknown) => {
    blockOptions(options);
    return blocker;
  },
}));
vi.mock("../ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? children : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => children,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
}));

import { EditableDiffCodeView } from "./EditableDiffCodeView";
import { StyledDiffCodeView } from "./StyledDiffCodeView";
import { readReviewDraft, reviewEditKey, ReviewEditsProvider, useReviewEdits } from "./ReviewEdits";

const target = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/repo",
  filePath: "file.ts",
  expectedBranch: "review",
};
const savedDraft = {
  ...target,
  contents: "saved",
  savedContents: "saved",
};
const key = reviewEditKey(target);
let renderer: ReactTestRenderer;
let edits: NonNullable<ReturnType<typeof useReviewEdits>>;
function Probe() {
  const value = useReviewEdits()!;
  useEffect(() => {
    edits = value;
  }, [value]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    }),
  );
  prepareWorkspace.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { worktreePath: "/review", branch: "t3-review/feature", isOnPullRequestHead: true },
  });
  publish.mockReset().mockResolvedValue({ _tag: "Success" });
  blocker.status = "idle";
  blocker.proceed.mockReset().mockImplementation(() => {
    blocker.status = "idle";
  });
  blocker.reset.mockReset().mockImplementation(() => {
    blocker.status = "idle";
  });
  blockOptions.mockClear();
  write.mockReset().mockResolvedValue({ _tag: "Success" });
  refresh.mockClear();
  toast.mockClear();
  editorOptions.mockClear();
  refreshStatus.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { refName: "review", pr: { url: "https://github.com/example/repo/pull/1" } },
  });
  read
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { contents: "fresh", truncated: false } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(
      <ReviewEditsProvider>
        <Probe />
      </ReviewEditsProvider>,
    );
  });
  await act(async () => {
    edits.begin(savedDraft);
    edits.focus(key);
  });
}
async function change(contents = "changed") {
  await act(async () => edits.change(key, contents));
}
async function save(modifier = "ctrlKey") {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "s",
    [modifier]: true,
  });
  await act(async () => window.dispatchEvent(event));
  return event;
}
async function click(label: string) {
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.join("") === label)!
      .props.onClick(),
  );
}
async function blockNavigation() {
  blocker.status = "blocked";
  await act(async () =>
    renderer.update(
      <ReviewEditsProvider>
        <Probe />
      </ReviewEditsProvider>,
    ),
  );
}

it("reads fresh working contents after checking the checkout", async () => {
  expect(await readReviewDraft(target)).toMatchObject({
    contents: "fresh",
    savedContents: "fresh",
    expectedBranch: "review",
  });
  expect(read.mock.calls.map((call) => [call[1], call[2].refresh])).toEqual([["file", true]]);
});
it("rejects a checkout change before reading working contents", async () => {
  refreshStatus.mockResolvedValueOnce({ _tag: "Success", value: { refName: "other", pr: null } });
  await expect(readReviewDraft(target)).rejects.toThrow("checkout changed");
  expect(read).not.toHaveBeenCalled();
});
it.each([
  "https://github.com/example/repo/pull/1",
  "https://gitlab.com/example/repo/-/merge_requests/1",
  "https://bitbucket.org/example/repo/pull-requests/1",
  "https://dev.azure.com/example/repo/_git/repo/pullrequest/1",
])("edits PR contents without reading or switching the checkout for %s", async (url) => {
  expect(await readReviewDraft({ ...target, pullRequestUrl: url }, "PR contents")).toMatchObject({
    contents: "PR contents",
    savedContents: "PR contents",
  });
  expect(refreshStatus).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(prepareWorkspace).not.toHaveBeenCalled();
});
it.each(["failure", "truncated"])("does not edit an incomplete read: %s", async (reason) => {
  read.mockResolvedValueOnce(
    reason === "failure"
      ? { _tag: "Failure" }
      : { _tag: "Success", value: { contents: "partial", truncated: true } },
  );
  await expect(readReviewDraft(target)).rejects.toThrow();
});
it.each(["ctrlKey", "metaKey"])("saves only on %s+S", async (modifier) => {
  await mount();
  await change();
  expect(write).not.toHaveBeenCalled();
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
  expect((await save(modifier)).defaultPrevented).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith({
    environmentId: "test",
    input: { cwd: "/repo", relativePath: "file.ts", contents: "changed", expectedBranch: "review" },
  });
  expect(edits.drafts.get(key)?.savedContents).toBe("changed");
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(false);
});
it("keeps failed saves dirty and permits a retry", async () => {
  await mount();
  await change();
  write.mockResolvedValueOnce({ _tag: "Failure" });
  await save();
  expect(edits.drafts.get(key)).toMatchObject({ contents: "changed", savedContents: "saved" });
  expect(toast).toHaveBeenCalledOnce();
  await save();
  expect(edits.drafts.get(key)?.savedContents).toBe("changed");
});
it("retains newer edits made while saving and blocks duplicate writes", async () => {
  await mount();
  await change("first");
  let finish!: (value: unknown) => void;
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await save();
  await change("second");
  await save();
  expect(write).toHaveBeenCalledOnce();
  await act(async () => finish({ _tag: "Success" }));
  expect(edits.drafts.get(key)).toMatchObject({ contents: "second", savedContents: "first" });
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
});
it("preserves dirty drafts when a review surface unmounts", async () => {
  await mount();
  await change();
  await act(async () => renderer.update(<ReviewEditsProvider>{null}</ReviewEditsProvider>));
  await act(async () =>
    renderer.update(
      <ReviewEditsProvider>
        <Probe />
      </ReviewEditsProvider>,
    ),
  );
  await act(async () => {
    edits.begin(savedDraft);
  });
  expect(edits.drafts.get(key)?.contents).toBe("changed");
});
it("keeps unsaved drafts separate and saves to their original branches", async () => {
  await mount();
  await change("first branch edits");
  const other = { ...savedDraft, expectedBranch: "other" };
  const otherKey = reviewEditKey(other);
  await act(async () => {
    edits.begin(other);
    edits.change(otherKey, "second branch edits");
    edits.focus(otherKey);
  });
  await save();
  expect(write.mock.lastCall?.[0].input).toMatchObject({
    expectedBranch: "other",
    contents: "second branch edits",
  });
  expect(edits.drafts.get(key)?.contents).toBe("first branch edits");
  await act(async () => edits.focus(key));
  await save();
  expect(write.mock.lastCall?.[0].input).toMatchObject({
    expectedBranch: "review",
    contents: "first branch edits",
  });
});
it("does not capture the save shortcut after focus leaves the review editor", async () => {
  await mount();
  await change();
  await act(async () => edits.focus(null));
  expect((await save()).defaultPrevented).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
it("keeps edits on cancelled navigation and discards without writing", async () => {
  await mount();
  await change();
  await blockNavigation();
  await click("Keep editing");
  expect(edits.drafts.get(key)?.contents).toBe("changed");
  await blockNavigation();
  await click("Discard");
  expect(edits.drafts.size).toBe(0);
  expect(write).not.toHaveBeenCalled();
  expect(blocker.proceed).toHaveBeenCalledOnce();
});
it("saves all dirty files before allowing navigation", async () => {
  await mount();
  await change();
  await act(async () => {
    edits.begin({ ...savedDraft, filePath: "other.ts" });
    edits.change(reviewEditKey({ ...target, filePath: "other.ts" }), "other change");
  });
  await blockNavigation();
  await click("Save");
  expect(write.mock.calls.map(([request]) => request.input.relativePath)).toEqual([
    "file.ts",
    "other.ts",
  ]);
  expect(blocker.proceed).toHaveBeenCalledOnce();
  expect(edits.drafts.size).toBe(0);
});

it.each(["pull request", "diff version", "checkout"])(
  "does not reuse an editor after the %s changes",
  async (changed) => {
    vi.stubGlobal("document", { caretPositionFromPoint: () => null });
    vi.stubGlobal("ShadowRoot", vi.fn());
    const fileDiff = parseDiffFromFile(
      { name: "file.ts", contents: "old" },
      { name: "file.ts", contents: "fresh" },
    );
    const item = { type: "diff" as const, id: "file.ts", fileDiff, version: 1 };
    const url = "https://github.com/example/repo/pull/1";
    const view = (pullRequestUrl: string, version: number, expectedBranch = "review") => (
      <ReviewEditsProvider>
        <Probe />
        <EditableDiffCodeView
          items={[{ ...item, version }]}
          editing={(filePath) => ({ ...target, filePath, pullRequestUrl, expectedBranch })}
        />
      </ReviewEditsProvider>
    );
    await act(async () => {
      renderer = create(view(url, 1));
    });
    const viewer = () => renderer.root.findByType(StyledDiffCodeView).props;
    await act(async () =>
      viewer().options.onLineClick(
        {
          type: "diff-line",
          lineNumber: 1,
          annotationSide: "additions",
          numberColumn: false,
          event: { clientX: 0, clientY: 0 },
          lineElement: { getRootNode: () => null },
        },
        { type: "diff", item, instance: { fileDiff } },
      ),
    );
    expect(viewer().items[0].edit).toBe(true);
    expect(viewer().items[0].fileDiff).not.toBe(fileDiff);
    viewer().createEditor({ onChange: vi.fn() });
    const setSelections = vi.fn();
    editorOptions.mock.lastCall?.[0].onAttach({
      getFile: () => ({ name: "b/file.ts", contents: "fresh" }),
      setSelections,
      focus: vi.fn(),
    });
    expect(setSelections).toHaveBeenCalledWith([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: "none" },
    ]);
    await act(async () =>
      renderer.update(
        view(
          changed === "pull request" ? url + "2" : url,
          changed === "diff version" ? 2 : 1,
          changed === "checkout" ? "other" : "review",
        ),
      ),
    );
    if (changed === "checkout") {
      expect(viewer().items[0].edit).toBe(true);
    } else {
      expect(viewer().items[0].edit).toBeUndefined();
      expect(viewer().items[0].fileDiff).toBe(fileDiff);
    }
  },
);

it("prepares visible PR code before a click and retains edits across folding", async () => {
  const fileDiff = parseDiffFromFile(
    { name: "file.ts", contents: "old" },
    { name: "file.ts", contents: "PR" },
  );
  const item = { type: "diff" as const, id: "file.ts", fileDiff, version: 1 };
  const prTarget = { ...target, pullRequestUrl: "https://github.com/example/repo/pull/1" };
  const view = (collapsed = false) => (
    <ReviewEditsProvider>
      <Probe />
      <EditableDiffCodeView
        items={[{ ...item, collapsed, version: collapsed ? 2 : 1 }]}
        editing={() => prTarget}
      />
    </ReviewEditsProvider>
  );
  await act(async () => {
    renderer = create(view());
  });
  await act(async () =>
    renderer.root.findByType(StyledDiffCodeView).props.options.onPostRender(null, null, "render", {
      type: "diff",
      item,
      instance: { fileDiff },
    }),
  );
  expect(renderer.root.findByType(StyledDiffCodeView).props.items[0].edit).toBe(true);
  expect(refreshStatus).not.toHaveBeenCalled();
  expect(prepareWorkspace).not.toHaveBeenCalled();
  await act(async () => edits.change(reviewEditKey(prTarget), "unsaved PR edit"));
  for (const collapsed of [true, false]) {
    await act(async () => renderer.update(view(collapsed)));
    const viewer = renderer.root.findByType(StyledDiffCodeView).props;
    await act(async () =>
      viewer.options.onPostRender(null, null, "render", {
        type: "diff",
        item: viewer.items[0],
        instance: { fileDiff },
      }),
    );
  }
  expect(
    renderer.root.findByType(StyledDiffCodeView).props.items[0].fileDiff.additionLines.join(""),
  ).toBe("unsaved PR edit");
});

it("saves PR files in one workspace, restores saved edits, and retries a failed push", async () => {
  await mount();
  const url = "https://github.com/example/repo/pull/1";
  const first = { ...savedDraft, pullRequestUrl: url };
  const second = { ...first, filePath: "other.ts" };
  const firstKey = reviewEditKey(first);
  const secondKey = reviewEditKey(second);
  for (const draft of [first, second]) {
    const draftKey = reviewEditKey(draft);
    await act(async () => {
      edits.begin(draft);
      edits.change(draftKey, "PR edit");
      edits.focus(draftKey);
    });
    await save();
  }
  expect(prepareWorkspace).toHaveBeenCalledTimes(1);
  expect(write.mock.calls.map(([{ input }]) => input)).toEqual([
    {
      cwd: "/review",
      relativePath: "file.ts",
      contents: "PR edit",
      expectedContents: "saved",
      expectedBranch: "t3-review/feature",
    },
    {
      cwd: "/review",
      relativePath: "other.ts",
      contents: "PR edit",
      expectedContents: "saved",
      expectedBranch: "t3-review/feature",
    },
  ]);
  await act(async () => renderer.unmount());
  await mount();
  expect(edits.drafts.get(firstKey)?.contents).toBe("PR edit");
  expect(edits.drafts.get(secondKey)?.pendingPush).toBe(true);
  publish.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => {
    expect(await edits.publish(target.environmentId, target.cwd, url)).toBe(false);
  });
  expect(edits.drafts.get(firstKey)?.pendingPush).toBe(true);
  await act(async () => {
    expect(await edits.publish(target.environmentId, target.cwd, url)).toBe(true);
  });
  expect(publish.mock.lastCall?.[1]).toMatchObject({
    action: "commit_push",
    expectedBranch: "t3-review/feature",
    filePaths: ["file.ts", "other.ts"],
  });
  expect(edits.drafts.get(firstKey)?.pendingPush).toBe(false);
  expect(edits.publishing.size).toBe(0);
});

it("saves and publishes the same PR separately for each source workspace", async () => {
  await mount();
  const url = "https://github.com/example/repo/pull/1";
  const first = { ...savedDraft, pullRequestUrl: url };
  const second = { ...first, cwd: "/other-repo" };
  for (const [index, draft] of [first, second].entries()) {
    prepareWorkspace.mockResolvedValueOnce({
      _tag: "Success",
      value: { worktreePath: `/review-${index}`, branch: "review", isOnPullRequestHead: true },
    });
    await act(async () => {
      edits.begin(draft);
      edits.change(reviewEditKey(draft), `edit ${index}`);
      edits.focus(reviewEditKey(draft));
    });
    await save();
  }
  expect(write.mock.calls.map(([request]) => request.input.cwd)).toEqual([
    "/review-0",
    "/review-1",
  ]);
  await act(async () => {
    expect(await edits.publish(target.environmentId, target.cwd, url)).toBe(true);
  });
  expect(edits.drafts.get(reviewEditKey(first))?.pendingPush).toBe(false);
  expect(edits.drafts.get(reviewEditKey(second))?.pendingPush).toBe(true);
  await act(async () => {
    expect(await edits.publish(target.environmentId, second.cwd, url)).toBe(true);
  });
  expect(edits.drafts.get(reviewEditKey(second))?.pendingPush).toBe(false);
});

it("keeps saved PR edits publishable when browser storage is full", async () => {
  await mount();
  const draft = { ...savedDraft, pullRequestUrl: "https://github.com/example/repo/pull/1" };
  const draftKey = reviewEditKey(draft);
  await act(async () => {
    edits.begin(draft);
    edits.change(draftKey, "edit");
    edits.focus(draftKey);
  });
  window.localStorage.setItem = () => {
    throw new Error("Quota exceeded");
  };
  await save();
  expect(edits.drafts.get(draftKey)).toMatchObject({ savedContents: "edit", pendingPush: true });
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Browser storage is unavailable" }),
  );
  await act(async () => {
    expect(await edits.publish(target.environmentId, target.cwd, draft.pullRequestUrl)).toBe(true);
  });
  expect(edits.drafts.get(draftKey)?.pendingPush).toBe(false);
});

it("blocks changes and duplicate publication while the writing agent runs", async () => {
  await mount();
  const url = "https://gitlab.com/example/repo/-/merge_requests/1";
  const draft = {
    ...savedDraft,
    pullRequestUrl: url,
    workspace: { cwd: "/review", branch: "review" },
    pendingPush: true,
  };
  const draftKey = reviewEditKey(draft);
  await act(async () => {
    edits.begin(draft);
  });
  let finish!: (value: unknown) => void;
  publish.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let result!: Promise<boolean>;
  await act(async () => {
    result = edits.publish(target.environmentId, target.cwd, url);
  });
  expect(edits.publishing.size).toBe(1);
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
  await act(async () => {
    edits.change(draftKey, "must not change");
    expect(await edits.publish(target.environmentId, target.cwd, url)).toBe(false);
  });
  expect(edits.drafts.get(draftKey)?.contents).toBe("saved");
  await act(async () => {
    finish({ _tag: "Success" });
    await result;
  });
  expect(edits.publishing.size).toBe(0);
});
