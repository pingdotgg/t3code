import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveWorkflowGroups,
  isWorkflowScriptMessage,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
  workflowMemberModelSelection,
} from "./subagentRuntime.ts";
import { resolveSubagentMetadata } from "./subagentDisplay.ts";
import { formatSubagentEffort } from "./threadExecution.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number];

function subagent(overrides: Partial<ProjectedSubagent> = {}): ProjectedSubagent {
  return {
    id: "coordinator",
    title: "probe",
    prompt: "export const meta = …",
    model: "claude-opus-5[1m]",
    status: "running" satisfies OrchestrationV2Subagent["status"],
    result: null,
    startedAt: at("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-08-01T10:00:05.000Z"),
    ...overrides,
  };
}

const member = (
  overrides: Partial<OrchestrationV2SubagentWorkflow["agents"][number]> = {},
): OrchestrationV2SubagentWorkflow["agents"][number] => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const groupsOf = (subagents: ReadonlyArray<ProjectedSubagent>) =>
  deriveWorkflowGroups(projectedSubagentsToRuntime(subagents));

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it("uses a settled member's wall-clock completion separately from its execution duration", () => {
    const [, settled] = projectedSubagentsToRuntime([
      subagent({
        status: "completed",
        completedAt: at("2026-08-01T10:00:09.000Z"),
        workflow: {
          phases: [],
          agents: [
            member({
              state: "completed",
              model: "claude-opus-5[1m]",
              effort: "xhigh",
              speed: "standard",
              startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
              durationMs: 1500,
              completedAt: Date.UTC(2026, 7, 1, 10, 0, 4, 432),
              totalTokens: 71_141,
              toolCalls: 3,
              prompt: "Reply with exactly: A1",
              result: "A1",
            }),
          ],
        },
      }),
    ]);
    expect(settled?.status).toBe("completed");
    expect(settled?.completedAt).toBe("2026-08-01T10:00:04.432Z");
    expect(settled?.result).toBe("A1");
    expect(settled?.model).toBe("claude-opus-5[1m]");
    expect(settled?.effort).toBe("xhigh");
    expect(settled?.speed).toBe("standard");
    expect(settled?.progress).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
    const instanceId = ProviderInstanceId.make("claudeAgent");
    expect(workflowMemberModelSelection(settled!, instanceId)).toEqual({
      instanceId,
      model: "claude-opus-5[1m]",
      options: [
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: false },
      ],
    });
    expect(workflowMemberModelSelection({ model: null, effort: "xhigh" }, instanceId)).toBe(
      undefined,
    );
    const provider = {
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        { slug: "claude-opus-5", name: "Claude Opus 5", isCustom: false, capabilities: null },
      ],
    };
    const modelSelection = workflowMemberModelSelection(settled!, instanceId);
    const { modelSlug } = resolveSubagentMetadata({
      model: settled!.model,
      modelSelection,
      provider,
    });
    expect(formatSubagentEffort({ modelSlug, modelSelection, provider })).toBe("xhigh");
  });

  it("names a workflow by the model it runs on when the provider reports none", () => {
    const [workflow] = projectedSubagentsToRuntime([subagent({ model: null })]);
    expect(
      resolveSubagentMetadata({
        model: workflow!.model,
        modelSelection: { model: "claude-opus-5-5" },
      }).modelLabel,
    ).toBe("Claude Opus 5.5");
    expect(resolveSubagentMetadata({ model: workflow!.model }).modelLabel).toBe("Not reported");
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles unfinished members when the coordinator is %s",
    (status) => {
      const groups = groupsOf([
        subagent({
          status,
          completedAt: at("2026-08-01T10:00:09.000Z"),
          workflow: {
            phases: [],
            agents: [
              member(),
              member({ index: 2, state: "queued" }),
              member({
                index: 3,
                state: "completed",
                startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
                durationMs: 1500,
              }),
            ],
          },
        }),
      ]);
      expect(groups[0]?.workflow.status).toBe(status);
      const members = groups[0]?.phases.flatMap((phase) => phase.members);
      expect(members?.map((agent) => agent.status)).toEqual([status, status, "completed"]);
      expect(members?.map((agent) => agent.completedAt)).toEqual([
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:01.500Z",
      ]);
      expect(members?.[0]?.model).toBeNull();
      expect(members?.[0]?.effort).toBeNull();
      expect(members?.[0]?.speed).toBeUndefined();
    },
  );

  it("titles an untitled subagent from its prompt without splitting an emoji", () => {
    const [untitled] = projectedSubagentsToRuntime([
      subagent({ title: null, prompt: `${"a".repeat(76)}😀 and more work.` }),
    ]);
    expect(untitled?.title).toBe(`${"a".repeat(76)}...`);
  });
});

