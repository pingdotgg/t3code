import { describe, expect, it } from "vite-plus/test";

import {
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  narrowPullRequestMentions,
  narrowPullRequestReferences,
  pullRequestCompletionSearch,
} from "./pullRequestComposerTrigger.ts";

describe("detectPullRequestComposerTrigger", () => {
  it.each([
    ["@", 0, "@", ""],
    ["cc @ju", 3, "@", "ju"],
    ["line one\n@first.last", 9, "@", "first.last"],
    ["@jane-doe more", 0, "@", "jane-doe"],
    ["fixes #", 6, "#", ""],
    ["see #12", 4, "#", "12"],
    ["after !5", 6, "!", "5"],
    ["#crash", 0, "#", "crash"],
  ])("finds the trigger in %j", (text, rangeStart, sigil, query) => {
    const cursor = rangeStart + 1 + query.length;
    expect(detectPullRequestComposerTrigger(text, cursor)).toEqual({
      kind: sigil === "@" ? "mention" : "reference",
      sigil,
      query,
      rangeStart,
      rangeEnd: cursor,
    });
  });

  it.each([
    ["mail me at jane@example.com", "mail me at jane@example.com".length],
    ["@jane done", "@jane done".length],
    ["@-jane", "@-jane".length],
    ["`@decorator`", "`@decorator".length],
    ["@jane", 3],
    ["C#", 2],
    ["![image", "![image".length],
    ["## Heading", 2],
  ])("ignores %j", (text, cursor) => {
    expect(detectPullRequestComposerTrigger(text, cursor)).toBeNull();
  });
});

describe("insertPullRequestCompletion", () => {
  it("replaces the partial token and adds a space", () => {
    const text = "thanks @ju";
    const trigger = detectPullRequestComposerTrigger(text, text.length)!;
    expect(insertPullRequestCompletion(text, trigger, "@julius")).toEqual({
      text: "thanks @julius ",
      cursor: "thanks @julius ".length,
    });
  });

  it("reuses the space that already follows and moves past it", () => {
    const text = "#1 please look";
    const trigger = detectPullRequestComposerTrigger(text, 2)!;
    const inserted = insertPullRequestCompletion(text, trigger, "#123");
    expect(inserted).toEqual({ text: "#123 please look", cursor: "#123 ".length });
    expect(detectPullRequestComposerTrigger(inserted.text, inserted.cursor)).toBeNull();
  });
});

describe("pullRequestCompletionSearch", () => {
  it.each([
    ["mention", "", undefined],
    ["mention", "To", undefined],
    ["mention", "12", undefined],
    ["mention", "Ton", "Ton"],
    ["reference", "", undefined],
    ["reference", "1", "1"],
    ["reference", "cr", undefined],
    ["reference", "crash", "crash"],
  ] as const)("sends a %s's %j to the host as %j", (kind, query, sent) => {
    expect(pullRequestCompletionSearch({ kind, query })).toBe(sent);
  });
});

describe("narrowPullRequestMentions", () => {
  it("matches login or name, case-insensitively, up to the limit", () => {
    const users = [
      { login: "TonybynMp4", name: null },
      { login: "16g", name: "Tom" },
      { login: "theo", name: "Theo" },
    ];
    expect(narrowPullRequestMentions(users, "to", 5).map((u) => u.login)).toEqual([
      "TonybynMp4",
      "16g",
    ]);
    expect(narrowPullRequestMentions(users, "", 2)).toHaveLength(2);
  });
});

describe("narrowPullRequestReferences", () => {
  it("keeps the sigil's kind and matches a number prefix or the title", () => {
    const candidates = [
      { reference: "#12", number: 12, title: "Crash on start" },
      { reference: "!12", number: 12, title: "Fix the crash" },
      { reference: "#3", number: 3, title: "Issue 12 follow-up" },
      { reference: "#120", number: 120, title: "Docs" },
    ];
    const narrowed = (sigil: "#" | "!", query: string) =>
      narrowPullRequestReferences(candidates, { sigil, query }, 5).map((c) => c.reference);
    expect(narrowed("#", "12")).toEqual(["#12", "#3", "#120"]);
    expect(narrowed("!", "CRASH")).toEqual(["!12"]);
    expect(narrowed("#", "")).toEqual(["#12", "#3", "#120"]);
  });
});
