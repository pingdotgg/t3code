import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { state, updateSettings } = vi.hoisted(() => ({
  state: { observability: {} as typeof DEFAULT_SERVER_SETTINGS.observability },
  updateSettings: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: "updateSettings",
    checkOtlpEndpoint: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "updateSettings" ? updateSettings : vi.fn()),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    environment: {
      environmentId: "env",
      label: "MAC1",
      serverConfig: { environment: { capabilities: {} } },
    },
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: typeof state) => unknown) => select(state),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

import { TelemetryExportSettings } from "./TelemetryExportSettings";

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  updateSettings.mockClear();
});

const type = (id: string, value: string) =>
  act(() => renderer!.root.findByProps({ id }).props.onChange({ target: { value } }));

describe("TelemetryExportSettings", () => {
  it("does not resend a field the user restored after another client changed it", async () => {
    state.observability = {
      ...DEFAULT_SERVER_SETTINGS.observability,
      otlpTracesUrl: "http://old/v1/traces",
    };
    await act(() => {
      renderer = create(<TelemetryExportSettings />);
    });

    await type("otlpTracesUrl", "http://draft/v1/traces");
    await type("otlpTracesUrl", "http://old/v1/traces");
    // Another client saves a new traces endpoint.
    state.observability = { ...state.observability, otlpTracesUrl: "http://other/v1/traces" };
    await act(() => renderer!.update(<TelemetryExportSettings />));
    await type("otlpMetricsUrl", "http://new/v1/metrics");
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));

    expect(updateSettings).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { observability: { otlpMetricsUrl: "http://new/v1/metrics" } } },
    });
  });
});
