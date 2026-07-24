import { describe, expect, it } from "vite-plus/test";

import { shouldLoadThreadProviderWorkspaceSkills } from "./thread-provider-skills";

function feedMessage(role: string, text: string) {
  return {
    type: "message",
    message: { role, text },
  };
}

describe("shouldLoadThreadProviderWorkspaceSkills", () => {
  it("keeps an empty thread composer lazy", () => {
    expect(
      shouldLoadThreadProviderWorkspaceSkills({
        composerSkillMenuActive: false,
        draftMessage: "",
        feed: [],
      }),
    ).toBe(false);
  });

  it("loads while the composer skill menu is active", () => {
    expect(
      shouldLoadThreadProviderWorkspaceSkills({
        composerSkillMenuActive: true,
        draftMessage: "$review-follow-up",
        feed: [],
      }),
    ).toBe(true);
  });

  it("loads for complete draft and sent user skill references", () => {
    expect(
      shouldLoadThreadProviderWorkspaceSkills({
        composerSkillMenuActive: false,
        draftMessage: "Use $review-follow-up next",
        feed: [],
      }),
    ).toBe(true);
    expect(
      shouldLoadThreadProviderWorkspaceSkills({
        composerSkillMenuActive: false,
        draftMessage: "",
        feed: [feedMessage("user", "Use $review-follow-up")],
      }),
    ).toBe(true);
  });

  it("ignores assistant references and incomplete inactive drafts", () => {
    expect(
      shouldLoadThreadProviderWorkspaceSkills({
        composerSkillMenuActive: false,
        draftMessage: "Use $review-follow-up",
        feed: [feedMessage("assistant", "Try $review-follow-up")],
      }),
    ).toBe(false);
  });
});
