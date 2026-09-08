/**
 * Process bootstrap for `Prisma.Compute` apps. The generated entry imports
 * this module and the user's `main`, nothing else — see
 * {@link ./Process.ts} for why.
 */
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BunHttpServer } from "../../Http.ts";
import { Stage } from "../../Stage.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackConstant,
} from "./Process.ts";

export interface PrismaBootstrapOptions {
  /** Port to serve on when the platform does not inject `PORT`. */
  readonly port: number;
  /** Stack identity baked in at deploy time. */
  readonly stack: { readonly name: string; readonly stage: string };
}

/** Serve the bundled app with a Bun HTTP server on `PORT` (all interfaces). */
export const bootstrap = (
  entrypoint: unknown,
  options: PrismaBootstrapOptions,
): Promise<void> => {
  process.env.PORT ??= String(options.port);

  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const stack = Layer.mergeAll(
    stackConstant(options.stack.name, options.stack.stage),
    Layer.succeed(Stage, options.stack.stage),
  );

  const program = resolveProgram("default").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stack),
        Layer.provideMerge(BunHttpServer({ hostname: "0.0.0.0" })),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
              ConfigProvider.fromEnv(),
            ),
          ),
        ),
        Layer.provideMerge(
          Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info"),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Prisma Compute", program);
};
