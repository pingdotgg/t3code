import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import type { Framework } from "@alchemy.run/frontend-frameworks/core";
import type * as Miniflare from "../miniflare/miniflare.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { Cwd } from "./Cwd.ts";

const kOptions = Symbol("@alchemy.run/cloudflare-test-tools/e2e/Options");

/**
 * Cloudflare-target configuration — everything the cloudflare deploy target
 * needs to build, dev-serve, and preview a fixture.
 */
export interface CloudflareTargetOptions {
  /**
   * Cloudflare worker configuration (compatibility date/flags, worker name,
   * bindings, assets) consumed by the built-in Vite implementation of the
   * `Framework` service — and, by convention, by framework packages named via
   * {@link Options.framework} (they read the same shape for their cloudflare
   * plugin options). Optional so assets-only fixtures can omit it.
   */
  readonly worker?: CloudflareVitePluginOptions;
  /**
   * Miniflare options for the preview server (`e2e preview` / the Playwright
   * `live` mode) — the cloudflare target's serving story for built output.
   */
  readonly preview?: Options.MiniflareOptions;
}

/**
 * Target selection + target-scoped config carriage: one optional key per
 * platform, opaque to everything except that platform's target. Cloudflare is
 * the only implemented target today; a future AWS target adds its own key
 * (e.g. `aws?: AwsTargetOptions`) without touching the framework plumbing.
 */
export interface TargetOptions {
  /**
   * Which platform target drives this fixture.
   * @default "cloudflare"
   */
  readonly name?: "cloudflare";
  readonly cloudflare?: CloudflareTargetOptions;
}

export interface Options {
  /**
   * The framework's project root, relative to the fixture root (the harness
   * cwd). Threaded by the harness into `Framework.build`/`Framework.dev`
   * (`FrameworkBuildOptions.root` / `FrameworkDevOptions.root`) so a fixture
   * whose app lives in a subdirectory (e.g. a monorepo-shaped fixture with the
   * Vite project at `app/`) needs no framework-Layer wrapping. The harness's
   * own persistence (`dist/build.json`) stays anchored at the fixture root.
   * @default the fixture root
   */
  readonly root?: string;
  /**
   * Deploy-target selection and target-scoped configuration. Defaults to the
   * cloudflare target. Frameworks and the harness read the resolved shape via
   * {@link resolveCloudflareOptions}, which also honors the deprecated
   * top-level `vite`/`miniflare` aliases.
   */
  readonly target?: TargetOptions;
  /**
   * @deprecated Alias for `target.cloudflare.worker` — kept so existing
   * `e2e.config.ts` files work unchanged. Prefer the target-scoped form.
   */
  readonly vite?: CloudflareVitePluginOptions;
  /**
   * @deprecated Alias for `target.cloudflare.preview` — kept so existing
   * `e2e.config.ts` files work unchanged. Prefer the target-scoped form.
   */
  readonly miniflare?: Options.MiniflareOptions;
  /**
   * The framework integration implementing `dev`/`build` for this fixture.
   *
   * - omitted — the built-in Vite implementation (default; zero behavior
   *   change for existing fixtures)
   * - a package specifier (e.g. `"@alchemy.run/frontend-frameworks/waku"`) — loaded from the
   *   *fixture's* own `node_modules`; the module must default-export (or
   *   named-export `framework`) a factory `(options: Options) =>
   *   Layer<Framework>` (a `Layer<Framework>` export is also accepted)
   * - a factory function — called with these options
   * - a `Layer<Framework>` — used as-is (build it yourself in `e2e.config.ts`
   *   by importing the framework package directly, for full type safety over
   *   framework-specific options)
   */
  readonly framework?: Options.FrameworkInput;
}

/**
 * The resolved cloudflare-target configuration: the target-scoped form merged
 * with the deprecated top-level aliases (target-scoped wins). This is the
 * single accessor the harness — and, by convention, framework packages that
 * read the harness options structurally — use to obtain cloudflare config;
 * nothing else should touch `options.vite` / `options.miniflare` directly.
 */
export const resolveCloudflareOptions = (
  options: Options,
): {
  worker: CloudflareVitePluginOptions | undefined;
  preview: Options.MiniflareOptions;
} => ({
  worker: options.target?.cloudflare?.worker ?? options.vite,
  preview: options.target?.cloudflare?.preview ?? options.miniflare ?? {},
});

/**
 * Resolve {@link Options.root} to an absolute project root (against the
 * harness cwd), or `undefined` when the fixture root is the project root —
 * the value the harness passes to `Framework.build`/`Framework.dev` as
 * `FrameworkBuildOptions.root` / `FrameworkDevOptions.root`.
 */
export const resolveRoot: (
  options: Options,
) => Effect.Effect<string | undefined, never, Path.Path> = Effect.fn(function* (
  options: Options,
) {
  if (options.root === undefined) {
    return undefined;
  }
  const path = yield* Path.Path;
  const cwd = yield* Cwd;
  return path.resolve(cwd, options.root);
});

export declare namespace Options {
  type Input = Options | Effect.Effect<Options>;
  type MiniflareOptions = {
    // `NonNullable` before `Omit`: newer miniflare versions surface the
    // optional `assets` slot as `{...} | undefined`, and `Omit` over a
    // union with `undefined` collapses to `{}`.
    [K in keyof Miniflare.Options]?: K extends "assets"
      ? Omit<NonNullable<Miniflare.Options[K]>, "directory">
      : Miniflare.Options[K];
  };

  /**
   * Services the harness runtime provides to a framework Layer while it is
   * being built (from `@effect/platform-node`'s `NodeServices`, plus a
   * dotenv/env `ConfigProvider`).
   */
  type FrameworkServices = FileSystem.FileSystem | Path.Path;

  /**
   * What a framework integration ultimately provides: a Layer for
   * framework-core's `Framework` service.
   */
  type FrameworkLayer = Layer.Layer<Framework, unknown, FrameworkServices>;

  /**
   * A factory producing the {@link FrameworkLayer} from the fixture's
   * options. May return the Layer directly or an Effect of it.
   */
  type FrameworkFactory = (
    options: Options,
  ) =>
    | FrameworkLayer
    | Effect.Effect<FrameworkLayer, unknown, FrameworkServices>;

  type FrameworkInput = string | FrameworkLayer | FrameworkFactory;
}

export const make = (options: Options.Input) =>
  Object.assign(options, { [kOptions]: true });

export const load = Effect.fn(function* () {
  const path = yield* Path.Path;
  const cwd = yield* Cwd;
  const url = yield* path
    .toFileUrl(path.resolve(cwd, "e2e.config.ts"))
    .pipe(Effect.map((url) => url.href));
  const options = yield* Effect.promise(
    async () => await import(url).then((m) => m.default as Options.Input),
  );
  if (Effect.isEffect(options)) {
    return yield* options;
  }
  if (!Predicate.hasProperty(options, kOptions)) {
    throw new Error("No e2e.config.ts found");
  }
  return options;
});
