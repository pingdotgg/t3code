import { describe, expect, it } from "vite-plus/test";

import { rewriteDevinSkillMentions } from "./devinAcp.ts";

describe("rewriteDevinSkillMentions", () => {
  it("rewrites known $skill mentions to the /name form Devin invokes", () => {
    expect(
      rewriteDevinSkillMentions(
        "$full-send now, then $unslop and $unknown for $5",
        new Set(["full-send", "unslop"]),
      ),
    ).toBe("/full-send now, then /unslop and $unknown for $5");
  });
});
