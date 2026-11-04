import { assert, describe, it } from "@effect/vitest";

import { cpuBusyBetween, parseLinuxCpu } from "./HostResources.ts";

const reading = (idle: number, total: number, count = 8) => ({ idle, total, count });

const parsed = (line: string) => {
  const cpu = parseLinuxCpu(line);
  if (cpu === null) throw new Error(`unparseable /proc/stat line: ${line}`);
  return { ...cpu, count: 8 };
};

describe("parseLinuxCpu", () => {
  it("counts disk wait as idle and interrupts as work", () => {
    // cpu user nice system idle iowait irq softirq steal guest guest_nice
    assert.deepInclude(parseLinuxCpu("cpu 100 0 200 600 100 0 100 0 0 0\n"), {
      idle: 7_000,
      total: 11_000,
    });
  });

  it("returns nothing for a line it cannot read", () => {
    assert.isNull(parseLinuxCpu("cpu 100 0 nonsense\n"));
  });
});

describe("cpuBusyBetween", () => {
  it("is the share of core time not spent idle", () => {
    assert.strictEqual(cpuBusyBetween(reading(1_000, 2_000), reading(1_750, 3_000)), 0.25);
  });

  it("counts softirq as busy rather than idle", () => {
    const before = parsed("cpu 0 0 0 0 0 0 0 0 0 0\n");
    const after = parsed("cpu 0 0 0 200 0 0 800 0 0 0\n");
    assert.strictEqual(cpuBusyBetween(before, after), 0.8);
  });

  it("stays within 0 to 1 when counters move inconsistently", () => {
    assert.strictEqual(cpuBusyBetween(reading(1_000, 2_000), reading(2_100, 3_000)), 0);
    assert.isNull(cpuBusyBetween(reading(1_000, 2_000), reading(980, 3_000)));
    assert.isNull(cpuBusyBetween(reading(1_000, 2_000), reading(1_000, 2_000)));
  });

  it("is unknown when the core count changed between readings", () => {
    assert.isNull(cpuBusyBetween(reading(1_000, 2_000, 8), reading(1_500, 3_000, 7)));
  });
});
