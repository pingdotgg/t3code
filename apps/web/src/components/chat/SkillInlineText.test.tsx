import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { INLINE_CHIP_WRAPPER_CLASS_NAME } from "../composerInlineChip";
import { SkillInlineText } from "./SkillInlineText";

const handoffSkill = {
  name: "handoff",
  displayName: "Handoff",
};

describe("SkillInlineText", () => {
  it("renders a known skill token as a labeled chip", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="run $handoff now" skills={[handoffSkill]} />,
    );

    expect(markup.match(/data-markdown-copy="\$handoff"/g)).toHaveLength(1);
    expect(markup).toContain(">Handoff</span>");
  });

  it("preserves a skill token as plain text when no skills are available", () => {
    const markup = renderToStaticMarkup(<SkillInlineText text="run $handoff now" skills={[]} />);

    expect(markup).toBe("run $handoff now");
    expect(markup).not.toContain("data-markdown-copy");
  });

  it("preserves an unknown skill token when other skills are available", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="$not-a-skill" skills={[handoffSkill]} />,
    );

    expect(markup).toBe("$not-a-skill");
    expect(markup).not.toContain("data-markdown-copy");
  });

  it("preserves a skill token adjacent to punctuation", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="($handoff)" skills={[handoffSkill]} />,
    );

    expect(markup).toBe("($handoff)");
    expect(markup).not.toContain("data-markdown-copy");
  });

  it("uses the shared inline chip wrapper class", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="$handoff" skills={[handoffSkill]} />,
    );
    const wrapperClass = /<span class="([^"]+)" data-markdown-copy="\$handoff">/.exec(markup)?.[1];

    expect(wrapperClass).toBe(INLINE_CHIP_WRAPPER_CLASS_NAME);
  });

  it("wraps a described skill chip in a tooltip trigger", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText
        text="$handoff"
        skills={[{ ...handoffSkill, description: "Prepare a handoff document" }]}
      />,
    );

    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup.match(/data-markdown-copy="\$handoff"/g)).toHaveLength(1);
  });

  it("renders a chip without a tooltip when the skill has no description", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="$handoff" skills={[handoffSkill]} />,
    );

    expect(markup).not.toContain("tooltip-trigger");
  });
});
