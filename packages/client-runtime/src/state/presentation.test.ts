import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
  OFFLINE_ENVIRONMENT_GRACE_MS,
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
function config(cwd = "/workspace"): ServerConfig {
  return {
    cwd,
    environment: { capabilities: {}, platform: { machine: "desktop" } },
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
  it("tracks loaded configs across environments, config loss and removal", () => {
    const h = harness();
    const stop = h.registry.subscribe(h.pullRequestsSupportedAtom, () => {});
    try {
      h.registry.set(h.configs(FIRST), null);
      h.registry.set(h.configs(SECOND), null);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.configs(FIRST), config());
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config());
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
      h.registry.set(h.configs(SECOND), null);
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

describe("offline environments", () => {
  it("lists an environment once it stays disconnected past the grace period", () => {
    vi.useFakeTimers();
    const h = harness();
    const stop = h.registry.subscribe(h.offlineEnvironmentIdsAtom, () => {});
    const offlineAfter = (phase: "connected" | "connecting" | "backoff" | "blocked") => {
      h.registry.set(
        h.state,
        AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase, attempt: 1 }),
      );
      return h.registry.get(h.offlineEnvironmentIdsAtom);
    };
    try {
      expect(offlineAfter("connected")).toEqual([]);
      expect(offlineAfter("backoff")).toEqual([]);
      vi.advanceTimersByTime(OFFLINE_ENVIRONMENT_GRACE_MS - 1);
      expect(h.registry.get(h.offlineEnvironmentIdsAtom)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(h.registry.get(h.offlineEnvironmentIdsAtom)).toEqual([FIRST, SECOND]);
      // A retry does not restart the grace period; only a connection does.
      expect(offlineAfter("connecting")).toEqual([FIRST, SECOND]);
      expect(offlineAfter("connected")).toEqual([]);
      expect(offlineAfter("backoff")).toEqual([]);
      // Retrying cannot fix a blocked connection, so it is offline at once.
      expect(offlineAfter("blocked")).toEqual([FIRST, SECOND]);
    } finally {
      stop();
      h.registry.dispose();
      vi.useRealTimers();
    }
  });
});

describe("presentations with providers", () => {
  it("leaves out disabled connections until they are re-enabled", () => {
    const h = harness();
    const atom = h.full.presentationsWithProvidersAtom;
    const withSecond = (enabled: boolean): EnvironmentCatalogState => ({
      isReady: true,
      entries: new Map([
        [FIRST, entry(FIRST)],
        [SECOND, { ...entry(SECOND), enabled }],
      ]),
    });
    const stop = h.registry.subscribe(atom, () => {});
    try {
      h.registry.set(h.configs(SECOND), config("/second"));
      h.registry.set(h.catalog, withSecond(false));
      expect([...h.registry.get(atom).keys()]).toEqual([FIRST]);
      expect(h.registry.get(h.full.presentationsAtom).has(SECOND)).toBe(true);
      h.registry.set(h.catalog, withSecond(true));
      expect([...h.registry.get(atom).keys()]).toEqual([FIRST, SECOND]);
      expect(h.registry.get(atom).get(SECOND)?.serverConfig?.cwd).toBe("/second");
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("leaves out unsupported environments", () => {
    const h = harness();
    const atom = h.full.presentationsWithProvidersAtom;
    const stop = h.registry.subscribe(atom, () => {});
    try {
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map<EnvironmentId, ConnectionCatalogEntry>([
          [FIRST, entry(FIRST)],
          [SECOND, { ...entry(SECOND), unsupportedReason: "Server is too old." }],
        ]),
      });
      expect([...h.registry.get(atom).keys()]).toEqual([FIRST]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("follows refused routes when nothing else about the connection changes", () => {
    const h = harness();
    const atom = h.full.presentationsWithProvidersAtom;
    const stop = h.registry.subscribe(atom, () => {});
    try {
      h.registry.set(h.state, AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE }));
      expect(h.registry.get(atom).get(FIRST)?.refusedRouteIds).toEqual([]);
      h.registry.set(
        h.state,
        AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, refusedRouteIds: ["direct"] }),
      );
      expect(h.registry.get(atom).get(FIRST)?.refusedRouteIds).toEqual(["direct"]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});

describe("connection presentation", () => {
  it("presents an enabled environment as connecting until its supervisor reports", () => {
    const h = harness();
    const phase = () => h.registry.get(h.full.presentationAtom(FIRST))?.connection.phase;
    const stop = h.registry.subscribe(h.full.presentationAtom(FIRST), () => {});
    try {
      expect(phase()).toBe("connecting");
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([[FIRST, { ...entry(FIRST), enabled: false }]]),
      });
      expect(phase()).toBe("available");
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[FIRST, entry(FIRST)]]) });
      h.registry.set(h.state, AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE }));
      expect(phase()).toBe("available");
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
