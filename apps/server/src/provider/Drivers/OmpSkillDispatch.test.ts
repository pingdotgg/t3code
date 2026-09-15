import { describe, expect, it } from "vite-plus/test";

import { rewriteOmpSkillMentions } from "./OmpSkillDispatch.ts";

const SKILLS = new Set(["tdd", "2spec", "code-review", "skill:weird"]);

describe("rewriteOmpSkillMentions", () => {
  it("leaves a prompt without a known mention untouched", () => {
    expect(rewriteOmpSkillMentions("fix the build", SKILLS)).toBeUndefined();
    expect(rewriteOmpSkillMentions("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("rewrites a mention in place and keeps the surrounding prose", () => {
    expect(rewriteOmpSkillMentions("ok, now $tdd the parser", SKILLS)).toBe(
      "ok, now /skill:tdd the parser",
    );
  });

  it("rewrites a mention that opens the prompt", () => {
    expect(rewriteOmpSkillMentions("$code-review\nfocus on auth", SKILLS)).toBe(
      "/skill:code-review\nfocus on auth",
    );
  });

  it("rewrites every mention, since omp has no one-command-per-message limit", () => {
    expect(rewriteOmpSkillMentions("$code-review the diff, then $tdd the fix", SKILLS)).toBe(
      "/skill:code-review the diff, then /skill:tdd the fix",
    );
  });

  it("dispatches a skill whose name begins with a digit", () => {
    expect(rewriteOmpSkillMentions("use $2spec here", SKILLS)).toBe("use /skill:2spec here");
  });

  it("keeps currency amounts and glued tokens as prose", () => {
    const withCurrencyNames = new Set([...SKILLS, "20", "20k"]);
    expect(rewriteOmpSkillMentions("pay $20 tomorrow", withCurrencyNames)).toBeUndefined();
    expect(rewriteOmpSkillMentions("budget is $20k", withCurrencyNames)).toBeUndefined();
    expect(rewriteOmpSkillMentions("cost is 5$tdd", SKILLS)).toBeUndefined();
  });

  it("leaves the prompt alone when no skills were discovered", () => {
    expect(rewriteOmpSkillMentions("$tdd now", new Set())).toBeUndefined();
  });
});
