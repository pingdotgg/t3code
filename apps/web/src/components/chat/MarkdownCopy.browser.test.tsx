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
      <div dir="rtl">
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
        </MarkdownTable>
      </div>,
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
      expect(pasted?.getAttribute("dir")).toBe("rtl");
      const cells = [...(pasted?.querySelectorAll("th, td") ?? [])] as HTMLElement[];
      expect(cells[0]?.style.textAlign).toBe("right");
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
    } finally {
      write.mockRestore();
    }
  });
});

describe("copying a table for chat apps", () => {
  it("writes aligned columns in a code fence, with a pre block for rich targets", async () => {
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
        </tbody>
      </MarkdownTable>,
      // The table renders no links and reads no route.
      { router: false },
    );
    const items: ClipboardItem[] = [];
    const write = vi.spyOn(navigator.clipboard, "write").mockImplementation(async (data) => {
      items.push(...data);
    });

    try {
      await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Copy for chat apps" }));
      await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

      const [item] = items;
      expect(item?.types).toEqual(["text/plain", "text/html"]);
      expect(await (await item!.getType("text/plain")).text()).toBe(
        "```\nName      Amount\n--------  ------\nAda & co   1,200\n```",
      );
      expect(await (await item!.getType("text/html")).text()).toBe(
        '<meta charset="utf-8"><pre>Name      Amount\n--------  ------\nAda &amp; co   1,200</pre>',
      );
    } finally {
      write.mockRestore();
    }
  });
});

describe("copying a table as PNG", () => {
  it("writes the drawn table as one image/png clipboard item", async () => {
    await using screen = await render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>Name</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ada</td>
            <td>11 Oct</td>
          </tr>
        </tbody>
      </MarkdownTable>,
      // The table renders no links and reads no route.
      { router: false },
    );
    const items: ClipboardItem[] = [];
    const write = vi.spyOn(navigator.clipboard, "write").mockImplementation(async (data) => {
      items.push(...data);
      // Settle the promised image as the browser would before the write resolves.
      await Promise.all(data.flatMap((item) => item.types.map((type) => item.getType(type))));
    });

    try {
      await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Copy as PNG" }));
      await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

      expect(items).toHaveLength(1);
      const [item] = items;
      expect(item?.types).toEqual(["image/png"]);
      const png = await item!.getType("image/png");
      expect(png.type).toBe("image/png");
      const table = screen.container.querySelector("table")!.getBoundingClientRect();
      const bitmap = await createImageBitmap(png);
      // The table plus a 16px margin on each side, at the screen's pixel density.
      expect(bitmap.width).toBe(Math.floor((table.width + 32) * devicePixelRatio));
      expect(bitmap.height).toBe(Math.floor((table.height + 32) * devicePixelRatio));
    } finally {
      write.mockRestore();
    }
  });
});
