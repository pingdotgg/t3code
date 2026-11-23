import "../../index.css";

import { RegistryContext } from "@effect/atom-react";
import type { DesktopBackgroundServiceState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { desktopBackgroundServiceStateAtom } from "../../state/desktopBackgroundService";
import { BackgroundServiceSetting } from "./BackgroundServiceSetting";

it("toggles background service directly without a confirmation dialog", async () => {
  const baseState: DesktopBackgroundServiceState = {
    supported: true,
    enabled: false,
    running: false,
    attached: false,
    externalService: false,
    version: null,
  };
  const getBackgroundServiceState = vi.fn(async () => baseState);
  const enableBackgroundService = vi.fn(async () => ({
    ...baseState,
    enabled: true,
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

  getBackgroundServiceState.mockResolvedValue({
    ...baseState,
    enabled: true,
  });
  await toggle.click();
  expect(enableBackgroundService).toHaveBeenCalledOnce();
  await act(() => registry.refresh(desktopBackgroundServiceStateAtom));
  await expect.element(toggle).toBeChecked();

  getBackgroundServiceState.mockResolvedValue(baseState);
  await toggle.click();
  expect(disableBackgroundService).toHaveBeenCalledOnce();
  await act(() => registry.refresh(desktopBackgroundServiceStateAtom));
  await expect.element(toggle).not.toBeChecked();
});