describe("deriveWorkflowGroups over a dynamic workflow", () => {
  it("groups and orders members without changing the plan, titles, or phase liveness", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 10, title: "Empty" },
            { index: 2, title: "Old Beta" },
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [
            member({ index: 3, label: "alpha:three", state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 2, label: "alpha:tie", state: "completed" }),
            member({ index: 4, label: "cancelled" }),
            member({ index: 5, label: "interrupted" }),
            member({ index: 3, label: "unphased:three", phaseIndex: undefined }),
            member({ index: 1, label: "unphased:null", phaseIndex: undefined }),
            member({ index: 0, label: "unphased:zero", phaseIndex: undefined }),
            member({ index: 2, label: "beta:queued", phaseIndex: 2, state: "queued" }),
            member({ index: 1, label: "idle", phaseIndex: 3, phaseTitle: "Resume" }),
            member({ index: 1, label: "waiting", phaseIndex: 4, phaseTitle: "Wait" }),
            member({ index: 1, label: "dynamic", phaseIndex: 5, phaseTitle: undefined }),
          ],
        },
      }),
    ]).map((agent) => {
      if (agent.title === "unphased:null") return { ...agent, agentIndex: null };
      if (agent.title === "cancelled") return { ...agent, status: "cancelled" as const };
      if (agent.title === "interrupted") return { ...agent, status: "interrupted" as const };
      if (agent.title === "idle") return { ...agent, status: "idle" as const };
      if (agent.title === "waiting") return { ...agent, status: "waiting" as const };
      return agent;
    });
    const before = structuredClone(runtime);
    for (const agent of runtime) {
      for (const phase of agent.phases) Object.freeze(phase);
      Object.freeze(agent.phases);
      Object.freeze(agent);
    }
    Object.freeze(runtime);
    const groups = deriveWorkflowGroups(runtime);
    expect(groups.map((group) => group.workflow.id)).toEqual(["coordinator"]);
    const group = groups[0]!;
    expect(
      group.phases.map((phase) => [
        phase.index,
        phase.title,
        phase.state,
        phase.settledCount,
        phase.members.map((agent) => agent.title),
      ]),
    ).toEqual([
      [
        1,
        "Alpha",
        "done",
        5,
        ["alpha:two", "alpha:tie", "alpha:three", "cancelled", "interrupted"],
      ],
      [2, "Beta", "running", 0, ["beta:queued"]],
      [3, "Resume", "running", 0, ["idle"]],
      [4, "Wait", "running", 0, ["waiting"]],
      [5, "Phase 6", "running", 0, ["dynamic"]],
      [10, "Empty", "pending", 0, []],
    ]);
    expect(group.unphasedMembers.map((agent) => agent.title)).toEqual([
      "unphased:null",
      "unphased:zero",
      "unphased:three",
    ]);
    expect(group.workflow).toBe(runtime[0]);
    for (const agent of [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ]) {
      expect(agent).toBe(runtime.find((input) => input.title === agent.title));
    }
    expect(runtime).toEqual(before);
  });

  it.each([
    ["Review", undefined, "Review"],
    [undefined, "Review", "Review"],
    ["Old", "Review", "Review"],
    [undefined, undefined, "Phase 2"],
    ["Review", "", ""],
  ])("keeps reported phase titles %s then %s", (first, second, expected) => {
    const agents = [member({ phaseTitle: first }), member({ index: 2, phaseTitle: second })];
    const groups = groupsOf([subagent({ workflow: { phases: [], agents } })]);
    expect(groups[0]?.phases[0]?.title).toBe(expected);
  });

  it("keeps unphased members with their workflow and excludes unrelated agents", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({ id: "ordinary" }),
      subagent({
        id: "earlier",
        startedAt: at("2026-08-01T09:00:00.000Z"),
        workflow: { phases: [], agents: [member({ phaseIndex: undefined })] },
      }),
      subagent({
        id: "__proto__",
        workflow: {
          phases: [],
          agents: [member({ phaseIndex: undefined, phaseTitle: undefined })],
        },
      }),
      subagent({ id: "constructor", workflow: { phases: [], agents: [] } }),
      subagent({ id: "orphan", workflow: { phases: [], agents: [member()] } }),
    ]);
    const groups = deriveWorkflowGroups(runtime.filter((agent) => agent.id !== "orphan"));
    expect(groups.map((group) => group.workflow.id)).toEqual([
      "earlier",
      "__proto__",
      "constructor",
    ]);
    expect(groups[0]?.unphasedMembers.map((agent) => agent.id)).toEqual(["earlier:agent:1"]);
    expect(groups[1]?.phases).toEqual([]);
    expect(groups[1]?.unphasedMembers.map((agent) => agent.id)).toEqual(["__proto__:agent:1"]);
    expect(groups[2]?.phases).toEqual([]);
    expect(groups[2]?.unphasedMembers).toEqual([]);
  });
});

