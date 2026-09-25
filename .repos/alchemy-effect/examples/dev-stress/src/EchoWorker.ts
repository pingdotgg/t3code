import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ECHO_MARKER } from "./echo/marker.ts";
import { PORTS } from "./ports.ts";
import SandboxDO from "./SandboxDO.ts";
// <<ECHO_IMPORTS>>
// <</ECHO_IMPORTS>>

/**
 * Effect-native Worker declared with `main: import.meta.url` — the shape
 * where the STACK PROCESS imports the worker's own source. Editing this
 * module (or anything it imports, e.g. `./echo/marker.ts`) is therefore
 * seen by `bun --watch`, so a hot swap is followed by a full stack re-run.
 * `api-worker.ts` covers the other path, where it is not.
 *
 * The `<<ECHO_BINDINGS>>` / `<<ECHO_ROUTES>>` regions are where the stress
 * suite grows and shrinks this worker's binding set at runtime: new
 * resources, new event sources, and new Durable Object classes (which
 * carry class migrations) are added to a LIVE worker and removed again.
 *
 * Routes:
 *   - `GET /marker`   → the marker constant (proof a reload landed)
 *   - `GET /kv`       → KV put/get roundtrip through the local simulator
 *   - `GET /r2`       → R2 put/get/list roundtrip
 *   - `GET /counter`  → Durable Object increment (state survives reloads)
 *   - `GET /sandbox`  → proxied into the local Cloudflare Container
 */
export default class EchoWorker extends Cloudflare.Worker<EchoWorker>()(
  "EchoWorker",
  {
    main: import.meta.url,
    // Pinned so the stress suite can probe this worker even while the stack
    // module is in a broken state and the CLI prints no outputs.
    dev: { port: PORTS.echo, strictPort: true },
  },
  Effect.gen(function* () {
    const kvNamespace = yield* Cloudflare.KV.Namespace("EchoKV");
    const bucket = yield* Cloudflare.R2.Bucket("EchoBucket", {
      forceDestroy: true,
    });
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(kvNamespace);
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    const counters = yield* Counter;
    const sandbox = yield* SandboxDO;
    // <<ECHO_BINDINGS>>
    // <</ECHO_BINDINGS>>

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://echo");

        if (url.pathname === "/marker") {
          return yield* HttpServerResponse.json({ marker: ECHO_MARKER });
        }

        if (url.pathname === "/kv") {
          const key = url.searchParams.get("key") ?? "hello";
          yield* kv.put(key, `kv:${key}`).pipe(Effect.orDie);
          const value = yield* kv.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        if (url.pathname === "/r2") {
          const key = url.searchParams.get("key") ?? "hello.txt";
          yield* r2.put(key, "hello from r2").pipe(Effect.orDie);
          const object = yield* r2.get(key).pipe(Effect.orDie);
          const text = object ? yield* object.text().pipe(Effect.orDie) : null;
          const { objects } = yield* r2.list().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            text,
            keys: objects.map((o) => o.key),
          });
        }

        if (url.pathname === "/counter") {
          const name = url.searchParams.get("name") ?? "default";
          const count = yield* counters.getByName(name).increment();
          return yield* HttpServerResponse.json({ count });
        }

        if (url.pathname.startsWith("/sandbox")) {
          return yield* sandbox
            .getByName("stress")
            .fetch(request)
            .pipe(Effect.orDie);
        }

        // <<ECHO_ROUTES>>
        // <</ECHO_ROUTES>>

        return yield* HttpServerResponse.json({ marker: ECHO_MARKER });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      // <<ECHO_LAYERS>>
      // <</ECHO_LAYERS>>
    ]),
  ),
) {}

/**
 * Durable Object state is the stress suite's proof that a hot reload
 * REPLACED CODE rather than recreating the resource: the counter keeps
 * climbing across every worker-source edit.
 */
export class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        increment: Effect.fn(function* () {
          const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
          yield* state.storage.put("count", count);
          return count;
        }),
      };
    }),
  ),
) {}

// <<ECHO_CLASSES>>
// <</ECHO_CLASSES>>
