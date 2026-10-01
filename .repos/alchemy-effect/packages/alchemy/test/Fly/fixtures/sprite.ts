import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * HTTP Sprite: writes a marker during init and serves it back.
 */
export default class Box extends Fly.Sprite<Box>()(
  "Box",
  {
    main: import.meta.url,
    urlAuth: "public",
    port: 3000,
  },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://sprite");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        yield* fs.makeDirectory("/tmp", { recursive: true }).pipe(Effect.orDie);
        yield* fs
          .writeFileString("/tmp/alchemy-sprite.txt", "hello-from-sprite")
          .pipe(Effect.orDie);
        const text = yield* fs
          .readFileString("/tmp/alchemy-sprite.txt")
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          ok: true,
          text,
        });
      }),
    };
  }),
) {}
