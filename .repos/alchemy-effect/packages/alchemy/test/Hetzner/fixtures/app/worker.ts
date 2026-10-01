import * as Hetzner from "@/Hetzner";
import { ServerHost } from "@/Server/Process.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Box, Data, MARKER, MARKER_FILE, VOLUME_PATH } from "./shared.ts";

/**
 * Background Service: mounts the shared Volume and writes a marker file
 * that {@link Api} reads over HTTP.
 */
export default class Worker extends Hetzner.Service<Worker>()(
  "Worker",
  {
    server: Box,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const volume = yield* Data;
    const mount = yield* Hetzner.MountVolume(volume, { path: VOLUME_PATH });
    const host = yield* ServerHost;

    yield* host.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(mount.path, { recursive: true });
        yield* fs.writeFileString(MARKER_FILE, MARKER);
        return yield* Effect.never;
      }).pipe(Effect.orDie),
    );
  }).pipe(Effect.provide(Hetzner.MountVolumeLive)),
) {}
