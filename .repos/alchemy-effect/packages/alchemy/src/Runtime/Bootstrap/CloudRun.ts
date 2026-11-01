/**
 * Process bootstrap for `GCP.Run.Service`. The generated entry imports
 * this module and the user's `main`, nothing else — see
 * {@link ./Process.ts} for why.
 *
 * Runtime credentials come from the Cloud Run metadata server (the
 * service's runtime service account), so HTTP bindings call GCP with
 * exactly the IAM the deploy granted — never the deploy-time token.
 */
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Logger from "effect/Logger";
import { fromMetadataServer } from "../../GCP/MetadataCredentials.ts";
import { BunHttpServer } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
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

  const program = resolveProgram("program", { telemetry: true }).pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(fromMetadataServer()),
        Layer.provideMerge(BunHttpServer({ hostname: "0.0.0.0" })),
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

  return runProcess("Cloud Run service", program);
};
