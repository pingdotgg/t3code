import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ConfiguredLocalServerUrls,
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  DiscoveredLocalServer,
  PREVIEW_URL_MAX_LENGTH,
  PreviewEvent,
  PreviewNavStatus,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
} from "./preview.ts";
import {
  PREVIEW_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationHost,
  PreviewAutomationError,
  PreviewAutomationDiagnosticsInput,
  PreviewAutomationDiagnosticsResult,
  PreviewAutomationOpenInput,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";

const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
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
const decodeDiagnosticsInput = Schema.decodeUnknownSync(PreviewAutomationDiagnosticsInput);
const decodeDiagnosticsResult = Schema.decodeUnknownSync(PreviewAutomationDiagnosticsResult);

describe("PreviewAutomationOpenInput", () => {
  it("accepts the inline preview visibility flag", () => {
    expect(decodeOpenInput({ open: false })).toEqual({ open: false });
  });

  it("retains the legacy show visibility alias", () => {
    expect(decodeOpenInput({ show: false })).toEqual({ show: false });
  });
});

describe("PreviewAutomationDiagnostics", () => {
  it("advertises diagnostics only on current hosts", () => {
    expect(PREVIEW_AUTOMATION_OPERATIONS).toContain("diagnostics");
    expect(PREVIEW_AUTOMATION_V1_OPERATIONS).not.toContain("diagnostics");
  });

  it("decodes all bounded input variants", () => {
    expect(decodeDiagnosticsInput({ kind: "console" })).toEqual({ kind: "console" });
    expect(
      decodeDiagnosticsInput({
        kind: "network",
        tabId: "tab-network",
        requestId: "request-1",
        includeResponseBody: true,
        limit: 10,
      }),
    ).toMatchObject({ kind: "network", requestId: "request-1", limit: 10 });
    expect(decodeDiagnosticsInput({ kind: "performance", sampleMs: 5000 })).toEqual({
      kind: "performance",
      sampleMs: 5000,
    });
    expect(decodeDiagnosticsInput({ kind: "memory", tabId: "tab-memory" })).toEqual({
      kind: "memory",
      tabId: "tab-memory",
    });
  });

  it("rejects invalid bounds, body-selection contradictions, and cross-kind options", () => {
    expect(() => decodeDiagnosticsInput({ kind: "console", limit: 0 })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "network", limit: 101 })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "performance", sampleMs: 5001 })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "network", includeResponseBody: true })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "network", requestId: "r".repeat(257) })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "console", requestId: "request-1" })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "console", includeResponseBody: false })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "network", sampleMs: 0 })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "performance", limit: 10 })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "memory", limit: 10 })).toThrow();
    expect(() => decodeDiagnosticsInput({ kind: "memory", requestId: "request-1" })).toThrow();
  });

  it("round-trips representative result schemas and backward-compatible console entries", () => {
    const consoleResult = decodeDiagnosticsResult({
      kind: "console",
      tabId: "tab-console",
      entries: [
        {
          level: "error",
          text: "boom",
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "exception",
          url: "http://localhost:5173/app.js",
          lineNumber: 4,
          columnNumber: 8,
          stack: [
            {
              functionName: "run",
              url: "http://localhost:5173/app.js",
              lineNumber: 4,
              columnNumber: 8,
            },
          ],
        },
      ],
      capturedCount: 1,
      returnedCount: 1,
      truncated: false,
    });
    expect(consoleResult.kind).toBe("console");
    expect(
      decodeDiagnosticsResult({
        kind: "console",
        tabId: "tab-old-console",
        entries: [{ level: "log", text: "old", timestamp: "2026-01-01T00:00:00.000Z" }],
        capturedCount: 1,
        returnedCount: 1,
        truncated: false,
      }),
    ).toMatchObject({ kind: "console", entries: [{ text: "old" }] });
    expect(
      decodeDiagnosticsResult({
        kind: "network",
        tabId: "tab-network",
        records: [
          {
            requestId: "request-1",
            url: "http://localhost:5173/data.json",
            method: "GET",
            status: 200,
            failed: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.010Z",
            durationMs: 10,
          },
        ],
        capturedCount: 1,
        returnedCount: 1,
        truncated: false,
        selectedRequestId: "request-1",
        requestFound: true,
        responseBody: '{"ok":true}',
        responseBodyBase64Encoded: false,
        responseBodyTruncated: false,
      }),
    ).toMatchObject({ kind: "network", requestFound: true });
    expect(
      decodeDiagnosticsResult({
        kind: "performance",
        tabId: "tab-performance",
        metrics: [{ name: "TaskDuration", value: 1.5 }],
        delta: [{ name: "TaskDuration", value: 0.5 }],
        navigation: null,
      }),
    ).toMatchObject({ kind: "performance", metrics: [{ name: "TaskDuration" }] });
    expect(
      decodeDiagnosticsResult({
        kind: "memory",
        tabId: "tab-memory",
        heapUsage: { usedSize: 10, totalSize: 20 },
        domCounters: { documents: 1, nodes: 3, jsEventListeners: 2 },
      }),
    ).toMatchObject({ kind: "memory", domCounters: { nodes: 3 } });
  });
});

