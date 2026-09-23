import { Cache, Effect, Exit, Scope } from "effect";
import * as LookupResultCache from "../LookupResultCache.ts";
const scope = Effect.runSync(Scope.make());
const original = process.argv[2] === "original";
const failure = process.argv.includes("failure");
const lookup = () => (failure ? Effect.fail("unavailable") : Effect.succeed(1));
const cache = await Effect.runPromise(
  original
    ? Cache.makeWith(lookup, { capacity: 8, timeToLive: () => "1 hour" })
    : LookupResultCache.make(lookup, {
        capacity: 8,
        timeToLive: () => "1 hour",
      }).pipe(Effect.provideService(Scope.Scope, scope)),
);
let reference;
async function populate() {
  await Effect.runPromise(
    Effect.gen(function* () {
      const snapshot = { values: Array.from({ length: 250000 }, (_, i) => i) };
      reference = new WeakRef(snapshot);
      const request = Effect.fn("LookupRetention.request")(function* () {
        yield* Effect.exit(original ? Cache.get(cache, "key") : cache.get("key"));
        return snapshot.values.length;
      });
      yield* request();
    }),
  );
}
await populate();
for (let i = 0; i < 12; i++) {
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
}
const retained = reference.deref() !== undefined;
const cachedResult = await Effect.runPromise(
  (original ? Cache.get(cache, "key") : cache.get("key")).pipe(
    Effect.catch(() => Effect.succeed("unavailable")),
  ),
);
await Effect.runPromise(Scope.close(scope, Exit.void));
process.stdout.write(JSON.stringify({ retained, cachedResult }));
