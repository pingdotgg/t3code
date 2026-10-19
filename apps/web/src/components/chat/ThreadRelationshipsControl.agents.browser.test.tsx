import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ModelSelection,
  type ScopedThreadRef,
  type ProviderOptionDescriptor,
  type OrchestrationV2ContextTransfer,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import "~/index.css";

const state = vi.hoisted(() => ({
  stopWorkflowLabel: "environment-data:orchestration:stop-workflow",
  projection: null as unknown,
  projections: null as Map<string, unknown> | null,
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
  command: vi.fn().mockResolvedValue({ _tag: "Success" }),
  workflowCommand: vi.fn().mockResolvedValue({ _tag: "Success" }),
  toast: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: ((ref: ScopedThreadRef | null) =>
    ref === null
      ? undefined
      : {
          projection: state.projections
            ? state.projections.get(scopedThreadKey(ref))
            : state.projection,
        }) as never,
  useThreadRelationshipShells: ((ref: { readonly environmentId: string }) =>
    (state.shells as ReadonlyArray<{ readonly environmentId: string; readonly source: unknown }>)
      .filter((shell) => shell.environmentId === ref.environmentId)
      .map((shell) => shell.source)) as never,
  useProjects: (() => state.projects) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() =>
    new Map(
      [...state.configs].map(([id, config]) => [id, (config as { providers: unknown }).providers]),
    )) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    command.label === state.stopWorkflowLabel ? state.workflowCommand : state.command) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } as never };
});
vi.mock(import("../../state/orchestration"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  const stopWorkflow = actual.orchestrationEnvironment.stopWorkflow;
  return {
    ...actual,
    orchestrationEnvironment: Object.assign(Object.create(actual.orchestrationEnvironment), {
      stopWorkflow: Object.assign(Object.create(stopWorkflow), {
        label: state.stopWorkflowLabel,
        permissionAtom: () => granted,
      }),
    }),
  };
});
// Tooltip and hover card content renders inline so the suite can read every row's agent
// details across many states without hovering each row.
vi.mock(import("../ui/tooltip"), async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: (({ children }: { children: ReactNode }) => children) as never,
    TooltipTrigger: (({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, {}, children)) as never,
    TooltipPopup: (({ children }: { children: ReactNode }) =>
      state.showTooltips ? children : null) as never,
  };
});

import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

let root: Root;
let container: HTMLDivElement;
let current: ReactElement;

async function render(element: ReactElement) {
  current = element;
  await act(async () => root.render(element));
}
// The mocked hooks read `state` while rendering, so a new element picks up changes.
const update = () => act(async () => root.render(cloneElement(current)));
const click = (element: HTMLElement) => act(async () => element.click());
const buttons = () => [...container.querySelectorAll("button")];
const allByLabel = (label: string) =>
  buttons().filter((button) => button.getAttribute("aria-label") === label);
function byLabel(label: string) {
  const matches = allByLabel(label);
  if (matches.length !== 1)
    throw new Error(`Expected one "${label}" button, got ${matches.length}`);
  return matches[0]!;
}
const sectionToggles = (expanded: boolean) =>
  buttons().filter(
    (button) =>
      button.getAttribute("aria-expanded") === String(expanded) &&
      !button.hasAttribute("aria-label"),
  );
function sectionToggle(expanded: boolean) {
  const [toggle] = sectionToggles(expanded);
  if (!toggle) throw new Error(`No ${expanded ? "expanded" : "collapsed"} section toggle`);
  return toggle;
}
const heading = () => container.querySelector("h3")?.textContent;
const buttonsWithLabel = (matches: (label: string) => boolean) =>
  buttons().filter((button) => matches(button.getAttribute("aria-label") ?? ""));
// Joins rendered text nodes; `visibleOnly` drops screen-reader-only text.
function textNodes(separator: string, visibleOnly = false) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (visibleOnly && node.parentElement?.closest(".sr-only")) continue;
    parts.push(node.textContent ?? "");
  }
  return parts.join(separator);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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
  state.projections = null;
});

