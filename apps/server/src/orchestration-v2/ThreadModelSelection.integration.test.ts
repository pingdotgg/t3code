import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import {
  exclusiveCapabilities,
  pooledCapabilities,
  initialSelection,
  replacementSelection,
  seedSelection,
  makeRestartAdapter,
  type RestartAdapterState,
} from "./testkit/SelectionRestartAdapter.ts";

it.live.each([
  { mode: "exclusive", selection: replacementSelection },
  { mode: "pooled", selection: replacementSelection },
  { mode: "exclusive", selection: seedSelection },
  { mode: "pooled", selection: seedSelection },
] as const)(
  "applies session transitions when a prepared run starts ($mode, $selection.model)",
  ({ mode, selection }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `prepared-model-${mode}-${selection.model}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(name);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: true,
        });
        const adapter = makeRestartAdapter(
          state,
          mode === "pooled" ? pooledCapabilities : exclusiveCapabilities,
        );
        const closedAtOpen: Array<number> = [];
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const completed = (ordinal: number) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            createdBy: "user",
            creationSource: "web",
            projectId: ProjectId.make(name),
            title: name,
            modelSelection: seedSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const firstCompleted = yield* completed(1);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:first`),
            threadId,
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`${name}:first`),
            text: "first",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(firstCompleted);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadProjection(threadId);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:prepare`),
            threadId,
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`${name}:prepared`),
            text: "prepare replacement",
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "defer_start" },
          });
          yield* worker.drain();
          const prepared = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(prepared.runs[1]?.status, "preparing");
          assert.deepEqual(prepared.providerSessions, before.providerSessions);
          assert.equal((yield* Ref.get(state)).closedSessionCount, 0);
          assert.lengthOf((yield* Ref.get(state)).started, 1);

          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${name}:later-pick`),
            threadId,
            modelSelection: initialSelection,
          });
          const replacementCompleted = yield* completed(2);
          yield* orchestrator.dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${name}:release`),
            threadId,
            runId: prepared.runs[1]!.id,
          });
          yield* worker.drain();
          yield* Fiber.join(replacementCompleted);
          yield* worker.drain();
          const result = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(result.runs[1]?.modelSelection, selection);
          assert.deepEqual(result.thread.modelSelection, initialSelection);
          const requiresRestart = selection.model !== seedSelection.model;
          assert.equal(
            result.providerSessions.some(
              (session) => session.id === before.providerSessions[0]!.id,
            ),
            !requiresRestart,
          );
          assert.deepEqual(closedAtOpen, requiresRestart ? [0, mode === "exclusive" ? 1 : 0] : [0]);
          assert.deepEqual(
            (yield* Ref.get(state)).started.map((turn) => turn.model),
            [seedSelection.model, selection.model],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name },
              ProviderAdapterRegistry.layerSingle({
                ...adapter,
                openSession: (input) =>
                  Effect.gen(function* () {
                    closedAtOpen.push((yield* Ref.get(state)).closedSessionCount);
                    return yield* adapter.openSession(input);
                  }),
              }),
            ),
          ),
        );
      }),
    ),
);

it.live.each(["exclusive", "pooled"] as const)(
  "picks without interrupting, preserves a queued model, and inherits the latest pick (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `thread-model-sync-${mode}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(name);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: true,
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            createdBy: "user",
            creationSource: "web",
            projectId: ProjectId.make(name),
            title: name,
            modelSelection: initialSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:first`),
            threadId,
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`${name}:first`),
            text: "first",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const before = yield* orchestrator.getThreadProjection(threadId);
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`${name}:pick`),
            threadId,
            modelSelection: replacementSelection,
          });
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(after.thread.modelSelection, replacementSelection);
          assert.equal(after.runs[0]?.status, "running");
          assert.deepEqual(after.providerTurns, before.providerTurns);
          assert.deepEqual(after.providerSessions, before.providerSessions);
          assert.equal((yield* Ref.get(state)).closedSessionCount, 0);

          // Previously persisted outbox entries retain their captured model.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:queued`),
            threadId,
            createdBy: "user",
            creationSource: "mobile",
            messageId: MessageId.make(`${name}:queued`),
            text: "queued",
            attachments: [],
            modelSelection: seedSelection,
            preserveThreadModelSelection: true,
            dispatchMode: { type: "queue_after_active" },
          });
          const completed = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.ordinal === 2 &&
                event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`${name}:interrupt`),
            threadId,
            runId: before.runs[0]!.id,
          });
          yield* worker.drain();
          yield* Fiber.join(completed);
          yield* worker.drain();
          const queuedFinished = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(queuedFinished.runs[1]?.modelSelection, seedSelection);
          assert.deepEqual(queuedFinished.thread.modelSelection, replacementSelection);

          const inherited = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.ordinal === 3 &&
                event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:inherited`),
            threadId,
            createdBy: "user",
            creationSource: "mobile",
            messageId: MessageId.make(`${name}:inherited`),
            text: "inherit the desktop pick before the phone receives its shell update",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(inherited);
          yield* worker.drain();
          const result = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(result.runs[2]?.modelSelection, replacementSelection);
          assert.deepEqual(result.thread.modelSelection, replacementSelection);
          const captured = yield* Ref.get(state);
          assert.deepEqual(
            captured.started.map((turn) => turn.model),
            [initialSelection.model, seedSelection.model, replacementSelection.model],
          );
          assert.deepEqual(
            captured.opened.map((session) => session.model),
            [initialSelection.model, seedSelection.model, replacementSelection.model],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name },
              ProviderAdapterRegistry.layerSingle(
                makeRestartAdapter(
                  state,
                  mode === "pooled" ? pooledCapabilities : exclusiveCapabilities,
                ),
              ),
            ),
          ),
        );
      }),
    ),
);
