import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
    // startup input event must not erase saved input, its note handler rebuilds a later field, a
    // native pick fills a later field silently, and ticking "more" adds a field before itself.
    const html = injectHtmlRenderBootstrap(`<!doctype html><html><body>
      <textarea name="note"></textarea>
      <input name="extra">
      <select name="tags" multiple><option>x</option><option>y</option><option>z</option></select>
      <input type="radio" name="pick" value="a" aria-label="Pick a" checked>
      <input type="radio" name="pick" value="b" aria-label="Pick b">
      <input name="choice" value="a">
      <div id="more-slot"></div>
      <input type="checkbox" name="more">
      <output id="echo"></output>
      <script>
        var note = document.querySelector("textarea");
        var tags = document.querySelector("select");
        var extra = function() { return document.querySelector('input[name="extra"]'); };
        var detail = function() { return document.querySelector('input[name="detail"]'); };
        note.addEventListener("input", function() {
          document.getElementById("echo").textContent = note.value;
          extra().replaceWith(extra().cloneNode());
        });
        // Fills a later field without an input event, so its value only exists after this handler.
        document.addEventListener("change", function(event) {
          if (event.target.name === "pick") {
            document.querySelector('input[name="choice"]').value = event.target.value;
          }
          if (event.target.name === "more" && event.target.checked && !detail()) {
            document.getElementById("more-slot").innerHTML = '<input name="detail">';
          }
        });
        // Deferred like the bootstrap's own report, so the host has the snapshot before the test sees this.
        function report() { setTimeout(send); }
        function send() {
          window.parent.postMessage({
            type: "fields",
            note: note.value,
            extra: extra().value,
            tags: Array.from(tags.selectedOptions, function(option) { return option.value; }),
            pick: document.querySelector('input[name="pick"]:checked').value,
            choice: document.querySelector('input[name="choice"]').value,
            more: document.querySelector('input[name="more"]').checked,
            detail: detail() ? detail().value : null,
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
          var more = document.querySelector('input[name="more"]');
          more.checked = true;
          more.dispatchEvent(new Event("change", { bubbles: true }));
          detail().value = "shown";
          detail().dispatchEvent(new Event("input", { bubbles: true }));
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
      choice: "b",
      more: true,
      detail: "shown",
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
          choice: "a",
          more: false,
          detail: null,
          echo: "",
        }),
      );
      const frame = screen.getByTitle("Form").element() as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ type: "edit" }, "*");
      await vi.waitFor(() => expect(fields).toEqual({ ...edited, pick: "a", choice: "a" }));
      // Native input runs microtasks between listeners, unlike a scripted dispatchEvent.
      await page.frameLocator(screen.getByTitle("Form")).getByLabelText("Pick b").click();
      await vi.waitFor(() => expect(fields).toEqual(edited));
    }

    fields = undefined;
    await using _screen = await render(
      <HtmlRenderDocument src={src} title="Form" formStateKey="env:form" />,
    );
    await vi.waitFor(() => expect(fields).toEqual(edited));
  });

  it("saves a form reset, which changes fields without input events", async () => {
    // The marker sits outside the form, so restoring it proves a restore ran and shows the saved note.
    const html = injectHtmlRenderBootstrap(`<!doctype html><html><body>
      <form><input name="note"></form>
      <input name="marker">
      <script>
        var note = document.querySelector('input[name="note"]');
        var marker = document.querySelector('input[name="marker"]');
        // Deferred like the bootstrap's own report, so the host has the snapshot before the test sees this.
        function report() {
          setTimeout(function() {
            window.parent.postMessage({ type: "reset-fields", note: note.value, marker: marker.value }, "*");
          });
        }
        document.addEventListener("input", report);
        window.addEventListener("message", function(event) {
          if (event.source !== window.parent || event.data.type !== "edit") return;
          note.value = "typed";
          note.dispatchEvent(new Event("input", { bubbles: true }));
          marker.value = "restored";
          marker.dispatchEvent(new Event("input", { bubbles: true }));
          // A later task, so the reset lands after the bootstrap has saved the typed note.
          setTimeout(function() {
            document.querySelector("form").reset();
            report();
          });
        });
      </script></body></html>`);
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    let fields: unknown;
    const messages = new AbortController();
    using _messages = { [Symbol.dispose]: () => messages.abort() };
    window.addEventListener(
      "message",
      (event) => {
        if (event.data?.type === "reset-fields") fields = event.data;
      },
      { signal: messages.signal },
    );
    const afterReset = { type: "reset-fields", note: "", marker: "restored" };

    {
      await using screen = await render(
        <HtmlRenderDocument src={src} title="Reset" formStateKey="env:reset" />,
      );
      const frame = screen.getByTitle("Reset").element() as HTMLIFrameElement;
      // Retry the edit until the page is listening; it is idempotent.
      await vi.waitFor(() => {
        frame.contentWindow?.postMessage({ type: "edit" }, "*");
        expect(fields).toEqual(afterReset);
      });
    }

    fields = undefined;
    await using _screen = await render(
      <HtmlRenderDocument src={src} title="Reset" formStateKey="env:reset" />,
    );
    await vi.waitFor(() => expect(fields).toEqual(afterReset));
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
