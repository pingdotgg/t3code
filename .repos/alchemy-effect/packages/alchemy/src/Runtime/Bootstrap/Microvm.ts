/**
 * Process bootstrap core for `AWS.Lambda.MicrovmImage` images. The runtime
 * (`bun` | `node`) is chosen at deploy time, and each is an optional peer,
 * so the platform-specific layers are supplied by the thin entry modules
 * {@link ./MicrovmBun.ts} / {@link ./MicrovmNode.ts} rather than imported
 * here. The generated entry imports one of those and the user's `main`,
 * nothing else — see {@link ./Process.ts} for why.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackConstant,
} from "./Process.ts";

export interface MicrovmBootstrapOptions {
  /** Port to serve on when the VM does not inject `PORT`. */
  readonly port: number;
  /** Stack identity baked in at deploy time. */
  readonly stack: { readonly name: string; readonly stage: string };
}

export interface MicrovmRuntime {
  /** `BunServices.layer` / `NodeServices.layer`. */
  readonly services: Layer.Layer<any>;
  /** `BunHttpServer()` / `NodeHttpServer()`; both listen on `PORT`. */
  readonly httpServer: Layer.Layer<any, any, any>;
}

/** Serve the bundled in-VM program on the runtime's HTTP server. */
export const bootstrapMicrovm = (
  runtime: MicrovmRuntime,
  entrypoint: unknown,
  options: MicrovmBootstrapOptions,
): Promise<void> => {
  // The HTTP server listens on `PORT`; default it to the image's port when
  // the VM does not inject one.
  process.env.PORT ??= String(options.port);

  const platform = Layer.mergeAll(
    runtime.services,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("default", { telemetry: true }).pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(
          stackConstant(options.stack.name, options.stack.stage),
        ),
        Layer.provideMerge(runtime.httpServer),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info"),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess(`MicroVM (port ${process.env.PORT})`, program);
};
