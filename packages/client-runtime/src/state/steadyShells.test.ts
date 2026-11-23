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
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
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
  phase: "connecting" | "disconnected" | "live",
  generation = 0,
  rowActions = 0,
): SteadyShellInput => ({
  environmentId,
  snapshot: value,
  serverSequence: value?.snapshotSequence ?? null,
  status: phase === "live" ? "live" : phase === "connecting" ? "synchronizing" : "cached",
  generation,
  connecting: phase !== "disconnected",
  rowActions,
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

  it("shows a connection's server snapshot when it arrives, and the events after it when live", () => {
    const [cached, fromServer, withEvents] = [snapshot(7), snapshot(9), snapshot(10)];
    let state = stepSteadyShells(EMPTY_STEADY_SHELLS_STATE, [shell(A, cached, "connecting")], 0);
    state = stepSteadyShells(state, [shell(A, fromServer, "connecting", 1)], 10);
    expect(shown(state, A)).toBe(fromServer);
    state = stepSteadyShells(state, [shell(A, withEvents, "connecting", 1)], 20);
    expect(shown(state, A)).toBe(fromServer);
    state = stepSteadyShells(state, [shell(A, withEvents, "live", 1)], 30);
    expect(shown(state, A)).toBe(withEvents);
  });

  it("does not wait for an environment that already shows its server snapshot", () => {
    const [cachedA, cachedB, serverA, serverB] = [
      snapshot(1),
      snapshot(2),
      snapshot(3),
      snapshot(4),
    ];
    let state = stepSteadyShells(
      EMPTY_STEADY_SHELLS_STATE,
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "connecting")],
      0,
    );
    state = stepSteadyShells(
      state,
      [shell(A, cachedA, "connecting"), shell(B, serverB, "connecting", 1)],
      10,
    );
    expect(shown(state, B)).toBe(cachedB);
    state = stepSteadyShells(
      state,
      [shell(A, serverA, "connecting", 2), shell(B, serverB, "connecting", 1)],
      20,
    );
    expect(shown(state, A)).toBe(serverA);
    expect(shown(state, B)).toBe(serverB);
    // B is not live yet, and A's next rows do not wait for it.
    const liveA = snapshot(5);
    state = stepSteadyShells(
      state,
      [shell(A, liveA, "live", 2), shell(B, serverB, "connecting", 1)],
      30,
    );
    expect(shown(state, A)).toBe(liveA);
  });

  it("shows rows that wait when their environment disconnects", () => {
    const [cachedA, cachedB, serverA] = [snapshot(7), snapshot(2), snapshot(9)];
    let state = stepSteadyShells(
      EMPTY_STEADY_SHELLS_STATE,
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "connecting")],
      0,
    );
    state = stepSteadyShells(
      state,
      [shell(A, serverA, "connecting", 1), shell(B, cachedB, "connecting")],
      10,
    );
    expect(shown(state, A)).toBe(cachedA);
    const disconnected = [shell(A, serverA, "disconnected", 1), shell(B, cachedB, "connecting")];
    state = stepSteadyShells(state, disconnected, 20);
    expect(shown(state, A)).toBe(cachedA);
    expect(state.releaseAt).toBe(10 + WINDOW);
    state = stepSteadyShells(state, disconnected, 10 + WINDOW);
    expect(shown(state, A)).toBe(serverA);
  });

  it("holds replayed events after a reconnect until the environment is live again", () => {
    const [first, replayed] = [snapshot(1), snapshot(4)];
    let state = stepSteadyShells(EMPTY_STEADY_SHELLS_STATE, [shell(A, first, "live", 1)], 0);
    state = stepSteadyShells(state, [shell(A, replayed, "connecting", 1)], 10);
    expect(shown(state, A)).toBe(first);
    state = stepSteadyShells(state, [shell(A, replayed, "live", 1)], 20);
    expect(shown(state, A)).toBe(replayed);
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
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "disconnected")],
      0,
    );
    state = stepSteadyShells(
      state,
      [shell(A, liveA, "live"), shell(B, cachedB, "disconnected")],
      500,
    );
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

  it("follows an environment's live rows once the user moves or removes a row there", () => {
    const [cachedA, cachedB, liveA, confirmedA] = [
      snapshot(1),
      snapshot(2),
      snapshot(3),
      snapshot(4),
    ];
    const [replayedB, archivedB, laterB] = [snapshot(5), snapshot(6), snapshot(7)];
    const settledA = { ...liveA };
    let state = stepSteadyShells(
      EMPTY_STEADY_SHELLS_STATE,
      [shell(A, cachedA, "connecting"), shell(B, cachedB, "connecting")],
      0,
    );
    state = stepSteadyShells(state, [shell(A, liveA, "live"), shell(B, cachedB, "connecting")], 10);
    expect(shown(state, A)).toBe(cachedA);

    // The user settles a thread of A: its rows show at once, and B's rows still wait.
    const heldB = shell(B, replayedB, "connecting");
    state = stepSteadyShells(state, [shell(A, settledA, "live", 0, 1), heldB], 20);
    expect(shown(state, A)).toBe(settledA);
    expect(shown(state, B)).toBe(cachedB);
    expect(state.releaseAt).toBeNull();
    state = stepSteadyShells(state, [shell(A, confirmedA, "live", 0, 1), heldB], 30);
    expect(shown(state, A)).toBe(confirmedA);

    // B still synchronizes when the user archives a thread there. Its rows follow the
    // replayed events until it is live, then wait again on the next reconnect.
    const a = shell(A, confirmedA, "live", 0, 1);
    state = stepSteadyShells(state, [a, shell(B, replayedB, "connecting", 0, 1)], 40);
    expect(shown(state, B)).toBe(replayedB);
    state = stepSteadyShells(state, [a, shell(B, archivedB, "connecting", 0, 1)], 50);
    expect(shown(state, B)).toBe(archivedB);
    state = stepSteadyShells(state, [a, shell(B, archivedB, "live", 0, 1)], 60);
    state = stepSteadyShells(state, [a, shell(B, laterB, "connecting", 0, 1)], 70);
    expect(shown(state, B)).toBe(archivedB);
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
    const rowActions = Atom.family((_: EnvironmentId) => Atom.make(0));
    const shellStates = Atom.family((_: EnvironmentId) =>
      Atom.make<EnvironmentShellState>({ ...EMPTY_SHELL_STATE, status: "synchronizing" }),
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
      shellStateAtom: shellStates,
      rowActionsAtom: rowActions,
      connectionStateAtom: connections,
    });
    const registry = AtomRegistry.make();
    const release = registry.mount(steady.snapshotAtom(A));

    registry.set(snapshots(A), liveA);
    registry.set(shellStates(A), { ...EMPTY_SHELL_STATE, status: "live", generation: 1 });
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
