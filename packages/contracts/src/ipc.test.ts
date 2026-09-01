import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, DesktopSshEnvironmentTargetSchema } from "./ipc.ts";

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

describe("DesktopSshEnvironmentTargetSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopSshEnvironmentTargetSchema);

  it("preserves bounded local SSH environment variables", () => {
    expect(
      decode({
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
        environmentVariables: {
          AWS_PROFILE: "production",
          EMPTY_VALUE: "",
        },
      }).environmentVariables,
    ).toEqual({ AWS_PROFILE: "production", EMPTY_VALUE: "" });
  });

  it("rejects names that cannot be process environment keys", () => {
    expect(() =>
      decode({
        alias: "devbox",
        hostname: "devbox.example.test",
        username: null,
        port: null,
        environmentVariables: { "BAD-NAME": "value" },
      }),
    ).toThrow();
  });

  it("rejects NUL bytes before values reach process spawning", () => {
    expect(() =>
      decode({
        alias: "devbox",
        hostname: "devbox.example.test",
        username: null,
        port: null,
        environmentVariables: { TOKEN: "bad\0value" },
      }),
    ).toThrow();
  });

  it("rejects variables that can alter local process execution", () => {
    for (const name of [
      "PATH",
      "path",
      "LD_PRELOAD",
      "ld_audit",
      "DYLD_INSERT_LIBRARIES",
      "GSS_MECH_CONFIG",
      "KRB5_CONFIG",
      "KRB5_KTNAME",
      "KRB5_PLUGIN_DIR",
      "OpenSSL_CONF",
      "PROGRAMDATA",
      "SSH_ASKPASS",
      "SSH_SK_HELPER",
      "ssh_sk_provider",
      "SSH_PKCS11_HELPER",
      "T3_SSH_AUTH_SECRET",
    ]) {
      expect(() =>
        decode({
          alias: "devbox",
          hostname: "devbox.example.test",
          username: null,
          port: null,
          environmentVariables: { [name]: "value" },
        }),
      ).toThrow();
    }
  });
});
