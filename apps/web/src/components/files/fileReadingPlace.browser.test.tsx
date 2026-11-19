import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import appCss from "~/index.css?inline";

import { type Citation, useViewerPlace } from "./fileReadingPlace";
import { readings } from "./fileReadingSave";
import type { FileReadingKey } from "./fileReadingStore";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";
import VirtualTablePreview from "./VirtualTablePreview";

/** A workspace file of its own, so no case reads a place another case saved. */
function placeFile(name: string) {
  const file: FileReadingKey = {
    kind: "path",
    environmentId: "file-reading-place-test",
    absolutePath: `/place/${name}`,
  };
  return {
    file,
    [Symbol.dispose]() {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("t3code.fileReading.v1:")) localStorage.removeItem(key);
      }
    },
  };
}

/** The app's styles, which lay out the table viewer's scroller. */
function appStyles() {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

/** Rendered Markdown's shape: blocks in a scroll area viewport. */
function Markdown(props: { readonly blocks: number }) {
  return (
    <div data-slot="scroll-area-viewport" style={{ height: 300, overflow: "auto" }}>
      <div className="chat-markdown">
        {Array.from({ length: props.blocks }, (_, index) => (
          <p key={index} style={{ height: 40, margin: 0 }}>
            Block {index + 1}
          </p>
        ))}
      </div>
    </div>
  );
}

/** A workspace file's code view, which keeps its own place. */
function CodeView() {
  return (
    <div className="file-preview-virtualizer" style={{ height: 300, overflow: "auto" }}>
      <pre style={{ height: 3000, margin: 0 }}>const a = 1;</pre>
    </div>
  );
}

/** The viewer container, with a control that switches the viewer, such as a mode toggle. */
function Viewer(props: { readonly file: FileReadingKey; readonly children: ReactNode }) {
  const { ref } = useViewerPlace({
    file: props.file,
    views: ["rendered", "offset"],
    citation: null,
  });
  return (
    <div ref={ref}>
      <button type="button">Show source</button>
      {props.children}
    </div>
  );
}

const sheetRows = (page: number) =>
  Array.from({ length: PREVIEW_PAGE_ROWS }, (_, row) => [
    `row ${page * PREVIEW_PAGE_ROWS + row + 1}`,
    String(row),
  ]);

/**
 * A table the viewer replaces inside a wrapper that stays, as a workbook's sheet switch does.
 * `indexed` holds the reveal back, as the large text viewer does while it indexes.
 */
function Sheet(props: {
  readonly file: FileReadingKey;
  readonly mount: number;
  readonly citation?: Citation;
  readonly indexed?: boolean;
}) {
  const { ref, rowLine } = useViewerPlace({
    file: props.file,
    views: ["rendered", "offset"],
    citation: props.citation ?? null,
  });
  return (
    <div ref={ref} className="flex h-75 w-100 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <VirtualTablePreview
          key={props.mount}
          name="Sheet"
          count={400}
          columns={2}
          getRows={sheetRows}
          revealLine={props.indexed === false ? null : rowLine(true)}
        />
      </div>
    </div>
  );
}

/** The table's scroller and the data index of the first row it shows. */
function tableView(container: HTMLElement) {
  const scroller = () => container.querySelector<HTMLElement>("[aria-rowcount] > [tabindex]");
  return {
    scroller,
    topRow() {
      const element = scroller();
      if (element === null) return null;
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>("[data-preview-row]")].find(
        (candidate) => candidate.getBoundingClientRect().bottom > top + 0.5,
      );
      return row === undefined ? null : Number(row.dataset.previewRow);
    },
  };
}

/** The observers that watch the whole viewer for a scroller to place, and the ones disconnected. */
function viewerLooks() {
  const observe = vi.spyOn(MutationObserver.prototype, "observe");
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  return {
    started: (root: Element | null) =>
      observe.mock.calls.flatMap(([target, options], index) =>
        target === root && options?.subtree === true ? [observe.mock.contexts[index]] : [],
      ),
    stopped: (look: unknown) => disconnect.mock.contexts.includes(look as MutationObserver),
    [Symbol.dispose]() {
      observe.mockRestore();
      disconnect.mockRestore();
    },
  };
}

