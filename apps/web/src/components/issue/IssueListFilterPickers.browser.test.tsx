import { CircleDashedIcon, LayersIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const candidates = vi.hoisted(() => ({
  labels: [
    { name: "bug", color: "d73a4a", description: "Something is broken" },
    { name: "docs", color: "0075ca", description: "Documentation" },
  ],
  assignees: [
    { id: "1", login: "alice", name: "Alice Smith", avatarUrl: null },
    { id: "2", login: "bob", name: "Bob Jones", avatarUrl: null },
  ],
  isPending: false,
  error: null as string | null,
  truncated: false,
}));

vi.mock(import("~/state/issues"), async (original) => ({
  ...(await original()),
  useIssueFilterCandidates: () => candidates,
}));

import { IssueFiltersMenu } from "./IssueListFilterPickers";

function renderMenu(props?: { labels?: ReadonlyArray<string>; assignee?: string | undefined }) {
  return render(
    <IssueFiltersMenu
      state="open"
      stateOptions={[
        { value: "open", label: "Open", Icon: CircleDashedIcon },
        { value: "closed", label: "Closed", Icon: CircleDashedIcon },
      ]}
      onState={vi.fn()}
      involvement="all"
      involvementOptions={[{ value: "all", label: "All", Icon: LayersIcon }]}
      onInvolvement={vi.fn()}
      scopes={[]}
      labels={props?.labels ?? []}
      onLabels={vi.fn()}
      assignee={props?.assignee}
      onAssignee={vi.fn()}
      projects={[]}
      hiddenProjects={new Set()}
      onHiddenProjects={vi.fn()}
    />,
  );
}

describe("IssueFiltersMenu search", () => {
  it("hides non-matching selected labels and shows the empty state when nothing matches", async () => {
    await using screen = await renderMenu({ labels: ["bug"] });
    await screen.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitem", { name: /Labels/ }).click();

    const search = page.getByRole("textbox", { name: "Search labels" });
    await userEvent.fill(search, "docs");

    await expect.element(page.getByRole("menuitemcheckbox", { name: "docs" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "bug" }))
      .not.toBeInTheDocument();

    await userEvent.fill(search, "zzzz");

    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "bug" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("No labels found")).toBeInTheDocument();
  });

  it("hides a non-matching selected assignee when searching people", async () => {
    await using screen = await renderMenu({ assignee: "alice" });
    await screen.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitem", { name: /Assignee/ }).click();

    const search = page.getByRole("textbox", { name: "Search people" });
    await userEvent.fill(search, "bob");

    await expect.element(page.getByRole("menuitemradio", { name: /bob/ })).toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitemradio", { name: /alice/ }))
      .not.toBeInTheDocument();
  });
});
