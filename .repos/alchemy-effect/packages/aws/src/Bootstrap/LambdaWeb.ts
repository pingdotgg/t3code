/**
 * Bootstrap for an Effect `AWS.Lambda.WebFunction` (zip, Node runtime). The
 * generated entry imports this module and the user's `main` — see
 * `alchemy/Runtime/Bootstrap` for why the entry is a shim.
 *
 * Unlike an Event Function, a Web Function is a plain HTTP server: the
 * bundled program's `fetch` handler is served by Effect's Node HTTP server
 * on the address Lambda passes in `AWS_LAMBDA_HTTP_ENDPOINT`. One execution
 * environment serves many requests concurrently, and response bodies stream
 * straight to the client.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "alchemy/Http";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import { ManagedHttpShutdown } from "alchemy/Runtime/ManagedHttpShutdown";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";

/**
 * The `host:port` Lambda routes requests to, or `127.0.0.1:3000` when
 * `AWS_LAMBDA_HTTP_ENDPOINT` is unset (local runs).
 */
const lambdaHttpEndpoint = () => {
  const value = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
  const separator = value?.lastIndexOf(":") ?? -1;
  if (value === undefined || separator <= 0) {
    return { host: "127.0.0.1", port: 3000 };
  }
  return {
    host: value.slice(0, separator).replace(/^\[(.*)\]$/, "$1"),
    port: Number(value.slice(separator + 1)),
  };
};

/**
 * Lambda sends `SIGTERM` and terminates the environment 1 second later.
 * Managed shutdown stops accepting, drains in-flight responses, closes the
 * instance scope, and exits inside that window.
 */
const SHUTDOWN_BUDGET_MS = 1000;

/**
 * Resolve the bundled program (the `fetch` handler registered via `serve`)
 * and run it with a Node HTTP server bound to `AWS_LAMBDA_HTTP_ENDPOINT`.
 */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const { host, port } = lambdaHttpEndpoint();

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const services = entrypointLayer(entrypoint).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(Region.fromEnv()),
    Layer.provideMerge(Endpoint.fromEnv()),
    Layer.provideMerge(NodeHttpServer({ hostname: host, port })),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        // Auto-bound `Config` values arrive in the env as Redacted markers;
        // reify them so a `Config` re-read inside a handler decodes the raw
        // source value.
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
    Layer.provideMerge(Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info")),
  );

  const program = Effect.gen(function* () {
    const managed = yield* Effect.serviceOption(ManagedHttpShutdown);
    if (Option.isNone(managed)) {
      return yield* resolveProgram("program").pipe(Effect.provide(services), Effect.scoped);
    }
    // Instance services outlive both HTTP responses and run finalizers;
    // they close last, inside the SIGTERM window.
    const context = yield* Layer.buildWithScope(services, managed.value.dependencies);
    return yield* resolveProgram("program").pipe(
      Effect.provideContext(context),
      Scope.provide(managed.value.dependencies),
    );
  });

  return runProcess("Lambda web function", program, {
    managedHttpShutdownTimeoutMs: SHUTDOWN_BUDGET_MS,
  });
};
