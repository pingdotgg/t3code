import {
  FILE_PREVIEW_SCROLL_SCRIPT,
  injectHtmlRenderBootstrap,
  readFilePreviewScroll,
} from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

import { BrowserDocumentFrame, HtmlRenderDocument } from "./BrowserDocumentFrame";

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

describe("HtmlRenderDocument", () => {
  it("reports the page's first height and ignores messages from other windows", async () => {
    using pageUrl = (() => {
      const page = `<script>parent.postMessage(${JSON.stringify(sizeChanged(321))}, "*");</script>`;
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const onContentHeight = vi.fn();
    await using _screen = await render(
      <HtmlRenderDocument src={pageUrl.url} title="Report" onContentHeight={onContentHeight} />,
    );

    await vi.waitFor(() => expect(onContentHeight).toHaveBeenCalledWith(321));

    // Listeners run in registration order, so once this one sees the message the frame's has too.
    const delivered = new Promise<void>((resolve) =>
      window.addEventListener("message", () => resolve(), { once: true }),
    );
    window.postMessage(sizeChanged(999), "*");
    await delivered;
    expect(onContentHeight).toHaveBeenCalledTimes(1);
  });

  it("opens a clicked image with the other images of its block in the viewer", async () => {
    const swatch = (color: string) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="${color}"/></svg>`,
      )}`;
    const html = injectHtmlRenderBootstrap(
      `<!doctype html><html><body><div>${["Red", "Green", "Blue"]
        .map((name) => `<img alt="${name}" src="${swatch(name.toLowerCase())}">`)
        .join("")}</div></body></html>`,
    );
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    await using screen = await render(<HtmlRenderDocument src={src} title="Swatches" />);

    await page.frameLocator(screen.getByTitle("Swatches")).getByAltText("Green").click();

    const viewer = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(viewer.getByAltText("Green")).toBeVisible();
    await expect.element(viewer.getByRole("button", { name: "Next media" })).toBeVisible();
    await expect.element(viewer.getByRole("button", { name: "Previous media" })).toBeVisible();
  });
});

it("keeps the chat in place when a label far from its hidden radio is clicked", async () => {
  const html = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
    .r > input { position: absolute; opacity: 0; pointer-events: none; }
    .fill { height: 1400px; }
  </style></head><body><div class="r">
    <input type="radio" name="opt" id="opt-a" checked>
    <input type="radio" name="opt" id="opt-b">
    <label for="opt-a">Top A</label><label for="opt-b">Top B</label>
    <div class="fill"></div>
    <label for="opt-a">A</label><label for="opt-b">B</label>
  </div><script>
    document.getElementById("opt-b").addEventListener("change", function() {
      parent.postMessage({ type: "radio-changed", id: "opt-b" }, "*");
    });
  </script></body></html>`);
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const scroller = document.createElement("div");
  scroller.style.cssText = "height: 400px; overflow: auto; width: 728px;";
  const changed = vi.fn();
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  window.addEventListener(
    "message",
    (event) => {
      if (event.data?.type === "radio-changed") changed(event.data.id);
    },
    { signal: messages.signal },
  );
  const contentHeight = vi.fn((height: number) => {
    scroller.style.setProperty("--content-height", `${height}px`);
  });
  await using screen = await render(
    <>
      <style>{`iframe[title="Toggle"] {
        display: block; width: 100%; height: var(--content-height, 120px); border: 0;
      }`}</style>
      <div style={{ height: 600 }} />
      <HtmlRenderDocument src={src} title="Toggle" onContentHeight={contentHeight} />
      <div style={{ height: 100 }} />
    </>,
    { container: scroller },
  );

  const frame = screen.getByTitle("Toggle").element() as HTMLIFrameElement;
  await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBeGreaterThan(1400));
  scroller.scrollTop = scroller.scrollHeight;
  const scrollTop = scroller.scrollTop;

  await page.frameLocator(screen.getByTitle("Toggle")).getByText("B", { exact: true }).click();

  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("opt-b"));
  expect(scroller.scrollTop).toBe(scrollTop);
});

const scrollIntoViewPage = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
  .fill { height: 1400px; }
  .panel { height: 200px; overflow: auto; }
  .card { height: 100px; overflow: hidden; }
  .gap { height: 600px; }
  .card .gap { height: 300px; }
</style></head><body>
  <nav id="top">Index</nav>
  <div class="fill"></div>
  <div class="panel" id="panel"><div class="gap"></div>
    <div class="card" id="card"><div class="gap"></div><p id="deep">Deep</p></div>
  </div>
<script>
  addEventListener("message", function(event) {
    if (event.data?.type !== "scroll-into-view") return;
    document.getElementById(event.data.id).scrollIntoView({ block: "nearest" });
    parent.postMessage({
      type: "scrolled",
      id: event.data.id,
      card: document.getElementById("card").scrollTop,
      panel: document.getElementById("panel").scrollTop,
      page: document.scrollingElement.scrollTop,
    }, "*");
  });
</script></body></html>`);

// Inline chat frames are fitted and contained; the expanded view keeps native scrolling, since
// its dialog scroller is how the page's own navigation reaches a section.
it.each([
  { name: "a fitted inline frame", containScroll: true, fitted: true },
  { name: "a fitted expanded frame", containScroll: false, fitted: true },
  { name: "a capped inline frame", containScroll: true, fitted: false },
])(
  "scrolls only what it should when a page script scrolls into view in $name",
  async (frameCase) => {
    const src = URL.createObjectURL(new Blob([scrollIntoViewPage], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    const scroller = document.createElement("div");
    scroller.style.cssText = "height: 400px; overflow: auto; width: 728px;";
    const scrolled = vi.fn();
    const messages = new AbortController();
    using _messages = { [Symbol.dispose]: () => messages.abort() };
    window.addEventListener(
      "message",
      (event) => {
        if (event.data?.type === "scrolled") scrolled(event.data);
      },
      { signal: messages.signal },
    );
    const contentHeight = vi.fn((height: number) => {
      if (frameCase.fitted) scroller.style.setProperty("--content-height", `${height}px`);
    });
    await using screen = await render(
      <>
        <style>{`iframe[title="Index"] {
        display: block; width: 100%; height: var(--content-height, 300px); border: 0;
      }`}</style>
        <div style={{ height: 600 }} />
        <HtmlRenderDocument
          src={src}
          title="Index"
          containScroll={frameCase.containScroll}
          onContentHeight={contentHeight}
        />
        <div style={{ height: 100 }} />
      </>,
      { container: scroller },
    );

    const frame = screen.getByTitle("Index").element() as HTMLIFrameElement;
    await vi.waitFor(() => expect(contentHeight).toHaveBeenCalled());
    if (frameCase.fitted) {
      await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBeGreaterThan(1400));
    }
    scroller.scrollTop = scroller.scrollHeight;
    const scrollTop = scroller.scrollTop;

    frame.contentWindow?.postMessage({ type: "scroll-into-view", id: "deep" }, "*");
    await vi.waitFor(() =>
      expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ id: "deep" })),
    );
    const deep = scrolled.mock.lastCall?.[0];
    // Every scroller inside the page moves, as the browser would: the clipped card, its panel,
    // and in a capped frame the page itself.
    expect(deep.card).toBeGreaterThan(0);
    expect(deep.panel).toBeGreaterThan(0);
    if (!frameCase.fitted) expect(deep.page).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(scrollTop);

    frame.contentWindow?.postMessage({ type: "scroll-into-view", id: "top" }, "*");
    await vi.waitFor(() =>
      expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ id: "top" })),
    );
    if (frameCase.containScroll) expect(scroller.scrollTop).toBe(scrollTop);
    else expect(scroller.scrollTop).toBeLessThan(scrollTop);
  },
);