it("stops the entire native workflow through its parent without changing state before acknowledgement", async () => {
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
  await render(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />,
  );
  await click(byLabel("Expand Checkout review"));
  const stopButton = () => byLabel("Stop workflow Checkout review");
  expect(buttonsWithLabel((label) => label.startsWith("Stop "))).toHaveLength(2);
  let acknowledge!: (result: { _tag: string }) => void;
  state.workflowCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  await click(stopButton());
  expect(state.workflowCommand).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote",
    input: { threadId: "parent", subagentId: "workflow" },
  });
  expect(state.command).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(stopButton().disabled).toBe(true);
  expect(byLabel("Stop subagent Worker").disabled).toBe(true);
  expect(byLabel("Open Checker chat")).toBeDefined();
  expect(heading()).toBe("Lineage · 2 running");
  await act(async () => {
    acknowledge({ _tag: "Success" });
  });
  expect(stopButton().disabled).toBe(false);
  expect(heading()).toBe("Lineage · 2 running");
  state.workflowCommand.mockResolvedValueOnce({ _tag: "Failure" });
  await click(stopButton());
  expect(state.toast).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Could not stop workflow",
  });
  expect(stopButton().disabled).toBe(false);
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
  await render(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("remote")}
      threadId={ThreadId.make("parent")}
    />,
  );
  const previousAgents = sectionToggles(false);
  if (previousAgents.length > 0) await click(previousAgents[0]!);
  expect(byLabel("Expand Checkout review")).toBeDefined();
  expect(allByLabel("Stop workflow Checkout review")).toHaveLength(0);
  expect(state.workflowCommand).not.toHaveBeenCalled();
});

it("opens the correct chat for every workflow phase and unphased member", async () => {
  state.showTooltips = true;
  state.configs.set("remote", {
    providers: [
      {
        instanceId: "claude-personal",
        driver: "claudeAgent",
        enabled: true,
        displayName: "Personal account",
        models: [],
      },
      {
        instanceId: "claude-work",
        driver: "claudeAgent",
        enabled: true,
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
  await render(panel);
  await click(byLabel("Expand Checkout review"));
  const memberButtons = () => buttonsWithLabel((label) => label.startsWith("Open Member"));
  const phaseButtons = () =>
    buttonsWithLabel((label) => label.includes(" phase, ")).filter((button) =>
      button.hasAttribute("aria-expanded"),
    );
  expect(memberButtons()).toHaveLength(3);
  expect(phaseButtons()).toHaveLength(3);
  expect(byLabel("Expand Inspect phase, done")).toBeDefined();
  expect(byLabel("Expand Improve phase, stopped")).toBeDefined();
  expect(byLabel("Collapse Verify phase, running")).toBeDefined();
  for (const phase of phaseButtons().slice(0, 2)) await click(phase);
  expect(memberButtons()).toHaveLength(7);
  for (const button of memberButtons()) {
    expect(button.disabled).toBe(true);
    await click(button);
  }
  expect(state.navigate).not.toHaveBeenCalled();
  state.shells = memberShells.map((source) => ({ environmentId: "remote", source }));
  await update();
  for (const button of memberButtons()) expect(button.disabled).toBe(false);
  for (const agent of agents) {
    await click(byLabel(`Open ${agent.label} chat`));
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "remote", threadId: agent.childThreadId },
    });
  }
  const rendered = textNodes("|");
  expect(rendered.match(/Sonnet · Work account/g)).toHaveLength(7);
  expect(rendered).not.toContain("Personal account");
  for (const phase of phases) expect(rendered).toContain(phase.title);
  expect(rendered).not.toContain(" phases");
  expect(rendered).toContain("1|/|2| |agents");
  expect(rendered).toContain("Running");
  expect(rendered).toContain("running");
  expect(buttonsWithLabel((label) => label.endsWith("phase, done"))).toHaveLength(1);
  expect(buttonsWithLabel((label) => label.endsWith("phase, stopped"))).toHaveLength(1);
  expect(rendered).toContain("|6s|");
  for (const phase of phaseButtons()) {
    const label = String(phase.getAttribute("aria-label")).slice("Collapse ".length);
    await click(phase);
    expect(memberButtons()).toHaveLength(5);
    await click(byLabel(`Expand ${label}`));
    expect(memberButtons()).toHaveLength(7);
  }
  await click(phaseButtons()[0]!);
  expect(memberButtons()).toHaveLength(5);
  const restarted = agents.map((agent) =>
    agent.index === 0 ? { ...agent, state: "running" } : agent,
  );
  state.projection = project(restarted);
  await update();
  expect(memberButtons()).toHaveLength(5);
  state.projection = project(agents);
  await update();
  expect(memberButtons()).toHaveLength(5);
  await click(byLabel("Collapse Checkout review"));
  expect(memberButtons()).toHaveLength(0);
  expect(state.navigate).toHaveBeenCalledTimes(7);
});

it("groups and counts a workflow by its run status instead of its coordinator chat", async () => {
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
  await render(panel);
  const text = () => textNodes("");
  expect(heading()).toBe("Lineage · 1 running");
  await click(byLabel("Expand Checkout review"));
  expect(byLabel("Open Checker chat")).toBeDefined();
  state.shells = [{ environmentId: "test", source: { ...child, activityRunStatus: "waiting" } }];
  await update();
  expect(heading()).toBe("Lineage · 1 running");
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
  await update();
  expect(heading()).toBe("Lineage");
  expect(text()).toContain("Previous agents");
  expect(allByLabel("Open Checker chat")).toHaveLength(0);
  await click(sectionToggle(false));
  expect(byLabel("Expand Checkout review")).toBeDefined();
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
    await render(panel);
    if (!canStop) {
      expect(allByLabel("Stop subagent Worker")).toHaveLength(0);
      return;
    }
    const stopButton = () => byLabel("Stop subagent Worker");
    await click(stopButton());
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
      await update();
      expect(allByLabel("Stop subagent Worker")).toHaveLength(0);
      state.projection = { ...projection, subagents: [{ ...agent, status: "completed" }] };
      await update();
      if (origin === "provider_native") {
        expect(allByLabel("Stop subagent Worker")).toHaveLength(0);
        continue;
      }
      await click(stopButton());
      expect(state.command).toHaveBeenCalledTimes(1);
      expect(state.command).toHaveBeenLastCalledWith({
        environmentId: "test",
        input: { threadId: "child" },
      });
    }
    state.shells = [{ environmentId: "test", source: child }];
    for (const status of ["completed", "failed", "interrupted"]) {
      state.projection = { ...projection, subagents: [{ ...agent, status }] };
      await update();
      expect(allByLabel("Stop subagent Worker")).toHaveLength(0);
    }
    state.projection = { ...projection, subagents: [{ ...agent, startedAt: null }] };
    await update();
    expect(allByLabel("Stop subagent Worker")).toHaveLength(0);
    state.projection = {
      ...projection,
      subagents: [{ ...agent, origin: "provider_native", driver: "codex" }],
    };
    await update();
    expect(allByLabel("Stop subagent Worker")).toHaveLength(0);
  },
);

