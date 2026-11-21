import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The markdown module graph reads the Electron bridge and local storage when it loads.
vi.stubGlobal("window", {});
vi.stubGlobal("localStorage", { getItem: () => null });
const { ChatMarkdown } = await import("./Markdown");

const html = (text: string, untrusted: boolean) =>
  renderToStaticMarkup(createElement(ChatMarkdown, { text, untrusted }));

describe("markdown from other people", () => {
  it("Given an image from a loopback address, when untrusted text renders, then no image is drawn and its alt text stays", () => {
    const out = html("![probe](http://127.0.0.1:3813/api/x.png)", true);
    expect(out).not.toContain("<img");
    expect(out).toContain("probe");
  });

  it("Given the same image in the app's own text, when it renders, then the image is drawn", () => {
    expect(html("![probe](http://127.0.0.1:3813/api/x.png)", false)).toContain("<img");
  });
});
