/**
 * Runtime bootstrap for Effect-native `GCP.CloudFunctions.Function`. The
 * generated entry imports this module and the user's `main`, and exports
 * {@link makeHandler}'s result as the Functions Framework target.
 *
 * The Node.js Functions Framework owns the HTTP server, so the program's
 * `HttpServer` here is a capture: `serve` records the composed handler
 * (event-source listeners, then the user's `fetch`) and each framework
 * request is bridged into it as a web `Request`. The program — built once
 * per instance, like the Cloud Run bootstrap — runs in the background for
 * the instance's lifetime.
 *
 * Runtime credentials come from the metadata server: the function's
 * runtime service account.
 */
import { NodeServices } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as EffectHttp from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { fromMetadataServer } from "../../GCP/MetadataCredentials.ts";
import { HttpServer, safeHttpEffect } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import { entrypointLayer, resolveProgram, stackFromEnv } from "./Process.ts";

/** Web-standard dispatcher over the program's composed HTTP handler. */
type Dispatch = (request: Request) => Promise<Response>;

/** The subset of the Functions Framework (Express) request/response used. */
interface FrameworkRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
}
interface FrameworkResponse {
  status(code: number): FrameworkResponse;
  setHeader(name: string, value: string | string[]): void;
  end(body?: Uint8Array): void;
}

const toWebRequest = (req: FrameworkRequest): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const url = `https://${host ?? "function"}${req.originalUrl ?? req.url}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody && req.rawBody ? new Uint8Array(req.rawBody) : undefined,
  });
};

const writeResponse = async (res: FrameworkResponse, response: Response) => {
  res.status(response.status);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
};

/**
 * `HttpServer` whose `serve` publishes a dispatcher instead of binding a
 * port. Requests run under the program's context and their own scope.
 */
const captureServer = (dispatch: Deferred.Deferred<Dispatch>) =>
  Layer.succeed(HttpServer, {
    serve: (handler) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<any>();
        const safe = safeHttpEffect(handler as any);
        const run: Dispatch = (webRequest) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const request = HttpServerRequest.fromWeb(webRequest);
              const scope = yield* Scope.make();
              const out = yield* Deferred.make<Response>();
              yield* EffectHttp.toHandled(safe, (req, response) =>
                Deferred.succeed(
                  out,
                  HttpServerResponse.toWeb(
                    EffectHttp.scopeTransferToStream(response),
                    { withoutBody: req.method === "HEAD", context },
                  ),
                ),
              ).pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  request,
                ),
                Effect.provideService(Scope.Scope, scope),
              );
              const response = yield* Deferred.await(out);
              yield* Scope.close(scope, Exit.void);
              return response;
            }).pipe(Effect.provideContext(context as Context.Context<never>)),
          );
        yield* Deferred.succeed(dispatch, run);
      }) as any,
  });

/**
 * Build the Functions Framework target for `entrypoint`. The program starts
 * when the framework loads the module and is reused by every request on
 * the instance.
 */
export const makeHandler = (entrypoint: unknown) => {
  const start = (): Promise<Dispatch> => {
    const dispatch = Deferred.makeUnsafe<Dispatch>();
    const platform = Layer.mergeAll(
      NodeServices.layer,
      FetchHttpClient.layer,
      Logger.layer([Logger.consolePretty()]),
    );
    const program = resolveProgram("program", { telemetry: true }).pipe(
      Effect.provide(
        entrypointLayer(entrypoint).pipe(
          Layer.provideMerge(stackFromEnv),
          Layer.provideMerge(fromMetadataServer()),
          Layer.provideMerge(captureServer(dispatch)),
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
    Effect.runFork(
      program.pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Cloud Function program failed", cause),
        ),
        // A program that ends (or fails) without serving never answers;
        // fail pending and future requests instead of hanging them.
        Effect.onExit(() =>
          Deferred.die(
            dispatch,
            new Error("Cloud Function program exited without serving HTTP"),
          ),
        ),
      ) as Effect.Effect<unknown>,
    );
    return Effect.runPromise(Deferred.await(dispatch));
  };

  const ready = start();
  // Surface a failed boot through the requests, not an unhandled rejection.
  ready.catch(() => undefined);

  return async (req: FrameworkRequest, res: FrameworkResponse) => {
    try {
      const dispatch = await ready;
      await writeResponse(res, await dispatch(toWebRequest(req)));
    } catch (error) {
      console.error("Cloud Function request failed", error);
      res.status(500).end();
    }
  };
};
