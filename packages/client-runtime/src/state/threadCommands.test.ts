import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  CommandId,
  MessageId,
  RuntimeRequestId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope],
      permissions: [AuthOrchestrationOperateScope],
    }),
  ),
);

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const NOW = DateTime.makeUnsafe("2026-09-12T10:00:00.000Z");
const FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const APPROVAL = {
  id: RuntimeRequestId.make("approval"),
  kind: "command" as const,
  createdAt: NOW,
};
const USER_INPUT = {
  id: RuntimeRequestId.make("input"),
  kind: "user_input" as const,
  createdAt: NOW,
};
const SNAPSHOT: OrchestrationV2ShellSnapshot = {
  snapshotSequence: 1,
  schemaVersion: 2,
  archivedThreads: [],
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Remote thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      itemCount: 0,
      visibleItemCount: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    },
  ],
};

const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* () {
  const requests = yield* Queue.unbounded<{
    command: OrchestrationV2Command;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<{ sequence: number }, Error>();
              yield* Queue.offer(requests, { command, reply });
              return yield* Deferred.await(reply);
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  return { registry, commands, snapshotAtom, visibleAtom, requests };
});

describe("remote thread lifecycle commands", () => {
  const actions = [
    ["settle", {}, { settledOverride: "settled", pinnedAt: null, snoozedUntil: null }],
    ["unsettle", { reason: "user" }, { settledOverride: "active", settledAt: null }],
    ["snooze", { snoozedUntil: "2099-01-01T00:00:00.000Z" }, { snoozedUntil: FUTURE }],
    ["unsnooze", { reason: "user" }, { snoozedUntil: null, snoozedAt: null }],
    ["pin", { orderKey: "a" }, { pinnedAt: expect.any(Object), pinOrderKey: "a" }],
    ["unpin", {}, { pinnedAt: null, pinOrderKey: null }],
    ["setAutoSettle", { enabled: false }, { autoSettleDisabledAt: expect.any(Object) }],
    ["reorderPin", { orderKey: "b" }, { pinOrderKey: "b" }],
    ["reorderActive", { orderKey: "b" }, { activeOrderKey: "b" }],
  ] as const;

  it.effect.each(actions)(
    "shows %s before a delayed remote reply and rolls back a rejection",
    ([action, input, expected]) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const source = h.snapshotAtom(ENVIRONMENT_ID);
        const initial = {
          ...SNAPSHOT,
          threads: [
            {
              ...SNAPSHOT.threads[0]!,
              ...(action === "unsettle" || action === "pin"
                ? { settledOverride: "settled" as const, settledAt: NOW }
                : {}),
              ...(action === "unsnooze" || action === "settle" || action === "pin"
                ? { snoozedUntil: FUTURE, snoozedAt: NOW }
                : {}),
              ...(action === "unpin" || action === "settle"
                ? { pinnedAt: NOW, pinOrderKey: "a" }
                : {}),
            },
          ],
        };
        h.registry.set(source, initial);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            commandId: CommandId.make(action),
            reason: "user",
            enabled: false,
            orderKey: "a",
            snoozedUntil: "2099-01-01T00:00:00.000Z",
            ...input,
          },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(expected);
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(source)).toBe(initial);
        yield* Deferred.fail(request.reply, new Error("Remote rejected the action"));
        expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(initial);
      }),
  );

  it.effect("keeps the preview after acknowledgement until the matching shell update arrives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, title: "Renamed remotely" }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({
        title: "Renamed remotely",
        settledOverride: "settled",
      });
      const confirmed = {
        ...changed,
        snapshotSequence: 3,
        threads: [
          {
            ...changed.threads[0]!,
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe("2026-09-12T12:00:00.000Z"),
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 4 });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBeNull();
    }),
  );

  it.effect(
    "shows a queued reverse action immediately and preserves it if the earlier action fails",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const settle = h.commands.settle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        });
        const first = yield* Queue.take(h.requests);
        const unsettle = h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        yield* Deferred.fail(first.reply, new Error("Settle rejected"));
        yield* Effect.promise(() => settle);
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe("thread.unsettle");
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "active" as const }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(second.reply, { sequence: 2 });
        yield* Effect.promise(() => unsettle);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("isolates environments and does not restore a remotely removed thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const otherEnvironment = EnvironmentId.make("other-remote");
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.commands.snapshotAtom(otherEnvironment))).toBe(SNAPSHOT);
      const removed = { ...SNAPSHOT, snapshotSequence: 2, threads: [] };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), removed);
      expect(h.registry.get(h.visibleAtom)?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("Thread removed"));
      yield* Effect.promise(() => result);
      expect(h.registry.get(h.visibleAtom)).toBe(removed);
    }),
  );

  it.effect("keeps pending approvals visible while a lifecycle request is pending", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const blocked = {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: APPROVAL }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), blocked);
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(blocked.threads[0]);
      yield* Deferred.fail(request.reply, new Error("Approval pending"));
      yield* Effect.promise(() => result);
    }),
  );

  const undoableActions = ["settle", "snooze"] as const;

  it.effect.each(undoableActions)("restores a confirmed %s when a queued undo fails", (action) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const parked =
        action === "settle" ? { settledOverride: "settled" as const } : { snoozedUntil: FUTURE };
      const awake = action === "settle" ? { settledOverride: "active" } : { snoozedUntil: null };
      const result = h.commands[action].run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
      });
      const first = yield* Queue.take(h.requests);
      const undo = h.commands[action === "settle" ? "unsettle" : "unsnooze"].run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      yield* Deferred.succeed(first.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      const confirmed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, ...parked }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      const second = yield* Queue.take(h.requests);
      expect(second.command.type).toBe(action === "settle" ? "thread.unsettle" : "thread.unsnooze");
      yield* Deferred.fail(second.reply, new Error("Undo rejected"));
      expect((yield* Effect.promise(() => undo))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
    }),
  );

  it.effect.each(undoableActions)(
    "preserves a newer approval when the %s reply arrives after the shell",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        const newer = {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: APPROVAL }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), newer);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)).toBe(newer);
      }),
  );

  it.effect.each(undoableActions)(
    "shows an accepted %s while the shell still has an old input request",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const stale = {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: USER_INPUT }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), stale);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(stale.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(
          action === "settle" ? { settledOverride: "settled" } : { snoozedUntil: FUTURE },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.pendingRuntimeRequest).toBeNull();
        expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(stale);
      }),
  );
});

