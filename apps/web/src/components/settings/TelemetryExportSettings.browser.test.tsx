import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { state, updateSettings } = vi.hoisted(() => ({
  state: { observability: {} as typeof DEFAULT_SERVER_SETTINGS.observability },
  updateSettings: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "updateSettings" ? updateSettings : vi.fn()) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment" },
    environment: {
      environmentId: "env",
      label: "MAC1",
      serverConfig: { environment: { capabilities: {} } },
    },
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((select: (settings: typeof state) => unknown) => select(state)) as never,
}));

import { TelemetryExportSettings } from "./TelemetryExportSettings";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  updateSettings.mockClear();
  vi.unstubAllGlobals();
});

const field = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
async function replace(id: string, value: string) {
  await userEvent.clear(field(id));
  await userEvent.type(field(id), value);
}

describe("TelemetryExportSettings", () => {
  it("does not resend a field the user restored after another client changed it", async () => {
    state.observability = {
      ...DEFAULT_SERVER_SETTINGS.observability,
      otlpTracesUrl: "http://old/v1/traces",
    };
    await act(async () => root.render(<TelemetryExportSettings />));

    await replace("otlpTracesUrl", "http://draft/v1/traces");
    await replace("otlpTracesUrl", "http://old/v1/traces");
    state.observability = { ...state.observability, otlpTracesUrl: "http://other/v1/traces" };
    await act(async () => root.render(<TelemetryExportSettings />));
    await replace("otlpMetricsUrl", "http://new/v1/metrics");
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await userEvent.click(save);

    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { patch: { observability: { otlpMetricsUrl: "http://new/v1/metrics" } } },
    });
    expect(container.textContent).toContain("Saved. Restart the server to apply.");
  });
});
