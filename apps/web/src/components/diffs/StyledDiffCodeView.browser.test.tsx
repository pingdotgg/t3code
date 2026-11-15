import type { CodeViewHandle } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { createRef, useState, type Ref, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: (() => "dark") as never,
}));

import { buildFileDiffEntries, getRenderablePatch } from "../../lib/diffRendering";
import { getDiffHeaderClickAction } from "./diffHeaderClick";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

/** Records each worker pool's initialization so the test can wait for highlighting. */
function captureWorkerPools() {
  const pools = new Map<WorkerPoolManager, Promise<void>>();
  const initialize = WorkerPoolManager.prototype.initialize;
  const spy = vi.spyOn(WorkerPoolManager.prototype, "initialize").mockImplementation(function (
    this: WorkerPoolManager,
    ...args
  ) {
    const pending = initialize.apply(this, args);
    pools.set(this, pending);
    return pending;
  });
  return { pools, [Symbol.dispose]: () => spy.mockRestore() };
}

// Exercises the production click helper against Pierre's real shadow DOM.
function RepeatedDiffs({
  entries,
  viewerRef,
  onOpen,
}: {
  entries: ReturnType<typeof buildFileDiffEntries>;
  viewerRef: Ref<CodeViewHandle<undefined, undefined>>;
  onOpen: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div
      onClickCapture={(event) => {
        const action = getDiffHeaderClickAction(event.nativeEvent);
        if (action?.type === "open") onOpen(action.filePath);
        else if (action?.type === "toggle") toggle(action.fileKey);
      }}
    >
      <StyledDiffCodeView
        viewerRef={viewerRef}
        className="h-[600px] w-[800px]"
        items={entries.map(({ fileDiff, fileKey, fileVersion }) => ({
          type: "diff",
          id: fileKey,
          fileDiff,
          version: fileVersion + Number(collapsed.has(fileKey)),
          collapsed: collapsed.has(fileKey),
        }))}
        options={{ theme: "pierre-dark", diffStyle: "unified" }}
        renderHeaderPrefix={(item) => (
          <button data-diff-file-key={item.id} onClick={() => toggle(item.id)}>
            Chevron
          </button>
        )}
      />
    </div>
  );
}

describe("repeated diff blocks", () => {
  it("renders every repeated block and collapses only the clicked one", async () => {
    const parsed = getRenderablePatch(
      ["first", "second", "second"]
        .map((content) =>
          [
            "diff --git a/same.ts b/same.ts",
            "--- a/same.ts",
            "+++ b/same.ts",
            "@@ -1 +1 @@",
            "-before",
            `+${content}`,
            "",
          ].join("\n"),
        )
        .join(""),
    );
    if (parsed?.kind !== "files") throw new Error("Expected file diffs");
    using captured = captureWorkerPools();
    const { pools } = captured;
    const entries = buildFileDiffEntries(parsed.files);
    const onOpen = vi.fn();
    let viewer: CodeViewHandle<undefined, undefined> | null = null;
    await using _screen = await render(
      <RepeatedDiffs
        entries={entries}
        viewerRef={(value) => {
          viewer = value;
        }}
        onOpen={onOpen}
      />,
      // This viewer fixture does not navigate or read router state.
      { router: false },
    );
    const pool = [...pools.keys()][0]!;
    await act(async () => {
      await pools.get(pool);
      await Promise.all(parsed.files.map((file) => pool.primeDiffHighlightCache(file)));
    });
    const flush = () => act(async () => viewer?.getInstance()?.render(true));
    await flush();
    const blocks = () => [...document.querySelectorAll("diffs-container")];
    const body = (index: number) => blocks()[index]!.shadowRoot!.querySelector("[data-diff]");
    const click = async (element: Element) => {
      await act(async () =>
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })),
      );
      await flush();
    };
    const expectExpanded = async (expanded: boolean[]) => {
      await vi.waitFor(() => {
        expect(blocks()).toHaveLength(3);
        expect(blocks().map((_, index) => body(index) !== null)).toEqual(expanded);
      });
    };
    await expectExpanded([true, true, true]);
    await vi.waitFor(() => {
      expect(body(0)?.textContent).toContain("first");
      expect(body(1)?.textContent).toContain("second");
      expect(body(2)?.textContent).toContain("second");
    });

    await click(blocks()[1]!.shadowRoot!.querySelector("[data-diffs-header]")!);
    await expectExpanded([true, false, true]);
    await click(blocks()[1]!.shadowRoot!.querySelector("[data-title] bdi")!);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("same.ts");
    await expectExpanded([true, false, true]);
    await click(blocks()[1]!.querySelector("button")!);
    await expectExpanded([true, true, true]);
    await click(blocks()[0]!.shadowRoot!.querySelector("[data-diffs-header]")!);
    await expectExpanded([false, true, true]);
  });
});