it("keeps the first and last selected card rings inside the fitted renderer frame", async () => {
  const html = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
    main { display: grid; gap: 12px; }
    button { box-sizing: border-box; width: 100%; height: 72px; border: 0; }
    button[aria-pressed="true"] { outline: 3px solid blue; outline-offset: 2px; }
  </style></head><body><main>
    <button id="first" aria-pressed="false">Meadow</button>
    <button id="middle" aria-pressed="false">Harbor</button>
    <button id="last" aria-pressed="false">Orchid</button>
  </main><script>
    document.querySelectorAll("button").forEach(function(button) {
      button.addEventListener("click", function() {
        document.querySelectorAll("button").forEach(function(card) {
          card.setAttribute("aria-pressed", String(card === button));
        });
      });
    });
    window.addEventListener("message", function(event) {
      if (event.source !== window.parent || event.data.type !== "select-card") return;
      var button = document.getElementById(event.data.id);
      button.click();
      var rect = button.getBoundingClientRect();
      var style = getComputedStyle(button);
      var ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      window.parent.postMessage({
        type: "selected-card-bounds",
        id: button.id,
        selected: button.getAttribute("aria-pressed") === "true",
        ring: ring,
        left: rect.left - ring,
        right: rect.right + ring,
        top: rect.top - ring,
        bottom: rect.bottom + ring,
        pageHeight: document.documentElement.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth
      }, "*");
    });
  </script></body></html>`);
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const container = document.createElement("div");
  container.style.width = "728px";
  const reports = new Map<
    string,
    {
      selected: boolean;
      ring: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
      pageHeight: number;
      viewportHeight: number;
      viewportWidth: number;
      scrollWidth: number;
    }
  >();
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  window.addEventListener(
    "message",
    (event) => {
      const frame = container.querySelector("iframe");
      if (event.source === frame?.contentWindow && event.data?.type === "selected-card-bounds") {
        reports.set(event.data.id, event.data);
      }
    },
    { signal: messages.signal },
  );
  const contentHeight = vi.fn((height: number) => {
    container.style.setProperty("--content-height", `${height}px`);
  });
  await using screen = await render(
    <>
      <style>{`iframe[title="Edge cards"] {
        display: block; width: 100%; height: var(--content-height, 120px); border: 0;
      }`}</style>
      <HtmlRenderDocument src={src} title="Edge cards" onContentHeight={contentHeight} />
    </>,
    { container },
  );

  await vi.waitFor(() => expect(contentHeight).toHaveBeenCalled());
  const frame = screen.getByTitle("Edge cards").element() as HTMLIFrameElement;
  await vi.waitFor(() => {
    expect(frame.getBoundingClientRect().height).toBe(contentHeight.mock.lastCall?.[0]);
  });

  for (const id of ["first", "last"]) {
    frame.contentWindow?.postMessage({ type: "select-card", id }, "*");
    await vi.waitFor(() => expect(reports.get(id)?.selected).toBe(true));
    const bounds = reports.get(id)!;
    expect(bounds.ring).toBe(5);
    expect(bounds.viewportWidth).toBe(728);
    expect(bounds.pageHeight).toBe(contentHeight.mock.lastCall?.[0]);
    expect(bounds.viewportHeight).toBe(bounds.pageHeight);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.viewportWidth);
  }
});

describe("BrowserDocumentFrame", () => {
  it("keeps a page on screen until its next revision has loaded", async () => {
    using pages = (() => {
      const urls = ["first", "second", "third"].map((name) =>
        URL.createObjectURL(new Blob([`<p>${name}</p>`], { type: "text/html" })),
      );
      return { urls, [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
    })();
    const [first, second, third] = pages.urls as [string, string, string];
    const frame = (revision: string, src: string) => (
      <div className="flex h-75 w-100 flex-col">
        <BrowserDocumentFrame
          src={src}
          title="Report"
          pdf={false}
          documentKey={`report:${revision}`}
          documentId="report"
        />
      </div>
    );
    await using screen = await render(frame("1", first));
    const srcs = () => Array.from(screen.container.querySelectorAll("iframe"), (f) => f.src);
    const onScreen = () => {
      const box = screen.container.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 10);
      return hit instanceof HTMLIFrameElement ? hit.src : null;
    };
    await vi.waitFor(() => expect(onScreen()).toBe(first));

    // The incoming frame cannot have loaded when it is inserted, so the current page must cover it.
    const atInsertion = new Promise<string | null>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!srcs().includes(second)) return;
        observer.disconnect();
        resolve(onScreen());
      });
      observer.observe(screen.container, { childList: true, subtree: true });
    });
    await screen.rerender(frame("2", second));
    expect(await atInsertion).toBe(first);
    await vi.waitFor(() => expect(srcs()).toEqual([second]));
    expect(onScreen()).toBe(second);

    await screen.rerender(frame("3", third));
    await screen.rerender(frame("2", second));
    expect(srcs(), "returning to the shown revision kept the pending frame").toEqual([second]);
    await screen.rerender(frame("3", third));
    await vi.waitFor(() => expect(onScreen()).toBe(third));
  });

  it("opens the next revision where the reader left the page", async () => {
    // The first page scrolls itself, as a reader would; the second is served without scrolling.
    const tall = '<div style="height:5000px">report</div>';
    using pages = (() => {
      const urls = [
        `${tall}<script>addEventListener("load",()=>scrollTo(0,1200))</script>`,
        tall,
      ].map((body) =>
        URL.createObjectURL(new Blob([body + FILE_PREVIEW_SCROLL_SCRIPT], { type: "text/html" })),
      );
      return { urls, [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
    })();
    const [first, second] = pages.urls as [string, string];
    const reports: Array<{ source: MessageEventSource | null; y: number }> = [];
    const onMessage = (event: MessageEvent) => {
      const scroll = readFilePreviewScroll(event.data);
      if (scroll !== undefined) reports.push({ source: event.source, y: scroll.y });
    };
    window.addEventListener("message", onMessage);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", onMessage) };
    const frame = (revision: string, src: string) => (
      <div className="flex h-75 w-100 flex-col">
        <BrowserDocumentFrame
          src={src}
          title="Report"
          pdf={false}
          documentKey={`report:${revision}`}
          documentId="report"
        />
      </div>
    );
    await using screen = await render(frame("1", first));
    const iframes = () => Array.from(screen.container.querySelectorAll("iframe"));
    await vi.waitFor(() => expect(reports.map((report) => report.y)).toContain(1200));

    await screen.rerender(frame("2", second));
    await vi.waitFor(() => expect(iframes().map((element) => element.src)).toEqual([second]));
    const shown = iframes()[0]!.contentWindow;
    expect(
      reports.filter((report) => report.source === shown).map((report) => report.y),
      "the next revision was uncovered before it took the reader's position",
    ).toContain(1200);
  });
});
