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
  useScopedSettings: (() => ENABLED_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: (({ control, status }: { control: ReactNode; status?: ReactNode }) => (
    <>
      {status ? <p>{status}</p> : null}
      {control}
    </>
  )) as never,
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

const ENABLED_SETTINGS = {
  ...DEFAULT_SERVER_SETTINGS,
  enableDeviceSupport: true,
  enableAgentDeviceAccess: true,
};
const OFFLINE_STATUS = "Offline machines will not get this setting: Desktop.";

const environment = (label: string, connected: boolean) => ({
  environmentId: EnvironmentId.make(label),
  label,
  connection: { phase: connected ? "connected" : "disconnected" },
  serverConfig: connected ? { settings: ENABLED_SETTINGS } : null,
});

function setup({ desktopConnected = false } = {}) {
  const laptop = environment("Laptop", true);
  const desktop = environment("Desktop", desktopConnected);
  state.environments = [laptop, desktop];
  state.connectedEnvironments = desktopConnected ? [laptop, desktop] : [laptop];
  state.configure.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.toast.mockReset();
}

it.each([
  ["Device hub", { enabled: false, agentAccessEnabled: false }],
  ["Agent device access", { agentAccessEnabled: false }],
])(
  "turning off %s updates connected environments and names the offline ones",
  async (name, input) => {
    setup();
    await using _screen = await render(<DevicesSettingsPanel />);
    const toggle = page.getByRole("switch", { name });

    await userEvent.click(toggle);
    await expect.element(toggle).toBeEnabled();
    expect(state.configure.mock.calls).toEqual([[{ environmentId: "Laptop", input }]]);
    expect(state.toast).not.toHaveBeenCalled();
    expect(page.getByText(OFFLINE_STATUS).elements()).toHaveLength(2);
  },
);

it("reports a failed save on a connected environment and still names the offline ones", async () => {
  setup();
  state.configure.mockResolvedValue({ _tag: "Failure", cause: new Error("denied") });
  await using _screen = await render(<DevicesSettingsPanel />);
  const hub = page.getByRole("switch", { name: "Device hub" });

  await userEvent.click(hub);
  await expect.element(hub).toBeEnabled();
  expect(state.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Device settings not saved on all environments",
    description: "Could not update Laptop.",
  });
  expect(page.getByText(OFFLINE_STATUS).elements()).toHaveLength(2);
});

it("updates every environment and shows no offline status when all are connected", async () => {
  setup({ desktopConnected: true });
  await using _screen = await render(<DevicesSettingsPanel />);
  const agent = page.getByRole("switch", { name: "Agent device access" });

  await userEvent.click(agent);
  await expect.element(agent).toBeEnabled();
  expect(state.configure.mock.calls.map(([call]) => call.environmentId)).toEqual([
    "Laptop",
    "Desktop",
  ]);
  expect(state.toast).not.toHaveBeenCalled();
  await expect.element(page.getByText(/Offline machines/)).not.toBeInTheDocument();
});
