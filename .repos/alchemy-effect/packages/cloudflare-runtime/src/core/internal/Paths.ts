import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { SystemError } from "../RuntimeError.shared.ts";
import * as System from "./System.ts";

export class Paths extends Context.Service<
  Paths,
  {
    readonly cache: (
      ...prefix: Array<string>
    ) => Effect.Effect<string, SystemError>;
    readonly config: (
      ...prefix: Array<string>
    ) => Effect.Effect<string, SystemError>;
    readonly data: (
      ...prefix: Array<string>
    ) => Effect.Effect<string, SystemError>;
    readonly state: (
      ...prefix: Array<string>
    ) => Effect.Effect<string, SystemError>;
  }
>()("cloudflare-runtime/Paths") {}

export const PathsLive = Layer.effect(
  Paths,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* System.home;

    const makeWith =
      (options: { env: string; fallback: Array<string> }) =>
      (...prefix: Array<string>) =>
        Config.string(options.env).pipe(
          Effect.orElseSucceed(() => path.join(home, ...options.fallback)),
          Effect.map((root) => path.join(root, ...prefix)),
          Effect.tap((path) =>
            fs.makeDirectory(path, { recursive: true }).pipe(
              Effect.catchTag(
                "PlatformError",
                (error) =>
                  new SystemError({
                    subtag: "Paths",
                    message: `Failed to create directory "${path}".`,
                    cause: error,
                    detail: { path, env: options.env },
                  }),
              ),
            ),
          ),
        );

    return Paths.of({
      cache: makeWith({ env: "XDG_CACHE_HOME", fallback: [".cache"] }),
      config: makeWith({ env: "XDG_CONFIG_HOME", fallback: [".config"] }),
      data: makeWith({ env: "XDG_DATA_HOME", fallback: [".local", "share"] }),
      state: makeWith({ env: "XDG_STATE_HOME", fallback: [".local", "state"] }),
    });
  }),
);

export const data = (...prefix: Array<string>) =>
  Paths.use((Paths) => Paths.data(...prefix));

export const config = (...prefix: Array<string>) =>
  Paths.use((Paths) => Paths.config(...prefix));

export const cache = (...prefix: Array<string>) =>
  Paths.use((Paths) => Paths.cache(...prefix));

export const state = (...prefix: Array<string>) =>
  Paths.use((Paths) => Paths.state(...prefix));
