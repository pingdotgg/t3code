import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
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

      const conn = yield* container.getTcpPort(3000);

      return {
        // Seed R2 through the DO's NATIVE binding so the container (which reads
        // over its HTTP token) sees a value written by a different binding.
        put: (key: string, value: string) =>
          bucket.put(key, value).pipe(Effect.asVoid),
        get: (key: string) => bucket.get(key),
        ping: () => container.ping(),
        // Read the object from inside the container over RPC.
        readObjectRpc: (key: string) => container.readObject(key),
        // Read the object from inside the container over its TCP port (fetch).
        readObjectFetch: (key: string) =>
          Effect.gen(function* () {
            const response = yield* conn.fetch(
              HttpClientRequest.get(
                `http://container/object?key=${encodeURIComponent(key)}`,
              ),
            );
            return (yield* response.json) as { value: string | null };
          }).pipe(Effect.orDie),
        hello: () =>
          Effect.gen(function* () {
            const response = yield* conn.fetch(
              HttpClientRequest.get("http://container/"),
            );
            return yield* response.text;
          }).pipe(Effect.orDie),
      };
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Containers.layer(MyContainer, {
          enableInternet: true,
        }),
      ),
    ),
  ),
) {}
