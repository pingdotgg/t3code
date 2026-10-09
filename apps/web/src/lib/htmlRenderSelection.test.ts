// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  htmlSelectionCommand,
  htmlSelectionParams,
  readHtmlSelection,
} from "./htmlRenderSelection";
import { injectHtmlSelectionBridge } from "@t3tools/shared/htmlRender";
import { createAssistantTextSelector } from "./assistantTextSelection";

const documents: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of documents.splice(0)) frame.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function page(html = "<p>Before <strong>quoted text</strong> after.</p><p>Second paragraph</p>") {
  // Executes the same raw bridge that the client adds to existing published pages.
  const frame = document.createElement("iframe");
  document.body.append(frame);
  documents.push(frame);
  const view = frame.contentWindow as Window & typeof globalThis;
  view.document.open();
  view.document.write(
    injectHtmlSelectionBridge(`<!doctype html><html><head></head><body>${html}</body></html>`),
  );
  view.document.close();
  const post = vi.spyOn(view.parent, "postMessage");
  const rect = { left: 10, top: 20, width: 80, height: 15 };
  Object.assign(view.Range.prototype, {
    getBoundingClientRect: () => rect,
    getClientRects: () => Object.assign([rect], { item: () => rect }),
  });
  const pointer = (type: string, target: Element = view.document.body, detail = 1) => {
    const event = new view.MouseEvent(type, {
      bubbles: true,
      button: 0,
      clientX: 70,
      clientY: 35,
      detail,
    });
    Object.defineProperty(event, "isPrimary", { value: true });
    target.dispatchEvent(event);
  };
  const select = (first: Node, start: number, last = first, end = first.textContent!.length) => {
    const range = view.document.createRange();
    range.setStart(first, start);
    range.setEnd(last, end);
    const selection = view.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    view.document.dispatchEvent(new view.Event("selectionchange"));
    return range;
  };
  const finish = () => new Promise<void>((resolve) => view.setTimeout(resolve, 0));
  const messages = () =>
    post.mock.calls
      .map(([data]) => data as unknown)
      .filter((data) => htmlSelectionParams(data) !== undefined);
  const command = (action: string, selector?: unknown) =>
    view.dispatchEvent(
      new view.MessageEvent("message", {
        source: view.parent,
        data: { method: "t3/selection-command", params: { action, selector } },
      }),
    );
  return { view, post, rect, pointer, select, finish, messages, command };
}

