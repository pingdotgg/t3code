import { ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const fallbackSkill: ServerProviderSkill = {
  name: "provider-fallback",
  path: "/skills/provider-fallback/SKILL.md",
  enabled: true,
};

const fallbackSkillItem: ComposerCommandItem = {
  id: "skill:provider-fallback",
  type: "skill",
  provider: ProviderDriverKind.make("codex"),
  skill: fallbackSkill,
  label: "provider-fallback",
  description: "Provider snapshot skill",
};

describe("ComposerCommandMenu", () => {
  it("surfaces workspace skill errors alongside fallback skills", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[fallbackSkillItem]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        errorText="Failed to load workspace skills."
        activeItemId={fallbackSkillItem.id}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Failed to load workspace skills.");
    expect(markup).toContain("provider-fallback");
  });
});
