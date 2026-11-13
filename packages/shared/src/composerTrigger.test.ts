import { describe, expect, it } from "vite-plus/test";

import {
  composerItemAnswersTrigger,
  continueComposerPathTrigger,
  detectComposerTrigger,
  parseSideChatCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
    ["cmd /foo\\bar", "cmd /foo\\bar".length],
    ["/Windows\\System32", "/Windows\\System32".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["/Model opus", "/MODEL opus"])(
    "opens the model picker for capitalized %j the same as /model",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toMatchObject({
        kind: "slash-model",
        query: "opus",
      });
    },
  );

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each([
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "$1,000",
    "£2e6",
    "raise $10k.",
  ])("does not open the skill menu for the amount in %j", (text) =>
    expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "$1password", "$2fa"])("still detects the skill prefix %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toMatchObject({
      kind: "skill",
      query: text.slice(1),
    });
  });
});

describe("continueComposerPathTrigger", () => {
  const continued = (text: string, previousText: string | null) =>
    continueComposerPathTrigger({
      text,
      cursor: text.length,
      detected: detectComposerTrigger(text, text.length),
      previous: previousText === null ? null : detectComposerTrigger(previousText, Infinity),
    });

  it.each([
    ["Open @Foreign ", "Foreign "],
    ["Open @Foreign Sub", "Foreign Sub"],
  ])("carries the active search into %j", (text, query) => {
    expect(continued(text, "Open @Foreign")).toEqual({
      kind: "path",
      query,
      rangeStart: 5,
      rangeEnd: text.length,
    });
  });

  it("stays in the search while the caret moves back through the query", () => {
    const spaced = continued("Open @Foreign Sub", "Open @Foreign");
    expect(
      continueComposerPathTrigger({
        text: "Open @Foreign Sub",
        cursor: "Open @Foreign ".length,
        detected: null,
        previous: spaced,
      }),
    ).toMatchObject({ query: "Foreign ", rangeStart: 5, rangeEnd: 14 });
  });

  it.each([
    ["no search was active", "Open @Foreign Sub", null],
    ["the query was replaced", "Open @Other thing", "Open @Foreign"],
    ["the at sign was deleted", "Open Foreign Sub", "Open @Foreign"],
    ["a newline ends the line", "Open @Foreign\n", "Open @Foreign"],
    ["a tab follows", "Open @Foreign\tSub", "Open @Foreign"],
    ["a terminal context follows", "Open @Foreign \uFFFC", "Open @Foreign"],
    ["only a space follows the at sign", "Open @ ", "Open @"],
    ["the active trigger is not a mention", "Run $skill now", "Run $skill"],
  ])("ends the search when %s", (_name, text, previousText) => {
    expect(continued(text, previousText)).toBeNull();
  });

  it("prefers a trigger detected at the caret", () => {
    expect(continued("Open @Foreign and @Sub", "Open @Foreign and")).toMatchObject({
      query: "Sub",
      rangeStart: 18,
    });
  });
});

describe("composerItemAnswersTrigger", () => {
  const spaced = { kind: "path", query: "Foreign Sub" };

  it("offers any result for a query without a space", () => {
    expect(
      composerItemAnswersTrigger({ label: "README.md" }, { kind: "path", query: "rdme" }),
    ).toBe(true);
  });

  it("offers a result for a spaced query only when it contains the typed text", () => {
    expect(composerItemAnswersTrigger({ label: "foreign subsidiaries" }, spaced)).toBe(true);
    expect(
      composerItemAnswersTrigger(
        { label: "Notes.md", path: "Foreign Subsidiaries/Notes.md" },
        spaced,
      ),
    ).toBe(true);
    expect(
      composerItemAnswersTrigger(
        { label: "ChatComposer.tsx", path: "src/ChatComposer.tsx" },
        { kind: "path", query: "ChatComposer so" },
      ),
    ).toBe(false);
    expect(
      composerItemAnswersTrigger({ label: "README.md" }, { kind: "path", query: "README " }),
    ).toBe(false);
  });
});

describe("serializeComposerFileLink", () => {
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

describe("parseSideChatCommand", () => {
  it("reads an optional prompt after /side or /btw", () => {
    expect(parseSideChatCommand("/side")).toEqual({ prompt: "" });
    expect(parseSideChatCommand("  /SIDE  why does this fail?\nline two ")).toEqual({
      prompt: "why does this fail?\nline two",
    });
    expect(parseSideChatCommand("/btw check @src/a.ts")).toEqual({ prompt: "check @src/a.ts" });
  });

  it("ignores other commands and inline mentions", () => {
    expect(parseSideChatCommand("/sidebar")).toBeNull();
    expect(parseSideChatCommand("/btwx")).toBeNull();
    expect(parseSideChatCommand("ask /side later")).toBeNull();
  });
});
