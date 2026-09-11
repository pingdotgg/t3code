/**
 * Process bootstrap for `AWS.AppRunner.Service` containers. The generated
 * entry imports this module and the user's `main`, nothing else — see
 * {@link ./Process.ts} for why.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BunHttpServer } from "../../Http.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

/** Serve the bundled program with a Bun HTTP server on the injected `PORT`. */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(Credentials.fromEnv()),
        Layer.provideMerge(Region.fromEnv()),
        Layer.provideMerge(BunHttpServer()),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv(),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("App Runner service", program);
};
