import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { createExtensionHost, type ExtensionHost } from "@t3tools/extension-sdk/host";
import { ExtensionSurface, type SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AgentsPanel } from "../../components/AgentsPanel";
import { agentFixture, agentsFixture } from "./fixtures";
import { createAgentsExtension, type AgentsBindings } from "./index";

const scripts = vi.hoisted(() => ({
  values: new Map<string, { _tag: string; value?: { contents: string; truncated: boolean } }>(),
  listeners: new Map<string, Set<() => void>>(),
  loading: { _tag: "Initial" },
  requests: vi.fn(),
}));

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    workflowScript: (request: {
      environmentId: string;
      input: { threadId: string; scriptPath: string };
    }) => {
      scripts.requests(request);
      return `${request.environmentId}/${request.input.threadId}/${request.input.scriptPath}`;
    },
  },
}));

vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (key: string) =>
      useSyncExternalStore(
        (listener) => {
          const listeners = scripts.listeners.get(key) ?? new Set<() => void>();
          scripts.listeners.set(key, listeners);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        () => scripts.values.get(key) ?? scripts.loading,
      ),
  };
});

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, onClick, "aria-label": label }: ComponentProps<"button">) => (
    <button onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
}));

const BindingsContext = createContext<AgentsBindings>(agentsFixture());
const trees: ReactTestRenderer[] = [];
const hosts: ExtensionHost<SurfaceRenderer>[] = [];

function record(threadId = "thread-a", client = "web"): ViewRecord {
  return {
    version: 1,
    surfaceId: "t3.agents/view",
    context: {
      resource: {
        namespace: "t3.agents",
        id: "roster",
        environmentId: "environment-a",
        projectId: "project-a",
        threadId,
      },
      client,
    },
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Agents unavailable",
  };
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join(" ");
}

async function click(tree: ReactTestRenderer, label: string) {
  const button = tree.root
    .findAllByType("button")
    .find(
      (candidate) => candidate.props["aria-label"] === label || text(candidate).includes(label),
    );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.props.onClick());
}

async function mount(extension: boolean, initial = agentsFixture()) {
  const host = createExtensionHost<SurfaceRenderer>({ authorize: () => false });
  hosts.push(host);
  const useBindings = vi.fn(() => useContext(BindingsContext));
  host.register(createAgentsExtension(useBindings));
  const id = await host.open(record());
  expect(useBindings).not.toHaveBeenCalled();
  const render = (bindings: AgentsBindings) =>
    extension ? (
      <BindingsContext value={bindings}>
        <ExtensionSurface host={host} viewId={id} style={{ height: "100%", minHeight: 0 }} />
      </BindingsContext>
    ) : (
      <AgentsPanel {...bindings} />
    );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render(initial));
  });
  trees.push(tree);
  return {
    tree,
    host,
    id,
    update: async (bindings: AgentsBindings) => {
      await act(async () => tree.update(render(bindings)));
    },
  };
}

