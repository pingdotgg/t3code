import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const selectScope = vi.fn();

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
  useHasSecretProvidersEnvironment: () => false,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => ({
    search: { project: "id-generator", machine: "workstation" },
    groups: [{ projectKey: "id-generator", displayName: "ID Generator" }],
    selectScope,
  })) as never,
}));

it("returns from a project to the project list through the breadcrumb", async () => {
  selectScope.mockClear();
  await using _screen = await render(<SettingsBreadcrumb pathname="/settings/projects" />);

  await expect.element(page.getByText("ID Generator")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Projects" }));
  expect(selectScope).toHaveBeenCalledWith({ machine: "workstation" });
});

it("returns from a project to the project list through the Projects section", async () => {
  await page.viewport(1280, 800);
  selectScope.mockClear();
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/projects" />
    </SidebarProvider>,
    { router: "/settings/projects" },
  );

  await userEvent.click(page.getByRole("button", { name: "Projects" }));
  expect(selectScope).toHaveBeenCalledWith({ machine: "workstation" });
});

it("keeps the picked project when opening Projects from another section", async () => {
  await page.viewport(1280, 800);
  selectScope.mockClear();
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );

  await userEvent.click(page.getByRole("button", { name: "Projects" }));
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/settings/projects"));
  expect(selectScope).not.toHaveBeenCalled();
});
