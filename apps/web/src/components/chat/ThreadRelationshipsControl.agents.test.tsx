import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ThreadId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type OrchestrationV2ContextTransfer,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
  workflowCommand: vi.fn().mockResolvedValue({ _tag: "Success" }),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: state.projection }),
  useThreadShells: () => state.shells,
  useProjects: () => state.projects,
  useServerConfigs: () => state.configs,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "environment-data:orchestration:stop-workflow"
      ? state.workflowCommand
      : state.command,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../../state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  return {
    orchestrationEnvironment: {
      stopWorkflow: {
        label: "environment-data:orchestration:stop-workflow",
        permissionAtom: () => granted,
      },
    },
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => (state.showTooltips ? children : null),
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

let renderer: ReactTestRenderer;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.shells = [];
  state.projects = [];
  state.configs.clear();
  state.showTooltips = false;
  state.navigate.mockClear();
  state.command.mockClear();
  state.workflowCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  state.toast.mockClear();
  state.projection = null;
});

it("stops the entire native workflow through its parent without changing state before acknowledgement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const coordinator = {
    id: "workflow",
    origin: "provider_native",
    driver: "claudeAgent",
    providerInstanceId: "claude-work",
    childThreadId: "workflow-chat",
    title: "Checkout review",
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    workflow: {
      name: "Checkout review",
      phases: [{ index: 0, title: "Inspect" }],
      agents: [{ index: 0, label: "Checker", state: "running", phaseIndex: 0 }],
    },
  };
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      coordinator,
      {
        ...coordinator,
        id: "worker",
        childThreadId: "worker-chat",
        origin: "app_owned",
        title: "Worker",
        workflow: undefined,
      },
    ],
  };
  state.shells = [
    {
      environmentId: "remote",
      source: {
        id: "workflow-chat",
        title: "Coordinator chat",
        lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
        activityRunStatus: "waiting",
      },
    },
  ];
  await act(async () => {
    renderer = create(
      <ThreadRelationshipsPanel
        environmentId={EnvironmentId.make("remote")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Expand Checkout review" }).props.onClick(),
  );
  const stopButton = () =>
    renderer.root.findByProps({ "aria-label": "Stop workflow Checkout review" });
  expect(
    renderer.root.findAll(
      (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("Stop "),
    ),
  ).toHaveLength(2);
  let acknowledge!: (result: { _tag: string }) => void;
  state.workflowCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  await act(async () => {
    stopButton().props.onClick();
  });
  expect(state.workflowCommand).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: { threadId: "parent", subagentId: "workflow" },
  });
  expect(state.command).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(stopButton().props.disabled).toBe(true);
  expect(renderer.root.findByProps({ "aria-label": "Stop subagent Worker" }).props.disabled).toBe(
    true,
  );
  expect(renderer.root.findByProps({ "aria-label": "Open Checker chat" })).toBeDefined();
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage · 2 running"]);
  await act(async () => {
    acknowledge({ _tag: "Success" });
  });
  expect(stopButton().props.disabled).toBe(false);
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage · 2 running"]);
  state.workflowCommand.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => {
    stopButton().props.onClick();
  });
  expect(state.toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Could not stop workflow",
  });
  expect(stopButton().props.disabled).toBe(false);
  expect(state.command).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each([
  ["claudeAgent", "provider_native", "completed"],
  ["claudeAgent", "provider_native", "failed"],
  ["claudeAgent", "provider_native", "interrupted"],
  ["claudeAgent", "provider_native", "waiting"],
  ["codex", "provider_native", "running"],
  ["claudeAgent", "app_owned", "running"],
])("does not offer workflow stop for %s %s %s", async (driver, origin, status) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "workflow",
        driver,
        origin,
        status,
        providerInstanceId: "claude-work",
        childThreadId: "workflow-chat",
        title: "Checkout review",
        startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        workflow: { name: "Checkout review", phases: [], agents: [] },
      },
    ],
  };
  await act(async () => {
    renderer = create(
      <ThreadRelationshipsPanel
        environmentId={EnvironmentId.make("remote")}
        threadId={ThreadId.make("parent")}
      />,
    );
  });
  const previousAgents = renderer.root.findAll(
    (node) =>
      node.type === "button" && node.props["aria-expanded"] === false && !node.props["aria-label"],
  );
  if (previousAgents.length > 0) await act(async () => previousAgents[0]!.props.onClick());
  expect(renderer.root.findByProps({ "aria-label": "Expand Checkout review" })).toBeDefined();
  expect(
    renderer.root.findAllByProps({ "aria-label": "Stop workflow Checkout review" }),
  ).toHaveLength(0);
  expect(state.workflowCommand).not.toHaveBeenCalled();
});