async function publishScript(
  key: string,
  value: { _tag: string; value?: { contents: string; truncated: boolean } },
) {
  await act(async () => {
    scripts.values.set(key, value);
    scripts.listeners.get(key)?.forEach((listener) => listener());
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T10:01:00.000Z"));
  scripts.values.clear();
  scripts.listeners.clear();
  scripts.requests.mockClear();
});

afterEach(async () => {
  for (const tree of trees.splice(0)) await act(async () => tree.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect([...scripts.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("registered native Agents renderer", () => {
  it("matches built-in status, hierarchy, expansion, script and live-update journeys", async () => {
    const builtin = await mount(false);
    const extension = await mount(true);
    const compare = () => expect(text(extension.tree.root)).toBe(text(builtin.tree.root));
    compare();
    expect(text(extension.tree.root)).toContain("Reading source");
    expect(text(extension.tree.root)).toContain("Fixture failure");
    expect(text(extension.tree.root)).toContain("Idle · resumable");
    expect(text(extension.tree.root)).toContain("Stopped");
    for (const label of [
      "Investigate",
      "Investigate",
      "Verify",
      "Collapse workflow",
      "Review workflow",
      "script",
    ]) {
      await click(builtin.tree, label);
      await click(extension.tree, label);
      compare();
    }
    expect(text(extension.tree.root)).toContain("Loading…");
    expect(scripts.requests).toHaveBeenLastCalledWith({
      environmentId: "environment-a",
      input: { threadId: "thread-a", scriptPath: ".t3/workflows/review.ts" },
    });
    const key = "environment-a/thread-a/.t3/workflows/review.ts";
    await publishScript(key, { _tag: "Failure" });
    compare();
    expect(text(extension.tree.root)).toContain("Could not load the script.");
    await publishScript(key, {
      _tag: "Success",
      value: { contents: "fixture script", truncated: true },
    });
    compare();
    expect(text(extension.tree.root)).toContain("fixture script");
    expect(text(extension.tree.root)).toContain("… (truncated)");
    await click(builtin.tree, "Close script");
    await click(extension.tree, "Close script");
    compare();
    const bindings = agentsFixture();
    const settled = {
      ...bindings,
      model: {
        ...bindings.model,
        workflows: bindings.model.workflows.map((group) => ({
          ...group,
          workflow: { ...group.workflow, status: "completed" as const },
        })),
      },
    };
    await builtin.update(settled);
    await extension.update(settled);
    compare();
    expect(
      extension.tree.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Collapse workflow"),
    ).toBe(true);
  });

  it("renders empty and large rosters through the same native composition", async () => {
    const bindings = { ...agentsFixture(), model: emptyAgentPanelModel() };
    const builtin = await mount(false, bindings);
    const extension = await mount(true, bindings);
    expect(text(extension.tree.root)).toBe(text(builtin.tree.root));
    expect(text(extension.tree.root)).toContain("No agents yet");
    const large = {
      ...bindings,
      model: deriveAgentPanelModel({
        agents: Array.from({ length: 100 }, (_, index) =>
          agentFixture({
            id: `agent-${index}`,
            title: `Reviewer ${index}`,
            status: "completed",
          }),
        ),
      }),
    };
    await builtin.update(large);
    await extension.update(large);
    expect(text(extension.tree.root)).toBe(text(builtin.tree.root));
    expect(text(extension.tree.root)).toContain("Reviewer 99");
    expect(extension.tree.root.findAllByType("button")).toHaveLength(0);
  });

  it("retains local expansion on hide/show and cleans script listeners and timers on close", async () => {
    const { tree, host, id } = await mount(true);
    await click(tree, "script");
    await click(tree, "Investigate");
    const before = text(tree.root);
    const timers = vi.getTimerCount();
    await act(async () => host.hide(id));
    expect(tree.root.findAllByType("div")[0]!.props.style.display).toBe("none");
    expect(vi.getTimerCount()).toBe(timers);
    await act(async () => host.show(id));
    expect(text(tree.root)).toBe(before);
    await act(async () => host.close(id));
    expect(vi.getTimerCount()).toBe(0);
    expect([...scripts.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await act(async () => tree.unmount());
    expect(host.diagnostics().listeners).toBe(0);
  });

  it("resets presentation on scoped context replacement and ignores old script fixture updates", async () => {
    const mounted = await mount(true);
    await click(mounted.tree, "script");
    const oldKey = "environment-a/thread-a/.t3/workflows/review.ts";
    await act(async () => {
      await mounted.host.updateContext(mounted.id, record("thread-b").context);
    });
    await mounted.update({ ...agentsFixture(), threadId: ThreadId.make("thread-b") });
    expect(scripts.listeners.get(oldKey)?.size).toBe(0);
    await click(mounted.tree, "script");
    await publishScript(oldKey, {
      _tag: "Success",
      value: { contents: "STALE THREAD A", truncated: false },
    });
    expect(text(mounted.tree.root)).not.toContain("STALE THREAD A");
    await publishScript("environment-a/thread-b/.t3/workflows/review.ts", {
      _tag: "Success",
      value: { contents: "Thread B script", truncated: false },
    });
    expect(text(mounted.tree.root)).toContain("Thread B script");
    await mounted.update({
      ...agentsFixture(),
      environmentId: EnvironmentId.make("environment-b"),
      threadId: ThreadId.make("thread-b"),
    });
    expect(text(mounted.tree.root)).not.toContain("Thread B script");
  });

  it("closes one shared-resource viewer independently, then disables and reopens the other", async () => {
    const first = await mount(true);
    const secondId = await first.host.open(record());
    expect(first.host.renderer(first.id)).toBe(first.host.renderer(secondId));
    const bindings = agentsFixture();
    let secondTree!: ReactTestRenderer;
    await act(async () => {
      secondTree = create(
        <BindingsContext value={bindings}>
          <ExtensionSurface host={first.host} viewId={secondId} />
        </BindingsContext>,
      );
    });
    trees.push(secondTree);
    await click(first.tree, "script");
    await click(secondTree, "script");
    const key = "environment-a/thread-a/.t3/workflows/review.ts";
    expect(scripts.listeners.get(key)?.size).toBe(2);
    await act(async () => first.host.close(first.id));
    expect(scripts.listeners.get(key)?.size).toBe(1);
    expect(text(secondTree.root)).toContain("Reading source");
    await act(async () => first.host.disable("t3.agents"));
    expect(secondTree.root.findAllByType(AgentsPanel)).toHaveLength(0);
    expect(scripts.listeners.get(key)?.size).toBe(0);
    expect(first.host.diagnostics().pendingCalls).toBe(0);
    await act(async () => {
      first.host.enable("t3.agents");
      await first.host.show(secondId);
    });
    expect(text(secondTree.root)).toContain("Reading source");
    expect(text(secondTree.root)).not.toContain("Loading…");
  });

  it("updates native activity and settlement in place without remounting rows", async () => {
    const bindings = agentsFixture();
    const builtin = await mount(false, bindings);
    const extension = await mount(true, bindings);
    const title = extension.tree.root
      .findAllByType("span")
      .find((span) => span.children.length === 1 && span.children[0] === "Direct running");
    const updated = {
      ...bindings,
      model: deriveAgentPanelModel({
        agents: bindings.model.directAgents.map((agent) =>
          agent.id === "running"
            ? {
                ...agent,
                status: "completed" as const,
                result: "Finished focused review",
                completedAt: "2026-09-09T10:01:00.000Z",
              }
            : agent,
        ),
      }),
    };
    await builtin.update(updated);
    await extension.update(updated);
    expect(text(extension.tree.root)).toBe(text(builtin.tree.root));
    expect(text(extension.tree.root)).toContain("Finished focused review");
    expect(extension.tree.root.findAllByType("span")).toContain(title);
  });

  it("releases listeners and elapsed timers over repeated open/close cycles", async () => {
    const mounted = await mount(true);
    await act(async () => mounted.host.close(mounted.id));
    await act(async () => mounted.tree.unmount());
    const bindings = agentsFixture();
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const id = await mounted.host.open(record());
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(
          <BindingsContext value={bindings}>
            <ExtensionSurface host={mounted.host} viewId={id} />
          </BindingsContext>,
        );
      });
      await click(tree, "script");
      await act(async () => mounted.host.close(id));
      await act(async () => tree.unmount());
      expect(vi.getTimerCount()).toBe(0);
      expect(mounted.host.diagnostics()).toMatchObject({ views: 0, listeners: 0, pendingCalls: 0 });
      expect([...scripts.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    }
  });

  it("restores null state and gives useful fallbacks for unsupported clients and state", async () => {
    const mounted = await mount(true);
    const restored = await mounted.host.restore(record("thread-a", "desktop"));
    expect(mounted.host.snapshot(restored).status).toBe("ready");
    const mobile = await mounted.host.restore(record("thread-a", "mobile"));
    expect(mounted.host.snapshot(mobile).status).toBe("unavailable");
    const invalid = await mounted.host.restore({ ...record(), restoreState: { invented: true } });
    expect(mounted.host.snapshot(invalid).status).toBe("unavailable");
  });
});
