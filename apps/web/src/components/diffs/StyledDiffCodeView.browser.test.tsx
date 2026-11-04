import type { CodeViewHandle } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { useState, type Ref } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: (() => "dark") as never,
}));

import { toggleAllDiffFiles } from "../../lib/diffCollapse";
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

// This capture host exercises the production helper against Pierre's real shadow DOM.
// DiffPanel's routing, open-file service and collapse-all wiring need app integration coverage.
function RepeatedDiffs({
  entries,
  viewerRef,
  onOpen,
  onLink,
}: {
  entries: ReturnType<typeof buildFileDiffEntries>;
  viewerRef: Ref<CodeViewHandle<undefined, undefined>>;
  onOpen: (path: string) => void;
  onLink: () => void;
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
      <button
        data-toggle-all
        onClick={() =>
          setCollapsed((current) =>
            toggleAllDiffFiles(
              entries.map((entry) => entry.fileKey),
              current,
            ),
          )
        }
      >
        Toggle all
      </button>
      <StyledDiffCodeView
        viewerRef={viewerRef}
        style={{ height: 600, width: 800 }}
        items={entries.map(({ fileDiff, fileKey, fileVersion }) => ({
          type: "diff",
          id: fileKey,
          fileDiff,
          version: fileVersion + Number(collapsed.has(fileKey)),
          collapsed: collapsed.has(fileKey),
        }))}
        options={{ theme: "pierre-dark", diffStyle: "unified" }}
        renderHeaderPrefix={(item) => (
          <>
            <button data-diff-file-key={item.id} onClick={() => toggle(item.id)}>
              Chevron
            </button>
            <a
              href="#action"
              onClick={(event) => {
                event.preventDefault();
                onLink();
              }}
            >
              Action
            </a>
          </>
        )}
      />
    </div>
  );
}

describe("repeated diff blocks", () => {
  it("renders every repeated block and gives header, filename and controls their own actions", async () => {
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
    const onLink = vi.fn();
    let viewer: CodeViewHandle<undefined, undefined> | null = null;
    await using _screen = await render(
      <RepeatedDiffs
        entries={entries}
        viewerRef={(value) => {
          viewer = value;
        }}
        onOpen={onOpen}
        onLink={onLink}
      />,
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
    const expectExpanded = (expanded: boolean[]) => {
      expect(blocks()).toHaveLength(3);
      expect(blocks().map((_, index) => body(index) !== null)).toEqual(expanded);
    };
    expectExpanded([true, true, true]);
    expect(body(0)?.textContent).toContain("first");
    expect(body(1)?.textContent).toContain("second");
    expect(body(2)?.textContent).toContain("second");

    await click(blocks()[1]!.shadowRoot!.querySelector("[data-diffs-header]")!);
    expectExpanded([true, false, true]);
    await click(blocks()[1]!.shadowRoot!.querySelector("[data-title] bdi")!);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("same.ts");
    expectExpanded([true, false, true]);
    await click(blocks()[1]!.querySelector("button")!);
    expectExpanded([true, true, true]);
    await click(blocks()[1]!.querySelector("a")!);
    expect(onLink).toHaveBeenCalledOnce();
    await click(body(1)!);
    expectExpanded([true, true, true]);
    await click(blocks()[0]!.shadowRoot!.querySelector("[data-diffs-header]")!);
    expectExpanded([false, true, true]);
    await click(document.querySelector("[data-toggle-all]")!);
    expectExpanded([false, false, false]);
    await click(document.querySelector("[data-toggle-all]")!);
    expectExpanded([true, true, true]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
