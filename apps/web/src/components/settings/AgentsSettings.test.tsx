import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProfileEditor } from "./AgentsSettings";
import { draftFromProfile } from "./AgentsSettings.logic";

describe("Agents settings editor", () => {
  it("renders accessible controls for the complete profile policy", () => {
    const markup = renderToStaticMarkup(
      <ProfileEditor
        draft={draftFromProfile()}
        isNew
        selectedSummary={null}
        canEdit
        error={null}
        notice={null}
        isLoading={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onArchiveRestore={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Profile instructions"');
    expect(markup).toContain('aria-label="Show in chat Agent picker"');
    expect(markup).toContain('aria-label="Maximum total tokens"');
    expect(markup).toContain('aria-label="Profile hooks"');
    expect(markup).toContain('aria-label="Profile rules"');
    expect(markup).toContain("Save");
  });

  it("locks the scope for an existing profile identity", () => {
    const markup = renderToStaticMarkup(
      <ProfileEditor
        draft={{ ...draftFromProfile(), id: "reviewer", name: "Reviewer" }}
        isNew={false}
        selectedSummary={null}
        canEdit
        error={null}
        notice={null}
        isLoading={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onArchiveRestore={() => undefined}
      />,
    );
    expect(markup).toMatch(/<select[^>]*disabled=""[^>]*aria-label="Profile scope"/);
  });
});
