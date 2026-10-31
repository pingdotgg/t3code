import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SidebarEnvironmentFilter } from "./SidebarEnvironmentFilter";

const laptop = EnvironmentId.make("laptop");
const studio = EnvironmentId.make("studio");
const travel = EnvironmentId.make("travel");
const environments = [
  { environmentId: laptop, label: "Laptop" },
  { environmentId: studio, label: "Studio" },
  { environmentId: travel, label: "Travel" },
];
const projects = ["All projects", "Notes"];

function FilterMenu() {
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const [project, setProject] = useState("All projects");
  return (
    <Combobox
      autoHighlight
      items={projects}
      value={project}
      onValueChange={(value) => value && setProject(value)}
    >
      <ComboboxTrigger aria-label="Filter projects">Filter: {project}</ComboboxTrigger>
      <ComboboxPopup maxHeight="available">
        <ComboboxSearchInput aria-label="Search projects" placeholder="Search projects" />
        <ComboboxList>
          {(item: string) => <ComboboxItem value={item}>{item}</ComboboxItem>}
        </ComboboxList>
        <SidebarEnvironmentFilter
          environments={environments}
          excludedEnvironmentIds={excludedIds}
          machineByEnvironmentId={new Map()}
          primaryEnvironmentId={laptop}
          onChange={setExcludedIds}
        />
      </ComboboxPopup>
    </Combobox>
  );
}

describe("sidebar environment filter menu", () => {
  it("keeps multi-selection open and retains it when the footer collapses", async () => {
    await using screen = await render(<FilterMenu />);
    await screen.getByLabelText("Filter projects").click();
    await page.getByRole("button", { name: "All environments" }).click();
    await page.getByRole("checkbox", { name: "Travel" }).click();
    await expect.element(page.getByRole("checkbox", { name: "Travel" })).not.toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: "Studio" })).toBeChecked();
    await page.getByRole("checkbox", { name: "Studio" }).click();
    await page.getByRole("button", { name: "Laptop" }).click();
    await expect
      .element(page.getByRole("group", { name: "Filter environments" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Laptop" }).click();
    await expect.element(page.getByRole("checkbox", { name: "Travel" })).not.toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: "Studio" })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "All environments" }).click();
    await expect.element(page.getByRole("checkbox", { name: "Travel" })).toBeChecked();
    await page.getByRole("option", { name: "Notes" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Filter: Notes")).toBeVisible();
  });

  it("keeps the footer available for an empty project search and keyboard interaction", async () => {
    await using screen = await render(<FilterMenu />);
    await screen.getByLabelText("Filter projects").click();
    page.getByRole("button", { name: "All environments" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("checkbox", { name: "Studio" })).toBeVisible();
    await page.getByRole("button", { name: "All environments" }).click();
    await userEvent.type(page.getByRole("combobox", { name: "Search projects" }), "missing");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("checkbox", { name: "Studio" })).toBeVisible();
    await userEvent.tab();
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("button", { name: "No environments" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("Filter projects")).toHaveFocus();
  });
});
