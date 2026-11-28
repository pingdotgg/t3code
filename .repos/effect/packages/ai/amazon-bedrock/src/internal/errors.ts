import * as AiError from "effect/ai/AiError"
import * as Effect from "effect/Effect"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redactable from "effect/Redactable"
import * as Schema from "effect/Schema"
import type { EventStreamError } from "./eventStream.ts"

const module = "AmazonBedrockClient"

/**
 * An `AiError` of the client module.
 *
 * @internal
 */
export const make = (method: string, reason: AiError.AiErrorReason): AiError.AiError =>
  AiError.make({ module, method, reason })

// =============================================================================
// Error Mappers
// =============================================================================

/** @internal */
export const mapSchemaError = (error: Schema.SchemaError, method: string): AiError.AiError =>
  make(method, AiError.InvalidResponseError.fromSchemaError(error))

/** @internal */
export const mapEventStreamError = (error: EventStreamError, method: string): AiError.AiError =>
  make(method, new AiError.InvalidResponseError({ description: error.description }))

/**
 * Maps an exception frame of a ConverseStream response, such as a
 * `throttlingException`, to the reason its REST counterpart would have.
 *
 * @internal
 */
export const mapStreamException = (
  exceptionType: string,
  message: string | undefined,
  method: string
): AiError.AiError => {
  const description = Predicate.isUndefined(message) ? exceptionType : `${exceptionType}: ${message}`
  return make(
    method,
    exceptionType === "throttlingException"
      ? new AiError.RateLimitError({})
      : exceptionType === "validationException"
      ? new AiError.InvalidRequestError({ description })
      : new AiError.InternalProviderError({ description })
  )
}

/** @internal */
export const mapHttpClientError = (
  error: HttpClientError.HttpClientError,
  method: string
): Effect.Effect<never, AiError.AiError> => {
  const reason = error.reason
  switch (reason._tag) {
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError": {
      return Effect.fail(make(method, AiError.NetworkError.fromRequestError(reason)))
    }
    case "StatusCodeError": {
      return mapStatusCodeError(reason, method)
    }
    case "DecodeError":
    case "EmptyBodyError": {
      return Effect.fail(make(
        method,
        new AiError.InvalidOutputError({
          description: reason.description ??
            (reason._tag === "DecodeError" ? "Failed to decode response" : "Response body was empty")
        })
      ))
    }
  }
}

// Bedrock REST errors are flat `{ "message": "..." }` bodies (AWS uses both
// casings), with the exception type in the `x-amzn-errortype` header.
const BedrockErrorBody = Schema.fromJsonString(Schema.Struct({
  message: Schema.optional(Schema.String),
  Message: Schema.optional(Schema.String)
}))

const decodeErrorBody = Schema.decodeUnknownOption(BedrockErrorBody)

const mapStatusCodeError = Effect.fnUntraced(function*(
  error: HttpClientError.StatusCodeError,
  method: string
) {
  const { description, request, response } = error

  let body: string | undefined = description
  if (!description?.startsWith("{")) {
    const responseBody = yield* Effect.option(response.text)
    if (Option.isSome(responseBody) && responseBody.value) {
      body = responseBody.value
    }
  }

  const decoded = decodeErrorBody(body)
  const message = Option.isSome(decoded) ? decoded.value.message ?? decoded.value.Message : undefined

  return yield* make(
    method,
    mapStatusCodeToReason({
      status: response.status,
      requestMethod: request.method,
      url: request.url,
      message,
      // AWS sends the exception shape as `Name:http://internal.amazon.com/coral/...`.
      errorType: response.headers["x-amzn-errortype"]?.split(":")[0],
      http: {
        response: {
          status: response.status,
          headers: Redactable.redact(response.headers) as Record<string, string>
        },
        body
      }
    })
  )
})

// =============================================================================
// HTTP Status Code
// =============================================================================

/**
 * Bedrock answers 403 for several unrelated problems: a bad key, an expired
 * session token and a model the account is not entitled to all arrive as 403.
 * The exception shape in `x-amzn-errortype` distinguishes them.
 */
const authenticationKinds: Record<string, AiError.AuthenticationError["kind"]> = {
  AccessDeniedException: "InsufficientPermissions",
  ExpiredTokenException: "ExpiredKey",
  IncompleteSignatureException: "InvalidKey",
  InvalidSignatureException: "InvalidKey",
  MissingAuthenticationTokenException: "MissingKey",
  UnrecognizedClientException: "InvalidKey"
}

const mapStatusCodeToReason = ({ errorType, http, message, requestMethod, status, url }: {
  readonly requestMethod: string
  readonly url: string
  readonly status: number
  readonly message: string | undefined
  readonly errorType: string | undefined
  readonly http: typeof AiError.HttpContext.Type
}): AiError.AiErrorReason => {
  // AWS sends this with a 400, but the request is well formed: the account
  // has used up a quota.
  if (errorType === "ServiceQuotaExceededException") {
    return new AiError.QuotaExhaustedError({ http })
  }

  const describe = (text: string | undefined): string | undefined =>
    Predicate.isUndefined(errorType) ? text : Predicate.isUndefined(text) ? errorType : `${errorType}: ${text}`

  switch (status) {
    case 400:
    case 404:
    case 422: {
      const summary = message ?? `HTTP ${status}`
      return new AiError.InvalidRequestError({
        description: describe(`${summary} (${requestMethod} ${url})`),
        http
      })
    }
    case 401:
    case 403: {
      return new AiError.AuthenticationError({
        kind: (Predicate.isNotUndefined(errorType) ? authenticationKinds[errorType] : undefined)
          ?? (status === 401 ? "InvalidKey" : "InsufficientPermissions"),
        description: describe(message),
        http
      })
    }
    case 408:
    case 424: {
      // ModelTimeoutException and ModelErrorException: the model failed to
      // answer in time, or answered with an error.
      return new AiError.InternalProviderError({
        description: describe(message) ?? "Model error",
        http
      })
    }
    case 429: {
      return new AiError.RateLimitError({ http })
    }
    default: {
      if (status >= 500) {
        return new AiError.InternalProviderError({
          description: describe(message) ?? "Server error",
          http
        })
      }
      return new AiError.UnknownError({
        description: describe(message),
        http
      })
    }
  }
}
