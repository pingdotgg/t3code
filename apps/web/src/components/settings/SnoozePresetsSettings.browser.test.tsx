import { render } from "../../../test/render";
import {
  DEFAULT_SNOOZE_PRESETS,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SNOOZE_PRESETS,
  type SnoozePresetSetting,
} from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  presets: [] as ReadonlyArray<SnoozePresetSetting>,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    snoozePresets: state.presets,
  })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children }) => <div>{children}</div>,
}));

import { SnoozePresetsRow } from "./SnoozePresetsSettings";

describe("SnoozePresetsRow", () => {
  it("keeps the option that fills the list at the bottom until focus leaves", async () => {
    // One short of the limit; the next option offered is "In 30 minutes", which sorts first.
    state.presets = [
      ...DEFAULT_SNOOZE_PRESETS,
      { kind: "at", day: "saturday", time: "09:00" },
      { kind: "after", minutes: 24 * 60 },
    ];
    expect(state.presets).toHaveLength(MAX_SNOOZE_PRESETS - 1);
    // The row reads no route state.
    await using screen = await render(<SnoozePresetsRow />, { router: false });
    state.updateSettings.mockReset().mockImplementation((patch) => {
      state.presets = patch.snoozePresets ?? state.presets;
      void screen.rerender(<SnoozePresetsRow />);
    });

    const add = page.getByRole("button", { name: "Add option" });
    await userEvent.click(add);

    // A disabled button drops focus, which the list reads as leaving it and sorts mid-edit.
    await expect.element(add).toHaveFocus();
    await expect.element(add).toHaveAttribute("aria-disabled", "true");
    const added = page.getByRole("group", { name: `Snooze option ${MAX_SNOOZE_PRESETS}` });
    await expect.element(added.getByRole("textbox", { name: "Amount" })).toHaveValue("30");
  });
});
