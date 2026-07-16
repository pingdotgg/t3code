import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const baseDescriptor = {
  environmentId: "environment-test",
  label: "Test environment",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

describe("ExecutionEnvironmentDescriptor.advertisedEndpoints", () => {
  it("decodes descriptors without advertisedEndpoints (older servers)", () => {
    const decoded = decodeDescriptor(baseDescriptor);
    expect(decoded.advertisedEndpoints).toBeUndefined();
  });

  it("decodes descriptors that advertise endpoints", () => {
    const decoded = decodeDescriptor({
      ...baseDescriptor,
      advertisedEndpoints: [
        {
          id: "tailscale-serve",
          label: "Tailscale",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: false,
          },
          httpBaseUrl: "https://machine.tailnet.ts.net/",
          wsBaseUrl: "wss://machine.tailnet.ts.net/",
          reachability: "private-network",
          compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
          source: "server",
          status: "available",
          isDefault: true,
        },
      ],
    });

    expect(decoded.advertisedEndpoints).toHaveLength(1);
    expect(decoded.advertisedEndpoints?.[0]?.id).toBe("tailscale-serve");
    expect(decoded.advertisedEndpoints?.[0]?.isDefault).toBe(true);
  });
});
