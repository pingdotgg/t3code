import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopWslStateSchema } from "./ipc.ts";

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


describe("DesktopWslStateSchema diagnostics", () => {
  const decode = Schema.decodeUnknownSync(DesktopWslStateSchema);

  it("preserves structured post-preflight failure evidence", () => {
    const diagnostic = {
      occurredAt: "2026-08-10T06:00:00.000Z",
      phase: "runtime-exit",
      message: "backend exited with code 1",
      distro: "Ubuntu",
      wslVersion: 2,
      nodePath: "/home/user/.cache/t3code/node",
      httpBaseUrl: "http://172.20.0.2:3774/",
      bindHost: "172.20.0.2",
      port: 3774,
      restartAttempt: 2,
      pid: 4242,
    } as const;
    expect(
      decode({
        enabled: true,
        distro: "Ubuntu",
        available: true,
        wslOnly: false,
        distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
        preflightError: null,
        diagnostic,
      }).diagnostic,
    ).toEqual(diagnostic);
  });
});
