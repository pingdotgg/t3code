import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("detectComposerTrigger", () => {
  it("detects a slash command at the start of the message", () => {
    const text = "/rev";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects a slash command trigger in the middle of existing text", () => {
    const text = "Fix the tests /rev";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: "Fix the tests ".length,
      rangeEnd: text.length,
    });
  });

  it("detects /model mid-text as the model trigger", () => {
    const text = "switch it up /model";
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-model",
      query: "",
      rangeStart: "switch it up ".length,
      rangeEnd: text.length,
    });
  });

  it("ignores slashes inside a word", () => {
    const text = "check src/components";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("ignores slashes inside URLs", () => {
    const text = "see https://example.com/docs";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
