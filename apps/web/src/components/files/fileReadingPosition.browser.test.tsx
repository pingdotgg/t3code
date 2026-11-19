import type { ChatFileAttachment } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { useClosedViewStore } from "~/closedViewStore";
import { useRightPanelStore } from "~/rightPanelStore";

vi.mock(import("~/assets/assetUrls"), async (original) =>
  (await import("./fileReadingTestMocks")).mockAssetUrls(await original()),
);
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) =>
  (await import("./fileReadingTestMocks")).mockRuntime(await original()),
);
vi.mock(import("~/state/session"), async (original) =>
  (await import("./fileReadingTestMocks")).mockSession(await original()),
);
vi.mock(import("~/state/filesystem"), async (original) =>
  (await import("./fileReadingTestMocks")).mockFilesystem(await original()),
);
vi.mock(import("~/state/use-atom-command"), async (original) =>
  (await import("./fileReadingTestMocks")).mockAtomCommand(await original()),
);
vi.mock(import("~/state/server"), async (original) =>
  (await import("./fileReadingTestMocks")).mockServer(await original()),
);
vi.mock(import("~/remoteOpen"), async (original) =>
  (await import("./fileReadingTestMocks")).mockRemoteOpen(await original()),
);
vi.mock(import("~/hooks/useTheme"), async (original) =>
  (await import("./fileReadingTestMocks")).mockTheme(await original()),
);
vi.mock(import("./projectFilesQueryState"), async (original) =>
  (await import("./fileReadingTestMocks")).mockProjectFiles(await original()),
);
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.mutationRefresh(),
);
vi.mock(import("./FileBreadcrumbs"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.breadcrumbs(),
);
vi.mock(import("./FileBrowserPanel"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.browser(),
);
vi.mock(import("../DiffWorkerPoolProvider"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.diffWorkers(),
);

import { readings } from "./fileReadingSave";
import {
  AttachmentPanel,
  COLD_WORKER,
  csv,
  environmentId,
  holdIndexing,
  largeText,
  lines,
  ReadingPanel,
  readingSetup,
  rowsView,
  sourceFile,
  sourceView,
  state,
} from "./fileReadingTestKit";
import { FILE_LINK_REVEAL_ATTRIBUTE } from "./fileSurfaceChrome";

describe("file reading position", () => {
  it("returns a source file to the reader's line after a tab switch and a panel remount", async () => {
    using reading = await readingSetup("switch");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 1213 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(50));
    const before = view.topLine();
    expect(before.offset).toBeLessThan(0);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
  });

  it("reveals a citation over a saved position, then keeps the reader's later place", async () => {
    using reading = await readingSetup("cited");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(100));

    await act(() => panel.openFile(ref, "a.ts", 40));
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    expect(reading.saved("a.ts", "source")?.line).toBe(40);
    await userEvent.wheel(view.scroller(), { delta: { y: 230 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(40));
    const before = view.topLine();
    expect(before.line).toBeLessThan(100);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(ref, "c.ts"));
    await act(() => panel.closeSurface(ref, "file:c.ts"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
    expect(view.line(40)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE)).toBe(true);
  });

  it("clamps a saved position past the end of shorter contents without rewriting it", async () => {
    using reading = await readingSetup("shorter");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 4000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(150));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const saved = reading.saved("a.ts", "source");

    state.files["a.ts"] = sourceFile("a.ts", "alpha", 60);
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(60, "alpha_60"));
    const scroller = view.scroller();
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(
      scroller.scrollHeight - scroller.clientHeight - 1,
    );
    expect(reading.saved("a.ts", "source")).toEqual(saved);
  });

  it("returns rendered Markdown to the reader's block after a tab switch, clamped when shorter", async () => {
    using reading = await readingSetup("rendered");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.md");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const viewport = () =>
      screen.container
        .querySelector(".chat-markdown")
        ?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    await vi.waitFor(() => expect(viewport()?.textContent).toContain("Paragraph 80."));
    await userEvent.wheel(viewport()!, { delta: { y: 1500 } });
    await vi.waitFor(() => expect(reading.saved("doc.md", "rendered")?.block).toBeGreaterThan(10));
    const wheeled = reading.saved("doc.md", "rendered")!.block!;

    // The custom scrollbar sits beside the viewport and moves it directly.
    const scrollbar = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-scrollbar"]',
    )!;
    const track = scrollbar.getBoundingClientRect();
    await userEvent.click(scrollbar, {
      position: { x: track.width / 2, y: track.height - 4 },
    });
    await vi.waitFor(() =>
      expect(reading.saved("doc.md", "rendered")?.block).toBeGreaterThan(wheeled),
    );
    const before = viewport()!.scrollTop;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => expect(viewport()).toBeFalsy());
    await act(() => panel.activateSurface(ref, "file:doc.md"));
    await vi.waitFor(() => expect(Math.abs(viewport()!.scrollTop - before)).toBeLessThanOrEqual(1));

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => expect(viewport()).toBeFalsy());
    const saved = reading.saved("doc.md", "rendered");
    const shorter = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}.`).join(
      "\n\n",
    );
    state.files["doc.md"] = {
      relativePath: "doc.md",
      contents: shorter,
      byteLength: shorter.length,
      truncated: false,
    };
    await act(() => panel.activateSurface(ref, "file:doc.md"));
    await vi.waitFor(() => {
      const element = viewport()!;
      expect(element.textContent).not.toContain("Paragraph 31.");
      expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
      expect(element.scrollTop).toBeGreaterThanOrEqual(
        element.scrollHeight - element.clientHeight - 1,
      );
    });
    expect(reading.saved("doc.md", "rendered")).toEqual(saved);
  });

  it("returns a citation reopened with Reopen Closed View to the reader's place", async () => {
    using reading = await readingSetup("reopen-closed");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(100));
    const before = view.topLine();

    await act(() => panel.closeSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const entry = useClosedViewStore
      .getState()
      .entries.find((closed) => closed.kind === "panel-tab" && closed.surface.id === "file:a.ts")!;
    // Reopen Closed View opens the tab with its old line, then drops the closed entry after an await.
    panel.openFile(ref, "a.ts", 40);
    await Promise.resolve();
    useClosedViewStore.getState().remove(entry.id);

    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
    expect(view.line(40)).toBeNull();
  });

  it("jumps to a Markdown citation reopened at request 1 after it was read rendered", async () => {
    using reading = await readingSetup("reopen-md");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.md", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(view.line(40)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    await vi.waitFor(() => expect(screen.container.querySelector(".chat-markdown")).toBeTruthy());

    await act(() => panel.closeSurface(ref, "file:doc.md"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(ref, "doc.md", 40));

    await vi.waitFor(() => expect(screen.container.querySelector(".chat-markdown")).toBeFalsy());
    await vi.waitFor(() =>
      expect(view.line(40)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE)).toBe(true),
    );
    const scroller = view.scroller();
    const line = view.line(40)!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    expect(line.top).toBeGreaterThanOrEqual(box.top);
    expect(line.bottom).toBeLessThanOrEqual(box.bottom);
  });

  it("jumps to a citation reopened at request 1 after its tab was closed", async () => {
    using reading = await readingSetup("reopen");
    const panel = useRightPanelStore.getState();
    panel.openFile(reading.ref, "b.ts");
    panel.openFile(reading.ref, "a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={reading.ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    const revealedTop = view.scroller().scrollTop;
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(view.scroller().scrollTop).toBeGreaterThan(revealedTop + 1000));

    await act(() => panel.closeSurface(reading.ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(reading.ref, "a.ts", 40));

    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
  });
});

describe("large text and table rows keep the reader's place", () => {
  it("returns a CSV table to the reader's row after a tab switch, capped at the end when shorter", async () => {
    using reading = await readingSetup("csv");
    const { panel, ref } = reading;
    const table = (rows: number) => {
      const contents = csv(rows);
      return { relativePath: "table.csv", contents, byteLength: contents.length, truncated: false };
    };
    state.files["table.csv"] = table(300);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "table.csv");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    await vi.waitFor(rows.indexed, COLD_WORKER);
    await rows.wheel(2900);
    await vi.waitFor(() =>
      expect(reading.saved("table.csv", "rendered")?.block).toBeGreaterThan(50),
    );
    const before = rows.topRow();
    expect(before).toBe(reading.saved("table.csv", "rendered")?.block);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:table.csv"));
    await vi.waitFor(() => expect(rows.topRow()).toBe(before), COLD_WORKER);

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(rows.topRow()).toBe(before), COLD_WORKER);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const saved = reading.saved("table.csv", "rendered");
    state.files["table.csv"] = table(40);
    await act(() => panel.activateSurface(ref, "file:table.csv"));
    await vi.waitFor(() => {
      rows.indexed();
      const scroller = rows.scroller()!;
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(scroller.scrollTop).toBeGreaterThanOrEqual(
        scroller.scrollHeight - scroller.clientHeight - 1,
      );
    }, COLD_WORKER);
    expect(reading.saved("table.csv", "rendered")).toEqual(saved);
  });

  it("keeps a text file's line when it grows past the 1 MB preview and when it shrinks back", async () => {
    using reading = await readingSetup("crossing");
    const { panel, ref } = reading;
    const contents = lines(400);
    const small = {
      relativePath: "app.log",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    state.files["app.log"] = small;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "app.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const rows = rowsView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "log line 1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(reading.saved("app.log", "source")?.line).toBeGreaterThan(50));
    const read = reading.saved("app.log", "source")!.line!;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    reading.serve("app.log", contents);
    state.files["app.log"] = { ...small, byteLength: 2_000_000, truncated: true };
    await act(() => panel.activateSurface(ref, "file:app.log"));
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(read - 1);
    }, COLD_WORKER);

    await rows.wheel(2000);
    await vi.waitFor(() =>
      expect(reading.saved("app.log", "source")?.line).toBeGreaterThan(read + 30),
    );
    const later = reading.saved("app.log", "source")!.line!;
    expect(rows.topRow()).toBe(later - 1);
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    state.files["app.log"] = small;
    await act(() => panel.activateSurface(ref, "file:app.log"));
    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: later, offset: 0 }));
  });

  it("reveals a cited line of a large text file once, even when the reader scrolls and leaves while it indexes, then returns to the reader's place", async () => {
    using reading = await readingSetup("large-cited");
    using indexing = holdIndexing();
    const { panel, ref } = reading;
    largeText(reading, "big.log", lines(600));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "big.log", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(rows.topRow()).toBe(0), COLD_WORKER);
    await rows.wheel(600);
    await vi.waitFor(() => expect(reading.saved("big.log", "source")?.line).toBeGreaterThan(10));
    // The reader leaves before indexing ends, so the viewer has yet to show the citation.
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:big.log"));
    await vi.waitFor(() => expect(rows.topRow()).toBe(0), COLD_WORKER);
    indexing.release();
    await vi.waitFor(
      () =>
        expect(
          screen.container.querySelector('[data-preview-reveal="true"]')?.textContent,
        ).toContain("log line 40"),
      COLD_WORKER,
    );
    expect(reading.saved("big.log", "source")?.line).toBe(40);

    await rows.wheel(3000);
    await vi.waitFor(() => expect(reading.saved("big.log", "source")?.line).toBeGreaterThan(100));
    const before = rows.topRow();
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:big.log"));
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(before);
    }, COLD_WORKER);
  });

  it("leaves a large text file where the reader scrolled it while it indexed, and a click there keeps the restore", async () => {
    using reading = await readingSetup("indexing");
    using indexing = holdIndexing();
    const { panel, ref } = reading;
    largeText(reading, "big.log", `${lines(600)}\n`);
    readings.writePosition(
      { kind: "path", environmentId, absolutePath: `${reading.cwd}/big.log` },
      { view: "source", line: 40, offset: 0 },
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "big.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
    await vi.waitFor(() => expect(status()).toMatch(/600 lines.*Indexing/), COLD_WORKER);
    await rows.wheel(3000);
    await vi.waitFor(() => expect(rows.topRow()).toBeGreaterThan(80));
    const top = rows.scroller()!.scrollTop;

    indexing.release();
    await vi.waitFor(rows.indexed);
    expect(Math.abs(rows.scroller()!.scrollTop - top)).toBeLessThan(29);
    await vi.waitFor(() => expect(reading.saved("big.log", "source")?.line).toBeGreaterThan(80));
    const line = reading.saved("big.log", "source")!.line!;
    // Opening the file again from the tree keeps the rows where the reader has them.
    await act(() => panel.openFile(ref, "big.log"));
    expect(screen.container.querySelector('[data-preview-reveal="true"]')).toBeNull();
    expect(Math.abs(rows.scroller()!.scrollTop - top)).toBeLessThan(29);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    indexing.hold();
    await act(() => panel.activateSurface(ref, "file:big.log"));
    // A click that scrolls nothing while it indexes leaves the restore to land.
    await vi.waitFor(() => expect(status()).toMatch(/600 lines.*Indexing/), COLD_WORKER);
    await userEvent.click(rows.scroller()!);
    indexing.release();
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(line - 1);
    }, COLD_WORKER);
  });

  it("returns a large text file that changed while open to the reader's line", async () => {
    using reading = await readingSetup("changed");
    const { panel, ref } = reading;
    largeText(reading, "app.log", `${lines(600)}\n`);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "app.log");
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} workspaceMutationId="before" />,
    );
    const rows = rowsView(screen.container);
    await vi.waitFor(rows.indexed, COLD_WORKER);
    await rows.wheel(3000);
    await vi.waitFor(() => expect(reading.saved("app.log", "source")?.line).toBeGreaterThan(50));
    const line = reading.saved("app.log", "source")!.line!;

    // An agent appends to the log, and the viewer loads the new bytes.
    largeText(reading, "app.log", `${lines(700)}\n`);
    await screen.rerender(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} workspaceMutationId="after" />,
    );
    await vi.waitFor(() => {
      rows.indexed();
      expect(screen.container.querySelector('[role="status"]')?.textContent).toContain("700 lines");
      expect(rows.topRow()).toBe(line - 1);
    }, COLD_WORKER);
  });

  it("returns a large CSV attachment's table and its raw text each to its own line", async () => {
    using reading = await readingSetup("csv-attachment");
    const data: ChatFileAttachment = {
      type: "file",
      id: "attachment-data.csv" as ChatFileAttachment["id"],
      name: "data.csv",
      mimeType: "text/csv",
      sizeBytes: 2_000_000,
    };
    reading.attach(data, csv(400));
    const key = { kind: "attachment", environmentId, attachmentId: data.id } as const;
    readings.writePosition(key, { view: "rendered", block: 80, fraction: 0 });
    readings.writePosition(key, { view: "source", line: 200, offset: 0 });
    await using screen = await render(
      <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={data} />,
    );
    const rows = rowsView(screen.container);
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(80);
    }, COLD_WORKER);

    await userEvent.click(screen.getByRole("button", { name: "Show source" }));
    await vi.waitFor(() => {
      rows.indexed();
      expect(screen.container.querySelector('[role="region"][aria-rowcount]')).not.toBeNull();
      expect(rows.topRow()).toBe(199);
    }, COLD_WORKER);
  });

  it("scrolls a CSV attachment's table on past its saved row", async () => {
    using reading = await readingSetup("small-csv-attachment");
    const text = csv(400);
    const data: ChatFileAttachment = {
      type: "file",
      id: "attachment-table.csv" as ChatFileAttachment["id"],
      name: "table.csv",
      mimeType: "text/csv",
      sizeBytes: text.length,
    };
    reading.attach(data, text);
    const key = { kind: "attachment", environmentId, attachmentId: data.id } as const;
    readings.writePosition(key, { view: "rendered", block: 80, fraction: 0 });
    await using screen = await render(
      <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={data} />,
    );
    const rows = rowsView(screen.container);
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(80);
    }, COLD_WORKER);
    // The scroll re-renders the panel, which must not load the attachment and its table again.
    const table = rows.scroller();
    await rows.wheel(1500);
    await vi.waitFor(() =>
      expect(reading.attachmentSaved(data.id, "rendered")?.block).toBeGreaterThan(110),
    );
    expect(rows.scroller()).toBe(table);
    expect(rows.topRow()).toBe(reading.attachmentSaved(data.id, "rendered")?.block);
  });
});
