import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { isMacPlatform } from "~/lib/utils";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  fileListeners: new Set<() => void>(),
  writeFile: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    // Edits write through setProjectFileQueryData, as the real query cache does.
    data: useSyncExternalStore(
      (listener) => {
        state.fileListeners.add(listener);
        return () => state.fileListeners.delete(listener);
      },
      () => state.optimistic ?? state.file,
    ),
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
    for (const listener of state.fileListeners) listener();
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.optimistic = null;
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(truncated: boolean) {
  state.file = {
    relativePath: "tasks.md",
    contents: "- [ ] Keep the rest of this file\n",
    byteLength: truncated ? 1_200_000 : 32,
    truncated,
  };
  return filePreview("tasks.md");
}

function filePreview(relativePath: string, target = threadRef, revealLine: number | null = null) {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={target}
      composerDraftTarget={target}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={revealLine}
      revealRequestId={revealLine === null ? 0 : 1}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
      },
    });
  });
});

describe("file view comments", () => {
  it("shows a comment already in the composer draft when the file view mounts", async () => {
    using _settings = setup();
    const contents = "export const one = 1;\nexport const two = 2;\n";
    state.file = {
      relativePath: "config.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const comment = buildFileReviewComment({
      id: "file-comment-1",
      filePath: "config.ts",
      startLine: 2,
      endLine: 2,
      text: "Repro note on line two",
      contents,
    });
    const store = useComposerDraftStore.getState();
    store.addReviewComment(threadRef, comment);
    using _comment = { [Symbol.dispose]: () => store.removeReviewComment(threadRef, comment.id) };

    await using screen = await render(filePreview("config.ts"));

    const inlineComment = screen.getByText("Repro note on line two");
    await expect.element(inlineComment).toBeVisible();
    expect(inlineComment.element().closest("[slot]")?.getAttribute("slot")).toBe("annotation-2");
  });

  it("shows only the current thread's comments when the thread changes under a mounted file view", async () => {
    using _settings = setup();
    const contents = "export const one = 1;\nexport const two = 2;\n";
    state.file = {
      relativePath: "config.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const otherThreadRef = { environmentId, threadId: ThreadId.make("other-thread") };
    const store = useComposerDraftStore.getState();
    const comments = [
      { target: threadRef, id: "file-comment-a", line: 1, text: "Note from thread A" },
      { target: otherThreadRef, id: "file-comment-b", line: 2, text: "Note from thread B" },
    ];
    for (const { target, id, line, text } of comments) {
      store.addReviewComment(
        target,
        buildFileReviewComment({
          id,
          filePath: "config.ts",
          startLine: line,
          endLine: line,
          text,
          contents,
        }),
      );
    }
    using _comments = {
      [Symbol.dispose]: () => {
        for (const { target, id } of comments) store.removeReviewComment(target, id);
      },
    };

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("Note from thread A")).toBeVisible();

    await screen.rerender(filePreview("config.ts", otherThreadRef));

    await expect.element(screen.getByText("Note from thread B")).toBeVisible();
    expect(screen.getByText("Note from thread A").query()).toBeNull();
  });

  it("does not replay another thread's comment when undoing after a thread change", async () => {
    using _settings = setup();
    const contents = "export const one = 1;\nexport const two = 2;\n";
    state.file = {
      relativePath: "config.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const otherThreadRef = { environmentId, threadId: ThreadId.make("other-thread") };
    const store = useComposerDraftStore.getState();
    store.addReviewComment(
      threadRef,
      buildFileReviewComment({
        id: "file-comment-a",
        filePath: "config.ts",
        startLine: 2,
        endLine: 2,
        text: "Note from thread A",
        contents,
      }),
    );
    using _comments = {
      [Symbol.dispose]: () => {
        for (const target of [threadRef, otherThreadRef]) {
          store.removeReviewComment(target, "file-comment-a");
        }
      },
    };

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("Note from thread A")).toBeVisible();
    const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
    const content = () => shadowRoot()?.querySelector<HTMLElement>("[data-content]");
    await vi.waitFor(() => expect(content()?.isContentEditable).toBe(true));

    const firstLine = shadowRoot()!.querySelector('[data-line="1"]')!;
    const caret = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT).nextNode()!;
    content()!.focus();
    const selectionSynced = new Promise((resolve) =>
      document.addEventListener("selectionchange", resolve, { once: true }),
    );
    document.getSelection()!.setBaseAndExtent(caret, 0, caret, 0);
    await selectionSynced;
    await act(async () => {
      content()!.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertParagraph",
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    });
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe(`\n${contents}`));

    await screen.rerender(filePreview("config.ts", otherThreadRef));
    await vi.waitFor(() => expect(content()?.isContentEditable).toBe(true));
    content()!.focus();
    const isMac = isMacPlatform(navigator.platform);
    await act(async () => {
      content()!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    });

    const otherDraft = useComposerDraftStore.getState().getComposerDraft(otherThreadRef);
    expect(otherDraft?.reviewComments ?? []).toEqual([]);
    expect(screen.getByText("Note from thread A").query()).toBeNull();
  });

  it("drops a comment removed from the composer and does not re-add it on the next edit", async () => {
    using _settings = setup();
    const contents = "export const one = 1;\nexport const two = 2;\n";
    state.file = {
      relativePath: "config.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const store = useComposerDraftStore.getState();
    const comment = buildFileReviewComment({
      id: "file-comment-removed",
      filePath: "config.ts",
      startLine: 2,
      endLine: 2,
      text: "Removed from the composer",
      contents,
    });
    store.addReviewComment(threadRef, comment);
    using _comment = { [Symbol.dispose]: () => store.removeReviewComment(threadRef, comment.id) };

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("Removed from the composer")).toBeVisible();
    const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
    const content = () => shadowRoot()?.querySelector<HTMLElement>("[data-content]");
    await vi.waitFor(() => expect(content()?.isContentEditable).toBe(true));

    await act(async () => store.removeReviewComment(threadRef, comment.id));
    await expect.element(screen.getByText("Removed from the composer")).not.toBeInTheDocument();

    const firstLine = shadowRoot()!.querySelector('[data-line="1"]')!;
    const caret = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT).nextNode()!;
    content()!.focus();
    const selectionSynced = new Promise((resolve) =>
      document.addEventListener("selectionchange", resolve, { once: true }),
    );
    document.getSelection()!.setBaseAndExtent(caret, 0, caret, 0);
    await selectionSynced;
    await act(async () => {
      content()!.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertParagraph",
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    });
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe(`\n${contents}`));

    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.reviewComments ?? []).toEqual([]);
    expect(screen.getByText("Removed from the composer").query()).toBeNull();
  });

  it("deleting a commented line removes its comment instead of moving it", async () => {
    using _settings = setup();
    const contents = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    state.file = {
      relativePath: "config.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const store = useComposerDraftStore.getState();
    const comment = buildFileReviewComment({
      id: "file-comment-deleted-line",
      filePath: "config.ts",
      startLine: 2,
      endLine: 2,
      text: "This is about b",
      contents,
    });
    store.addReviewComment(threadRef, comment);
    using _comment = { [Symbol.dispose]: () => store.removeReviewComment(threadRef, comment.id) };

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("This is about b")).toBeVisible();
    const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
    const content = () => shadowRoot()?.querySelector<HTMLElement>("[data-content]");
    await vi.waitFor(() => expect(content()?.isContentEditable).toBe(true));
    const firstText = (lineNumber: number) =>
      document
        .createTreeWalker(
          shadowRoot()!.querySelector(`[data-line="${lineNumber}"]`)!,
          NodeFilter.SHOW_TEXT,
        )
        .nextNode()!;
    const input = (inputType: string, data: string | null = null) =>
      act(async () => {
        content()!.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType,
            data,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      });

    content()!.focus();
    const selectionSynced = new Promise((resolve) =>
      document.addEventListener("selectionchange", resolve, { once: true }),
    );
    document.getSelection()!.setBaseAndExtent(firstText(2), 0, firstText(3), 0);
    await selectionSynced;
    await input("deleteContentBackward");
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe("const a = 1;\nconst c = 3;\n"));
    await expect.element(screen.getByText("This is about b")).not.toBeInTheDocument();
    // The caret stays at the start of the line that moved up.
    await input("insertText", "x");
    await vi.waitFor(() =>
      expect(state.optimistic?.contents).toBe("const a = 1;\nxconst c = 3;\n"),
    );

    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.reviewComments ?? []).toEqual([]);
    expect(screen.getByText("This is about b").query()).toBeNull();
  });

  it("keeps a linked line revealed when the thread changes under the file view", async () => {
    using _settings = setup();
    const contents = Array.from(
      { length: 400 },
      (_, index) => `export const line${index + 1} = ${index + 1};`,
    ).join("\n");
    state.file = {
      relativePath: "long.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const otherThreadRef = { environmentId, threadId: ThreadId.make("other-thread") };

    // Tailwind is not loaded in browser tests; give the scroller a height so it can scroll.
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = ".file-preview-virtualizer { height: 300px; overflow: auto; }";
    using _style = { [Symbol.dispose]: () => style.remove() };

    await using screen = await render(filePreview("long.ts", threadRef, 200));
    const lineVisible = (lineNumber: number) => {
      const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer");
      const line = screen.container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector(`[data-line="${lineNumber}"]`);
      if (!scroller || !line) return false;
      const viewport = scroller.getBoundingClientRect();
      const row = line.getBoundingClientRect();
      return row.top >= viewport.top && row.bottom <= viewport.bottom;
    };
    await vi.waitFor(() => expect(lineVisible(200), "revealed on mount").toBe(true));

    await screen.rerender(filePreview("long.ts", otherThreadRef, 200));

    await vi.waitFor(() => expect(lineVisible(200), "revealed after the thread change").toBe(true));
  });
});
