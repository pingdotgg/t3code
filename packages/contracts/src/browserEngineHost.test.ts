import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_ENGINE_FAVICON_MAX_LENGTH,
  BROWSER_ENGINE_PROFILE_LIST_MAX,
  BrowserEngineCommand,
  BrowserEngineHostCommandResultInput,
  BrowserEngineHostReportInput,
  BrowserEngineHostStreamEvent,
  BrowserEngineProfileCommand,
} from "./browserEngineHost.ts";

const decodeCommand = Schema.decodeUnknownSync(BrowserEngineCommand);
const decodeReport = Schema.decodeUnknownSync(BrowserEngineHostReportInput);
const decodeResult = Schema.decodeUnknownSync(BrowserEngineHostCommandResultInput);
const decodeStreamEvent = Schema.decodeUnknownSync(BrowserEngineHostStreamEvent);

const target = { threadId: "thread-1", tabId: "tab-1", serverEpoch: "epoch-1" };
const status = {
  navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "App" },
  canGoBack: true,
  canGoForward: false,
  zoomFactor: 1.25,
  appearance: "dark",
  audioMuted: false,
  audible: true,
  devToolsOpen: false,
  pictureInPicture: false,
  favicon: null,
};

describe("BrowserEngineCommand", () => {
  it("accepts every ordinary page verb", () => {
    for (const command of [
      { _tag: "back" },
      { _tag: "forward" },
      { _tag: "reload" },
      { _tag: "hardReload" },
      { _tag: "navigate", url: "https://example.com/" },
      { _tag: "zoom", zoomFactor: 1.5 },
      { _tag: "setAppearance", appearance: "light" },
      { _tag: "setAudioMuted", muted: true },
      { _tag: "setDevToolsOpen", open: true },
      { _tag: "setDevToolsOpen", open: false },
      { _tag: "setPictureInPicture", open: true },
    ]) {
      expect(decodeCommand(command)).toEqual(command);
    }
  });

  it("rejects zoom factors off the fixed ladder and verbs outside the set", () => {
    expect(() => decodeCommand({ _tag: "zoom", zoomFactor: 1.3 })).toThrow();
    expect(() => decodeCommand({ _tag: "navigate", url: "" })).toThrow();
    expect(() =>
      decodeCommand({ _tag: "navigate", url: `https://e.com/${"a".repeat(2048)}` }),
    ).toThrow();
    expect(() => decodeCommand({ _tag: "resize" })).toThrow();
    expect(() => decodeCommand({ _tag: "openDevTools" })).toThrow();
    expect(() => decodeCommand({ _tag: "setDevToolsOpen" })).toThrow();
    expect(() => decodeCommand({ _tag: "setPictureInPicture" })).toThrow();
  });
});

describe("BrowserEngineHostReportInput", () => {
  it("carries the page status fields", () => {
    const input = {
      hostConnectionId: "host-1",
      target,
      engineGeneration: "42",
      status,
    };
    expect(decodeReport(input)).toEqual(input);
  });

  it("bounds favicon data", () => {
    expect(() =>
      decodeReport({
        hostConnectionId: "host-1",
        target,
        engineGeneration: "42",
        status: {
          ...status,
          favicon: {
            dataUrl: `data:image/png;base64,${"A".repeat(BROWSER_ENGINE_FAVICON_MAX_LENGTH)}`,
            pageUrl: "http://localhost:5173/",
          },
        },
      }),
    ).toThrow();
  });

  it("carries a closed guest lifecycle instead of a page status", () => {
    const fence = { hostConnectionId: "host-1", target, engineGeneration: "42" };
    for (const lifecycle of ["crashed", "recovering", "exhausted"]) {
      expect(decodeReport({ ...fence, lifecycle })).toEqual({ ...fence, lifecycle });
    }
    expect(() => decodeReport({ ...fence, lifecycle: "restarting" })).toThrow();
  });
});

describe("BrowserEngineHostCommandResultInput", () => {
  it("requires a closed rejection reason", () => {
    expect(() =>
      decodeResult({
        hostConnectionId: "host-1",
        commandId: "command-1",
        result: { outcome: "rejected", reason: "Error: boom" },
      }),
    ).toThrow();
    expect(
      decodeResult({
        hostConnectionId: "host-1",
        commandId: "command-1",
        result: { outcome: "rejected", reason: "stale-generation" },
      }).result,
    ).toEqual({ outcome: "rejected", reason: "stale-generation" });
  });
});

