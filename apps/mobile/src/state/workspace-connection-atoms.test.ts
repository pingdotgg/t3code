import { describe, expect, it } from "@effect/vitest";
import {
  PrimaryConnectionTarget,
  type EnvironmentPresentation,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellSummary } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";
import { projectWorkspaceEnvironment, projectWorkspaceState } from "./workspaceModel";

const ID = EnvironmentId.make("environment-1");
function presentation(): EnvironmentPresentation {
  return {
    entry: {
      target: new PrimaryConnectionTarget({
        environmentId: ID,
        label: "Mac",
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      }),
      enabled: true,
      profile: Option.none(),
    },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: null,
  };
}
function harness() {
  const source = Atom.make<EnvironmentPresentation | null>(presentation());
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([[ID, presentation().entry]]),
  });
  const network = Atom.make<NetworkStatus>("online");
  const atoms = createWorkspaceConnectionAtoms({
    catalogValueAtom: catalog,
    networkStatusValueAtom: network,
    presentationAtom: () => source,
  });
  const registry = AtomRegistry.make();
  return { source, catalog, network, registry, ...atoms };
}

describe("workspace connection subscriptions", () => {
  it("keeps connection consumers stable across shell and provider updates", () => {
    const h = harness();
    const shell = Atom.make<EnvironmentShellSummary>({
      hasSnapshot: true,
      hasSynchronizingShell: false,
      hasCachedShell: false,
      hasLiveShell: true,
      firstError: null,
    });
    const broadState = Atom.make((get) =>
      projectWorkspaceState({
        isReady: get(h.catalog).isReady,
        networkStatus: get(h.network),
        environments: [projectWorkspaceEnvironment(ID, get(h.source)!)],
        shellSummary: get(shell),
      }),
    );
    const initial = h.registry.get(h.stateAtom);
    const initialEnvironments = h.registry.get(h.environmentsAtom);
    let broadChanges = 0;
    let connectionChanges = 0;
    const stopBroad = h.registry.subscribe(broadState, () => broadChanges++);
    const stopNarrow = h.registry.subscribe(h.stateAtom, () => connectionChanges++);
    try {
      for (let index = 0; index < 20; index++) {
        h.registry.set(shell, {
          ...h.registry.get(shell),
          hasSynchronizingShell: index % 2 === 0,
        });
        h.registry.get(broadState);
        h.registry.get(h.stateAtom);
      }
      expect(broadChanges).toBe(20);
      expect(connectionChanges).toBe(0);
      for (let index = 0; index < 4; index++) {
        // Full config still advances for consumers such as Settings.
        const config = { cwd: `/workspace-${index}` } as ServerConfig;
        h.registry.set(h.source, { ...presentation(), serverConfig: config });
        expect(h.registry.get(h.source)?.serverConfig).toBe(config);
        expect(h.registry.get(h.stateAtom)).toBe(initial);
        expect(h.registry.get(h.environmentsAtom)).toBe(initialEnvironments);
      }
      expect(connectionChanges).toBe(0);
    } finally {
      stopBroad();
      stopNarrow();
      h.registry.dispose();
    }
  });

  it("propagates errors, offline state, disabling and reconnection", () => {
    const h = harness();
    try {
      expect(h.registry.get(h.stateAtom).connectionState).toBe("connected");
      const failed = {
        ...presentation(),
        connection: { phase: "error" as const, error: "Connection failed", traceId: "trace-1" },
      };
      h.registry.set(h.source, failed);
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        connectionState: "error",
        connectionError: "Connection failed",
        hasReadyEnvironment: false,
      });
      expect(h.registry.get(h.environmentsAtom)[0]?.connectionErrorTraceId).toBe("trace-1");
      h.registry.set(h.source, { ...failed, entry: { ...failed.entry, enabled: false } });
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        hasConnections: true,
        connectionState: "available",
        connectionError: null,
      });
      h.registry.set(h.source, {
        ...presentation(),
        connection: { phase: "reconnecting", error: null, traceId: null },
      });
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        hasConnectingEnvironment: true,
        connectionState: "reconnecting",
      });
      h.registry.set(h.source, presentation());
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        hasReadyEnvironment: true,
        hasConnectingEnvironment: false,
      });
      h.registry.set(h.network, "offline");
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        connectionState: "offline",
        hasReadyEnvironment: false,
      });
      h.registry.set(h.network, "online");
      expect(h.registry.get(h.stateAtom).connectionState).toBe("connected");
    } finally {
      h.registry.dispose();
    }
  });

  it("updates labels and endpoints, removes environments, and finishes catalog loading", () => {
    const h = harness();
    try {
      h.registry.set(h.catalog, { isReady: false, entries: new Map() });
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        isLoadingConnections: true,
        hasConnections: false,
      });
      h.registry.set(h.source, {
        ...presentation(),
        entry: {
          ...presentation().entry,
          target: new PrimaryConnectionTarget({
            environmentId: ID,
            label: "Renamed",
            httpBaseUrl: "https://new.example.test",
            wsBaseUrl: "wss://new.example.test",
          }),
        },
      });
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[ID, presentation().entry]]) });
      expect(h.registry.get(h.environmentsAtom)[0]).toMatchObject({
        environmentLabel: "Renamed",
        displayUrl: "https://new.example.test",
      });
      expect(h.registry.get(h.stateAtom).isLoadingConnections).toBe(false);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        hasConnections: false,
        connectionState: "available",
        hasReadyEnvironment: false,
      });
      expect(h.registry.get(h.environmentsAtom)).toEqual([]);
    } finally {
      h.registry.dispose();
    }
  });
});
