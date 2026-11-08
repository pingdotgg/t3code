import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

const environmentId = EnvironmentId.make("laptop");

it("offers Add to another machine on a started thread", async () => {
  const onAddToMachine = vi.fn();
  await using screen = await render(
    <BranchToolbarEnvironmentSelector
      envLocked
      environmentId={environmentId}
      availableEnvironments={[
        {
          environmentId,
          projectId: ProjectId.make("project"),
          label: "Laptop",
          isPrimary: true,
          machine: "laptop",
        },
      ]}
      onAddToMachine={onAddToMachine}
    />,
  );

  await userEvent.click(screen.getByRole("combobox", { name: "Run on" }));
  await userEvent.click(page.getByRole("option", { name: "Add to another machine" }));
  expect(onAddToMachine).toHaveBeenCalledOnce();
});
