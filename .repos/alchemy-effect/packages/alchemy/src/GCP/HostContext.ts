import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { HttpEffect } from "../Http.ts";
import * as Http from "../Http.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
} from "../Server/Process.ts";

/**
 * Claims an inbound HTTP request for an event source (a Pub/Sub push
 * delivery, a Cloud Scheduler call, …). Return `undefined` to pass the
 * request on to the next listener and finally the user's `fetch`.
 */
export type GcpHttpListener = (
  request: HttpServerRequest,
) =>
  | Effect.Effect<HttpServerResponse.HttpServerResponse, never, any>
  | undefined;

/**
 * Runtime context of an HTTP-serving GCP host (`GCP.Run.Service`,
 * `GCP.CloudFunctions.Function`). Extends the process host context with
 * `listen`, the counterpart of `host.listen` on a Cloudflare Worker or an
 * AWS Lambda: event sources register listeners that see every request
 * before the user's `fetch` handler.
 */
export interface GcpHostRuntimeContext extends HostRuntimeContext {
  listen: (listener: GcpHttpListener) => Effect.Effect<void>;
}

export const isGcpListenHost = (
  value: unknown,
): value is GcpHostRuntimeContext & { LogicalId: string; Type: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { listen?: unknown }).listen === "function" &&
  typeof (value as { serve?: unknown }).serve === "function";

const notFound = Effect.succeed(
  HttpServerResponse.text("Not Found", { status: 404 }),
);

export const createGcpHostRuntimeContext =
  (type: string) =>
  (id: string): GcpHostRuntimeContext => {
    const base = createHostRuntimeContext(type)(id);
    const listeners: GcpHttpListener[] = [];
    let served = false;

    // Listeners are read per request, so it does not matter whether an
    // event source registers before or after the user's `fetch` is served.
    const route = <Req>(
      handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
    ): HttpEffect<Req> =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        for (const listener of listeners) {
          const claimed = listener(request);
          if (claimed !== undefined) return yield* claimed;
        }
        return yield* Http.safeHttpEffect(handler);
      }) as HttpEffect<Req>;

    return {
      ...base,
      listen: (listener) =>
        Effect.sync(() => {
          listeners.push(listener);
        }),
      serve: ((handler, options) => {
        served = true;
        return base.serve(route(handler as HttpEffect<any>), options);
      }) as HostRuntimeContext["serve"],
      // A host whose only job is consuming events has no `fetch`, so the
      // Platform never calls `serve`; start the server for the listeners.
      exports: Effect.gen(function* () {
        if (!served && listeners.length > 0) {
          served = true;
          yield* base.serve(route(notFound));
        }
        return yield* base.exports;
      }),
    };
  };
