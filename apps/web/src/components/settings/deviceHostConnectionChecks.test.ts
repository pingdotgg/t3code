import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type DeviceHostSummary } from "@t3tools/contracts";
import {
  checkDeviceHostConnections,
  deviceHostConnectionKey,
  type DeviceHostCheck,
} from "./deviceHostConnectionChecks";

const host = { id: "mac", label: "Mac mini", target: "user@mac" };
const ids = ["a", "b", "c", "d"].map((id) => EnvironmentId.make(id));
const targets = ids.map((environmentId, index) => ({
  environmentId,
  label: environmentId,
  connected: index !== 3,
}));
const summary: DeviceHostSummary = {
  id: "mac",
  label: "Mac mini",
  kind: "ssh",
  platforms: [{ platform: "ios", available: true }],
  hubInstalled: false,
  agentDeviceInstalled: false,
};

describe("device host connection checks", () => {
  it("starts all connected environments and retains success, local, failure, and offline results", async () => {
    const calls: string[] = [];
    const pending = new Map<
      string,
      { resolve: (value: DeviceHostSummary) => void; reject: (error: Error) => void }
    >();
    const results = new Map<string, DeviceHostCheck>();
    const run = checkDeviceHostConnections(
      targets,
      host,
      (environmentId) => {
        calls.push(environmentId);
        return new Promise((resolve, reject) => pending.set(environmentId, { resolve, reject }));
      },
      (environmentId, result) => results.set(environmentId, result),
    );
    expect(calls).toEqual(ids.slice(0, 3));
    expect(results.get(ids[0]!)).toEqual({ status: "pending" });
    pending.get(ids[0]!)!.resolve(summary);
    pending.get(ids[1]!)!.resolve({ ...summary, id: "local", kind: "local" });
    pending.get(ids[2]!)!.reject(new Error("SSH key rejected"));
    await run;
    expect([...results.values()]).toEqual([
      { status: "connected", platforms: summary.platforms },
      { status: "local" },
      { status: "failed", error: "SSH key rejected" },
      { status: "failed", error: "Environment disconnected" },
    ]);
  });

  it("does not reuse results after editing a destination or SSH options", () => {
    const key = deviceHostConnectionKey(host);
    for (const changed of [
      { ...host, target: "other" },
      { ...host, port: 2222 },
      { ...host, identityFile: "~/.ssh/other" },
    ]) {
      expect(deviceHostConnectionKey(changed)).not.toBe(key);
    }
    expect(
      deviceHostConnectionKey({ ...host, id: "another-environment-id", label: "Renamed" }),
    ).toBe(key);
  });
});
