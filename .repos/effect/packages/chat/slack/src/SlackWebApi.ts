/**
 * The minimal Slack Web API client the adapter is built on. It is public, so
 * a consumer can call a method the adapter has no op for, with the same error
 * mapping and the same rule for writes.
 *
 * @stability unstable
 * @since 4.1.5
 */
import { retrySafe } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
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
 * Options for one Web API call.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface CallOptions {
  /**
   * The call changes something. It is never retried after the request left,
   * and a failure that may have landed is `uncertain`.
   */
  readonly write?: boolean | undefined
  /** Retry `retry` failures, as `ChatAdapter.retrySafe` does. Default true. */
  readonly retry?: boolean | undefined
}

/**
 * The minimal Web API client, with the bot token.
 *
 * **Details**
 *
 * - `call` posts form parameters to `https://slack.com/api/{method}`. A
 *   string goes as it is, any other value as JSON, and `undefined` is left
 *   out. It succeeds with the answer once Slack says `ok`.
 * - An `ok: false` answer fails with the reason for Slack's error code, which
 *   becomes the reason's `detail`. `ratelimited` and an HTTP 429 give
 *   `RateLimited` with the `Retry-After` wait.
 * - A write never repeats once the request left: a transport failure, a
 *   server error or an unreadable answer is `uncertain`. A read retries
 *   `retry` failures unless `retry: false`.
 * - The error's `op` is the method name.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class SlackWebApi extends Context.Service<SlackWebApi, {
  readonly call: (
    method: string,
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions | undefined
  ) => Effect.Effect<Schema.Json, ChatError>
}>()("@effect/chat-slack/SlackWebApi") {}

const formBody = (body: Readonly<Record<string, unknown>>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    out[key] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return out
}

/**
 * Builds the client from an `HttpClient` and a bot token.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const make = Effect.fnUntraced(function*(options: {
  readonly botToken: Redacted.Redacted
  readonly baseUrl?: string | undefined
}) {
  const http = yield* HttpClient.HttpClient
  const baseUrl = options.baseUrl ?? "https://slack.com/api"

  const once = (method: string, body: Readonly<Record<string, unknown>>, write: boolean) => {
    const fail = (reason: Parameters<typeof Errors.chatError>[1]) => Effect.fail(Errors.chatError(method, reason))
    const request = HttpClientRequest.post(`${baseUrl}/${method}`).pipe(
      HttpClientRequest.bearerToken(Redacted.value(options.botToken)),
      HttpClientRequest.bodyUrlParams(formBody(body))
    )
    return http.execute(request).pipe(
      Effect.catch((error) => fail(Errors.transport(write, error.reason._tag, error))),
      Effect.flatMap((response) => {
        const retryAfter = Errors.parseRetryAfter(response.headers["retry-after"])
        if (response.status < 200 || response.status >= 300) {
          return fail(Errors.reasonForStatus(response.status, { write, retryAfter }))
        }
        return response.json.pipe(
          Effect.catch((error) => fail(Errors.invalidResponse(write, "invalid_json", error))),
          Effect.flatMap((json): Effect.Effect<Schema.Json, ChatError> => {
            if (!Predicate.isObject(json) || typeof json.ok !== "boolean") {
              return fail(Errors.invalidResponse(write, "invalid_response"))
            }
            if (json.ok) return Effect.succeed(json)
            const code = typeof json.error === "string" ? json.error : "unknown_error"
            return fail(Errors.reasonForCode(code, { write, retryAfter }))
          })
        )
      })
    )
  }

  return SlackWebApi.of({
    call: (method, body, callOptions) => {
      const call = once(method, body, callOptions?.write === true)
      return callOptions?.retry === false ? call : retrySafe(call)
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
  readonly botToken: Redacted.Redacted
  readonly baseUrl?: string | undefined
}): Layer.Layer<SlackWebApi, never, HttpClient.HttpClient> => Layer.effect(SlackWebApi, make(options))