describe("thread model selection", () => {
  const selection = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
  const nextSelection = {
    ...selection,
    model: "sonnet",
    options: [{ id: "effort", value: "high" }],
  };

  it.effect("denies a model change without the target grant and blocks an immediate send", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const granted = h.registry.get(sessions(ENVIRONMENT_ID));
      if (granted._tag !== "Success") return yield* Effect.die("Missing fixture grant");
      h.registry.set(
        sessions(ENVIRONMENT_ID),
        AsyncResult.success({ ...granted.value, scopes: [], permissions: [] }),
      );
      expect(h.registry.get(h.commands.setModelSelection.permissionAtom(ENVIRONMENT_ID))).toBe(
        false,
      );
      const save = h.commands.setModelSelection.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, modelSelection: selection },
      });
      const send = h.commands.startTurn.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: {
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("denied"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: "start",
        },
      });
      expect((yield* Effect.promise(() => save))._tag).toBe("Failure");
      expect((yield* Effect.promise(() => send))._tag).toBe("Failure");
      expect(yield* Queue.size(h.requests)).toBe(0);
    }),
  );

  it.effect(
    "shows a pick immediately, then follows other clients after its receipt reaches the shell",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const save = h.commands.setModelSelection.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, modelSelection: selection },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.modelSelection).toEqual(selection);
        const request = yield* Queue.take(h.requests);
        expect(request.command).toMatchObject({
          type: "thread.model-selection.set",
          modelSelection: selection,
        });
        yield* Deferred.succeed(request.reply, { sequence: 3 });
        yield* Effect.promise(() => save);
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 2 });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.modelSelection).toEqual(selection);
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 4,
          threads: [{ ...SNAPSHOT.threads[0]!, modelSelection: nextSelection }],
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.modelSelection).toEqual(nextSelection);
      }),
  );

  it.effect("an earlier failed pick cannot remove a newer optimistic pick", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const first = h.commands.setModelSelection.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, modelSelection: selection },
      });
      const request = yield* Queue.take(h.requests);
      const second = h.commands.setModelSelection.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, modelSelection: nextSelection },
      });
      yield* Deferred.fail(request.reply, new Error("Disconnected"));
      yield* Effect.promise(() => first);
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.modelSelection).toEqual(nextSelection);
      const nextRequest = yield* Queue.take(h.requests);
      yield* Deferred.succeed(nextRequest.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => second))._tag).toBe("Success");
    }),
  );

  it.effect.each([true, false])(
    "orders an immediate send after the pick, save succeeds: %s",
    (succeeds) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const save = h.commands.setModelSelection.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, modelSelection: selection },
        });
        const request = yield* Queue.take(h.requests);
        const readyToEnqueue = h.commands.waitForModelSelection.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        });
        const send = h.commands.startTurn.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.make("message"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            dispatchMode: "start",
          },
        });
        if (succeeds) {
          yield* Deferred.succeed(request.reply, { sequence: 3 });
          const sendRequest = yield* Queue.take(h.requests);
          expect(sendRequest.command.type).toBe("message.dispatch");
          expect(sendRequest.command).not.toHaveProperty("modelSelection");
          yield* Deferred.succeed(sendRequest.reply, { sequence: 4 });
          expect((yield* Effect.promise(() => send))._tag).toBe("Success");
        } else {
          yield* Deferred.fail(request.reply, new Error("Disconnected"));
          expect((yield* Effect.promise(() => send))._tag).toBe("Failure");
          expect(h.registry.get(h.visibleAtom)?.threads[0]?.modelSelection).toEqual(
            SNAPSHOT.threads[0]!.modelSelection,
          );
          expect(yield* Queue.size(h.requests)).toBe(0);
        }
        yield* Effect.promise(() => save);
        expect((yield* Effect.promise(() => readyToEnqueue))._tag).toBe(
          succeeds ? "Success" : "Failure",
        );
      }),
  );
});
