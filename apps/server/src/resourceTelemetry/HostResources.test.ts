import { assert, describe, it } from "@effect/vitest";

import { cpuBusyBetween } from "./HostResources.ts";

const reading = (idle: number, total: number, count = 8, diskWait: number | null = 0) => ({
  idle,
  total,
  count,
  diskWait,
});

describe("cpuBusyBetween", () => {
  it("is the share of core time not spent idle", () => {
    assert.strictEqual(cpuBusyBetween(reading(1_000, 2_000), reading(1_750, 3_000)), 0.25);
  });

  it("stays within 0 to 1 when counters move inconsistently", () => {
    assert.strictEqual(cpuBusyBetween(reading(1_000, 2_000), reading(2_100, 3_000)), 0);
    assert.isNull(cpuBusyBetween(reading(1_000, 2_000), reading(980, 3_000)));
    assert.isNull(cpuBusyBetween(reading(1_000, 2_000), reading(1_000, 2_000)));
  });

  it("is unknown when the core count changed between readings", () => {
    assert.isNull(cpuBusyBetween(reading(1_000, 2_000, 8), reading(1_500, 3_000, 7)));
  });

  it("is unknown when disk wait could not be read", () => {
    const unknown = reading(1_000, 2_000, 8, null);
    assert.isNull(cpuBusyBetween(unknown, reading(1_200, 3_000)));
  });
});
