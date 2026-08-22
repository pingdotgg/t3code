import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPreviewAutomationSnapshotInputSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRecordingStopInputSchema,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("desktop recording finalization deadlines", () => {
  it("preserves explicit stop and save timeouts", () => {
    const decodeStop = Schema.decodeUnknownSync(DesktopPreviewRecordingStopInputSchema);
    const decodeSave = Schema.decodeUnknownSync(DesktopPreviewRecordingSaveInputSchema);
    const data = new Uint8Array([1, 2, 3]);

    expect(decodeStop({ tabId: "tab-1", timeoutMs: 1_250 })).toEqual({
      tabId: "tab-1",
      timeoutMs: 1_250,
    });
    expect(
      decodeSave({
        tabId: "tab-1",
        mimeType: "video/webm",
        data,
        idempotencyKey: "f3088f18-9595-44f8-a67c-50c587d034a2",
        timeoutMs: 1_250,
      }),
    ).toEqual({
      tabId: "tab-1",
      mimeType: "video/webm",
      data,
      idempotencyKey: "f3088f18-9595-44f8-a67c-50c587d034a2",
      timeoutMs: 1_250,
    });
    expect(() =>
      decodeSave({
        tabId: "tab-1",
        mimeType: "video/webm",
        data,
        idempotencyKey: "../unsafe",
      }),
    ).toThrow();
  });
});

describe("DesktopPreviewAutomationSnapshotInputSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopPreviewAutomationSnapshotInputSchema);

  it("defaults omitted legacy fields to foreground capture and the desktop timeout", () => {
    expect(decode({ tabId: "tab-1" })).toEqual({
      tabId: "tab-1",
      background: false,
      timeoutMs: 15_000,
    });
    expect(decode({ tabId: "tab-1", background: undefined })).toEqual({
      tabId: "tab-1",
      background: false,
      timeoutMs: 15_000,
    });
  });

  it("preserves a caller-supplied snapshot timeout", () => {
    expect(decode({ tabId: "tab-1", background: true, timeoutMs: 1_250 })).toEqual({
      tabId: "tab-1",
      background: true,
      timeoutMs: 1_250,
    });
  });
});