it("opens the correct chat for every workflow phase and unphased member", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.showTooltips = true;
  state.configs.set("remote", {
    providers: [
      {
        instanceId: "claude-personal",
        driver: "claudeAgent",
        displayName: "Personal account",
        models: [],
      },
      {
        instanceId: "claude-work",
        driver: "claudeAgent",
        displayName: "Work account",
        models: [{ slug: "claude-sonnet-4-6", name: "Sonnet" }],
      },
    ],
  });
  const phases = ["Inspect", "Improve", "Verify"].map((title, index) => ({ index, title }));
  const agents = Array.from({ length: 7 }, (_, index) => ({
    index,
    label: `Member ${index}`,
    state:
      index === 2 ? "cancelled" : index === 4 ? "failed" : index === 5 ? "running" : "completed",
    ...(index < 6 ? { phaseIndex: Math.floor(index / 2) } : {}),
    childThreadId: `member-chat-${index}`,
    model: "claude-sonnet-4-6",
    result: `Result ${index}`,
    totalTokens: 1200,
    // Staggered starts, so a phase spans longer than either member's own run.
    startedAt: 1_700_000_000_000 + index * 1000,
    durationMs: 5000,
  }));
  const project = (members: typeof agents) => ({
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "workflow",
        driver: "claudeAgent",
        providerInstanceId: "claude-work",
        childThreadId: "workflow-chat",
        title: "Checkout review",
        status: "running",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
        workflow: { name: "Checkout review", phases, agents: members },
      },
    ],
  });
  state.projection = project(agents);
  // Matching IDs from another environment cannot make these chats available.
  const memberShells = agents.map((agent) => ({
    id: agent.childThreadId,
    title: agent.label,
    lineage: { parentThreadId: "workflow-chat", relationshipToParent: "subagent" },
    status: "completed",
    activityRunStatus: null,
  }));
  state.shells = memberShells.map((source) => ({ environmentId: "other", source }));
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Expand Checkout review" }).props.onClick(),
  );
  const memberButtons = () =>
    renderer.root.findAll(
      (node) =>
        node.type === "button" && String(node.props["aria-label"]).startsWith("Open Member"),
    );
  const phaseButtons = () =>
    renderer.root.findAll(
      (node) =>
        node.type === "button" &&
        typeof node.props["aria-expanded"] === "boolean" &&
        String(node.props["aria-label"]).includes(" phase, "),
    );
  // Only the running phase starts open, beside the unphased member.
  expect(memberButtons()).toHaveLength(3);
  expect(phaseButtons()).toHaveLength(3);
  expect(renderer.root.findByProps({ "aria-label": "Expand Inspect phase, done" })).toBeDefined();
  expect(
    renderer.root.findByProps({ "aria-label": "Expand Improve phase, stopped" }),
  ).toBeDefined();
  expect(
    renderer.root.findByProps({ "aria-label": "Collapse Verify phase, running" }),
  ).toBeDefined();
  for (const phase of phaseButtons().slice(0, 2)) await act(async () => phase.props.onClick());
  expect(memberButtons()).toHaveLength(7);
  for (const button of memberButtons()) {
    expect(button.props.disabled).toBe(true);
    await act(async () => button.props.onClick());
  }
  expect(state.navigate).not.toHaveBeenCalled();
  // The coordinator roster arrives before the member thread shells.
  state.shells = memberShells.map((source) => ({ environmentId: "remote", source }));
  await act(async () => renderer.update(cloneElement(panel)));
  for (const button of memberButtons()) expect(button.props.disabled).toBe(false);
  for (const agent of agents) {
    await act(async () =>
      renderer.root.findByProps({ "aria-label": `Open ${agent.label} chat` }).props.onClick(),
    );
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "remote", threadId: agent.childThreadId },
    });
  }
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered.match(/Sonnet · Work account/g)).toHaveLength(7);
  expect(rendered).not.toContain("Personal account");
  for (const phase of phases) expect(rendered).toContain(phase.title);
  // The closed row leaves phase progress to the tree.
  expect(rendered).not.toContain(" phases");
  expect(rendered).toContain('"1","/","2"," ","agents"');
  expect(rendered).toContain("Running");
  // The phase holding the running member reports itself as the active one.
  expect(rendered).toContain("running");
  expect(rendered).toContain("done");
  expect(rendered).toContain("stopped");
  // Members 0 and 1 start a second apart and run 5s each, so Inspect took 6s.
  expect(rendered).toContain('"6s"');
  for (const phase of phaseButtons()) {
    const label = String(phase.props["aria-label"]).slice("Collapse ".length);
    await act(async () => phase.props.onClick());
    expect(memberButtons()).toHaveLength(5);
    await act(async () =>
      renderer.root.findByProps({ "aria-label": `Expand ${label}` }).props.onClick(),
    );
    expect(memberButtons()).toHaveLength(7);
  }
  // A phase the user closed stays closed once it starts running, and stays
  // closed after it settles.
  await act(async () => phaseButtons()[0]!.props.onClick());
  expect(memberButtons()).toHaveLength(5);
  const restarted = agents.map((agent) =>
    agent.index === 0 ? { ...agent, state: "running" } : agent,
  );
  state.projection = project(restarted);
  await act(async () => renderer.update(cloneElement(panel)));
  expect(memberButtons()).toHaveLength(5);
  state.projection = project(agents);
  await act(async () => renderer.update(cloneElement(panel)));
  expect(memberButtons()).toHaveLength(5);
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Collapse Checkout review" }).props.onClick(),
  );
  expect(memberButtons()).toHaveLength(0);
  expect(state.navigate).toHaveBeenCalledTimes(7);
});

