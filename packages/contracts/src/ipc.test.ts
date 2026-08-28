import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPreviewAutomationPressResultSchema,
} from "./ipc.ts";

const encodeAutomationPressResult = Schema.encodeUnknownSync(
  DesktopPreviewAutomationPressResultSchema,
);
const decodeAutomationPressResult = Schema.decodeUnknownSync(
  DesktopPreviewAutomationPressResultSchema,
);

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

describe("DesktopPreviewAutomationPressResultSchema", () => {
  const roundTrip = (input: unknown) => {
    const encoded = encodeAutomationPressResult(input);
    return decodeAutomationPressResult(encoded);
  };

  it.each([
    { _tag: "Success" },
    {
      _tag: "Failure",
      error: {
        _tag: "PreviewAutomationKeyboardWindowNotFocusedError",
        tabId: "tab-1",
        webContentsId: 41,
      },
    },
    {
      _tag: "Failure",
      error: {
        _tag: "PreviewAutomationKeyboardFocusedFrameUnsupportedError",
        tabId: "tab-1",
        webContentsId: 41,
      },
    },
    {
      _tag: "Failure",
      error: {
        _tag: "PreviewAutomationKeyboardDeliveryNotConfirmedError",
        tabId: "tab-1",
        webContentsId: 41,
      },
    },
    {
      _tag: "Failure",
      error: {
        _tag: "PreviewAutomationTargetChangedError",
        operation: "press",
        tabId: "tab-1",
        webContentsId: 41,
      },
    },
  ])("round-trips $error._tag", (result) => {
    expect(roundTrip(result)).toEqual(result);
  });

  it("rejects unknown fulfilled failures", () => {
    expect(() =>
      decodeAutomationPressResult({
        _tag: "Failure",
        error: {
          _tag: "PreviewOperationError",
          tabId: "tab-1",
          webContentsId: 41,
        },
      }),
    ).toThrow();
  });
});
