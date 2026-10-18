import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  DeviceOperationError,
  EnvironmentId,
  LOCAL_DEVICE_HOST_ID,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "list" ? list : vi.fn()),
}));
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", configure: "configure" },
  useDeviceState: () => ({ state: deviceState, loaded: true }),
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useUpdateScopedSettings: () => vi.fn(),
}));
// Rows resolve scope and permissions; only their controls matter here.
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsRow: ({ control, children }: { control?: ReactNode; children?: ReactNode }) => (
    <>
      {control}
      {children}
    </>
  ),
}));
// The version popover holds the Update button; render the button in place of the popover.
vi.mock("../device/DeviceToolVersions", () => ({
  DeviceToolVersions: ({ action }: { action?: ReactNode }) => action ?? null,
}));
vi.mock("../device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("./DeviceHostsSettings", () => ({ DeviceHostsSettings: () => null }));

import { DeviceIntegrationControls } from "./IntegrationsSettings";

const environmentId = EnvironmentId.make("environment-1");
const deviceState = {
  supportsToolUpdate: true,
  hosts: [
    {
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "This computer",
      platforms: [],
      tools: {
        hub: { requiredVersion: "0.12.0", installedVersions: [], runningVersion: null },
        agent: { requiredVersion: "1.0.0", installedVersions: ["1.0.0"], runningVersion: null },
      },
      hubInstalled: false,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: false,
  hubBasePath: "/device-hub",
  revision: 1,
} satisfies DeviceServiceState;

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([
  {
    name: "a failed install",
    error: new DeviceOperationError({
      operation: "update device tool",
      reason: "command_failed",
      exitCode: 243,
      cause: new Error("npm error EACCES https://private:credential@registry.example.test/hub"),
    }),
    message: "Device update device tool failed: The device command failed (exit code 243).",
  },
  {
    name: "a lost connection",
    error: new EnvironmentRpcUnavailableError({
      environmentId,
      message: "Query environment is not connected.",
    }),
    message: "Query environment is not connected.",
  },
])(
  "reports $name as the server describes it, not as a network problem",
  async ({ error, message }) => {
    list.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(error) });
    await act(() => {
      renderer = create(
        <DeviceIntegrationControls
          environmentId={environmentId}
          enabled
          agentAccessEnabled={false}
        />,
      );
    });

    const update = renderer!.root.find(
      (node) => node.type === "button" && node.props.children === "Update to v0.12.0",
    );
    await act(async () => update.props.onClick());

    expect(list).toHaveBeenCalledWith({ environmentId, input: { updateTool: "hub" } });
    expect(renderer!.root.find((node) => node.props.role === "alert").props.children).toBe(message);
  },
);
