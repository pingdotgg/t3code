import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownTable } from "./MarkdownTable";

// Insecure origins (a LAN or tailnet address over plain http) have no async clipboard.
function withoutAsyncClipboard(clipboard?: Partial<Clipboard>) {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  const copied = new DataTransfer();
  const execCommand = vi.spyOn(document, "execCommand").mockImplementation(() => {
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: copied, bubbles: true, cancelable: true }),
    );
    return true;
  });
  return {
    copied,
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

  it.each([
    ["no async clipboard", undefined],
    // Firefox before 127 has writeText but no ClipboardItem.
    ["writeText only", { writeText: () => Promise.resolve() }],
  ])("copies a table through the execCommand fallback with %s", async (_, asyncClipboard) => {
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
    using clipboard = withoutAsyncClipboard(asyncClipboard);

    await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Copy as rich text" }));
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(clipboard.execCommand).toHaveBeenCalledWith("copy");
    expect(clipboard.copied.getData("text/html")).toContain("<td>Ada</td>");
    expect(clipboard.copied.getData("text/plain")).toContain("| Name |");
  });
});

describe("table copy as rich text", () => {
  it("copies a table as rich text with an HTML table flavor", async () => {
    await using screen = await render(
      <MarkdownTable>
        <thead>
          <tr>
            <th>Name</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Ada
              <span data-markdown-math="inline" data-markdown-copy="$x^2$">
                x²
              </span>
              <svg aria-hidden="true" />
            </td>
          </tr>
        </tbody>
      </MarkdownTable>,
      // The table renders no links and reads no route.
      { router: false },
    );
    using write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();

    await userEvent.click(screen.getByRole("button", { name: "Copy table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Copy as rich text" }));
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    const [item] = write.mock.calls[0]![0];
    const html = await (await item!.getType("text/html")).text();
    const text = await (await item!.getType("text/plain")).text();
    expect(html).toContain('<table border="1">');
    expect(html).toContain("<code>$x^2$</code>");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("x²");
    expect(text).toContain("| Name |");
  });
});
