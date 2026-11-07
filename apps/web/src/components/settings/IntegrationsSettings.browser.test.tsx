import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  connectedEnvironments: [] as unknown[],
  configure: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    search: {},
    scope: { kind: "all" },
    environments: state.environments,
    connectedEnvironments: state.connectedEnvironments,
    environment: state.connectedEnvironments[0] ?? null,
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_SERVER_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: (({ control }: { control: ReactNode }) => control) as never,
}));
vi.mock(import("./DeviceSourcesSettings"), () => ({
  DeviceSourcesSettings: (() => null) as never,
}));
vi.mock(import("../device/DeviceHostUpdates"), () => ({
  DeviceHostUpdates: (() => null) as never,
}));
vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  useDeviceState: () => ({
    state: {
      hosts: [],
      hostStatus: "disabled",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: false,
      agentAccessEnabled: false,
      hubBasePath: "/api/device-hub",
      revision: 0,
    },
    loaded: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.configure) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { DevicesSettingsPanel } from "./IntegrationsSettings";

const environment = (label: string, connected: boolean) => ({
  environmentId: EnvironmentId.make(label),
  label,
  connection: { phase: connected ? "connected" : "disconnected" },
  serverConfig: connected ? { settings: DEFAULT_SERVER_SETTINGS } : null,
});

function setup() {
  const laptop = environment("Laptop", true);
  state.environments = [laptop, environment("Desktop", false)];
  state.connectedEnvironments = [laptop];
  state.configure.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.toast.mockReset();
}

it("applies device switches to connected environments and skips offline ones", async () => {
  setup();
  await using _screen = await render(<DevicesSettingsPanel />);
  const hub = page.getByRole("switch", { name: "Device hub" });

  await userEvent.click(hub);
  await expect.element(hub).toBeEnabled();
  expect(state.configure.mock.calls.map(([call]) => call.environmentId)).toEqual(["Laptop"]);
  expect(state.toast).not.toHaveBeenCalled();

  state.configure.mockResolvedValue({ _tag: "Failure", cause: new Error("denied") });
  await userEvent.click(hub);
  await expect.element(hub).toBeEnabled();
  expect(state.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Device settings not saved on all environments",
    description: "Could not update Laptop.",
  });
});
