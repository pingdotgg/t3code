import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopPreviewAutomationClickResultSchema,
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

describe("DesktopPreviewAutomationClickResultSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopPreviewAutomationClickResultSchema);

  it.each([
    { _tag: "Dispatched" },
    { _tag: "NotSent", reason: "tab-not-visible" },
    { _tag: "NotSent", reason: "timeout", timeoutMs: 50 },
    { _tag: "NotSent", reason: "target-missing" },
    { _tag: "NotSent", reason: "target-hidden" },
    { _tag: "NotSent", reason: "target-disabled" },
    { _tag: "NotSent", reason: "target-ambiguous", matchCount: 2 },
  ] as const)("decodes $reason", (result) => {
    expect(decode(result)).toEqual(result);
  });

  it("rejects an ambiguous target without a positive match count", () => {
    expect(() => decode({ _tag: "NotSent", reason: "target-ambiguous", matchCount: 0 })).toThrow();
  });
});
