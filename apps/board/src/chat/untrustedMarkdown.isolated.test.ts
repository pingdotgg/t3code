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

  it("Given a picture whose source is loopback and an image from a public host, when untrusted text renders, then no loopback address is in the output", () => {
    const out = html(
      '<picture><x><source srcset="http://127.0.0.1:3813/api/x.png"></x><img src="https://example.com/a.png"></picture>',
      true,
    );
    expect(out).not.toContain("127.0.0.1");
  });
});
