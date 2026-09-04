import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it("keeps a leading slash as a command trigger", () => {
    expect(detectComposerTrigger("/", 1)).toEqual({
      kind: "slash-command",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
    });
  });

  it("keeps a slash command active after an otherwise empty line", () => {
    expect(detectComposerTrigger("\n/rev", 5)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 1,
      rangeEnd: 5,
    });
  });

  it("ignores caller-defined whitespace before a slash command", () => {
    const placeholder = "\uFFFC";
    const text = `${placeholder} /rev`;
    const isWhitespaceChar = (char: string) =>
      char === placeholder || char === " " || char === "\n" || char === "\t" || char === "\r";

    expect(detectComposerTrigger(text, text.length, isWhitespaceChar)).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 2,
      rangeEnd: text.length,
    });
  });

  it("uses a bare inline slash name as a skill-only trigger", () => {
    const text = "Use /unslop";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-skill",
      query: "unslop",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it.each(["Use /tmp/build.sh", "Use /etc/hosts"])(
    "keeps the absolute path in %s as ordinary text",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toBeNull();
    },
  );

  it("keeps later-line slashes skill-only when the draft already has text", () => {
    const text = "Use a skill\n/";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-skill",
      query: "",
      rangeStart: "Use a skill\n".length,
      rangeEnd: text.length,
    });
  });
});

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
