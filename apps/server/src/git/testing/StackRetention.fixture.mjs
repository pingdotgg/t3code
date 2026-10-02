import { Cache, Effect } from "effect";
import { detachStackFrame } from "../detachStackFrame.ts";
// `original` runs the bare Effect Cache to show the leak this helper prevents.
const original = process.argv.includes("original");
const failure = process.argv.includes("failure");
const lookup = () => (failure ? Effect.fail("unavailable") : Effect.succeed(1));
const cache = await Effect.runPromise(
  Cache.makeWith(lookup, { capacity: 8, timeToLive: () => "1 hour" }),
);
const get = () => (original ? Cache.get(cache, "key") : detachStackFrame(Cache.get(cache, "key")));
let reference;
await Effect.runPromise(
  Effect.gen(function* () {
    const snapshot = { values: Array.from({ length: 250000 }, (_, i) => i) };
    reference = new WeakRef(snapshot);
    const request = Effect.fn("StackRetention.request")(function* () {
      yield* Effect.exit(get());
      return snapshot.values.length;
    });
    yield* request();
  }),
);
for (let i = 0; i < 12; i++) {
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
}
const retained = reference.deref() !== undefined;
const cachedResult = await Effect.runPromise(
  get().pipe(Effect.catch(() => Effect.succeed("unavailable"))),
);
process.stdout.write(JSON.stringify({ retained, cachedResult }));
