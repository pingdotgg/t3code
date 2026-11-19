// Shared setup for the right panel's reading tests. A test file mocks the panel's modules with
// `fileReadingTestMocks` before it imports this kit.
import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ChatFileAttachment,
  EnvironmentId,
  type ProjectReadFileResult,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { expect, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import appCss from "~/index.css?inline";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import FilePreviewPanel from "./FilePreviewPanel";
import { resetState, state } from "./fileReadingTestMocks";

export { state };

export const environmentId = EnvironmentId.make("file-reading-position-test");
// Each mount of the text viewer starts its indexing worker cold, slow on a busy machine.
export const COLD_WORKER = { timeout: 10_000 };

type SavedView = "source" | "rendered" | "pdf" | "offset" | "media";

export function sourceFile(
  relativePath: string,
  word: string,
  lines: number,
): ProjectReadFileResult {
  const contents = Array.from(
    { length: lines },
    (_, index) => `const ${word}_${index + 1} = ${index + 1};`,
  ).join("\n");
  return { relativePath, contents, byteLength: contents.length, truncated: false };
}

/** A thread whose right panel reads files under `/reading/<name>`, and its saved places. */
export async function readingSetup(name: string) {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  const settings = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = settings.map((key) => localStorage.getItem(key));
  localStorage.setItem(settings[0]!, "false");
  localStorage.setItem(settings[1]!, "true");
  resetState();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  const doc = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  state.files = {
    "a.ts": sourceFile("a.ts", "alpha", 300),
    "b.ts": sourceFile("b.ts", "beta", 300),
    "c.ts": sourceFile("c.ts", "gamma", 10),
    "doc.md": { relativePath: "doc.md", contents: doc, byteLength: doc.length, truncated: false },
  };
  const ref = scopeThreadRef(environmentId, ThreadId.make(`reading-${name}`));
  const cwd = `/reading/${name}`;
  const urls: string[] = [];
  const stored = (key: string) =>
    JSON.parse(localStorage.getItem(`t3code.fileReading.v1:${key}`) ?? "null") as {
      line?: number;
      offset?: number;
      block?: number;
      page?: number;
      top?: number;
      left?: number;
      time?: number;
      at: number;
    } | null;
  return {
    ref,
    cwd,
    panel: useRightPanelStore.getState(),
    saved: (path: string, view: SavedView) =>
      stored(JSON.stringify([environmentId, `${cwd}/${path}`, view])),
    attachmentSaved: (id: string, view: SavedView) =>
      stored(JSON.stringify([environmentId, { attachment: id }, view])),
    /** Serves `contents` at the file's asset URL; the fragment keeps the panel's query off the blob. */
    serve(path: string, contents: Blob | string) {
      const url = URL.createObjectURL(contents instanceof Blob ? contents : new Blob([contents]));
      urls.push(url);
      state.assets[`${cwd}/${path}`] = `${url}#asset`;
    },
    /** Serves an attachment by its id. */
    attach(attachment: ChatFileAttachment, contents: Blob | string) {
      const url = URL.createObjectURL(contents instanceof Blob ? contents : new Blob([contents]));
      urls.push(url);
      state.assets[attachment.id] = url;
    },
    [Symbol.dispose]() {
      for (const url of urls) URL.revokeObjectURL(url);
      useRightPanelStore.getState().removeThread(ref);
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("t3code.fileReading.v1:") || key.startsWith("t3code.fileReveal.v1:")) {
          localStorage.removeItem(key);
        }
      }
      style.remove();
      for (const [index, key] of settings.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

const noop = () => {};

function Panel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly attachment?: ChatFileAttachment;
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly width: number | undefined;
  readonly workspaceMutationId: string | null;
}) {
  return (
    <div style={{ display: "flex", height: 400, width: props.width ?? 700 }}>
      <FilePreviewPanel
        environmentId={environmentId}
        cwd={props.cwd}
        projectName="Project"
        relativePath={props.relativePath}
        {...(props.attachment === undefined ? {} : { attachment: props.attachment })}
        threadRef={props.threadRef}
        composerDraftTarget={props.threadRef}
        keybindings={[]}
        availableEditors={[]}
        openInShortcutEnabled={false}
        revealLine={props.revealLine}
        revealRequestId={props.revealRequestId}
        onOpenFile={noop}
        onNavigateFolder={noop}
        folderTrail={undefined}
        onPendingChange={noop}
        selectedFilePending={false}
        workspaceMutationId={props.workspaceMutationId}
      />
    </div>
  );
}

/** Renders the active file tab the way the right panel does: one panel per workspace. */
export function ReadingPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly width?: number;
  readonly workspaceMutationId?: string;
}) {
  const surface = useRightPanelStore((store) =>
    selectActiveRightPanelSurface(store.byThreadKey, props.threadRef),
  );
  return surface?.kind === "file" ? (
    <Panel
      threadRef={props.threadRef}
      cwd={props.cwd}
      relativePath={surface.relativePath}
      revealLine={surface.revealLine}
      revealRequestId={surface.revealRequestId}
      width={props.width}
      workspaceMutationId={props.workspaceMutationId ?? null}
    />
  ) : null;
}

/** A chat attachment open in the right panel. */
export function AttachmentPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly attachment: ChatFileAttachment;
}) {
  return (
    <Panel
      threadRef={props.threadRef}
      cwd={props.cwd}
      relativePath={props.attachment.name}
      attachment={props.attachment}
      revealLine={null}
      revealRequestId={0}
      width={undefined}
      workspaceMutationId={null}
    />
  );
}

