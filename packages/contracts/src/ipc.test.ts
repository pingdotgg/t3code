import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopRendererStateWriteSchema } from "./ipc.ts";

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

describe("DesktopRendererStateWriteSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopRendererStateWriteSchema);

  it("limits renderer persistence to the two declared state documents", () => {
    expect(decode({ key: "ui-state", value: '{"projectOrder":[]}' })).toEqual({
      key: "ui-state",
      value: '{"projectOrder":[]}',
    });
    expect(decode({ key: "composer-preferences", value: null })).toEqual({
      key: "composer-preferences",
      value: null,
    });
    expect(() => decode({ key: "../settings", value: "{}" })).toThrow();
  });
});
