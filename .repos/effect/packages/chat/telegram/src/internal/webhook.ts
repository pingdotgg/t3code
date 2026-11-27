import * as ByteSize from "effect/ByteSize"
import type { ChatError } from "effect/chat/ChatError"
import { timingSafeEqual } from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Errors from "./errors.ts"
import type { Outcome } from "./receive.ts"

/** The header Telegram sends the webhook secret in. @internal */
export const secretHeader = "x-telegram-bot-api-secret-token"

/** A secret token's value, if it keeps Telegram's rule with the adapter's floor of 32 characters. @internal */
export const secretToken = (op: string, token: Redacted.Redacted<string>): Effect.Effect<string, ChatError> => {
  const secret = Redacted.value(token)
  return /^[A-Za-z0-9_-]{32,256}$/.test(secret)
    ? Effect.succeed(secret)
    : Errors.fail(op, Errors.invalidRequest("invalid_secret_token"))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const status = (code: number) => HttpServerResponse.empty({ status: code })

/**
 * One webhook request.
 *
 * - 401 without the secret, before the body is read. 413 past
 *   `maxBodySize`, 400 for a body that can't be read or is not an update.
 * - 200 once the update was accepted, answered or sent to `onUnhandled`.
 * - 503 when its event was not accepted in time, or could not be read.
 *
 * @internal
 */
export const handleRequest = (
  request: HttpServerRequest.HttpServerRequest,
  options: {
    readonly secret: Uint8Array
    readonly maxBodySize: ByteSize.ByteSize
    readonly receive: (update: unknown) => Effect.Effect<Outcome>
  }
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function*() {
    const header = request.headers[secretHeader]
    // Compared in constant time.
    if (header === undefined || !timingSafeEqual(encoder.encode(header), options.secret)) return status(401)
    const body = yield* Effect.result(
      Effect.provideService(request.arrayBuffer, HttpIncomingMessage.MaxBodySize, options.maxBodySize)
    )
    if (body._tag === "Failure") {
      const reason = body.failure.reason
      return status(reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge" ? 413 : 400)
    }
    // Measured again: the request caches its body, so one read earlier under a larger limit comes back whole.
    if (body.success.byteLength > ByteSize.toNumberUnsafe(options.maxBodySize)) return status(413)
    const update = parseJson(decoder.decode(body.success))
    if (!Predicate.isObject(update) || typeof update.update_id !== "number") return status(400)
    switch (yield* options.receive(update)) {
      case "accepted":
      case "unhandled":
        return status(200)
      case "invalid":
        return yield* Effect.as(
          Effect.logWarning("telegram webhook: the update could not be read, answered 503"),
          status(503)
        )
      case "notAccepted":
        return yield* Effect.as(
          Effect.logWarning("telegram webhook: the handler refused the event or passed the deadline, answered 503"),
          status(503)
        )
    }
  })
