import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  normalizeTerminalOutput,
  TERMINAL_OUTPUT_TAIL_CHARS,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const layerTest = Layer.mergeAll(
  layerTestEventSink,
  IdAllocator.layer,
  CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(layerTestEventSink, layerTestStores))),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const ITEM_ID = TurnItemId.make("turn-item:command");

function applyFrame(
  state: TerminalOutputState,
  frame: OrchestrationV2CommandOutputFrame,
): TerminalOutputState {
  return frame.kind === "replace"
    ? appendTerminalOutput({ ...EMPTY_TERMINAL_OUTPUT, truncated: frame.truncated }, frame.text)
    : appendTerminalOutput(state, frame.text);
}

const seedThread = Effect.gen(function* () {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const projectId = yield* idAllocator.allocate.project({ fixtureName: "command-output" });
  const threadId = yield* idAllocator.allocate.thread({ fixtureName: "command-output", projectId });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Command output",
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: yield* idAllocator.allocate.event({ threadId }),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return threadId;
});

const writeCommandItem = (
  threadId: ThreadId,
  fields: Pick<
    Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
    "status" | "output" | "exitCode"
  >,
) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const settled = fields.status !== "running";
    const item: OrchestrationV2TurnItem = {
      id: ITEM_ID,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: null,
      startedAt: now,
      completedAt: settled ? now : null,
      updatedAt: now,
      type: "command_execution",
      input: "yes | head -n 1000000",
      ...fields,
    };
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "turn-item.updated",
          threadId,
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
  });

const subscribeFrames = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const hub = yield* CommandOutputHub.CommandOutputHub;
    const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame | "ended">();
    yield* hub.subscribe({ threadId, itemId: ITEM_ID }).pipe(
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.andThen(Queue.offer(frames, "ended")),
      Effect.forkScoped,
    );
    return frames;
  });

const takeFrame = (frames: Queue.Queue<OrchestrationV2CommandOutputFrame | "ended">) =>
  Queue.take(frames).pipe(
    Effect.flatMap((frame) =>
      frame === "ended" ? Effect.die("command output stream ended early") : Effect.succeed(frame),
    ),
  );

const layer = it.layer(layerTest);

