import { RegistryContext } from "@effect/atom-react";
import type { AppleIntentStatus } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { AppleIntentsSettingsSection } from "./AppleIntentsSettingsSection";

function makeBaseDesktopBridge() {
  return {
    getClientSettings: vi.fn(async () => DEFAULT_CLIENT_SETTINGS),
    setClientSettings: vi.fn(async () => undefined),
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  };
}

function stubMacPlatform() {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => "MacIntel",
  });
  return {
    [Symbol.dispose]() {
      if (originalDescriptor) {
        Object.defineProperty(navigator, "platform", originalDescriptor);
      } else {
        delete (navigator as unknown as { platform?: string }).platform;
      }
    },
  };
}

it("renders Siri & Spotlight toggles and clears index when available on macOS 27.3+", async () => {
  using _mac = stubMacPlatform();
  const clearIndex = vi.fn(async () => undefined);
  using _bridge = stubGlobal("desktopBridge", {
    ...makeBaseDesktopBridge(),
    appleIntents: {
      getStatus: vi.fn(async (): Promise<AppleIntentStatus> => ({ available: true })),
      syncIndex: vi.fn(async () => undefined),
      removeEnvironment: vi.fn(async () => undefined),
      clearIndex,
      setOnscreenContext: vi.fn(async () => undefined),
      syncAuthCredentials: vi.fn(async () => undefined),
    },
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };

  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <AppleIntentsSettingsSection />
    </RegistryContext.Provider>,
  );

  await expect.element(screen.getByRole("heading", { name: "Siri & Spotlight" })).toBeVisible();
  const clearButton = screen.getByRole("button", { name: "Clear index" });
  await expect.element(clearButton).toBeEnabled();
  await clearButton.click();
  expect(clearIndex).toHaveBeenCalledOnce();
});

it("shows macOS 27.3 requirement notice when running on an older macOS version", async () => {
  using _mac = stubMacPlatform();
  using _bridge = stubGlobal("desktopBridge", {
    ...makeBaseDesktopBridge(),
    appleIntents: {
      getStatus: vi.fn(async (): Promise<AppleIntentStatus> => ({
        available: false,
        reason: "requires-macos-27.3",
      })),
      syncIndex: vi.fn(async () => undefined),
      removeEnvironment: vi.fn(async () => undefined),
      clearIndex: vi.fn(async () => undefined),
      setOnscreenContext: vi.fn(async () => undefined),
      syncAuthCredentials: vi.fn(async () => undefined),
    },
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };

  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <AppleIntentsSettingsSection />
    </RegistryContext.Provider>,
  );

  await expect
    .element(screen.getByText("Siri & Spotlight App Intents require macOS 27.3 or later."))
    .toBeVisible();
});
