import {
  Framework,
  FrameworkError,
  readBuildOutput,
  writeBuildOutput,
  type BuildOutput,
  type DeployTargetServer,
} from "@alchemy.run/frontend-frameworks/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { makeCloudflareTarget } from "./CloudflareTarget.ts";
import { Cwd } from "./Cwd.ts";
import * as Options from "./Options.ts";

export interface Instance {
  url: URL;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchText(path: string, init?: RequestInit): Promise<string>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  dispose(): Promise<void>;
}

declare namespace Instance {
  type Raw = Omit<Instance, "dispose">;
}

export class Server extends Context.Service<
  Server,
  {
    readonly live: () => Effect.Effect<
      Instance.Raw,
      FrameworkError,
      Scope.Scope
    >;
    readonly dev: () => Effect.Effect<
      Instance.Raw,
      FrameworkError,
      Scope.Scope
    >;
  }
>()("@alchemy.run/cloudflare-test-tools/e2e/Server") {}

/**
 * Where the harness persists a fixture's `BuildOutput`, relative to the
 * fixture root. Persistence is the harness's E2E mechanism (preview serves
 * from it) — it is NOT part of the `Framework` contract; `Framework.build`
 * returns the `BuildOutput` purely in-memory.
 */
export const BUILD_OUTPUT_FILE = "dist/build.json";

/**
 * Run `Framework.build` and persist the returned `BuildOutput` to
 * {@link BUILD_OUTPUT_FILE} (framework-core's `writeBuildOutput`), so
 * `preview` can serve it without rebuilding.
 *
 * The fixture's `Options.root` (if any) is resolved against the harness cwd
 * and threaded into `Framework.build` as `FrameworkBuildOptions.root`; the
 * persisted `dist/build.json` stays anchored at the fixture root regardless.
 */
export const buildAndPersist: Effect.Effect<
  BuildOutput,
  FrameworkError,
  Framework | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const framework = yield* Framework;
  const path = yield* Path.Path;
  const cwd = yield* Cwd;
  const options = yield* Options.load().pipe(
    Effect.mapError(
      (cause) =>
        new FrameworkError({ message: "Failed to load e2e.config.ts", cause }),
    ),
  );
  const root = yield* Options.resolveRoot(options);
  const output = yield* framework.build(
    root !== undefined ? { root } : undefined,
  );
  yield* writeBuildOutput(path.resolve(cwd, BUILD_OUTPUT_FILE), output).pipe(
    Effect.mapError(
      (cause) =>
        new FrameworkError({ message: "Failed to write build.json", cause }),
    ),
  );
  return output;
});

/** Wrap a target's serve result (or any base URL) into fetch helpers. */
const toInstance = (server: DeployTargetServer): Instance.Raw => {
  const url = new URL(server.url);
  const baseFetch =
    server.fetch ??
    ((path: string, init?: RequestInit) => fetch(new URL(path, url), init));
  return {
    url,
    fetch: baseFetch,
    fetchText: (path: string, init?: RequestInit) =>
      baseFetch(path, init).then((response) => response.text()),
    fetchJson: <T>(path: string, init?: RequestInit) =>
      baseFetch(path, init).then((response) => response.json() as Promise<T>),
  };
};

export const layer = Layer.effect(
  Server,
  Effect.gen(function* () {
    const framework = yield* Framework;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Cwd;
    const options = yield* Options.load();
    // The deploy target for this fixture. Only the cloudflare target exists
    // today; `Options.TargetOptions` is where another platform would be
    // selected.
    const target = makeCloudflareTarget(
      Options.resolveCloudflareOptions(options),
    );
    // The fixture's project root (Options.root resolved against the harness
    // cwd) — threaded into Framework.dev; buildAndPersist resolves it itself.
    const root = yield* Options.resolveRoot(options);

    const buildJsonPath = path.resolve(cwd, BUILD_OUTPUT_FILE);
    const persistedBuild = buildAndPersist.pipe(
      Effect.provideService(Framework, framework),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    const live = () =>
      readBuildOutput(buildJsonPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.catch(() => persistedBuild),
        Effect.flatMap((build) =>
          target.serve({ root: cwd, output: build }).pipe(
            Effect.map(toInstance),
            Effect.mapError(
              (error) =>
                new FrameworkError({
                  message: error.message,
                  cause: error.cause,
                }),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        ),
      );

    const dev = () =>
      framework
        .dev(root !== undefined ? { root } : undefined)
        .pipe(Effect.map(toInstance));

    return Server.of({
      live,
      dev,
    });
  }),
);
