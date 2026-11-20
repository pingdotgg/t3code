import { describe, expect, it } from "vite-plus/test";

import { orchestratorStats, renderBrief } from "./brief";
import { resolveRoles, ROLES } from "./roles";

describe("the orchestrator brief", () => {
  it("Given a board folder and a cap of 2, when the brief renders, then it names the folder and the cap", () => {
    const brief = renderBrief({ boardDir: "/p/.agentboard/x", builderCap: 2 });
    expect(brief).toContain("/p/.agentboard/x");
    expect(brief).toContain("at most 2 building agents");
    expect(brief).not.toContain("{{");
  });

  it("Given the registry, when the brief renders, then every role is listed with its delegate_task arguments", () => {
    const brief = renderBrief({ boardDir: "/p/.agentboard/x", builderCap: 2 });
    expect(brief).toContain(
      '| `scout` | MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. | `research` | `shared` | `{"model":"claude-sonnet-5-5","options":{"effort":"medium"}}` | yes |',
    );
    expect(brief).toContain("Read /p/.agentboard/x/roles/<role>.md and act as that role.");
    expect(ROLES.filter((role) => !brief.includes(`| \`${role.name}\` |`))).toEqual([]);
  });

  it("Given a Codex orchestrator, when the brief renders, then no role carries a target", () => {
    const roles = resolveRoles(ROLES, { instanceId: "codex", driver: "codex", offered: [] });
    const brief = renderBrief({ boardDir: "/p/.agentboard/x", builderCap: 3, roles });
    expect(brief).toContain("at most 3 building agents");
    expect(brief).not.toContain('"options":{"effort"');
  });

  it("Given an instance that lacks a model, when the brief renders, then the fallback is stated under the table", () => {
    const roles = resolveRoles(ROLES, {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      offered: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    });
    const brief = renderBrief({ boardDir: "/p/.agentboard/x", builderCap: 2, roles });
    expect(brief).toContain(
      "- claude-fable-5-1 is not offered by claudeAgent, so it uses the orchestrator's model.",
    );
  });
});

describe("orchestrator stats", () => {
  const tickets = JSON.stringify([
    { key: "T-1", title: "a", stage: "planned" },
    { key: "T-2", title: "b", stage: "building" },
    { key: "T-3", title: "c", stage: "building" },
    { key: "T-4", title: "d", stage: "reviewing" },
    { key: "T-5", title: "e", stage: "merged" },
  ]);
  const forYou = [
    '{"id":"a","kind":"question","status":"open"}',
    '{"id":"b","kind":"gate","status":"open"}',
    '{"id":"a","kind":"question","status":"resolved"}',
    '{"id":"c","kind":"read","status":"held"}',
  ].join("\n");
  const decisions =
    "time\tdecision\talternatives\treason\tevidence\n2026-11-20\tSplit into five tickets\t-\tindependent\ttickets.json\n2026-11-21\tResearch T-1 first\t-\tunknown area\t-\n";

  it("Given a fixed store, when the stats are counted, then each number matches", () => {
    const stats = orchestratorStats({ tickets, forYou, decisions }, 2);
    expect(stats).toEqual({
      stages: {
        planned: 1,
        building: 2,
        reviewing: 1,
        verifying: 0,
        pr: 0,
        awaiting_approval: 0,
        merged: 1,
        off_path: 0,
      },
      ticketTotal: 5,
      forYouOpen: 1,
      buildersInUse: 2,
      builderCap: 2,
      latestDecision: { time: "2026-11-21", decision: "Research T-1 first" },
      problems: [],
    });
  });

  it("Given no store files yet, when the stats are counted, then everything is zero and nothing is a problem", () => {
    const stats = orchestratorStats({ tickets: null, forYou: null, decisions: null }, 2);
    expect(stats.ticketTotal).toBe(0);
    expect(stats.forYouOpen).toBe(0);
    expect(stats.latestDecision).toBeNull();
    expect(stats.problems).toEqual([]);
  });

  it("Given only the decisions header, when the stats are counted, then there is no latest decision", () => {
    const header = "time\tdecision\talternatives\treason\tevidence\n";
    expect(
      orchestratorStats({ tickets: null, forYou: null, decisions: header }, 2).latestDecision,
    ).toBeNull();
  });

  it("Given a bad stage and a bad line, when the stats are counted, then both are reported and the good lines count", () => {
    const stats = orchestratorStats(
      {
        tickets: '[{"key":"T-1","title":"a","stage":"done"}]',
        forYou: '{"id":"a","status":"open"}\n\nnot json\n',
        decisions: null,
      },
      2,
    );
    expect(stats.problems).toEqual([
      expect.stringContaining("tickets.json is invalid: "),
      "foryou.jsonl line 3 is not an item",
    ]);
    expect(stats.forYouOpen).toBe(1);
    expect(stats.ticketTotal).toBe(0);
  });
});
