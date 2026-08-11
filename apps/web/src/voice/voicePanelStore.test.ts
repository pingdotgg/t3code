import { afterEach, describe, expect, it } from "vite-plus/test";

import { useVoicePanelStore } from "./voicePanelStore";

afterEach(() => {
  useVoicePanelStore.getState().closeVoicePanel();
});

describe("voice panel store", () => {
  it("opens, closes, and toggles the singleton panel state", () => {
    const store = useVoicePanelStore.getState();

    store.openVoicePanel();
    expect(useVoicePanelStore.getState().open).toBe(true);

    store.closeVoicePanel();
    expect(useVoicePanelStore.getState().open).toBe(false);

    store.toggleVoicePanel();
    expect(useVoicePanelStore.getState().open).toBe(true);
    useVoicePanelStore.getState().toggleVoicePanel();
    expect(useVoicePanelStore.getState().open).toBe(false);
  });
});
