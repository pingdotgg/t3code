import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PluginPackageActionInput,
  PluginPackageOperationError,
  PluginPackageStatusSnapshot,
} from "./pluginPackages.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeStatus = Schema.decodeUnknownSync(PluginPackageStatusSnapshot);
const decodeAction = Schema.decodeUnknownSync(PluginPackageActionInput);

describe("plugin package contracts", () => {
  it("decodes environment package status", () => {
    expect(
      decodeStatus({
        errors: [],
        packages: [
          {
            id: "com.acme.runtime-status",
            version: "1.0.0",
            apiVersion: 1,
            enabled: true,
            state: "active",
            capabilities: ["t3.commands@1"],
            contributions: { commands: ["acme.runtime-status"] },
          },
        ],
      }),
    ).toEqual({
      errors: [],
      packages: [
        {
          id: "com.acme.runtime-status",
          version: "1.0.0",
          apiVersion: 1,
          enabled: true,
          state: "active",
          capabilities: ["t3.commands@1"],
          contributions: { commands: ["acme.runtime-status"] },
        },
      ],
    });
  });

  it("reports invalid discovered package directories without inventing an id", () => {
    expect(
      decodeStatus({
        errors: [{ directory: "broken-package", error: "manifest api version is unsupported" }],
        packages: [],
      }),
    ).toEqual({
      errors: [{ directory: "broken-package", error: "manifest api version is unsupported" }],
      packages: [],
    });
  });

  it("rejects malformed package ids and action payloads", () => {
    expect(() => decodeAction({ id: "runtime-status" })).toThrow();
    expect(() => decodeAction({ id: `com.${"a".repeat(252)}` })).toThrow();
    expect(() => decodeAction({ id: "com.acme.runtime-status", extra: true })).toThrow();
  });

  it("preserves operation causes without putting failure text in the stable message", () => {
    const cause = new Error("disk exploded");
    const error = new PluginPackageOperationError({ cause, operation: "enable" });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("enable failed for plugin packages");
    expect(
      new PluginPackageOperationError({
        detail: "package is not enabled",
        id: "com.acme.runtime-status",
        operation: "reload",
      }).message,
    ).toBe("reload failed for plugin package com.acme.runtime-status: package is not enabled");
  });

  it("registers fixed status and lifecycle rpc methods", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesStatus)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesEnable)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesDisable)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesReload)).toBe(true);
  });
});
