/**
 * Process bootstrap for `Railway.Service` (a Node process serving the
 * bundled program). The generated entry imports this module and the user's
 * `main`, nothing else — see {@link ./Process.ts} for why.
 *
 * Railway canvas Functions stay on bun (`functionRuntime(bun)` + the
 * inline canvas wrapper). This module is the Docker/Service path only.
 */
import { NodeServices } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { NodeHttpServer } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

/**
 * Resolve the bundled program (the runners registered via `host.run` /
 * serve) and run it with a Node HTTP server bound to `PORT`, so the
 * returned `{ fetch }` handler is actually served and `host.run` loops
 * stay alive.
 */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(NodeHttpServer({ hostname: "0.0.0.0" })),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Railway service", program);
};
