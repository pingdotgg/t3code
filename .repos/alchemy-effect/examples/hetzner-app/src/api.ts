import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Box, Data, MARKER_FILE, VOLUME_PATH } from "./shared.ts";

/**
 * HTTP Service: mounts the shared Volume and serves the marker file
 * {@link Worker} writes.
 */
export default class Api extends Hetzner.Service<Api>()(
  "Api",
  {
    server: Box,
    main: import.meta.url,
    port: API_PORT,
  },
  Effect.gen(function* () {
    const volume = yield* Data;
    const mount = yield* Hetzner.MountVolume(volume, { path: VOLUME_PATH });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({
            ok: true,
            path: mount.path,
          });
        }
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(MARKER_FILE).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          path: mount.path,
          device: mount.device,
          text,
        });
      }),
    };
  }).pipe(Effect.provide(Hetzner.MountVolumeLive)),
) {}
