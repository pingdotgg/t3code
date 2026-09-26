import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
}));

import {
  changedCustomizeSettingKeys,
  pickCustomizeSettings,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";

afterEach(() => useCustomizeInterfaceStore.getState().close());

describe("customize snapshots", () => {
  it("includes scenes and transparency in Undo and Revert without unrelated settings", () => {
    const before = pickCustomizeSettings(DEFAULT_CLIENT_SETTINGS);
    const after = pickCustomizeSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      themeBackground: "ocean",
      themeBackgroundTransparency: 65,
      sendShortcut: "mod-enter",
    });
    expect(changedCustomizeSettingKeys(before, after)).toEqual([
      "themeBackground",
      "themeBackgroundTransparency",
    ]);
  });

  it("keeps preview changes out of snapshots and history, and clears them on close", () => {
    const store = useCustomizeInterfaceStore;
    store.getState().open();
    const snapshot = store.getState().snapshot;
    store.getState().setPreviewPresetId("minimal");
    expect(store.getState().snapshot).toBe(snapshot);
    expect(store.getState().history).toEqual([]);
    store.getState().close();
    expect(store.getState().previewPresetId).toBeNull();
    store.getState().open();
    expect(store.getState().previewPresetId).toBeNull();
  });

  it("clears the preview before editing a surface", () => {
    const store = useCustomizeInterfaceStore;
    store.getState().open();
    store.getState().setPreviewPresetId("focus");
    store.getState().setEditing("composer");
    expect(store.getState().previewPresetId).toBeNull();
    expect(store.getState().history).toEqual([]);
  });
});
