import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  collectAgentTurnCompletions,
  createAgentTurnNotificationSourceAtom,
  type AgentTurnNotificationSource,
  type NotifiableThreadShell,
} from "./desktopAgentTurnNotifications";

const NOW = "2026-08-26T12:00:00.000Z";

function shell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return {
    environmentId: "env-1" as EnvironmentId,
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function runningShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    session: {
      threadId: "thread-1" as ThreadId,
      status: "running",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1" as TurnId,
      lastError: null,
      updatedAt: NOW,
    },
    ...overrides,
  });
}

function startingShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    session: {
      threadId: "thread-1" as ThreadId,
      status: "starting",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    ...overrides,
  });
}

function completedShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    latestTurn: {
      turnId: "turn-1" as TurnId,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
    ...overrides,
  });
}

function failedShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    session: {
      threadId: "thread-1" as ThreadId,
      status: "error",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Provider process exited.",
      updatedAt: NOW,
    },
    ...overrides,
  });
}

function live(shells: ReadonlyArray<NotifiableThreadShell>): AgentTurnNotificationSource {
  return {
    shells,
    liveEnvironmentIds: new Set(shells.map((thread) => thread.environmentId)),
  };
}

function resynchronizing(
  shells: ReadonlyArray<NotifiableThreadShell>,
): AgentTurnNotificationSource {
  return { shells, liveEnvironmentIds: new Set() };
}

const KEY = "env-1:thread-1";

