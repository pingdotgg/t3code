import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ConfiguredLocalServerUrls,
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  DiscoveredLocalServer,
  PREVIEW_URL_MAX_LENGTH,
  PreviewNavStatus,
  PreviewViewportSetting,
} from "./preview.ts";
import {
  PreviewAutomationHost,
  PreviewAutomationError,
  PreviewAutomationOpenInput,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";

const decodeNavStatus = Schema.decodeUnknownSync(PreviewNavStatus);
const decodeServer = Schema.decodeUnknownSync(DiscoveredLocalServer);
const decodeConfiguredLocalServerUrls = Schema.decodeUnknownSync(ConfiguredLocalServerUrls);
const decodeViewport = Schema.decodeUnknownSync(PreviewViewportSetting);
const decodeResizeInput = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeResizeResult = Schema.decodeUnknownSync(PreviewAutomationResizeResult);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationError = Schema.decodeUnknownSync(PreviewAutomationError);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationOpenInput", () => {
  it("retains the legacy show visibility alias", () => {
    expect(decodeOpenInput({ show: false })).toEqual({ show: false });
  });
});

describe("PreviewNavStatus", () => {
  it("rejects empty url", () => {
    expect(() => decodeNavStatus({ _tag: "Loading", url: "", title: "" })).toThrow();
  });
});

describe("PreviewViewportSetting", () => {
  it("rejects unsafe dimensions and oversized render areas", () => {
    expect(decodeViewport({ _tag: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
    expect(() => decodeViewport({ _tag: "freeform", width: 100, height: 800 })).toThrow();
    expect(() => decodeViewport({ _tag: "freeform", width: 3840, height: 3840 })).toThrow();
  });
});

describe("PreviewAutomationResizeInput", () => {
  it("requires fields that match the selected mode", () => {
    expect(decodeResizeInput({ mode: "fill" })).toEqual({ mode: "fill" });
    expect(
      decodeResizeInput({ mode: "preset", preset: "pixel-7", orientation: "landscape" }),
    ).toMatchObject({ mode: "preset", preset: "pixel-7" });
    expect(() => decodeResizeInput({ mode: "preset", preset: "pixel-8" })).toThrow();
    expect(() => decodeResizeInput({ mode: "freeform", width: 1024 })).toThrow();
    expect(() => decodeResizeInput({ mode: "fill", width: 1024, height: 768 })).toThrow();
  });

  it("allows fill-mode measurements below the minimum selectable fixed size", () => {
    expect(
      decodeResizeResult({
        tabId: "preview-t",
        setting: { _tag: "fill" },
        viewport: { width: 180, height: 120 },
      }).viewport,
    ).toEqual({ width: 180, height: 120 });
  });
});

describe("preview automation tab targeting", () => {
  it("accepts an explicit tab and rejects contradictory open behavior", () => {
    expect(decodeResizeInput({ tabId: "tab-app", mode: "fill" })).toMatchObject({
      tabId: "tab-app",
      mode: "fill",
    });
    expect(decodeOpenInput({ tabId: "tab-app", reuseExistingTab: true })).toMatchObject({
      tabId: "tab-app",
      reuseExistingTab: true,
    });
    expect(() => decodeOpenInput({ tabId: "tab-app", reuseExistingTab: false })).toThrow();
  });
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

describe("PreviewAutomationError", () => {
  it("preserves a typed non-editable target failure", () => {
    const error = decodeAutomationError({
      _tag: "PreviewAutomationTargetNotEditableError",
      operation: "type",
      environmentId: "environment-1",
      threadId: "thread-1",
      providerSessionId: "provider-session-1",
      providerInstanceId: "codex",
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      tabId: "tab-1",
      timeoutMs: 1_000,
      remoteTag: "PreviewAutomationTargetNotEditableError",
      remoteMessageLength: 12,
      cause: {},
      selectorKind: "focused-element",
    });

    expect(error._tag).toBe("PreviewAutomationTargetNotEditableError");
    if (error._tag === "PreviewAutomationTargetNotEditableError") {
      expect(error.selectorKind).toBe("focused-element");
      expect(error.message).toBe("Preview automation type requires an editable focused element.");
    }
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

describe("DiscoveredLocalServer", () => {
  it("rejects invalid ports", () => {
    expect(() =>
      decodeServer({
        host: "localhost",
        port: 0,
        url: "http://localhost:0",
        processName: null,
        pid: null,
        terminal: null,
      }),
    ).toThrow();
    expect(() =>
      decodeServer({
        host: "localhost",
        port: 70000,
        url: "http://localhost:70000",
        processName: null,
        pid: null,
        terminal: null,
      }),
    ).toThrow();
  });
});

describe("ConfiguredLocalServerUrls", () => {
  it("bounds the number and length of probe candidates", () => {
    expect(() =>
      decodeConfiguredLocalServerUrls(
        Array.from(
          { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
          (_, index) => `http://localhost:${3_000 + index}`,
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeConfiguredLocalServerUrls([`http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`]),
    ).toThrow();
  });
});
