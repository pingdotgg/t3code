import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ORCHESTRATION_V2_WS_METHODS, ThreadId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "@effect/vitest";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";

const THREAD_ID = ThreadId.make("shared-thread");
const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

describe("Diff environment isolation", () => {
  it("keeps selection, reveal and remembered bases separate for the same thread id", () => {
    useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
    const local = scopeThreadRef(LOCAL, THREAD_ID);
    const remote = scopeThreadRef(REMOTE, THREAD_ID);
    const store = useDiffPanelStore.getState();
    const selection = (ref: typeof local) =>
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref);
    try {
      store.selectBranchBaseRef(local, "origin/local");
      store.selectBranchBaseRef(remote, "origin/remote");
      store.selectTurn(local, RunId.make("local-turn"), "local.ts");
      store.selectTurn(local, RunId.make("local-turn"), "local.ts");
      expect(selection(remote)).toEqual({ kind: "branch", baseRef: "origin/remote" });
      store.selectTurn(remote, RunId.make("remote-turn"), "remote.ts");
      store.reconcileTurnSelection(local, [RunId.make("local-latest")]);
      expect(selection(local)).toEqual({
        kind: "turn",
        turnId: "local-latest",
        filePath: "local.ts",
        revealRequestId: 2,
      });
      expect(selection(remote)).toEqual({
        kind: "turn",
        turnId: "remote-turn",
        filePath: "remote.ts",
        revealRequestId: 1,
      });
      store.selectGitScope(local, "branch");
      store.selectGitScope(remote, "branch");
      expect(selection(local)).toEqual({ kind: "branch", baseRef: "origin/local" });
      expect(selection(remote)).toEqual({ kind: "branch", baseRef: "origin/remote" });
      store.removeThread(local);
      expect(selection(local)).toEqual({ kind: "branch", baseRef: null });
      expect(selection(remote)).toEqual({ kind: "branch", baseRef: "origin/remote" });
    } finally {
      useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
    }
  });

  it.effect(
    "routes turnDiff reads and cached results to the right environment with the same thread id",
    () => readIsolation("turnDiff"),
  );
  it.effect(
    "routes fullThreadDiff reads and cached results to the right environment with the same thread id",
    () => readIsolation("fullThreadDiff"),
  );
});

function readIsolation(kind: "turnDiff" | "fullThreadDiff") {
  return Effect.gen(function* () {
    const calls: EnvironmentId[] = [];
    const supervisors = yield* Effect.gen(function* () {
      const entries = [];
      for (const environmentId of [LOCAL, REMOTE]) {
        const read = (input: { threadId: ThreadId }) =>
          Effect.sync(() => {
            expect(input.threadId).toBe(THREAD_ID);
            calls.push(environmentId);
            return {
              threadId: THREAD_ID,
              fromTurnCount: 0,
              toTurnCount: 1,
              diff: environmentId,
            };
          });
        entries.push([
          environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: `https://${environmentId}.example.test`,
              wsBaseUrl: `wss://${environmentId}.example.test`,
            }),
            state: yield* SubscriptionRef.make({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
            }),
            session: yield* SubscriptionRef.make(
              Option.some({
                client: {
                  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: read,
                  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: read,
                },
              }),
            ),
          } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
        ] as const);
      }
      return new Map(entries);
    });
    const supervisor = (id: EnvironmentId) => supervisors.get(id)!;
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor(id)),
      followStream: (id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor(id)),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
    );
    const panels = createOrchestrationEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    const input = {
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: false,
    };
    const local = panels[kind]({ environmentId: LOCAL, input });
    const remote = panels[kind]({ environmentId: REMOTE, input });
    try {
      const [localResult, remoteResult] = yield* Effect.promise(() =>
        Promise.all([executeAtomQuery(registry, local), executeAtomQuery(registry, remote)]),
      );
      expect(localResult).toMatchObject({ _tag: "Success", value: { diff: LOCAL } });
      expect(remoteResult).toMatchObject({ _tag: "Success", value: { diff: REMOTE } });
      expect(calls.toSorted()).toEqual([LOCAL, REMOTE]);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(local))).diff).toBe(LOCAL);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(remote))).diff).toBe(REMOTE);
    } finally {
      registry.dispose();
    }
  });
}