const press = (element: Element) =>
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
const typeIn = (element: Element) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

describe("the viewer container's look for a scroller", () => {
  it("watches nothing for a file without a saved place, whatever the reader does", async () => {
    using notes = placeFile("fresh.md");
    using looks = viewerLooks();
    await using screen = await render(
      <Viewer file={notes.file}>
        <Markdown blocks={40} />
      </Viewer>,
      { router: false },
    );
    const root = screen.container.firstElementChild;
    await screen.rerender(
      <Viewer file={notes.file}>
        <Markdown blocks={80} />
      </Viewer>,
    );
    press(root!.querySelector("p")!);
    typeIn(root!.querySelector("p")!);
    press(screen.getByRole("button").element());
    expect(looks.started(root)).toEqual([]);
  });

  it("stops once it places the saved block or meets the code view, and only a control looks again, briefly", async () => {
    using notes = placeFile("read.md");
    using looks = viewerLooks();
    readings.writePosition(notes.file, { view: "rendered", block: 20, fraction: 0 });
    await using screen = await render(
      <Viewer file={notes.file}>
        <Markdown blocks={80} />
      </Viewer>,
      { router: false },
    );
    const root = screen.container.firstElementChild;
    const viewport = root!.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    await vi.waitFor(() => expect(viewport.scrollTop).toBe(800));
    const [opening] = looks.started(root);
    expect(looks.stopped(opening)).toBe(true);

    // The source view replaces the rendered one; it keeps its own place, so the look ends there.
    await screen.rerender(
      <Viewer file={notes.file}>
        <CodeView />
      </Viewer>,
    );
    const [, swapped] = looks.started(root);
    await vi.waitFor(() => expect(looks.stopped(swapped)).toBe(true));

    using _timers = fakeTimers();
    const code = root!.querySelector(".file-preview-virtualizer pre")!;
    press(code);
    typeIn(code);
    expect(looks.started(root)).toHaveLength(2);
    press(screen.getByRole("button").element());
    const [, , clicked] = looks.started(root);
    expect(clicked).toBeDefined();
    expect(looks.stopped(clicked)).toBe(false);
    await act(() => vi.advanceTimersByTime(2_000));
    expect(looks.stopped(clicked)).toBe(true);
  });
});

describe("the viewer container's table rows", () => {
  it("returns a table the viewer mounts again inside it to the reader's row, long after any click", async () => {
    using _styles = appStyles();
    using sheet = placeFile("book.ods");
    readings.writePosition(sheet.file, { view: "rendered", block: 80, fraction: 0 });
    await using screen = await render(<Sheet file={sheet.file} mount={1} />, { router: false });
    const table = tableView(screen.container);
    await vi.waitFor(() => expect(table.topRow()).toBe(80));
    await userEvent.wheel(table.scroller()!, { delta: { y: 1500 } });
    await vi.waitFor(() =>
      expect(readings.readPosition(sheet.file, "rendered")?.block).toBeGreaterThan(110),
    );
    const read = readings.readPosition(sheet.file, "rendered")!.block;

    await screen.rerender(<Sheet file={sheet.file} mount={2} />);
    await vi.waitFor(() => expect(table.topRow()).toBe(read));
  });

  it("leaves a table where the reader scrolled it while a cited line waits for the raw text", async () => {
    using _styles = appStyles();
    using sheet = placeFile("data.csv");
    readings.writePosition(sheet.file, { view: "rendered", block: 80, fraction: 0 });
    const citation: Citation = { id: 1, line: 300, pending: () => true, shown: () => {} };
    const sheetAt = (indexed: boolean) => (
      <Sheet file={sheet.file} mount={1} citation={citation} indexed={indexed} />
    );
    await using screen = await render(sheetAt(false), { router: false });
    const table = tableView(screen.container);
    await vi.waitFor(() => expect(table.topRow()).toBe(0));
    await userEvent.wheel(table.scroller()!, { delta: { y: 1000 } });
    await vi.waitFor(() =>
      expect(readings.readPosition(sheet.file, "rendered")?.block).toBeGreaterThan(20),
    );
    const top = table.topRow();

    await screen.rerender(sheetAt(true));
    expect(table.topRow()).toBe(top);
  });
});
