import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  ThreadId,
  type ModelSelection,
  type NodeId,
  type ProviderOptionDescriptor,
  type OrchestrationV2ContextTransfer,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  projections: new Map<string, unknown>(),
  owningAgents: new Map<string, unknown>(),
  lookupSubagent: vi.fn(),
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/entities", () => ({
  useThreadProjection: (ref: ScopedThreadRef | null) => {
    if (!ref) return null;
    const current = state.projection as { thread: { id: string } } | null;
    const projection =
      current?.thread.id === ref.threadId ? state.projection : state.projections.get(ref.threadId);
    return projection ? { projection } : null;
  },
  useThreadShells: () => state.shells,
  useProjects: () => state.projects,
  useServerConfigs: () => state.configs,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [] }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/threads")>()),
  useOwningSubagent: (ref: ScopedThreadRef | null, nodeId: NodeId | null) => {
    if (!ref || !nodeId) return null;
    state.lookupSubagent(ref, nodeId);
    return state.owningAgents.get(`${ref.threadId}:${nodeId}`) ?? null;
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) =>
    state.showTooltips ? <span>{children}</span> : null,
}));

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

let renderer: ReactTestRenderer;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
  state.projection = null;
  state.projections.clear();
  state.owningAgents.clear();
  state.lookupSubagent.mockClear();
  state.navigate.mockClear();
  state.shells = [];
  state.projects = [];
  state.configs.clear();
  state.showTooltips = false;
});

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
  expect(text()).toContain("2m 15s");
  expect(text()).not.toContain("(1)");
  expect(text()).toContain("Done");
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

