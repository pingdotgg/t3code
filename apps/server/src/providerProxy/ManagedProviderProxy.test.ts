import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";

import {
  isCompatibleCliProxyApiVersion,
  parseCliProxyApiVersionOutput,
} from "./CliProxyApiBinary.ts";
import { renderCliProxyApiConfig } from "./ManagedProviderProxy.ts";

describe("renderCliProxyApiConfig", () => {
  it("writes CLIProxyAPI's v8 layout: loopback, one client key, a management key, sticky sessions", () => {
    const config = parseYaml(
      renderCliProxyApiConfig({
        port: 41234,
        apiKey: 'client"key',
        managementKey: "mgmt\\key",
        authDir: "C:\\Users\\me\\.t3\\userdata\\cliproxyapi\\auths",
      }),
    );

    expect(config).toEqual({
      "config-version": 8,
      server: { host: "127.0.0.1", port: 41234 },
      management: {
        "allow-remote": false,
        "secret-key": "mgmt\\key",
        "disable-control-panel": true,
      },
      access: { "api-keys": ['client"key'] },
      routing: { "session-affinity": true },
      oauth: { "auth-dir": "C:\\Users\\me\\.t3\\userdata\\cliproxyapi\\auths" },
    });
  });
});

describe("parseCliProxyApiVersionOutput", () => {
  it("reads the version CLIProxyAPI prints before its usage text", () => {
    expect(
      parseCliProxyApiVersionOutput(
        "CLIProxyAPI Version: 8.0.47, Commit: 90c447d3, BuiltAt: 2026-10-29T00:27:53Z\nUsage of cli-proxy-api\n",
      ),
    ).toBe("8.0.47");
    expect(parseCliProxyApiVersionOutput("Usage of cli-proxy-api\n  -config string\n")).toBeNull();
    // A v7 override would ignore the v8 listener and management settings T3 writes.
    expect(["8.0.47", "8.1.0", "7.2.81"].map(isCompatibleCliProxyApiVersion)).toEqual([
      true,
      true,
      false,
    ]);
  });
});
