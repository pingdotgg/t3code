import type { T3HostBridge, T3HostDisplayPreferences } from "@t3tools/contracts";
import {
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
} from "@t3tools/shared/displayPreferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { resolveHostDisplayPreferences } from "./hostDisplayPreferences";

const allVisiblePreferences: T3HostDisplayPreferences = {
  showOpenInPicker: true,
  showCheckoutModeIndicator: true,
  showBranchSelector: true,
  enableTerminal: true,
  enableSourceControlPanel: true,
  threadConversationMaxWidthPx: null,
};

const allHiddenPreferences: T3HostDisplayPreferences = {
  showOpenInPicker: false,
  showCheckoutModeIndicator: false,
  showBranchSelector: false,
  enableTerminal: false,
  enableSourceControlPanel: false,
  threadConversationMaxWidthPx: null,
};

describe("resolveHostDisplayPreferences", () => {
  it("defaults all controls visible outside VS Code webviews", () => {
    expect(
      resolveHostDisplayPreferences({
        isVscodeWebview: false,
        preferences: null,
      }),
    ).toEqual(allVisiblePreferences);
  });

  it("defaults VS Code webview duplicated controls hidden", () => {
    expect(
      resolveHostDisplayPreferences({
        isVscodeWebview: true,
        preferences: null,
      }),
    ).toEqual(allHiddenPreferences);
  });

  it("lets host preferences override the host defaults independently", () => {
    expect(
      resolveHostDisplayPreferences({
        isVscodeWebview: true,
        preferences: {
          showBranchSelector: true,
          enableTerminal: true,
          enableSourceControlPanel: true,
          threadConversationMaxWidthPx: 960,
        },
      }),
    ).toEqual({
      ...allHiddenPreferences,
      showBranchSelector: true,
      enableTerminal: true,
      enableSourceControlPanel: true,
      threadConversationMaxWidthPx: 960,
    });
  });

  it("clamps the host thread conversation width preference", () => {
    expect(
      resolveHostDisplayPreferences({
        isVscodeWebview: true,
        preferences: {
          threadConversationMaxWidthPx: 120,
        },
      }).threadConversationMaxWidthPx,
    ).toBe(THREAD_CONVERSATION_MIN_WIDTH_PX);
    expect(
      resolveHostDisplayPreferences({
        isVscodeWebview: true,
        preferences: {
          threadConversationMaxWidthPx: 5000,
        },
      }).threadConversationMaxWidthPx,
    ).toBe(THREAD_CONVERSATION_MAX_WIDTH_PX);
  });

  it("keeps the thread conversation width unset when the host does not provide a value", () => {
    expect(
      resolveHostDisplayPreferences({
        isVscodeWebview: true,
        preferences: {},
      }).threadConversationMaxWidthPx,
    ).toBeNull();
  });
});

describe("host display preference subscription", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("updates the readable snapshot when the host pushes new preferences", async () => {
    const listeners: Array<(preferences: T3HostDisplayPreferences) => void> = [];
    const bridge: T3HostBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getDisplayPreferences: () => allHiddenPreferences,
      onDisplayPreferencesChanged: (callback) => {
        listeners.push(callback);
        return () => {
          listeners.splice(listeners.indexOf(callback), 1);
        };
      },
    };
    vi.stubGlobal("window", {
      __T3_IS_VSCODE_WEBVIEW: true,
      t3HostBridge: bridge,
    });

    const module = await import("./hostDisplayPreferences");
    expect(module.readHostDisplayPreferences()).toEqual(allHiddenPreferences);

    const emitDisplayPreferencesChanged = listeners[0];
    if (!emitDisplayPreferencesChanged) {
      throw new Error("Expected host display preference listener to be registered.");
    }
    emitDisplayPreferencesChanged(allVisiblePreferences);

    expect(module.readHostDisplayPreferences()).toEqual(allVisiblePreferences);
  });

  it("notifies subscribers when the host bridge changes preferences", async () => {
    const firstBridge: T3HostBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getDisplayPreferences: () => allHiddenPreferences,
    };
    const secondBridge: T3HostBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getDisplayPreferences: () => allVisiblePreferences,
    };
    vi.stubGlobal("window", {
      __T3_IS_VSCODE_WEBVIEW: true,
      t3HostBridge: firstBridge,
    });

    const module = await import("./hostDisplayPreferences");
    const subscriber = vi.fn();
    module.subscribeHostDisplayPreferences(subscriber);

    vi.stubGlobal("window", {
      __T3_IS_VSCODE_WEBVIEW: true,
      t3HostBridge: secondBridge,
    });
    expect(module.readHostDisplayPreferences()).toEqual(allVisiblePreferences);

    expect(subscriber).toHaveBeenCalledTimes(1);
  });
});