it.each(["live", "retained"])(
  "opens %s workflows and their phase members without changing ordinary agent navigation",
  async (source) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const agent = {
      id: "workflow-node",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      childThreadId: "workflow-child",
      title: "Native workflow",
      prompt: "await workflow.run();",
      model: "claude-opus-4-6",
      status: source === "live" ? "running" : "completed",
      result: null,
      startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      workflow: {
        name: "Release review",
        phases: [
          { index: 2, title: "Publish" },
          { index: 1, title: "Inspect" },
        ],
        agents: [
          {
            index: 1,
            label: "Release writer",
            model: "claude-sonnet-4-6",
            lastToolName: "Bash",
            totalTokens: 1234,
            toolCalls: 5,
            state: "running",
            phaseIndex: 2,
            childThreadId: "writer-child",
          },
          {
            index: 0,
            label: "Code reviewer",
            state: "completed",
            phaseIndex: 1,
            childThreadId: "reviewer-child",
          },
        ],
      },
    };
    const ordinary = {
      ...agent,
      id: "ordinary-node",
      childThreadId: "ordinary-child",
      title: "Ordinary agent",
      status: "running",
      workflow: undefined,
    };
    state.projection = {
      thread: {
        id: "parent",
        lineage: { parentThreadId: null, relationshipToParent: null },
        activeProviderThreadId: null,
      },
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
      subagents: source === "live" ? [agent, ordinary] : [ordinary],
    };
    const shells = [
      ...[agent, ordinary].map((entry) => ({
        id: entry.childThreadId,
        title: entry.title,
        status: entry.status,
        lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
        forkedFrom: { type: "node", nodeId: entry.id },
      })),
      ...agent.workflow.agents.map((member) => ({
        id: member.childThreadId,
        title: member.label,
        status: member.state,
        lineage: { parentThreadId: "workflow-child", relationshipToParent: "subagent" },
      })),
    ].map((entry) => ({ environmentId: "test", source: entry }));
    state.shells = shells;
    state.owningAgents.set("parent:workflow-node", agent);
    state.showTooltips = true;
    await act(async () => {
      renderer = create(
        <ThreadRelationshipsPanel
          environmentId={EnvironmentId.make("test")}
          threadId={ThreadId.make("parent")}
        />,
      );
    });
    const text = (root = renderer.root) =>
      root
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join(" ");
    const buttonWithText = (value: string) =>
      renderer.root.findAllByType("button").find((button) => text(button).includes(value))!;
    const buttonWithLabel = (label: string) =>
      renderer.root.findAllByType("button").find((button) => button.props["aria-label"] === label)!;
    expect(state.lookupSubagent).not.toHaveBeenCalled();
    if (source === "retained") {
      expect(text()).not.toContain("Release review");
      await act(async () => buttonWithText("Previous agents").props.onClick());
      expect(state.lookupSubagent).toHaveBeenCalledWith(
        { environmentId: "test", threadId: "parent" },
        "workflow-node",
      );
    }
    expect(text()).toContain("Release review");
    expect(text()).toContain("Ordinary agent");
    expect(text()).not.toContain("Inspect");
    expect(text()).not.toContain("Code reviewer");
    await act(async () => buttonWithText("Release review").props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "workflow-child" },
    });
    expect(text()).not.toContain("Inspect");
    state.navigate.mockClear();
    await act(async () => buttonWithLabel("Expand workflow").props.onClick());
    expect(state.navigate).not.toHaveBeenCalled();
    expect(text()).toContain("Inspect");
    expect(text()).toContain("Publish");
    const phaseTitles = renderer.root
      .findAllByType("button")
      .map((button) => button.props["aria-label"])
      .filter((label) => typeof label === "string" && /^(Inspect|Publish):/.test(label));
    expect(phaseTitles[0]).toContain("Inspect");
    expect(phaseTitles[1]).toContain("Publish");
    expect(text()).not.toContain("Code reviewer");
    await act(async () => buttonWithLabel("Inspect: 1/1").props.onClick());
    expect(text()).toContain("Code reviewer");
    await act(async () => buttonWithLabel("Open Code reviewer").props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "reviewer-child" },
    });
    expect(text()).toContain("Last tool: Bash");
    expect(text()).toContain("1,234 tokens");
    expect(text()).toContain("5 tool calls");
    await act(async () => buttonWithLabel("Open Release writer").props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "writer-child" },
    });
    await act(async () => buttonWithLabel("Collapse workflow").props.onClick());
    expect(text()).not.toContain("Inspect");
    expect(text()).not.toContain("Code reviewer");
    expect(buttonWithText("Ordinary agent").props.disabled).toBe(false);
    await act(async () => buttonWithText("Ordinary agent").props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "ordinary-child" },
    });
    if (source === "live") expect(state.lookupSubagent).not.toHaveBeenCalled();
    else
      expect(
        state.lookupSubagent.mock.calls.every(([, nodeId]) => nodeId === "workflow-node"),
      ).toBe(true);

    state.shells = shells.filter(
      ({ source: shell }) =>
        shell.id !== "reviewer-child" && (source !== "live" || shell.id !== "workflow-child"),
    );
    await act(async () =>
      renderer.update(
        <ThreadRelationshipsPanel
          environmentId={EnvironmentId.make("test")}
          threadId={ThreadId.make("parent")}
        />,
      ),
    );
    state.navigate.mockClear();
    if (source === "live") {
      expect(buttonWithLabel("Open workflow: Release review").props.disabled).toBe(true);
      expect(buttonWithLabel("Open workflow: Release review").props.onClick).toBeUndefined();
    }
    await act(async () => buttonWithLabel("Expand workflow").props.onClick());
    await act(async () => buttonWithLabel("Inspect: 1/1").props.onClick());
    expect(text()).toContain("Code reviewer");
    expect(buttonWithLabel("Open Code reviewer").props.disabled).toBe(true);
    expect(buttonWithLabel("Open Code reviewer").props.onClick).toBeUndefined();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => buttonWithLabel("Open Release writer").props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "writer-child" },
    });
  },
);

