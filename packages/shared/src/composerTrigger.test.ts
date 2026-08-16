import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  parseComposerThreadLink,
  serializeComposerFileLink,
  serializeComposerMentionPath,
  serializeComposerThreadLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it("uses # for tasks", () => {
    expect(detectComposerTrigger("Continue #auth", "Continue #auth".length)).toEqual({
      kind: "thread",
      query: "auth",
      rangeStart: "Continue ".length,
      rangeEnd: "Continue #auth".length,
    });
  });

  it("uses @ for files", () => {
    expect(detectComposerTrigger("Inspect @src/com", "Inspect @src/com".length)).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Inspect ".length,
      rangeEnd: "Inspect @src/com".length,
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

  it("quotes paths containing the file trigger", () => {
    expect(serializeComposerMentionPath("docs/@generated/config.md")).toBe(
      '"docs/@generated/config.md"',
    );
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

describe("task references", () => {
  it("round-trips environment and thread ids", () => {
    const link = serializeComposerThreadLink({
      environmentId: "environment/one",
      threadId: "thread two",
      title: "Old [task]",
    });

    expect(link).toBe("[Old \\[task\\]](t3-thread:///environment%2Fone/thread%20two)");
    expect(parseComposerThreadLink("t3-thread:///environment%2Fone/thread%20two")).toEqual({
      environmentId: "environment/one",
      threadId: "thread two",
    });
  });

  it("rejects incomplete and unrelated links", () => {
    expect(parseComposerThreadLink("https://example.com/environment/thread")).toBeNull();
    expect(parseComposerThreadLink("t3-thread:///environment-only")).toBeNull();
  });

  it("preserves dot-segment identifiers", () => {
    const link = serializeComposerThreadLink({
      environmentId: ".",
      threadId: "..",
      title: "Dot task",
    });

    expect(parseComposerThreadLink(link.slice(link.indexOf("(") + 1, -1))).toEqual({
      environmentId: ".",
      threadId: "..",
    });
  });
});
