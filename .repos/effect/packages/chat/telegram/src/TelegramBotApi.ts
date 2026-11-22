/**
 * The minimal Bot API client the Telegram adapter is built on. It is public,
 * so a consumer can call a method the adapter has no op for, with the same
 * error mapping, the same rule for writes and the same care for the token.
 *
 * **Details**
 *
 * The bot token is part of every request's path, and `HttpClient` records
 * the path of a request in its span and in its errors. So the client's own
 * span is turned off for every request made here, and each call gets a span
 * `TelegramBotApi.{method}` whose `url.path` is `/bot<redacted>/{method}`.
 * Every failure becomes a `ChatError` whose `cause` holds no request,
 * response or URL.
 *
 * @stability unstable
 * @since 4.1.5
 */
import { type File, retrySafe } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import { ChatThread } from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import { isObject } from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Address from "./internal/address.ts"
import * as Errors from "./internal/errors.ts"

/**
 * Which Telegram environment a bot lives in. The test environment has its
 * own accounts and bots, and its methods sit under `/bot<token>/test/`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Environment = "production" | "test"

/**
 * The cause of a `NotFound` with detail `chat_migrated`: the group became
 * a supergroup, which has a new chat id. The adapter does not follow it,
 * since the consumer is the one that stores the old address.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class TelegramChatMigrated extends Schema.TaggedError<TelegramChatMigrated>(
  "@effect/chat-telegram/TelegramBotApi/TelegramChatMigrated"
)("TelegramChatMigrated", {
  thread: ChatThread
}) {
  override get message(): string {
    return "The Telegram group became a supergroup with a new address"
  }
}

/**
 * Options for one Bot API call.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface CallOptions {
  /**
   * The call changes something. It is never repeated once the request left,
   * and a failure that may have landed is `uncertain`.
   */
  readonly write?: boolean | undefined
  /** Files sent as parts of a `multipart/form-data` body, each under its `field`. */
  readonly files?: ReadonlyArray<{ readonly field: string; readonly file: File }> | undefined
  /** Retry `retry` failures, as `ChatAdapter.retrySafe` does. Default true. */
  readonly retry?: boolean | undefined
}

