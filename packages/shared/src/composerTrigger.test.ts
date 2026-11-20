import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  parseSideChatCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

function parsedLinkLabel(markdown: string): string | undefined {
  const textOf = (node: MarkdownNode): string =>
    node.value ?? (node.children ?? []).map(textOf).join("");
  const find = (node: MarkdownNode): MarkdownNode | undefined =>
    node.type === "link" ? node : node.children?.map(find).find(Boolean);
  const link = find(unified().use(remarkParse).parse(markdown) as MarkdownNode);
  return link && textOf(link);
}

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

  it.each([
    ["/model", 0],
    ["Question\n/MODEL", 9],
  ])("offers typed %j as a slash command", (text, rangeStart) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(rangeStart + 1),
      rangeStart,
      rangeEnd: text.length,
    });
  });

  it("does not reopen a menu after /model arguments", () => {
    expect(detectComposerTrigger("/Model opus", "/Model opus".length)).toBeNull();
  });

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

  it.each([
    ["", "", ""],
    ["Compare ", "8737", ""],
    ["Compare (", "", ")"],
    ["Compare(", "fix-name", ")"],
    ["((", "fix_name", "))"],
    ["[", "8737", "]"],
    ["{", "8737", "}"],
    ["【", "修正", "】"],
  ])("keeps brackets outside the PR range after %j", (prefix, query, suffix) => {
    const text = `${prefix}#${query}`;
    expect(detectComposerTrigger(`${text}${suffix}`, text.length)).toEqual({
      kind: "pull-request",
      query,
      rangeStart: prefix.length,
      rangeEnd: text.length,
    });
  });

  it.each([
    "# Heading",
    "issue#123",
    "https://example.com/#123",
    "(#123)",
    "[issue#123",
    "[#_fix",
    "]#123",
  ])("does not detect a pull request in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it.each([
    ["Investigate #1", "#", "pull-request"],
    ["Investigate !1", "#", null],
    ["Investigate #1", "!", "issue"],
    ["Investigate (#login", "!", "issue"],
    ["Investigate !1", "!", "pull-request"],
    ["Investigate (!fix", "!", "pull-request"],
    ["Hello!", "!", null],
  ] as const)("reads %j with change request sigil %s", (text, sigil, kind) => {
    expect(detectComposerTrigger(text, text.length, undefined, sigil)?.kind ?? null).toBe(kind);
  });

  it.each([
    ["@src/(#1", "path", "src/(#1"],
    ["$review(#1", "skill", "review(#1"],
  ])("keeps explicit completion for %j", (token, kind, query) => {
    const text = `Use ${token}`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind,
      query,
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

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

  it.each([
    ["pkg/__init__.py", "__init__.py"],
    ["notes/*draft*.md", "*draft*.md"],
  ])("renders the mention of %j with its file name as the label", (path, basename) => {
    expect(parsedLinkLabel(serializeComposerFileLink(path))).toBe(basename);
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
