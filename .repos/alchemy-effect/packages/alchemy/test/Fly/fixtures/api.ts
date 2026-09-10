import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, MARKER, MARKER_FILE, Site, VOLUME_PATH } from "./shared.ts";

/**
 * HTTP Service: mounts a per-replica disk, writes a marker, and serves it back.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const mount = yield* Fly.MountVolume({ path: VOLUME_PATH, sizeGb: 1 });
    const fs = yield* FileSystem.FileSystem;

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
        yield* fs
          .makeDirectory(mount.path, { recursive: true })
          .pipe(Effect.orDie);
        yield* fs.writeFileString(MARKER_FILE, MARKER).pipe(Effect.orDie);
        const text = yield* fs.readFileString(MARKER_FILE).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({
          path: mount.path,
          text,
        });
      }),
    };
  }).pipe(Effect.provide(Fly.MountVolumeLive)),
) {}
