import { beforeEach, describe, expect, it } from "vitest";

import {
  getAssistantDeliveryModeForDispatch,
  getProviderOptionsForDispatch,
  getSendTimeAssistantDeliveryMode,
} from "./ChatView.providerOptions";

beforeEach(() => {
  window.localStorage.clear();
});

const buildPersistedAppSettings = (enableAssistantStreaming: boolean) => ({
  claudeBinaryPath: "",
  claudeHomePath: "",
  codexBinaryPath: "",
  codexHomePath: "",
  confirmThreadDelete: true,
  enableAssistantStreaming,
  codexServiceTier: "auto",
  customClaudeModels: [],
  customCodexModels: [],
});

describe("getProviderOptionsForDispatch", () => {
  it("returns Claude Code overrides when configured", () => {
    expect(
      getProviderOptionsForDispatch(
        {
          claudeBinaryPath: "/usr/local/bin/claude",
          claudeHomePath: "/tmp/.claude",
          codexBinaryPath: "",
          codexHomePath: "",
        },
        "claudeCode",
      ),
    ).toEqual({
      claudeCode: {
        binaryPath: "/usr/local/bin/claude",
        homePath: "/tmp/.claude",
      },
    });
  });

  it("omits provider overrides when the selected provider has no values", () => {
    expect(
      getProviderOptionsForDispatch(
        {
          claudeBinaryPath: "/usr/local/bin/claude",
          claudeHomePath: "/tmp/.claude",
          codexBinaryPath: "",
          codexHomePath: "",
        },
        "codex",
      ),
    ).toBeUndefined();
  });
});

describe("getAssistantDeliveryModeForDispatch", () => {
  it("maps enabled assistant streaming to streaming delivery", () => {
    expect(getAssistantDeliveryModeForDispatch({ enableAssistantStreaming: true })).toBe("streaming");
    expect(getAssistantDeliveryModeForDispatch({ enableAssistantStreaming: false })).toBe("buffered");
  });

  it("reads the latest persisted same-tab app settings snapshot at send time", () => {
    window.localStorage.setItem(
      "t3code:app-settings:v1",
      JSON.stringify(buildPersistedAppSettings(false)),
    );
    expect(getSendTimeAssistantDeliveryMode()).toBe("buffered");

    window.localStorage.setItem(
      "t3code:app-settings:v1",
      JSON.stringify(buildPersistedAppSettings(true)),
    );
    expect(getSendTimeAssistantDeliveryMode()).toBe("streaming");
  });
});