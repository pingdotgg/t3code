import "../../index.css";

import { RegistryContext } from "@effect/atom-react";
import type { DesktopBackgroundServiceState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { desktopBackgroundServiceStateAtom } from "../../state/desktopBackgroundService";
import { BackgroundServiceSetting } from "./BackgroundServiceSetting";

it("toggles background service install and uninstall through the confirmation dialog", async () => {
  const baseState: DesktopBackgroundServiceState = {
    supported: true,
    installed: false,
    running: false,
    attached: false,
    otherBaseDir: null,
    version: null,
  };
  const getBackgroundServiceState = vi.fn(async () => baseState);
  const enableBackgroundService = vi.fn(async () => ({
    ...baseState,
    installed: true,
    running: true,
    attached: true,
    version: "0.1.11",
  }));
  const disableBackgroundService = vi.fn(async () => baseState);
  using _bridge = stubGlobal("desktopBridge", {
    getBackgroundServiceState,
    enableBackgroundService,
    disableBackgroundService,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <BackgroundServiceSetting />
    </RegistryContext.Provider>,
  );

  const toggle = screen.getByRole("switch", { name: "Background service" });
  await expect.element(toggle).not.toBeChecked();

  await toggle.click();
  await page.getByRole("button", { name: "Install and restart" }).click();
  expect(enableBackgroundService).toHaveBeenCalledOnce();

  getBackgroundServiceState.mockResolvedValue({
    ...baseState,
    installed: true,
    running: true,
    attached: true,
    version: "0.1.11",
  });
  await act(() => registry.refresh(desktopBackgroundServiceStateAtom));
  await expect.element(toggle).toBeChecked();

  await toggle.click();
  await page.getByRole("button", { name: "Uninstall and restart" }).click();
  expect(disableBackgroundService).toHaveBeenCalledOnce();
});
