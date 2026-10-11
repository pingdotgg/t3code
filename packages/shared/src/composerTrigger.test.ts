import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, serializeComposerFileLink } from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );

  it.each(["Use /rev", "Use\n  /rev", "  /rev"])(
    "detects a slash command that starts a word in %j",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "slash-command",
        query: "rev",
        rangeStart: text.length - "/rev".length,
        rangeEnd: text.length,
      });
    },
  );

  it.each([
    "Use /review afterwards",
    "/review afterwards",
    "  /review\tnext",
    "$first /review\nnext",
  ])("replaces the whole slash token with the caret inside %j", (text) => {
    const rangeStart = text.indexOf("/");
    const trigger = detectComposerTrigger(text, rangeStart + "/rev".length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart,
      rangeEnd: rangeStart + "/review".length,
    });
  });

  it.each([
    ["Use /tmp/build.sh", "Use /tmp/build.sh".length],
    ["Use /etc/hosts", "Use /etc/hosts".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
    ["see https://example.com/a", "see https://example.com/a".length],
  ])("keeps paths and URLs literal in %j", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model", 6)).toMatchObject({ kind: "slash-model", query: "" });
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
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
