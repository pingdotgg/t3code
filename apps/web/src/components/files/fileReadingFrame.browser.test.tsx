import { FILE_PREVIEW_SCROLL_SCRIPT, readFilePreviewScroll } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";

import { BrowserDocumentFrame } from "./BrowserDocumentFrame";
import { type FileReadingKey, readings, usePdfReadingView } from "./fileReadingSave";

const environmentId = "file-reading-frame-test";
const TALL_PAGE =
  '<div style="height:6000px">report</div><script>addEventListener("message",(e)=>{if(typeof e.data?.scrollTo==="number")scrollTo(0,e.data.scrollTo)})</script>';

/** Revisions of one HTML file in the right panel's frame, with the pages' messages recorded. */
function htmlPages(name: string) {
  const readingKey = {
    kind: "path",
    environmentId,
    absolutePath: `/reading/${name}/page.html`,
  } as const;
  const urls: string[] = [];
  const messages: Array<{ source: MessageEventSource | null; data: unknown }> = [];
  const onMessage = (event: MessageEvent) => {
    messages.push({ source: event.source, data: event.data });
  };
  window.addEventListener("message", onMessage);
  const reports = (source: MessageEventSource | null) =>
    messages.flatMap((message) => {
      const scroll = message.source === source ? readFilePreviewScroll(message.data) : undefined;
      return scroll === undefined ? [] : [scroll.y];
    });
  return {
    readingKey,
    saved: () => readings.readPosition(readingKey, "offset")?.top,
    stored: () =>
      localStorage.getItem(
        `t3code.fileReading.v1:${JSON.stringify([environmentId, readingKey.absolutePath, "offset"])}`,
      ),
    /** A page that posts `loaded:<name>` on load; `bridge` adds the scroll script. */
    url(name: string, body = TALL_PAGE, options = { bridge: true }) {
      const loaded = `<script>addEventListener("load",()=>parent.postMessage("loaded:${name}","*"))</script>`;
      const html = body + loaded + (options.bridge ? FILE_PREVIEW_SCROLL_SCRIPT : "");
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      urls.push(url);
      return url;
    },
    page: (revision: string, src: string) => (
      <div className="flex h-75 w-100 flex-col">
        <BrowserDocumentFrame
          src={src}
          title="Page"
          pdf={false}
          documentKey={`page:${revision}`}
          documentId="page"
          readingKey={readingKey}
        />
      </div>
    ),
    loaded: (name: string) => messages.some((message) => message.data === `loaded:${name}`),
    scrollPage: (frame: HTMLIFrameElement, y: number) =>
      frame.contentWindow?.postMessage({ scrollTo: y }, "*"),
    reports,
    lastY: (source: MessageEventSource | null) => reports(source).at(-1),
    /** The frames' URLs, the page on screen last. */
    sources: (root: HTMLElement) =>
      Array.from(root.querySelectorAll("iframe"), (frame) => frame.src),
    shown: (root: HTMLElement) => Array.from(root.querySelectorAll("iframe")).at(-1)!,
    [Symbol.dispose]() {
      window.removeEventListener("message", onMessage);
      for (const url of urls) URL.revokeObjectURL(url);
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("t3code.fileReading.v1:")) localStorage.removeItem(key);
      }
    },
  };
}

/** Keeps the frame load event for `src` from the app, as a subresource that never finishes does. */
function stallLoad(src: string) {
  let stalled: HTMLIFrameElement | null = null;
  // A frame's load event reaches the document but not the window.
  const hold = (event: Event) => {
    if (stalled !== null || !(event.target instanceof HTMLIFrameElement)) return;
    if (event.target.src !== src) return;
    stalled = event.target;
    event.stopPropagation();
  };
  document.addEventListener("load", hold, true);
  const stop = () => document.removeEventListener("load", hold, true);
  return {
    release() {
      stop();
      stalled?.dispatchEvent(new Event("load"));
    },
    [Symbol.dispose]: stop,
  };
}

