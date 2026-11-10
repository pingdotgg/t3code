import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";

import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

// The pool starts its workers before showing any code, which can outlast a cold CI browser.
vi.mock(import("~/components/DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import ReadOnlySourcePreview from "./ReadOnlySourcePreview";

const LINE_COUNT = 301;
const text = `${Array.from({ length: LINE_COUNT }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

function copiedText(target: Element) {
  const clipboardData = new DataTransfer();
  target.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true, composed: true }),
  );
  return clipboardData.getData("text/plain");
}

describe("ReadOnlySourcePreview", () => {
  it("copies the whole file after Select All, wherever the preview is scrolled", async () => {
    // File paints nothing until the shared highlighter has loaded; once it has, mount renders synchronously.
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div style={{ display: "flex", flexDirection: "column", height: 400 }}>
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));
    // Only rows near the viewport are mounted, so the browser's own copy would stop there.
    expect(rows().length).toBeLessThan(LINE_COUNT);

    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toBe(text);

    // A selection that ends inside the mounted rows stays the browser's to copy.
    const firstText = rows()[0]!.querySelector("span")!.firstChild!;
    const lastText = rows()[rows().length - 1]!.querySelector("span")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(firstText, 0, lastText, 4);
    expect(copiedText(rows()[0]!)).toBe("");
  });
});
