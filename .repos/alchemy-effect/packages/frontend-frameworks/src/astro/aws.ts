/**
 * `@alchemy.run/frontend-frameworks/astro/aws` — the AWS Lambda deploy target
 * for the Astro integration.
 *
 * Astro's AWS story is a plain Node SSR bundle behind a Lambda Function
 * URL: the adapter integration pins this package's `aws-server` entrypoint
 * (which wraps `App.render` with the `@alchemy.run/frontend-frameworks/aws-lambda`
 * handler adapter) as the build's server entry, and forces the server build
 * to be **self-contained** (`vite.ssr.noExternal: true`) so `dist/server`
 * can ship to Lambda as-is (`bundle: false`). What this target owns:
 *
 * - **`integration`** — the adapter integration: registers itself via
 *   `setAdapter` at `astro:config:done` (rejecting a user-declared adapter
 *   with an actionable error), pins the `aws-server` entrypoint, and
 *   configures the server build for self-containment.
 * - **`finish`** — a fully-static build (`output: "static"`: every route
 *   prerendered) deploys ASSETS-ONLY: `serverModules` is dropped so the
 *   composite skips the Lambda entirely.
 * - **`selectServerEntry`** — pins the adapter's entry chunk as
 *   `serverModules[0]` (astro's page modules are rolldown inputs in the
 *   same environment, so the entry environment emits many entry chunks).
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3) for callers that post-process
 *   server code.
 *
 * No `devPlatform`: `dev` runs Astro's own Node dev server, which is
 * already the AWS Lambda programming model (plain Node).
 */
import type { AstroInlineConfig, AstroIntegration } from "astro";
import * as Effect from "effect/Effect";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  DeployTargetError,
  makeDeployTarget,
  type ServerEntryChunk,
} from "../core/index.ts";
import { make } from "./Astro.ts";
import type { AstroTarget, AstroTargetBuildContext } from "./Target.ts";

/**
 * The importable specifier of this package's AWS Lambda server entrypoint —
 * the module the adapter pins as `serverEntrypoint`. It exports the Lambda
 * `handler` (streaming by default).
 */
export const SERVER_ENTRYPOINT =
  "@alchemy.run/frontend-frameworks/astro/entrypoints/aws-server";

/** AWS-specific target configuration. */
export interface AstroAwsConfig {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). With `false` — or whenever the
   * `awslambda` global is absent — the buffered handler answers
   * APIGW/Function-URL events with a complete payload-v2 response object.
   * @default true
   */
  readonly streaming?: boolean | undefined;
}

export interface AstroAwsTarget extends AstroTarget<AstroAwsConfig> {}

/** Options for {@link distilledAws} (the adapter integration). */
export interface DistilledAwsOptions {
  /** See {@link AstroAwsConfig.streaming}. @default true */
  readonly streaming?: boolean | undefined;
  /**
   * Reports the resolved build output mode (`astro:config:done`'s
   * `buildOutput`): `"static"` when every route is prerendered, `"server"`
   * when any route renders on demand. The target's `finish` pass uses it to
   * strip `serverModules` from a fully-static build so the deploy is
   * assets-only (no Lambda).
   * @internal
   */
  readonly onBuildOutput?:
    | ((buildOutput: "static" | "server") => void)
    | undefined;
  /**
   * Reports the resolved server-entry file name (`config.build.serverEntry`,
   * `entry.mjs` by default) so the entry chunk can be pinned as
   * `serverModules[0]`.
   * @internal
   */
  readonly onServerEntryName?: ((name: string) => void) | undefined;
}

/**
 * The AWS Lambda adapter integration for Astro. Injected via
 * `integrations` (after the user's) rather than `adapter`: it registers
 * itself as the adapter at `astro:config:done`, where it also rejects a
 * user-declared adapter with an actionable error.
 */