describe("an HTML file's frame keeps the reader's place", () => {
  it("returns an HTML page to the reader's place, and a page shorter at load keeps that place", async () => {
    using pages = htmlPages("html");
    const first = pages.url("first");
    // This page is short when it loads, then grows without scrolling, as late content does.
    const second = pages.url(
      "second",
      `<div id="body" style="height:1000px">report</div><script>addEventListener("load",()=>setTimeout(()=>{document.getElementById("body").style.height="6000px"},100))</script>`,
    );
    await using screen = await render(pages.page("1", first));
    await vi.waitFor(() => expect(pages.loaded("first")).toBe(true));
    await userEvent.wheel(pages.shown(screen.container), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(pages.saved()).toBeGreaterThan(2000));

    await screen.rerender(<></>);
    const stored = pages.stored();
    const saved = pages.saved();
    await screen.rerender(pages.page("2", second));
    await vi.waitFor(() => {
      expect(pages.lastY(pages.shown(screen.container).contentWindow)).toBe(saved);
    });
    expect(pages.stored()).toBe(stored);
  });

  it("saves an HTML page once a later revision takes the place a stalled first page never took", async () => {
    using pages = htmlPages("html-stalled");
    readings.writePosition(pages.readingKey, { view: "offset", top: 1500, left: 0 });
    const [first, second] = [pages.url("first"), pages.url("second")];
    using _stall = stallLoad(first);
    await using screen = await render(pages.page("1", first));
    await vi.waitFor(() => expect(pages.loaded("first")).toBe(true));

    await screen.rerender(pages.page("2", second));
    await vi.waitFor(() => expect(pages.sources(screen.container)).toEqual([second]));
    const shown = pages.shown(screen.container);
    await vi.waitFor(() => expect(pages.lastY(shown.contentWindow)).toBe(1500));
    // The page scrolls itself: a wheel sent as the frame is revealed can miss it.
    pages.scrollPage(shown, 3500);
    await vi.waitFor(() => expect(pages.saved()).toBe(3500));
  });

  it("keeps an HTML revision where the reader scrolled it after a stalled swap showed it, in a later revision too", async () => {
    using pages = htmlPages("html-early");
    readings.writePosition(pages.readingKey, { view: "offset", top: 1500, left: 0 });
    const [first, second, third] = [pages.url("first"), pages.url("second"), pages.url("third")];
    await using screen = await render(pages.page("1", first));
    await vi.waitFor(() => expect(pages.loaded("first")).toBe(true));
    using stall = stallLoad(second);
    using _timers = fakeTimers();
    await screen.rerender(pages.page("2", second));
    await vi.waitFor(() => expect(pages.loaded("second")).toBe(true));
    await act(() => vi.advanceTimersByTime(5_000));
    await vi.waitFor(() => expect(pages.sources(screen.container)).toEqual([second]));
    const content = pages.shown(screen.container).contentWindow;
    // The reader scrolls the page on screen, which the parent sees only through its reports.
    pages.scrollPage(pages.shown(screen.container), 3000);
    await vi.waitFor(() => expect(pages.lastY(content)).toBeGreaterThan(2500));
    const place = pages.lastY(content);
    expect(pages.saved()).toBe(1500);

    stall.release();
    expect(pages.saved()).toBe(place);
    await screen.rerender(pages.page("3", third));
    await vi.waitFor(() => expect(pages.sources(screen.container)).toEqual([third]));
    await vi.waitFor(() => {
      expect(pages.lastY(pages.shown(screen.container).contentWindow)).toBe(place);
    });
    expect(pages.reports(content).every((y) => y !== 1500)).toBe(true);
  });

  it("stalls once for an HTML page without the scroll script, then shows later revisions on load", async () => {
    using pages = htmlPages("html-plain");
    readings.writePosition(pages.readingKey, { view: "offset", top: 1500, left: 0 });
    const [first, second, third] = ["first", "second", "third"].map((name) =>
      pages.url(name, undefined, { bridge: false }),
    ) as [string, string, string];
    await using screen = await render(pages.page("1", first));
    await vi.waitFor(() => expect(pages.loaded("first")).toBe(true));
    using _timers = fakeTimers();

    await screen.rerender(pages.page("2", second));
    await vi.waitFor(() => expect(pages.loaded("second")).toBe(true));
    expect(pages.sources(screen.container)).toEqual([second, first]);
    act(() => vi.advanceTimersByTime(5_000));
    await vi.waitFor(() => expect(pages.sources(screen.container)).toEqual([second]));
    // Each check advances the fake clock by its interval, far short of another 5 s stall.
    await screen.rerender(pages.page("3", third));
    await vi.waitFor(() => expect(pages.sources(screen.container)).toEqual([third]));
  });

  it("saves nothing from a page the HTML frame navigates to", async () => {
    using pages = htmlPages("html-away");
    const elsewhere = `data:text/html,${encodeURIComponent(
      `<div style="height:6000px">elsewhere</div>${FILE_PREVIEW_SCROLL_SCRIPT}<script>addEventListener("load",()=>scrollTo(0,4321))</script>`,
    )}`;
    const first = pages.url(
      "first",
      `${TALL_PAGE}<script>addEventListener("message",(e)=>{if(e.data==="leave")location.href=${JSON.stringify(elsewhere)}})</script>`,
    );
    await using screen = await render(pages.page("1", first));
    await vi.waitFor(() => expect(pages.loaded("first")).toBe(true));
    const content = pages.shown(screen.container).contentWindow!;
    await userEvent.wheel(pages.shown(screen.container), { delta: { y: 1000 } });
    await vi.waitFor(() => expect(pages.saved()).toBeGreaterThan(500));
    const place = pages.saved();

    content.postMessage("leave", "*");
    await vi.waitFor(() => expect(pages.lastY(content)).toBe(4321));
    expect(pages.saved()).toBe(place);
  });
});

