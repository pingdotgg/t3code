import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  kind: "project" as "project" | "checkout",
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  persist: vi.fn(),
  toast: vi.fn(),
}));
const selectedId = EnvironmentId.make("selected-remote");
const otherId = EnvironmentId.make("other-environment");

vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => {
    const environment = {
      environmentId: selectedId,
      label: "Selected remote",
      connection: { phase: "connected" },
      serverConfig: {
        settings: state.settings,
        nativeTools: [{ name: "t3_thread_send", description: "Send a message to a thread." }],
      },
    };
    return {
      scope: { kind: state.kind, label: "Project", members: [], environmentIds: [selectedId] },
      environment,
      environments: [environment, { ...environment, environmentId: otherId }],
      connectedEnvironments: [environment],
      target: { settings: state.settings },
    };
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  useMergedSettings: (
    settings: typeof DEFAULT_SERVER_SETTINGS,
    selector: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown,
  ) => selector({ ...DEFAULT_UNIFIED_SETTINGS, nativeToolEnabled: settings.nativeToolEnabled }),
  persistClientSettingsPatch: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: () => new Set([selectedId]),
  readEnvironmentScope: (id: EnvironmentId) => id === selectedId,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));

import { NativeToolsSettings } from "./NativeToolsSettings";

it.each(["project", "checkout"] as const)(
  "saves tool changes only to the selected environment while retaining %s scope",
  async (kind) => {
    state.kind = kind;
    state.settings = { ...DEFAULT_SERVER_SETTINGS, nativeToolEnabled: {} };
    state.toast.mockReset();
    state.persist.mockReset().mockImplementation(async ({ input }) => {
      state.settings = applyServerSettingsPatch(state.settings, input.patch);
      return AsyncResult.success(state.settings);
    });
    await using screen = await render(<NativeToolsSettings />);
    const toggle = screen.getByRole("switch", { name: "t3_thread_send" });
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(state.persist).toHaveBeenCalledOnce());
    expect(state.persist).toHaveBeenLastCalledWith({
      environmentId: selectedId,
      input: { patch: { nativeToolEnabled: { t3_thread_send: false } } },
    });
    await screen.rerender(<NativeToolsSettings />);
    await expect.element(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(state.persist).toHaveBeenCalledTimes(2));
    expect(state.persist).toHaveBeenLastCalledWith({
      environmentId: selectedId,
      input: { patch: { nativeToolEnabled: { t3_thread_send: true } } },
    });
    expect(state.toast).not.toHaveBeenCalled();
  },
);
