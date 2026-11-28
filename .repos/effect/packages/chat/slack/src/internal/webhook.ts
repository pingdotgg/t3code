import * as ByteSize from "effect/ByteSize"
import type { ChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import type { NotAccepted } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as Clock from "effect/Clock"
import * as Mac from "effect/crypto/Mac"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Json from "./json.ts"
import { normalize } from "./normalize.ts"

/** How far a request's timestamp may be from now, as Slack recommends. */
const maxSkewSeconds = 60 * 5

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The default of `maxBodyBytes`. @internal */
export const defaultMaxBodyBytes = 1024 * 1024

/**
 * Checks Slack's `v0` request signature: an HMAC-SHA256 of
 * `v0:{timestamp}:{body}` with the signing secret, and a timestamp within
 * five minutes of now.
 *
 * @internal
 */
export const makeVerifier = Effect.fnUntraced(function*(signingSecret: Redacted.Redacted) {
  const mac = yield* Mac.Mac
  // Invalid signing secrets are configuration defects, not route errors.
  const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(Redacted.value(signingSecret))).pipe(Effect.orDie)
  return (headers: { readonly [key: string]: string | undefined }, body: Uint8Array): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const timestamp = headers["x-slack-request-timestamp"]
      const signature = headers["x-slack-signature"]
      if (timestamp === undefined || signature === undefined || !/^\d+$/.test(timestamp)) return false
      const tag = signature.startsWith("v0=") ? Hex.decode(signature.slice(3)) : undefined
      if (tag === undefined || Result.isFailure(tag) || tag.success.length === 0) return false
      const now = yield* Clock.currentTimeMillis
      if (Math.abs(now / 1000 - Number(timestamp)) > maxSkewSeconds) return false
      const prefix = encoder.encode(`v0:${timestamp}:`)
      const message = new Uint8Array(prefix.length + body.length)
      message.set(prefix)
      message.set(body, prefix.length)
      // Crypto failures fail closed, like a mismatched signature.
      return yield* mac.verify(key, tag.success, message).pipe(Effect.catch(() => Effect.succeed(false)))
    })
})

/**
 * The body, or `None` past `maxBodySize` or when it can't be read, both
 * answered 413. The length is checked again because the request caches its
 * body: one read earlier under a larger limit comes back as it was.
 */
const readBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBodySize: ByteSize.ByteSize
): Effect.Effect<Option.Option<Uint8Array>> =>
  request.arrayBuffer.pipe(
    Effect.map((buffer) =>
      buffer.byteLength > ByteSize.toNumberUnsafe(maxBodySize) ? Option.none() : Option.some(new Uint8Array(buffer))
    ),
    Effect.catch(() => Effect.succeedNone),
    Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBodySize)
  )

/** A slash command's form fields, as its payload. A repeated field keeps its first value. */
const commandFields = (form: URLSearchParams): Record<string, string> => {
  const fields: Record<string, string> = {}
  for (const [key, value] of form) if (!Object.hasOwn(fields, key)) Json.setOwn(fields, key, value)
  return fields
}

const ok = HttpServerResponse.empty({ status: 200 })
const status = (code: number) => HttpServerResponse.empty({ status: code })

/**
 * What is logged with each 503 of the Events API route.
 *
 * @internal
 */
export const unavailable = {
  botUser: "slack webhook: the bot user could not be read, answered 503",
  notAccepted: "slack webhook: the handler refused the event, answered 503",
  deadline: "slack webhook: the request passed its deadline, answered 503"
} as const

/** @internal */
export interface Options {
  readonly verify: (headers: { readonly [key: string]: string | undefined }, body: Uint8Array) => Effect.Effect<boolean>
  readonly appId: string
  readonly teamId: string
  readonly botUserId: Effect.Effect<string, ChatError>
  readonly handle: (event: ChatEvent.ChatEvent) => Effect.Effect<void, NotAccepted>
  readonly deadline: Duration.Duration
  readonly maxBodySize: ByteSize.ByteSize
}

