import { EnvironmentId } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarEnvironmentScopeMenu } from "./SidebarEnvironmentScopeMenu";

it("opens the environment menu and selects an environment", async () => {
  const laptop = EnvironmentId.make("laptop");
  const server = EnvironmentId.make("server");
  const onValueChange = vi.fn();
  await using screen = await render(
    <SidebarProvider>
      <SidebarEnvironmentScopeMenu
        environments={[
          { environmentId: laptop, label: "Laptop" },
          { environmentId: server, label: "Server" },
        ]}
        machineByEnvironmentId={new Map()}
        value={null}
        work={new Map()}
        onValueChange={onValueChange}
      />
    </SidebarProvider>,
  );

  await screen.getByRole("button", { name: "Filter threads by environment" }).click();
  await expect.element(page.getByText("Show threads from")).toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: "All environments" })).toBeVisible();

  await page.getByRole("menuitemradio", { name: "Server" }).click();
  expect(onValueChange).toHaveBeenCalledWith(server);
});
