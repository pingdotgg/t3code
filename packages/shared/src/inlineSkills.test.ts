import { describe, expect, it } from "vite-plus/test";

import { formatProviderSkillDisplayName } from "./inlineSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("does not repeat a Claude plugin name that matches its skill name", () => {
    expect(formatProviderSkillDisplayName({ name: "frontend-design:frontend-design" })).toBe(
      "Frontend Design",
    );
    expect(formatProviderSkillDisplayName({ name: "pstack:comment-sicko" })).toBe(
      "Pstack Comment Sicko",
    );
  });
});
