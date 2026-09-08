/**
 * Shared core of the generated process bootstraps (ECS, App Runner, Batch,
 * EC2, Cloudflare Containers, MicroVM, Docker, Fly, Hetzner, Prisma).
 *
 * Each bundler used to emit its bootstrap as an inline TypeScript string —
 * a virtual module with no location on disk, whose imports mixed alchemy's
 * own dependencies (`@distilled.cloud/*`, `@effect/platform-*`) with the
 * consumer's (`alchemy`, `effect`). No directory can resolve both under an
 * isolated install (bun `--linker=isolated`, pnpm), so the imports were
 * left external and the process died at boot with `Cannot find module`.
 *
 * Now the generated entry is a three-line shim that imports ONLY
 * `alchemy/Runtime/Bootstrap/<Platform>` (resolvable from any consumer —
 * `alchemy` is its direct dependency) plus the user's `main`. Everything
 * alchemy needs lives in these real modules, whose imports resolve by the
 * ordinary rule: from the file that wrote them.
 *
 * The helpers here are the pieces every platform module composes; the
 * layer ORDER (which service is provided to which) is platform-specific and
 * stays in each module.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEntrypointLayer } from "../../Runtime.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";
import { provideProcessTelemetry } from "../../Telemetry.ts";

/**
 * The tag every bundled platform program registers itself under
 * (`Self`'s key). Typed loosely on purpose: the shape is the platform
 * instance, which differs per platform and is only ever read dynamically.
 */
export const entrypointTag = Context.Service<any, any>(Self.key);

/**
 * Normalize the entrypoint export into the layer providing
 * {@link entrypointTag}: an inline-effect class default export is an Effect
 * resolving the platform instance, while the tagged form
 * (`X.make(props, impl)`) exports a Layer providing the `Self` tag.
 */
export const entrypointLayer = (entrypoint: unknown): Layer.Layer<any> =>
  makeEntrypointLayer(entrypointTag, entrypoint);

/** `Stack` from the `ALCHEMY_STACK_NAME` / `ALCHEMY_STAGE` the host injects. */
export const stackFromEnv: Layer.Layer<Stack, Config.ConfigError> =
  Layer.effect(
    Stack,
    Effect.all([
      Config.string("ALCHEMY_STACK_NAME"),
      Config.string("ALCHEMY_STAGE"),
    ]).pipe(
      Effect.map(([name, stage]) => ({
        name,
        stage,
        bindings: {},
        resources: {},
        actions: {},
      })),
    ),
  );

/** `Stack` from constants baked in at deploy time. */
export const stackConstant = (
  name: string,
  stage: string,
): Layer.Layer<Stack> =>
  Layer.succeed(Stack, {
    name,
    stage,
    bindings: {},
    resources: {},
    actions: {},
  });

/**
 * Resolve the program the bundled platform registered under `exportKey`
 * (`program` for the server/one-shot hosts, `default` for containers,
 * `handler` for Lambda), optionally under process-lifetime telemetry: built
 * once into the root scope; exporters batch on their intervals and flush
 * when the scope closes on graceful shutdown.
 */
export const resolveProgram = (
  exportKey: string,
  options?: { readonly telemetry?: boolean },
): Effect.Effect<any, any, any> =>
  entrypointTag.pipe(
    Effect.flatMap((self) => {
      const program: Effect.Effect<any, any, any> =
        self.RuntimeContext.exports.pipe(
          Effect.flatMap((exports: any) => exports[exportKey]),
        );
      return options?.telemetry
        ? program.pipe(provideProcessTelemetry(self.RuntimeContext))
        : program;
    }),
  );

/**
 * Run `program` as the process entry: log the start, exit 1 on failure.
 * With `exitOnComplete`, exit 0 explicitly once it completes (one-shot jobs
 * whose host waits on the process, e.g. Batch).
 */
export const runProcess = (
  label: string,
  program: Effect.Effect<unknown, unknown>,
  options?: { readonly exitOnComplete?: boolean },
): Promise<void> => {
  console.log(`${label} bootstrap starting...`);
  // Node 26 exits 13 (unsettled TLA) when the event loop is empty while
  // `await bootstrap(...)` is still pending. `host.run(Effect.never)` has
  // no native handle; an HTTP `listen` does. Hold a timer so run-only
  // Services stay up the same way Bun does.
  const keepAlive = setInterval(() => undefined, 1 << 30);
  return Effect.runPromise(program).then(
    () => {
      clearInterval(keepAlive);
      if (options?.exitOnComplete) {
        console.log(`${label} completed.`);
        process.exit(0);
      }
    },
    (err) => {
      clearInterval(keepAlive);
      console.error(`${label} bootstrap failed:`, err);
      process.exit(1);
    },
  );
};
