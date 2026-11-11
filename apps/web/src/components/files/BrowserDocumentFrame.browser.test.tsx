import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { useRef, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";
import { HtmlRenderDialog } from "../chat/HtmlRenderDialog";

import {
  HtmlRenderAskButton,
  HtmlRenderDocument,
  type HtmlRenderDocumentHandle,
} from "./BrowserDocumentFrame";

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

function AskableEmbed({
  src,
  onAskInSideChat,
}: {
  src: string;
  onAskInSideChat: (text: string) => void;
}) {
  const documentRef = useRef<HtmlRenderDocumentHandle>(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  return (
    <>
      <HtmlRenderDocument
        ref={documentRef}
        onBridgeReady={() => setBridgeReady(true)}
        src={src}
        title="State diagram"
        onAskInSideChat={onAskInSideChat}
      />
      {bridgeReady ? (
        <HtmlRenderAskButton onClick={() => documentRef.current?.askInSideChat()} />
      ) : null}
    </>
  );
}

it("asks about a trusted selection inside the sandboxed embed", async () => {
  const html =
    injectHtmlRenderBootstrap(`<div id="scroller" style="height:80px;overflow:auto"><p id="selection-text" style="height:800px">observation space</p></div><script>
    window.addEventListener("message", function(event) {
      if (event.data === "clear-selection") { window.getSelection().removeAllRanges(); return; }
      if (event.data === "scroll-selection") { document.getElementById("scroller").scrollTop = 80; return; }
      if (event.data === "handle-selection" || event.data === "restore-selection") {
        var node = document.getElementById("selection-text").firstChild;
        var range = document.createRange();
        if (event.data === "handle-selection") range.setStart(node, 12), range.setEnd(node, 17);
        else range.selectNodeContents(document.getElementById("selection-text"));
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
      if (event.data === "move-selection") { parent.postMessage({ jsonrpc: "2.0", method: "t3/notifications/selection-changed", params: { text: "observation space", rect: { x: 8, y: 100000 } } }, "*"); return; }
      if (event.data !== "forge-selection") return;
      parent.postMessage({ jsonrpc: "2.0", method: "t3/notifications/selection-changed", params: { text: "forged", rect: { x: 8, y: 8 } } }, "*");
    });
  </script>`);
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const onAskInSideChat = vi.fn();
  const onContentHeight = vi.fn();
  await using screen = await render(
    <div data-testid="embed-scroll-container" style={{ height: 260, overflow: "auto" }}>
      <div style={{ paddingLeft: 400 }}>
        <button type="button">Outside embed</button>
      </div>
      <HtmlRenderDocument
        src={src}
        title="Selection diagram"
        onAskInSideChat={onAskInSideChat}
        onContentHeight={onContentHeight}
      />
      <div style={{ height: 400 }} />
    </div>,
  );
  await vi.waitFor(() => expect(onContentHeight).toHaveBeenCalled());
  const frame = screen.getByTitle("Selection diagram").element() as HTMLIFrameElement;
  const forged = new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.params?.text !== "forged") return;
      window.removeEventListener("message", onMessage);
      resolve();
    };
    window.addEventListener("message", onMessage);
  });
  await act(async () => {
    frame.contentWindow?.postMessage("forge-selection", "*");
    await forged;
  });
  await expect
    .element(page.getByRole("button", { name: "Ask in side chat" }))
    .not.toBeInTheDocument();
  await screen.getByTitle("Selection diagram").click();
  await userEvent.keyboard("{Control>}a{/Control}");
  const ask = page.getByRole("button", { name: "Ask in side chat" });
  await expect.element(ask).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Cite selection in composer" }))
    .not.toBeInTheDocument();
  const scroller = screen.getByTestId("embed-scroll-container").element();
  const frameTop = frame.getBoundingClientRect().top;
  scroller.scrollTop = 50;
  await vi.waitFor(() => expect(frame.getBoundingClientRect().top).toBe(frameTop - 50));
  expect(document.activeElement).toBe(frame);
  await expect.element(ask).not.toBeInTheDocument();
  await userEvent.keyboard("{Control>}a{/Control}");
  await expect.element(ask).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(ask).not.toBeInTheDocument();
  await userEvent.keyboard("{Control>}a{/Control}");
  await expect.element(ask).toBeVisible();
  frame.contentWindow?.postMessage("scroll-selection", "*");
  await expect.element(ask).not.toBeInTheDocument();
  await userEvent.keyboard("{Control>}a{/Control}");
  await expect.element(ask).toBeVisible();
  await screen.getByRole("button", { name: "Outside embed" }).click();
  await expect.element(ask).not.toBeInTheDocument();
  await screen.getByTitle("Selection diagram").click();
  await userEvent.keyboard("{Control>}a{/Control}");
  await expect.element(ask).toBeVisible();
  {
    let posted: unknown;
    const listening = new AbortController();
    using _listening = { [Symbol.dispose]: () => listening.abort() };
    window.addEventListener(
      "message",
      (event) => {
        if (
          event.source === frame.contentWindow &&
          event.data?.method === "t3/notifications/selection-changed"
        )
          posted = event.data.params?.text;
      },
      { signal: listening.signal },
    );
    using _active = vi.spyOn(navigator.userActivation, "isActive", "get").mockReturnValue(true);
    frame.contentWindow?.postMessage("handle-selection", "*");
    await vi.waitFor(() => expect(posted).toBe("space"));
    await ask.click();
    expect(onAskInSideChat).toHaveBeenLastCalledWith("space");
    frame.contentWindow?.postMessage("restore-selection", "*");
    await expect.element(ask).toBeVisible();
  }
  frame.contentWindow?.postMessage("move-selection", "*");
  await vi.waitFor(() =>
    expect(
      page.getByRole("toolbar", { name: "Selection actions" }).element().getBoundingClientRect()
        .top,
    ).toBe(window.innerHeight - 40),
  );
  {
    using _inactive = vi.spyOn(navigator.userActivation, "isActive", "get").mockReturnValue(false);
    frame.contentWindow?.postMessage("clear-selection", "*");
    await expect.element(ask).not.toBeInTheDocument();
  }
  await userEvent.keyboard("{Control>}a{/Control}");
  await expect.element(ask).toBeVisible();
  await ask.click();
  expect(onAskInSideChat).toHaveBeenCalledWith("observation space");
  await expect.element(ask).not.toBeInTheDocument();
  await screen.rerender(
    <HtmlRenderDocument
      src={src}
      title="Pending selection"
      onAskInSideChat={onAskInSideChat}
      askPending
    />,
  );
  await screen.getByTitle("Pending selection").click();
  await userEvent.keyboard("{Control>}a{/Control}");
  await expect.element(ask).toHaveAttribute("aria-disabled", "true");
  await expect.element(ask).toHaveAttribute("aria-description", "Starting side chat…");
  (ask.element() as HTMLButtonElement).click();
  expect(onAskInSideChat).toHaveBeenCalledTimes(2);
  const longSrc = URL.createObjectURL(
    new Blob([injectHtmlRenderBootstrap(`<p>${"x".repeat(4001)}</p>`)], { type: "text/html" }),
  );
  using _longUrl = { [Symbol.dispose]: () => URL.revokeObjectURL(longSrc) };
  await screen.rerender(
    <HtmlRenderDocument
      key={longSrc}
      src={longSrc}
      title="Long selection"
      onAskInSideChat={onAskInSideChat}
    />,
  );
  await screen.getByTitle("Long selection").click();
  await userEvent.keyboard("{Control>}a{/Control}");
  const shorten = page.getByRole("button", { name: "Shorten selection to ask in side chat" });
  await expect.element(shorten).toHaveAttribute("aria-disabled", "true");
  (shorten.element() as HTMLButtonElement).click();
  expect(onAskInSideChat).toHaveBeenCalledTimes(2);
});

