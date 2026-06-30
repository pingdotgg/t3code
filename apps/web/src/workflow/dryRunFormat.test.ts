import type { WorkflowDryRunResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeDryRunEnd, describeDryRunHop } from "./dryRunFormat";

const laneName = (key: string) => (key === "work" ? "Work" : key === "done" ? "Done" : key);

describe("dryRunFormat", () => {
  it("describes hops by source", () => {
    expect(
      describeDryRunHop(
        {
          fromLane: "work",
          toLane: "done",
          source: "step_on",
          viaStepKey: "code",
          result: "success",
        } as never,
        laneName,
      ),
    ).toBe('Work → Done — step "code" success route');
    expect(
      describeDryRunHop(
        {
          fromLane: "work",
          toLane: "done",
          source: "lane_transition",
          matchedTransitionIndex: 1,
          result: "success",
        } as never,
        laneName,
      ),
    ).toBe("Work → Done — transition #2 matched");
    expect(
      describeDryRunHop(
        { fromLane: "work", toLane: "done", source: "lane_on", result: "failure" } as never,
        laneName,
      ),
    ).toBe("Work → Done — lane failure fallback");
  });

  it("describes end states", () => {
    const base = { startLane: "work", scenario: "success", hops: [], notes: [] };
    expect(
      describeDryRunEnd(
        { ...base, end: "terminal", endLane: "done" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toBe('Reached terminal lane "Done".');
    expect(
      describeDryRunEnd(
        { ...base, end: "no_route", endLane: "work" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toContain("no route matched");
    expect(
      describeDryRunEnd(
        { ...base, end: "manual", endLane: "work" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toContain("manual lane");
    expect(
      describeDryRunEnd(
        { ...base, end: "cycle_cap", endLane: "work" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toContain("unbounded cycle");
  });
});
