/**
 * Process bootstrap for `GCP.Run.Service`. The generated entry imports
 * this module and the user's `main`, nothing else — see
 * `alchemy/Runtime/Bootstrap` for why.
 *
 * Runtime credentials come from the Cloud Run metadata server (the
 * service's runtime service account), so HTTP bindings call GCP with
 * exactly the IAM the deploy granted — never the deploy-time token.
 */
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
import { fromMetadataServer } from "../MetadataCredentials.ts";

/** Serve the bundled program with a Bun HTTP server on the injected `PORT`. */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  // Cloud Run sets `PORT` only on the ingress container; a sidecar
  // `GCP.Run.Container` gets its port from `ALCHEMY_HTTP_PORT`.
  if (process.env.ALCHEMY_HTTP_PORT && !process.env.PORT) {
    process.env.PORT = process.env.ALCHEMY_HTTP_PORT;
  }
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
