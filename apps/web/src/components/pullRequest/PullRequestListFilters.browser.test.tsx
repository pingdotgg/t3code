import { CircleDashedIcon, LayersIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const hosted = vi.hoisted(() => ({
  labels: [] as Array<{ readonly name: string; readonly color: string | null }>,
  authors: [],
  references: [],
  error: null,
  isPending: false,
}));

vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  usePullRequestFilterOptions: () => hosted,
}));

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

describe("PullRequestFiltersMenu label search", () => {
  it("keeps a selected label's color and count while searching for another label", async () => {
    await using screen = await render(
      <PullRequestFiltersMenu
        state="open"
        stateOptions={[{ value: "open", label: "Open", Icon: CircleDashedIcon }]}
        onState={vi.fn()}
        involvement="all"
        involvementOptions={[{ value: "all", label: "All", Icon: LayersIcon }]}
        onInvolvement={vi.fn()}
        filters={{ labels: [["bug"]] }}
        onFilters={vi.fn()}
        labelOptions={[
          { name: "bug", color: "d73a4a", count: 5 },
          { name: "docs", color: "0075ca", count: 2 },
        ]}
        optionScope={[]}
        host={undefined}
        hostOptions={[]}
        onHost={vi.fn()}
        server={undefined}
        serverOptions={[]}
        onServer={vi.fn()}
        projects={[]}
        projectId={undefined}
        projectEnvironmentId={undefined}
        unavailable={new Map()}
        onProject={vi.fn()}
      />,
    );

    await screen.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitem", { name: /Labels/ }).click();
    await userEvent.fill(page.getByRole("textbox", { name: "Search labels" }), "docs");

    const bugRow = page.getByRole("menuitemcheckbox", { name: /bug/ });
    await expect.element(bugRow).toBeInTheDocument();
    await expect.element(bugRow.getByText("5")).toBeInTheDocument();
    const dot = bugRow.element().querySelector<HTMLElement>(".rounded-full");
    expect(dot?.style.backgroundColor).toBe("rgb(215, 58, 74)");
    await expect.element(page.getByRole("menuitemcheckbox", { name: /docs/ })).toBeInTheDocument();
  });
});