it("groups and counts a workflow by its run status instead of its coordinator chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.showTooltips = true;
  const coordinator = {
    id: "workflow",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: "workflow-chat",
    title: "Checkout review",
    status: "running",
    startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    progress: "Inspecting the checkout workflow",
    result: "Workflow checks complete",
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:00Z"),
    workflow: {
      name: "Checkout review",
      phases: [{ index: 0, title: "Inspect" }],
      agents: [{ index: 0, label: "Checker", state: "running", phaseIndex: 0 }],
    },
  };
  const projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null } },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [coordinator],
  };
  const child = {
    id: "workflow-chat",
    title: "Coordinator chat",
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    status: "completed",
    activityRunStatus: null,
  };
  state.projection = projection;
  state.shells = [{ environmentId: "test", source: child }];
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join("");
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage · 1 running"]);
  await act(async () =>
    renderer.root.findByProps({ "aria-label": "Expand Checkout review" }).props.onClick(),
  );
  expect(renderer.root.findByProps({ "aria-label": "Open Checker chat" })).toBeDefined();
  state.shells = [{ environmentId: "test", source: { ...child, activityRunStatus: "waiting" } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage · 1 running"]);
  expect(text()).toContain("Inspecting the checkout workflow");
  state.projection = {
    ...projection,
    subagents: [
      {
        ...coordinator,
        status: "completed",
        completedAt: DateTime.makeUnsafe("2026-09-21T12:10:00Z"),
      },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage"]);
  expect(text()).toContain("Previous agents");
  expect(renderer.root.findAllByProps({ "aria-label": "Open Checker chat" })).toHaveLength(0);
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(renderer.root.findByProps({ "aria-label": "Expand Checkout review" })).toBeDefined();
  expect(text()).toContain("Workflow checks complete");
  expect(text()).toContain("10m");
});

it.each([
  { driver: "codex", origin: "app_owned", runId: null, canStop: true },
  { driver: "claudeAgent", origin: "app_owned", runId: null, canStop: true },
  { driver: "claudeAgent", origin: "provider_native", runId: "run-1", canStop: true },
  { driver: "claudeAgent", origin: "provider_native", runId: null, canStop: false },
])(
  "offers individual Stop for supported $origin $driver subagents with run $runId",
  async ({ driver, origin, runId, canStop }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const parent = {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    };
    const child = {
      id: "child",
      title: "Worker",
      lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
    };
    const agent = {
      id: "agent",
      childThreadId: "child",
      origin,
      threadId: "parent",
      runId,
      nativeTaskRef: { driver, nativeId: "claude-task", strength: "strong" },
      driver,
      providerInstanceId: "codex",
      title: "Worker",
      prompt: "Check the change",
      model: "gpt-5.4",
      status: "running",
      progress: null,
      result: null,
      startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    };
    state.shells = [{ environmentId: "test", source: child }];
    const projection = {
      thread: parent,
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
      subagents: [agent],
    };
    state.projection = projection;
    const panel = (
      <ThreadRelationshipsPanel
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make("parent")}
      />
    );
    await act(async () => {
      renderer = create(panel);
    });
    if (!canStop) {
      expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(
        0,
      );
      return;
    }
    const stopButton = () => renderer.root.findByProps({ "aria-label": "Stop subagent Worker" });
    await act(async () => stopButton().props.onClick());
    expect(state.command).toHaveBeenCalledWith({
      environmentId: "test",
      input:
        origin === "provider_native"
          ? { threadId: "parent", subagentId: "agent" }
          : { threadId: "child" },
    });
    expect(state.navigate).not.toHaveBeenCalled();

    for (const status of ["starting", "running", "waiting"] as const) {
      state.command.mockClear();
      state.shells = [
        {
          environmentId: "test",
          source: {
            ...child,
            activityRunStatus: status,
            activityRunStartedAt: DateTime.makeUnsafe("2026-09-16T12:05:00Z"),
          },
        },
      ];
      state.projection = {
        ...projection,
        subagents: [{ ...agent, origin: "provider_native", status: "completed" }],
      };
      await act(async () => renderer.update(cloneElement(panel)));
      expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(
        0,
      );
      state.projection = { ...projection, subagents: [{ ...agent, status: "completed" }] };
      await act(async () => renderer.update(cloneElement(panel)));
      if (origin === "provider_native") {
        expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(
          0,
        );
        continue;
      }
      await act(async () => stopButton().props.onClick());
      expect(state.command).toHaveBeenCalledTimes(1);
      expect(state.command).toHaveBeenLastCalledWith({
        environmentId: "test",
        input: { threadId: "child" },
      });
    }
    state.shells = [{ environmentId: "test", source: child }];
    for (const status of ["completed", "failed", "interrupted"]) {
      state.projection = { ...projection, subagents: [{ ...agent, status }] };
      await act(async () => renderer.update(cloneElement(panel)));
      expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(
        0,
      );
    }
    state.projection = { ...projection, subagents: [{ ...agent, startedAt: null }] };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(0);
    state.projection = {
      ...projection,
      subagents: [{ ...agent, origin: "provider_native", driver: "codex" }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(renderer.root.findAllByProps({ "aria-label": "Stop subagent Worker" })).toHaveLength(0);
  },
);

it("shows the matching child agent details and refreshes them when the agent settles", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const agent = {
    id: "agent-1",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: "child-1",
    title: "Checker",
    prompt: "Check the change",
    model: "gpt-5.4",
    status: "running",
    progress: "Running checks",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
  };
  const projection = {
    thread: {
      id: "parent",
      lineage: { relationshipToParent: null },
      activeProviderThreadId: null,
    },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      { ...agent, id: "unlinked", childThreadId: null, title: "Unlinked agent" },
      agent,
      { ...agent, id: "agent-2", childThreadId: "child-2", title: "Worker", model: "gpt-5.3" },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ")
      .replace(/\s+/g, " ");
  expect(text()).toContain("Checker");
  expect(text()).toContain("Lineage · 3 running");
  expect(text()).toContain("running");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("gpt-5.3");
  expect(text()).not.toContain("tok");
  expect(text()).not.toContain("Unlinked agent");
  expect(text()).not.toContain("Active agents");
  expect(renderer.root.findAllByProps({ type: "button", "aria-expanded": true })).toHaveLength(0);

  state.projection = {
    ...projection,
    subagents: [
      {
        ...agent,
        status: "completed",
        progress: undefined,
        result: "All checks passed",
        completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
      },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(renderer.root.findByType("h3").children).toEqual(["Lineage"]);
  expect(text()).toContain("Previous agents (1)");
  expect(text()).not.toContain("Checker");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Checker");
  // A started agent's row shows only its compact time; the icon carries the status.
  expect(text()).toContain("Checker 2m");
  expect(text()).not.toContain("(1)");
  expect(text()).not.toContain("Done");
  expect(text()).not.toContain("running");
  expect(text()).not.toContain("Worker");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": true }).props.onClick(),
  );
  expect(text()).not.toContain("Checker");
  expect(text()).toContain("Previous agents (1)");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Checker");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `running-agent-${index}`,
      childThreadId: `running-child-${index}`,
    })),
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Lineage · 8 running");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `old-agent-${index}`,
      childThreadId: `old-child-${index}`,
      status: index === 7 ? "failed" : "completed",
      title: `Old agent ${index}`,
      result: index === 7 ? "Earlier build failed" : "Done",
      completedAt: DateTime.makeUnsafe("2026-09-16T12:02:15Z"),
    })),
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("1 failed");
  expect(text()).not.toContain("Old agent 7");
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Show "))!
      .props.onClick(),
  );
  expect(text()).toContain("Old agent 7");

  state.projection = {
    ...projection,
    subagents: [{ ...agent, childThreadId: null }],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Lineage · 1 running");
});