describe("BrowserEngineHostStreamEvent", () => {
  it("decodes command frames with their fence", () => {
    const event = {
      type: "command",
      commandId: "command-1",
      target,
      engineGeneration: "42",
      command: { _tag: "reload" },
    };
    expect(decodeStreamEvent(event)).toEqual(event);
  });
});

describe("BrowserEngineProfileCommand", () => {
  const decodeProfileCommand = Schema.decodeUnknownSync(BrowserEngineProfileCommand);

  it("always names the profile a clear or import targets", () => {
    expect(decodeProfileCommand({ _tag: "clearCookies", profileId: "work" })).toEqual({
      _tag: "clearCookies",
      profileId: "work",
    });
    // The desktop's all-partitions clear is keyed on an absent profile id.
    expect(() => decodeProfileCommand({ _tag: "clearCookies" })).toThrow();
    expect(() => decodeProfileCommand({ _tag: "clearCache" })).toThrow();
    expect(() =>
      decodeProfileCommand({ _tag: "importCookies", sourceId: "chrome", sourceProfile: "p0" }),
    ).toThrow();
  });

  it("carries import handles, never source profile directories", () => {
    expect(() =>
      decodeProfileCommand({
        _tag: "importCookies",
        profileId: "work",
        sourceId: "chrome",
        sourceProfile: "p0",
        requester: "t3.browser",
        sourceProfileDirectory: "Profile 1",
      }),
    ).not.toThrow();
    const decoded = decodeProfileCommand({
      _tag: "importCookies",
      profileId: "work",
      sourceId: "chrome",
      sourceProfile: "p0",
      requester: "t3.browser",
      sourceProfileDirectory: "Profile 1",
    });
    expect(decoded).not.toHaveProperty("sourceProfileDirectory");
    expect(() =>
      decodeProfileCommand({
        _tag: "importCookies",
        profileId: "work",
        sourceId: "chrome",
        sourceProfile: "x".repeat(17),
        requester: "t3.browser",
      }),
    ).toThrow();
  });

  it("rides its own stream frame without a session fence", () => {
    const event = {
      type: "profile-command",
      commandId: "command-2",
      command: { _tag: "listProfiles" },
    };
    expect(decodeStreamEvent(event)).toEqual(event);
  });

  it("carries import proceed and cancel by command id alone", () => {
    for (const type of ["profile-command-proceed", "profile-command-cancel"]) {
      expect(decodeStreamEvent({ type, commandId: "command-2" })).toEqual({
        type,
        commandId: "command-2",
      });
    }
  });
});

describe("profile command answers", () => {
  const answer = (result: unknown) =>
    decodeResult({ hostConnectionId: "host-1", commandId: "command-2", result }).result;

  it("decodes each answer shape", () => {
    expect(
      answer({
        outcome: "profiles",
        profiles: [{ id: "default", name: "Default" }],
        defaultProfileId: "default",
      }),
    ).toEqual({
      outcome: "profiles",
      profiles: [{ id: "default", name: "Default" }],
      defaultProfileId: "default",
    });
    expect(answer({ outcome: "imported", imported: 3, skipped: 1 })).toEqual({
      outcome: "imported",
      imported: 3,
      skipped: 1,
    });
    expect(answer({ outcome: "declined" })).toEqual({ outcome: "declined" });
    expect(answer({ outcome: "confirmed" })).toEqual({ outcome: "confirmed" });
    expect(answer({ outcome: "rejected", reason: "cancelled" })).toEqual({
      outcome: "rejected",
      reason: "cancelled",
    });
    expect(answer({ outcome: "import-failed", reason: "browserRunning" })).toEqual({
      outcome: "import-failed",
      reason: "browserRunning",
    });
    expect(answer({ outcome: "rejected", reason: "unknown-profile" })).toEqual({
      outcome: "rejected",
      reason: "unknown-profile",
    });
  });

  it("bounds the profile list and rejects open-ended failure text", () => {
    const profiles = Array.from({ length: BROWSER_ENGINE_PROFILE_LIST_MAX + 1 }, (_, index) => ({
      id: `p${index}`,
      name: `Profile ${index}`,
    }));
    expect(() => answer({ outcome: "profiles", profiles, defaultProfileId: "default" })).toThrow();
    expect(() => answer({ outcome: "import-failed", reason: "Error: keychain" })).toThrow();
    expect(() => answer({ outcome: "imported", imported: -1, skipped: 0 })).toThrow();
  });
});
