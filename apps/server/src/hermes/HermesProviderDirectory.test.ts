import { ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { resolveHermesProviderConnections } from "./HermesProviderDirectory.ts";
import { DEFAULT_HERMES_SERVE_ENDPOINT } from "./HermesServeRuntime.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

const gatewayEnvironment = [{ name: "HERMES_GATEWAY_TOKEN", value: "token-1", sensitive: true }];

const settingsWith = (input: {
  readonly config: Record<string, unknown>;
  readonly environment?: ReadonlyArray<Record<string, unknown>>;
  readonly enableRemoteHermes?: boolean;
}): ServerSettings =>
  decodeServerSettings({
    enableHermes: true,
    ...(input.enableRemoteHermes === undefined
      ? {}
      : { enableRemoteHermes: input.enableRemoteHermes }),
    providerInstances: {
      hermes_main: {
        driver: "hermes",
        displayName: "Hermes",
        enabled: true,
        environment: input.environment ?? gatewayEnvironment,
        config: { enabled: true, profileKey: "work", ...input.config },
      },
    },
  });

describe("resolveHermesProviderConnections", () => {
  it("treats an empty endpoint as the default loopback gateway endpoint", () => {
    const directory = resolveHermesProviderConnections(settingsWith({ config: { endpoint: "" } }));
    expect(
      directory.unavailable.filter((provider) => provider.providerInstanceId === "hermes_main"),
    ).toEqual([]);
    expect(
      directory.ready.find((provider) => provider.providerInstanceId === "hermes_main"),
    ).toMatchObject({
      endpoint: DEFAULT_HERMES_SERVE_ENDPOINT,
      token: "token-1",
    });
  });

  it("does not hand the local gateway token to remote endpoints when remote Hermes is disabled", () => {
    const directory = resolveHermesProviderConnections(
      settingsWith({ config: { endpoint: "wss://hermes.example.com/api/ws" } }),
    );
    expect(directory.ready).toEqual([]);
    expect(
      directory.unavailable.some((provider) => provider.providerInstanceId === "hermes_main"),
    ).toBe(true);
  });

  it("blocks remote endpoints without dedicated pairing material even when remote access is enabled", () => {
    const directory = resolveHermesProviderConnections(
      settingsWith({
        config: { endpoint: "wss://hermes.example.com/api/ws", remoteAccessEnabled: true },
        enableRemoteHermes: true,
      }),
    );
    expect(directory.ready).toEqual([]);
    expect(
      directory.unavailable.find((provider) => provider.providerInstanceId === "hermes_main")
        ?.diagnostic,
    ).toContain("HERMES_REMOTE_PAIRING_TOKEN");
  });
});
