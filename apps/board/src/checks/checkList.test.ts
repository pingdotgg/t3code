import { describe, expect, it } from "vite-plus/test";

import type { CheckRun, CheckStatus } from "../domain/readiness";
import { sortChecks, summarizeChecks } from "./checkList";

const check = (name: string, status: CheckStatus, fields: Partial<CheckRun> = {}): CheckRun => ({
  name,
  status,
  description: null,
  url: null,
  required: false,
  placeholder: false,
  runningSince: null,
  ...fields,
});

const MIXED = [
  check("lint", "success"),
  check("build", "pending"),
  check("e2e", "failure", { required: true }),
  check("deploy", "skipped"),
  check("Some workflow runs could not be listed", "action-required", { placeholder: true }),
  check("docs", "neutral"),
  check("cleanup", "cancelled"),
  check("approve", "action-required"),
  check("unit", "success", { required: true }),
  check("integration", "pending", { required: true }),
];

describe("the checks list", () => {
  it("Given all seven statuses, a required check, and a placeholder, when sorted, then failing come first, then running, then the rest, and the placeholder last", () => {
    expect(sortChecks(MIXED).map((entry) => entry.name)).toEqual([
      "e2e",
      "cleanup",
      "approve",
      "integration",
      "build",
      "unit",
      "lint",
      "deploy",
      "docs",
      "Some workflow runs could not be listed",
    ]);
  });

  it("Given the same list, when it is summed up, then the headline counts each state and notes the checks not listed", () => {
    expect(summarizeChecks(MIXED)).toBe(
      "2 failing, 1 needs action, 2 running, 2 passing, 1 skipped, 1 neutral, some not listed",
    );
  });

  it("Given one failing, two running, and eight passing checks, when summed up, then it reads like the Checks tab's headline", () => {
    const checks = [
      check("a", "failure"),
      check("b", "pending"),
      check("c", "pending"),
      ...Array.from({ length: 8 }, (_, index) => check(`ok-${index}`, "success")),
    ];
    expect(summarizeChecks(checks)).toBe("1 failing, 2 running, 8 passing");
  });

  it("Given no checks, when summed up, then it says so", () => {
    expect(summarizeChecks([])).toBe("No checks");
  });
});
