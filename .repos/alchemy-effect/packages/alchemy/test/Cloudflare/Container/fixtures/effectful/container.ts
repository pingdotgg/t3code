import * as Cloudflare from "@/Cloudflare";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Storage } from "./storage.ts";

export class MyContainer extends Cloudflare.Container<
  MyContainer,
  {
    ping: () => Effect.Effect<string>;
    /** Read an object's text body from R2 (or `null` when absent). */
    readObject: (
      key: string,
    ) => Effect.Effect<string | null, never, RuntimeContext>;
  }
>()("EffectfulContainer") {}

export default MyContainer.make(
  {
    main: import.meta.url,
    image: "oven/bun:latest",
  },
  Effect.gen(function* () {
    // The container reads R2 over a scoped HTTP API token (not the native
    // Worker binding) — this proves the HTTP R2 client works from inside a
    // container process.
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Storage);

    const read = (key: string) =>
      bucket.get(key).pipe(
        Effect.flatMap((object) =>
          object ? object.text() : Effect.succeed(null),
        ),
        Effect.orDie,
      );

    return {
      ping: () => Effect.succeed("pong"),
      readObject: read,
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/object") {
          const key = url.searchParams.get("key") ?? "";
          const value = yield* read(key);
          return yield* HttpServerResponse.json({ value });
        }
        return HttpServerResponse.text("hello from effectful container");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketHttp)),
);
