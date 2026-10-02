import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const root = process.argv[2];
const count = Number(process.argv[3] ?? 4);
const bytes = Number(process.argv[4] ?? 32768);
const require = NodeModule.createRequire(root + "/packages/shared/package.json");
const load = (name) => import(NodeURL.pathToFileURL(require.resolve("effect/" + name)));
const [Effect, Cache, Tracer] = await Promise.all(["Effect", "Cache", "Tracer"].map(load));
const { makeLocalFileTracer } = await import(
  NodeURL.pathToFileURL(root + "/packages/shared/src/observability.ts")
);
const refs = [];
let exported = 0;
const tracer = await Effect.runPromise(
  makeLocalFileTracer({
    filePath: "unused",
    maxBytes: 1024,
    maxFiles: 1,
    batchWindowMs: 10000,
    sink: {
      filePath: "unused",
      push(record) {
        NodeAssert.deepEqual(record.exit, { _tag: "Success" });
        exported++;
      },
      flush: Effect.void,
      close: () => Effect.void,
    },
  }),
);
// Like the SQLite prepared statement cache, lookup fibers remain alive after use.
const cache = await Effect.runPromise(
  Cache.make({ capacity: count, timeToLive: "10 minutes", lookup: (key) => Effect.succeed(key) }),
);

async function read(index) {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const projection = JSON.parse(
        JSON.stringify({
          turnItems: [{ output: [{ text: NodeCrypto.randomBytes(bytes).toString("hex") }] }],
        }),
      );
      refs.push(new WeakRef(projection));
      yield* Cache.get(cache, index);
      return projection;
    }).pipe(
      Effect.withSpan("read-thread-projection"),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  );
  NodeAssert.equal(result.turnItems[0].output[0].text.length, bytes * 2);
}

for (let index = 0; index < count; index++) await read(index);
for (let index = 0; index < 3; index++) {
  await new Promise(setImmediate);
  global.gc();
}
console.log(
  JSON.stringify({
    cacheSize: await Effect.runPromise(Cache.size(cache)),
    retained: refs.filter((ref) => ref.deref()).length,
    exported,
    payloadMiB: (count * bytes * 2) / 1048576,
    heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
  }),
);