/**
 * One Events API request.
 *
 * - 413 past the body limit, 401 for a bad signature, 400 for a body that
 *   is not JSON.
 * - `url_verification` is answered with its challenge.
 * - An envelope for another app or workspace, or of another type, is
 *   answered 200 and dropped, so Slack does not retry it.
 * - 503 when the bot user can't be read, the handler fails `NotAccepted`,
 *   or the whole request (including its body and verification) takes longer
 *   than the deadline. Slack then retries. Each is logged with its own
 *   message, since the status alone does not say which it was.
 *
 * @internal
 */
export const handleRequest = (
  request: HttpServerRequest.HttpServerRequest,
  options: Options
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function*() {
    const body = yield* readBody(request, options.maxBodySize)
    if (Option.isNone(body)) return status(413)
    if (!(yield* options.verify(request.headers, body.value))) return status(401)
    const envelope = Json.parse(decoder.decode(body.value))
    if (!Json.isObject(envelope)) return status(400)
    if (envelope.type === "url_verification") {
      return typeof envelope.challenge === "string"
        ? HttpServerResponse.text(envelope.challenge)
        : status(400)
    }
    if (envelope.type !== "event_callback" || envelope.api_app_id !== options.appId) return ok
    const botUserId = yield* Effect.catch(
      Effect.asSome(options.botUserId),
      (error) => Effect.as(Effect.logError(unavailable.botUser, error), Option.none<string>())
    )
    if (Option.isNone(botUserId)) return status(503)
    const events = normalize(envelope, { teamId: options.teamId, botUserId: botUserId.value })
    return yield* Effect.forEach(events, options.handle, { discard: true }).pipe(
      Effect.as(ok),
      Effect.catchTag("NotAccepted", () => Effect.as(Effect.logWarning(unavailable.notAccepted), status(503)))
    )
  }).pipe(
    Effect.timeoutOption(options.deadline),
    Effect.flatMap(Option.match({
      onNone: () => Effect.as(Effect.logWarning(unavailable.deadline), status(503)),
      onSome: Effect.succeed
    }))
  )

/** @internal */
export interface InteractivityOptions {
  readonly verify: Options["verify"]
  readonly appId: string
  readonly interaction: (
    payload: unknown,
    options: { readonly deadline: Duration.Duration }
  ) => Effect.Effect<Schema.Json | undefined | ChatInteraction.Late>
  readonly deadline: Duration.Duration
  readonly maxBodySize: ByteSize.ByteSize
}

const isLate = Schema.is(ChatInteraction.Late)

/**
 * One Interactivity request: a form-encoded body whose `payload` field
 * holds the JSON, or a slash command's, whose fields are the payload.
 *
 * - 413 past the body limit, 401 for a bad signature, 400 for a body with
 *   neither a `payload` that is a JSON object nor a `command`.
 * - A payload or command for another app is answered 200 and dropped.
 * - `Late` is answered 503, which keeps a modal open. Anything else is a
 *   200, with the body as JSON when there is one.
 *
 * @internal
 */
export const handleInteractivity = (
  request: HttpServerRequest.HttpServerRequest,
  options: InteractivityOptions
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function*() {
    const body = yield* readBody(request, options.maxBodySize)
    if (Option.isNone(body)) return status(413)
    if (!(yield* options.verify(request.headers, body.value))) return status(401)
    const form = new URLSearchParams(decoder.decode(body.value))
    const field = form.get("payload")
    const payload = field !== null ? Json.parse(field) : form.has("command") ? commandFields(form) : undefined
    if (!Json.isObject(payload)) return status(400)
    if (payload.api_app_id !== options.appId) return ok
    const answer = yield* options.interaction(payload, { deadline: options.deadline })
    if (answer === undefined) return ok
    return isLate(answer) ? status(503) : HttpServerResponse.jsonUnsafe(answer)
  })