const LINE_COUNT = 2_000;
const lines = Array.from({ length: LINE_COUNT }, (_, index) => `line ${index + 1}`);
const fileDiff = parsePatchFiles(
  [
    "diff --git a/big.sql b/big.sql",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/big.sql",
    `@@ -0,0 +1,${LINE_COUNT} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n"),
)[0]!.files[0]!;

function copy(): string {
  const clipboardData = new DataTransfer();
  document.body.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
  );
  return clipboardData.getData("text/plain");
}

function renderBigFile(viewerRef: Ref<CodeViewHandle<undefined, undefined>>) {
  const container = document.createElement("div");
  container.style.cssText = "display: flex; width: 800px; height: 300px;";
  return render(
    <StyledDiffCodeView
      viewerRef={viewerRef}
      style={{ width: "100%", height: "100%", overflow: "auto" }}
      items={[{ id: "big", type: "diff", fileDiff }]}
    />,
    { container },
  );
}

async function waitForRows(viewerRef: RefObject<CodeViewHandle<undefined, undefined> | null>) {
  const renderedItem = () => viewerRef.current?.getInstance()?.getRenderedItems()[0]?.element;
  await vi.waitFor(
    () =>
      expect(renderedItem()?.shadowRoot?.querySelectorAll("[data-line]").length).toBeGreaterThan(0),
    { timeout: 10_000 },
  );
  return renderedItem;
}

describe("StyledDiffCodeView", () => {
  it("copies every line of a file after select all, including rows the virtualizer dropped", async () => {
    const viewerRef = createRef<CodeViewHandle<undefined, undefined>>();
    await using _screen = await renderBigFile(viewerRef);
    const renderedItem = await waitForRows(viewerRef);
    const rows = renderedItem()!.shadowRoot!.querySelectorAll("[data-line]");
    expect(rows.length).toBeLessThan(LINE_COUNT);

    renderedItem()!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, composed: true }),
    );
    const azertyQuit = new KeyboardEvent("keydown", {
      key: "q",
      code: "KeyA",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(azertyQuit);
    expect(azertyQuit.defaultPrevented).toBe(false);
    expect(copy()).toBe("");

    const selectAll = new KeyboardEvent("keydown", {
      key: "ф",
      code: "KeyA",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(selectAll);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "с", code: "KeyC", metaKey: true, bubbles: true }),
    );

    expect(selectAll.defaultPrevented).toBe(true);
    expect(copy()).toBe(lines.join("\n"));

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(copy()).toBe("");
  });

  it("copies a dragged range after scrolling unmounts its rows, following the drag past them", async () => {
    const viewerRef = createRef<CodeViewHandle<undefined, undefined>>();
    await using _screen = await renderBigFile(viewerRef);
    const renderedItem = await waitForRows(viewerRef);
    const row = (line: number) =>
      renderedItem()!.shadowRoot!.querySelector(`[data-line="${line}"]`);
    const first = row(1)!;
    const mounted = renderedItem()!.shadowRoot!.querySelectorAll("[data-line]");
    const last = mounted[mounted.length - 1]!;
    const lastLine = Number(last.getAttribute("data-line"));

    first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    const selected = new Promise((resolve) =>
      document.addEventListener("selectionchange", resolve, { once: true }),
    );
    document.getSelection()!.setBaseAndExtent(first, 0, last, last.childNodes.length);
    await selected;

    const scroller = renderedItem()!.closest(".diff-render-surface")!;
    const scrollTo = async (top: number, unmounted: number) => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
      await vi.waitFor(() => expect(row(unmounted)).toBeNull());
    };
    await scrollTo(first.getBoundingClientRect().height * 100, 1);
    expect(copy()).toBe(lines.slice(0, lastLine).join("\n"));

    // Autoscroll keeps moving the focus after the anchor's row unmounted.
    const later = renderedItem()!.shadowRoot!.querySelectorAll("[data-line]");
    const focus = later[later.length - 1]!;
    const focusLine = Number(focus.getAttribute("data-line"));
    const extended = new Promise((resolve) =>
      document.addEventListener("selectionchange", resolve, { once: true }),
    );
    document.getSelection()!.extend(focus, focus.childNodes.length);
    await extended;
    await scrollTo(scroller.scrollHeight, focusLine);

    expect(focusLine).toBeGreaterThan(lastLine);
    expect(copy()).toBe(lines.slice(0, focusLine).join("\n"));
  });
});