it("shows readable models and only differing workspace details in agent tooltips", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.showTooltips = true;
  const parent = {
    id: "parent",
    projectId: "main",
    worktreePath: null,
    lineage: {},
    activeProviderThreadId: null,
  };
  const child = {
    id: "child",
    projectId: "main",
    worktreePath: null as string | null,
    branch: null as string | null,
    title: "Worker",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }] as ModelSelection["options"],
    },
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  state.projects = [
    { id: "main", environmentId: "test", title: "Main", workspaceRoot: "/main" },
    {
      id: "other",
      environmentId: "elsewhere",
      title: "Wrong environment",
      workspaceRoot: "/wrong",
    },
    { id: "other", environmentId: "test", title: "Other project", workspaceRoot: "/other" },
  ];
  state.shells = [{ environmentId: "test", source: child }];
  state.configs.set("test", {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        models: [
          { slug: "gpt-5.4", name: "My GPT model", shortName: "My GPT", aliases: ["model-alias"] },
        ],
      },
    ],
  });
  const projection = {
    thread: parent,
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      {
        id: "agent",
        childThreadId: "child",
        origin: "app_owned",
        driver: "codex",
        providerInstanceId: "codex",
        title: "Worker",
        prompt: "Check",
        model: "gpt-5.4",
        status: "pending",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      },
    ],
  };
  state.projection = projection;
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
    />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const text = (visibleOnly = false) => {
    const read = (node: ReactTestInstance | string): string => {
      if (typeof node === "string") return node;
      if (visibleOnly && node.props.className === "sr-only") return "";
      return node.children.map(read).join("");
    };
    return read(renderer.root);
  };
  const rerender = async (source = child) => {
    state.shells = [{ environmentId: "test", source: { ...source } }];
    await act(async () => renderer.update(cloneElement(panel)));
  };
  const nativeProjection = {
    ...projection,
    subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
  };
  expect(text()).toContain("My GPT · high");
  state.projection = nativeProjection;
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("My GPT");
  expect(text()).not.toContain("My GPT · high");
  state.projection = projection;
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).not.toContain("Tokens");
  expect(text()).not.toContain("Open subagent");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("Workspace");

  for (const [model, expected] of [
    [null, "Not reported"],
    ["", "Not reported"],
    ["   ", "Not reported"],
    ["model-alias", "My GPT"],
    ["gpt-5.5", "GPT-5.5"],
    ["custom/model-v1", "custom/model-v1"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain(expected);
    if (!model?.trim() || model === "gpt-5.5" || model === "custom/model-v1") {
      expect(text()).not.toContain(" · high");
    } else {
      expect(text()).toContain(`${expected} · high`);
    }
    expect(text()).not.toContain("Unknown");
    if (!model?.trim()) expect(text()).not.toContain("My GPT");
  }

  for (const driver of [
    "codex",
    "claudeAgent",
    "cursor",
    "opencode",
    "grok",
    "antigravity",
    "pi",
    "acpRegistry",
  ]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model: null }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain("Not reported");
    expect(text()).not.toContain("My GPT");
  }

  state.projection = projection;
  for (const [options, expected] of [
    [[{ id: "effort", value: "max" }], " · max"],
    [[{ id: "reasoning", value: "low" }], " · low"],
    [[{ id: "variant", value: "high" }], " · high"],
    [[{ id: "reasoningEffort", value: "none" }], " · none"],
    [[{ id: "reasoningEffort", value: true }], ""],
    [[{ id: "serviceTier", value: "fast" }], ""],
    [[], ""],
    [undefined, ""],
  ] as const) {
    child.modelSelection.options = options;
    await rerender();
    expect(text()).toContain(`My GPT${expected}`);
    if (!expected) expect(text()).not.toContain("My GPT ·");
  }
  const speedConfig = state.configs.get("test");
  const serviceTier: ProviderOptionDescriptor = {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    currentValue: "priority",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
  };
  const fastMode: ProviderOptionDescriptor = {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
    currentValue: true,
  };
  for (const [driver, descriptor, value, iconLabel] of [
    ["codex", serviceTier, "default", ""],
    ["codex", serviceTier, "priority", "Fast mode on"],
    ["codex", serviceTier, "ultrafast", "Ultrafast mode on"],
    ["codex", serviceTier, "flex", ""],
    ["codex", serviceTier, "unknown", ""],
    [
      "codex",
      { ...serviceTier, options: serviceTier.options.filter(({ id }) => id !== "ultrafast") },
      "ultrafast",
      "",
    ],
    ["codex", serviceTier, true, ""],
    ["codex", serviceTier, undefined, ""],
    ["claudeAgent", fastMode, true, "Fast mode on"],
    ["claudeAgent", fastMode, false, ""],
    ["cursor", fastMode, true, "Fast mode on"],
    ["cursor", fastMode, false, ""],
    ["opencode", fastMode, true, "Fast mode on"],
    ["cursor", fastMode, "true", ""],
    ["cursor", serviceTier, "priority", ""],
  ] as const) {
    state.configs.set("test", {
      providers: [
        {
          instanceId: "codex",
          driver,
          models: [
            {
              slug: "gpt-5.4",
              name: "My GPT",
              capabilities: { optionDescriptors: [descriptor] },
            },
          ],
        },
      ],
    });
    child.modelSelection.options = [
      { id: "reasoningEffort", value: "high" },
      ...(value === undefined ? [] : [{ id: descriptor.id, value }]),
    ];
    await rerender();
    expect(text(true)).toContain("My GPT · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    expect(text()).toContain(`My GPT · ${iconLabel}high`);
    if (!iconLabel) expect(text()).not.toContain("mode on");
    child.modelSelection.options = child.modelSelection.options.filter(
      ({ id }) => id !== "reasoningEffort",
    );
    await rerender();
    expect(text()).not.toContain(" · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    if (iconLabel) expect(text()).toContain(iconLabel);
    else expect(text()).not.toContain("mode on");
  }
  state.configs.set("test", {
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Work account",
        models: [
          {
            slug: "gpt-5.4",
            name: "My GPT",
            capabilities: { optionDescriptors: [serviceTier] },
          },
        ],
      },
      {
        instanceId: "codex_personal",
        driver: "codex",
        displayName: "Personal account",
        models: [],
      },
    ],
  });
  child.modelSelection.options = [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ];
  await rerender();
  expect(text(true)).toContain("My GPT · Work account · high");
  expect(text()).toContain("My GPT · Work account · Fast mode onhigh");
  expect(text()).not.toContain("Personal account");
  state.projection = nativeProjection;
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
  state.projection = projection;
  for (const modelSelection of [
    { ...child.modelSelection, instanceId: "other" },
    { ...child.modelSelection, model: "gpt-5.5" },
  ]) {
    await rerender({ ...child, modelSelection });
    expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
  }
  state.shells = [];
  for (const status of ["running", "completed", "failed"] as const) {
    state.projection = {
      ...projection,
      subagents: [
        {
          ...projection.subagents[0],
          origin: "provider_native",
          status,
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "low" },
              { id: "serviceTier", value: "ultrafast" },
            ],
          },
        },
      ],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    if (status === "completed") {
      await act(async () =>
        renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
      );
    }
    expect(text()).toContain("My GPT · Work account · Ultrafast mode onlow");
    expect(text()).not.toContain(" · high");
  }
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": true }).props.onClick(),
  );
  state.projection = projection;
  state.configs.set("test", speedConfig);
  child.modelSelection.options = [{ id: "reasoningEffort", value: "high" }];
  await rerender({ ...child, modelSelection: { ...child.modelSelection, instanceId: "other" } });
  expect(text()).not.toContain("My GPT ·");
  const config = state.configs.get("test");
  state.configs.clear();
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  await rerender();
  expect(text()).toContain("GPT-5.4 · high");
  state.configs.set("test", config);
  for (const model of ["custom/model-v1", "custom/model-v2"]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    await rerender({
      ...child,
      modelSelection: { ...child.modelSelection, model: "custom/model-v1" },
    });
    expect(text().includes(`${model} · high`)).toBe(model === "custom/model-v1");
  }

  state.projection = {
    ...projection,
    subagents: [
      {
        ...projection.subagents[0],
        progress: "Checking the latest changes",
        result: "Old intermediate result",
      },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Checking the latest changes");
  expect(text()).not.toContain("Old intermediate result");
  const result = "Final checks passed. " + "More detail. ".repeat(50) + "Hidden tail";
  state.projection = {
    ...projection,
    subagents: [
      { ...projection.subagents[0], status: "failed", progress: "Stale progress", result },
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Final checks passed.");
  expect(text()).not.toContain("Stale progress");
  expect(text()).not.toContain("Hidden tail");
  expect(text()).not.toContain(result);
  state.projection = projection;

  child.worktreePath = "/main/worktrees/checker";
  await rerender();
  expect(text()).toContain("Worktree");
  expect(text()).toContain("checker");
  expect(text()).not.toContain("/main/worktrees");
  expect(text()).not.toContain("Project");

  child.branch = "fix/checker";
  await rerender();
  expect(text()).toContain("Branch");
  expect(text()).toContain("fix/checker");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("/main/worktrees");

  child.projectId = "other";
  child.worktreePath = null;
  child.branch = null;
  await rerender();
  expect(text()).toContain("Other project");
  expect(text()).toContain("Workspace");
  expect(text()).toContain("other");
  expect(text()).not.toContain("/other");
  expect(text()).not.toContain("Wrong environment");
  expect(text()).not.toContain("Worktree");

  state.shells = [];
  state.configs.clear();
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Workspace");

  for (const [driver, model, expected] of [
    ["codex", "gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
    ["codex", "custom/model-v2", "custom/model-v2"],
    ["claudeAgent", "gpt-5.4", "GPT-5.4"],
    ["claudeAgent", "claude-opus-4-6", "Claude Opus 4.6"],
    ["cursor", "composer-2", "Composer 2"],
    ["grok", "grok-4-fast", "Grok 4 Fast"],
    ["antigravity", "gemini-3.8-flash-high", "Gemini 3.8 Flash High"],
    ["opencode", "anthropic/claude-sonnet-4-6", "anthropic/Claude Sonnet 4.6"],
    ["codex", null, "Not reported"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain(expected);
  }
});

it("shows the parent's own visible status as parent and child activity change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("test");
  const parent = {
    id: "parent",
    title: "Parent conversation",
    status: "completed",
    activityRunStatus: "running",
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const child = {
    id: "child",
    title: "Current fork",
    status: "completed",
    lineage: { parentThreadId: "parent", relationshipToParent: "fork" },
  };
  state.projection = {
    thread: { ...child, activeProviderThreadId: null },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  const shells = (parentSource: typeof parent, childSource: typeof child) => [
    { environmentId, source: parentSource },
    { environmentId, source: childSource },
  ];
  state.shells = shells(parent, child);
  const panel = (
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={ThreadId.make("child")} />
  );
  await act(async () => {
    renderer = create(panel);
  });
  const visibleText = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string" && node.props.className !== "sr-only")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ");
  expect(visibleText()).toContain("Parent conversation");
  expect(visibleText()).toContain("Running");
  state.shells = shells(
    { ...parent, activityRunStatus: "completed" },
    { ...child, status: "running" },
  );
  await act(async () => renderer.update(cloneElement(panel)));
  expect(visibleText()).toContain("Done");
  expect(visibleText()).not.toContain("Running");
});

it.each(["source", "target"])(
  "shows transfer lifecycle states when viewing the %s thread",
  async (currentThreadId) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const environmentId = EnvironmentId.make("test");
    const threads = ["source", "target"].map((id) => ({
      id,
      title: `${id} conversation`,
      status: "running",
      activityRunStatus: "running",
      lineage: { parentThreadId: null, relationshipToParent: null },
    }));
    state.shells = threads.map((source) => ({ environmentId, source }));
    const labels: Record<OrchestrationV2ContextTransfer["status"], string> = {
      pending: "Queued",
      resolved_native: "Resolved (native)",
      resolved_portable: "Resolved (portable)",
      failed: "Failed",
      consumed: "Consumed",
      superseded: "Superseded",
    };
    const panel = (
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={ThreadId.make(currentThreadId)}
      />
    );
    for (const [status, label] of Object.entries(labels)) {
      state.projection = {
        thread: {
          ...threads.find((thread) => thread.id === currentThreadId),
          activeProviderThreadId: null,
        },
        runs: [],
        providerThreads: [],
        providerSessions: [],
        subagents: [],
        contextTransfers: [{ sourceThreadId: "source", targetThreadId: "target", status }],
      };
      await act(async () => {
        if (status === "pending") renderer = create(panel);
        else renderer.update(cloneElement(panel));
      });
      const visibleText = renderer.root
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join(" ");
      expect(visibleText).toContain(
        currentThreadId === "source" ? "target conversation" : "source conversation",
      );
      expect(visibleText).toContain(label);
      expect(visibleText).not.toContain("Unknown");
      expect(visibleText).not.toContain("Running");
    }
  },
);
