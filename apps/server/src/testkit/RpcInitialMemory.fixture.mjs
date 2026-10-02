import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeAssert from "node:assert/strict";

const root = process.argv[2];
const mode = process.argv[3];
const count = Number(process.argv[4] ?? 4);
const bytes = Number(process.argv[5] ?? 32768);
const require = NodeModule.createRequire(root + "/apps/server/package.json");
const load = (name) => import(NodeURL.pathToFileURL(require.resolve("effect/" + name)));
const [Effect, Stream, Layer, Deferred, Fiber] = await Promise.all(
  ["Effect", "Stream", "Layer", "Deferred", "Fiber"].map(load),
);
const app = (file) => import(NodeURL.pathToFileURL(root + "/apps/server/src/" + file + ".ts"));
const [Prefix, Ws, Threads, Events] = await Promise.all([
  app("rpcInitialItems"),
  app("ws"),
  app("orchestration-v2/ThreadManagementService"),
  app("persistence/Services/OrchestrationEventStore"),
]);
const refs = [];
const fibers = [];
const checkpoints = [];
const deliveredCounts = [];

function history() {
  const value = JSON.parse(JSON.stringify({ text: NodeCrypto.randomBytes(bytes).toString("hex") }));
  refs.push(new WeakRef(value));
  return value;
}

function start(ready) {
  const index = deliveredCounts.push(0) - 1;
  const live = Stream.fromEffect(Deferred.succeed(ready, undefined)).pipe(
    Stream.drain,
    Stream.concat(Stream.never),
  );
  const dependencies = Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: () =>
        Effect.sync(() => ({
          snapshotSequence: 1,
          projection: {
            messages: [history()],
            contextHandoffs: [],
            turnItems: [],
            visibleTurnItems: [],
          },
        })),
      streamStoredEventsFrom: () => live,
    }),
    Layer.mock(Events.OrchestrationEventStore)({
      latestAgentSequence: () => Effect.succeed(1),
      getAgentReplayStats: () =>
        Effect.succeed({
          eventCount: 1,
          rawPayloadBytes: bytes * 2,
          hasCreateEvent: false,
        }),
      readAgentEvents: () =>
        Stream.fromEffect(
          Effect.sync(() => ({
            sequence: 1,
            event: { type: "message.updated", payload: history() },
          })),
        ),
    }),
  );
  const stream =
    mode === "prefix"
      ? Effect.succeed(Stream.concat(Prefix.rpcInitialItems([history()]), live))
      : Ws.subscribeOrchestrationV2Thread({
          threadId: "synthetic-thread",
          requestCompletionMarker: true,
          ...(mode === "replay" ? { afterSequence: 0 } : {}),
        }).pipe(Effect.provide(dependencies));
  let delivered = 0;
  return stream.pipe(
    Effect.flatMap((stream) =>
      stream.pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (mode === "prefix") {
              NodeAssert.equal(item.text.length, bytes * 2);
            } else if (delivered === 0) {
              NodeAssert.equal(item.kind, mode === "replay" ? "event" : "snapshot");
              const value = mode === "replay" ? item.event.payload : item.projection.messages[0];
              NodeAssert.equal(value.text.length, bytes * 2);
            } else {
              NodeAssert.equal(item.kind, "synchronized");
            }
            delivered++;
            deliveredCounts[index] = delivered;
          }),
        ),
        Effect.forkDetach,
      ),
    ),
  );
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) {
      const ready = yield* Deferred.make();
      fibers.push(yield* start(ready));
      yield* Deferred.await(ready);
      NodeAssert.equal(deliveredCounts[i], mode === "prefix" ? 1 : 2);
      if (i === Math.floor(count / 2) - 1 || i === count - 1) {
        yield* Effect.promise(async () => {
          for (let j = 0; j < 3; j++) {
            await new Promise(setImmediate);
            global.gc();
          }
          checkpoints.push({
            subscriptions: fibers.length,
            retained: refs.filter((ref) => ref.deref()).length,
            payloadMiB: ((i + 1) * bytes * 2) / 1048576,
            heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
          });
        });
      }
    }
    for (const fiber of fibers) yield* Fiber.interrupt(fiber);
    return { checkpoints };
  }),
);
console.log(JSON.stringify(result));
