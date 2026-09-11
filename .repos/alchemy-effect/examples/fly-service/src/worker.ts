import * as Fly from "alchemy/Fly";
import { ServerHost } from "alchemy/Server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MARKER, MARKER_FILE, Site, VOLUME_PATH } from "./shared.ts";

/**
 * Background Service: mounts a per-replica disk at `/data` and writes a
 * marker file. No public proxy ports — {@link Api} is the HTTP surface.
 */
export default class Worker extends Fly.Service<Worker>()(
  "Worker",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
    services: [],
  },
  Effect.gen(function* () {
    const mount = yield* Fly.MountVolume({ path: VOLUME_PATH, sizeGb: 1 });
    const host = yield* ServerHost;
    const fs = yield* FileSystem.FileSystem;

    yield* host.run(
      Effect.gen(function* () {
        yield* fs.makeDirectory(mount.path, { recursive: true });
        yield* fs.writeFileString(MARKER_FILE, MARKER);
        return yield* Effect.never;
      }).pipe(Effect.orDie),
    );
  }).pipe(Effect.provide(Fly.MountVolumeLive)),
) {}
