/**
 * Process bootstrap for `GCP.Run.Job` and `GCP.Run.WorkerPool`. No HTTP
 * server — the program's `run` executes, and for a Job the process exits 0
 * once it finishes (Cloud Run marks the task complete on exit). A worker
 * pool's long-running `run` loop keeps its instance alive.
 *
 * Runtime credentials come from the metadata server (the host's runtime
 * service account).
 */
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Logger from "effect/Logger";
import { fromMetadataServer } from "../../GCP/MetadataCredentials.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

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

  return runProcess("Cloud Run job", program, { exitOnComplete: true });
};