export const distilledAws = (
  options: DistilledAwsOptions = {},
): AstroIntegration => {
  // Whether WE satisfied `config.adapter`. The user's astro.config.* loads
  // natively and this integration is injected via `integrations`, but
  // astro's build refuses server output unless `config.adapter` is set — so
  // `astro:config:setup` injects a hookless marker when the config declares
  // no adapter (the real adapter registration is `setAdapter` at
  // `astro:config:done`). When the flag is still false at
  // `astro:config:done`, the user declared their own adapter — a conflict.
  let injectedAdapterMarker = false;
  return {
    name: "@alchemy.run/frontend-frameworks/astro-aws",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (config.adapter === undefined) {
          injectedAdapterMarker = true;
          updateConfig({
            adapter: {
              name: "@alchemy.run/frontend-frameworks/astro-aws",
              hooks: {},
            },
          });
        }
      },
      "astro:config:done": ({ setAdapter, config, buildOutput }) => {
        if (config.adapter !== undefined && !injectedAdapterMarker) {
          throw new Error(
            `@alchemy.run/frontend-frameworks/astro/aws: the Astro config declares the adapter "${config.adapter.name}", ` +
              "but the deploy target already provides the AWS Lambda adapter. " +
              "Remove `adapter` from your astro.config file — user integrations " +
              "(react, mdx, tailwind, ...) are honored, and the adapter is injected by the toolchain.",
          );
        }
        options.onBuildOutput?.(buildOutput);
        options.onServerEntryName?.(config.build.serverEntry);
        setAdapter({
          name: "@alchemy.run/frontend-frameworks/astro-aws",
          entrypointResolution: "auto",
          serverEntrypoint: SERVER_ENTRYPOINT,
          adapterFeatures: {
            buildOutput,
            middlewareMode: "classic",
            preserveBuildClientDir: true,
            preserveBuildServerDir: true,
          },
          supportedAstroFeatures: {
            serverOutput: "stable",
            hybridOutput: "stable",
            staticOutput: "stable",
            i18nDomains: "experimental",
            envGetSecret: "stable",
            sharpImageService: {
              support: "limited",
              message:
                "sharp is not shipped with the Lambda server bundle; install it as a project dependency to optimize images at build time",
            },
          },
        });
      },
      "astro:build:setup": ({ vite: viteConfig, target }) => {
        if (target === "server") {
          // Self-contained dist/server: Lambda ships the directory as-is
          // (`bundle: false`), so every server dependency must be bundled
          // into the emitted chunks. Node builtins stay external
          // automatically; sharp is a native module that can never bundle,
          // and the Lambda Node.js runtime provides `@aws-sdk/*` v3.
          viteConfig.ssr ||= {};
          viteConfig.ssr.noExternal = true;
          viteConfig.build ||= {};
          const build = viteConfig.build as Record<string, any>;
          build.rolldownOptions ||= {};
          build.rolldownOptions.external = ["sharp", /^@aws-sdk\//];
          viteConfig.define = {
            __ALCHEMY_ASTRO_AWS_STREAMING__: JSON.stringify(
              options.streaming ?? true,
            ),
            ...viteConfig.define,
          };
        }
      },
    },
  };
};

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/**
 * The adapter-driven target — the shape the framework's regular
 * build/finish pipeline consumes. Used directly in the build child (where
 * `cwd === root` holds); {@link target} wraps it with the wholesale
 * `build` hook that spawns the child.
 */
const makeAwsAdapterTarget = (config: AstroAwsConfig = {}): AstroAwsTarget => {
  // The resolved build output mode from `astro:config:done`: `"static"`
  // means every route is prerendered, so the deploy must be assets-only.
  let buildOutput: "static" | "server" | undefined;
  // The resolved server-entry file name (`entry.mjs` by default).
  let serverEntryName: string | undefined;
  return makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    integration: () =>
      distilledAws({
        streaming: config.streaming,
        onBuildOutput: (mode) => {
          buildOutput = mode;
        },
        onServerEntryName: (name) => {
          serverEntryName = name;
        },
      }),
    // Astro's page modules are rolldown inputs of the `ssr` environment, so
    // it emits many entry chunks; pin the adapter's server entry (renamed to
    // `config.build.serverEntry` by astro, facade = the aws-server module).
    selectServerEntry: (chunk: ServerEntryChunk): boolean =>
      chunk.fileName === (serverEntryName ?? "entry.mjs") ||
      (chunk.facadeModuleId !== null &&
        /\/entrypoints\/aws-server\.(?:ts|js|mjs)$/.test(
          chunk.facadeModuleId.replaceAll("\\", "/"),
        )),
    // A fully-static build deploys ASSETS-ONLY: the SSR entry astro bundled
    // for prerendering is dropped from the output and the client directory
    // carries all prerendered HTML, `404.html` included.
    finish: (output) =>
      Effect.succeed(
        buildOutput === "static"
          ? { ...output, serverModules: undefined }
          : output,
      ),
  });
};

/**
 * The natively-loaded `astro.config.*` executes user plugins/integrations
 * that may read the cwd, mutate `process.env`, or `process.chdir` — none of
 * which may touch the engine process (many deploys share one event loop).
 * This target's wholesale `build` therefore runs the framework in a
 * disposable child process whose working directory IS the project root (see
 * `core/BuildChild.ts`). The shared `core/BuildChildRunner` entry imports
 * this module in the child and calls the exported {@link buildInChild}.
 */
export interface AstroAwsBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: AstroAwsConfig;
  /**
   * The inline Astro overlay the framework was constructed with
   * (`AstroFrameworkOptions.astro`, carried through the build context).
   * Only JSON-serializable fields cross the process boundary.
   */
  readonly astro: AstroInlineConfig | undefined;
}

export const buildInChild = (config: AstroAwsBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The adapter-only target: no wholesale `build` hook, so the child
      // runs the regular astro build + finish pipeline (no recursion).
      target: makeAwsAdapterTarget(config.config),
      astro: config.astro,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Build the AWS Lambda {@link AstroTarget}. See the module doc for the
 * seams.
 */
export const target = (config: AstroAwsConfig = {}): AstroAwsTarget => ({
  ...makeAwsAdapterTarget(config),
  build: (context: AstroTargetBuildContext) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "astro",
      config: {
        rootDir: context.root,
        config,
        astro: context.astro,
      } satisfies AstroAwsBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export default target;
