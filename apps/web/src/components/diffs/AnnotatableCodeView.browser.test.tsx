import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { createRef, StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileDiffContentVersion, buildFileDiffIdentityKey } from "~/lib/diffRendering";

import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./AnnotatableCodeView";

const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };

function file(
  name: string,
  type: FileDiffMetadata["type"] = "change",
  prevName?: string,
  contents = "new",
) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1,${contents.split("\n").length} @@\n-old\n+${contents}\n`,
    { cacheKeyPrefix: `${name}:${contents}` },
  )[0]!.files[0]!;
  fileDiff.type = type;
  if (prevName) fileDiff.prevName = prevName;
  return {
    fileDiff,
    filePath: name,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
    collapsed: false,
  };
}

function setup() {
  const reset = () => useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  reset();
  const container = document.createElement("div");
  Object.assign(container.style, { width: "800px", height: "400px", display: "grid" });
  const viewerRef = createRef<AnnotatableCodeViewHandle>();
  const view = (
    files: ReturnType<typeof file>[],
    codeViewKey = "initial",
    pendingFiles: FileDiffMetadata[] = [],
    isRefreshingDiff = false,
  ) => (
    <StrictMode>
      <AnnotatableCodeView
        viewerRef={viewerRef}
        className="h-full min-h-0 overflow-auto"
        codeViewKey={codeViewKey}
        files={files}
        pendingFiles={pendingFiles}
        isRefreshingDiff={isRefreshingDiff}
        sectionId="unstaged"
        sectionTitle="Uncommitted"
        composerDraftTarget={target}
        options={{}}
        renderHeaderFilenameSuffix={() => null}
        renderHeaderPrefix={() => null}
        onRevealSearchMatch={() => {}}
      />
    </StrictMode>
  );
  const renderedFile = () => {
    const item = viewerRef.current?.getInstance()?.getRenderedItems()[0];
    if (item?.type !== "diff") throw new Error("Diff is not rendered");
    return item;
  };
  const select = () =>
    act(() => {
      // Invoke Pierre's own wrappers, which resolve their context from the latest item.
      const { instance } = renderedFile();
      instance.options.onLineSelectionChange?.(range);
      instance.options.onGutterUtilityClick?.(range);
    });
  const editor = () => {
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Comment editor is not available");
    return textarea;
  };
  const click = (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === label,
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    return act(() => button.click());
  };
  const typeComment = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        editor(),
        text,
      );
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
  return {
    container,
    viewerRef,
    view,
    renderedFile,
    select,
    editor,
    click,
    typeComment,
    [Symbol.dispose]: reset,
  };
}

describe("diff comment drafts", () => {
  it("keeps the text and selected line through refresh and a provisional lazy patch", async () => {
    using test = setup();
    const original = file("shared.ts", "rename-pure", "old.ts");
    await using screen = await render(test.view([original]), { container: test.container });
    await expect.element(screen.getByText("new", { exact: true })).toBeVisible();
    expect(test.renderedFile().instance.getLineIndex(1)).toBeDefined();
    await test.select();
    await vi.waitFor(() => expect(test.editor().value).toBe(""));
    await test.typeComment("Keep this draft");
    const refreshed = file("shared.ts", "rename-pure", "old.ts");
    await screen.rerender(test.view([refreshed], "refreshed", [], true));
    await vi.waitFor(() => expect(test.editor().value).toBe("Keep this draft"));
    expect(test.viewerRef.current?.getSelectedLines()).toEqual(
      expect.objectContaining({ id: original.fileKey, range }),
    );
    await test.click("Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments ?? []).toEqual(
      [],
    );
    await act(() => {
      test
        .editor()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
        );
    });
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments ?? []).toEqual(
      [],
    );
    expect(test.editor().value).toBe("Keep this draft");

    await screen.rerender(
      test.view([], "loading", [
        { ...refreshed.fileDiff, type: "rename-changed", hunks: [], cacheKey: "shared:pending" },
      ]),
    );
    expect(test.container.querySelector("textarea")).toBeNull();
    await screen.rerender(test.view([refreshed], "loaded"));
    await vi.waitFor(() => expect(test.editor().value).toBe("Keep this draft"));
    expect(test.viewerRef.current?.getSelectedLines()).toEqual(
      expect.objectContaining({ id: original.fileKey, range }),
    );
    await test.click("Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        filePath: "shared.ts",
        text: "Keep this draft",
        selection: { ...range, endSide: "additions" },
      }),
    ]);
  });

  it("rejects old line ranges and retained submission until Pierre adopts refreshed content", async () => {
    using test = setup();
    const original = file("adoption.ts");
    const refreshed = file("adoption.ts", "change", undefined, "inserted\n+new");
    const highlight = WorkerPoolManager.prototype.highlightDiffAST;
    let resumeHighlight: (() => void) | undefined;
    let pool: WorkerPoolManager | undefined;
    using _highlight = vi
      .spyOn(WorkerPoolManager.prototype, "highlightDiffAST")
      .mockImplementation(function (this: WorkerPoolManager, instance, diff) {
        pool = this;
        if (diff === refreshed.fileDiff) {
          resumeHighlight = () => highlight.call(this, instance, diff);
          return;
        }
        return highlight.call(this, instance, diff);
      });
    await using screen = await render(test.view([original]), { container: test.container });
    await expect.element(screen.getByText("new", { exact: true })).toBeVisible();
    const initialPool = pool;
    if (!initialPool) throw new Error("Diff worker pool is unavailable");
    await act(() => initialPool.primeDiffHighlightCache(original.fileDiff));
    expect(initialPool.getDiffResultCache(original.fileDiff)).toBeDefined();
    expect(test.renderedFile().instance.getLineIndex(1)).toBeDefined();
    await act(() => test.viewerRef.current?.getInstance()?.render(true));
    await test.select();
    await vi.waitFor(() => expect(test.editor().value).toBe(""));
    await test.typeComment("Old coordinates");
    const retainedSubmit = Array.from(test.container.querySelectorAll("button")).find(
      (node) => node.textContent === "Comment",
    )!;
    const previousInstance = test.renderedFile().instance;

    await screen.rerender(test.view([refreshed]));
    await vi.waitFor(() => expect(resumeHighlight).toBeDefined());
    const pending = test.renderedFile();
    expect(pending.item.fileDiff).toBe(refreshed.fileDiff);
    expect(pending.instance).toBe(previousInstance);
    expect(pending.element.shadowRoot?.textContent).not.toContain("inserted");
    expect(retainedSubmit.isConnected).toBe(true);
    expect(
      pending.instance.__getNextRenderData({
        fileDiff: refreshed.fileDiff,
        lineAnnotations: undefined,
      }).fileDiff,
    ).toBe(original.fileDiff);
    await test.typeComment("Still visible old draft");
    expect(retainedSubmit.disabled).toBe(false);
    await act(() => retainedSubmit.click());
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments ?? []).toEqual(
      [],
    );
    await test.select();
    expect(test.viewerRef.current?.getSelectedLines()).toBeNull();

    await act(() => resumeHighlight?.());
    await vi.waitFor(() => {
      expect(
        test.renderedFile().instance.__getNextRenderData({
          fileDiff: refreshed.fileDiff,
          lineAnnotations: undefined,
        }).fileDiff,
      ).toBe(refreshed.fileDiff);
      expect(test.renderedFile().element.shadowRoot?.textContent).toContain("inserted");
      expect(test.container.querySelector("textarea")).toBeNull();
    });
    await test.select();
    await vi.waitFor(() => expect(test.editor().value).toBe(""));
    await test.typeComment("Current coordinates");
    await test.click("Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        text: "Current coordinates",
        diff: expect.stringContaining("+inserted"),
      }),
    ]);
  });
});
