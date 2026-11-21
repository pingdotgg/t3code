import { describe, expect, it } from "vite-plus/test";

import {
  machineCapacity,
  recommendNextMachine,
  type MachineCapacityInput,
} from "./machineCapacity.ts";

const MB = 1024 * 1024;
const calm = { avg10: 0, avg60: 0 };

function machine(
  overrides: Partial<MachineCapacityInput> & {
    readonly totalMb: number;
    readonly availableMb: number;
  },
): MachineCapacityInput {
  const { totalMb, availableMb, ...rest } = overrides;
  return {
    cores: 4,
    load: [0.4, 0.5, 0.6],
    cpuUtilization: 0.1,
    memory: { totalBytes: totalMb * MB, availableBytes: availableMb * MB },
    pressure: { cpu: calm, memory: calm, io: calm },
    working: 0,
    maxWorkingAgents: null,
    ...rest,
  };
}

// hub2: 7.3 GB, 4 cores, at most 2 agents. hub: 3.2 GB on a slow disk.
const hub2 = (overrides: Partial<MachineCapacityInput> = {}) =>
  machine({ totalMb: 7346, availableMb: 4688, maxWorkingAgents: 2, ...overrides });
const hub = (availableMb: number, overrides: Partial<MachineCapacityInput> = {}) =>
  machine({ totalMb: 3276, availableMb, maxWorkingAgents: 2, ...overrides });

describe("machineCapacity", () => {
  it.each([
    // 15% of 7346 MB is above the 512 MB floor: (4688 - 1102) / 700 = 5 by memory, the cap says 1.
    ["hub2 with one agent", hub2({ working: 1 }), { more: 1, limit: "cap", level: "room" }],
    ["hub2 at its cap", hub2({ working: 2 }), { more: 0, limit: "cap", level: "full" }],
    ["hub2 over its cap", hub2({ working: 3 }), { more: 0, limit: "cap", level: "full" }],
    [
      "hub2 without a cap",
      hub2({ maxWorkingAgents: null }),
      { more: 5, limit: "memory", level: "room" },
    ],
    // The 512 MB floor applies: (1500 - 512) / 700 = 1.
    ["hub with 1.5 GB free", hub(1500), { more: 1, limit: "memory", level: "room" }],
    ["hub at its memory reserve", hub(1100), { more: 0, limit: "memory", level: "full" }],
    // Below the 800 MB gate for heavy work, the reserve already leaves no room.
    ["hub below the heavy-work gate", hub(790), { more: 0, limit: "memory", level: "full" }],
  ] as const)("%s", (_name, status, expected) => {
    expect(machineCapacity(status)).toEqual(expected);
  });

  it.each([
    [
      "memory pressure over 10",
      hub2({ pressure: { cpu: calm, memory: { avg10: 30, avg60: 11 }, io: calm } }),
      "memoryPressure",
    ],
    ["a 5-minute load at 85% of the cores", hub2({ load: [3, 3.4, 2] }), "cpu"],
    [
      "CPU pressure over 25",
      hub2({ pressure: { cpu: { avg10: 40, avg60: 26 }, memory: calm, io: calm } }),
      "cpu",
    ],
    [
      "IO pressure over 50",
      hub2({ pressure: { cpu: calm, memory: calm, io: { avg10: 51, avg60: 20 } } }),
      "io",
    ],
    ["a busy Windows CPU", hub2({ load: null, pressure: null, cpuUtilization: 0.9 }), "cpu"],
    [
      "pressure on a machine over its cap",
      hub2({ working: 3, pressure: { cpu: calm, memory: { avg10: 0, avg60: 12 }, io: calm } }),
      "memoryPressure",
    ],
  ] as const)("leaves no room under %s", (_name, status, limit) => {
    expect(machineCapacity(status)).toEqual({ more: 0, limit, level: "pressure" });
  });

  it("skips the pressure gates where the platform reports no pressure", () => {
    expect(
      machineCapacity(machine({ totalMb: 16_000, availableMb: 9_000, load: null, pressure: null })),
    ).toEqual({ more: 9, limit: "memory", level: "room" });
  });
});

describe("recommendNextMachine", () => {
  const notebook = (overrides: Partial<MachineCapacityInput> = {}) =>
    machine({ totalMb: 16_000, availableMb: 9_000, maxWorkingAgents: 3, ...overrides });

  it("picks the machine with the most room", () => {
    expect(
      recommendNextMachine([
        { id: "hub2", status: hub2({ working: 1 }) },
        { id: "notebook", status: notebook({ working: 1 }) },
        { id: "hub", status: hub(1500) },
      ]),
    ).toEqual({ kind: "start", id: "notebook", more: 2 });
  });

  it("breaks a tie by the share of free memory, then by order", () => {
    const tied = [
      { id: "hub", status: hub(1500) },
      { id: "hub2", status: hub2({ working: 1 }) },
      { id: "notebook", status: notebook({ working: 2, memory: hub2().memory }) },
    ];
    expect(recommendNextMachine(tied)).toEqual({ kind: "start", id: "hub2", more: 1 });
  });

  it("skips offline machines", () => {
    expect(
      recommendNextMachine([
        { id: "hub2", status: null },
        { id: "hub", status: hub(1500) },
      ]),
    ).toEqual({ kind: "start", id: "hub", more: 1 });
  });

  it("waits with each reason when nothing fits", () => {
    expect(
      recommendNextMachine([
        { id: "hub2", status: hub2({ working: 2 }) },
        { id: "notebook", status: notebook({ working: 3 }) },
        { id: "hub", status: hub(1500, { load: [4, 4, 4] }) },
        { id: "pc", status: null },
      ]),
    ).toEqual({ kind: "wait", limits: ["cap", "cpu"] });
  });

  it("waits without a reason when no machine reported", () => {
    expect(recommendNextMachine([{ id: "hub2", status: null }])).toEqual({
      kind: "wait",
      limits: [],
    });
  });
});
