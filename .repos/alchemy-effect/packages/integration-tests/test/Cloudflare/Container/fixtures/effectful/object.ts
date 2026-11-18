import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MyContainer } from "./container.ts";
import { Storage } from "./storage.ts";

export class Object extends Cloudflare.DurableObject<Object>()(
  "Object",
  Effect.gen(function* () {
    // plan time
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Storage);
    const state = yield* Cloudflare.DurableObjectState;
    const container = yield* MyContainer;

    return Effect.gen(function* () {
      // runtime
      yield* state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)",
      );

      // Starting is idempotent: a no-op once the container is running.
      const start = container.start({ enableInternet: true });
      const conn = yield* container.getTcpPort(3000);

      return {
        // Seed R2 through the DO's NATIVE binding so the container (which reads
        // over its HTTP token) sees a value written by a different binding.
        put: (key: string, value: string) => bucket.put(key, value).pipe(Effect.asVoid),
        get: (key: string) => bucket.get(key),
        ping: () => start.pipe(Effect.andThen(container.ping())),
        // The env var a `Binding.Service` injected into the container.
        boundEnv: () => start.pipe(Effect.andThen(container.boundEnv())),
        // Read the object from inside the container over RPC.
        readObjectRpc: (key: string) => start.pipe(Effect.andThen(container.readObject(key))),
        // Read the object from inside the container over its TCP port (fetch).
        readObjectFetch: (key: string) =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* conn.fetch(
              HttpClientRequest.get(`http://container/object?key=${encodeURIComponent(key)}`),
            );
            return (yield* response.json) as { value: string | null };
          }).pipe(Effect.orDie),
        hello: () =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* conn.fetch(HttpClientRequest.get("http://container/"));
            return yield* response.text;
          }).pipe(Effect.orDie),
      };
    });
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
