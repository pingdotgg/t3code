import { FileRenderer, parseDiffFromFile } from "@pierre/diffs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
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
  formatError,
} = vi.hoisted(() => ({
  editorOptions: vi.fn(),
  prepareWorkspace: vi.fn(),
  publish: vi.fn(),
  formatError: vi.fn(),
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
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: formatError }));
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
import {
  readReviewDraft,
  reviewEditKey,
  ReviewEditsProvider,
  useReviewEdits,
  useReviewPanelLeaveGuard,
} from "./ReviewEdits";
import { selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";

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
const panelRef = scopeThreadRef(target.environmentId, ThreadId.make("review"));
let renderer: ReactTestRenderer;
let edits: NonNullable<ReturnType<typeof useReviewEdits>>;
function Probe() {
  const value = useReviewEdits()!;
  useReviewPanelLeaveGuard(panelRef);
  useEffect(() => {
    edits = value;
  }, [value]);
  return null;
}

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
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
  formatError.mockReset().mockReturnValue("Request failed");
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
    input: {
      cwd: "/repo",
      relativePath: "file.ts",
      contents: "changed",
      expectedBranch: "review",
      expectedContents: "saved",
    },
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
it.each(["ctrlKey", "metaKey"])(
  "keeps closed PR drafts and blocks %s save, dialog save, and publish",
  async (modifier) => {
    await mount();
    const url = "https://github.com/example/repo/pull/1";
    const draft = {
      ...savedDraft,
      pullRequestUrl: url,
      workspace: { cwd: "/review", branch: "feature" },
      pendingPush: true,
    };
    const draftKey = reviewEditKey(draft);
    await act(async () => {
      edits.begin(draft);
      edits.change(draftKey, "unsaved");
      edits.focus(draftKey);
      edits.setPullRequestReadOnly(target.environmentId, url, "This PR is merged.");
    });
    await save(modifier);
    await act(async () => edits.change(draftKey, "late editor event"));
    expect(edits.drafts.get(draftKey)).toMatchObject({
      contents: "unsaved",
      savedContents: "saved",
    });
    await blockNavigation();
    expect(
      renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save")
        ?.props.disabled,
    ).toBe(true);
    await click("Save");
    expect(write).not.toHaveBeenCalled();
    expect(prepareWorkspace).not.toHaveBeenCalled();
    await click("Discard");
    expect(blocker.proceed).toHaveBeenCalledOnce();
    expect(edits.drafts.get(draftKey)).toMatchObject({ contents: "saved", pendingPush: true });
    await act(async () => {
      expect(await edits.publish(target.environmentId, target.cwd, url)).toBe(false);
    });
    expect(publish).not.toHaveBeenCalled();
    await act(async () => {
      edits.setPullRequestReadOnly(target.environmentId, url, null);
      expect(await edits.publish(target.environmentId, target.cwd, url)).toBe(true);
    });
  },
);

it("does not save when the PR closes while its workspace is being prepared", async () => {
  await mount();
  const url = "https://github.com/example/repo/pull/1";
  const draft = { ...savedDraft, pullRequestUrl: url };
  const draftKey = reviewEditKey(draft);
  let finish!: (value: unknown) => void;
  prepareWorkspace.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await act(async () => {
    edits.begin(draft);
    edits.change(draftKey, "unsaved");
    edits.focus(draftKey);
  });
  await save();
  await act(async () => {
    edits.setPullRequestReadOnly(target.environmentId, url, "This PR is closed.");
    finish({
      _tag: "Success",
      value: { worktreePath: "/review", branch: "feature", isOnPullRequestHead: true },
    });
  });
  expect(write).not.toHaveBeenCalled();
  expect(edits.drafts.get(draftKey)?.contents).toBe("unsaved");
});
it("keeps edits and explains when an older server rejects PR saving", async () => {
  await mount();
  const draft = { ...savedDraft, pullRequestUrl: "https://github.com/example/repo/pull/1" };
  const draftKey = reviewEditKey(draft);
  await act(async () => {
    edits.begin(draft);
    edits.change(draftKey, "PR edit");
    edits.focus(draftKey);
  });
  prepareWorkspace.mockResolvedValueOnce({ _tag: "Failure" });
  const detail = 'Expected "local" | "worktree"\n  at ["mode"]';
  formatError.mockReturnValueOnce(detail);
  await save();
  expect(edits.drafts.get(draftKey)).toMatchObject({
    contents: "PR edit",
    savedContents: "saved",
  });
  expect(write).not.toHaveBeenCalled();
  expect(toast.mock.lastCall?.[0].description).toContain("Update and restart");
  expect(toast.mock.lastCall?.[0].description).toContain(detail);
  await save();
  expect(edits.drafts.get(draftKey)?.savedContents).toBe("PR edit");
});
it("keeps the panel open until unsaved edits are saved or discarded", async () => {
  await mount();
  await change();
  let open = true;
  const close = () => {
    open = false;
  };
  await act(async () => edits.requestLeave(close));
  expect(open).toBe(true);
  await click("Keep editing");
  expect(open).toBe(true);
  expect(edits.drafts.get(key)?.contents).toBe("changed");
  await act(async () => edits.requestLeave(close));
  write.mockResolvedValueOnce({ _tag: "Failure" });
  await click("Save");
  expect(open).toBe(true);
  expect(edits.drafts.get(key)?.contents).toBe("changed");
  await click("Save");
  expect(open).toBe(false);
  expect(edits.drafts.size).toBe(0);
});
it("keeps the editor for inactive closes and automatic opens, and confirms a user switch", async () => {
  await mount();
  const store = useRightPanelStore.getState();
  store.open(panelRef, "files");
  store.open(panelRef, "diff");
  await change();
  await act(async () => {
    store.closeSurface(panelRef, "files");
    store.closeOtherSurfaces(panelRef, "diff");
    const currentTurn = TurnId.make("current");
    useDiffPanelStore.getState().selectTurn(panelRef, currentTurn);
    if (
      store.openProactive(
        panelRef,
        { id: "diff", kind: "diff" },
        store.getUserActionRevision(panelRef),
      )
    ) {
      useDiffPanelStore.getState().selectTurn(panelRef, TurnId.make("new"));
    }
    expect(
      useDiffPanelStore.getState().byThreadKey[`${target.environmentId}:review`],
    ).toMatchObject({ turnId: currentTurn });
    expect(
      store.openProactive(
        panelRef,
        {
          kind: "pull-request",
          id: "pull-request:other",
          projectId: "project",
          repository: "owner/repo",
          number: 1,
        },
        store.getUserActionRevision(panelRef),
      ),
    ).toBe(false);
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  expect(edits.drafts.get(key)?.contents).toBe("changed");
  await act(async () => store.openFile(panelRef, "file.ts"));
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, panelRef)).toBe("diff");
  await click("Keep editing");
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, panelRef)).toBe("diff");
  await act(async () => store.openFile(panelRef, "file.ts"));
  await click("Discard");
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, panelRef)).toBe("file");
});
it("discards only after confirmation and closes a clean panel without asking", async () => {
  await mount();
  await change();
  const close = vi.fn();
  await act(async () => edits.requestLeave(close));
  expect(close).not.toHaveBeenCalled();
  await blockNavigation();
  await click("Discard");
  expect(close).toHaveBeenCalledOnce();
  expect(blocker.reset).toHaveBeenCalledOnce();
  expect(blocker.proceed).not.toHaveBeenCalled();
  expect(edits.drafts.size).toBe(0);
  await act(async () => edits.requestLeave(close));
  expect(close).toHaveBeenCalledTimes(2);
});
it("cancels a pending close while saving and clears old save errors on the next prompt", async () => {
  await mount();
  await change();
  write.mockResolvedValueOnce({ _tag: "Failure" });
  await save();
  const close = vi.fn();
  await act(async () => edits.requestLeave(close));
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  let finish!: (value: unknown) => void;
  write.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await click("Save");
  expect(close).not.toHaveBeenCalled();
  expect(
    renderer.root.findAllByType("button").filter((button) => button.props.disabled),
  ).toHaveLength(2);
  await click("Keep editing");
  await act(async () => finish({ _tag: "Success" }));
  expect(close).not.toHaveBeenCalled();
  expect(edits.drafts.get(key)?.savedContents).toBe("changed");
});
it("does not warn for list filters that keep the same PR open", async () => {
  await mount();
  await change();
  const current = {
    routeId: "/_chat/pull-requests",
    search: { repository: "owner/repo", number: 1, selectedHost: "github.com" },
  };
  const shouldBlock = blockOptions.mock.lastCall?.[0].shouldBlockFn;
  expect(
    shouldBlock({
      current,
      next: { ...current, search: { ...current.search, q: "test", host: "gitlab.com" } },
    }),
  ).toBe(false);
  expect(
    shouldBlock({ current, next: { ...current, search: { ...current.search, number: 2 } } }),
  ).toBe(true);
  expect(
    shouldBlock({
      current,
      next: { ...current, search: { ...current.search, selectedHost: "gitlab.com" } },
    }),
  ).toBe(true);
  expect(shouldBlock({ current, next: { routeId: "/settings" } })).toBe(true);
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
  const otherDraft = { ...savedDraft, pullRequestUrl: "https://github.com/example/repo/pull/2" };
  await act(async () => edits.begin(otherDraft));
  expect(edits.savingKeys.has(key)).toBe(true);
  expect(edits.savingKeys.has(reviewEditKey(otherDraft))).toBe(false);
  await save();
  expect(write).toHaveBeenCalledOnce();
  await act(async () => finish({ _tag: "Success" }));
  expect(edits.savingKeys.size).toBe(0);
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
it("consumes the editor save before the composer's window shortcut", async () => {
  const stash = vi.fn();
  function ComposerShortcut() {
    useEffect(() => {
      window.addEventListener("keydown", stash, true);
      return () => window.removeEventListener("keydown", stash, true);
    }, []);
    return null;
  }
  await act(async () => {
    renderer = create(
      <ReviewEditsProvider>
        <Probe />
        <ComposerShortcut />
      </ReviewEditsProvider>,
    );
  });
  await act(async () => {
    edits.begin(savedDraft);
    edits.change(key, "changed");
    edits.focus(key);
  });
  await save();
  expect(write).toHaveBeenCalledOnce();
  expect(stash).not.toHaveBeenCalled();
  await act(async () => edits.focus(null));
  await save();
  expect(stash).toHaveBeenCalledOnce();
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
      getFile: () => ({ name: fileDiff.name, contents: "fresh" }),
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
  const loadDiffFiles = vi.fn().mockRejectedValue(new Error("Source repository is gone"));
  const view = (collapsed = false, readOnly = false, partial = false) => (
    <ReviewEditsProvider>
      <Probe />
      <EditableDiffCodeView
        items={[
          {
            ...item,
            fileDiff: partial ? { ...fileDiff, isPartial: true } : fileDiff,
            collapsed,
            version: collapsed ? 2 : 1,
          },
        ]}
        editing={() => ({ ...prTarget, readOnly })}
        options={{ loadDiffFiles }}
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
  await act(async () => renderer.update(view(true, true)));
  let readonlyItem = renderer.root.findByType(StyledDiffCodeView).props.items[0];
  expect(readonlyItem.edit).toBe(false);
  expect(readonlyItem.fileDiff.additionLines.join("")).toBe("unsaved PR edit");
  await act(async () => renderer.update(view()));
  await act(async () => edits.change(reviewEditKey(prTarget), "old"));
  await act(async () => renderer.update(view(false, true)));
  readonlyItem = renderer.root.findByType(StyledDiffCodeView).props.items[0];
  const bodyRenderer = new FileRenderer();
  const revertedBody = await bodyRenderer.asyncRender(readonlyItem.file);
  expect(bodyRenderer.renderPartialHTML(revertedBody.contentAST).replace(/<[^>]*>/g, "")).toBe(
    "old",
  );
  await act(async () => renderer.update(view()));
  await act(async () => edits.change(reviewEditKey(prTarget), "unsaved PR edit"));
  await act(async () => edits.focus(reviewEditKey(prTarget)));
  await save();
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(view(false, true, true));
  });
  expect(edits.drafts.get(reviewEditKey(prTarget))?.pendingPush).toBe(true);
  readonlyItem = renderer.root.findByType(StyledDiffCodeView).props.items[0];
  expect(readonlyItem.edit).toBe(false);
  const body = await bodyRenderer.asyncRender(readonlyItem.file);
  expect(bodyRenderer.renderPartialHTML(body.contentAST).replace(/<[^>]*>/g, "")).toBe(
    "unsaved PR edit",
  );
  bodyRenderer.cleanUp();
  expect(loadDiffFiles).not.toHaveBeenCalled();
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
      pullRequestUrl: url,
    },
    {
      cwd: "/review",
      relativePath: "other.ts",
      contents: "PR edit",
      expectedContents: "saved",
      expectedBranch: "t3-review/feature",
      pullRequestUrl: url,
    },
  ]);
  await act(async () => renderer.unmount());
  await mount();
  expect(edits.drafts.get(firstKey)?.contents).toBe("PR edit");
  expect(edits.drafts.get(secondKey)?.pendingPush).toBe(true);
  expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(false);
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

