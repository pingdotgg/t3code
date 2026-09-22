import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { StrictMode, useEffect, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  confirm: vi.fn<() => Promise<boolean>>(),
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
  labels: [] as string[],
  restore: null as (() => Promise<void>) | null,
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "system",
    setTheme: () => true,
    followSystem: true,
    setFollowSystem: () => true,
    setThemeHalf: () => true,
    clearThemeHalves: () => true,
    themeHalves: null,
  }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.updateSettings,
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { useSettingsRestore } from "./SettingsPanels";

function Harness(): ReactNode {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore();
  useEffect(() => {
    state.labels = changedSettingLabels;
    state.restore = restoreDefaults;
  });
  return null;
}

let renderer: ReactTestRenderer | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, generateThreadTitles: false };
  state.confirm.mockReset().mockResolvedValue(true);
  state.updateSettings.mockReset();
  act(() => {
    renderer = create(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("global Restore device defaults", () => {
  it("reports AI thread titles as changed and resets them to their default", async () => {
    expect(state.labels).toContain("AI thread titles");

    await act(async () => {
      await state.restore?.();
    });

    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    const patch = state.updateSettings.mock.calls[0]![0];
    expect(patch.generateThreadTitles).toBe(true);
    expect(patch.generateThreadTitles).toBe(DEFAULT_UNIFIED_SETTINGS.generateThreadTitles);
  });

  it("does not report AI thread titles when the setting is already at its default", () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
    act(() => {
      renderer!.update(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });

    expect(state.labels).not.toContain("AI thread titles");
  });
});