it("shows the matching child agent details and refreshes them when the agent settles", async () => {
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
  await render(panel);
  const text = () => textNodes(" ").replace(/\s+/g, " ");
  expect(text()).toContain("Checker");
  expect(text()).toContain("Lineage · 3 running");
  expect(text()).toContain("running");
  expect(text()).not.toContain("gpt-5.4");
  expect(text()).not.toContain("gpt-5.3");
  expect(text()).not.toContain("tok");
  expect(text()).not.toContain("Unlinked agent");
  expect(text()).not.toContain("Active agents");
  expect(sectionToggles(true)).toHaveLength(0);

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
  await update();
  expect(heading()).toBe("Lineage");
  expect(text()).toContain("Previous agents (1)");
  expect(text()).not.toContain("Checker");
  await click(sectionToggle(false));
  expect(text()).toContain("Checker");
  expect(text()).toContain("Checker 2m");
  expect(text()).not.toContain("(1)");
  expect(text()).not.toContain("Done");
  expect(text()).not.toContain("running");
  expect(text()).not.toContain("Worker");
  await click(sectionToggle(true));
  expect(text()).not.toContain("Checker");
  expect(text()).toContain("Previous agents (1)");
  await click(sectionToggle(false));
  expect(text()).toContain("Checker");

  state.projection = {
    ...projection,
    subagents: Array.from({ length: 8 }, (_, index) => ({
      ...agent,
      id: `running-agent-${index}`,
      childThreadId: `running-child-${index}`,
    })),
  };
  await update();
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
  await update();
  expect(text()).toContain("1 failed");
  expect(text()).not.toContain("Old agent 7");
  await click(buttons().find((button) => button.textContent?.startsWith("Show "))!);
  expect(text()).toContain("Old agent 7");

  state.projection = {
    ...projection,
    subagents: [{ ...agent, childThreadId: null }],
  };
  await update();
  expect(text()).toContain("Lineage · 1 running");
});

