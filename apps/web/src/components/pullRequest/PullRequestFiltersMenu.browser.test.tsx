import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import type { PullRequestInvolvement } from "@t3tools/contracts";

import { render } from "../../../test/render";
import { PullRequestFiltersMenu, type PullRequestFilterOption } from "./PullRequestListFilters";

import "~/index.css";

const PLAIN_ICON = () => null;

const STATE_OPTIONS: ReadonlyArray<PullRequestFilterOption<"open">> = [
  { value: "open", label: "Open", Icon: PLAIN_ICON },
];
const INVOLVEMENT_OPTIONS: ReadonlyArray<PullRequestFilterOption<PullRequestInvolvement>> = [
  { value: "all", label: "All", Icon: PLAIN_ICON },
  { value: "authored", label: "Authored", Icon: PLAIN_ICON },
  { value: "reviewing", label: "Reviewing", Icon: PLAIN_ICON },
];
const SERVER_OPTIONS: ReadonlyArray<PullRequestFilterOption<string>> = [
  { value: "", label: "All servers", Icon: PLAIN_ICON },
  { value: "local", label: "Local", Icon: PLAIN_ICON },
  { value: "remote", label: "Remote", Icon: PLAIN_ICON },
];

function createFiltersMenu() {
  return (
    <PullRequestFiltersMenu
      state="open"
      stateOptions={STATE_OPTIONS}
      onState={() => {}}
      involvement="all"
      involvementOptions={INVOLVEMENT_OPTIONS}
      onInvolvement={() => {}}
      filters={{}}
      onFilters={() => {}}
      optionScope={[]}
      server={undefined}
      serverOptions={SERVER_OPTIONS}
      onServer={() => {}}
      projects={[]}
      projectId={undefined}
      projectEnvironmentId={undefined}
      unavailable={new Map()}
      onProject={() => {}}
    />
  );
}

describe("Pull request filters menu", () => {
  it("leaves the host filter to the list's own selector instead of repeating it", async () => {
    await using screen = await render(createFiltersMenu());

    await userEvent.click(screen.getByRole("button", { name: /Filters/ }));
    await expect.element(page.getByRole("menuitem", { name: /^Project/ })).toBeInTheDocument();

    expect(page.getByRole("menuitem", { name: /^Host/ }).query()).toBeNull();
  });
});
