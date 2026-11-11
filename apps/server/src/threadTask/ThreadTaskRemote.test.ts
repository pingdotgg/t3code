import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadTaskRemoteAssignInput,
  ThreadTaskRemoteDeliverInput,
  ThreadTaskRemoteDeliverResult,
  ThreadTaskRemoteOwnerActionInput,
  ThreadTaskProjectSnapshot,
  ThreadTaskProjectSnapshotInput,
  ThreadTask,
  ThreadTaskView,
  ThreadTaskWake,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  layer as projectionLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ThreadTaskService from "./ThreadTaskService.ts";
import * as ThreadTaskStore from "./ThreadTaskStore.ts";
import { ThreadTaskTransport, type ThreadTaskRemoteRequest } from "./ThreadTaskTransport.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread tasks"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const A = EnvironmentId.make("env-captain");
const B = EnvironmentId.make("env-worker");
const captain = ThreadId.make("captain");
const worker = ThreadId.make("worker");

/** One environment's orchestrator, projections and database, unshared with the other. */
const environmentLayer = () => {
  const database = Sqlite.layerMemory;
  const runtime = Layer.mergeAll(
    database,
    projectionLayer.pipe(Layer.provide(database)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "thread-task-remote" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
  return Layer.mergeAll(
    runtime,
    ThreadTaskStore.layer.pipe(Layer.provide(database)),
    EffectOutbox.layer.pipe(Layer.provide(database)),
  ).pipe(Layer.provideMerge(runtime));
};

/** A task view as an environment or relaying app from before check-backs decodes it. */
const { checkBack: _wakeCheckBack, ...legacyWakeFields } = ThreadTaskWake.fields;
const { checkBack: _taskCheckBack, ...legacyTaskFields } = ThreadTask.fields;
const LegacyThreadTaskRemoteDeliverInput = Schema.Struct({
  ...ThreadTaskRemoteDeliverInput.fields,
  view: Schema.Struct({
    ...ThreadTaskView.fields,
    task: Schema.Struct({
      ...legacyTaskFields,
      wake: Schema.NullOr(Schema.Struct(legacyWakeFields)),
    }),
  }),
});

const encodeView = Schema.encodeEffect(ThreadTaskView);
const encodeLegacyDeliver = Schema.encodeEffect(LegacyThreadTaskRemoteDeliverInput);
const encodeDeliverResult = Schema.encodeEffect(ThreadTaskRemoteDeliverResult);
const encodeSnapshot = Schema.encodeEffect(ThreadTaskProjectSnapshot);

/**
 * The connected app between two environments: each call is encoded and
 * decoded with the RPC contracts, and `connected` can be switched off.
 */
const makeNetwork = Effect.gen(function* () {
  const services = new Map<EnvironmentId, ThreadTaskService.ThreadTaskService["Service"]>();
  const reconnected = yield* PubSub.unbounded<void>();
  const state: {
    connected: boolean;
    calls: number;
    loseReplyFor: string | null;
    legacyRelay: boolean;
    /** The modes each relayed call carried, by action. */
    modes: Array<readonly [string, unknown]>;
  } = {
    modes: [],
    connected: true,
    calls: 0,
    // The relaying app predates check-backs: deliveries pass through its older contract.
    legacyRelay: false,
    // The next call of this action is applied by the receiver, but its reply is lost.
    loseReplyFor: null,
  };
  const roundTrip = <S extends Schema.Top>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie);
  const call = (
    environmentId: EnvironmentId,
    request: ThreadTaskRemoteRequest,
    modeCeiling?: unknown,
  ) =>
    Effect.gen(function* () {
      state.calls += 1;
      state.modes.push([request.action, modeCeiling]);
      if (!state.connected)
        return yield* Effect.fail("No T3 app with T3 Agents enabled is connected.");
      const target = services.get(environmentId);
      if (target === undefined) return yield* Effect.fail(`Unknown environment ${environmentId}.`);
      const run = Effect.gen(function* () {
        switch (request.action) {
          case "remoteAssign":
            return yield* encodeView(
              yield* target.remoteAssign(
                yield* roundTrip(ThreadTaskRemoteAssignInput, request.input),
              ),
            ).pipe(Effect.orDie);
          case "remoteDeliver": {
            const relayed = state.legacyRelay
              ? yield* encodeLegacyDeliver(
                  yield* roundTrip(LegacyThreadTaskRemoteDeliverInput, request.input),
                ).pipe(Effect.orDie)
              : request.input;
            return yield* encodeDeliverResult(
              yield* target.remoteDeliver(yield* roundTrip(ThreadTaskRemoteDeliverInput, relayed)),
            ).pipe(Effect.orDie);
          }
          case "projectSnapshot":
            return yield* encodeSnapshot(
              yield* target.projectSnapshot(
                yield* roundTrip(ThreadTaskProjectSnapshotInput, request.input),
              ),
            ).pipe(Effect.orDie);
          case "remoteOwnerAction":
            return yield* encodeView(
              yield* target.remoteOwnerAction(
                yield* roundTrip(ThreadTaskRemoteOwnerActionInput, request.input),
              ),
            ).pipe(Effect.orDie);
        }
      });
      // A remote rejection reaches the caller as the relay's error message.
      const reply = yield* run.pipe(Effect.mapError((error) => error.detail));
      if (state.loseReplyFor === request.action) {
        state.loseReplyFor = null;
        return yield* Effect.fail("The T3 app relaying this call disconnected.");
      }
      return reply;
    });
  const transport = (localEnvironmentId: EnvironmentId) =>
    ThreadTaskTransport.of({
      localEnvironmentId,
      call,
      peers: () => [...services.keys()].filter((id) => id !== localEnvironmentId),
      connected: Stream.fromPubSub(reconnected),
    });
  return {
    services,
    state,
    transport,
    reconnect: Effect.gen(function* () {
      state.connected = true;
      yield* PubSub.publish(reconnected, undefined);
    }),
  };
});

const environment = (network: Effect.Success<typeof makeNetwork>, environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const context = yield* Layer.buildWithMemoMap(
      environmentLayer(),
      yield* Layer.makeMemoMap,
      scope,
    );
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, context);
    /** A fresh service over this environment's database, as after a restart. */
    const startService = run(
      Effect.gen(function* () {
        const service = yield* ThreadTaskService.make.pipe(
          Effect.provideService(ThreadTaskTransport, network.transport(environmentId)),
        );
        yield* service.start();
        network.services.set(environmentId, service);
        return service;
      }),
    );
    const create = (
      id: ThreadId,
      parent?: { thread: ThreadId; environment?: EnvironmentId },
      profileId?: string,
      runtimeMode: "approval-required" | "full-access" = "full-access",
    ) =>
      run(
        Effect.flatMap(OrchestratorV2, (orchestrator) =>
          orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId: id,
            projectId: ProjectId.make(`project:${environmentId}`),
            title: id,
            modelSelection: { instanceId, model: "gpt-5.1-codex" },
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
            ...(profileId === undefined
              ? {}
              : {
                  profileSnapshot: {
                    profileId,
                    profileName: profileId,
                    revision: 1,
                    effectiveSource: {
                      modelSelection: "profile" as const,
                      runtimeMode: "profile" as const,
                      interactionMode: "profile" as const,
                      reasoningEffort: "profile" as const,
                    },
                  },
                }),
            ...(parent === undefined
              ? {}
              : {
                  parentThreadId: parent.thread,
                  ...(parent.environment === undefined
                    ? {}
                    : { parentEnvironmentId: parent.environment }),
                }),
          }),
        ),
      );
    const send = (id: ThreadId, turn: number) =>
      run(
        Effect.flatMap(OrchestratorV2, (orchestrator) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send:${id}:${turn}`),
            threadId: id,
            messageId: MessageId.make(`message:${id}:${turn}`),
            text: `Turn ${turn}`,
            attachments: [],
            dispatchMode: { type: "defer_start" },
            createdBy: "agent",
            creationSource: "mcp",
          }),
        ),
      );
    const endOpenRuns = (id: ThreadId) =>
      run(
        Effect.gen(function* () {
          const projections = yield* ProjectionStoreV2;
          const sink = yield* EventSinkV2;
          const { runs } = yield* projections.getThreadRecords(id, ["runs"]);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: runs
              .filter(
                (r) => !["completed", "failed", "interrupted", "cancelled"].includes(r.status),
              )
              .map((r) => ({
                id: EventId.make(`event:end:${r.id}`),
                type: "run.updated" as const,
                threadId: id,
                runId: r.id,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: { ...r, status: "completed" as const, completedAt: now },
              })),
          });
        }),
      );
    const wakes = (id: ThreadId) =>
      run(
        Effect.flatMap(ProjectionStoreV2, (projections) =>
          projections.getThreadRecords(id, ["messages"], { messageRoles: ["user"] }),
        ).pipe(
          Effect.map(({ messages }) =>
            messages
              .filter((m) => String(m.id).startsWith("message:thread-task-wake:"))
              .map((m) => ({ id: String(m.id), text: m.text, createdBy: m.createdBy })),
          ),
        ),
      );
    const settled = (id: ThreadId) =>
      run(Effect.flatMap(ProjectionStoreV2, (projections) => projections.getThread(id))).pipe(
        Effect.map((thread) => thread.settledOverride === "settled"),
      );
    const link = (id: ThreadId) =>
      run(Effect.flatMap(ThreadTaskStore.ThreadTaskStore, (store) => store.getLink(id)));
    return { run, startService, create, send, endOpenRuns, wakes, settled, link };
  });

const asCaptain = { kind: "thread", threadId: captain } as const;
const asWorker = { kind: "thread", threadId: worker } as const;

it.effect(
  "remote INPUT and DONE sync without Captain messages, through disconnects and restarts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const network = yield* makeNetwork;
        const envA = yield* environment(network, A);
        const envB = yield* environment(network, B);
        let tasksA = yield* envA.startService;
        let tasksB = yield* envB.startService;
        const drain = Effect.gen(function* () {
          yield* tasksB.drain;
          yield* tasksA.drain;
        });

        yield* envA.create(captain);
        yield* envB.create(worker, { thread: captain, environment: A });
        yield* envB.create(ThreadId.make("sibling"), { thread: captain, environment: A });
        yield* envB.send(worker, 1);

        // The Captain assigns its remote child; B keeps the record, A a mirror.
        const assigned = yield* tasksA.assign(
          asCaptain,
          { threadId: worker, summary: "Remote deliverable", settleWhenAccepted: true },
          B,
        );
        assert.equal(assigned.task.workerEnvironmentId, B);
        assert.equal(assigned.sync?.state, "synced");
        const authoritative = (yield* tasksB.read(asWorker, {})).tasks[0]!;
        assert.equal(authoritative.task.ownerEnvironmentId, A);
        assert.equal(authoritative.task.ownerThreadId, captain);

        // Only the chat the worker is nested under may assign it, and only with B's consent.
        const wrongParent = yield* tasksB
          .remoteAssign({
            ownerEnvironmentId: A,
            ownerThreadId: ThreadId.make("another-captain"),
            workerThreadId: worker,
            taskId: "task:stolen",
            summary: "Take over",
            capability: "x".repeat(72),
          })
          .pipe(Effect.flip);
        assert.equal(wrongParent.code, "scope_denied");
        // A forged capability cannot inject state into the Captain's mirror.
        const forged = yield* tasksA
          .remoteDeliver({ workerEnvironmentId: B, capability: "forged", view: authoritative })
          .pipe(Effect.flip);
        assert.equal(forged.code, "scope_denied");

        // The worker cannot message its sibling or its remote Captain.
        assert.equal(
          (yield* tasksB
            .authorizeMessage({ senderThreadId: worker, targetThreadId: ThreadId.make("sibling") })
            .pipe(Effect.flip)).code,
          "scope_denied",
        );
        assert.equal(
          (yield* tasksB
            .authorizeMessage({ senderThreadId: worker, targetThreadId: null })
            .pipe(Effect.flip)).code,
          "scope_denied",
        );
        // The Captain still relays freely.
        yield* tasksA.authorizeMessage({ senderThreadId: captain, targetThreadId: null });

        // INPUT syncs to the Captain's task mirror without a chat message.
        yield* tasksB.update(asWorker, {
          expectedRevision: 1,
          status: "INPUT",
          needs: "Which region should it deploy to?",
        });
        yield* drain;
        let captainWakes = yield* envA.wakes(captain);
        assert.equal(captainWakes.length, 0);
        assert.equal(
          (yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!.task.status,
          "INPUT",
        );

        // Disconnected: DONE is kept on B and shown as pending there; A is not told yet.
        network.state.connected = false;
        yield* tasksB.update(asWorker, {
          expectedRevision: 2,
          status: "DONE",
          evidence: ["sha abc"],
        });
        yield* drain;
        assert.equal(
          (yield* envB.link(worker)).pipe((l) => (l._tag === "Some" ? l.value.state : "")),
          "unreachable",
        );
        assert.equal(
          (yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!.task.status,
          "INPUT",
        );
        // Owner actions fail closed while the worker's environment is unreachable.
        const offline = yield* tasksA
          .update(asCaptain, { threadId: worker, expectedRevision: 3, accept: true })
          .pipe(Effect.flip);
        assert.equal(offline.code, "unreachable");

        // B restarts while disconnected, then the app reconnects: DONE arrives once.
        tasksB = yield* envB.startService;
        yield* tasksB.recover;
        yield* network.reconnect;
        yield* drain;
        captainWakes = yield* envA.wakes(captain);
        assert.equal(captainWakes.length, 0);

        // A repeated delivery (retry after a lost acknowledgement) changes nothing.
        tasksA = yield* envA.startService;
        const current = (yield* tasksB.read(asWorker, {})).tasks[0]!;
        const { capability } = (yield* envB.link(worker)).pipe((l) =>
          l._tag === "Some" ? l.value : assert.fail("worker link"),
        );
        assert.isFalse(
          (yield* tasksA.remoteDeliver({ workerEnvironmentId: B, capability, view: current }))
            .applied,
        );
        yield* tasksB.recover;
        yield* drain;
        assert.equal((yield* envA.wakes(captain)).length, 0);

        // A stale owner revision is refused by B; the current one is accepted there.
        const stale = yield* tasksA
          .update(asCaptain, { threadId: worker, expectedRevision: 2, accept: true })
          .pipe(Effect.flip);
        assert.include(stale.detail, "revision 3");
        const accepted = yield* tasksA.update(asCaptain, {
          threadId: worker,
          expectedRevision: 3,
          accept: true,
        });
        assert.isTrue(accepted.accepted);
        assert.equal(
          (yield* tasksB.read(asWorker, {})).tasks[0]!.task.acceptance?.acceptedBy,
          "owner",
        );

        // Settlement stays on B and still waits for the worker's turn.
        assert.isFalse(yield* envB.settled(worker));
        yield* envB.endOpenRuns(worker);
        yield* drain;
        assert.isTrue(yield* envB.settled(worker));
        assert.equal(
          (yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!.task.settlement.state,
          "settled",
        );
        // No child activity created a Captain message or run.
        assert.equal((yield* envA.wakes(captain)).length, 0);
      }),
    ),
);

it.effect(
  "a retried remote assignment after a lost reply and a restart returns the original one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const network = yield* makeNetwork;
        const envA = yield* environment(network, A);
        const envB = yield* environment(network, B);
        let tasksA = yield* envA.startService;
        const tasksB = yield* envB.startService;
        yield* envA.create(captain);
        yield* envB.create(worker, { thread: captain, environment: A });
        yield* envB.send(worker, 1);
        const input = {
          threadId: worker,
          summary: "Deploy it",
          settleWhenAccepted: true,
          clientRequestId: "assign-1",
        };

        // B applies the assignment, but A never hears back.
        network.state.loseReplyFor = "remoteAssign";
        const lost = yield* tasksA.assign(asCaptain, input, B).pipe(Effect.flip);
        assert.equal(lost.code, "unreachable");
        const first = (yield* tasksB.read(asWorker, {})).tasks[0]!.task;

        // A restarts, then retries the same request.
        tasksA = yield* envA.startService;
        const retried = yield* tasksA.assign(asCaptain, input, B);
        const after = (yield* tasksB.read(asWorker, {})).tasks[0]!.task;
        assert.equal(after.taskId, first.taskId);
        assert.equal(after.revision, first.revision);
        assert.equal(after.settleWhenAccepted?.grantedAt, first.settleWhenAccepted?.grantedAt);
        assert.equal(retried.task.taskId, first.taskId);
        assert.equal(retried.sync?.state, "synced");
        const secret = (side: typeof envA) =>
          side.link(worker).pipe(Effect.map((l) => (l._tag === "Some" ? l.value.capability : "")));
        assert.equal(yield* secret(envA), yield* secret(envB));

        // Once acknowledged, the same request is answered here without asking B again.
        const calls = network.state.calls;
        const again = yield* tasksA.assign(asCaptain, input, B);
        assert.equal(again.task.taskId, first.taskId);
        assert.equal(network.state.calls, calls);
      }),
    ),
);

it.effect("a Captain's deferred settlement waits for its accepted remote child to go quiet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = yield* makeNetwork;
      const envA = yield* environment(network, A);
      const envB = yield* environment(network, B);
      const tasksA = yield* envA.startService;
      const tasksB = yield* envB.startService;
      const drain = Effect.gen(function* () {
        yield* tasksB.drain;
        yield* tasksA.drain;
      });
      yield* envA.create(captain);
      yield* envB.create(worker, { thread: captain, environment: A });
      yield* envA.send(captain, 1);
      yield* envB.send(worker, 1);
      yield* tasksA.assign(
        asCaptain,
        { threadId: worker, summary: "Ship", settleWhenAccepted: true },
        B,
      );

      // DONE and accepted while the worker's turn is still running on B.
      yield* tasksB.update(asWorker, { expectedRevision: 1, status: "DONE", evidence: ["sha 1"] });
      yield* drain;
      const accepted = yield* tasksA.update(asCaptain, {
        threadId: worker,
        expectedRevision: 2,
        accept: true,
      });
      assert.isTrue(accepted.accepted);
      assert.equal(accepted.workerRun, "running");

      // The Captain asks to settle after its turn; its turn ends, the remote child is still busy.
      yield* tasksA.settleAfterTurn(asCaptain, {});
      yield* envA.endOpenRuns(captain);
      yield* drain;
      const held = yield* tasksA.settleAfterTurn(asCaptain, {});
      assert.equal(held.state, "pending");
      assert.equal(held.blockedBy, "pending_descendant");

      // The child finishes while disconnected: A cannot verify it, so it keeps waiting.
      network.state.connected = false;
      yield* envB.endOpenRuns(worker);
      yield* drain;
      assert.isTrue(yield* envB.settled(worker));
      assert.isFalse(yield* envA.settled(captain));
      assert.equal((yield* tasksA.settleAfterTurn(asCaptain, {})).blockedBy, "pending_descendant");

      // Reconnected, the settled child arrives and the Captain settles.
      yield* network.reconnect;
      yield* drain;
      assert.isTrue(yield* envA.settled(captain));
      assert.equal((yield* tasksA.settleAfterTurn(asCaptain, {})).state, "settled");
    }),
  ),
);

it.effect("Captains on two environments read one project board with explicit coverage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = yield* makeNetwork;
      const envA = yield* environment(network, A);
      const envB = yield* environment(network, B);
      const tasksA = yield* envA.startService;
      const tasksB = yield* envB.startService;
      const captainB = ThreadId.make("captain-b");
      const remoteChild = ThreadId.make("remote-child");
      const localChild = ThreadId.make("local-child");
      const projectKey = "repo:github.com/example/shared";
      yield* envA.create(captain);
      yield* envB.create(captainB);
      yield* envB.create(remoteChild, { thread: captain, environment: A });
      yield* envB.create(localChild, { thread: captainB });
      yield* envB.send(remoteChild, 1);
      yield* envB.send(localChild, 1);
      // The Captain on A lives in its own project; its child's work is in the shared one.
      yield* tasksA.assign(asCaptain, { threadId: remoteChild, summary: "API", projectKey }, B);
      yield* tasksB.assign(
        { kind: "thread", threadId: captainB },
        { threadId: localChild, summary: "Docs", projectKey },
      );

      const owners = (board: {
        readonly owners: ReadonlyArray<{
          readonly ownerThreadId: string;
          readonly tasks: ReadonlyArray<{
            readonly source: string;
            readonly view: { readonly task: { readonly workerThreadId: string } };
          }>;
        }>;
      }) =>
        Object.fromEntries(
          board.owners.map((owner) => [
            owner.ownerThreadId,
            owner.tasks.map((entry) => `${entry.view.task.workerThreadId}:${entry.source}`),
          ]),
        );

      // Each Captain sees both domains, each child under its own owner.
      const fromA = yield* tasksA.board(asCaptain, { projectKey });
      assert.deepEqual(owners(fromA), {
        captain: ["remote-child:live"],
        "captain-b": ["local-child:live"],
      });
      assert.deepEqual(
        fromA.coverage.map((entry) => `${entry.environmentId}:${entry.state}`),
        [`${A}:local`, `${B}:live`],
      );
      const fromB = yield* tasksB.board({ kind: "thread", threadId: captainB }, { projectKey });
      assert.deepEqual(owners(fromB), owners(fromA));

      // Visibility is read-only: a Captain cannot change the other's child.
      const foreign = yield* tasksB
        .update(
          { kind: "thread", threadId: captainB },
          {
            threadId: remoteChild,
            expectedRevision: 1,
            summary: "Mine now",
          },
        )
        .pipe(Effect.flip);
      assert.equal(foreign.code, "scope_denied");
      // Workers read their own task, not the board.
      const worker = yield* tasksB
        .board({ kind: "thread", threadId: localChild }, { projectKey })
        .pipe(Effect.flip);
      assert.equal(worker.code, "scope_denied");

      // Disconnected, B is reported unreachable and A's own child comes from its mirror.
      network.state.connected = false;
      const offline = yield* tasksA.board(asCaptain, { projectKey });
      assert.deepEqual(owners(offline), { captain: ["remote-child:mirror"] });
      const bCoverage = offline.coverage.find((entry) => entry.environmentId === B)!;
      assert.equal(bCoverage.state, "unreachable");
      assert.isNotNull(bCoverage.error);
    }),
  ),
);

it.effect(
  "a legacy named child on another environment reports to its Captain without messaging it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const network = yield* makeNetwork;
        const envA = yield* environment(network, A);
        const envB = yield* environment(network, B);
        const tasksA = yield* envA.startService;
        const tasksB = yield* envB.startService;
        const drain = Effect.gen(function* () {
          yield* tasksB.drain;
          yield* tasksA.drain;
        });
        yield* envA.create(captain);
        // Launched on B as a named agent before tasks existed: no task on either side.
        yield* envB.create(worker, { thread: captain, environment: A }, "cody");

        // Messaging its Captain on A is refused even without a task row.
        const denied = yield* tasksB
          .authorizeMessage({ senderThreadId: worker, targetThreadId: null })
          .pipe(Effect.flip);
        assert.equal(denied.code, "scope_denied");

        // Its turn ending adopts a task mirrored on A, without messaging the Captain.
        yield* envB.send(worker, 1);
        yield* envB.endOpenRuns(worker);
        yield* drain;
        assert.equal((yield* envA.wakes(captain)).length, 0);
        const mirror = (yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!;
        assert.equal(mirror.task.workerEnvironmentId, B);
        assert.equal(mirror.sync?.state, "synced");

        // The adopted link carries owner actions back to B.
        yield* tasksB.update(asWorker, {
          expectedRevision: (yield* tasksB.read(asWorker, {})).tasks[0]!.task.revision,
          status: "DONE",
          evidence: ["staging deployed"],
        });
        yield* drain;
        const current = (yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!;
        assert.equal(current.task.status, "DONE");
        const accepted = yield* tasksA.update(asCaptain, {
          threadId: worker,
          expectedRevision: current.task.revision,
          accept: true,
        });
        assert.isTrue(accepted.accepted);
        assert.equal((yield* envA.wakes(captain)).length, 0);
      }),
    ),
);

it.effect(
  "remote turn ends and check-back expiry never message the Captain through any relay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const network = yield* makeNetwork;
        const envA = yield* environment(network, A);
        const envB = yield* environment(network, B);
        const tasksA = yield* envA.startService;
        const tasksB = yield* envB.startService;
        const drain = Effect.gen(function* () {
          yield* tasksB.drain;
          yield* tasksA.drain;
        });
        yield* envA.create(captain);
        yield* envB.create(worker, { thread: captain, environment: A });
        yield* envB.send(worker, 1);
        yield* tasksA.assign(asCaptain, { threadId: worker, summary: "Remote copy" }, B);

        // INPUT and acknowledgement turns on B start nothing on A.
        yield* tasksB.update(asWorker, { expectedRevision: 1, status: "INPUT", needs: "Region?" });
        yield* envB.endOpenRuns(worker);
        yield* drain;
        assert.equal((yield* envA.wakes(captain)).length, 0);
        for (const turn of [2, 3]) {
          yield* envB.send(worker, turn);
          yield* envB.endOpenRuns(worker);
        }
        yield* drain;
        assert.equal((yield* envA.wakes(captain)).length, 0);

        // Back to WAITING with its own watcher, relayed by an app that predates
        // check-backs: the Captain's mirror still decodes every delivery.
        network.state.legacyRelay = true;
        yield* envB.send(worker, 4);
        yield* tasksB.update(asWorker, {
          expectedRevision: 2,
          status: "WAITING",
          checkBack: { minutes: 20, note: "transfer monitor" },
        });
        yield* drain;
        const mirror = (yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!;
        assert.equal(mirror.task.status, "WAITING");
        assert.equal(mirror.sync?.state, "synced");
        yield* envB.endOpenRuns(worker);
        yield* envB.send(worker, 5);
        yield* envB.endOpenRuns(worker);
        yield* drain;
        assert.equal((yield* envA.wakes(captain)).length, 0);

        // Check-back expiry and repeated deliveries leave the Captain quiet.
        yield* TestClock.adjust("20 minutes");
        yield* drain;
        let wakes = yield* envA.wakes(captain);
        assert.equal(wakes.length, 0);
        const current = (yield* tasksB.read(asWorker, {})).tasks[0]!;
        const { capability } = (yield* envB.link(worker)).pipe((l) =>
          l._tag === "Some" ? l.value : assert.fail("worker link"),
        );
        assert.isFalse(
          (yield* tasksA.remoteDeliver({ workerEnvironmentId: B, capability, view: current }))
            .applied,
        );
        yield* drain;
        assert.equal((yield* envA.wakes(captain)).length, 0);

        // A current relay also leaves the Captain quiet after check-back expiry.
        network.state.legacyRelay = false;
        yield* envB.send(worker, 6);
        yield* tasksB.update(asWorker, {
          expectedRevision: 3,
          checkBack: { minutes: 5, note: "second transfer" },
        });
        yield* envB.endOpenRuns(worker);
        yield* TestClock.adjust("5 minutes");
        yield* drain;
        wakes = yield* envA.wakes(captain);
        assert.equal(wakes.length, 0);
      }),
    ),
);

it.effect("legacy remote wakes cannot inject Captain messages or runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = yield* makeNetwork;
      const envA = yield* environment(network, A);
      const envB = yield* environment(network, B);
      const tasksA = yield* envA.startService;
      const tasksB = yield* envB.startService;
      yield* envA.create(captain);
      yield* envB.create(worker, { thread: captain, environment: A });
      yield* tasksA.assign(asCaptain, { threadId: worker, summary: "Legacy peer" }, B);
      yield* tasksB.drain;
      yield* tasksA.drain;
      const current = (yield* tasksB.read(asWorker, {})).tasks[0]!;
      const link = yield* envB.link(worker);
      assert.equal(link._tag, "Some");
      if (link._tag !== "Some") return assert.fail("worker link");
      const reasons = ["done", "input", "gate", "run_ended", "question"] as const;
      for (const [index, reason] of reasons.entries()) {
        const delivered = yield* tasksA.remoteDeliver({
          workerEnvironmentId: B,
          capability: link.value.capability,
          view: {
            ...current,
            task: {
              ...current.task,
              cursor: current.task.cursor + index + 1,
              wake: {
                id: `legacy:${worker}:revision:${index}:${reason}`,
                reason,
                revision: current.task.revision,
                runId: null,
                state: "pending",
                skipReason: null,
                createdAt: "1970-01-01T00:00:00.000Z",
              },
            },
          },
        });
        assert.isTrue(delivered.applied);
      }
      yield* tasksA.drain;
      assert.deepEqual(yield* envA.wakes(captain), []);
      assert.isNull((yield* tasksA.read(asCaptain, { threadId: worker })).tasks[0]!.task.wake);
      const records = yield* envA.run(
        Effect.flatMap(ProjectionStoreV2, (projections) =>
          projections.getThreadRecords(captain, ["runs"]),
        ),
      );
      assert.equal(records.runs.length, 0);
    }),
  ),
);

it.effect("a named child launched on another environment is in its Captain's sweep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = yield* makeNetwork;
      const envA = yield* environment(network, A);
      const envB = yield* environment(network, B);
      const tasksA = yield* envA.startService;
      const tasksB = yield* envB.startService;
      yield* envA.create(captain);
      // As a cross-environment launch leaves it: an agent's chat nested under the Captain.
      yield* envB.create(worker, { thread: captain, environment: A }, "cody");
      assert.deepEqual((yield* tasksA.read(asCaptain, {})).tasks, []);

      // What the launch registers for it (remoteThreads.assignRemoteChild).
      yield* tasksA.assign(asCaptain, { threadId: worker, summary: "Configure Accessibility" }, B);
      yield* tasksB.drain;
      yield* tasksA.drain;

      const sweep = (yield* tasksA.read(asCaptain, {})).tasks;
      assert.deepEqual(
        sweep.map((view) => [view.task.workerThreadId, view.task.workerEnvironmentId]),
        [[worker, B]],
      );
      assert.equal(sweep[0]!.task.summary, "Configure Accessibility");
    }),
  ),
);

it.effect("a chat's task calls to another environment carry the chat's own modes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const network = yield* makeNetwork;
      const envA = yield* environment(network, A);
      const envB = yield* environment(network, B);
      const tasksA = yield* envA.startService;
      yield* envB.startService;
      yield* envA.create(captain, undefined, undefined, "approval-required");
      yield* envB.create(worker, { thread: captain, environment: A });
      yield* tasksA.assign(asCaptain, { threadId: worker, summary: "Remote deliverable" }, B);
      const supervised = { runtimeMode: "approval-required", interactionMode: "default" };
      assert.deepEqual(
        network.state.modes.filter(([action]) => action === "remoteAssign"),
        [["remoteAssign", supervised]],
      );
    }),
  ),
);