it.each(["live", "retained"])(
  "shows the coordinator's %s workflow phases while keeping its parent and unrelated agents",
  async (source) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const agent = {
      id: "original-workflow-node",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      childThreadId: "coordinator",
      title: "Native workflow",
      prompt: "await workflow.run();",
      model: "claude-opus-4-6",
      status: "running",
      result: null,
      startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      workflow: {
        name: "Release review",
        phases: [{ index: 1, title: "Inspect" }],
        agents: [
          {
            index: 0,
            label: "Code reviewer",
            state: "running",
            phaseIndex: 1,
            childThreadId: "member",
          },
        ],
      },
    };
    const coordinator = {
      id: "coordinator",
      title: "Workflow thread",
      lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
      forkedFrom: { type: "node", nodeId: "original-workflow-node" },
      activeProviderThreadId: null,
    };
    state.projection = {
      thread: coordinator,
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
      subagents: [
        {
          ...agent,
          id: "member-node",
          childThreadId: "member",
          title: "Code reviewer",
          workflow: undefined,
        },
        {
          ...agent,
          id: "ordinary-node",
          childThreadId: "ordinary",
          title: "Extra helper",
          workflow: undefined,
        },
      ],
    };
    state.shells = [
      coordinator,
      {
        id: "parent",
        title: "Parent conversation",
        lineage: { parentThreadId: null, relationshipToParent: null },
      },
      {
        id: "member",
        title: "Code reviewer",
        status: "running",
        lineage: { parentThreadId: "coordinator", relationshipToParent: "subagent" },
      },
      {
        id: "ordinary",
        title: "Extra helper",
        status: "running",
        lineage: { parentThreadId: "coordinator", relationshipToParent: "subagent" },
      },
    ].map((entry) => ({ environmentId: "test", source: entry }));
    if (source === "live") state.projections.set("parent", { subagents: [agent] });
    state.owningAgents.set("parent:original-workflow-node", agent);
    await act(async () => {
      renderer = create(
        <ThreadRelationshipsPanel
          environmentId={EnvironmentId.make("test")}
          threadId={ThreadId.make("coordinator")}
        />,
      );
    });
    const text = (root = renderer.root) =>
      root
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join(" ");
    expect(text()).toContain("Parent conversation");
    expect(text()).toContain("Release review");
    expect(text()).toContain("Extra helper");
    expect(text()).toContain("Lineage · 2 running");
    expect(text()).not.toContain("Code reviewer");
    const parentButton = renderer.root
      .findAllByType("button")
      .find((button) => text(button).includes("Parent conversation"))!;
    await act(async () => parentButton.props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "parent" },
    });
    const expand = renderer.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Expand workflow")!;
    await act(async () => expand.props.onClick());
    expect(text()).toContain("Inspect");
    const members = renderer.root
      .findAllByType("button")
      .filter((button) => text(button).includes("Code reviewer"));
    expect(members).toHaveLength(1);
    await act(async () => members[0]!.props.onClick());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "test", threadId: "member" },
    });
    if (source === "live") expect(state.lookupSubagent).not.toHaveBeenCalled();
    else
      expect(state.lookupSubagent).toHaveBeenCalledWith(
        { environmentId: "test", threadId: "parent" },
        "original-workflow-node",
      );
  },
);

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
  expect(text()).toContain("My GPT · high");
  state.projection = {
    ...projection,
    subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
  };
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
    state.shells = [{ environmentId: "test", source: { ...child } }];
    await act(async () => renderer.update(cloneElement(panel)));
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
    state.shells = [{ environmentId: "test", source: { ...child } }];
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text(true)).toContain("My GPT · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    expect(text()).toContain(`My GPT · ${iconLabel}high`);
    if (!iconLabel) expect(text()).not.toContain("mode on");
    child.modelSelection.options = child.modelSelection.options.filter(
      ({ id }) => id !== "reasoningEffort",
    );
    state.shells = [{ environmentId: "test", source: { ...child } }];
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).not.toContain(" · high");
    expect(text(true)).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex/);
    if (iconLabel) expect(text()).toContain(iconLabel);
    else expect(text()).not.toContain("mode on");
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
    state.projection = projection;
    for (const modelSelection of [
      { ...child.modelSelection, instanceId: "other" },
      { ...child.modelSelection, model: "gpt-5.5" },
    ]) {
      state.shells = [{ environmentId: "test", source: { ...child, modelSelection } }];
      await act(async () => renderer.update(cloneElement(panel)));
      expect(text()).not.toMatch(/Fast|Ultrafast|Normal|Standard|Flex| · high/);
    }
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
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text(true)).toContain("My GPT · Work account · high");
  expect(text()).toContain("My GPT · Work account · Fast mode onhigh");
  expect(text()).not.toContain("Personal account");
  state.configs.set("test", speedConfig);
  child.modelSelection.options = [{ id: "reasoningEffort", value: "high" }];
  state.shells = [
    {
      environmentId: "test",
      source: { ...child, modelSelection: { ...child.modelSelection, instanceId: "other" } },
    },
  ];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).not.toContain("My GPT ·");
  const config = state.configs.get("test");
  state.configs.clear();
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4");
  expect(text()).not.toContain("GPT-5.4 ·");
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("GPT-5.4 · high");
  state.configs.set("test", config);
  for (const model of ["custom/model-v1", "custom/model-v2"]) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], model }],
    };
    state.shells = [
      {
        environmentId: "test",
        source: { ...child, modelSelection: { ...child.modelSelection, model: "custom/model-v1" } },
      },
    ];
    await act(async () => renderer.update(cloneElement(panel)));
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
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Worktree");
  expect(text()).toContain("checker");
  expect(text()).not.toContain("/main/worktrees");
  expect(text()).not.toContain("Project");

  child.branch = "fix/checker";
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("Branch");
  expect(text()).toContain("fix/checker");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("/main/worktrees");

  child.projectId = "other";
  child.worktreePath = null;
  child.branch = null;
  state.shells = [{ environmentId: "test", source: { ...child } }];
  await act(async () => renderer.update(cloneElement(panel)));
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

