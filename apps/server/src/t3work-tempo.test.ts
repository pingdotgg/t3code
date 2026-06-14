import { describe, expect, it } from "@effect/vitest";

import {
  computeTempoUserCapacity,
  planSecondsInRange,
  selectUnavailabilityPlans,
} from "./t3work-tempo.ts";

const day = (date: string, requiredSeconds: number) => ({ date, requiredSeconds });

const plan = (overrides: Record<string, unknown>) => ({
  startDate: "2026-06-08",
  endDate: "2026-06-08",
  plannedSecondsPerDay: 14400,
  totalPlannedSecondsInScope: 14400,
  ...overrides,
});

describe("computeTempoUserCapacity", () => {
  it("sums requiredSeconds over the sprint window only", () => {
    const result = computeTempoUserCapacity({
      accountId: "a",
      scheduleDays: [
        day("2026-06-07", 25920), // before window
        day("2026-06-08", 25920),
        day("2026-06-09", 25920),
        day("2026-06-10", 0), // holiday
        day("2026-06-11", 25920),
        day("2026-06-20", 25920), // after window
      ],
      unavailabilityPlans: [],
      from: "2026-06-08",
      to: "2026-06-12",
    });
    expect(result.requiredSeconds).toBe(3 * 25920);
    expect(result.workingDays).toBe(3);
    expect(result.capacitySeconds).toBe(3 * 25920);
  });

  it("subtracts the selected unavailability plans", () => {
    const result = computeTempoUserCapacity({
      accountId: "a",
      scheduleDays: [day("2026-06-08", 28800), day("2026-06-09", 28800)],
      unavailabilityPlans: [plan({ planItem: { type: "PROJECT" } })],
      from: "2026-06-08",
      to: "2026-06-09",
    });
    expect(result.plannedSeconds).toBe(14400);
    expect(result.capacitySeconds).toBe(2 * 28800 - 14400);
  });

  it("never returns negative capacity", () => {
    const result = computeTempoUserCapacity({
      accountId: "a",
      scheduleDays: [day("2026-06-08", 7200)],
      unavailabilityPlans: [
        plan({ plannedSecondsPerDay: 28800, totalPlannedSecondsInScope: 28800 }),
      ],
      from: "2026-06-08",
      to: "2026-06-08",
    });
    expect(result.capacitySeconds).toBe(0);
  });
});

describe("selectUnavailabilityPlans", () => {
  const offProject = plan({ planItem: { id: "20545", type: "ISSUE" } }); // INT-2
  const sprintWork = plan({ planItem: { id: "777", type: "ISSUE" } }); // IES issue
  const generic = plan({ planItem: { type: "PROJECT" } });
  const issueKeyById = new Map([
    ["20545", "INT-2"],
    ["777", "IES-21014"],
  ]);

  it("always selects non-issue plans", () => {
    expect(selectUnavailabilityPlans([generic])).toEqual([generic]);
  });

  it("without a project key, issue plans never subtract", () => {
    expect(selectUnavailabilityPlans([offProject, sprintWork])).toEqual([]);
  });

  it("selects issue plans from OTHER projects, keeps own-project work plans", () => {
    const selected = selectUnavailabilityPlans([offProject, sprintWork, generic], {
      projectKey: "IES",
      issueKeyById,
    });
    expect(selected).toEqual([offProject, generic]);
  });

  it("treats unresolvable issue keys as work plans (conservative)", () => {
    const selected = selectUnavailabilityPlans([offProject], {
      projectKey: "IES",
      issueKeyById: new Map([["20545", null]]),
    });
    expect(selected).toEqual([]);
  });

  it("matches project keys case-insensitively", () => {
    const selected = selectUnavailabilityPlans([offProject], {
      projectKey: "int",
      issueKeyById,
    });
    expect(selected).toEqual([]);
  });
});

describe("planSecondsInRange", () => {
  it("falls back to per-day seconds over overlapping working days", () => {
    const workingDates = new Set(["2026-06-08", "2026-06-09", "2026-06-10"]);
    const seconds = planSecondsInRange(
      {
        startDate: "2026-06-09",
        endDate: "2026-06-15",
        plannedSecondsPerDay: 10000,
      },
      "2026-06-08",
      "2026-06-10",
      workingDates,
    );
    // Overlap 06-09..06-10, both working days.
    expect(seconds).toBe(20000);
  });

  it("returns zero for plans outside the window", () => {
    expect(
      planSecondsInRange(
        { startDate: "2026-05-01", endDate: "2026-05-05", plannedSecondsPerDay: 10000 },
        "2026-06-08",
        "2026-06-10",
        new Set(),
      ),
    ).toBe(0);
  });
});
