import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { dragSelectWhileScrolling } from "../../../test/dragSelection";
import { render } from "../../../test/render";

import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

// The pool starts its workers before showing any code, which can outlast a cold CI browser.
vi.mock(import("~/components/DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { StyledDiffCodeView } from "./StyledDiffCodeView";

const LINE_COUNT = 300;
const lines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
const fileDiff = parsePatchFiles(
  [
    "diff --git a/notes.txt b/notes.txt",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    `@@ -1,${LINE_COUNT} +1,${LINE_COUNT} @@`,
    ...lines("-old", LINE_COUNT),
    ...lines("+new", LINE_COUNT),
    "",
  ].join("\n"),
  { cacheKeyPrefix: "selection-copy" },
)[0]!.files[0]!;

// The browser ignores a copy event's data unless the event is cancelled, and copies the selection itself.
function copiedText(target: Element) {
  const clipboardData = new DataTransfer();
  const handled = !target.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true, composed: true }),
  );
  return handled ? clipboardData.getData("text/plain") : null;
}

describe("StyledDiffCodeView", () => {
  it.each([
    { diffStyle: "unified", column: "unified", prefix: "old" },
    { diffStyle: "split", column: "additions", prefix: "new" },
  ] as const)(
    "keeps a $diffStyle selection whose rows scroll out of the render window",
    async ({ diffStyle, column, prefix }) => {
      await getSyntaxHighlighterPromise("text");
      await using screen = await render(
        <div className="flex h-[400px] flex-col">
          <StyledDiffCodeView
            items={[{ id: "notes", type: "diff", fileDiff }]}
            options={{ diffStyle }}
            className="min-h-0 flex-1 overflow-auto"
          />
        </div>,
      );
      const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
      const rows = () => root.querySelectorAll(`code[data-${column}] [data-line]`);
      await vi.waitFor(() => expect(rows()[0]?.textContent).toBe(`${prefix} 1`));

      // A drag from line 1 to line 20 of one side, then the viewer scrolls on while the button is held.
      const endText = rows()[19]!.lastChild!.firstChild!;
      const selected = new Promise((resolve) =>
        document.addEventListener("selectionchange", resolve, { once: true }),
      );
      document.getSelection()!.setBaseAndExtent(rows()[0]!, 0, endText, " 20".length);
      // A real drag reports its selection on every pointer move, before any row scrolls away.
      await selected;
      const scroller = screen.container.querySelector(".diff-render-surface")!;
      scroller.scrollTop = scroller.scrollHeight;
      await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe(`${prefix} 1`));

      expect(copiedText(rows()[0]!)).toBe(lines(prefix, 20).join("\n"));
    },
  );

  it("keeps the start of a drag that scrolls its first rows out of the render window", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <StyledDiffCodeView
          items={[{ id: "notes", type: "diff", fileDiff }]}
          options={{ diffStyle: "unified" }}
          className="min-h-0 flex-1 overflow-auto"
        />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("old 1"));

    await dragSelectWhileScrolling(
      screen.container.querySelector(".diff-render-surface")!,
      rows()[0]!,
      () => root.querySelector('[data-line][data-line-index^="209,"]') ?? undefined,
    );
    expect(rows()[0]?.textContent).not.toBe("old 1");

    expect(copiedText(rows()[0]!)).toBe(lines("old", 210).join("\n"));
  });
});