layer("CommandOutputHub", (it) => {
  it.effect(
    "a late subscriber gets the running tail, then live appends, then the final output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* CommandOutputHub.CommandOutputHub;
          const threadId = yield* seedThread;
          yield* writeCommandItem(threadId, { status: "running" });
          yield* hub.append({
            threadId,
            itemId: ITEM_ID,
            chunk: "\u001b[32mbuilding\u001b[0m\n10%",
          });
          yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "\r55%\u001b[3" });

          const frames = yield* subscribeFrames(threadId);
          const first = yield* takeFrame(frames);
          assert.equal(first.kind, "replace");
          assert.isTrue(first.running);
          let client = applyFrame(EMPTY_TERMINAL_OUTPUT, first);
          assert.equal(client.text, "\u001b[0;32mbuilding\u001b[0m\n55%");

          yield* TestClock.adjust("1 second");
          yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "1m" });
          yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "\r100%\u001b[0m\ndone\n" });
          const append = yield* takeFrame(frames);
          assert.equal(append.kind, "append");
          client = applyFrame(client, append);
          assert.equal(
            client.text,
            normalizeTerminalOutput(
              "\u001b[32mbuilding\u001b[0m\n10%\r55%\u001b[31m\r100%\u001b[0m\ndone\n",
            ).text,
          );

          yield* TestClock.adjust("1 second");
          yield* writeCommandItem(threadId, {
            status: "completed",
            exitCode: 0,
            output: "building\n100%\ndone\n",
          });
          const final = yield* takeFrame(frames);
          assert.deepEqual(final, {
            kind: "replace",
            text: "building\n100%\ndone\n",
            truncated: false,
            running: false,
          });
          assert.equal(yield* Queue.take(frames), "ended");
        }),
      ),
  );

  it.effect("a row that is not a known command fails instead of waiting forever", () =>
    Effect.gen(function* () {
      const hub = yield* CommandOutputHub.CommandOutputHub;
      const threadId = yield* seedThread;
      const error = yield* hub
        .subscribe({ threadId, itemId: ITEM_ID })
        .pipe(Stream.runDrain, Effect.flip);
      assert.equal(error._tag, "OrchestrationV2CommandOutputError");
      assert.equal(error.message, "No such command.");
    }),
  );

  it.effect("a viewer whose command was evicted for newer ones is resynced, not appended to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running" });
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "abc" });
        const frames = yield* subscribeFrames(threadId);
        let client = applyFrame(EMPTY_TERMINAL_OUTPUT, yield* takeFrame(frames));
        assert.equal(client.text, "abc");
        for (let index = 0; index < 64; index += 1) {
          yield* hub.append({
            threadId,
            itemId: TurnItemId.make(`turn-item:other-${index}`),
            chunk: "x",
          });
        }
        yield* TestClock.adjust("1 second");
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "\rX" });
        const next = yield* takeFrame(frames);
        assert.equal(next.kind, "replace");
        client = applyFrame(client, next);
        assert.equal(client.text, "X");
      }),
    ),
  );

  it.effect("a finished command sends only its bounded final output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        const huge = Array.from({ length: 400_000 }, (_, index) => `line ${index}`).join("\n");
        yield* writeCommandItem(threadId, { status: "failed", exitCode: 1, output: huge });
        const frames = yield* subscribeFrames(threadId);
        const final = yield* takeFrame(frames);
        assert.equal(final.kind, "replace");
        assert.isFalse(final.running);
        assert.isTrue(final.truncated);
        assert.isAtMost(final.text.length, TERMINAL_OUTPUT_TAIL_CHARS);
        assert.isTrue(final.text.endsWith("line 399999"));
        assert.equal(yield* Queue.take(frames), "ended");
      }),
    ),
  );

  it.effect("a finished command whose output is one huge line still shows its tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        const line = "x".repeat(TERMINAL_OUTPUT_TAIL_CHARS * 8);
        yield* writeCommandItem(threadId, {
          status: "completed",
          exitCode: 0,
          output: `${line}\n`,
        });
        const frames = yield* subscribeFrames(threadId);
        const final = yield* takeFrame(frames);
        assert.equal(final.kind, "replace");
        assert.isTrue(final.truncated);
        assert.isTrue(final.text.includes("xxxx"));
        assert.isAtMost(final.text.length, TERMINAL_OUTPUT_TAIL_CHARS);
      }),
    ),
  );

  it.effect("an old Claude row's raw Bash result shows as its stdout and stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, {
          status: "completed",
          exitCode: 0,
          output: '{"stdout":"built","stderr":"1 warning","interrupted":false}',
        });
        const frames = yield* subscribeFrames(threadId);
        const final = yield* takeFrame(frames);
        assert.equal(final.text, "built\n1 warning");
      }),
    ),
  );

  it.effect("providers that only report output in item snapshots still stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running", output: "step 1\n" });
        const frames = yield* subscribeFrames(threadId);
        assert.equal((yield* takeFrame(frames)).text, "step 1\n");
        yield* TestClock.adjust("1 second");
        yield* writeCommandItem(threadId, { status: "running", output: "step 1\nstep 2\n" });
        const update = yield* takeFrame(frames);
        assert.deepEqual(update, {
          kind: "replace",
          text: "step 1\nstep 2\n",
          truncated: false,
          running: true,
        });
      }),
    ),
  );

  it.effect("an interrupted command ends the stream with the output it printed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, { status: "running" });
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: "waiting for server\n" });
        const frames = yield* subscribeFrames(threadId);
        yield* takeFrame(frames);
        yield* TestClock.adjust("1 second");
        // Some providers omit stopped-command output; the live tail is released before the settled item persists.
        yield* hub.finish({ threadId, itemId: ITEM_ID });
        yield* writeCommandItem(threadId, { status: "interrupted" });
        const final = yield* takeFrame(frames);
        assert.deepEqual(final, {
          kind: "replace",
          text: "waiting for server\n",
          truncated: false,
          running: false,
        });
        assert.equal(yield* Queue.take(frames), "ended");
      }),
    ),
  );
});
