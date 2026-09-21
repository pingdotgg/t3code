import { ComposerContextId, DeviceContextRecord, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { SshConnectionProfile } from "./catalog.ts";
import { RelayConnectionTarget, SshConnectionTarget } from "./model.ts";
import { deviceMention, searchDeviceMentions } from "./deviceMentions.ts";
import type { EnvironmentPresentation } from "./presentation.ts";

const isDeviceContextRecord = Schema.is(DeviceContextRecord);
const target = new SshConnectionTarget({
  environmentId: EnvironmentId.make("remote-machine"),
  connectionId: "ssh",
  label: "Build Box",
});
const machine: EnvironmentPresentation = {
  entry: {
    target,
    enabled: true,
    profile: Option.some(
      new SshConnectionProfile({
        connectionId: "ssh",
        environmentId: target.environmentId,
        label: target.label,
        target: {
          alias: "builder",
          hostname: "buildbox.tailnet.test",
          username: "dev",
          port: 2222,
        },
      }),
    ),
  },
  connection: { phase: "connected", error: null, traceId: null },
  serverConfig: null,
};

describe("device mentions", () => {
  it("searches existing machine names and SSH hostnames without case sensitivity", () => {
    expect(searchDeviceMentions([machine], "BUILD")).toHaveLength(1);
    expect(searchDeviceMentions([machine], "tailnet")).toHaveLength(1);
    expect(searchDeviceMentions([machine], "missing")).toEqual([]);
    expect(searchDeviceMentions([machine], "")).toHaveLength(1);
  });

  it("captures SSH details in the wire schema without connection credentials", () => {
    const record = { ...deviceMention(machine), contextId: ComposerContextId.make("device_1") };
    expect(isDeviceContextRecord(record)).toBe(true);
    expect(record.ssh).toEqual([{ host: "buildbox.tailnet.test", username: "dev", port: 2222 }]);
    expect(record).not.toHaveProperty("profile");
    expect(record).not.toHaveProperty("httpBaseUrl");
  });

  it("keeps offline relay machines identifiable without inventing an SSH hostname", () => {
    const relay: EnvironmentPresentation = {
      entry: {
        enabled: true,
        profile: Option.none(),
        target: new RelayConnectionTarget({
          environmentId: EnvironmentId.make("relay-machine"),
          label: "Build Box",
        }),
      },
      connection: { phase: "offline", error: null, traceId: null },
      serverConfig: null,
    };
    const devices = searchDeviceMentions([machine, relay], "Build Box");
    expect(devices.map((device) => device.environmentId)).toEqual([
      "remote-machine",
      "relay-machine",
    ]);
    expect(devices[1]).toMatchObject({ ssh: [], connectionStatus: "offline" });
  });
});
