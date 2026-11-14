import { describe, expect, it } from "vite-plus/test";

import {
  debouncedPullRequestCompletionSearch,
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  narrowPullRequestMentions,
  narrowPullRequestReferences,
} from "./pullRequestComposerTrigger.ts";

const GITLAB = { mentions: true, referenceSigils: ["#", "!"] } as const;

describe("detectPullRequestComposerTrigger", () => {
  it.each([
    ["@", 0, "@", ""],
    ["cc @ju", 3, "@", "ju"],
    ["line one\n@first.last", 9, "@", "first.last"],
    ["@jane-doe more", 0, "@", "jane-doe"],
    ["cc @김철", 3, "@", "김철"],
    ["@ㄱ", 0, "@", "ㄱ"],
    ["@प्रिया", 0, "@", "प्रिया"],
    ["fixes #", 6, "#", ""],
    ["see #12", 4, "#", "12"],
    ["after !5", 6, "!", "5"],
    ["#crash", 0, "#", "crash"],
  ])("finds the trigger in %j", (text, rangeStart, sigil, query) => {
    const cursor = rangeStart + 1 + query.length;
    expect(detectPullRequestComposerTrigger(text, cursor, GITLAB)).toEqual({
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
    expect(detectPullRequestComposerTrigger(text, cursor, GITLAB)).toBeNull();
  });

  it.each([
    ["@ju", {}],
    ["#12", { mentions: true }],
    ["!important", { mentions: true, referenceSigils: ["#"] }],
    ["#12", { mentions: true, referenceSigils: [] }],
  ] as const)("ignores %j on a host that cannot complete it", (text, support) => {
    expect(detectPullRequestComposerTrigger(text, text.length, support)).toBeNull();
  });
});

describe("insertPullRequestCompletion", () => {
  it.each(["", "\nnext line", "\r\nnext line"])(
    "replaces the partial token and adds a space before %j",
    (suffix) => {
      const text = `thanks @ju${suffix}`;
      const trigger = detectPullRequestComposerTrigger(text, "thanks @ju".length, GITLAB)!;
      expect(insertPullRequestCompletion(text, trigger, "@julius")).toEqual({
        text: `thanks @julius ${suffix}`,
        cursor: "thanks @julius ".length,
      });
    },
  );

  it("reuses the space that already follows and moves past it", () => {
    const text = "#1 please look";
    const trigger = detectPullRequestComposerTrigger(text, 2, GITLAB)!;
    const inserted = insertPullRequestCompletion(text, trigger, "#123");
    expect(inserted).toEqual({ text: "#123 please look", cursor: "#123 ".length });
    expect(detectPullRequestComposerTrigger(inserted.text, inserted.cursor, GITLAB)).toBeNull();
  });
});

describe("debouncedPullRequestCompletionSearch", () => {
  it.each([
    ["a settled search", { sigil: "#" }, "#crash", "crash"],
    ["a settled bare sigil", { sigil: "@" }, "@", undefined],
    ["a lagging search", { sigil: "#" }, "#cra", "cra"],
    ["the other sigil's key", { sigil: "!" }, "#12", undefined],
    ["no key yet", { sigil: "#" }, null, undefined],
  ] as const)("sends %s as the host search", (_, trigger, key, sent) => {
    expect(debouncedPullRequestCompletionSearch(trigger, key)).toBe(sent);
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
