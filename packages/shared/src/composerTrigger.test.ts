import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
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

  it("keeps classic bare @ and # when the mention-index labs flag is off", () => {
    expect(detectComposerTrigger("@jira:login", "@jira:login".length)).toEqual({
      kind: "path",
      query: "jira:login",
      rangeStart: 0,
      rangeEnd: "@jira:login".length,
    });
    expect(detectComposerTrigger("#12", "#12".length)).toEqual({
      kind: "pull-request",
      query: "12",
      rangeStart: 0,
      rangeEnd: "#12".length,
    });
  });

  it("treats @kind: as type filters and # as PRs+issues when mention index is on", () => {
    const on = { mentionIndexEnabled: true } as const;
    expect(detectComposerTrigger("@jira:login", "@jira:login".length, on)).toEqual({
      kind: "jira",
      query: "login",
      rangeStart: 0,
      rangeEnd: "@jira:login".length,
    });
    expect(detectComposerTrigger("@figma:checkout", "@figma:checkout".length, on)).toEqual({
      kind: "figma",
      query: "checkout",
      rangeStart: 0,
      rangeEnd: "@figma:checkout".length,
    });
    expect(detectComposerTrigger("@file:src/", "@file:src/".length, on)).toEqual({
      kind: "file",
      query: "src/",
      rangeStart: 0,
      rangeEnd: "@file:src/".length,
    });
    expect(detectComposerTrigger("@thread:fix", "@thread:fix".length, on)).toEqual({
      kind: "thread",
      query: "fix",
      rangeStart: 0,
      rangeEnd: "@thread:fix".length,
    });
    expect(detectComposerTrigger("@pr:12", "@pr:12".length, on)).toEqual({
      kind: "pull-request",
      query: "12",
      rangeStart: 0,
      rangeEnd: "@pr:12".length,
    });
    expect(detectComposerTrigger("@issue:42", "@issue:42".length, on)).toEqual({
      kind: "issue",
      query: "42",
      rangeStart: 0,
      rangeEnd: "@issue:42".length,
    });
    expect(detectComposerTrigger("@src/", "@src/".length, on)).toEqual({
      kind: "path",
      query: "src/",
      rangeStart: 0,
      rangeEnd: "@src/".length,
    });
    expect(detectComposerTrigger("@", "@".length, on)).toEqual({
      kind: "path",
      query: "",
      rangeStart: 0,
      rangeEnd: 1,
    });
    expect(detectComposerTrigger("#12", "#12".length, on)).toEqual({
      kind: "hash",
      query: "12",
      rangeStart: 0,
      rangeEnd: "#12".length,
    });
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