describe("PreviewNavStatus", () => {
  it("decodes Idle", () => {
    expect(decodeNavStatus({ _tag: "Idle" })).toEqual({ _tag: "Idle" });
  });

  it("decodes Loading with title", () => {
    expect(decodeNavStatus({ _tag: "Loading", url: "http://localhost:5173/", title: "" })).toEqual({
      _tag: "Loading",
      url: "http://localhost:5173/",
      title: "",
    });
  });

  it("decodes LoadFailed with code/description", () => {
    expect(
      decodeNavStatus({
        _tag: "LoadFailed",
        url: "https://example.com/",
        title: "Example",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      }),
    ).toEqual({
      _tag: "LoadFailed",
      url: "https://example.com/",
      title: "Example",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
  });

  it("rejects empty url", () => {
    expect(() => decodeNavStatus({ _tag: "Loading", url: "", title: "" })).toThrow();
  });
});

describe("PreviewSessionSnapshot", () => {
  it("round-trips a Success snapshot", () => {
    const snapshot = decodeSnapshot({
      threadId: "thread-1",
      tabId: "preview-thread-1",
      navStatus: {
        _tag: "Success",
        url: "http://localhost:5173/",
        title: "Vite App",
      },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(snapshot.tabId).toBe("preview-thread-1");
    expect(snapshot.navStatus._tag).toBe("Success");
  });
});

describe("PreviewViewportSetting", () => {
  it("decodes fill, freeform, and preset modes", () => {
    expect(decodeViewport({ _tag: "fill" })).toEqual({ _tag: "fill" });
    expect(decodeViewport({ _tag: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
    expect(
      decodeViewport({
        _tag: "preset",
        presetId: "iphone-15-pro",
        width: 393,
        height: 852,
      }),
    ).toMatchObject({ _tag: "preset", presetId: "iphone-15-pro" });
  });

  it("rejects unsafe dimensions and oversized render areas", () => {
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

describe("PreviewEvent", () => {
  it("decodes opened", () => {
    const event = decodePreviewEvent({
      type: "opened",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(event.type).toBe("opened");
  });

  it("decodes failed with code/description", () => {
    const event = decodePreviewEvent({
      type: "failed",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      url: "https://example.com/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    expect(event.type).toBe("failed");
    if (event.type === "failed") {
      expect(event.code).toBe(-105);
    }
  });

  it("decodes resized with tab viewport state", () => {
    const event = decodePreviewEvent({
      type: "resized",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(event.type).toBe("resized");
  });

  it("decodes closed without snapshot", () => {
    const event = decodePreviewEvent({
      type: "closed",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
    });
    expect(event.type).toBe("closed");
  });
});

describe("DiscoveredLocalServer", () => {
  it("decodes a server with process metadata", () => {
    const server = decodeServer({
      host: "localhost",
      port: 5173,
      url: "http://localhost:5173",
      processName: "node",
      pid: 12345,
      terminal: null,
    });
    expect(server.port).toBe(5173);
    expect(server.processName).toBe("node");
  });

  it("decodes a server without process metadata", () => {
    const server = decodeServer({
      host: "localhost",
      port: 3000,
      url: "http://localhost:3000",
      processName: null,
      pid: null,
      terminal: null,
    });
    expect(server.processName).toBeNull();
  });

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
