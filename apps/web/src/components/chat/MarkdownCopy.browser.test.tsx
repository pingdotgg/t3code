import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownTable } from "./MarkdownTable";

// Insecure origins (a LAN or tailnet address over plain http) have no async clipboard.
function withoutAsyncClipboard() {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const execCommand = vi.spyOn(document, "execCommand").mockReturnValue(true);
  return {
    execCommand,
    [Symbol.dispose]() {
      execCommand.mockRestore();
      Reflect.deleteProperty(navigator, "clipboard");
      if (original) Object.defineProperty(Navigator.prototype, "clipboard", original);
    },
  };
}

describe("markdown copy without the async clipboard", () => {
  it("copies a code block through the execCommand fallback", async () => {
    await using screen = await render(
      <MarkdownCodeBlock
        code="echo hi"
        language="sh"
        fenceTitle={null}
        theme="light"
        isStreaming={false}
      >
        <pre>
          <code>echo hi</code>
        </pre>
      </MarkdownCodeBlock>,
      // The block renders no links and reads no route.
      { router: false },
    );
    using clipboard = withoutAsyncClipboard();

    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(clipboard.execCommand).toHaveBeenCalledWith("copy");
  });

  it("copies a table through the execCommand fallback", async () => {
    await using screen = await render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>Name</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ada</td>
          </tr>
        </tbody>
      </MarkdownTable>,
      // The table renders no links and reads no route.
      { router: false },
    );
    using clipboard = withoutAsyncClipboard();

    await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Copy as Markdown" }));
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(clipboard.execCommand).toHaveBeenCalledWith("copy");
  });
});

describe("copying a table as HTML", () => {
  it("writes the markup as plain text and as the rich HTML flavor", async () => {
    await using screen = await render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ textAlign: "right" }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ada &amp; co</td>
            <td style={{ textAlign: "right" }}>1,200</td>
          </tr>
          <tr>
            <td>
              first
              <br />
              second
            </td>
            <td>
              {/* The wrapper MarkdownMath renders around a formula. */}
              <span data-markdown-math="inline" data-markdown-copy="\(x^2\)">
                x²
              </span>
            </td>
          </tr>
          <tr>
            <td>zero</td>
            <td>garbage</td>
          </tr>
        </tbody>
      </MarkdownTable>,
      // The table renders no links and reads no route.
      { router: false },
    );
    // Raw span values, so the copy reads the DOM's own rowSpan/colSpan normalization.
    const sourceCell = (text: string) =>
      [...document.querySelectorAll("td")].find((cell) => cell.textContent === text);
    sourceCell("zero")?.setAttribute("rowspan", "0");
    sourceCell("garbage")?.setAttribute("colspan", "2garbage");
    sourceCell("Ada & co")?.setAttribute("rowspan", "-1");
    const items: ClipboardItem[] = [];
    const write = vi.spyOn(navigator.clipboard, "write").mockImplementation(async (data) => {
      items.push(...data);
    });

    try {
      await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Copy as HTML" }));
      await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

      const [item] = items;
      expect(item?.types).toEqual(["text/plain", "text/html"]);
      const markup = await (await item!.getType("text/plain")).text();
      expect(markup).toMatch(/^<table[\s>]/);
      expect(await (await item!.getType("text/html")).text()).toBe(
        `<meta charset="utf-8">${markup}`,
      );

      const pasted = new DOMParser().parseFromString(markup, "text/html").querySelector("table");
      const cells = [...(pasted?.querySelectorAll("th, td") ?? [])] as HTMLElement[];
      expect(cells.map((cell) => [cell.tagName, cell.innerHTML, cell.style.textAlign])).toEqual([
        ["TH", "Name", "left"],
        ["TH", "Amount", "right"],
        ["TD", "Ada &amp; co", ""],
        ["TD", "1,200", "right"],
        ["TD", "first<br>second", ""],
        ["TD", "\\(x^2\\)", ""],
        ["TD", "zero", ""],
        ["TD", "garbage", ""],
      ]);
      const span = (cell: HTMLElement | undefined) => [
        cell?.getAttribute("rowspan") ?? null,
        cell?.getAttribute("colspan") ?? null,
      ];
      // rowspan="0" runs to the section end, "2garbage" reads as 2, a negative span is dropped.
      expect([span(cells[6]), span(cells[7]), span(cells[2])]).toEqual([
        ["0", null],
        [null, "2"],
        [null, null],
      ]);
      // Fixed light colors: the copy reads the same whichever theme it came from.
      expect(cells[0]?.style.backgroundColor).toBe("rgb(246, 248, 250)");
      expect(cells[0]?.style.color).toBe("rgb(31, 35, 40)");
      expect(cells.every((cell) => cell.style.borderStyle === "solid")).toBe(true);
    } finally {
      write.mockRestore();
    }
  });
});
