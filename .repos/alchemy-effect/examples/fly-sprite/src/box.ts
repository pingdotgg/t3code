import * as Fly from "alchemy/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * HTTP Sprite. Yield FileSystem in init, not inside fetch.
 * Config.redacted is written onto the Sprite at deploy time.
 */
export default class Box extends Fly.Sprite<Box>()(
  "Box",
  {
    main: import.meta.url,
    urlAuth: "public",
    port: 3000,
  },
  Effect.gen(function* () {
    const marker = yield* Config.string("SPRITE_MARKER").pipe(
      Config.withDefault("hello-from-fly-sprite"),
    );
    const apiKey = yield* Config.redacted("API_KEY").pipe(
      Config.withDefault(Redacted.make("unused")),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory("/tmp", { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString("/tmp/marker.txt", marker).pipe(Effect.orDie);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://sprite");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        void Redacted.value(apiKey);
        return yield* HttpServerResponse.json({
          ok: true,
          marker,
        });
      }),
    };
  }),
) {}
