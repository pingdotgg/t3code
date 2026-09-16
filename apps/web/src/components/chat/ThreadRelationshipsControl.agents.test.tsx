import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  navigate: vi.fn(),
  shells: [] as unknown[],
  projects: [] as unknown[],
  configs: new Map<string, unknown>(),
  showTooltips: false,
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
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
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
  expect(text()).toContain("Previous agents (1)");
  expect(text()).not.toContain("Checker");
  await act(async () =>
    renderer.root.findByProps({ type: "button", "aria-expanded": false }).props.onClick(),
  );
  expect(text()).toContain("Checker");
  expect(text()).toContain("2m 15s");
  expect(text()).not.toContain("(1)");
  expect(text()).toContain("completed");
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
        models: [{ slug: "gpt-5.4", name: "My GPT model", shortName: "My GPT" }],
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
  const text = () =>
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ");
  expect(text()).toContain("My GPT");
  expect(text()).not.toContain("Tokens");
  expect(text()).not.toContain("Open subagent");
  expect(text()).not.toContain("Project");
  expect(text()).not.toContain("Worktree");
  expect(text()).not.toContain("Workspace");

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
    ["codex", null, "Unknown"],
  ] as const) {
    state.projection = {
      ...projection,
      subagents: [{ ...projection.subagents[0], driver, model }],
    };
    await act(async () => renderer.update(cloneElement(panel)));
    expect(text()).toContain(expected);
  }
});