describe("resolveWorkflowOpening", () => {
  const SCRIPT = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';
  const childThread = {
    id: ThreadId.make("child"),
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("parent"),
    },
    creationSource: "provider" as const,
  };
  const coordinator = (workflow?: OrchestrationV2SubagentWorkflow) => ({
    ...subagent({
      title: "Run the alpha workflow",
      childThreadId: "child",
      ...(workflow === undefined ? {} : { workflow }),
    }),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  });
  const brief = (text: string, workflowScript?: boolean) => ({
    id: "message-1",
    role: "user",
    text,
    ...(workflowScript === undefined ? {} : { workflowScript }),
  });

  it("opens a marked thread with the coordinator's plan and members", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT, true)],
      parentSubagents: [
        coordinator({
          name: "probe-wf",
          phases: [{ index: 1, title: "Alpha" }],
          agents: [member({ childThreadId: ThreadId.make("member-1") })],
        }),
      ],
    });
    expect(opening).toMatchObject({
      messageId: "message-1",
      script: SCRIPT,
      name: "probe-wf",
      description: "Run the alpha workflow",
    });
    expect(
      opening?.group?.phases.map((phase) => ({
        title: phase.title,
        members: phase.members.map((agent) => [agent.title, agent.status, agent.childThreadId]),
      })),
    ).toEqual([{ title: "Alpha", members: [["alpha:one", "running", "member-1"]] }]);
  });

  it("recognizes an unmarked script before the parent loads", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT)],
      parentSubagents: null,
    });
    expect(opening).toMatchObject({ script: SCRIPT, name: null, group: null });
  });

  it("leaves an ordinary subagent thread and other threads alone", () => {
    expect(
      resolveWorkflowOpening({
        thread: childThread,
        messages: [brief("Audit the last five commits.")],
        parentSubagents: [coordinator()],
      }),
    ).toBeNull();
    expect(
      resolveWorkflowOpening({
        thread: {
          ...childThread,
          lineage: { ...childThread.lineage, relationshipToParent: null, parentThreadId: null },
        },
        messages: [brief(SCRIPT)],
        parentSubagents: null,
      }),
    ).toBeNull();
    expect(isWorkflowScriptMessage({ role: "user", text: "Explain `export const meta`." })).toBe(
      false,
    );
    expect(isWorkflowScriptMessage({ role: "assistant", text: SCRIPT })).toBe(false);
  });
});
