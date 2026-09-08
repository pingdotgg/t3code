import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type { Service } from "../workerd/Config.ts";

export class Storage extends Context.Service<Storage, Service>()("Storage") {}

export const make = (filePath: string): Service => ({
  name: "storage",
  disk: {
    path: filePath,
    writable: true,
    allowDotfiles: true,
  },
});

export const layerDisk = (filePath: string) =>
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(filePath, { recursive: true });
      return make(filePath);
    }),
  );

export const layerTemp = (options?: {
  readonly directory?: string | undefined;
  readonly prefix?: string | undefined;
}) =>
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Effect.acquireRelease(
        fs.makeTempDirectory(options),
        (dir) =>
          fs.remove(dir, { recursive: true }).pipe(
            // Windows: workerd may still hold file locks for a moment after
            // shutdown, failing the removal with EBUSY. Retry briefly, then
            // prefer leaking a temp directory over failing the dispose.
            Effect.retry({
              schedule: Schedule.spaced("100 millis"),
              times: 20,
            }),
            Effect.ignore,
          ),
      );
      return make(path);
    }),
  );
