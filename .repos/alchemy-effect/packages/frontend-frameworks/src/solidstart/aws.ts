/**
 * `@alchemy.run/frontend-frameworks/solidstart/aws` — the AWS Lambda deploy
 * target for the SolidStart integration.
 *
 * SolidStart's server half is nitro (`@solidjs/vite-plugin-nitro-2`), so its
 * AWS story is nitro's `aws-lambda` preset: `.output/server` is a
 * self-contained Node ESM deployment unit whose `index.mjs` exports a Lambda
 * `handler`, and `.output/public` holds the client assets (prerendered pages
 * included) for the CDN. What this target owns:
 *
 * - **`nitroPreset`** — `"aws-lambda"`, enforced as the last word on the
 *   nitro config the integration hands to the appended nitro plugin.
 * - **`configureNitro`** — enables response streaming by default
 *   (`awsLambda.streaming: true`): the emitted handler wraps
 *   `awslambda.streamifyResponse` and expects a Lambda Function URL with
 *   `invokeMode: RESPONSE_STREAM`. Set `streaming: false` on the target
 *   config for the buffered APIGW-style handler.
 * - **`bundle`** — Node resolve conditions and the `@aws-sdk/` externals
 *   (the Lambda Node.js runtime ships SDK v3) for callers that post-process
 *   server code.
 *
 * No `finish`: nitro's aws-lambda output already ships its own
 * `package.json` (`type: "module"`) and copied externals, so the server
 * directory deploys as-is.
 *
 * No `devPlatform` seam: `dev` runs SolidStart's own Vite dev server, which
 * is already the AWS Lambda programming model (plain Node).
 */
import * as Effect from "effect/Effect";
import { runBuildChild } from "../core/BuildChild.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  make,
  type SolidStartTarget,
  type SolidStartTargetConfig,
} from "./SolidStart.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "aws-lambda";

/**
 * The importable specifier of nitro's aws-lambda streaming runtime handler —
 * the module a custom entry would re-export to wrap the framework's handler.
 */
export const NITRO_HANDLER_SPECIFIER =
  "nitropack/presets/aws-lambda/runtime/aws-lambda-streaming";

/** AWS-specific knobs carried on the shared {@link SolidStartTargetConfig}. */
export interface SolidStartAwsTargetConfig extends SolidStartTargetConfig {
  /**
   * Whether the emitted Lambda handler streams its response
   * (`awslambda.streamifyResponse`, requires a Function URL with
   * `invokeMode: RESPONSE_STREAM`). The buffered handler answers
   * APIGW/Function-URL events with a complete response object.
   * @default true
   */
  readonly streaming?: boolean | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/**
 * The adapter-driven target — the shape the framework's regular vite/nitro
 * build pipeline consumes. Used directly in the build child (where
 * `cwd === root` holds); {@link makeAwsTarget} wraps it with the wholesale
 * `build` hook that spawns the child.
 */
const makeAwsAdapterTarget = (
  config: SolidStartAwsTargetConfig = {},
): SolidStartTarget =>
  makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    nitroPreset: NITRO_PRESET,
    configureNitro: (nitroConfig) => {
      const awsLambda =
        nitroConfig.awsLambda !== null &&
        typeof nitroConfig.awsLambda === "object"
          ? (nitroConfig.awsLambda as Record<string, unknown>)
          : {};
      nitroConfig.awsLambda = {
        ...awsLambda,
        streaming: config.streaming ?? true,
      };
    },
  });

/**
 * A SolidStart build loads and executes the project's `vite.config.*` (its
 * `solidStart()` plugin scans the route directory from `process.cwd()`, and
 * user plugins may mutate `process.env` or `process.chdir`) — none of which
 * may touch the engine process, where many deploys share one event loop.
 * This target's wholesale `build` therefore runs the framework in a
 * disposable child process whose working directory IS the project root (see
 * `core/BuildChild.ts`). The shared `core/BuildChildRunner` entry imports
 * this module in the child and calls the exported {@link buildInChild}.
 */
export interface SolidStartAwsBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: SolidStartAwsTargetConfig;
}

export const buildInChild = (config: SolidStartAwsBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The adapter-only target: no wholesale `build` hook, so the child
      // runs the regular vite/nitro build pipeline (no recursion).
      target: makeAwsAdapterTarget(config.config),
      nitro: config.config.nitro,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the AWS Lambda {@link SolidStartTarget}. See the module doc for the
 * seams.
 */
export const makeAwsTarget = (
  config: SolidStartAwsTargetConfig = {},
): SolidStartTarget => ({
  ...makeAwsAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      framework: "solidstart",
      config: {
        rootDir: context.root,
        config,
      } satisfies SolidStartAwsBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeAwsTarget;

export default makeAwsTarget;
