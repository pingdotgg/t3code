import { EnvironmentId, type MachineStatus } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { claudeAccountUsage, machineChips } from "./machineBar.logic";

const GiB = 1024 ** 3;

function status(hostname: string, working: number): MachineStatus {
  return {
    hostname,
    platform: "linux",
    sampledAt: 0,
    cores: 4,
    load: [0.2, 0.3, 0.4],
    cpuUtilization: 0.1,
    memory: { totalBytes: 7 * GiB, availableBytes: 4 * GiB },
    swap: null,
    disk: null,
    pressure: null,
    working,
    open: 0,
    maxWorkingAgents: 2,
    agents: [],
  };
}

describe("machineChips", () => {
  it("gives a machine reached through two environments one chip, and an offline one its label", () => {
    const chips = machineChips([
      { environmentId: EnvironmentId.make("local"), label: "This PC", status: status("hub2", 1) },
      { environmentId: EnvironmentId.make("hub2"), label: "hub2", status: status("HUB2", 0) },
      { environmentId: EnvironmentId.make("hub"), label: "hub (backup)", status: null },
    ]);
    expect(
      chips.map(({ name, environmentLabel, capacity }) => ({ name, environmentLabel, capacity })),
    ).toEqual([
      {
        name: "hub2",
        environmentLabel: "This PC",
        capacity: { more: 1, limit: "cap", level: "room" },
      },
      { name: "hub (backup)", environmentLabel: "hub (backup)", capacity: null },
    ]);
  });
});

describe("claudeAccountUsage", () => {
  const account = (
    key: string,
    displayName: string | null,
    windows: LimitAccount["limits"]["windows"],
    driver: LimitAccount["driver"] = "claudeAgent" as LimitAccount["driver"],
  ): LimitAccount => ({
    key,
    driver,
    displayName,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-11-21T10:00:00.000Z", windows },
  });

  it("reads each Claude account's 5-hour and all-model weekly windows", () => {
    expect(
      claudeAccountUsage([
        account("b", "Auto B", [
          { id: "five_hour", kind: "session", label: "5h", usedPercent: 99.4 },
          { id: "seven_day", kind: "weekly", label: "Week", usedPercent: 19 },
        ]),
        account("a", "Auto", [
          { id: "five_hour", kind: "session", label: "5h", usedPercent: 45 },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Fable week",
            usedPercent: 100,
            modelIds: ["claude-fable-5-2"],
          },
          { id: "seven_day", kind: "weekly", label: "Week", usedPercent: 60 },
        ]),
        account(
          "codex",
          "Codex",
          [{ id: "5h", kind: "session", label: "5h", usedPercent: 10 }],
          "codex" as LimitAccount["driver"],
        ),
      ]),
    ).toEqual([
      { key: "a", label: "A", session: 45, weekly: 60 },
      { key: "b", label: "B", session: 99.4, weekly: 19 },
    ]);
  });
});
