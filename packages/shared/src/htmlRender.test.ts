import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

function clickHtmlLink(html: string, href: string, framed = true) {
  const messages: unknown[] = [];
  const attributes = new Map<string, string>([["href", href]]);
  const anchor = {
    matches: (selector: string) => selector === "a[href]",
    getAttribute: (name: string) => attributes.get(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const event = {
    isTrusted: true,
    composedPath: () => [anchor],
    metaKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  const listeners: Array<(click: typeof event) => void> = [];
  const window = {
    parent: {} as object,
    addEventListener: () => undefined,
    postMessage: (message: unknown) => messages.push(message),
  };
  window.parent = framed ? { postMessage: window.postMessage } : window;
  const context = NodeVM.createContext({
    URL,
    window,
    document: {
      getElementById: () => ({}),
      baseURI: "https://example.com/render.html",
      addEventListener: (type: string, listener: (click: typeof event) => void) => {
        if (type === "click") listeners.push(listener);
      },
    },
    location: { href: "https://example.com/render.html", hash: "" },
  });
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    NodeVM.runInContext(script[1]!, context);
  }
  for (const listener of listeners) listener(event);
  return { event, messages, attributes };
}

describe("injectHtmlRenderBootstrap", () => {
  it.each([
    "https://github.com/example/repo/pull/1",
    "t3-thread://v1/mcp:b597d231-0c1e-4da8-8794-ccd3c3df953c",
  ])("opens %s through the host without navigating the iframe", (url) => {
    const { event, messages } = clickHtmlLink(injectHtmlRenderBootstrap("<p>Page</p>"), url);
    expect(event.defaultPrevented).toBe(true);
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: "t3-link-1",
        method: "ui/open-link",
        params: { url, metaKey: false, ctrlKey: false },
      },
    ]);
    expect(readHtmlRenderLinkRequest(messages[0])).toMatchObject({ url });
  });

  it("opens thread links in a new window for the mobile host to handle", () => {
    const { attributes } = clickHtmlLink(
      injectHtmlRenderBootstrap("<p>Page</p>"),
      "t3-thread://v1/mcp:mobile",
      false,
    );
    expect(attributes.get("target")).toBe("_blank");
  });

  it("keeps same-page anchors inside the document", () => {
    const { event, messages } = clickHtmlLink(injectHtmlRenderBootstrap("<p>Page</p>"), "#details");
    expect(event.defaultPrevented).toBe(false);
    expect(messages).toEqual([]);
  });

  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it.each(["t3-thread://v1/mcp:1234"])("accepts the thread link %s", (url) => {
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/open-link",
        params: { url },
      }),
    ).toEqual({ id: 1, url, metaKey: false, ctrlKey: false });
  });

  it("accepts web URLs and rejects unsupported schemes or malformed requests", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("t3-thread://v1/"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});
