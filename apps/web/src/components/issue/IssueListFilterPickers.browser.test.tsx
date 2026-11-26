import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock(import("~/state/issues"), async (original) => ({
  ...(await original()),
  useIssueFilterCandidates: (() => ({
    labels: [
      { name: "bug", description: null, color: "d73a4a" },
      { name: "docs", description: null, color: "0075ca" },
    ],
    assignees: [
      { login: "octocat", name: "Mona Octocat" },
      { login: "hubot", name: "Hubot Robot" },
    ],
    isPending: false,
    error: null,
    truncated: false,
  })) as never,
}));

import { IssueFiltersMenu } from "./IssueListFilterPickers";

function renderMenu(props: { labels: ReadonlyArray<string>; assignee: string | undefined }) {
  return render(
    <IssueFiltersMenu
      state="open"
      stateOptions={[]}
      onState={() => {}}
      involvement="all"
      involvementOptions={[]}
      onInvolvement={() => {}}
      scopes={[]}
      labels={props.labels}
      onLabels={() => {}}
      assignee={props.assignee}
      onAssignee={() => {}}
      projects={[]}
      hiddenProjects={new Set()}
      onHiddenProjects={() => {}}
    />,
  );
}

describe("IssueFiltersMenu search", () => {
  it("hides a selected label that does not match the search and says none were found", async () => {
    await using screen = await renderMenu({ labels: ["bug"], assignee: undefined });
    await screen.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitem", { name: /Labels/ }).click();

    await userEvent.fill(page.getByRole("textbox", { name: "Search labels" }), "zzzz");

    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "bug" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("No labels found")).toBeInTheDocument();
  });

  it("hides a selected assignee that does not match the search", async () => {
    await using screen = await renderMenu({ labels: [], assignee: "octocat" });
    await screen.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("menuitem", { name: /Assignee/ }).click();

    await userEvent.fill(page.getByRole("textbox", { name: "Search people" }), "hubot");

    await expect.element(page.getByRole("menuitemradio", { name: /hubot/ })).toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitemradio", { name: /octocat/ }))
      .not.toBeInTheDocument();
  });
});
