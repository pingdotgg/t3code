import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Url from "effect/http/Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

/**
 * Send an Effect `HttpClientRequest` through a runtime `Fetcher` binding
 * (service binding, mTLS certificate, ...) and adapt the response.
 *
 * Internal: shared by the fetcher-shaped `Binding.Service`s and not exported
 * from the Workers barrel.
 *
 * @internal
 */
export const fetchWithFetcher = (
  fetcher: runtime.Fetcher,
  request: HttpClientRequest.HttpClientRequest,
  description: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.RequestError> => {
  const urlResult = Url.make(
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
        catch: (cause) => new HttpClientError.TransportError({ request, cause, description }),
      }),
      (response) => HttpClientResponse.fromWeb(request, response),
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
