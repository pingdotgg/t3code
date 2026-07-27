import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { HttpEffect } from "../Http.ts";
import * as Http from "../Http.ts";
import * as Output from "../Output.ts";
import {
  packEnvValue,
  unpackEnvValue,
  type BaseRuntimeContext,
} from "../RuntimeContext.ts";

export type ProcessServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal;

export interface ProcessContext extends BaseRuntimeContext {
  run: <Req = never, RunReq = never>(
    effect: Effect.Effect<void, never, RunReq>,
  ) => Effect.Effect<void, never, Req | RunReq>;
}

/**
 * Long-running host loop registration (`run`). Provided by `Platform` when the
 * execution context implements {@link ProcessContext} (i.e. carries `run`).
 *
 * `Platform` wires this automatically for every host runtime context that
 * implements `run` (EC2 instances, ECS tasks, processes), so an inline program
 * can `yield* ServerHost` and call `host.run(...)` during plan/deploy without
 * the caller providing the layer itself.
 */
export class ServerHost extends Context.Service<
  ServerHost,
  Pick<ProcessContext, "run">
>()("Alchemy::ServerHost") {}

/**
 * Deploy-time / plan-time host context for platforms that bundle a long-lived
 * program. It collects background work registered via `run` and HTTP handlers
 * registered via `serve` into a single `exports.program` effect that the
 * generated container/instance entrypoint runs.
 */
export interface HostRuntimeContext extends ProcessContext {
  serve: <Req = never>(
    handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
    options?: { shape?: Record<string, unknown> },
  ) => Effect.Effect<void, never, Req>;
  exports: Effect.Effect<{
    readonly program: Effect.Effect<void, never, any>;
  }>;
}

/**
 * Build a {@link HostRuntimeContext} for a hosted platform of the given
 * resource `type`. Both `run` (background loops) and `serve` (HTTP handlers)
 * append to a single list of runners; `exports.program` runs them all
 * concurrently. This is the shared host context used by `AWS.EC2.Instance` and
 * `AWS.ECS.Task`.
 */
export const createHostRuntimeContext =
  (type: string) =>
  (id: string): HostRuntimeContext => {
    const runners: Effect.Effect<void, never, any>[] = [];
    const env: Record<string, any> = {};

    return {
      Type: type,
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          // `packEnvValue` marker-packs Redacted values so they survive the
          // Output → env round-trip.
          env[key] = output.pipe(Output.map(packEnvValue));
          return key;
        }),
      get: <T>(key: string) =>
        // Read straight from `process.env` — see `unpackEnvValue` for why
        // this must never resolve through `Config.string`.
        Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
      run: (effect: Effect.Effect<void, never, any>) =>
        Effect.sync(() => {
          runners.push(effect);
        }),
      serve: ((handler) =>
        Effect.sync(() => {
          // Register the HTTP handler as a runner. At container runtime the
          // ambient `HttpServer` (if provided) serves it; `Http.serve` is a
          // no-op when no server is bound, so this never crashes plan/deploy.
          runners.push(Http.serve(handler as HttpEffect<any>));
        })) as HostRuntimeContext["serve"],
      exports: Effect.sync(() => ({
        program: Effect.all(runners, { concurrency: "unbounded" }),
      })),
    } satisfies HostRuntimeContext;
  };