it("shows readable models and only differing workspace details in agent tooltips", async () => {
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
  await render(panel);
  const text = (visibleOnly = false) => textNodes("", visibleOnly);
  const rerender = async (source = child) => {
    // Fresh objects, as real shells are: the compiled component memoizes on identity.
    state.shells = [
      {
        environmentId: "test",
        source: {
          ...source,
          modelSelection: { ...source.modelSelection, options: source.modelSelection.options },
        },
      },
    ];
    await update();
  };
  const nativeProjection = {
    ...projection,
    subagents: [{ ...projection.subagents[0], origin: "provider_native" }],
  };
  expect(text()).toContain("My GPT · high");
  state.projection = nativeProjection;
  await update();
  expect(text()).toContain("My GPT");
  expect(text()).not.toContain("My GPT · high");
  state.projection = projection;
  await update();
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
    await update();
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
    await update();
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
        enabled: true,
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
        enabled: true,
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
  await update();
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
    await update();
    if (status === "completed") {
      await click(sectionToggle(false));
    }
    expect(text()).toContain("My GPT · Work account · Ultrafast mode onlow");
    expect(text()).not.toContain(" · high");
  }
  await click(sectionToggle(true));
  state.projection = projection;
  state.configs.set("test", speedConfig);
  child.modelSelection.options = [{ id: "reasoningEffort", value: "high" }];
  await rerender({ ...child, modelSelection: { ...child.modelSelection, instanceId: "other" } });
  expect(text()).not.toContain("My GPT ·");
  const config = state.configs.get("test");
  state.configs.clear();
  await update();
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
  await update();
  expect(text()).toContain("Checking the latest changes");
  expect(text()).not.toContain("Old intermediate result");
  const result = "Final checks passed. " + "More detail. ".repeat(50) + "Hidden tail";
  state.projection = {
    ...projection,
    subagents: [
      { ...projection.subagents[0], status: "failed", progress: "Stale progress", result },
    ],
  };
  await update();
  await click(sectionToggle(false));
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
  await update();
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
    await update();
    expect(text()).toContain(expected);
  }
});

it("shows the parent's own visible status as parent and child activity change", async () => {
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
  await render(panel);
  const visibleText = () => textNodes(" ", true);
  expect(visibleText()).toContain("Parent conversation");
  expect(visibleText()).toContain("Running");
  state.shells = shells(
    { ...parent, activityRunStatus: "completed" },
    { ...child, status: "running" },
  );
  await update();
  expect(visibleText()).toContain("Done");
  expect(visibleText()).not.toContain("Running");
});

it("shows the native coordinator status from its member and gives follow-up activity precedence", async () => {
  const environmentId = EnvironmentId.make("remote");
  const coordinator = {
    id: "coordinator",
    title: "Workflow coordinator",
    status: "idle",
    creationSource: "provider",
    activeProviderThreadId: null,
    lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
  };
  const member = {
    ...coordinator,
    id: "member",
    title: "Reviewer",
    lineage: { parentThreadId: "coordinator", relationshipToParent: "subagent" },
  };
  const emptyProjection = {
    runs: [],
    nodes: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [],
  };
  const rootTurn = {
    kind: "root_turn",
    runId: null,
    status: "failed",
    startedAt: DateTime.makeUnsafe("2026-09-16T12:00:00Z"),
    completedAt: DateTime.makeUnsafe("2026-09-16T12:00:10Z"),
  };
  state.projections = new Map([
    ["remote:member", { ...emptyProjection, thread: member, nodes: [rootTurn] }],
    ["local:coordinator", { ...emptyProjection, thread: coordinator, nodes: [rootTurn] }],
  ]);
  state.shells = [coordinator, member].map((source) => ({ environmentId, source }));
  await render(
    <ThreadRelationshipsPanel environmentId={environmentId} threadId={ThreadId.make("member")} />,
  );
  const coordinatorText = () =>
    buttons().find((button) => button.textContent?.includes("Workflow coordinator"))?.textContent;
  expect(coordinatorText()).toMatch(/Workflow coordinator\s*Idle$/);

  for (const [status, label] of [
    ["running", "Running"],
    ["completed", "Done"],
  ]) {
    state.projections.set("remote:coordinator", {
      ...emptyProjection,
      thread: coordinator,
      nodes: [
        { ...rootTurn, status, completedAt: status === "running" ? null : rootTurn.completedAt },
      ],
    });
    await update();
    expect(coordinatorText()).toMatch(new RegExp(`Workflow coordinator\\s*${label}$`));
  }

  state.shells = [
    { environmentId, source: { ...coordinator, activityRunStatus: "running" } },
    { environmentId, source: member },
  ];
  await update();
  expect(coordinatorText()).toMatch(/Workflow coordinator\s*Running$/);
});

it.each(["source", "target"])(
  "shows transfer lifecycle states when viewing the %s thread",
  async (currentThreadId) => {
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
      if (status === "pending") await render(panel);
      else await update();
      const visibleText = textNodes(" ");
      expect(visibleText).toContain(
        currentThreadId === "source" ? "target conversation" : "source conversation",
      );
      expect(visibleText).toContain(label);
      expect(visibleText).not.toContain("Unknown");
      expect(visibleText).not.toContain("Running");
    }
  },
);