describe("PDF reading view", () => {
  function PdfView(props: {
    readonly file: FileReadingKey;
    readonly onView: (page: number) => void;
  }) {
    const [view, setView] = usePdfReadingView(props.file);
    props.onView(view.page);
    return (
      <button type="button" onClick={() => setView({ page: 2, offset: 40, zoom: 1.5, left: 0 })}>
        Go to page 3
      </button>
    );
  }

  it("seeds a new PDF.js mount with the page saved by an earlier one", async () => {
    const file = { kind: "path", environmentId, absolutePath: "/reading/pdf/report.pdf" } as const;
    const pages: number[] = [];
    try {
      {
        await using screen = await render(
          <PdfView file={file} onView={(page) => pages.push(page)} />,
        );
        await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
        await vi.waitFor(() => expect(pages.at(-1)).toBe(2));
      }
      pages.length = 0;
      await using screen = await render(
        <PdfView file={file} onView={(page) => pages.push(page)} />,
      );
      await expect.element(screen.getByRole("button")).toBeVisible();
      expect(pages[0]).toBe(2);
    } finally {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("t3code.fileReading.v1:")) localStorage.removeItem(key);
      }
    }
  });

  it("keeps the browser's own viewer for a PDF without a reading key, on its first URL until the file changes", async () => {
    using _native = vi.spyOn(navigator, "pdfViewerEnabled", "get").mockReturnValue(true);
    const [original, renewed, edited] = ["%PDF-1.4", "%PDF-1.4", "%PDF-1.4 edited"].map((text) =>
      URL.createObjectURL(new Blob([text], { type: "application/pdf" })),
    ) as [string, string, string];
    const draft = (src: string, revision: string) => (
      <BrowserDocumentFrame
        src={src}
        title="Draft PDF"
        pdf
        documentKey={`draft:${revision}`}
        documentId="draft"
      />
    );
    try {
      await using screen = await render(draft(original, "one"));
      const opened = screen.container.querySelector("iframe");
      expect(opened?.src.startsWith(original)).toBe(true);

      // A renewed grant for the same revision keeps the frame and the URL it opened with.
      await screen.rerender(draft(renewed, "one"));
      expect(screen.container.querySelector("iframe")).toBe(opened);
      expect(opened?.src.startsWith(original)).toBe(true);

      await screen.rerender(draft(edited, "two"));
      const reloaded = screen.container.querySelector("iframe");
      expect(reloaded).not.toBe(opened);
      expect(reloaded?.src.startsWith(edited)).toBe(true);
    } finally {
      for (const url of [original, renewed, edited]) URL.revokeObjectURL(url);
    }
  });
});
