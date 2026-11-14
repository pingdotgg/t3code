import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
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

// The browser ignores a copy event's data unless the event is cancelled, and copies the selection itself.
function copiedText(target: Element) {
  const clipboardData = new DataTransfer();
  const handled = !target.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true, composed: true }),
  );
  return handled ? clipboardData.getData("text/plain") : null;
}

describe("ReadOnlySourcePreview", () => {
  it("copies the whole file after Select All, wherever the preview is scrolled", async () => {
    // File paints nothing until the shared highlighter has loaded; once it has, mount renders synchronously.
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
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

    document.getSelection()!.removeAllRanges();
    await userEvent.click(rows()[rows().length - 1]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    // A selection that stops inside the mounted rows at either end stays the browser's to copy.
    const pre = root.querySelector("pre")!;
    const firstText = rows()[0]!.querySelector("span")!.firstChild!;
    const lastText = rows()[rows().length - 1]!.querySelector("span")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(pre, 0, lastText, 4);
    expect(copiedText(rows()[0]!)).toBeNull();
    document.getSelection()!.setBaseAndExtent(firstText, 4, pre, pre.childNodes.length);
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  it.each([
    ["a lone carriage return", "\r"],
    ["a carriage return and line feed", "\r\n"],
  ])("copies the whole of a file whose lines end in %s", async (_name, ending) => {
    const contents = text.replaceAll("\n", ending);
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={contents} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toBe(contents);
  });

  it("copies a partial selection after its rows scroll out of the mounted window", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    const rowText = (line: number) =>
      [...rows()].find((row) => row.textContent === `line ${line}`)!.querySelector("span")!
        .firstChild!;
    document.getSelection()!.setBaseAndExtent(rowText(5), 0, rowText(20), "line 20".length);
    const selected = Array.from({ length: 16 }, (_, index) => `line ${index + 5}`).join("\n");

    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    scroller.scrollTop = 0;
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    expect(copiedText(rows()[0]!) ?? document.getSelection()!.toString()).toBe(selected);
  });

  it("drops a selection scrolled out of the mounted window when a click lands on its edge", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    const rowText = (index: number) => rows()[index]!.querySelector("span")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(rowText(4), 0, rowText(19), 4);
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toContain("line 5\n");

    // The first mounted row is where the scrolled-out selection is parked, far above the viewport.
    rows()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    document.getSelection()!.collapse(rowText(0), 0);
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  it("copies a drag that autoscrolls past the edge of the preview", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    const start = rows()[4]!.querySelector("span")!.getBoundingClientRect();
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    const edge = scroller.getBoundingClientRect().bottom;
    const frame = window.frameElement?.getBoundingClientRect();
    const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
      cdp().send("Input.dispatchMouseEvent", {
        type,
        x: x + (frame?.left ?? 0),
        y: y + (frame?.top ?? 0),
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });
    await mouse("mousePressed", start.left + 1, start.top + 5);
    await mouse("mouseMoved", start.left + 30, edge - 5);
    // Held below the preview, the pointer is over no row while the browser scrolls the drag on.
    await mouse("mouseMoved", start.left + 30, edge + 60);
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"), { timeout: 10_000 });
    await mouse("mouseReleased", start.left + 30, edge + 60);

    const copied = copiedText(rows()[0]!)!;
    const from = text.indexOf("line 5\n");
    expect(copied).toBe(text.slice(from, from + copied.length));
    // The drag ends in the rows on screen, short of the last mounted one.
    const lastLine = 4 + copied.split("\n").length;
    expect(lastLine).toBeGreaterThan(50);
    expect(lastLine).toBeLessThan(Number(rows()[rows().length - 1]!.getAttribute("data-line")));
  });

  it("extends a selection with Shift+click after its anchor scrolls out of the mounted window", async () => {
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    await userEvent.click(rows()[2]!.querySelector("span")!, { position: { x: 1, y: 5 } });
    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    await userEvent.click(rows()[rows().length - 1]!.querySelector("span")!, {
      position: { x: 1, y: 5 },
      modifiers: ["Shift"],
    });

    const clicked = document.getSelection()!.getComposedRanges({ shadowRoots: [root] })[0]!;
    const lastLine = clicked.endContainer.textContent!;
    expect(Number(lastLine.replace("line ", ""))).toBeGreaterThan(250);
    expect(copiedText(rows()[0]!)).toBe(
      text.slice(text.indexOf("line 3\n"), text.indexOf(`${lastLine}\n`)),
    );
  });
});
