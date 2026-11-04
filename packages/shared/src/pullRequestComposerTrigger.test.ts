import { describe, expect, it } from "vite-plus/test";

import {
  detectPullRequestMention,
  insertPullRequestMention,
  narrowPullRequestMentions,
  pullRequestMentionSearch,
} from "./pullRequestComposerTrigger.ts";

describe("detectPullRequestMention", () => {
  it.each([
    ["@", 0, ""],
    ["cc @ju", 3, "ju"],
    ["line one\n@first.last", 9, "first.last"],
    ["@jane-doe more", 0, "jane-doe"],
  ])("finds the mention in %j", (text, rangeStart, query) => {
    const cursor = rangeStart + 1 + query.length;
    expect(detectPullRequestMention(text, cursor)).toEqual({
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
  ])("ignores %j", (text, cursor) => {
    expect(detectPullRequestMention(text, cursor)).toBeNull();
  });
});

describe("insertPullRequestMention", () => {
  it("replaces the partial login and adds a space", () => {
    const text = "thanks @ju";
    const trigger = detectPullRequestMention(text, text.length)!;
    expect(insertPullRequestMention(text, trigger, "julius")).toEqual({
      text: "thanks @julius ",
      cursor: "thanks @julius ".length,
    });
  });

  it("reuses the space that already follows and moves past it", () => {
    const text = "@ju please look";
    const trigger = detectPullRequestMention(text, 3)!;
    const inserted = insertPullRequestMention(text, trigger, "julius");
    expect(inserted).toEqual({ text: "@julius please look", cursor: "@julius ".length });
    expect(detectPullRequestMention(inserted.text, inserted.cursor)).toBeNull();
  });
});

describe("pullRequestMentionSearch", () => {
  it.each([
    ["", undefined],
    ["To", undefined],
    ["Ton", "Ton"],
  ])("sends %j to the host as %j", (typed, query) => {
    expect(pullRequestMentionSearch(typed)).toBe(query);
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
