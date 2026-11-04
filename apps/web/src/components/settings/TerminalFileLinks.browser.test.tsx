import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
import { readBrowserClientSettings } from "~/clientPersistenceStorage";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

it("saves and resets the terminal file preference through General settings", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("terminal-links", 1)]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/settings/general"] }));
  await router.load();
  // AppRoot supplies the real app router.
  await using _screen = await render(<AppRoot router={router} />, { router: false });
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
