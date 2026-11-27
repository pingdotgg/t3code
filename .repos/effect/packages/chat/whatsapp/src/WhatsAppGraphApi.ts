/**
 * The minimal Graph API client the WhatsApp adapter is built on. It is
 * public, so a consumer can call an endpoint the adapter has no op for, with
 * the same error mapping and the same rule for writes.
 *
 * @stability unstable
 * @since 4.1.5
 */
import { retrySafe } from "effect/chat/ChatAdapter"
import type { ChatError, ChatErrorReason } from "effect/chat/ChatError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Errors from "./internal/errors.ts"

/**
 * Options for one Graph call.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface CallOptions {
  /** Default `GET`, or `POST` when there is a `body` or a `form`. */
  readonly method?: "GET" | "POST" | "DELETE" | undefined
  /** Sent as JSON. */
  readonly body?: Readonly<Record<string, unknown>> | undefined
  /** Sent as `multipart/form-data`, as a media upload is. */
  readonly form?: FormData | undefined
  /** Query parameters. */
  readonly params?: Readonly<Record<string, string>> | undefined
  /**
   * The call changes something. It is never repeated once the request left,
   * and a failure that may have landed is `uncertain`.
   */
  readonly write?: boolean | undefined
  /** Retry `retry` failures, as `ChatAdapter.retrySafe` does. Default true. */
  readonly retry?: boolean | undefined
}

/**
 * The minimal Graph API client, with the access token.
 *
 * **Details**
 *
 * - `call` requests `{baseUrl}/{path}` with the token as a bearer token,
 *   and succeeds with the JSON of a 2xx answer.
 * - Another answer fails with the reason for its Graph error code, whose
 *   `detail` is `graph_{code}` and whose `cause` is the Graph `error`
 *   object, or for its HTTP status when it has no Graph error.
 * - A write never repeats once the request left: a transport failure, a
 *   server error or an unreadable answer is `uncertain`. A refusal that
 *   Meta answers before sending, such as a rate limit, is retried unless
 *   `retry: false`, as a read's `retry` failures are.
 * - The error's `op` is the path.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class WhatsAppGraphApi extends Context.Service<WhatsAppGraphApi, {
  readonly call: (path: string, options?: CallOptions | undefined) => Effect.Effect<Schema.Json, ChatError>
}>()("@effect/chat-whatsapp/WhatsAppGraphApi") {}

/**
 * The Graph API version the adapter was written against.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const defaultBaseUrl = "https://graph.facebook.com/v24.0"

/**
 * Builds the client from an `HttpClient` and a system user access token.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const make = Effect.fnUntraced(function*(options: {
  readonly accessToken: Redacted.Redacted
  readonly baseUrl?: string | undefined
}) {
  const http = yield* HttpClient.HttpClient
  const baseUrl = options.baseUrl ?? defaultBaseUrl

  const once = (path: string, callOptions: CallOptions) => {
    const write = callOptions.write === true
    const fail = (reason: ChatErrorReason) => Effect.fail(Errors.chatError(path, reason))
    const method = callOptions.method ??
      (callOptions.body !== undefined || callOptions.form !== undefined ? "POST" : "GET")
    let request = HttpClientRequest.make(method)(`${baseUrl}/${path}`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(options.accessToken))
    )
    if (callOptions.params !== undefined) request = HttpClientRequest.setUrlParams(request, callOptions.params)
    if (callOptions.form !== undefined) request = HttpClientRequest.bodyFormData(request, callOptions.form)
    else if (callOptions.body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, callOptions.body)
    return http.execute(request).pipe(
      Effect.catch((error) => fail(Errors.transport(write, error.reason._tag, error))),
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              response.status >= 200 && response.status < 300
                ? fail(Errors.invalidResponse(write, "invalid_json", error))
                : fail(Errors.reasonForStatus(response.status, { write })),
            onSuccess: (json): Effect.Effect<Schema.Json, ChatError> => {
              if (response.status >= 200 && response.status < 300) return Effect.succeed(json)
              const graph = Errors.graphError(json)
              const cause = Predicate.hasProperty(json, "error") ? json.error : json
              return fail(
                graph === undefined
                  ? Errors.reasonForStatus(response.status, { write, cause })
                  : Errors.reasonForGraphError(graph, { write, cause })
              )
            }
          })
        )
      )
    )
  }

  return WhatsAppGraphApi.of({
    call: (path, callOptions = {}) => {
      const call = once(path, callOptions)
      return callOptions.retry === false ? call : retrySafe(call)
    }
  })
})

/**
 * The client as a layer.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly accessToken: Redacted.Redacted
  readonly baseUrl?: string | undefined
}): Layer.Layer<WhatsAppGraphApi, never, HttpClient.HttpClient> => Layer.effect(WhatsAppGraphApi, make(options))
