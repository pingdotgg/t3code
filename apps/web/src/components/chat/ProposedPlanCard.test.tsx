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
});
