import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";

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

  it("restores form input when the page mounts again, as after a thread switch", async () => {
    // The page reports its fields on load and after every edit, including restored ones. Its
    // startup input event must not erase saved input, and its note handler rebuilds a later field.
    const html = injectHtmlRenderBootstrap(`<!doctype html><html><body>
      <textarea name="note"></textarea>
      <input name="extra">
      <select name="tags" multiple><option>x</option><option>y</option><option>z</option></select>
      <input type="radio" name="pick" value="a" checked>
      <input type="radio" name="pick" value="b">
      <output id="echo"></output>
      <script>
        var note = document.querySelector("textarea");
        var tags = document.querySelector("select");
        var extra = function() { return document.querySelector('input[name="extra"]'); };
        note.addEventListener("input", function() {
          document.getElementById("echo").textContent = note.value;
          extra().replaceWith(extra().cloneNode());
        });
        function report() {
          window.parent.postMessage({
            type: "fields",
            note: note.value,
            extra: extra().value,
            tags: Array.from(tags.selectedOptions, function(option) { return option.value; }),
            pick: document.querySelector('input[name="pick"]:checked').value,
            echo: document.getElementById("echo").textContent
          }, "*");
        }
        document.addEventListener("input", report);
        document.addEventListener("change", report);
        window.addEventListener("message", function(event) {
          if (event.source !== window.parent || event.data.type !== "edit") return;
          note.value = "keep this";
          note.dispatchEvent(new Event("input", { bubbles: true }));
          extra().value = "two";
          extra().dispatchEvent(new Event("input", { bubbles: true }));
          tags.options[1].selected = true;
          tags.options[2].selected = true;
          tags.dispatchEvent(new Event("change", { bubbles: true }));
          var pick = document.querySelector('input[value="b"]');
          pick.checked = true;
          pick.dispatchEvent(new Event("change", { bubbles: true }));
        });
        note.dispatchEvent(new Event("input", { bubbles: true }));
      </script></body></html>`);
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    let fields: unknown;
    const messages = new AbortController();
    using _messages = { [Symbol.dispose]: () => messages.abort() };
    window.addEventListener(
      "message",
      (event) => {
        if (event.data?.type === "fields") fields = event.data;
      },
      { signal: messages.signal },
    );
    const edited = {
      type: "fields",
      note: "keep this",
      extra: "two",
      tags: ["y", "z"],
      pick: "b",
      echo: "keep this",
    };

    {
      await using screen = await render(
        <HtmlRenderDocument src={src} title="Form" formStateKey="env:form" />,
      );
      await vi.waitFor(() =>
        expect(fields).toEqual({
          type: "fields",
          note: "",
          extra: "",
          tags: [],
          pick: "a",
          echo: "",
        }),
      );
      const frame = screen.getByTitle("Form").element() as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ type: "edit" }, "*");
      await vi.waitFor(() => expect(fields).toEqual(edited));
    }

    fields = undefined;
    await using _screen = await render(
      <HtmlRenderDocument src={src} title="Form" formStateKey="env:form" />,
    );
    await vi.waitFor(() => expect(fields).toEqual(edited));
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