it.each(["parent", "coordinator"])(
  "shows workflow follow-up status from the %s lineage",
  async (currentThreadId) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const agent = {
      id: "workflow-node",
      driver: "claudeAgent",
      providerInstanceId: "claude",
      childThreadId: "coordinator",
      title: "Review workflow",
      prompt: "original script",
      model: "claude-opus-4-6",
      status: "completed",
      result: "Old result",
      startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
      completedAt: DateTime.makeUnsafe("2026-09-16T12:03:00Z"),
      updatedAt: DateTime.makeUnsafe("2026-09-16T12:03:00Z"),
      workflow: { name: "Release review", phases: [], agents: [] },
    };
    const parent = {
      id: "parent",
      title: "Parent",
      status: "completed",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
    };
    const coordinator = {
      id: "coordinator",
      title: "Workflow thread",
      status: "completed",
      activeProviderThreadId: null,
      lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
      forkedFrom: { type: "node", nodeId: agent.id },
    };
    const project = (thread: typeof parent | typeof coordinator, subagents: (typeof agent)[]) => ({
      thread,
      subagents,
      runs: [],
      providerThreads: [],
      providerSessions: [],
      contextTransfers: [],
    });
    state.projection =
      currentThreadId === "parent" ? project(parent, [agent]) : project(coordinator, []);
    state.projections.set("parent", project(parent, [agent]));
    state.owningAgents.set("parent:workflow-node", agent);
    const panel = (
      <ThreadRelationshipsPanel
        environmentId={EnvironmentId.make("test")}
        threadId={ThreadId.make(currentThreadId)}
      />
    );
    let mounted = false;
    for (const status of ["running", "waiting", null]) {
      state.shells = [
        parent,
        {
          ...coordinator,
          activityRunStatus: status,
          activityRunStartedAt: status ? DateTime.makeUnsafe("2026-09-16T12:05:00Z") : null,
        },
      ].map((source) => ({ environmentId: "test", source }));
      await act(async () => {
        if (mounted) renderer.update(cloneElement(panel));
        else {
          renderer = create(panel);
          mounted = true;
        }
      });
      if (currentThreadId === "parent" && status === null) {
        const previousAgents = renderer.root
          .findAllByType("button")
          .find((button) =>
            button
              .findAll((node) => typeof node.type === "string")
              .some((node) => node.children.includes("Previous agents")),
          )!;
        await act(async () => previousAgents.props.onClick());
      }
      const card = renderer.root.findByProps({ "aria-label": "Workflow: Release review" });
      const text = card
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join(" ");
      expect(text).toContain(
        status === "running" ? "Running" : status === "waiting" ? "Waiting" : "Completed",
      );
      if (status) {
        expect(text).not.toContain("Completed");
        expect(text).not.toContain("3m 00s");
      } else expect(text).toContain("3m 00s");
    }
  },
);
