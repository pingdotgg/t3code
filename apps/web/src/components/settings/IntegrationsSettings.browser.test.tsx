import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const { listBrowserImportSources } = vi.hoisted(() => ({
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock(import("../preview/previewBridge"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewBridge: { ...actual.previewBridge, listBrowserImportSources } as never,
  };
});
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [], isReady: true })) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

function setup() {
  listBrowserImportSources.mockClear();
}

async function openSettings() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <StrictMode>
        <IntegrationsSettingsPanel />
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(screen.container.querySelector("section#browser")).not.toBeNull());
  stack.move();
  return screen;
}

describe("Integrations browser discovery", () => {
  it("keeps agent browser access in the single Browser section", async () => {
    setup();
    await using screen = await openSettings();

    expect(page.getByRole("heading", { name: "Browser", exact: true }).elements()).toHaveLength(1);
    const access = page.getByRole("switch", { name: "Agent browser access", exact: true });
    await expect.element(access).toBeVisible();
    expect(access.element().closest("section")).toBe(
      screen.container.querySelector("section#browser"),
    );
    expect(access.element().closest("#agent-browser-access")).not.toBeNull();
  });

  it("does not scan browser files when entering or revisiting settings", async () => {
    setup();
    await using first = await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await first.unmount();
    await using _second = await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });
});