it.each(["save", "publish"])(
  "protects saved PR edits until %s recovers browser storage failure",
  async (recovery) => {
    await mount();
    const draft = { ...savedDraft, pullRequestUrl: "https://github.com/example/repo/pull/1" };
    const draftKey = reviewEditKey(draft);
    await act(async () => {
      edits.begin(draft);
      edits.change(draftKey, "edit");
      edits.focus(draftKey);
    });
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("Quota exceeded");
    };
    await save();
    expect(edits.drafts.get(draftKey)).toMatchObject({ savedContents: "edit", pendingPush: true });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Browser storage is unavailable" }),
    );
    expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(true);
    const leave = vi.fn();
    await act(async () => edits.requestLeave(leave));
    expect(leave).toHaveBeenCalledOnce();
    if (recovery === "save") {
      window.localStorage.setItem = setItem;
      await act(async () => edits.change(draftKey, "another edit"));
      await save();
      expect(edits.drafts.get(draftKey)).toMatchObject({
        savedContents: "another edit",
        pendingPush: true,
      });
    } else {
      await act(async () => {
        expect(await edits.publish(target.environmentId, target.cwd, draft.pullRequestUrl)).toBe(
          true,
        );
      });
      expect(edits.drafts.get(draftKey)?.pendingPush).toBe(false);
    }
    expect(blockOptions.mock.lastCall?.[0].enableBeforeUnload).toBe(false);
  },
);

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