describe("HTML render selection bridge", () => {
  it("omits CSS-hidden subtrees from captured quotes and source matching", async () => {
    const p = page(
      '<style>.hidden { display: none }</style><p>Before <span class="hidden"><b>secret</b></span><strong>quoted text</strong> after.</p>',
    );
    const paragraph = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0, paragraph.lastChild!);
    p.pointer("mouseup", paragraph);
    await p.finish();
    const quote = readHtmlSelection(p.messages().at(-1))!.selector;
    expect(quote.text).toBe("Before quoted text after.");
    expect(quote.end).toBe(25);
    p.command("target", quote);
    expect(htmlSelectionParams(p.messages().at(-1))?.target).toEqual(p.rect);
    p.command("target", { ...quote, text: "secret" });
    expect(htmlSelectionParams(p.messages().at(-1))?.target).toBeNull();
  });

  it("uses CSS layout for word boundaries when capturing and resolving quotes", async () => {
    const p = page(
      '<style>.block { display: block } .inline { display: inline } .contents { display: contents }</style><span class="block">first</span><span class="block">second</span><div class="inline">third</div><span class="contents">fourth<br>fifth</span>',
    );
    const first = p.view.document.querySelector("span")!;
    const last = p.view.document.querySelector(".contents")!;
    p.pointer("pointerdown", first);
    p.select(first.firstChild!, 0, last.lastChild!);
    p.pointer("mouseup", last);
    await p.finish();
    const quote = readHtmlSelection(p.messages().at(-1))!.selector;
    expect(quote.text).toBe("first\nsecond\nthirdfourth\nfifth");
    p.command("target", quote);
    expect(htmlSelectionParams(p.messages().at(-1))?.target).toEqual(p.rect);
  });

  it("reveals a quote through nested scroll containers before returning its target", () => {
    const p = page(
      '<div id="outer" style="overflow-x: auto; overflow-y: auto; scroll-behavior: smooth"><div id="inner" style="overflow-x: auto; overflow-y: auto; scroll-behavior: smooth"><p>quoted text</p></div></div>',
    );
    const outer = p.view.document.querySelector<HTMLElement>("#outer")!;
    const inner = p.view.document.querySelector<HTMLElement>("#inner")!;
    Object.defineProperties(inner, {
      clientHeight: { value: 100 },
      clientWidth: { value: 100 },
      scrollHeight: { value: 800 },
      scrollWidth: { value: 800 },
    });
    Object.defineProperties(outer, {
      clientHeight: { value: 150 },
      clientWidth: { value: 150 },
      scrollHeight: { value: 1000 },
      scrollWidth: { value: 1000 },
    });
    for (const element of [inner, outer]) {
      let top = 0;
      let left = 0;
      Object.defineProperties(element, {
        // Auto scrolling follows the page's smooth behavior and does not finish synchronously.
        scrollTop: { get: () => top, set: () => {} },
        scrollLeft: { get: () => left, set: () => {} },
      });
      element.scrollBy = (options?: ScrollToOptions | number) => {
        if (typeof options !== "object" || options.behavior !== "instant") return;
        top += options.top ?? 0;
        left += options.left ?? 0;
      };
    }
    const bounds = (left: number, top: number, width: number, height: number) =>
      new p.view.DOMRect(left, top, width, height);
    inner.getBoundingClientRect = () =>
      bounds(200 - outer.scrollLeft, 300 - outer.scrollTop, 100, 100);
    outer.getBoundingClientRect = () => bounds(10, 10, 150, 150);
    const quoteBounds = () =>
      bounds(
        450 - inner.scrollLeft - outer.scrollLeft,
        650 - inner.scrollTop - outer.scrollTop,
        80,
        15,
      );
    Object.assign(p.view.Range.prototype, {
      getBoundingClientRect: quoteBounds,
      getClientRects: () => [quoteBounds()],
    });
    const scroll = vi.spyOn(p.view, "scrollBy").mockImplementation(() => {});
    p.command("target", { text: "quoted text", start: 0, end: 11, prefix: "", suffix: "" });
    const target = htmlSelectionParams(p.messages().at(-1))!.target!;
    expect(inner.scrollTop).toBe(265);
    expect(inner.scrollLeft).toBe(230);
    expect(outer.scrollTop).toBe(240);
    expect(outer.scrollLeft).toBe(140);
    expect(target).toEqual({ left: 80, top: 145, width: 80, height: 15 });
    expect(scroll).not.toHaveBeenCalled();

    inner.scrollBy({
      top: 500 - inner.scrollTop,
      left: 500 - inner.scrollLeft,
      behavior: "instant",
    });
    outer.scrollBy({
      top: 300 - outer.scrollTop,
      left: 300 - outer.scrollLeft,
      behavior: "instant",
    });
    p.command("target", { text: "quoted text", start: 0, end: 11, prefix: "", suffix: "" });
    expect(htmlSelectionParams(p.messages().at(-1))?.target).toEqual({
      left: 10,
      top: 10,
      width: 80,
      height: 15,
    });
  });

  it.each([
    { left: 700, top: 20, expectedLeft: 160, expectedTop: 20 },
    { left: -200, top: 20, expectedLeft: 80, expectedTop: 20 },
    { left: 10, top: 700, expectedLeft: 10, expectedTop: 80 },
    { left: 10, top: -200, expectedLeft: 10, expectedTop: 80 },
    { left: 700, top: 700, expectedLeft: 160, expectedTop: 80 },
  ])(
    "reveals a quote at ($left, $top) before replying on a smooth-scrolling page",
    ({ left, top, expectedLeft, expectedTop }) => {
      const p = page("<style>html { scroll-behavior: smooth }</style><p>quoted text</p>");
      Object.defineProperties(p.view, {
        innerWidth: { value: 320 },
        innerHeight: { value: 240 },
      });
      let dx = 0;
      let dy = 0;
      const bounds = () => new p.view.DOMRect(left - dx, top - dy, 80, 15);
      Object.assign(p.view.Range.prototype, {
        getBoundingClientRect: bounds,
        getClientRects: () => [bounds()],
      });
      const scroll = vi
        .spyOn(p.view, "scrollBy")
        .mockImplementation((options?: ScrollToOptions | number) => {
          // The reply must use coordinates after scrolling, without waiting for an animation.
          if (typeof options !== "object" || options.behavior !== "instant") return;
          dx += options.left ?? 0;
          dy += options.top ?? 0;
        });
      const quote = { text: "quoted text", start: 0, end: 11, prefix: "", suffix: "" };
      p.command("mark", quote);
      expect(scroll).not.toHaveBeenCalled();
      p.command("target", quote);
      expect(htmlSelectionParams(p.messages().at(-1))?.target).toEqual({
        left: expectedLeft,
        top: expectedTop,
        width: 80,
        height: 15,
      });
      expect(scroll).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps native Tab navigation for oversized selections", async () => {
    const p = page(`<p>${"x".repeat(8001)}</p><button>Next</button>`);
    const paragraph = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0);
    p.pointer("mouseup", paragraph);
    await p.finish();
    const tab = new p.view.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    p.view.document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(p.messages().some((data) => htmlSelectionParams(data)?.focus)).toBe(false);
  });

  it("accepts paragraph selection whose empty endpoint is in the following control", async () => {
    const p = page("<p>quoted paragraph</p><button>Next</button>");
    const paragraph = p.view.document.querySelector("p")!;
    const button = p.view.document.querySelector("button")!;
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0, button.firstChild!, 0);
    p.pointer("mouseup", paragraph);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("quoted paragraph");
    p.select(paragraph.firstChild!, 0, button.firstChild!, 1);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))).toBeNull();
  });

  it("clears stale highlights and revalidates an open comment when its text changes", async () => {
    const p = page();
    p.view.requestAnimationFrame = (callback) => p.view.setTimeout(() => callback(0), 0);
    const highlights = new Map();
    Object.assign(p.view, { CSS: { highlights }, Highlight: vi.fn() });
    await p.finish();
    const quote = {
      text: "quoted text",
      start: 7,
      end: 18,
      prefix: "Before ",
      suffix: " after. Second paragraph",
    };
    p.command("mark", quote);
    expect(highlights.has("t3-html-citation")).toBe(true);
    p.view.document.querySelector("strong")!.textContent = "different text";
    await p.finish();
    await p.finish();
    expect(highlights.has("t3-html-citation")).toBe(false);
    expect(htmlSelectionParams(p.messages().at(-1))).toMatchObject({
      target: null,
      selector: quote,
      action: "mark",
    });
    p.command("target", { ...quote, text: "different text" });
    expect(highlights.has("t3-html-citation")).toBe(true);
    p.command("target", { ...quote, text: "missing" });
    expect(highlights.has("t3-html-citation")).toBe(false);
  });

  it("only reports changed comment targets during page mutation validation", async () => {
    const p = page();
    const callbacks: FrameRequestCallback[] = [];
    p.view.requestAnimationFrame = (callback) => {
      callbacks.push(callback);
      return 1;
    };
    const validate = async () => {
      // Deliver the MutationObserver batch, then run its scheduled validation.
      await Promise.resolve();
      expect(callbacks).toHaveLength(1);
      callbacks.shift()!(0);
    };
    const replies = () =>
      p.messages().filter((data) => htmlSelectionParams(data)?.action === "mark");
    const quote = { text: "quoted text", start: 7, end: 18, prefix: "Before ", suffix: "" };
    p.command("mark", quote);
    expect(replies()).toHaveLength(1);
    const other = p.view.document.querySelectorAll("p")[1]!;
    for (const attribute of ["class", "style", "hidden", "data-state"]) {
      other.setAttribute(attribute, "");
      await validate();
      other.removeAttribute(attribute);
      await validate();
      expect(replies()).toHaveLength(1);
    }
    // Arbitrary attributes can affect page CSS and move the quote.
    p.rect.top = 40;
    other.setAttribute("data-state", "expanded");
    await validate();
    expect(replies()).toHaveLength(2);
    expect(htmlSelectionParams(replies().at(-1))?.target).toEqual(p.rect);
    const strong = p.view.document.querySelector("strong")!;
    strong.textContent = "different text";
    await validate();
    expect(replies()).toHaveLength(3);
    expect(htmlSelectionParams(replies().at(-1))?.target).toBeNull();
    other.className = "updated";
    await validate();
    expect(replies()).toHaveLength(3);
    strong.textContent = "quoted text";
    await validate();
    expect(replies()).toHaveLength(4);
    expect(htmlSelectionParams(replies().at(-1))?.target).toEqual(p.rect);
    // Explicit commands still acknowledge every request, even at unchanged coordinates.
    p.command("mark", quote);
    p.command("mark", quote);
    expect(replies()).toHaveLength(6);
    p.command("unmark");
    other.className = "after-close";
    await Promise.resolve();
    expect(callbacks).toHaveLength(0);
  });

  it("projects selector fields in both directions across the iframe boundary", () => {
    const p = page();
    const selector = { text: "quote", start: 0, end: 5, prefix: "", suffix: "" };
    const citation = {
      ...selector,
      environmentId: "other-env",
      threadId: "other-thread",
      messageId: "other-message",
      version: 2,
      comment: "page-authored instructions",
    };
    const parsed = readHtmlSelection({
      jsonrpc: "2.0",
      method: "t3/selection",
      params: { selector: citation, rect: p.rect, pointer: null },
    });
    expect(parsed?.selector).toEqual(selector);
    const frame = documents.at(-1)!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    htmlSelectionCommand(frame, "mark", citation);
    expect(post).toHaveBeenLastCalledWith(
      { method: "t3/selection-command", params: { action: "mark", selector } },
      "*",
    );
  });

  it("anchors paragraph selection to visible text when its trailing newline has no width", async () => {
    const p = page();
    const paragraph = p.view.document.querySelector("p")!;
    Object.assign(p.view.Range.prototype, {
      getClientRects: () => [p.rect, { ...p.rect, left: 90, width: 0 }],
    });
    p.pointer("pointerdown", paragraph);
    p.select(paragraph.firstChild!, 0, paragraph.lastChild!);
    p.pointer("mouseup", paragraph);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))?.rect).toEqual(p.rect);
  });

  it("captures text inside a saved render only after release, with the same selector as assistant text", async () => {
    const p = page();
    const strong = p.view.document.querySelector("strong")!;
    p.pointer("pointerdown", strong);
    p.select(strong.firstChild!, 0);
    expect(p.messages().some((data) => readHtmlSelection(data))).toBe(false);
    p.pointer("pointerup", strong);
    p.pointer("mouseup", strong);
    await p.finish();
    const selected = readHtmlSelection(p.messages().at(-1));
    expect(selected).toEqual({
      selector: createAssistantTextSelector("Before quoted text after.\nSecond paragraph", 7, 18),
      rect: p.rect,
      pointer: { x: 70, y: 35 },
    });
    p.command("clear");
    expect(p.view.getSelection()!.isCollapsed).toBe(true);
    expect(p.messages().at(-1)).toMatchObject({ params: null });
  });

  it("omits controls and scripts from a quote spanning paragraphs", async () => {
    const p = page("<p>one<button>ignore</button><script>/* ignored */</script></p><p>two</p>");
    const paragraphs = p.view.document.querySelectorAll("p");
    p.pointer("pointerdown", paragraphs[0]);
    p.select(paragraphs[0]!.firstChild!, 0, paragraphs[1]!.firstChild!);
    p.pointer("mouseup", paragraphs[1]);
    await p.finish();
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("one\ntwo");
  });

  it("does not shorten the multi-click delay when selectionchange arrives late", () => {
    vi.useFakeTimers();
    const p = page();
    const strong = p.view.document.querySelector("strong")!;
    p.pointer("pointerdown", strong);
    p.select(strong.firstChild!, 0);
    p.pointer("mouseup", strong, 2);
    p.view.document.dispatchEvent(new p.view.Event("selectionchange"));
    vi.advanceTimersByTime(499);
    expect(p.messages().some((data) => readHtmlSelection(data))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("quoted text");
  });

  it("resolves the saved quote after surrounding text moves and rejects ambiguous repeats", async () => {
    const p = page();
    const selector = createAssistantTextSelector(
      "Before quoted text after.\nSecond paragraph",
      7,
      18,
    )!;
    p.view.document.body.prepend(p.view.document.createTextNode("Inserted content "));
    p.command("target", selector);
    expect(htmlSelectionParams(p.messages().at(-1))).toEqual({
      target: p.rect,
      selector,
      action: "target",
    });
    p.view.document.body.insertAdjacentHTML(
      "beforeend",
      "<p>Before <strong>quoted text</strong> after.</p><p>Second paragraph</p>",
    );
    p.command("target", selector);
    expect(htmlSelectionParams(p.messages().at(-1))).toEqual({
      target: null,
      selector,
      action: "target",
    });
  });

  it("dismisses a quote on Escape and excludes form selections", async () => {
    const p = page("<textarea>private control</textarea><p>visible</p>");
    const input = p.view.document.querySelector("textarea")!;
    p.pointer("pointerdown", input);
    p.select(input.firstChild!, 0);
    p.pointer("mouseup", input);
    await p.finish();
    expect(p.messages().some((data) => readHtmlSelection(data))).toBe(false);
    const text = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", text);
    p.select(text.firstChild!, 0);
    p.pointer("mouseup", text);
    p.view.document.dispatchEvent(
      new p.view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await p.finish();
    expect(p.messages().at(-1)).toMatchObject({ params: null });
  });

  it.each([
    { key: "a", ctrlKey: true, metaKey: false },
    { key: "A", ctrlKey: false, metaKey: true },
  ])("captures Select All after Escape with $key (ctrl=$ctrlKey, meta=$metaKey)", (shortcut) => {
    vi.useFakeTimers();
    const p = page("<p>Before <strong>quoted text</strong> after.</p>");
    const paragraph = p.view.document.querySelector("p")!;
    const strong = p.view.document.querySelector("strong")!;
    p.pointer("pointerdown", strong);
    p.select(strong.firstChild!, 0);
    p.pointer("mouseup", strong);
    vi.runOnlyPendingTimers();
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("quoted text");

    p.view.document.dispatchEvent(
      new p.view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    p.view.document.dispatchEvent(new p.view.Event("selectionchange"));
    vi.runOnlyPendingTimers();
    expect(p.messages().at(-1)).toMatchObject({ params: null });

    const selectAll = new p.view.KeyboardEvent("keydown", {
      ...shortcut,
      bubbles: true,
      cancelable: true,
    });
    p.view.document.dispatchEvent(selectAll);
    p.select(paragraph.firstChild!, 0, paragraph.lastChild!);
    vi.runOnlyPendingTimers();
    expect(selectAll.defaultPrevented).toBe(false);
    expect(readHtmlSelection(p.messages().at(-1))?.selector.text).toBe("Before quoted text after.");
    expect(htmlSelectionParams(p.messages().at(-1))?.pointer).toBeNull();
  });

  it("keeps oversized selections out of cross-window messages", async () => {
    const p = page(`<p>${"x".repeat(8001)}</p>`);
    const text = p.view.document.querySelector("p")!;
    p.pointer("pointerdown", text);
    p.select(text.firstChild!, 0);
    p.pointer("mouseup", text);
    await p.finish();
    expect(htmlSelectionParams(p.messages().at(-1))).toEqual({
      tooLong: true,
      rect: p.rect,
      pointer: { x: 70, y: 35 },
    });
  });

  it("rejects malformed selection messages and non-finite geometry", () => {
    const selection = {
      jsonrpc: "2.0",
      method: "t3/selection",
      params: {
        selector: { text: "quote", start: 0, end: 5, prefix: "", suffix: "" },
        rect: { left: 1, top: 2, width: 3, height: 4 },
        pointer: null,
      },
    };
    expect(readHtmlSelection(selection)?.selector.text).toBe("quote");
    expect(readHtmlSelection({ ...selection, method: "other" })).toBeNull();
    expect(
      readHtmlSelection({
        ...selection,
        params: { ...selection.params, rect: { ...selection.params.rect, top: NaN } },
      }),
    ).toBeNull();
    expect(
      readHtmlSelection({
        ...selection,
        params: { ...selection.params, selector: { ...selection.params.selector, end: -1 } },
      }),
    ).toBeNull();
  });
});
