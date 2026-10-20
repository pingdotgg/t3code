import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({
  canOperate: false,
  canWriteSettings: true,
  connected: true,
  openEditor: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: (() => "") as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: () => {
    const environment = {
      environmentId: "primary-settings",
      serverConfig: {
        keybindings: [],
        keybindingsConfigPath: "/fixture/keybindings.json",
        availableEditors: [],
      },
    };
    return (
      state.connected
        ? { environment, connectedEnvironments: [environment] }
        : { environment: null, connectedEnvironments: [] }
    ) as never;
  },
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    environmentId === "primary-settings" &&
    (scope === "orchestration:operate"
      ? state.canOperate
      : scope === "settings:write" && state.canWriteSettings);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
    useEnvironmentsWithScope: (() =>
      new Set(state.canWriteSettings ? ["primary-settings"] : [])) as never,
  };
});
vi.mock(import("../../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: ((environmentId: EnvironmentId) => (path: string) =>
    state.openEditor({ environmentId, path })) as never,
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function setup() {
  state.canOperate = false;
  state.canWriteSettings = true;
  state.connected = true;
  state.openEditor.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
}

const renderPanel = () => render(<KeybindingsSettingsPanel />);
const openButton = (screen: Screen) => {
  const button = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open keybindings.json"]',
  );
  expect(button).not.toBeNull();
  return button!;
};

describe("KeybindingsSettings editor permission", () => {
  it("rejects editor launches when settings writes are the only write grant", async () => {
    setup();
    await using screen = await renderPanel();
    expect(openButton(screen).disabled).toBe(true);
    await act(async () => openButton(screen).click());
    expect(state.openEditor).not.toHaveBeenCalled();
  });

  it("opens the primary environment's file after operate is granted without settings writes", async () => {
    setup();
    state.canWriteSettings = false;
    await using screen = await renderPanel();
    state.canOperate = true;
    await screen.rerender(<KeybindingsSettingsPanel />);
    expect(openButton(screen).disabled).toBe(false);
    await act(async () => openButton(screen).click());

    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      path: "/fixture/keybindings.json",
    });
  });

  it("rejects a queued editor launch after operate is revoked", async () => {
    setup();
    state.canOperate = true;
    await using screen = await renderPanel();
    const button = openButton(screen);
    state.canOperate = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => button.click());

    expect(state.openEditor).not.toHaveBeenCalled();
    await screen.rerender(<KeybindingsSettingsPanel />);
    expect(openButton(screen).disabled).toBe(true);
  });
});

describe("KeybindingsSettings write notice", () => {
  it("asks for a connected environment when none is connected", async () => {
    setup();
    state.connected = false;
    await using screen = await renderPanel();
    expect(screen.container.textContent).toContain("Connect an environment to change keybindings.");
  });

  it("names the permission when the connection cannot write settings", async () => {
    setup();
    state.canWriteSettings = false;
    await using screen = await renderPanel();
    expect(screen.container.textContent).toContain(
      "This connection can view keybindings but cannot change them.",
    );
  });
});
