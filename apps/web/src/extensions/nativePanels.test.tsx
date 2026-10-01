import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { NativeRightPanel, type NativePanelBindings } from "./nativePanels";
import { registerWorkspaceExtension } from "./workspaceRegistry";
import { selectSelectedRightPanelSurface, useRightPanelStore } from "../rightPanelStore";

// Unrelated native engines are outside this generic-extension boundary regression.
vi.mock("./terminal/PersistentThreadTerminal", () => ({
  PersistentThreadTerminalDrawer: () => null,
  PersistentThreadTerminalPanel: () => null,
}));
vi.mock("../components/AgentsPanel", () => ({ AgentsPanel: () => null }));
vi.mock("../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("../components/pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => null,
}));
vi.mock("../components/pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => null,
}));
vi.mock("../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("generic extension layout ownership", () => {
  it("keeps project-scoped counter restore records in their owning threads", async () => {
    useRightPanelStore.setState({
      byThreadKey: {},
      extensionDockByThreadKey: {},
      userActionRevisionByThreadKey: {},
    });
    const a = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread-a"));
    const b = scopeThreadRef(a.environmentId, ThreadId.make("thread-b"));
    const record: ViewRecord = {
      version: 1,
      surfaceId: "community.counter/view",
      stateVersion: 1,
      placement: "side-panel",
      restoreState: 0,
      fallback: "Counter unavailable",
      context: {
        client: "web",
        resource: {
          namespace: "community.project",
          id: "counter",
          environmentId: a.environmentId,
          projectId: "shared-project",
        },
      },
    };
    const restored: unknown[] = [];
    const unregister = registerWorkspaceExtension({
      manifest: {
        id: "community.counter",
        apiVersion: 1,
        version: "1.0.0",
        surfaces: [
          {
            id: record.surfaceId,
            title: "Counter",
            placements: ["side-panel"],
            clients: ["web"],
            scope: "project",
            capabilities: [],
            stateVersion: 1,
          },
        ],
      },
      surfaces: [
        {
          id: record.surfaceId,
          validateRestore: (state) => typeof state === "number",
          createView(session) {
            const initial = session.restoreState;
            if (typeof initial !== "number") throw new Error("Invalid counter state");
            restored.push(initial);
            return {
              renderer: function Counter() {
                const [count, setCount] = useState(initial);
                return (
                  <button
                    onClick={() => {
                      setCount(count + 1);
                      session.save(count + 1);
                    }}
                  >
                    {count}
                  </button>
                );
              },
            };
          },
        },
      ],
    });
    const bindings: NativePanelBindings = {
      browser: null,
      files: null,
      terminal: null,
      versionControl: null,
      get diff(): NativePanelBindings["diff"] {
        throw new Error("Unexpected native diff access");
      },
      get agents(): NativePanelBindings["agents"] {
        throw new Error("Unexpected native agents access");
      },
    };
    const surfaceFor = (ref: ScopedThreadRef) => {
      const surface = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ref,
      );
      if (surface?.kind !== "extension") throw new Error("Missing extension surface");
      return surface;
    };
    const render = (ref: ScopedThreadRef) => (
      <NativeRightPanel
        surface={surfaceFor(ref)}
        threadRef={ref}
        context={record.context}
        visible
        bindings={bindings}
      />
    );
    let root: ReactTestRenderer | undefined;
    try {
      expect(useRightPanelStore.getState().openExtension(a, record)).toBe(true);
      expect(useRightPanelStore.getState().openExtension(b, record)).toBe(true);
      expect(surfaceFor(a).record).toEqual(surfaceFor(b).record);
      expect(surfaceFor(a).viewerGeneration).not.toBe(surfaceFor(b).viewerGeneration);
      await act(async () => {
        root = create(render(a));
      });
      await act(async () => {
        root!.root.findByType("button").props.onClick();
      });
      expect(surfaceFor(a).record.restoreState).toBe(1);
      expect(surfaceFor(b).record.restoreState).toBe(0);
      await act(async () => {
        root!.update(render(b));
      });
      expect(root!.root.findByType("button").children).toEqual(["0"]);
      await act(async () => {
        root!.root.findByType("button").props.onClick();
      });
      await act(async () => {
        root!.root.findByType("button").props.onClick();
      });
      expect(surfaceFor(a).record.restoreState).toBe(1);
      expect(surfaceFor(b).record.restoreState).toBe(2);
      await act(async () => {
        root!.update(render(a));
      });
      expect(root!.root.findByType("button").children).toEqual(["1"]);
      await act(async () => {
        root!.update(render(b));
      });
      expect(root!.root.findByType("button").children).toEqual(["2"]);
      expect(restored).toEqual([0, 0, 1, 2]);
      expect(surfaceFor(a).record.context).toEqual(record.context);
      expect(surfaceFor(b).record.context).toEqual(record.context);
    } finally {
      await act(async () => {
        root?.unmount();
        unregister();
      });
      useRightPanelStore.setState({
        byThreadKey: {},
        extensionDockByThreadKey: {},
        userActionRevisionByThreadKey: {},
      });
    }
  });
});
