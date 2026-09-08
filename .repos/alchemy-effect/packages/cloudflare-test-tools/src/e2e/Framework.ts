import {
  Framework,
  FrameworkError,
  loadProjectModule,
} from "@alchemy.run/frontend-frameworks/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Cwd } from "./Cwd.ts";
import * as Options from "./Options.ts";
import * as Vite from "./Vite.ts";

/**
 * The built-in Vite implementation of framework-core's `Framework` service —
 * the default when `e2e.config.ts` names no framework. Framework packages
 * (waku/astro/sveltekit/nextjs) provide their own layers with the same shape.
 */
export const makeViteFramework = (
  options: Options.Options,
): Options.Options.FrameworkLayer =>
  Layer.effect(
    Framework,
    Effect.gen(function* () {
      const vite = yield* Vite.Vite;
      const { worker } = Options.resolveCloudflareOptions(options);
      const wrapError = (error: Vite.ViteError) =>
        new FrameworkError({
          framework: "vite",
          message: error.message,
          cause: error.cause,
        });
      return Framework.of({
        build: (buildOptions) =>
          vite
            .build(
              worker,
              buildOptions?.root !== undefined
                ? { root: buildOptions.root }
                : undefined,
            )
            .pipe(Effect.mapError(wrapError)),
        dev: (devOptions) =>
          vite
            .dev(worker, {
              ...(devOptions?.root !== undefined
                ? { root: devOptions.root }
                : undefined),
              ...(devOptions?.port !== undefined
                ? { server: { port: devOptions.port } }
                : undefined),
            })
            .pipe(
              Effect.map(({ url }) => ({ url })),
              Effect.mapError(wrapError),
            ),
      });
    }),
  ).pipe(Layer.provide(Vite.ViteLive));

/** The exports a framework package may provide (see {@link resolve}). */
interface FrameworkModule {
  readonly default?: unknown;
  readonly framework?: unknown;
}

const invalidExport = (specifier: string) =>
  new FrameworkError({
    framework: specifier,
    message:
      `"${specifier}" does not provide a usable framework export: expected a default export ` +
      "(or named export `framework`) that is a `(options) => Layer<Framework>` factory " +
      "or a `Layer<Framework>`",
  });

const toFrameworkLayer: (
  candidate: unknown,
  options: Options.Options,
  specifier: string,
) => Effect.Effect<
  Options.Options.FrameworkLayer,
  FrameworkError | unknown,
  Options.Options.FrameworkServices
> = Effect.fn(function* (
  candidate: unknown,
  options: Options.Options,
  specifier: string,
) {
  const resolved = Effect.isEffect(candidate)
    ? yield* candidate as Effect.Effect<
        unknown,
        unknown,
        Options.Options.FrameworkServices
      >
    : candidate;
  if (Layer.isLayer(resolved)) {
    return resolved as Options.Options.FrameworkLayer;
  }
  if (typeof resolved === "function") {
    return yield* toFrameworkLayer(
      (resolved as Options.Options.FrameworkFactory)(options),
      options,
      specifier,
    );
  }
  return yield* Effect.fail(invalidExport(specifier));
});

/**
 * Resolve the `Framework` Layer for a fixture from its options:
 *
 * - no `framework` — the built-in Vite implementation over `options.vite`
 * - a string — imported from the fixture's own `node_modules` (via
 *   framework-core's `loadProjectModule`, so the fixture's installed copy of
 *   the framework is the one driven); its default export (or named export
 *   `framework`) is applied to the options
 * - a factory — applied to the options
 * - a Layer — used as-is
 */
export const resolve = Effect.fn(function* (options: Options.Options) {
  const input = options.framework;
  if (input === undefined) {
    return makeViteFramework(options);
  }
  if (typeof input === "string") {
    const cwd = yield* Cwd;
    const module_ = yield* loadProjectModule<FrameworkModule>(cwd, input).pipe(
      Effect.mapError(
        (error) =>
          new FrameworkError({
            framework: input,
            message: error.message,
            cause: error.cause,
          }),
      ),
    );
    const candidate = module_.default ?? module_.framework;
    if (candidate === undefined) {
      return yield* Effect.fail(invalidExport(input));
    }
    return yield* toFrameworkLayer(candidate, options, input);
  }
  return yield* toFrameworkLayer(
    input,
    options,
    "e2e.config.ts framework option",
  );
});

/**
 * The `Framework` Layer for the current fixture: loads `e2e.config.ts` and
 * resolves its `framework` option (defaulting to the built-in Vite
 * implementation). Everything downstream (`Cli`, `Server`) dispatches through
 * the `Framework` service and never talks to Vite directly.
 */
export const layer: Layer.Layer<
  Framework,
  unknown,
  Options.Options.FrameworkServices
> = Layer.unwrap(
  Effect.gen(function* () {
    const options = yield* Options.load();
    return yield* resolve(options);
  }),
);
