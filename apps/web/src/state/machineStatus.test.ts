import { EnvironmentId, type MachineStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { machineEnvironmentFromResult } from "./machineStatus";

const environmentId = EnvironmentId.make("environment-1");
const receivedAt = 1_800_000_000_000;
const status: MachineStatus = {
  hostname: "hub2",
  platform: "linux",
  sampledAt: receivedAt,
  cores: 4,
  load: [0.2, 0.3, 0.4],
  cpuUtilization: 0.1,
  memory: { totalBytes: 7 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 },
  swap: null,
  disk: null,
  pressure: null,
  working: 1,
  open: 0,
  maxWorkingAgents: 2,
  agents: [],
};

const machine = (result: AsyncResult.AsyncResult<MachineStatus, unknown> | null) =>
  machineEnvironmentFromResult(environmentId, "hub2", result);

describe("machineEnvironmentFromResult", () => {
  it("reads a successful sample", () => {
    expect(machine(AsyncResult.success(status, { timestamp: receivedAt }))).toEqual({
      environmentId,
      label: "hub2",
      status,
      receivedAt,
      loading: false,
    });
  });

  it("keeps the last sample when a poll fails", () => {
    const previousSuccess = Option.some(AsyncResult.success(status, { timestamp: receivedAt }));
    const result = AsyncResult.failure(Cause.fail("timeout"), { previousSuccess });

    expect(machine(result)).toEqual({
      environmentId,
      label: "hub2",
      status,
      receivedAt,
      loading: false,
    });
  });

  it("reads off when failure has no previous sample", () => {
    expect(machine(AsyncResult.failure(Cause.fail("timeout")))).toEqual({
      environmentId,
      label: "hub2",
      status: null,
      receivedAt: 0,
      loading: false,
    });
  });

  it("reads off when the environment is disconnected", () => {
    expect(machine(null).status).toBeNull();
  });
});
