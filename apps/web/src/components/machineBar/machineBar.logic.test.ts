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
  const now = Date.parse("2026-11-21T21:00:00.000Z");
  const environment = (
    id: string,
    label: string,
    reported: MachineStatus | null,
    options: { readonly ageMs?: number; readonly loading?: boolean } = {},
  ) => ({
    environmentId: EnvironmentId.make(id),
    label,
    status: reported,
    receivedAt: now - (options.ageMs ?? 1_000),
    loading: options.loading ?? false,
  });

  it("gives one chip per host, and names machines without fresh data by their label", () => {
    const chips = machineChips(
      [
        environment("local", "This PC", status("hub2", 1)),
        environment("hub2", "hub2", status("HUB2", 0)),
        environment("hub", "hub (backup)", null),
        environment("notebook", "Notebook", status("Tom_Notebook", 0), { ageMs: 120_000 }),
        environment("starting", "Starting", null, { loading: true }),
      ],
      now,
    );
    expect(
      chips.map(({ name, environmentLabel, capacity, loading }) => ({
        name,
        environmentLabel,
        capacity,
        loading,
      })),
    ).toEqual([
      {
        name: "hub2",
        environmentLabel: "This PC",
        capacity: { more: 1, limit: "cap", level: "room" },
        loading: false,
      },
      { name: "hub (backup)", environmentLabel: "hub (backup)", capacity: null, loading: false },
      // A server that stopped answering two minutes ago reads as off, not as its last numbers.
      { name: "Notebook", environmentLabel: "Notebook", capacity: null, loading: false },
      { name: "Starting", environmentLabel: "Starting", capacity: null, loading: true },
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
