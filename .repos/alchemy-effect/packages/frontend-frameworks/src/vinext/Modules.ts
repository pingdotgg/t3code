import * as Effect from "effect/Effect";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ModuleLoadError,
  resolveProjectPackageDirectory,
} from "../core/Loader.ts";

/** Vinext exposes import-only entrypoints that require.resolve cannot resolve. */
export const loadVinextModule = <T>(root: string, file: string) =>
  resolveProjectPackageDirectory(root, "vinext").pipe(
    Effect.flatMap((directory) =>
      Effect.tryPromise({
        try: () =>
          import(
            /* @vite-ignore */ pathToFileURL(join(directory, "dist", file)).href
          ) as Promise<T>,
        catch: (cause) =>
          new ModuleLoadError({ root, specifier: `vinext/${file}`, cause }),
      }),
    ),
  );
