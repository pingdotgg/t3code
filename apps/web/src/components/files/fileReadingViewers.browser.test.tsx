import type { ChatFileAttachment } from "@t3tools/contracts";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

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
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () =>
  (await import("./fileReadingTestMocks")).mockPdfWorkerUrl(),
);
vi.mock(import("./office/WordDocument"), async () =>
  (await import("./fileReadingTestMocks")).mockWordDocument(),
);

import { ROWS_SELECTOR } from "./fileReadingPlace";
import { readings } from "./fileReadingSave";
import {
  AttachmentPanel,
  environmentId,
  firstShown,
  letterPdf,
  pressMedia,
  ReadingPanel,
  readingSetup,
  rowsView,
  seekAsReader,
  silentWav,
  sourceView,
  state,
} from "./fileReadingTestKit";

// PDF.js, Mermaid and the Office viewers load lazily and start their workers cold.
const COLD_VIEWER = { timeout: 10_000 };

function attachment(name: string, mimeType: string, text: string): ChatFileAttachment {
  return {
    type: "file",
    id: `attachment-${name}` as ChatFileAttachment["id"],
    name,
    mimeType,
    sizeBytes: text.length,
  };
}

function flowchart(nodes: number) {
  return `flowchart TD\n${Array.from({ length: nodes }, (_, index) => `  N${index} --> N${index + 1}`).join("\n")}`;
}

/**
 * A workbook of sheets of 300 numbered rows. Its first stored sheet is hidden, so it opens on
 * "First", and cell A1 of "Second" links to row 280 of "First".
 */
function workbook() {
  const sheets = [
    { name: "Hidden", state: ' state="hidden"', links: "" },
    { name: "First", state: "", links: "" },
    {
      name: "Second",
      state: "",
      links: '<hyperlinks><hyperlink ref="A1" location="First!A280"/></hyperlinks>',
    },
  ];
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state} r:id="rId${index + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships>${sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  );
  const data = Array.from(
    { length: 300 },
    (_, row) => `<row r="${row + 1}"><c r="A${row + 1}"><v>${row + 1}</v></c></row>`,
  ).join("");
  for (const [index, sheet] of sheets.entries()) {
    archive.file(
      `xl/worksheets/sheet${index + 1}.xml`,
      `<worksheet><sheetData>${data}</sheetData>${sheet.links}</worksheet>`,
    );
  }
  return archive.generateAsync({ type: "blob" });
}

/** An OpenDocument spreadsheet with two sheets of numbered rows; a sheet may have none. */
function openDocumentSheet(north: number, south = 1) {
  const rows = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `<table:table-row><table:table-cell><text:p>row ${index + 1}</text:p></table:table-cell></table:table-row>`,
    ).join("");
  return new JSZip()
    .file(
      "content.xml",
      `<office:document><table:table table:name="North">${rows(north)}</table:table><table:table table:name="South">${rows(south)}</table:table></office:document>`,
    )
    .generateAsync({ type: "blob" });
}

