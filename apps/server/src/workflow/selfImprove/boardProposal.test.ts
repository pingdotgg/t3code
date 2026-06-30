import type {
  WorkflowBoardMetrics,
  WorkflowDefinition,
  WorkflowDryRunResult,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { buildProposalPrompt, parseBoardProposal } from "./boardProposalPrompt.ts";
import { dryRunRegression, preservationGate } from "./boardProposalValidation.ts";

const baseDefinition: WorkflowDefinition = {
  name: "Board A",
  sources: [],
  outbound: [],
  lanes: [
    { key: "backlog" as never, name: "Backlog", entry: "manual" },
    {
      key: "work" as never,
      name: "Work",
      entry: "auto",
      pipeline: [
        {
          key: "code" as never,
          type: "agent",
          agent: { instance: "claude_main" as never, model: "sonnet" as never },
          instruction: "do it" as never,
          on: { success: "done" as never },
        },
      ],
    },
    { key: "done" as never, name: "Done", entry: "auto", terminal: true },
  ],
} as WorkflowDefinition;

const metrics: WorkflowBoardMetrics = {
  windowDays: 30,
  generatedAt: "2026-06-14T00:00:00.000Z",
  throughput: { created: 5, shipped: 3 },
  cycleTime: { count: 3, p50Ms: 1000, p90Ms: 2000, avgMs: 1500 },
  wipByLane: [{ laneKey: "work", admitted: 2, queued: 1 }],
  statusBreakdown: { running: 2 },
  attention: {
    blocked: 1,
    waitingOnUser: 0,
    oldest: [
      {
        ticketId: "t-1",
        title: "SECRET PLAN: do not leak this title",
        laneKey: "work",
        ageMs: 99999,
      },
    ],
  },
  routeOutcomes: [
    { fromLane: "work", toLane: "done", source: "step_on", result: "success", count: 3 },
  ],
  manualMoveCount: 4,
  stepStats: [
    {
      laneKey: "work",
      stepKey: "code",
      stepType: "agent",
      succeeded: 3,
      failed: 1,
      retries: 2,
      totalTokens: 1234,
      avgDurationMs: 500,
    },
  ],
};

describe("buildProposalPrompt", () => {
  it("strips ticket titles from the attention list", () => {
    const prompt = buildProposalPrompt({ definition: baseDefinition, metrics });
    assert.notInclude(prompt, "do not leak this title");
    // The numeric age is still present.
    assert.include(prompt, "ageMs=99999");
  });

  it("includes the definition and numeric metrics", () => {
    const prompt = buildProposalPrompt({ definition: baseDefinition, metrics });
    assert.include(prompt, '"Board A"');
    assert.include(prompt, "Manual moves: 4");
    assert.include(prompt, "work.code");
  });

  it("includes the no-change-sources focus instruction", () => {
    const prompt = buildProposalPrompt({ definition: baseDefinition, metrics });
    assert.include(prompt, "do NOT change sources, outbound, or the board name");
    assert.include(prompt, '"proposedDefinition"');
  });

  it("redacts a seeded credential token from the assembled prompt", () => {
    const withToken = {
      name: "Board A",
      sources: [],
      outbound: [],
      lanes: [
        {
          key: "work",
          name: "Work",
          entry: "auto",
          pipeline: [
            {
              key: "code",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "use token ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
            },
          ],
        },
        { key: "done", name: "Done", entry: "auto", terminal: true },
      ],
    } as unknown as WorkflowDefinition;
    const prompt = buildProposalPrompt({ definition: withToken, metrics });
    assert.notInclude(prompt, "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    assert.include(prompt, "[redacted]");
  });
});

describe("parseBoardProposal", () => {
  it("passes through a well-formed payload", () => {
    const parsed = parseBoardProposal({ proposedDefinition: { name: "x" }, rationale: "because" });
    assert.deepEqual(parsed, { proposedDefinition: { name: "x" }, rationale: "because" });
  });

  it("throws when rationale is not a string", () => {
    assert.throws(() => parseBoardProposal({ proposedDefinition: {}, rationale: 1 as never }));
  });

  it("throws when proposedDefinition is missing", () => {
    assert.throws(() => parseBoardProposal({ proposedDefinition: null, rationale: "x" }));
  });
});

describe("preservationGate", () => {
  it("passes when sources/outbound/name unchanged", () => {
    const result = preservationGate(baseDefinition, baseDefinition);
    assert.isTrue(result.ok);
    assert.equal(result.violations.length, 0);
    assert.equal(result.laneDiffCount, 0);
  });

  it("fails when the board name changes", () => {
    const proposed = { ...baseDefinition, name: "Board B" } as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isFalse(result.ok);
    assert.isTrue(result.violations.some((v) => v.includes("board name")));
  });

  it("fails when sources change", () => {
    const proposed = {
      ...baseDefinition,
      sources: [{ provider: "github", url: "https://example.com" }],
    } as unknown as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isFalse(result.ok);
    assert.isTrue(result.violations.some((v) => v.includes("sources")));
  });

  it("fails when outbound changes", () => {
    const proposed = {
      ...baseDefinition,
      outbound: [{ when: { "==": [1, 1] }, connectionRef: "x" }],
    } as unknown as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isFalse(result.ok);
    assert.isTrue(result.violations.some((v) => v.includes("outbound")));
  });

  it("fails when board settings (maxConcurrentTickets) change", () => {
    const proposed = {
      ...baseDefinition,
      settings: { maxConcurrentTickets: 50 },
    } as unknown as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isFalse(result.ok);
    assert.isTrue(result.violations.some((v) => v.includes("settings")));
  });

  it("treats absent settings and an empty settings object as unchanged", () => {
    const proposed = {
      ...baseDefinition,
      settings: {},
    } as unknown as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isTrue(result.ok);
  });

  it("counts lane diffs (added + changed)", () => {
    const proposed = {
      ...baseDefinition,
      lanes: [
        ...baseDefinition.lanes,
        { key: "extra" as never, name: "Extra", entry: "manual" },
      ].map((lane) =>
        (lane.key as string) === "backlog" ? { ...lane, name: "Backlog renamed" } : lane,
      ),
    } as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isTrue(result.ok); // name/sources/outbound unchanged
    assert.equal(result.laneDiffCount, 2); // one changed, one added
  });

  it("fails when a proposal REMOVES an existing lane", () => {
    const proposed = {
      ...baseDefinition,
      lanes: baseDefinition.lanes.filter((lane) => (lane.key as string) !== "work"),
    } as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isFalse(result.ok);
    assert.isTrue(
      result.violations.some((v) => v.includes("removes/renames") && v.includes("work")),
    );
  });

  it("fails when a proposal RE-KEYS an existing lane (treated as removal)", () => {
    const proposed = {
      ...baseDefinition,
      lanes: baseDefinition.lanes.map((lane) =>
        (lane.key as string) === "work" ? { ...lane, key: "work_v2" as never } : lane,
      ),
    } as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isFalse(result.ok);
    assert.isTrue(
      result.violations.some((v) => v.includes("removes/renames") && v.includes("work")),
    );
  });

  it("still passes when a proposal only ADDS a lane (superset is allowed)", () => {
    const proposed = {
      ...baseDefinition,
      lanes: [...baseDefinition.lanes, { key: "extra" as never, name: "Extra", entry: "manual" }],
    } as WorkflowDefinition;
    const result = preservationGate(baseDefinition, proposed);
    assert.isTrue(result.ok);
  });
});

describe("dryRunRegression", () => {
  const result = (
    startLane: string,
    scenario: WorkflowDryRunResult["scenario"],
    end: WorkflowDryRunResult["end"],
  ): WorkflowDryRunResult => ({
    startLane: startLane as never,
    scenario,
    hops: [],
    end,
    endLane: startLane as never,
    notes: [],
  });

  it("flags a NEW no_route in proposed", () => {
    const base = [result("work", "success", "terminal")];
    const proposed = [result("work", "success", "no_route")];
    const out = dryRunRegression(base, proposed);
    assert.isFalse(out.ok);
    assert.equal(out.regressions.length, 1);
  });

  it("flags a NEW cycle_cap in proposed", () => {
    const base = [result("work", "failure", "manual")];
    const proposed = [result("work", "failure", "cycle_cap")];
    const out = dryRunRegression(base, proposed);
    assert.isFalse(out.ok);
  });

  it("does NOT flag a dead end already present in base", () => {
    const base = [result("work", "success", "no_route")];
    const proposed = [result("work", "success", "no_route")];
    const out = dryRunRegression(base, proposed);
    assert.isTrue(out.ok);
  });

  it("does NOT flag a proposal that fixes a base dead end", () => {
    const base = [result("work", "success", "no_route")];
    const proposed = [result("work", "success", "terminal")];
    const out = dryRunRegression(base, proposed);
    assert.isTrue(out.ok);
  });
});
