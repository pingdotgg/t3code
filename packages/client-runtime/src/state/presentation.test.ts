import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  BearerConnectionTarget,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "./presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

const FIRST = EnvironmentId.make("first");
const SECOND = EnvironmentId.make("second");
function entry(environmentId: EnvironmentId, label = environmentId as string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
}
function config(pullRequests = false, cwd = "/workspace"): ServerConfig {
  return {
    cwd,
    environment: { capabilities: { pullRequests }, platform: { machine: "desktop" } },
  } as ServerConfig;
}
function harness() {
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [FIRST, entry(FIRST)],
      [SECOND, entry(SECOND)],
    ]),
  });
  const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(config()));
  const state = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  const full = createEnvironmentPresentationAtoms({
    catalogValueAtom: catalog,
    stateAtom: () => state,
    serverConfigValueAtom: configs,
  });
  const summaries = createEnvironmentSummaryAtoms({
    catalogValueAtom: catalog,
    presentationAtom: full.presentationAtom,
  });
  return { catalog, configs, state, full, ...summaries, registry: AtomRegistry.make() };
}

describe("environment summary subscriptions", () => {
  it("renames a Connect host while leaving a manual alias and its subscribers unchanged", () => {
    const h = harness();
    const manualTarget = new BearerConnectionTarget({
      environmentId: SECOND,
      label: "My alias",
      connectionId: "manual",
    });
    const relayTarget = new RelayConnectionTarget({ environmentId: SECOND, label: "Catalog host" });
    h.registry.set(h.catalog, {
      isReady: true,
      entries: new Map<EnvironmentId, ConnectionCatalogEntry>([
        [
          FIRST,
          {
            ...entry(FIRST),
            target: new RelayConnectionTarget({ environmentId: FIRST, label: "Studio" }),
          },
        ],
        [
          SECOND,
          {
            ...entry(SECOND),
            target: manualTarget,
            alternateRoutes: [
              { target: manualTarget, profile: Option.none() },
              { target: relayTarget, profile: Option.none() },
            ],
          },
        ],
      ]),
    });
    const manualAtom = Atom.make((get) =>
      get(h.environmentsAtom).find((environment) => environment.environmentId === SECOND),
    );
    const manual = h.registry.get(manualAtom);
    let manualChanges = 0;
    const stop = h.registry.subscribe(manualAtom, () => manualChanges++);
    try {
      h.registry.set(h.configs(SECOND), {
        ...config(),
        environment: { ...config().environment, label: "Different shared name" },
      });
      expect(h.registry.get(manualAtom)).toBe(manual);
      expect(h.registry.get(h.identitiesAtom)[1]?.label).toBe("My alias");
      for (const label of ["Studio Mac", "Detected Mac"]) {
        h.registry.set(h.configs(FIRST), {
          ...config(),
          environment: { ...config().environment, label },
        });
        expect(
          h.registry
            .get(h.environmentsAtom)
            .find((environment) => environment.environmentId === FIRST)?.environmentLabel,
        ).toBe(label);
        expect(h.registry.get(h.identitiesAtom)[0]?.label).toBe(label);
        expect(h.registry.get(manualAtom)).toBe(manual);
      }
      expect(manualChanges).toBe(0);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
  it("updates labels from the live descriptor while keeping unrelated subscribers stable", () => {
    const h = harness();
    const initialIds = h.registry.get(h.environmentIdsAtom);
    const initialConnected = h.registry.get(h.connectedEnvironmentIdsAtom);
    const initialMachines = h.registry.get(h.machineByIdAtom);
    const counts = { labels: 0, connections: 0, ids: 0, connected: 0, machines: 0 };
    const stops = [
      h.registry.subscribe(h.identitiesAtom, () => counts.labels++),
      h.registry.subscribe(h.environmentsAtom, () => counts.connections++),
      h.registry.subscribe(h.environmentIdsAtom, () => counts.ids++),
      h.registry.subscribe(h.connectedEnvironmentIdsAtom, () => counts.connected++),
      h.registry.subscribe(h.machineByIdAtom, () => counts.machines++),
    ];
    try {
      const previous = config();
      h.registry.set(h.configs(FIRST), {
        ...previous,
        environment: { ...previous.environment, label: "Studio Mac" },
      });
      expect(h.registry.get(h.identitiesAtom)[0]?.label).toBe("Studio Mac");
      expect(h.registry.get(h.environmentsAtom)[0]?.environmentLabel).toBe("Studio Mac");
      expect(h.registry.get(h.environmentIdsAtom)).toBe(initialIds);
      expect(h.registry.get(h.connectedEnvironmentIdsAtom)).toBe(initialConnected);
      expect(h.registry.get(h.machineByIdAtom)).toBe(initialMachines);
      expect(counts).toEqual({ labels: 1, connections: 1, ids: 0, connected: 0, machines: 0 });

      // Clearing the override publishes the server's detected name.
      h.registry.set(h.configs(FIRST), {
        ...previous,
        environment: { ...previous.environment, label: "Detected Mac" },
      });
      expect(h.registry.get(h.identitiesAtom)[0]?.label).toBe("Detected Mac");
      expect(h.registry.get(h.environmentsAtom)[0]?.environmentLabel).toBe("Detected Mac");
      h.registry.set(h.configs(FIRST), null);
      expect(h.registry.get(h.identitiesAtom)[0]?.label).toBe("first");
      expect(h.registry.get(h.environmentsAtom)[0]?.environmentLabel).toBe("first");
    } finally {
      stops.forEach((stop) => stop());
      h.registry.dispose();
    }
  });

  it("tracks capabilities across environments, config loss and removal", () => {
    const h = harness();
    const stop = h.registry.subscribe(h.pullRequestsSupportedAtom, () => {});
    try {
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.configs(FIRST), config(true));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(true));
      h.registry.set(h.configs(FIRST), null);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[FIRST, entry(FIRST)]]) });
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([FIRST]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([{ environmentId: FIRST, label: "first" }]);
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([
          [SECOND, entry(SECOND)],
          [FIRST, entry(FIRST)],
        ]),
      });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([SECOND, FIRST]);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(false));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([]);
      expect(h.registry.get(h.environmentsAtom)).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
