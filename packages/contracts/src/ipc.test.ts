import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopMicrophoneAccessStatusSchema } from "./ipc.ts";

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

describe("DesktopMicrophoneAccessStatusSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopMicrophoneAccessStatusSchema);

  it("accepts every desktop microphone permission state", () => {
    for (const status of [
      "not-determined",
      "granted",
      "denied",
      "restricted",
      "unknown",
      "unsupported",
    ] as const) {
      expect(decode(status)).toBe(status);
    }
  });

  it("rejects unknown desktop microphone permission states", () => {
    expect(() => decode("prompting")).toThrow();
  });
});
