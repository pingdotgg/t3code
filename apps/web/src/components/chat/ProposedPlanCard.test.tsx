import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light",
    resolvedTheme: "light",
  }),
}));

describe("ProposedPlanCard", () => {
  it("highlights matches in the rendered plan title", async () => {
    const { ProposedPlanCard } = await import("./ProposedPlanCard");
    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planMarkdown={"## Seeded Thread Search Plan\n\n1. First step"}
        cwd={undefined}
        workspaceRoot={undefined}
        searchQuery="seed"
        searchActive
      />,
    );

    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).toContain("<mark");
    expect(markup).toContain(">Seed<");
  });

  it("reveals collapsed plan matches while searching", async () => {
    const { ProposedPlanCard } = await import("./ProposedPlanCard");
    const longBody = Array.from({ length: 14 }, (_, index) => `- filler line ${index + 1}`).join(
      "\n",
    );
    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planMarkdown={`# Search plan\n\n${longBody}\n- buried search token`}
        cwd={undefined}
        workspaceRoot={undefined}
        searchQuery="search token"
        searchActive
      />,
    );

    expect(markup).toContain('data-thread-search-highlight="active"');
    expect(markup).toContain(">search token<");
    expect(markup).not.toContain("Expand plan");
  });
});