/**
 * The Bot API client, with the bot's token.
 *
 * **Details**
 *
 * - `call` posts `params` to a method and succeeds with its `result`.
 *   Objects in `params` are sent as JSON; with `files` the body is
 *   multipart and each object is a JSON string part.
 * - An answer with `ok: false` fails with the reason for its `error_code`
 *   and `parameters`. Its `detail` is a fixed string, never Telegram's
 *   description, which can quote the message. A `migrate_to_chat_id` gives
 *   `NotFound` with detail `chat_migrated` and a `TelegramChatMigrated`
 *   cause.
 * - `file` streams a file by its `file_path` from `getFile`, failing
 *   `TooLarge` once more than `maxBytes` arrive. Redirects are refused.
 * - `botId` is the numeric id in front of the token's colon.
 * - The error's `op` is the method.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class TelegramBotApi extends Context.Service<TelegramBotApi, {
  readonly botId: string
  readonly environment: Environment
  readonly call: (
    method: string,
    params?: Readonly<Record<string, unknown>> | undefined,
    options?: CallOptions | undefined
  ) => Effect.Effect<Schema.Json, ChatError>
  readonly file: (filePath: string, options: { readonly maxBytes: number }) => Stream.Stream<Uint8Array, ChatError>
}>()("@effect/chat-telegram/TelegramBotApi") {}

/**
 * The cloud Bot API server.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const defaultApiUrl = "https://api.telegram.org"

const methodName = /^[A-Za-z]{1,64}$/
const filePath = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/

const formValue = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value)

/**
 * Builds the client from an `HttpClient` and a bot token.
 *
 * **Details**
 *
 * Fails `Unauthenticated` with detail `invalid_token` when the token has
 * no numeric bot id in front of a colon. `apiUrl` is for a local Bot API
 * server and is privileged configuration.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const make = Effect.fnUntraced(function*(options: {
  readonly token: Redacted.Redacted<string>
  readonly environment?: Environment | undefined
  readonly apiUrl?: string | undefined
}) {
  const http = yield* HttpClient.HttpClient
  const environment = options.environment ?? "production"
  const apiUrl = (options.apiUrl ?? defaultApiUrl).replace(/\/+$/, "")
  const botId = /^(\d{1,20}):[A-Za-z0-9_-]+$/.exec(Redacted.value(options.token))?.[1]
  if (botId === undefined) {
    return yield* Errors.fail("layer", Errors.unauthenticatedToken)
  }
  const suffix = environment === "test" ? "/test" : ""
  const methodUrl = (method: string) => `${apiUrl}/bot${Redacted.value(options.token)}${suffix}/${method}`
  const fileUrl = (path: string) => `${apiUrl}/file/bot${Redacted.value(options.token)}${suffix}/${path}`

  // Redirects are never followed: the next hop would see the token in the path.
  const send = (request: HttpClientRequest.HttpClientRequest, op: string, write: boolean) =>
    Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
      http.execute(request).pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, {
          ...(init._tag === "Some" ? init.value : {}),
          redirect: "manual"
        }),
        Effect.mapError((error) => Errors.chatError(op, Errors.transport(write, error.reason._tag)))
      ))

  const decode = (op: string, write: boolean, response: HttpClientResponse.HttpClientResponse) => {
    const success = response.status >= 200 && response.status < 300
    const statusError: Errors.ApiError = { code: response.status, description: "" }
    return response.json.pipe(
      Effect.matchEffect({
        onFailure: () =>
          Errors.fail(
            op,
            success ? Errors.invalidResponse(write, "invalid_json") : Errors.reasonForApiError(statusError, { write })
          ),
        onSuccess: (body): Effect.Effect<Schema.Json, ChatError> => {
          if (isObject(body) && body.ok === true && "result" in body) return Effect.succeed(body.result as Schema.Json)
          const error = Errors.apiError(body, response.status) ?? (success ? undefined : statusError)
          if (error === undefined) return Errors.fail(op, Errors.invalidResponse(write, "invalid_answer"))
          const cause = error.migrateTo === undefined
            ? undefined
            : new TelegramChatMigrated({ thread: Address.thread(error.migrateTo) })
          return Errors.fail(op, Errors.reasonForApiError(error, { write, cause }))
        }
      })
    )
  }

  const once = (method: string, params: Readonly<Record<string, unknown>>, callOptions: CallOptions) => {
    const write = callOptions.write === true
    let request = HttpClientRequest.post(methodUrl(method))
    if (callOptions.files !== undefined && callOptions.files.length > 0) {
      const form = new FormData()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) form.append(key, formValue(value))
      }
      for (const { field, file } of callOptions.files) {
        form.append(
          field,
          new Blob([file.content as Uint8Array<ArrayBuffer>], { type: file.contentType }),
          file.name
        )
      }
      request = HttpClientRequest.bodyFormData(request, form)
    } else {
      request = HttpClientRequest.bodyJsonUnsafe(request, params)
    }
    return Effect.flatMap(send(request, method, write), (response) => decode(method, write, response)).pipe(
      Effect.withSpan(`TelegramBotApi.${method}`, {
        kind: "client",
        attributes: {
          "http.request.method": "POST",
          "url.path": `/bot<redacted>${suffix}/${method}`,
          "telegram.method": method
        }
      })
    )
  }

  const call: TelegramBotApi["Service"]["call"] = (method, params = {}, callOptions = {}) => {
    if (!methodName.test(method)) return Errors.fail(method, Errors.invalidRequest("invalid_method"))
    const effect = once(method, params, callOptions)
    return callOptions.retry === false ? effect : retrySafe(effect)
  }

  const file: TelegramBotApi["Service"]["file"] = (path, { maxBytes }) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const op = "download"
        if (!filePath.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
          return yield* Errors.fail(op, Errors.invalidResponse(false, "untrusted_file_path"))
        }
        const url = fileUrl(path)
        const response = yield* send(HttpClientRequest.get(url), op, false)
        if ((response.status >= 300 && response.status < 400) || response.url !== url) {
          return yield* Errors.fail(op, Errors.invalidResponse(false, "redirect"))
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* Errors.fail(
            op,
            Errors.reasonForApiError({ code: response.status, description: "" }, { write: false })
          )
        }
        const tooLarge = Errors.chatError(op, Errors.tooLarge("files", "max_bytes"))
        const length = Number(response.headers["content-length"])
        if (Number.isFinite(length) && length > maxBytes) return yield* Effect.fail(tooLarge)
        let received = 0
        return response.stream.pipe(
          Stream.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag))),
          Stream.mapEffect((chunk) => {
            received += chunk.length
            return received > maxBytes ? Effect.fail(tooLarge) : Effect.succeed(chunk)
          })
        )
      }).pipe(
        Effect.withSpan("TelegramBotApi.file", {
          kind: "client",
          attributes: { "http.request.method": "GET", "url.path": "/file/bot<redacted>" }
        })
      )
    )

  return TelegramBotApi.of({ botId, environment, call, file })
})

/**
 * The client as a layer.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = (options: {
  readonly token: Redacted.Redacted<string>
  readonly environment?: Environment | undefined
  readonly apiUrl?: string | undefined
}): Layer.Layer<TelegramBotApi, ChatError, HttpClient.HttpClient> => Layer.effect(TelegramBotApi, make(options))
