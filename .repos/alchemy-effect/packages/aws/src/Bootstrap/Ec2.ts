/**
 * Process bootstrap for the hosted `AWS.EC2.Instance` program (a systemd
 * unit running bun). The generated entry imports this module and the user's
 * `main`, nothing else — see `alchemy/Runtime/Bootstrap` for why.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

/** Serve the bundled program with a Bun HTTP server on the instance's `PORT`. */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program", { telemetry: true }).pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        // The instance profile: credentials come from IMDS, not the env.
        Layer.provideMerge(Credentials.fromChain()),
        Layer.provideMerge(Region.fromEnv()),
        Layer.provideMerge(BunHttpServer()),
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

  return runProcess("Instance", program);
};
