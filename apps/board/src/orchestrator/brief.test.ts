import { describe, expect, it } from "vite-plus/test";

import { orchestratorStats, renderFacts, renderRules } from "./brief";
import { resolveRoles, ROLES } from "./roles";

const FACTS = {
  boardDir: "/p/.agentboard/x",
  builderCap: 2,
  project: "slugkit",
  projectDir: "/p",
};

describe("the orchestrator's standing rules and board facts", () => {
  it("Given a board, when the facts render, then they name the folder, the cap, and the project and nothing else", () => {
    const facts = renderFacts(FACTS);
    expect(facts).toContain("`/p/.agentboard/x`");
    expect(facts).toContain("at most 2 building agents");
    expect(facts).toContain("`slugkit`, at `/p`");
    expect(facts).not.toContain("{{");
    expect(facts).not.toContain("delegate_task");
  });

  it("Given the standing rules, when they render, then they hold no board's folder, cap, or project", () => {
    const rules = renderRules();
    expect(rules).not.toContain("{{");
    expect(rules).not.toContain("# Board facts");
    expect(rules).toContain("Read <board folder>/roles/<role>.md and act as that role.");
    expect(rules).toContain("`printenv T3CODE_THREAD_ID`");
    expect(rules).toContain("`.agentboard/*/board.json`");
    expect(rules).toContain("`orchestratorThreadId`");
  });

  it("Given the registry, when the rules render, then every role is listed with its delegate_task arguments", () => {
    const rules = renderRules();
    expect(rules).toContain(
      '| `scout` | MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. | `research` | `shared` | `{"model":"claude-sonnet-5-5","options":{"effort":"medium"}}` | yes |',
    );
    expect(ROLES.filter((role) => !rules.includes(`| \`${role.name}\` |`))).toEqual([]);
  });

  it("Given a Codex orchestrator, when the rules render, then each role names the picked instance and no model", () => {
    const roles = resolveRoles(ROLES, { instanceId: "codex", driver: "codex", offered: [] });
    const rules = renderRules(roles);
    expect(rules).toContain('| `{"providerInstanceId":"codex"}` |');
    expect(rules).not.toContain('"options":{"effort"');
  });

  it("Given an instance that lacks a model, when the rules render, then the fallback is stated under the table", () => {
    const roles = resolveRoles(ROLES, {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      offered: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    });
    expect(renderRules(roles)).toContain(
      "- claude-fable-5-1 is not offered by claudeAgent, so it uses the orchestrator's model.",
    );
  });

  it("Given the rules, when they render, then they require the real clock, every stage, a named PR base, and evidence", () => {
    const rules = renderRules();
    expect(rules).toContain("`date -u +%Y-%m-%dT%H:%M:%SZ`");
    expect(rules).toContain("Move a ticket here the moment you open its pull request");
    expect(rules).toContain("Open each pull request against the base the user named.");
    expect(rules).toContain("<its worktree>/.omp/artifacts/<ticket key>/");
    expect(rules).toContain("<board folder>/artifacts/<ticket key>/");
    expect(rules).toContain("`met`, `evidence`, and `note` are all required");
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
  const item = (id: string, kind: string, status: string) =>
    JSON.stringify({ id, kind, title: id, body: "", status, createdAt: "2026-11-20T10:00:00Z" });
  const forYou = [
    item("a", "question", "open"),
    item("b", "gate", "open"),
    '{"id":"a","status":"resolved"}',
    item("c", "read", "held"),
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

  it("Given a bad stage and a bad for-you line, when the stats are counted, then the stage is reported and the good lines count", () => {
    const stats = orchestratorStats(
      {
        tickets: '[{"key":"T-1","title":"a","stage":"done"}]',
        forYou: `${item("a", "question", "open")}\n\nnot json\n`,
        decisions: null,
      },
      2,
    );
    expect(stats.problems).toEqual([expect.stringContaining("tickets.json is invalid: ")]);
    expect(stats.forYouOpen).toBe(1);
    expect(stats.ticketTotal).toBe(0);
  });
});
