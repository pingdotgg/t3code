import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

import { HtmlRenderDocument } from "./BrowserDocumentFrame";

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

  it("cancels clicks on non-web links so the report is not navigated away", async () => {
    const html = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
      a { position: fixed; left: 0; right: 0; height: 20vh; display: block; }
      #thread { top: 0; } #mail { top: 20vh; } #download { top: 40vh; } #script { top: 60vh; }
      #thread-download { top: 80vh; }
    </style></head><body>
      <a id="thread" href="t3-thread://v2/environment-1/thread-1">Open owner</a>
      <a id="mail" href="mailto:someone@example.com">Mail owner</a>
      <a id="download" href="data:text/plain,report" download="report.txt">Download</a>
      <a id="script" href="javascript:void(0)">Run</a>
      <a id="thread-download" href="t3-thread://v2/environment-1/thread-2" download>Open other</a>
    <script>
      document.addEventListener("click", function(event) {
        var link = event.target.closest("a");
        parent.postMessage({ type: "link-click", id: link && link.id, defaultPrevented: event.defaultPrevented }, "*");
      });
      parent.postMessage({ type: "ready" }, "*");
    </script></body></html>`);
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    const clicks: Array<{ id: string; defaultPrevented: boolean }> = [];
    const messages = new AbortController();
    using _messages = { [Symbol.dispose]: () => messages.abort() };
    const ready = new Promise<void>((resolve) =>
      window.addEventListener(
        "message",
        (event) => {
          if (event.data?.type === "ready") resolve();
          if (event.data?.type === "link-click") clicks.push(event.data);
        },
        { signal: messages.signal },
      ),
    );
    await using screen = await render(
      <>
        <style>{`iframe[title="Links"] { display: block; width: 400px; height: 200px; border: 0; }`}</style>
        <HtmlRenderDocument src={src} title="Links" onContentHeight={() => {}} />
      </>,
    );
    await ready;

    const frame = screen.getByTitle("Links");
    for (const y of [20, 60, 100, 140, 180]) {
      await userEvent.click(frame, { position: { x: 200, y } });
    }

    await vi.waitFor(() =>
      expect(clicks).toEqual([
        { type: "link-click", id: "thread", defaultPrevented: true },
        { type: "link-click", id: "mail", defaultPrevented: true },
        { type: "link-click", id: "download", defaultPrevented: false },
        { type: "link-click", id: "script", defaultPrevented: false },
        { type: "link-click", id: "thread-download", defaultPrevented: true },
      ]),
    );
  });
});

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
