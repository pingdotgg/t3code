import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Partition, Site } from "./suite-env.ts";

export { Site };

export const VOLUME_PATH = "/data";
export const MARKER_FILE = "hello.txt";
export const MARKER = "hello-from-railway-volume";
export const VOLUME_PORT = 3000;

/**
 * Block disk {@link VolumeApi} mounts at {@link VOLUME_PATH}.
 */
export const Data = Railway.Volume("Data", {
  project: Site,
  environment: Partition,
  mountPath: VOLUME_PATH,
});

/**
 * HTTP Service that mounts {@link Data} via {@link Railway.MountVolume}
 * and round-trips a file — the Volume tutorial shape.
 */
export default class VolumeApi extends Railway.Service<VolumeApi>()(
  "VolumeApi",
  {
    project: Site,
    environment: Partition,
    main: import.meta.url,
    port: VOLUME_PORT,
  },
  Effect.gen(function* () {
    const mount = yield* Railway.MountVolume(Data, { path: VOLUME_PATH });
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
        const file = `${mount.path}${url.pathname}`;
        if (request.method === "PUT") {
          const body = yield* request.text;
          yield* fs.writeFileString(file, body).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }
        if (request.method === "GET") {
          const text = yield* fs
            .readFileString(file)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (text === undefined) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          return HttpServerResponse.text(text);
        }
        return HttpServerResponse.text("Hello from Railway!");
      }),
    };
  }).pipe(Effect.provide(Railway.MountVolumeLive)),
) {}