it("asks about the title and visible embed text from its corner button", async () => {
  const html = injectHtmlRenderBootstrap(
    '<p>observation space</p><p hidden>Hidden text</p><script>const secret = "script text";</script>',
  );
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const onAskInSideChat = vi.fn();
  await using screen = await render(<AskableEmbed src={src} onAskInSideChat={onAskInSideChat} />);
  await screen.getByRole("button", { name: "Ask in side chat" }).click();
  await vi.waitFor(() =>
    expect(onAskInSideChat).toHaveBeenCalledWith("State diagram\n\nobservation space"),
  );
  const longSrc = URL.createObjectURL(
    new Blob([injectHtmlRenderBootstrap(`<p>${"x".repeat(4100)}</p>`)], { type: "text/html" }),
  );
  using _longUrl = { [Symbol.dispose]: () => URL.revokeObjectURL(longSrc) };
  await screen.rerender(
    <AskableEmbed key={longSrc} src={longSrc} onAskInSideChat={onAskInSideChat} />,
  );
  await screen.getByRole("button", { name: "Ask in side chat" }).click();
  await vi.waitFor(() =>
    expect(onAskInSideChat).toHaveBeenLastCalledWith(`State diagram\n\n${"x".repeat(3985)}`),
  );
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  const dialogReady = new Promise<void>((resolve) => {
    window.addEventListener(
      "message",
      (event) => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[title="State diagram"]');
        if (
          frame &&
          event.source === frame.contentWindow &&
          event.data?.method === "ui/notifications/size-changed"
        )
          resolve();
      },
      { signal: messages.signal },
    );
  });
  await screen.rerender(
    <HtmlRenderDialog
      src={src}
      htmlRender={{ attachmentId: "state-diagram", title: "State diagram", height: 321 }}
      onAskInSideChat={onAskInSideChat}
      onClose={() => undefined}
    />,
  );
  await dialogReady;
  await page.getByRole("button", { name: "Ask in side chat" }).click();
  await vi.waitFor(() => expect(onAskInSideChat).toHaveBeenCalledTimes(3));
  expect(onAskInSideChat).toHaveBeenLastCalledWith("State diagram\n\nobservation space");
  await page.getByTitle("State diagram", { exact: true }).click();
  await userEvent.keyboard("{Control>}a{/Control}");
  await page
    .getByRole("toolbar", { name: "Selection actions" })
    .getByRole("button", { name: "Ask in side chat" })
    .click();
  expect(onAskInSideChat).toHaveBeenLastCalledWith("observation space");
});

it("hides the corner action for an older embed without the selection bridge", async () => {
  const html = `<p>Older diagram</p><script>parent.postMessage(${JSON.stringify(sizeChanged(321))}, "*");</script>`;
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  const loaded = new Promise<void>((resolve) => {
    window.addEventListener(
      "message",
      (event) => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Older diagram"]');
        if (
          event.source === frame?.contentWindow &&
          event.data?.method === "ui/notifications/size-changed"
        )
          resolve();
      },
      { signal: messages.signal },
    );
  });
  const onAskInSideChat = vi.fn();
  await using screen = await render(
    <HtmlRenderDialog
      src={src}
      htmlRender={{ attachmentId: "older-diagram", title: "Older diagram", height: 321 }}
      onAskInSideChat={onAskInSideChat}
      onClose={() => undefined}
    />,
  );
  await act(async () => {
    await loaded;
  });
  await expect
    .element(screen.getByRole("button", { name: "Ask in side chat" }))
    .not.toBeInTheDocument();
});
