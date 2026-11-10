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

function seedFile(relativePath: string, contents: string) {
  state.file = { relativePath, contents, byteLength: contents.length, truncated: false };
}

function storeComment(
  target: typeof threadRef,
  input: { id: string; line: number; text: string; contents: string },
) {
  const comment = buildFileReviewComment({
    id: input.id,
    filePath: "config.ts",
    startLine: input.line,
    endLine: input.line,
    text: input.text,
    contents: input.contents,
  });
  const store = useComposerDraftStore.getState();
  store.addReviewComment(target, comment);
  return { comment, [Symbol.dispose]: () => store.removeReviewComment(target, comment.id) };
}

function fileEditor(container: HTMLElement) {
  const shadowRoot = () => container.querySelector("diffs-container")?.shadowRoot;
  const content = () => shadowRoot()?.querySelector<HTMLElement>("[data-content]");
  const lineStart = (lineNumber: number) =>
    document
      .createTreeWalker(
        shadowRoot()!.querySelector(`[data-line="${lineNumber}"]`)!,
        NodeFilter.SHOW_TEXT,
      )
      .nextNode()!;
  const dispatch = (event: Event) => act(async () => content()!.dispatchEvent(event));
  const isMac = isMacPlatform(navigator.platform);
  return {
    ready: () => vi.waitFor(() => expect(content()?.isContentEditable).toBe(true)),
    select: async (fromLine: number, toLine = fromLine) => {
      content()!.focus();
      const selectionSynced = new Promise((resolve) =>
        document.addEventListener("selectionchange", resolve, { once: true }),
      );
      document.getSelection()!.setBaseAndExtent(lineStart(fromLine), 0, lineStart(toLine), 0);
      await selectionSynced;
    },
    input: (inputType: string, data: string | null = null) =>
      dispatch(
        new InputEvent("beforeinput", {
          inputType,
          data,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      ),
    undo: () =>
      dispatch(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      ),
  };
}

describe("file view comments", () => {
  const contents = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

  it("shows a comment already in the composer draft when the file view mounts", async () => {
    using _settings = setup();
    seedFile("config.ts", contents);
    using _comment = storeComment(threadRef, { id: "c1", line: 2, text: "About b", contents });

    await using screen = await render(filePreview("config.ts"));

    const inlineComment = screen.getByText("About b");
    await expect.element(inlineComment).toBeVisible();
    expect(inlineComment.element().closest("[slot]")?.getAttribute("slot")).toBe("annotation-2");
  });

  it("shows only the current thread's comments when the thread changes", async () => {
    using _settings = setup();
    seedFile("config.ts", contents);
    const otherThreadRef = { environmentId, threadId: ThreadId.make("other-thread") };
    using _a = storeComment(threadRef, { id: "a", line: 1, text: "From thread A", contents });
    using _b = storeComment(otherThreadRef, { id: "b", line: 2, text: "From thread B", contents });

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("From thread A")).toBeVisible();

    await screen.rerender(filePreview("config.ts", otherThreadRef));

    await expect.element(screen.getByText("From thread B")).toBeVisible();
    expect(screen.getByText("From thread A").query()).toBeNull();
  });

  it("drops a comment removed from the composer and does not re-add it on the next edit", async () => {
    using _settings = setup();
    seedFile("config.ts", contents);
    using stored = storeComment(threadRef, { id: "gone", line: 2, text: "Removed", contents });

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("Removed")).toBeVisible();
    const editor = fileEditor(screen.container);
    await editor.ready();

    await act(async () =>
      useComposerDraftStore.getState().removeReviewComment(threadRef, stored.comment.id),
    );
    await expect.element(screen.getByText("Removed")).not.toBeInTheDocument();

    await editor.select(1);
    await editor.input("insertParagraph");
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe(`\n${contents}`));

    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.reviewComments ?? []).toEqual([]);
    expect(screen.getByText("Removed").query()).toBeNull();
  });

  it("deleting a commented line keeps its stored comment, and Undo shows it again", async () => {
    using _settings = setup();
    seedFile("config.ts", contents);
    using stored = storeComment(threadRef, { id: "c1", line: 2, text: "About b", contents });
    const storedComment = () =>
      useComposerDraftStore
        .getState()
        .getComposerDraft(threadRef)
        ?.reviewComments.find(({ id }) => id === stored.comment.id);

    await using screen = await render(filePreview("config.ts"));
    await expect.element(screen.getByText("About b")).toBeVisible();
    const editor = fileEditor(screen.container);
    await editor.ready();

    await editor.select(2, 3);
    await editor.input("deleteContentBackward");
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe("const a = 1;\nconst c = 3;\n"));
    await expect.element(screen.getByText("About b")).not.toBeInTheDocument();
    // The caret stays at the start of the line that moved up.
    await editor.input("insertText", "x");
    await vi.waitFor(() =>
      expect(state.optimistic?.contents).toBe("const a = 1;\nxconst c = 3;\n"),
    );
    expect(screen.getByText("About b").query()).toBeNull();
    expect(storedComment()).toEqual(stored.comment);

    await editor.undo();
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe("const a = 1;\nconst c = 3;\n"));
    await editor.undo();
    await vi.waitFor(() => expect(state.optimistic?.contents).toBe(contents));
    await expect.element(screen.getByText("About b")).toBeVisible();
    expect(storedComment()).toEqual(stored.comment);
  });

  it("reveals the linked line again when the thread changes under the file view", async () => {
    using _settings = setup();
    seedFile(
      "long.ts",
      Array.from({ length: 400 }, (_, index) => `export const line${index + 1} = ${index};`).join(
        "\n",
      ),
    );
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