export function sourceView(container: HTMLElement) {
  const scroller = () => container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
  const line = (lineNumber: number) =>
    container
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${lineNumber}"]`) ?? null;
  return {
    scroller,
    line,
    /** The first row the viewport shows, partly or fully, and its top relative to the viewport. */
    topLine() {
      const top = scroller().getBoundingClientRect().top;
      const rows = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll("[data-line]");
      const row = [...(rows ?? [])]
        .filter((element) => element.getBoundingClientRect().bottom > top + 0.5)
        .sort(
          (left, right) =>
            Number(left.getAttribute("data-line")) - Number(right.getAttribute("data-line")),
        )[0];
      return {
        line: Number(row?.getAttribute("data-line")),
        offset: Math.round(row!.getBoundingClientRect().top - top),
      };
    },
    expectLineInView(lineNumber: number, text: string) {
      const element = line(lineNumber);
      expect(element?.textContent).toContain(text);
      const view = scroller().getBoundingClientRect();
      const rect = element!.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(view.top - 1);
      expect(rect.bottom).toBeLessThanOrEqual(view.bottom + 1);
    },
  };
}

/** Rows of the large text and table viewer, by their data index. */
export function rowsView(container: HTMLElement) {
  const scroller = () => container.querySelector<HTMLElement>("[aria-rowcount] > [tabindex]");
  return {
    scroller,
    /** The data index of the first row the viewport shows. */
    topRow() {
      const element = scroller();
      if (element === null) return null;
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>("[data-preview-row]")].find(
        (candidate) => candidate.getBoundingClientRect().bottom > top + 0.5,
      );
      return row === undefined ? null : Number(row.dataset.previewRow);
    },
    indexed() {
      const status = container.querySelector('[role="status"]')?.textContent ?? "";
      expect(status).toMatch(/lines|rows/);
      expect(status).not.toContain("Indexing");
    },
    /** userEvent finds the scroller again by its text, so rows the worker has not filled yet would lose it. */
    async wheel(y: number) {
      await vi.waitFor(() => {
        const shown = [...scroller()!.querySelectorAll("[data-preview-row]")];
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.filter((row) => /^\d+$/.test(row.textContent ?? ""))).toEqual([]);
      }, COLD_WORKER);
      await userEvent.wheel(scroller()!, { delta: { y } });
    },
  };
}

/** The first item a scroller shows, and how far its top sits above the scroller's top. */
export function firstShown(scroller: HTMLElement, items: string) {
  const top = scroller.getBoundingClientRect().top;
  const elements = [...scroller.querySelectorAll(items)];
  const index = elements.findIndex((item) => item.getBoundingClientRect().bottom > top + 0.5);
  return {
    index,
    offset: Math.round(top - (elements[index]?.getBoundingClientRect().top ?? top)),
  };
}

export function csv(rows: number) {
  return ["name,value", ...Array.from({ length: rows }, (_, index) => `row ${index + 1},${index}`)]
    .join("\n")
    .concat("\n");
}

export function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `log line ${index + 1}`).join("\n");
}

/** A large text file the panel streams from its asset URL. */
export function largeText(
  reading: { readonly serve: (path: string, contents: string) => void },
  path: string,
  contents: string,
) {
  reading.serve(path, contents);
  state.files[path] = { relativePath: path, contents, byteLength: 2_000_000, truncated: true };
}

/**
 * Holds back the large text worker's finished index until `release`, as a long file does; rows
 * the worker has read still show and scroll. `hold` holds the next workers' indexes again.
 */
export function holdIndexing() {
  const Native = window.Worker;
  const held: Array<() => void> = [];
  let holding = true;
  class HoldingWorker extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      // The first listener, so it can keep the finished index from the viewer's own.
      this.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (!holding || !isFinishedIndex(data)) return;
        event.stopImmediatePropagation();
        held.push(() => this.dispatchEvent(new MessageEvent("message", { data })));
      });
    }
  }
  window.Worker = HoldingWorker;
  return {
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      for (const deliver of held.splice(0)) deliver();
    },
    [Symbol.dispose]() {
      window.Worker = Native;
    },
  };
}

const isFinishedIndex = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "meta" &&
  "complete" in data &&
  data.complete === true;

/** A PDF of letter pages, each saying which page it is. */
export function letterPdf(pages: number) {
  const font = 3 + pages * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`,
    ...Array.from({ length: pages }, (_, index) => {
      const text = `BT /F1 24 Tf 72 700 Td (Page ${index + 1}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
        `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      ];
    }).flat(),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: "application/pdf" });
}

/** Ten seconds of 8 kHz silence, which audio and video elements load with a known duration. */
export function silentWav() {
  const rate = 8000;
  const samples = rate * 10;
  const bytes = new Uint8Array(44 + samples).fill(128);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  return new Blob([bytes], { type: "audio/wav" });
}

/** Marks a media element used, as a reader pressing its native controls does. */
export function pressMedia(media: HTMLMediaElement) {
  media.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  media.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

/** Seeks a media element as a reader pressing its native controls would. */
export async function seekAsReader(media: HTMLMediaElement, time: number) {
  pressMedia(media);
  const seeked = new Promise((resolve) =>
    media.addEventListener("seeked", resolve, { once: true }),
  );
  media.currentTime = time;
  await seeked;
}
