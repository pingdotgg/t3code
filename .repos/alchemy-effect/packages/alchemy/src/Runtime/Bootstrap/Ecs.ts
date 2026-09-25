/**
 * Process bootstrap for `AWS.ECS.Task` / `AWS.ECS.Service` containers. The
 * generated entry imports this module and the user's `main`, nothing else —
 * see {@link ./Process.ts} for why.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { BunHttpServer } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

/**
 * Resolve the bundled program (the runners registered via `host.run` /
 * serve) and run it with a Bun HTTP server bound to `PORT`, so a returned
 * `{ fetch }` handler is actually served and `host.run` loops stay alive. A
 * pure one-shot `{ run }` program completes and the process exits 0.
 */
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
        // Full provider chain, not fromEnv: Fargate tasks receive credentials
        // from the container-credentials endpoint
        // (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI), not environment variables.
        Layer.provideMerge(Credentials.fromChain()),
        Layer.provideMerge(Region.fromEnv()),
        // AWS_ENDPOINT_URL is the LocalStack-standard override injected by
        // local emulators (floci) into task containers — without it, runtime
        // bindings in `alchemy dev` would call REAL AWS with dummy
        // credentials. Resolves undefined when unset, so live deploys are
        // unaffected.
        Layer.provideMerge(Endpoint.fromEnv()),
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

  return runProcess("Task", program);
};
