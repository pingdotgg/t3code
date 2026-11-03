import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { DesktopPreviewAutomationSetViewportInputSchema } from "./ipc.ts";
import {
  PreviewAutomationHost,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationOpenInput,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
const decodeSetViewportInput = Schema.decodeUnknownSync(
  DesktopPreviewAutomationSetViewportInputSchema,
);

describe("PreviewAutomationOpenInput", () => {
  it.each(["default", "incognito", "profile-feature-a"])(
    "accepts profile %s for a new tab",
    (profileId) => {
      expect(decodeOpenInput({ profileId })).toEqual({ profileId });
      expect(decodeOpenInput({ profileId, reuseExistingTab: false })).toEqual({
        profileId,
        reuseExistingTab: false,
      });
    },
  );

  it("rejects profile selection when reusing a tab", () => {
    expect(() => decodeOpenInput({ profileId: "incognito", tabId: "tab-app" })).toThrow(
      "profileId opens a new tab",
    );
    expect(() => decodeOpenInput({ profileId: "incognito", reuseExistingTab: true })).toThrow(
      "profileId opens a new tab",
    );
  });

  it.each(["", "profile\u0000other", "x".repeat(65)])(
    "rejects invalid profile ID %j",
    (profileId) => {
      expect(() => decodeOpenInput({ profileId })).toThrow();
    },
  );
});

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

describe("DesktopPreviewAutomationSetViewportInputSchema", () => {
  it("accepts a complete size or an explicit clear, and rejects a partial size", () => {
    expect(decodeSetViewportInput({ tabId: "tab-1", width: 800, height: 600 })).toEqual({
      tabId: "tab-1",
      width: 800,
      height: 600,
    });
    expect(decodeSetViewportInput({ tabId: "tab-1", clear: true })).toEqual({
      tabId: "tab-1",
      clear: true,
    });
    expect(() => decodeSetViewportInput({ tabId: "tab-1", width: 800 })).toThrow();
    expect(() => decodeSetViewportInput({ tabId: "tab-1" })).toThrow();
  });
});

describe("PreviewAutomationInvalidSelectorError", () => {
  const invalidSelector = (selectorKind: "locator" | "selector") =>
    new PreviewAutomationInvalidSelectorError({
      operation: "click",
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("claude"),
      clientId: "desktop",
      connectionId: "connection-1",
      requestId: "request-1",
      timeoutMs: 15_000,
      remoteTag: "Error",
      remoteMessageLength: 0,
      cause: null,
      selectorKind,
      selectorLength: 42,
    });

  it("tells agents which locator forms are accepted and where CSS goes", () => {
    const { message } = invalidSelector("locator");
    expect(message).toContain("aria-ref=");
    expect(message).toMatch(/role/);
    expect(message).toMatch(/text/);
    expect(message).toMatch(/CSS[^.]*\bselector\b/);
  });

  it("points an invalid CSS selector at the locator alternative", () => {
    const { message } = invalidSelector("selector");
    expect(message).toMatch(/CSS/);
    expect(message).toMatch(/\blocator\b/);
    expect(message).toContain("aria-ref=");
  });
});
