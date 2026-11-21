import { describe, expect, it } from "vite-plus/test";

import type { Ticket } from "../domain/ticket";
import { agentTree, type FamilyRow, joinBoard } from "./boardModel";

const ORCHESTRATOR = "th-orch";

const row = (
  id: string,
  title: string,
  extra: Partial<FamilyRow> & { parent?: string } = {},
): FamilyRow => {
  const { parent = ORCHESTRATOR, ...rest } = extra;
  // SAFETY: the board reads only the fields FamilyRow picks, and this sets every one of them.
  return {
    id,
    title,
    providerInstanceId: "claudeAgent",
    status: "idle",
    branch: null,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: "subagent",
      rootThreadId: ORCHESTRATOR,
    },
    creationSource: "mcp",
    activityRunStatus: null,
    pendingBackgroundTasks: [],
    pendingRuntimeRequest: null,
    ...rest,
  } as FamilyRow;
};

// SAFETY: only whether the request exists is read, never its fields.
const PENDING = { kind: "command" } as FamilyRow["pendingRuntimeRequest"];

const driverOf = (instanceId: string) => (instanceId === "claudeAgent" ? "claudeAgent" : null);

const tickets: ReadonlyArray<Ticket> = [
  {
    key: "T-1",
    title: "Login form",
    stage: "building",
    threads: [{ threadId: "th-a", role: "task", round: 2 }],
  },
  { key: "T-2", title: "Session store", stage: "building", dependsOn: ["T-1"] },
  { key: "T-3", title: "Docs", stage: "merged" },
];

const family = [
  row("th-orch", "board"),
  row("th-a", "[T-1] task", { status: "running", branch: "feat/login" }),
  row("th-b", "[T-2] scout", { pendingRuntimeRequest: PENDING }),
  row("th-c", "[T-1] reviewer"),
  row("th-d", "[board] scout"),
  row("th-e", "[T-9] wizard", { status: "failed" }),
];

describe("joining tickets with the thread family", () => {
  const model = joinBoard({ tickets, family, orchestratorThreadId: ORCHESTRATOR, driverOf });
  const summary = (lane: "building" | "merged") =>
    model.lanes[lane].map(({ ticket, agents }) => [
      ticket.key,
      agents.map((agent) => [agent.threadId, agent.role, agent.runState]),
    ]);

  it("Given a ticket that lists a thread, when joined, then the thread is its first agent and a title with the key adds the others", () => {
    expect(summary("building")).toEqual([
      [
        "T-1",
        [
          ["th-a", "task", "working"],
          ["th-c", "reviewer", "idle"],
        ],
      ],
      ["T-2", [["th-b", "scout", "idle"]]],
    ]);
    expect(summary("merged")).toEqual([["T-3", []]]);
    expect(model.lanes.planned).toEqual([]);
  });

  it("Given children no ticket claims, when joined, then they sit in unassigned", () => {
    expect(model.unassigned.map((agent) => [agent.threadId, agent.role, agent.registered])).toEqual(
      [
        ["th-d", "scout", true],
        ["th-e", "wizard", false],
      ],
    );
  });

  it("Given an agent's shell row, when joined, then the card fields come from it", () => {
    const [first] = model.lanes.building[0]?.agents ?? [];
    expect(first).toMatchObject({
      round: 2,
      branch: "feat/login",
      driver: "claudeAgent",
      pendingRequest: false,
      registered: true,
    });
    expect(model.lanes.building[1]?.agents[0]?.pendingRequest).toBe(true);
  });
});

describe("an agent's role", () => {
  const join = (title: string, role: string) =>
    joinBoard({
      tickets: [
        {
          key: "T-1",
          title: "a",
          stage: "building",
          threads: [{ threadId: "th-a", role, round: 1 }],
        },
      ],
      family: [row("th-a", title)],
      orchestratorThreadId: ORCHESTRATOR,
      driverOf,
    }).lanes.building[0]?.agents[0];

  it("Given a title that carries the t3 role and a ticket that records the registry role, when joined, then the registry role names the agent", () => {
    expect(join("[T-1] implementation", "task")).toMatchObject({ role: "task", registered: true });
  });

  it("Given a title and a ticket entry that both name a role outside the registry, when joined, then the agent is flagged", () => {
    expect(join("[T-1] wizard", "wizard")).toMatchObject({ role: "wizard", registered: false });
  });
});

describe("an agent outside the role registry", () => {
  const flagged = (creationSource: FamilyRow["creationSource"], subagent = true) => {
    const child = row("th-a", "hello", { creationSource });
    return joinBoard({
      tickets: [],
      family: [
        subagent ? child : { ...child, lineage: { ...child.lineage, relationshipToParent: null } },
      ],
      orchestratorThreadId: ORCHESTRATOR,
      driverOf,
    }).unassigned[0]?.outsideRegistry;
  };

  it("Given a child T3 made from the provider's own subagent call, when joined, then it is flagged", () => {
    expect(flagged("provider")).toBe(true);
  });

  it("Given a child started by delegate_task, when joined, then it is not flagged", () => {
    expect(flagged("mcp")).toBe(false);
  });

  it("Given a provider thread that is not a subagent, when joined, then it is not flagged", () => {
    expect(flagged("provider", false)).toBe(false);
  });
});

describe("the agent tree", () => {
  it("Given nested children, when built, then each parent counts its direct children and those working", () => {
    const tree = agentTree({
      family: [
        row("th-orch", "board"),
        row("th-a", "[T-1] task", { status: "running" }),
        row("th-a1", "[T-1] sonic", { parent: "th-a", status: "running" }),
        row("th-a2", "[T-1] scout", { parent: "th-a" }),
        row("th-b", "[T-2] scout"),
        row("th-lost", "[T-3] task", { parent: "th-gone" }),
      ],
      orchestratorThreadId: ORCHESTRATOR,
      driverOf,
    });
    expect(
      tree.map((node) => [
        node.agent.threadId,
        node.children.map((child) => child.agent.threadId),
        node.working,
      ]),
    ).toEqual([
      ["th-a", ["th-a1", "th-a2"], 1],
      ["th-b", [], 0],
      ["th-lost", [], 0],
    ]);
  });
});
