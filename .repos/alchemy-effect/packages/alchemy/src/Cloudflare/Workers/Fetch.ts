import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";
import * as Binding from "../../Binding.ts";
import { isWorker, type Worker, WorkerEnvironment } from "./Worker.ts";

export class Fetch extends Binding.Service<
  Fetch,
  (
    worker: Worker,
  ) => Effect.Effect<
    (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.RequestError
    >
  >
>()("Cloudflare.Fetch") {}

export const FetchLive = Layer.effect(
  Fetch,
  Effect.gen(function* () {
    const Policy = yield* FetchPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (worker: Worker) {
      yield* Policy(worker);
      const fetcher = (env as Record<string, runtime.Fetcher>)[
        worker.LogicalId
      ];

      return (request: HttpClientRequest.HttpClientRequest) =>
        doFetch(fetcher, request);
    });
  }),
);

const doFetch = (
  fetcher: runtime.Fetcher,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.RequestError
> => {
  const urlResult = UrlParams.makeUrl(
    request.url,
    request.urlParams,
    request.hash.pipe(Option.getOrUndefined),
  );
  if (Result.isFailure(urlResult)) {
    return Effect.fail(
      new HttpClientError.InvalidUrlError({
        request,
        cause: urlResult.failure,
        description: "Failed to construct URL",
      }),
    );
  }
  const url = urlResult.success;

  const send = (body: BodyInit | undefined) =>
    Effect.mapError(
      Effect.map(
        Effect.tryPromise({
          try: () =>
            fetcher.fetch(
              url.toString() as runtime.RequestInfo,
              {
                method: request.method,
                headers: request.headers as unknown as runtime.HeadersInit,
                body,
                duplex: request.body._tag === "Stream" ? "half" : undefined,
              } as runtime.RequestInit,
            ) as unknown as Promise<Response>,
          catch: (cause) => cause,
        }),
        (response) => HttpClientResponse.fromWeb(request, response),
      ),
      (cause) =>
        new HttpClientError.TransportError({
          request,
          cause,
          description: "Service binding fetch failed",
        }),
    );

  switch (request.body._tag) {
    case "Raw":
    case "Uint8Array":
      return send(request.body.body as BodyInit);
    case "FormData":
      return send(request.body.formData);
    case "Stream":
      return Effect.flatMap(
        Effect.mapError(
          Stream.toReadableStreamEffect(request.body.stream),
          (cause) =>
            new HttpClientError.EncodeError({
              request,
              cause,
              description: "Failed to encode stream body",
            }),
        ),
        send,
      );
    default:
      return send(undefined);
  }
};

export class FetchPolicy extends Binding.Policy<
  FetchPolicy,
  (worker: Worker) => Effect.Effect<void>
>()("Cloudflare.Fetch") {}

export const FetchPolicyLive = FetchPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isWorker(host)) {
      yield* host.bind`${host}`({
        bindings: [
          {
            type: "service",
            name: host.LogicalId,
            service: host.workerName,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`FetchPolicy does not support runtime '${host.Type}'`),
      );
    }
  }),
);
