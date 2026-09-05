import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, Profiler, type ReactNode, type Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { findTestNode, installReactTestDom, type ReactTestNode } from "~/test/reactTestDom";

vi.mock("lucide-react", () => ({
  Bot: () => null,
  Braces: () => null,
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  X: () => null,
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    viewportRef,
  }: {
    children: ReactNode;
    viewportRef?: Ref<HTMLDivElement>;
  }) => (
    <div ref={viewportRef} data-slot="scroll-area-viewport">
      {children}
    </div>
  ),
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

import { AgentsPanel } from "./AgentsPanel";

const EMPTY_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

const ROSTER_MODEL: AgentPanelModel = { ...EMPTY_MODEL, hasAgents: true };

function viewport(container: ReactTestNode): ReactTestNode {
  const node = findTestNode(container, "data-slot", "scroll-area-viewport");
  if (node === null) throw new Error("Agents scroll viewport was not rendered");
  return node;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsPanel scroll position", () => {
  it("isolates thread positions and restores them when returning", async () => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);

    try {
      await act(() =>
        root.render(<AgentsPanel key="env:A" threadKey="env:A" model={ROSTER_MODEL} />),
      );
      const threadAViewport = viewport(container);
      threadAViewport.scrollTop = 420;
      threadAViewport.dispatchEvent(new Event("scroll"));

      await act(() =>
        root.render(<AgentsPanel key="env:B" threadKey="env:B" model={ROSTER_MODEL} />),
      );
      expect(viewport(container).scrollTop).toBe(0);

      await act(() =>
        root.render(<AgentsPanel key="env:A" threadKey="env:A" model={ROSTER_MODEL} />),
      );
      expect(viewport(container).scrollTop).toBe(420);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("isolates identical thread ids in different environments", async () => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const threadId = ThreadId.make("same-thread");
    const firstThreadKey = scopedThreadKey(scopeThreadRef(EnvironmentId.make("env-1"), threadId));
    const secondThreadKey = scopedThreadKey(scopeThreadRef(EnvironmentId.make("env-2"), threadId));

    try {
      await act(() =>
        root.render(
          <AgentsPanel key={firstThreadKey} threadKey={firstThreadKey} model={ROSTER_MODEL} />,
        ),
      );
      const firstViewport = viewport(container);
      firstViewport.scrollTop = 280;
      firstViewport.dispatchEvent(new Event("scroll"));

      await act(() =>
        root.render(
          <AgentsPanel key={secondThreadKey} threadKey={secondThreadKey} model={ROSTER_MODEL} />,
        ),
      );
      expect(viewport(container).scrollTop).toBe(0);

      await act(() =>
        root.render(
          <AgentsPanel key={firstThreadKey} threadKey={firstThreadKey} model={ROSTER_MODEL} />,
        ),
      );
      expect(viewport(container).scrollTop).toBe(280);
    } finally {
      await act(() => root.unmount());
    }
  });

  it.each([
    ["another right-panel tab", "tab"],
    ["a hidden right panel", "hidden"],
    ["the sheet layout", "sheet"],
  ])("restores after remounting from %s", async (_transition, keySuffix) => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const threadKey = `env:remount-thread-${keySuffix}`;

    try {
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      const initialViewport = viewport(container);
      initialViewport.scrollTop = 360;
      initialViewport.dispatchEvent(new Event("scroll"));

      await act(() => root.render(<div>Other panel state</div>));
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      expect(viewport(container).scrollTop).toBe(360);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("restores when an initially empty model gains its roster", async () => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const threadKey = "env:late-roster";

    try {
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      const initialViewport = viewport(container);
      initialViewport.scrollTop = 510;
      initialViewport.dispatchEvent(new Event("scroll"));

      await act(() => root.render(<div>Other thread</div>));
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={EMPTY_MODEL} />),
      );
      expect(findTestNode(container, "data-slot", "scroll-area-viewport")).toBeNull();

      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      expect(viewport(container).scrollTop).toBe(510);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("preserves an offset clamped by a smaller remounted viewport", async () => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const threadKey = "env:clamped-remount";

    try {
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      const initialViewport = viewport(container);
      initialViewport.scrollTop = 510;
      initialViewport.dispatchEvent(new Event("scroll"));

      await act(() => root.render(<div>Other panel state</div>));
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      const constrainedViewport = viewport(container);
      constrainedViewport.scrollHeight = 700;
      constrainedViewport.clientHeight = 300;
      constrainedViewport.scrollTop = 399.5;

      await act(() => root.render(<div>Original layout</div>));
      await act(() =>
        root.render(<AgentsPanel key={threadKey} threadKey={threadKey} model={ROSTER_MODEL} />),
      );
      expect(viewport(container).scrollTop).toBe(510);
    } finally {
      await act(() => root.unmount());
    }
  });

  it("does not rerender when capturing scroll", async () => {
    const document = installReactTestDom();
    const container = document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const onRender = vi.fn();

    try {
      await act(() =>
        root.render(
          <Profiler id="agents" onRender={onRender}>
            <AgentsPanel threadKey="env:no-rerender" model={ROSTER_MODEL} />
          </Profiler>,
        ),
      );
      const renderCount = onRender.mock.calls.length;
      const agentsViewport = viewport(container);
      agentsViewport.scrollTop = 170;
      agentsViewport.dispatchEvent(new Event("scroll"));

      expect(onRender).toHaveBeenCalledTimes(renderCount);
    } finally {
      await act(() => root.unmount());
    }
  });
});
