import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { RuleEditor } from "./RulesSettings";
import { draftFromRule } from "./RulesSettings.logic";

describe("Rules settings editor", () => {
  it("renders file targeting and reversible lifecycle controls", () => {
    const markup = renderToStaticMarkup(
      <RuleEditor
        draft={draftFromRule()}
        isNew
        archived={false}
        isLoading={false}
        error={null}
        notice={null}
        disabled={false}
        isMutating={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onArchiveRestore={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Rule file globs"');
    expect(markup).toContain('aria-label="Rule profiles"');
    expect(markup).toContain('aria-label="Rule instructions"');
    expect(markup).toContain("Save");
  });

  it("locks the editor while the selected rule is loading", () => {
    const markup = renderToStaticMarkup(
      <RuleEditor
        draft={draftFromRule()}
        isNew={false}
        archived={false}
        isLoading
        error={null}
        notice={null}
        disabled={false}
        isMutating={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onArchiveRestore={() => undefined}
      />,
    );

    expect(markup).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Rule name"/);
    expect(markup).toMatch(/<textarea[^>]*disabled=""[^>]*aria-label="Rule file globs"/);
    expect(markup).toMatch(/<textarea[^>]*disabled=""[^>]*aria-label="Rule instructions"/);
  });

  it("locks both lifecycle actions while a mutation is in flight", () => {
    const markup = renderToStaticMarkup(
      <RuleEditor
        draft={draftFromRule()}
        isNew={false}
        archived={false}
        isLoading={false}
        error={null}
        notice={null}
        disabled={false}
        isMutating
        onChange={() => undefined}
        onSave={() => undefined}
        onArchiveRestore={() => undefined}
      />,
    );

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Archive.*<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Save.*<\/button>/);
  });
});
