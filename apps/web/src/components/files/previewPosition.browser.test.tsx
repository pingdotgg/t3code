import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import appCss from "~/index.css?inline";
import NotebookPreview from "./NotebookPreview";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";
import { PreviewPositionKey } from "./previewPosition";
import VirtualTablePreview from "./VirtualTablePreview";

function withAppCss() {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

function opened(positionKey: string, children: ReactNode) {
  return (
    <PreviewPositionKey value={positionKey}>
      <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </PreviewPositionKey>
  );
}

describe("large text scroll position", () => {
  const log = (count: number) => (
    <VirtualTablePreview
      name="app.log"
      count={count}
      columns={1}
      source
      getRows={(page) =>
        Array.from({ length: PREVIEW_PAGE_ROWS }, (_, row) => [
          `entry ${page * PREVIEW_PAGE_ROWS + row + 1}`,
        ])
      }
    />
  );
  const scroller = () =>
    document
      .querySelector<HTMLElement>("[data-preview-row]")
      ?.closest<HTMLElement>(".overflow-auto") ?? expect.unreachable();
  const firstVisibleRow = () => {
    const top = scroller().getBoundingClientRect().top;
    const row = Array.from(scroller().querySelectorAll<HTMLElement>("[data-preview-row]")).find(
      (node) => node.getBoundingClientRect().bottom > top + 1,
    );
    return Number(row?.dataset.previewRow);
  };

  it("returns a reopened log to its line, once that line has streamed in", async () => {
    using _style = withAppCss();
    let saved: number;
    {
      await using _screen = await render(opened("app.log", log(5000)));
      await vi.waitFor(() => expect(firstVisibleRow()).toBe(0));
      scroller().scrollTop = 1000 * 29;
      scroller().dispatchEvent(new Event("scroll"));
      await vi.waitFor(() => expect(firstVisibleRow()).toBeGreaterThan(900));
      saved = firstVisibleRow();
    }
    {
      await using _screen = await render(opened("other.log", log(5000)));
      await vi.waitFor(() => expect(firstVisibleRow(), "another file opens at the top").toBe(0));
    }
    await using screen = await render(opened("app.log", log(100)));
    await vi.waitFor(() => expect(firstVisibleRow()).toBe(0));
    await screen.rerender(opened("app.log", log(5000)));
    await vi.waitFor(() => expect(firstVisibleRow()).toBe(saved));
  });
});

describe("notebook scroll position", () => {
  const notebook = (
    <NotebookPreview
      notebook={{
        type: "notebook",
        language: "python",
        cells: Array.from({ length: 40 }, (_, index) => ({
          kind: "raw" as const,
          source: Array.from({ length: 8 }, (_, line) => `cell ${index} line ${line}`).join("\n"),
          outputs: [],
        })),
      }}
    />
  );
  const scroller = () =>
    document.querySelector<HTMLElement>("section")?.closest<HTMLElement>(".overflow-auto") ??
    expect.unreachable();
  const readingPosition = () => {
    const top = scroller().getBoundingClientRect().top;
    const cells = Array.from(scroller().querySelectorAll("section"));
    const cell = cells.findIndex((node) => node.getBoundingClientRect().bottom > top);
    return { cell, offset: Math.round(top - cells[cell]!.getBoundingClientRect().top) };
  };

  it("returns a reopened notebook to its cell, including cells shown with Show more", async () => {
    using _style = withAppCss();
    let saved: ReturnType<typeof readingPosition>;
    {
      await using screen = await render(opened("analysis.ipynb", notebook));
      await screen.getByRole("button", { name: /Show more cells/ }).click();
      await vi.waitFor(() => expect(scroller().querySelectorAll("section")).toHaveLength(40));
      scroller().scrollTop = scroller().scrollHeight - scroller().clientHeight - 200;
      scroller().dispatchEvent(new Event("scroll"));
      saved = readingPosition();
      expect(saved.cell, "scrolled into the cells Show more added").toBeGreaterThan(20);
    }
    {
      await using _screen = await render(opened("other.ipynb", notebook));
      await vi.waitFor(() => expect(scroller().querySelectorAll("section")).toHaveLength(20));
      expect(scroller().scrollTop, "another notebook opens at the top").toBe(0);
    }
    await using _screen = await render(opened("analysis.ipynb", notebook));
    await vi.waitFor(() => {
      const position = readingPosition();
      expect(position.cell).toBe(saved.cell);
      expect(Math.abs(position.offset - saved.offset)).toBeLessThanOrEqual(2);
    });
  });
});
