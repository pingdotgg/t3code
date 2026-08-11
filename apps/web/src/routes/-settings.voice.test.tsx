import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../components/settings/VoiceSettingsPanel", () => ({
  VoiceSettingsPanel: () => <div data-testid="voice-settings-panel" />,
}));

import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";
import { Route, SettingsVoiceRoute } from "./settings.voice";

describe("settings voice route", () => {
  it("registers the voice settings panel on the file route", () => {
    expect(SettingsVoiceRoute().type).toBe(VoiceSettingsPanel);
    expect(Route.options.component).toBe(SettingsVoiceRoute);
  });
});
