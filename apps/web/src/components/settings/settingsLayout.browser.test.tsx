import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import "../../index.css";

const state = vi.hoisted(() => ({ available: false }));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettingsAvailable: () => state.available,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => null,
  usePrimaryEnvironment: () => null,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => false,
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: () => new Map(),
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));

it.each([
  { available: false, reason: PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE },
  {
    available: true,
    reason: "This connection lacks permission to change settings on the primary environment.",
  },
])("explains server settings availability ($available)", async ({ available, reason }) => {
  state.available = available;
  const changed = vi.fn();
  await using screen = await render(
    <SettingsRow
      title="Provider update checks"
      serverScoped
      control={<Switch checked onCheckedChange={changed} aria-label="Check provider versions" />}
    />,
  );

  await userEvent.tab();
  await expect.element(screen.getByRole("group", { name: "Provider update checks" })).toHaveFocus();
  await expect.element(page.getByText(reason)).toBeVisible();
  await userEvent.keyboard("{Enter} ");
  expect(changed).not.toHaveBeenCalled();
});

it("keeps a locally disabled control inert and restores interaction when its reason clears", async () => {
  state.available = true;
  const changed = vi.fn();
  await using screen = await render(
    <SettingsRow
      title="Example setting"
      disabledReason="Saving this setting."
      control={<Switch checked onCheckedChange={changed} aria-label="Example setting" />}
    />,
  );

  await userEvent.tab();
  await expect.element(page.getByText("Saving this setting.")).toBeVisible();
  await userEvent.keyboard("{Enter} ");
  expect(changed).not.toHaveBeenCalled();

  await screen.rerender(
    <SettingsRow
      title="Example setting"
      control={<Switch checked onCheckedChange={changed} aria-label="Example setting" />}
    />,
  );
  await screen.getByRole("switch", { name: "Example setting" }).click();
  expect(changed).toHaveBeenCalledWith(false, expect.anything());
});
