import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { finishNeonOutput, makeNeonTarget } from "../core/NeonServe.ts";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { DeployTargetError } from "../core/DeployTarget.ts";
import { FrameworkError, type FrameworkDevOptions } from "../core/Framework.ts";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isInsideDevChild, runDevChild } from "../core/DevChild.ts";
import { runBuildChild } from "../core/BuildChild.ts";
import { Framework } from "../core/Framework.ts";
import { make as makeVocsLayer } from "./Vocs.ts";
import type { Plugin } from "vite";
import {
  make as makeNode,
  makeNodeTarget,
  type VocsNodeFrameworkOptions,
} from "./node.ts";

// Preserve config imports and closures; only the dev-only Vite loader is removed.
const runtimeConfigPlugin = (): Plugin => ({
  name: "alchemy:vocs-neon-runtime-config",
  enforce: "post",
  transform(code, id) {
    const file = id.replaceAll("\\", "/").split("?")[0];
    if (file?.endsWith("/vocs/dist/internal/mdx.js")) {
      const logger =
        /const logger = createLogger\(undefined, \{ allowClearScreen: false, prefix: '\[vocs\]' \}\);/;
      if (
        !logger.test(code) ||
        !code.includes("import { createLogger } from 'vite';")
      )
        throw new Error(
          "Vocs MDX logger changed; update the Neon runtime bridge.",
        );
      return code
        .replace("import { createLogger } from 'vite';", "")
        .replace(
          logger,
          'const logger = { warn: (message) => console.warn("[vocs]", message), error: (message) => console.error("[vocs]", message) };',
        );
    }
    if (!file?.endsWith("/vocs/dist/internal/config.js")) return;
    const pattern =
      /export async function resolve\(options = \{\}\) \{[\s\S]*?\n\}\n(?=export let global;)/;
    if (!pattern.test(code))
      throw new Error(
        "Vocs runtime config shape changed; update the Neon config bridge.",
      );
    return code.replace(
      pattern,
      "export async function resolve() {\n" +
        '  const resolved = (await import("virtual:alchemy-vocs/user-config")).default;\n' +
        "  return define(resolved);\n}\n",
    );
  },
});

export const buildInChild = (config: { root: string }) =>
  Effect.gen(function* () {
    const node = makeNodeTarget();
    const framework = yield* Framework.pipe(
      Effect.provide(
        makeVocsLayer({
          root: config.root,
          target: {
            ...node,
            build: undefined,
            vitePlugins: (context) =>
              node
                .vitePlugins(context)
                .pipe(
                  Effect.map((plugins) => [...plugins, runtimeConfigPlugin()]),
                ),
          },
        }),
      ),
    );
    return yield* framework
      .build({ root: config.root })
      .pipe(Effect.flatMap(finishNeonOutput));
  });

/** Vocs production output served by a Neon Fetch handler. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) => ({
  ...makeNeonTarget(makeNodeTarget(config)),
  build: (
    context: Parameters<
      NonNullable<ReturnType<typeof makeNodeTarget>["build"]>
    >[0],
  ) =>
    runBuildChild({
      runtime: "node",
      module: import.meta.url,
      rootDir: context.root,
      config: { root: context.root },
      framework: "vocs",
      env: context.env,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DeployTargetError({
            platform: "neon",
            message: cause.message,
            cause,
          }),
      ),
    ),
});
export default target;

/** Native Vocs development with Neon-compatible production output. */
export const make = Effect.fn(function* (
  options: VocsNodeFrameworkOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* makeNode(options);
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem)(fs),
    Layer.succeed(Path.Path)(path),
  );
  return {
    dev: Effect.fn(function* (devOptions?: FrameworkDevOptions) {
      const root = yield* Effect.sync(() =>
        path.resolve(devOptions?.root ?? options.root ?? process.cwd()),
      );
      if (isInsideDevChild()) {
        const fail = (cause: unknown) =>
          new FrameworkError({
            framework: "vocs",
            message: "Failed to start the native Vocs dev server",
            cause,
          });
        const modules = yield* Effect.try({
          try: () => {
            const project = createRequire(path.join(root, "package.json"));
            const vocs = project.resolve("vocs/vite");
            const require = createRequire(vocs);
            return {
              vocs: pathToFileURL(vocs).href,
              vite: pathToFileURL(require.resolve("vite")).href,
              react: pathToFileURL(require.resolve("@vitejs/plugin-react"))
                .href,
            };
          },
          catch: fail,
        });
        // All plugins must share Vocs's Vite instance for runnable SSR environments.
        const vite = yield* Effect.tryPromise({
          try: () => import(modules.vite) as Promise<typeof import("vite")>,
          catch: fail,
        });
        const react = yield* Effect.tryPromise({
          try: () =>
            import(modules.react) as Promise<
              typeof import("@vitejs/plugin-react")
            >,
          catch: fail,
        });
        const vocs = yield* Effect.tryPromise({
          try: () =>
            import(modules.vocs) as Promise<typeof import("vocs/vite")>,
          catch: fail,
        });
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              vite.createServer({
                root,
                configFile: false,
                plugins: [react.default(), vocs.vocs()],
                server: {
                  host: devOptions?.host,
                  port: devOptions?.port,
                  strictPort: devOptions?.port !== undefined,
                },
              }),
            catch: fail,
          }),
          (server) => Effect.promise(() => server.close()),
        );
        yield* Effect.tryPromise({ try: () => server.listen(), catch: fail });
        const url =
          server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
        if (!url)
          return yield* Effect.fail(
            fail(new Error("Vocs did not report a dev URL")),
          );
        return { url };
      }
      return yield* runDevChild({
        // Vocs's Vite dev server (like its build) exhausts memory under
        // Bun; run the dev child under Node from PATH.
        runtime: "node",
        framework: "vocs",
        module: import.meta.url,
        callerUrl: import.meta.url,
        rootDir: root,
        makeOptions: { ...options, root },
        devOptions: { ...devOptions, root },
      });
    }),
    build: (buildOptions?: {
      readonly root?: string;
    }): Effect.Effect<BuildOutput, FrameworkError | DeployTargetError> =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(() =>
          path.resolve(buildOptions?.root ?? options.root ?? process.cwd()),
        );
        return yield* target().build({ root, framework: "vocs" });
      }).pipe(Effect.provide(services)),
  };
});
