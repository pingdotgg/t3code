import { describe, expect, it } from "vite-plus/test";
import { isMermaidFenceLanguage, mermaidClipboardMarkdown } from "./mermaidLanguage";

describe("isMermaidFenceLanguage", () => {
  it("recognizes mermaid and mmd fences", () => {
    expect(isMermaidFenceLanguage("mermaid")).toBe(true);
    expect(isMermaidFenceLanguage("MERMAID")).toBe(true);
    expect(isMermaidFenceLanguage(" mmd ")).toBe(true);
  });

  it("rejects other languages", () => {
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage("text")).toBe(false);
    expect(isMermaidFenceLanguage("")).toBe(false);
  });
});

describe("mermaidClipboardMarkdown", () => {
  it("wraps source in a mermaid fence", () => {
    expect(mermaidClipboardMarkdown("flowchart TD\n  A --> B", "mermaid")).toBe(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n",
    );
  });

  it("lengthens the fence when the source contains triple backticks", () => {
    expect(mermaidClipboardMarkdown("note ``` inside", "mermaid")).toBe(
      "````mermaid\nnote ``` inside\n````\n\n",
    );
  });
});