describe("collectAgentTurnCompletions", () => {
  it("notifies once with the thread title on running to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), live([runningShell()]));
    expect(first.completions).toEqual([]);
    expect(first.nextPhases.get(KEY)).toEqual({ phase: "running", armed: true });

    const second = collectAgentTurnCompletions(first.nextPhases, live([completedShell()]));
    expect(second.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
    expect(second.nextPhases.get(KEY)).toEqual({ phase: "completed", armed: false });
  });

  it("never notifies for a thread first observed as completed", () => {
    const result = collectAgentTurnCompletions(new Map(), live([completedShell()]));
    expect(result.completions).toEqual([]);
    expect(result.nextPhases.get(KEY)).toEqual({ phase: "completed", armed: false });
  });

  it("does not re-notify on completed to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), live([runningShell()]));
    const second = collectAgentTurnCompletions(first.nextPhases, live([completedShell()]));
    expect(second.completions.length).toBe(1);

    const third = collectAgentTurnCompletions(second.nextPhases, live([completedShell()]));
    expect(third.completions).toEqual([]);
  });

  it("carries the active phase across a transient null and notifies once", () => {
    const first = collectAgentTurnCompletions(new Map(), live([runningShell()]));
    const nulled = collectAgentTurnCompletions(first.nextPhases, live([shell()]));
    expect(nulled.completions).toEqual([]);
    expect(nulled.nextPhases.get(KEY)).toEqual({ phase: "running", armed: true });

    const completed = collectAgentTurnCompletions(nulled.nextPhases, live([completedShell()]));
    expect(completed.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("creates no entry and never notifies for a null-only thread", () => {
    const result = collectAgentTurnCompletions(new Map(), live([shell()]));
    expect(result.completions).toEqual([]);
    expect(result.nextPhases.size).toBe(0);
  });

  it("drops removed threads and treats a reappearance as a fresh first observation", () => {
    const first = collectAgentTurnCompletions(new Map(), live([runningShell()]));
    const removed = collectAgentTurnCompletions(first.nextPhases, live([]));
    expect(removed.nextPhases.size).toBe(0);

    const reappeared = collectAgentTurnCompletions(removed.nextPhases, live([completedShell()]));
    expect(reappeared.completions).toEqual([]);
  });

  it("does not notify on failed to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), live([failedShell()]));
    expect(first.nextPhases.get(KEY)).toEqual({ phase: "failed", armed: false });

    const second = collectAgentTurnCompletions(first.nextPhases, live([completedShell()]));
    expect(second.completions).toEqual([]);
  });

  it("does not notify on the session-boot transient (starting to completed)", () => {
    const starting = collectAgentTurnCompletions(new Map(), live([startingShell()]));
    expect(starting.nextPhases.get(KEY)).toEqual({ phase: "starting", armed: false });

    const booted = collectAgentTurnCompletions(starting.nextPhases, live([completedShell()]));
    expect(booted.completions).toEqual([]);

    const running = collectAgentTurnCompletions(booted.nextPhases, live([runningShell()]));
    const finished = collectAgentTurnCompletions(running.nextPhases, live([completedShell()]));
    expect(finished.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("notifies on waiting_for_approval to completed", () => {
    const first = collectAgentTurnCompletions(
      new Map(),
      live([runningShell({ hasPendingApprovals: true })]),
    );
    expect(first.nextPhases.get(KEY)).toEqual({ phase: "waiting_for_approval", armed: true });

    const second = collectAgentTurnCompletions(first.nextPhases, live([completedShell()]));
    expect(second.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("tracks the same threadId independently per environment", () => {
    const envA = "env-a" as EnvironmentId;
    const envB = "env-b" as EnvironmentId;
    const first = collectAgentTurnCompletions(
      new Map(),
      live([runningShell({ environmentId: envA }), runningShell({ environmentId: envB })]),
    );

    const second = collectAgentTurnCompletions(
      first.nextPhases,
      live([
        completedShell({ environmentId: envA, title: "Ship the fix" }),
        runningShell({ environmentId: envB }),
      ]),
    );
    expect(second.completions).toEqual([
      { threadKey: "env-a:thread-1", threadTitle: "Ship the fix" },
    ]);
    expect(second.nextPhases.get("env-b:thread-1")).toEqual({ phase: "running", armed: true });
  });

  it("does not notify when a cached running thread completes in the fresh snapshot", () => {
    const cached = collectAgentTurnCompletions(new Map(), resynchronizing([runningShell()]));
    expect(cached.nextPhases.get(KEY)).toEqual({ phase: "running", armed: false });

    const refreshed = collectAgentTurnCompletions(cached.nextPhases, live([completedShell()]));
    expect(refreshed.completions).toEqual([]);
  });

  it("keeps a live-armed thread notifiable across a resynchronizing observation", () => {
    const first = collectAgentTurnCompletions(new Map(), live([runningShell()]));
    const resynced = collectAgentTurnCompletions(
      first.nextPhases,
      resynchronizing([runningShell()]),
    );
    expect(resynced.nextPhases.get(KEY)).toEqual({ phase: "running", armed: true });

    const completed = collectAgentTurnCompletions(resynced.nextPhases, live([completedShell()]));
    expect(completed.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("notifies for a completion replayed during resynchronization when armed live", () => {
    const first = collectAgentTurnCompletions(new Map(), live([runningShell()]));
    const replayed = collectAgentTurnCompletions(
      first.nextPhases,
      resynchronizing([completedShell()]),
    );
    expect(replayed.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("arms a running thread once its environment turns live", () => {
    const cached = collectAgentTurnCompletions(new Map(), resynchronizing([runningShell()]));
    const armed = collectAgentTurnCompletions(cached.nextPhases, live([runningShell()]));
    expect(armed.nextPhases.get(KEY)).toEqual({ phase: "running", armed: true });

    const completed = collectAgentTurnCompletions(armed.nextPhases, live([completedShell()]));
    expect(completed.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });
});

const ENV = "env-1" as EnvironmentId;

function shellState(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return { snapshot: Option.none(), status, error: Option.none() };
}

function makeSourceHarness() {
  const shellsAtom = Atom.make<ReadonlyArray<NotifiableThreadShell>>([runningShell()]);
  const stateAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(shellState("live")),
  );
  return {
    registry: AtomRegistry.make(),
    shellsAtom,
    stateAtoms,
    sourceAtom: createAgentTurnNotificationSourceAtom({
      threadShellsAtom: shellsAtom,
      shellStateValueAtom: stateAtoms,
    }),
  };
}

describe("createAgentTurnNotificationSourceAtom", () => {
  it("keeps the source identity across shell state updates that change no liveness", () => {
    const harness = makeSourceHarness();
    const baseline = harness.registry.get(harness.sourceAtom);
    expect(baseline.liveEnvironmentIds.has(ENV)).toBe(true);
    let fires = 0;
    const unsubscribe = harness.registry.subscribe(harness.sourceAtom, () => {
      fires += 1;
    });

    harness.registry.set(harness.stateAtoms(ENV), shellState("live"));
    expect(harness.registry.get(harness.sourceAtom)).toBe(baseline);
    expect(fires).toBe(0);
    unsubscribe();
  });

  it("emits once per liveness flip, shells change, and environment removal", () => {
    const harness = makeSourceHarness();
    harness.registry.set(harness.stateAtoms(ENV), shellState("synchronizing"));
    const baseline = harness.registry.get(harness.sourceAtom);
    expect(baseline.liveEnvironmentIds.size).toBe(0);
    const sources: AgentTurnNotificationSource[] = [];
    const unsubscribe = harness.registry.subscribe(harness.sourceAtom, (source) => {
      sources.push(source);
    });

    harness.registry.set(harness.stateAtoms(ENV), shellState("live"));
    expect(sources.length).toBe(1);
    expect(sources[0]?.shells).toBe(baseline.shells);
    expect(sources[0]?.liveEnvironmentIds.has(ENV)).toBe(true);

    const completed = [completedShell()];
    harness.registry.set(harness.shellsAtom, completed);
    expect(sources.length).toBe(2);
    expect(sources[1]?.shells).toBe(completed);

    harness.registry.set(harness.shellsAtom, []);
    expect(sources.length).toBe(3);
    expect(sources[2]?.liveEnvironmentIds.size).toBe(0);
    unsubscribe();
  });
});
