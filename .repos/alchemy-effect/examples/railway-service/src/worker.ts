import * as Railway from "alchemy/Railway";
import { ServerHost } from "alchemy/Server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Disk, MARKER, MARKER_FILE, Site, VOLUME_PATH } from "./shared.ts";

/**
 * Background Service: mounts {@link Disk} at `/data` and writes a
 * marker file. Hosted Services default to a `/health` probe, so this
 * still answers HTTP there — {@link Api} is the public surface.
 */
export default class Worker extends Railway.Service<Worker>()(
  "Worker",
  {
    project: Site,
    main: import.meta.url,
    port: 3000,
    healthcheck: "/health",
  },
  Effect.gen(function* () {
    const mount = yield* Railway.MountVolume(Disk, { path: VOLUME_PATH });
    const host = yield* ServerHost;
    const fs = yield* FileSystem.FileSystem;

    yield* host.run(
      Effect.gen(function* () {
        yield* fs.makeDirectory(mount.path, { recursive: true });
        yield* fs.writeFileString(MARKER_FILE, MARKER);
        return yield* Effect.never;
      }).pipe(Effect.orDie),
    );
    return {
      fetch: HttpServerResponse.json({ ok: true }),
    };
  }).pipe(Effect.provide(Railway.MountVolumeLive)),
) {}
