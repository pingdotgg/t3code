import { describe, expect, it } from "vite-plus/test";

import {
  continueComposerPathTrigger,
  detectComposerTrigger,
  hasSpacedPathSearchEnded,
  literalSpacedPathMatches,
  parseSideChatCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
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
  const before = "Inspect @Release then summarize";
  const open = detectComposerTrigger(before, "Inspect @Release".length);
  const queryEnd = "Inspect @Release".length;

  it("continues an open @ search across spaces up to the caret", () => {
    const text = "Inspect @Release Notes.md then summarize";
    const cursor = "Inspect @Release Notes.md".length;
    expect(continueComposerPathTrigger(text, cursor, open, before, queryEnd)).toEqual({
      trigger: { kind: "path", query: "Release Notes.md", rangeStart: 8, rangeEnd: cursor },
      queryEnd: cursor,
    });
  });

  it.each([
    ["the caret leaves for existing prose", before, before.length],
    ["a newline enters the query", "Inspect @Release\nthen summarize", 17],
    ["a tab enters the query", "Inspect @Release\tthen summarize", 17],
    ["text before the @ changes", "Inspekt @Release N then summarize", 18],
  ])("stops when %s", (_name, text, cursor) => {
    expect(continueComposerPathTrigger(text, cursor, open, before, queryEnd)).toBeNull();
  });
});

describe("literalSpacedPathMatches", () => {
  const items = [
    { label: "Release Notes.md", path: "docs/Release Notes.md" },
    { label: "AGENTS.md", path: "AGENTS.md" },
    { label: "Fix login flow" },
  ];

  it.each([
    ["AGENTS", ["Release Notes.md", "AGENTS.md", "Fix login flow"]],
    ["release no", ["Release Notes.md"]],
    ["login f", ["Fix login flow"]],
    ["AGENTS.md ", []],
    ["AGENTS.md before you push", []],
  ])("keeps the literal matches for %j", (query, labels) => {
    expect(literalSpacedPathMatches(items, query).map((item) => item.label)).toEqual(labels);
  });
});

describe("hasSpacedPathSearchEnded", () => {
  const spaced = detectComposerTrigger("@Release", 8)!;
  const trigger = { ...spaced, query: "Release N", rangeEnd: 10 };
  const settled = { trigger, itemCount: 0, isPending: false, threadMatchCount: 0 };

  it("ends a spaced search once nothing matches and every search has settled", () => {
    expect(hasSpacedPathSearchEnded(settled)).toBe(true);
  });

  it.each([
    ["a search is pending", { isPending: true }],
    ["a thread title matched before its row mounted", { threadMatchCount: 1 }],
    ["items remain", { itemCount: 1 }],
    ["the query has no space", { trigger: spaced }],
  ])("keeps the search open while %s", (_name, override) => {
    expect(hasSpacedPathSearchEnded({ ...settled, ...override })).toBe(false);
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
