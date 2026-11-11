import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import {
  createSteadyShellAtoms,
  EMPTY_STEADY_SHELLS_STATE,
  stepSteadyShells,
  type SteadyShellInput,
  type SteadyShellsState,
} from "./steadyShells.ts";

const A = EnvironmentId.make("a");
const B = EnvironmentId.make("b");
const WINDOW = 2_000;

const snapshot = (snapshotSequence: number): OrchestrationV2ShellSnapshot => ({
  ...v2ShellSnapshot,
  snapshotSequence,
});
const shell = (
  environmentId: EnvironmentId,
  value: OrchestrationV2ShellSnapshot | null,
  phase: "connecting" | "retrying" | "live",
): SteadyShellInput => ({
  environmentId,
  snapshot: value,
  serverSequence: value?.snapshotSequence ?? null,
  live: phase === "live",
  inFlight: phase === "connecting",
});
const shown = (state: SteadyShellsState, environmentId: EnvironmentId) =>
  state.shells.get(environmentId)?.shown;

describe("stepSteadyShells", () => {
  it("shows cached rows at once and holds server rows until the environment is synchronized", () => {
    const cached = snapshot(7);
    const withLinks = { ...cached };
    const fromServer = snapshot(9);
    let state = stepSteadyShells(EMPTY_STEADY_SHELLS_STATE, [shell(A, cached, "connecting")], 0);
    expect(shown(state, A)).toBe(cached);

    // The cached links fill in without new server data.
    state = stepSteadyShells(state, [shell(A, withLinks, "connecting")], 10);
    expect(shown(state, A)).toBe(withLinks);

    state = stepSteadyShells(state, [shell(A, fromServer, "connecting")], 20);
    expect(shown(state, A)).toBe(withLinks);

    state = stepSteadyShells(state, [shell(A, fromServer, "live")], 30);
    expect(shown(state, A)).toBe(fromServer);
    expect(state.releaseAt).toBeNull();
  });

  it("shows the cache of an environment that was first seen before its cache was read", () => {
    const cached = snapshot(7);
    let state = stepSteadyShells(EMPTY_STEADY_SHELLS_STATE, [shell(A, null, "connecting")], 0);
    state = stepSteadyShells(state, [shell(A, cached, "connecting")], 10);
    expect(shown(state, A)).toBe(cached);
    state = stepSteadyShells(state, [shell(A, snapshot(9), "connecting")], 20);
    expect(shown(state, A)).toBe(cached);
  });

  it("shows the rows of environments that synchronize within the window together", () => {
    const [cachedA, cachedB, liveA, liveB] = [snapshot(1), snapshot(2), snapshot(3), snapshot(4)];
    let state = stepSteadyShells(
      EMPTY_STEADY_SHELLS_STATE,
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "connecting")],
      0,
    );
    state = stepSteadyShells(
      state,
      [shell(A, liveA, "live"), shell(B, cachedB, "connecting")],
      500,
    );
    expect(shown(state, A)).toBe(cachedA);
    expect(state.releaseAt).toBe(500 + WINDOW);

    state = stepSteadyShells(state, [shell(A, liveA, "live"), shell(B, liveB, "live")], 900);
    expect(shown(state, A)).toBe(liveA);
    expect(shown(state, B)).toBe(liveB);
    expect(state.releaseAt).toBeNull();
  });

  it("stops waiting for a slow environment when the window ends, then shows it on its own", () => {
    const [cachedA, cachedB, liveA, liveB] = [snapshot(1), snapshot(2), snapshot(3), snapshot(4)];
    let state = stepSteadyShells(
      EMPTY_STEADY_SHELLS_STATE,
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "connecting")],
      0,
    );
    const waiting = [shell(A, liveA, "live"), shell(B, cachedB, "connecting")];
    state = stepSteadyShells(state, waiting, 500);
    expect(stepSteadyShells(state, waiting, 500 + WINDOW - 1)).toBe(state);

    state = stepSteadyShells(state, waiting, 500 + WINDOW);
    expect(shown(state, A)).toBe(liveA);
    expect(shown(state, B)).toBe(cachedB);

    state = stepSteadyShells(state, [shell(A, liveA, "live"), shell(B, liveB, "live")], 9_000);
    expect(shown(state, B)).toBe(liveB);
  });

  it("does not wait for an environment that already failed", () => {
    const [cachedA, cachedB, liveA] = [snapshot(1), snapshot(2), snapshot(3)];
    let state = stepSteadyShells(
      EMPTY_STEADY_SHELLS_STATE,
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "retrying")],
      0,
    );
    state = stepSteadyShells(state, [shell(A, liveA, "live"), shell(B, cachedB, "retrying")], 500);
    expect(shown(state, A)).toBe(liveA);
  });

  it("follows a synchronized environment, and holds its rows again while it reconnects", () => {
    const [first, second, missed, caughtUp] = [snapshot(1), snapshot(2), snapshot(5), snapshot(6)];
    let state = stepSteadyShells(EMPTY_STEADY_SHELLS_STATE, [shell(A, first, "live")], 0);
    state = stepSteadyShells(state, [shell(A, second, "live")], 10);
    expect(shown(state, A)).toBe(second);

    state = stepSteadyShells(state, [shell(A, second, "connecting")], 20);
    state = stepSteadyShells(state, [shell(A, missed, "connecting")], 30);
    expect(shown(state, A)).toBe(second);

    state = stepSteadyShells(state, [shell(A, caughtUp, "live")], 40);
    expect(shown(state, A)).toBe(caughtUp);
  });

  it("drops an environment that left the list of enabled environments", () => {
    const state = stepSteadyShells(
      stepSteadyShells(EMPTY_STEADY_SHELLS_STATE, [shell(A, snapshot(1), "live")], 0),
      [],
      10,
    );
    expect(state.shells.size).toBe(0);
  });
});

describe("createSteadyShellAtoms", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows held rows when the window ends without another change", () => {
    const entry = (environmentId: EnvironmentId) => ({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: environmentId,
        httpBaseUrl: "https://example.test",
        wsBaseUrl: "wss://example.test",
      }),
      enabled: true,
      profile: Option.none(),
    });
    const catalog = Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([
        [A, entry(A)],
        [B, entry(B)],
      ]),
    });
    const [cachedA, liveA] = [snapshot(1), snapshot(3)];
    const snapshots = Atom.family((environmentId: EnvironmentId) =>
      Atom.make<OrchestrationV2ShellSnapshot | null>(environmentId === A ? cachedA : snapshot(2)),
    );
    const statuses = Atom.family((_: EnvironmentId) =>
      Atom.make<EnvironmentShellStatus>("synchronizing"),
    );
    const connections = Atom.family((_: EnvironmentId) =>
      Atom.make(
        AsyncResult.success<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connecting",
          attempt: 1,
        }),
      ),
    );
    const steady = createSteadyShellAtoms({
      catalogValueAtom: catalog,
      snapshotAtom: snapshots,
      statusAtom: statuses,
      connectionStateAtom: connections,
    });
    const registry = AtomRegistry.make();
    const release = registry.mount(steady.snapshotAtom(A));

    registry.set(snapshots(A), liveA);
    registry.set(statuses(A), "live");
    registry.set(
      connections(A),
      AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, desired: true, phase: "connected" }),
    );
    expect(registry.get(steady.snapshotAtom(A))).toBe(cachedA);

    vi.advanceTimersByTime(WINDOW);
    expect(registry.get(steady.snapshotAtom(A))).toBe(liveA);
    release();
  });
});
