/**
 * Process bootstrap for `Fly.Service` and `Fly.Sprite` (a Node process
 * serving the bundled program). The generated entry imports this module
 * and the user's `main`, nothing else — see {@link ./Process.ts} for why.
 */
import { NodeServices } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { NodeHttpServer } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import { ManagedHttpShutdown } from "./ManagedHttpShutdown.ts";
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

  const services = entrypointLayer(entrypoint).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(NodeHttpServer({ hostname: "0.0.0.0" })),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
  );
  const program = Effect.gen(function* () {
    const managed = yield* Effect.serviceOption(ManagedHttpShutdown);
    if (Option.isNone(managed)) {
      return yield* resolveProgram("program").pipe(
        Effect.provide(services),
        Effect.scoped,
      );
    }
    // Initializer dependencies outlive both run finalizers and HTTP responses.
    const context = yield* Layer.buildWithScope(
      services,
      managed.value.dependencies,
    );
    return yield* resolveProgram("program").pipe(
      Effect.provideContext(context),
      Scope.provide(managed.value.dependencies),
    );
  });

  const timeout = process.env.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS;
  return runProcess("Fly service", program, {
    managedHttpShutdownTimeoutMs:
      timeout === undefined
        ? undefined
        : /^\d+$/.test(timeout)
          ? Number(timeout)
          : NaN,
  });
};
