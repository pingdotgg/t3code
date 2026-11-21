import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { readBrowserClientSettings } from "~/clientPersistenceStorage";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { render } from "../../../test/render";
import { GeneralSettingsPanel } from "./SettingsPanels";
import { SettingsScopeProvider } from "./SettingsScopeContext";

it("saves and resets the terminal file preference through General settings", async () => {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await using _screen = await render(
    <SettingsScopeProvider search={{}} onChange={() => {}}>
      <GeneralSettingsPanel />
    </SettingsScopeProvider>,
  );
  const preference = page.getByRole("switch", { name: "Open terminal file links in T3 Code" });
  await expect.element(preference).not.toBeChecked();
  await preference.click();
  await expect.element(preference).toBeChecked();
  await vi.waitFor(() =>
    expect(readBrowserClientSettings()?.terminalFileLinksOpenInApp).toBe(true),
  );
  await page.getByRole("button", { name: "Reset terminal file links to default" }).click();
  await expect.element(preference).not.toBeChecked();
  await vi.waitFor(() =>
    expect(readBrowserClientSettings()?.terminalFileLinksOpenInApp).toBe(false),
  );
});
