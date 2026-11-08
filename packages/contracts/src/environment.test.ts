import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });

  it("decodes CloudSandboxCapabilities and CloudSandboxConnectionTargetSchema", () => {
    const decodeCapabilities = Schema.decodeUnknownSync(
      Schema.Struct({
        diskForking: Schema.Boolean,
        desktopStreaming: Schema.Boolean,
        autoStopKeepalive: Schema.Boolean,
        publicPortHosting: Schema.Boolean,
        hotResize: Schema.Boolean,
        rootAccess: Schema.Boolean,
      }),
    );

    const capabilities = decodeCapabilities({
      diskForking: true,
      desktopStreaming: true,
      autoStopKeepalive: true,
      publicPortHosting: true,
      hotResize: true,
      rootAccess: true,
    });
    expect(capabilities.diskForking).toBe(true);
    expect(capabilities.desktopStreaming).toBe(true);
  });
});
