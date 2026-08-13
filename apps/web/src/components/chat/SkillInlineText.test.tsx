import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SkillInlineText } from "./SkillInlineText";

const skills = [{ name: "github:gh-fix-ci", displayName: "Fix CI" }];

describe("SkillInlineText", () => {
  it("renders a resolved skill as an accessible button when it can be opened", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="Use $github:gh-fix-ci now" skills={skills} onSkillClick={() => {}} />,
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Open $github:gh-fix-ci"');
    expect(markup).toContain("Fix CI");
  });

  it("leaves unresolved names as text and resolved names inert without an opener", () => {
    const unresolved = renderToStaticMarkup(
      <SkillInlineText text="Use $missing" skills={skills} onSkillClick={() => {}} />,
    );
    const inert = renderToStaticMarkup(
      <SkillInlineText text="Use $github:gh-fix-ci" skills={skills} />,
    );

    expect(unresolved).not.toContain("<button");
    expect(unresolved).toContain("$missing");
    expect(inert).not.toContain("<button");
  });
});
