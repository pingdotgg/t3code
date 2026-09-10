import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { NATIVE_MATH_DOCUMENT } from "../../modules/t3-markdown-text/src/nativeMathDocument";

function fixture() {
  const messages: unknown[] = [];
  const dom = new JSDOM(NATIVE_MATH_DOCUMENT, {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "ReactNativeWebView", {
        value: { postMessage: (message: string) => messages.push(JSON.parse(message)) },
      });
      Object.defineProperty(window, "ResizeObserver", {
        value: class {
          observe() {}
        },
      });
    },
  });
  const update = (runs: string[], revision: number) =>
    dom.window.eval(
      `window.updateMath(${JSON.stringify({ runs, revision, color: "white", fontSize: 15, lineHeight: 22 })})`,
    );
  return { dom, messages, update };
}

describe("native math text bridge", () => {
  it("keeps a completed equation and its open source while adjacent text streams", () => {
    const { dom, update, messages } = fixture();
    try {
      const equation =
        '<span class="display"><button data-toggle="source">TeX source</button><span class="equation" data-source="$x$">x</span><span class="source" hidden>$x$</span></span>';
      update([equation, "Starting"], 1);
      const original = dom.window.document.querySelector(".equation");
      dom.window.document.querySelector("button")!.click();
      update([equation, "Starting a longer answer"], 2);
      expect(dom.window.document.querySelector(".equation")).toBe(original);
      expect(dom.window.document.querySelector<HTMLElement>(".source")!.hidden).toBe(false);
      expect(messages).toContainEqual({ type: "ready", revision: 0 });
      expect(messages).toContainEqual({ type: "height", revision: 2, height: 0 });
    } finally {
      dom.window.close();
    }
  });

  it("lets file menus close without taking an action", () => {
    const { dom, update, messages } = fixture();
    try {
      update(
        [
          `<button data-menu='{"actions":[{"id":"open","title":"Open"}]}' data-href="file:///tmp/test">File actions</button>`,
        ],
        1,
      );
      const { document } = dom.window;
      const button = document.querySelector("button")!;
      button.click();
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      button.click();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      button.click();
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
      expect(document.querySelector('[role="menu"]')).toBeNull();
      button.click();
      document.body.click();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(messages).not.toContainEqual(expect.objectContaining({ type: "file-action" }));
    } finally {
      dom.window.close();
    }
  });

  it("copies a selected skill label as its original token", () => {
    const { dom, update, messages } = fixture();
    try {
      update(['<span data-copy-source="$deploy"><svg class="inline-icon"></svg>Deploy</span>'], 1);
      const range = dom.window.document.createRange();
      range.selectNodeContents(dom.window.document.querySelector("[data-copy-source]")!.lastChild!);
      dom.window.getSelection()!.addRange(range);
      dom.window.document.dispatchEvent(new dom.window.Event("copy", { cancelable: true }));
      expect(messages).toContainEqual({ type: "copy", revision: 1, text: "$deploy" });
    } finally {
      dom.window.close();
    }
  });

  it("copies a selected equation as TeX and forwards links to the app", () => {
    const { dom, update, messages } = fixture();
    try {
      update(
        [
          'Before <span class="equation" data-source="\\(x\\)"><span>x</span></span> after <a href="https://example.com">reference</a>',
        ],
        1,
      );
      const { document } = dom.window;
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(".equation span")!);
      dom.window.getSelection()!.addRange(range);
      document.dispatchEvent(new dom.window.Event("copy", { cancelable: true }));
      expect(messages).toContainEqual({ type: "copy", revision: 1, text: String.raw`\(x\)` });
      document.querySelector("a")!.click();
      expect(messages).toContainEqual({ type: "link", revision: 1, href: "https://example.com" });
    } finally {
      dom.window.close();
    }
  });
});