describe("every right-panel viewer keeps the reader's place", () => {
  it("opens a PDF in PDF.js where the browser has its own viewer, at the reader's spot in a new width", async () => {
    using reading = await readingSetup("pdf");
    using _native = vi.spyOn(navigator, "pdfViewerEnabled", "get").mockReturnValue(true);
    // Each search of the viewer container for a scroller starts with the rows selector.
    using queries = vi.spyOn(Element.prototype, "querySelector");
    const searches = () => queries.mock.calls.filter(([selector]) => selector === ROWS_SELECTOR);
    const { panel, ref } = reading;
    reading.serve("doc.pdf", letterPdf(6));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.pdf");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const region = () =>
      screen.container.querySelector<HTMLElement>('[role="region"][aria-label="doc.pdf"]');
    /** How far down page 3 the viewport top is, as a share of the page's height. */
    const intoPage = () => {
      const page = region()!.querySelector('canvas[aria-label="Page 3"]')!.getBoundingClientRect();
      return (region()!.getBoundingClientRect().top - page.top) / page.height;
    };
    // PDF.js loads its worker and the document before the first page shows.
    await vi.waitFor(() => expect(screen.container.textContent).toContain("1 / 6 pages"), {
      timeout: 10_000,
    });
    await userEvent.wheel(region()!, { delta: { y: 2000 } });
    await vi.waitFor(() => expect(reading.saved("doc.pdf", "pdf")?.page).toBe(2));
    const before = intoPage();
    expect(before).toBeGreaterThan(0.05);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} width={500} />);
    await act(() => panel.activateSurface(ref, "file:doc.pdf"));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("3 / 6 pages"), {
      timeout: 10_000,
    });
    // PdfViewer scales the 16px gap above a page with the page; an unscaled offset misses by 0.1.
    await vi.waitFor(() => expect(intoPage()).toBeCloseTo(before, 1));
    // PDF.js keeps its own place, so the container never searches it, even after a click.
    await userEvent.click(region()!);
    expect(searches()).toEqual([]);
  });

  it("returns a zoomed PDF to the reader's sideways pan", async () => {
    using reading = await readingSetup("pdf-pan");
    using _native = vi.spyOn(navigator, "pdfViewerEnabled", "get").mockReturnValue(true);
    const { panel, ref } = reading;
    reading.serve("doc.pdf", letterPdf(2));
    readings.writePosition(
      { kind: "path", environmentId, absolutePath: `${reading.cwd}/doc.pdf` },
      { view: "pdf", page: 0, offset: 0, zoom: 2, left: 0 },
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.pdf");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const region = () =>
      screen.container.querySelector<HTMLElement>('[role="region"][aria-label="doc.pdf"]');
    await vi.waitFor(() => {
      expect(region()!.scrollWidth).toBeGreaterThan(region()!.clientWidth + 300);
    }, COLD_VIEWER);
    await userEvent.wheel(region()!, { delta: { x: 200 } });
    await vi.waitFor(() => expect(reading.saved("doc.pdf", "pdf")?.left).toBeGreaterThan(100));
    const left = region()!.scrollLeft;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:doc.pdf"));
    await vi.waitFor(() => expect(region()?.scrollLeft).toBeCloseTo(left, 0), COLD_VIEWER);
  });

  it("returns a Word document to the reader's page after a tab switch", async () => {
    using reading = await readingSetup("word");
    const { panel, ref } = reading;
    const docx = await new JSZip()
      .file(
        "word/document.xml",
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>`,
      )
      .generateAsync({ type: "blob" });
    reading.serve("report.docx", docx);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "report.docx");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const pages = () => screen.container.querySelector<HTMLElement>("[data-office-pages]");
    const shown = () => firstShown(pages()!, '[role="group"]');
    // The Office preparation worker starts cold.
    await vi.waitFor(() => expect(pages()?.querySelectorAll('[role="group"]')).toHaveLength(40), {
      timeout: 10_000,
    });
    await userEvent.wheel(pages()!, { delta: { y: 9300 } });
    await vi.waitFor(() =>
      expect(reading.saved("report.docx", "rendered")?.block).toBeGreaterThan(5),
    );
    const before = shown();

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:report.docx"));
    await vi.waitFor(
      () => {
        expect(shown().index).toBe(before.index);
        expect(Math.abs(shown().offset - Math.max(0, before.offset))).toBeLessThanOrEqual(1);
      },
      { timeout: 10_000 },
    );
  });

  it("returns a notebook to the reader's cell after a tab switch", async () => {
    using reading = await readingSetup("notebook");
    const { panel, ref } = reading;
    const notebook = {
      nbformat: 4,
      metadata: { language_info: { name: "python" } },
      cells: Array.from({ length: 20 }, (_, cell) => ({
        cell_type: "markdown",
        metadata: {},
        source: [`## Cell ${cell + 1}\n`, ...Array.from({ length: 12 }, () => "Some notes.\n\n")],
      })),
    };
    reading.serve("nb.ipynb", JSON.stringify(notebook));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "nb.ipynb");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const cells = () =>
      screen.container.querySelector("section[aria-label]")?.parentElement?.parentElement ?? null;
    const shown = () => firstShown(cells()!, "section[aria-label]");
    // The notebook goes through the cold Office conversion worker.
    await vi.waitFor(() => expect(cells()?.textContent).toContain("Cell 20"), { timeout: 10_000 });
    await userEvent.wheel(cells()!, { delta: { y: 4000 } });
    await vi.waitFor(() => expect(reading.saved("nb.ipynb", "rendered")?.block).toBeGreaterThan(3));
    const before = shown();

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:nb.ipynb"));
    await vi.waitFor(
      () => {
        expect(shown().index).toBe(before.index);
        expect(Math.abs(shown().offset - Math.max(0, before.offset))).toBeLessThanOrEqual(1);
      },
      { timeout: 10_000 },
    );
  });

  it("returns a Mermaid diagram to the reader's offset after a tab switch", async () => {
    using reading = await readingSetup("mermaid");
    const { panel, ref } = reading;
    const diagram = `flowchart TD\n${Array.from({ length: 40 }, (_, index) => `  N${index} --> N${index + 1}`).join("\n")}`;
    state.files["flow.mmd"] = {
      relativePath: "flow.mmd",
      contents: diagram,
      byteLength: diagram.length,
      truncated: false,
    };
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "flow.mmd");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const scroller = () =>
      screen.container.querySelector("[data-markdown-mermaid]")?.parentElement ?? null;
    // The diagram renderer loads lazily.
    await vi.waitFor(
      () => {
        const element = scroller();
        expect(element?.querySelector("svg")).toBeTruthy();
        expect(element!.scrollHeight).toBeGreaterThan(element!.clientHeight + 1500);
      },
      { timeout: 10_000 },
    );
    await userEvent.wheel(scroller()!, { delta: { y: 1200 } });
    await vi.waitFor(() => expect(reading.saved("flow.mmd", "offset")?.top).toBeGreaterThan(1000));
    const before = scroller()!.scrollTop;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:flow.mmd"));
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBeCloseTo(before, 0), {
      timeout: 10_000,
    });
  });

  it("returns audio and video paused at the reader's time, and a video's first frame saves nothing", async () => {
    using reading = await readingSetup("media");
    const { panel, ref } = reading;
    reading.serve("talk.wav", silentWav());
    reading.serve("clip.mp4", silentWav());
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "clip.mp4");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const media = (selector: string) => screen.container.querySelector<HTMLMediaElement>(selector);
    const clip = { kind: "path", environmentId, absolutePath: `${reading.cwd}/clip.mp4` } as const;
    const saveInOtherTab = (name: string, at: number, time: number) =>
      localStorage.setItem(
        `t3code.fileReading.v1:${JSON.stringify([environmentId, `${reading.cwd}/${name}`, "media"])}`,
        JSON.stringify({ v: 1, at, view: "media", time }),
      );

    await vi.waitFor(() => expect(media("video")?.currentTime).toBeCloseTo(0.1, 2));
    await vi.waitFor(() => expect(media("video")?.seeking).toBe(false));
    expect(readings.readPosition(clip, "media")).toBeNull();
    // A time saved after the video loaded, as another tab saves one, stays when the reader
    // presses the untouched video, such as to mute it.
    readings.writePosition(clip, { view: "media", time: 5 });
    pressMedia(media("video")!);
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    expect(reading.saved("clip.mp4", "media")?.time).toBe(5);
    await act(() => panel.activateSurface(ref, "file:clip.mp4"));
    await vi.waitFor(() => expect(media("video")?.currentTime).toBeCloseTo(5, 2));
    await seekAsReader(media("video")!, 3);
    await vi.waitFor(() => expect(reading.saved("clip.mp4", "media")?.time).toBeCloseTo(3, 2));

    // The reader's first press comes before the source loads, as a first tap on Play on iOS does;
    // playback moves from there with no other press.
    screen.container.addEventListener(
      "loadstart",
      (event) => pressMedia(event.target as HTMLMediaElement),
      { capture: true, once: true },
    );
    await act(() => panel.openFile(ref, "talk.wav"));
    await vi.waitFor(() => expect(media("audio")?.readyState).toBeGreaterThan(0));
    media("audio")!.currentTime = 4;
    await vi.waitFor(() => expect(reading.saved("talk.wav", "media")?.time).toBeCloseTo(4, 2));
    // Playback moves on between saves, and the tab switch keeps where it got to.
    const audio = media("audio")!;
    audio.muted = true;
    await audio.play();
    await vi.waitFor(() => expect(audio.currentTime).toBeGreaterThan(4.1));
    // A chat link opens the file that is already playing; the player stays and plays on.
    await act(() => panel.openFile(ref, "talk.wav"));
    expect(media("audio")).toBe(audio);
    const reopened = audio.currentTime;
    await vi.waitFor(() => expect(audio.currentTime).toBeGreaterThan(reopened + 0.3));
    const played = audio.currentTime;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const left = reading.saved("talk.wav", "media")!.time!;
    expect(left).toBeGreaterThanOrEqual(played);
    await act(() => panel.activateSurface(ref, "file:talk.wav"));
    await vi.waitFor(() => {
      expect(media("audio")?.currentTime).toBeCloseTo(left, 2);
      expect(media("audio")?.paused).toBe(true);
    });
    await seekAsReader(media("audio")!, 2);
    await vi.waitFor(() => expect(reading.saved("talk.wav", "media")?.time).toBeCloseTo(2, 2));
    const replaced = media("audio")!;
    await replaced.play();
    await vi.waitFor(() => expect(replaced.currentTime).toBeGreaterThan(2.3));
    replaced.pause();
    const paused = replaced.currentTime;
    await vi.waitFor(() => expect(reading.saved("talk.wav", "media")?.time).toBeCloseTo(paused, 2));
    // The file changes while open; the player loads it into the same element, which resets it.
    // The reader presses the player while the new source has no time yet.
    replaced.addEventListener("emptied", () => pressMedia(replaced), { once: true });
    reading.serve("talk.wav", silentWav());
    await screen.rerender(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} workspaceMutationId="edited" />,
    );
    await vi.waitFor(() => {
      expect(media("audio")).toBe(replaced);
      expect(replaced.src).toContain("edited");
      expect(replaced.readyState).toBeGreaterThan(0);
      expect(replaced.currentTime).toBeCloseTo(paused, 2);
    });
    expect(reading.saved("talk.wav", "media")?.time).toBeCloseTo(paused, 2);
    // Another browser tab saves a newer time; leaving the paused player here keeps it.
    saveInOtherTab("talk.wav", reading.saved("talk.wav", "media")!.at + 1, 7);
    await act(() => panel.activateSurface(ref, "file:clip.mp4"));
    await vi.waitFor(() => {
      expect(media("video")?.currentTime).toBeCloseTo(3, 2);
      expect(media("video")?.paused).toBe(true);
    });
    const theirs = reading.saved("talk.wav", "media")!;
    expect(theirs.time).toBe(7);
    // Reopened at 7 s, a press that leaves playback there saves nothing over a newer time, also
    // when the time reads a few milliseconds off, as an engine that seeks by frame may report it.
    await act(() => panel.activateSurface(ref, "file:talk.wav"));
    await vi.waitFor(() => expect(media("audio")?.currentTime).toBeCloseTo(7, 2));
    saveInOtherTab("talk.wav", theirs.at + 1, 8);
    await seekAsReader(media("audio")!, 7.005);
    await act(() => panel.activateSurface(ref, "file:clip.mp4"));
    expect(reading.saved("talk.wav", "media")?.time).toBe(8);
  });

  it("returns a Markdown attachment, even one named like a PDF, to the reader's block after the panel remounts", async () => {
    using reading = await readingSetup("attachment");
    const text = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
    // The panel shows an attachment by its content type, whatever its name says.
    const notes = attachment("report.pdf", "text/markdown", text);
    reading.attach(notes, new Blob([text], { type: notes.mimeType }));
    const panel = <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={notes} />;
    await using screen = await render(panel);
    const viewport = () =>
      screen.container
        .querySelector(".chat-markdown")
        ?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    await vi.waitFor(() => expect(viewport()?.textContent).toContain("Paragraph 80."));
    await userEvent.wheel(viewport()!, { delta: { y: 1500 } });
    await vi.waitFor(() =>
      expect(reading.attachmentSaved(notes.id, "rendered")?.block).toBeGreaterThan(10),
    );
    const before = viewport()!.scrollTop;

    await screen.rerender(<></>);
    await screen.rerender(
      <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={notes} />,
    );
    await vi.waitFor(() => expect(Math.abs(viewport()!.scrollTop - before)).toBeLessThanOrEqual(1));
  });

  it("keeps a Mermaid attachment's diagram and source places apart", async () => {
    using reading = await readingSetup("mermaid-attachment");
    const text = flowchart(40);
    const flow = attachment("flow.mmd", "text/vnd.mermaid", text);
    reading.attach(flow, new Blob([text], { type: flow.mimeType }));
    const panel = () => (
      <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={flow} />
    );
    await using screen = await render(panel());
    const diagram = () =>
      screen.container.querySelector("[data-markdown-mermaid]")?.parentElement ?? null;
    const source = () => screen.container.querySelector<HTMLElement>(".file-preview-virtualizer");
    // The diagram renderer loads lazily.
    await vi.waitFor(() => {
      const element = diagram();
      expect(element?.querySelector("svg")).toBeTruthy();
      expect(element!.scrollHeight).toBeGreaterThan(element!.clientHeight + 1500);
    }, COLD_VIEWER);
    await userEvent.wheel(diagram()!, { delta: { y: 1200 } });
    await vi.waitFor(() =>
      expect(reading.attachmentSaved(flow.id, "offset")?.top).toBeGreaterThan(1000),
    );
    const before = diagram()!.scrollTop;
    const saved = reading.attachmentSaved(flow.id, "offset");

    await userEvent.click(screen.getByRole("button", { name: "Show Mermaid source" }));
    await vi.waitFor(() => {
      expect(source()!.scrollHeight).toBeGreaterThan(source()!.clientHeight + 300);
    });
    await userEvent.wheel(source()!, { delta: { y: 400 } });
    await vi.waitFor(() =>
      expect(reading.attachmentSaved(flow.id, "source")?.offset).toBeGreaterThan(200),
    );
    const sourceTop = source()!.scrollTop;
    expect(reading.attachmentSaved(flow.id, "offset")).toEqual(saved);

    await screen.rerender(<></>);
    await screen.rerender(panel());
    await vi.waitFor(() => expect(diagram()?.scrollTop).toBeCloseTo(before, 0), COLD_VIEWER);
    await userEvent.click(screen.getByRole("button", { name: "Show Mermaid source" }));
    await vi.waitFor(() => expect(source()?.scrollTop).toBeCloseTo(sourceTop, 0));
  });

  it("keeps a workbook's place on its first visible sheet, which another sheet and a cell link leave alone", async () => {
    using reading = await readingSetup("excel");
    const { panel, ref } = reading;
    const book = { kind: "path", environmentId, absolutePath: `${reading.cwd}/book.xlsx` } as const;
    reading.serve("book.xlsx", await workbook());
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "book.xlsx");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const grid = () => screen.container.querySelector<HTMLElement>('[role="grid"]');
    const showSheet = async (name: string) => {
      await vi.waitFor(() => {
        expect(grid()?.getAttribute("aria-label")).toBe(name);
        expect(grid()!.scrollHeight).toBeGreaterThan(grid()!.clientHeight + 2000);
      }, COLD_VIEWER);
    };
    await showSheet("First");
    await userEvent.wheel(grid()!, { delta: { y: 1500 } });
    await vi.waitFor(() => expect(reading.saved("book.xlsx", "offset")?.top).toBeGreaterThan(1000));
    const before = grid()!.scrollTop;
    const saved = readings.readPosition(book, "offset");

    // A bare click presses nothing, so no look for a switched viewer runs from here.
    const click = (name: string) =>
      act(() =>
        screen
          .getByRole("tab", { name })
          .element()
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    await click("Second");
    await showSheet("Second");
    // A chat link opens the workbook again while it shows the second sheet.
    await act(() => panel.openFile(ref, "book.xlsx"));
    // Two wheels a frame apart, so a scroll the tracker took would be captured by now.
    await userEvent.wheel(grid()!, { delta: { y: 700 } });
    await vi.waitFor(() => expect(grid()!.scrollTop).toBeGreaterThan(300));
    const second = grid()!.scrollTop;
    await userEvent.wheel(grid()!, { delta: { y: 700 } });
    await vi.waitFor(() => expect(grid()!.scrollTop).toBeGreaterThan(second + 300));
    expect(readings.readPosition(book, "offset")).toEqual(saved);

    // The workbook mounts the first sheet's grid again, at the place the reader left it, also
    // when the sheet shows after any look a press started has ended.
    await click("First");
    await showSheet("First");
    await vi.waitFor(() => expect(grid()!.scrollTop).toBeCloseTo(before, 0));

    // A link in the second sheet opens the first one at the linked row, not at the reader's place.
    await userEvent.click(screen.getByRole("tab", { name: "Second" }));
    await showSheet("Second");
    // The grid follows a link once it has laid out its cells, which is when it draws its headers.
    await vi.waitFor(() => {
      const canvas = grid()!.querySelector("canvas")!;
      const [red, , , alpha] = canvas.getContext("2d")!.getImageData(1, 1, 1, 1).data;
      expect(alpha === 255 && red! < 255).toBe(true);
    });
    await userEvent.click(grid()!, { position: { x: 60, y: 30 } });
    await showSheet("First");
    await vi.waitFor(() => expect(grid()!.scrollTop).toBeGreaterThan(4000));
    await userEvent.wheel(grid()!, { delta: { y: 100 } });
    await vi.waitFor(() => expect(reading.saved("book.xlsx", "offset")?.top).toBeGreaterThan(4000));
  });

  it("returns an OpenDocument spreadsheet's first sheet to the reader's row, which a later sheet leaves alone", async () => {
    using reading = await readingSetup("ods");
    const { panel, ref } = reading;
    reading.serve("book.ods", await openDocumentSheet(200));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "book.ods");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const rows = rowsView(screen.container);
    await vi.waitFor(() => expect(rows.scroller()).toBeTruthy(), COLD_VIEWER);
    await rows.wheel(2900);
    await vi.waitFor(() =>
      expect(reading.saved("book.ods", "rendered")?.block).toBeGreaterThan(50),
    );
    const before = rows.topRow();
    expect(before).toBe(reading.saved("book.ods", "rendered")?.block);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:book.ods"));
    await vi.waitFor(() => expect(rows.topRow()).toBe(before), COLD_VIEWER);

    // A revision empties the first sheet; reading the second one leaves the first sheet's row.
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const book = { kind: "path", environmentId, absolutePath: `${reading.cwd}/book.ods` } as const;
    const saved = readings.readPosition(book, "rendered");
    reading.serve("book.ods", await openDocumentSheet(0, 200));
    await act(() => panel.activateSurface(ref, "file:book.ods"));
    await expect.element(screen.getByText("This sheet is empty.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next sheet" }));
    await rows.wheel(700);
    await vi.waitFor(() => expect(rows.topRow()).toBeGreaterThan(10));
    const second = rows.topRow()!;
    await rows.wheel(700);
    await vi.waitFor(() => expect(rows.topRow()).toBeGreaterThan(second + 10));
    expect(readings.readPosition(book, "rendered")).toEqual(saved);
  });
});
