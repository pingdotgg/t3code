import {
  ChatError,
  type ChatErrorReason,
  fileRefused as fileRefusedDetail,
  Forbidden,
  InvalidRequest,
  InvalidResponse,
  NoAdapter,
  NotFound,
  PlatformUnavailable,
  RateLimited,
  TooLarge,
  Transport,
  Unauthenticated,
  Unknown,
  Unsupported
} from "effect/chat/ChatError"
import * as Duration from "effect/Duration"
import { isObject } from "effect/Predicate"
import { platform } from "./normalize.ts"

/** Discord's JSON error codes, by what they mean. */
const notFoundCodes = new Set([10003, 10004, 10007, 10008, 10013, 10014, 10015])
const forbiddenCodes = new Set([20001, 20028, 50001, 50005, 50013, 50021, 50083, 160005, 160006])
const unauthenticatedCodes = new Set([0, 40001])
const tooLargeFiles = new Set([40005, 50045])

/** A 50035 whose errors say a field is too long. */
const isTooLong = (data: { readonly [x: PropertyKey]: unknown }): boolean =>
  JSON.stringify(data.errors ?? {}).includes("MAX_LENGTH")

const withCause = (cause: unknown) => (cause === undefined ? {} : { cause })

/**
 * The reason for an answer Discord sent: a JSON error `code` when there is
 * one, otherwise the HTTP status. `detail` is the code, or `http_{status}`.
 *
 * @internal
 */
export const reasonForResponse = (
  status: number,
  data: unknown,
  options: { readonly write: boolean; readonly cause?: unknown }
): ChatErrorReason => {
  const body = isObject(data) ? data : {}
  const code = typeof body.code === "number" ? body.code : undefined
  const cause = withCause(options.cause)
  if (status === 429) {
    const seconds = typeof body.retry_after === "number" ? body.retry_after : undefined
    return new RateLimited({
      detail: code === undefined ? "http_429" : String(code),
      ...cause,
      ...(seconds === undefined || seconds < 0 ? {} : { retryAfter: Duration.millis(Math.ceil(seconds * 1000)) })
    })
  }
  if (status >= 500) {
    return new PlatformUnavailable({ retry: options.write ? "uncertain" : "retry", detail: `http_${status}`, ...cause })
  }
  const detail = code === undefined ? `http_${status}` : String(code)
  if (code !== undefined) {
    if (notFoundCodes.has(code)) return new NotFound({ detail, ...cause })
    if (forbiddenCodes.has(code)) return new Forbidden({ detail, ...cause })
    if (tooLargeFiles.has(code)) return new TooLarge({ subject: "files", detail, ...cause })
    if (code === 50035 && isTooLong(body)) return new TooLarge({ subject: "text", detail, ...cause })
    if (unauthenticatedCodes.has(code) && status === 401) return new Unauthenticated({ detail, ...cause })
  }
  if (status === 401) return new Unauthenticated({ detail, ...cause })
  if (status === 403) return new Forbidden({ detail, ...cause })
  if (status === 404) return new NotFound({ detail, ...cause })
  if (status === 413) return new TooLarge({ subject: "files", detail, ...cause })
  return new InvalidRequest({ detail, ...cause })
}

/**
 * A request that failed before an answer came.
 *
 * @internal
 */
export const transport = (write: boolean, detail: string, cause?: unknown): ChatErrorReason =>
  new Transport({ retry: write ? "uncertain" : "retry", detail, ...withCause(cause) })

/**
 * An answer the adapter cannot read. A write may have landed.
 *
 * @internal
 */
export const invalidResponse = (write: boolean, detail: string, cause?: unknown): ChatErrorReason => {
  const fields = { detail, ...withCause(cause) }
  return write ? new Unknown(fields) : new InvalidResponse(fields)
}

/**
 * The reason for a dfx `DiscordRESTError`, read structurally so no dfx
 * type is needed: an `ErrorResponse` or `RatelimitedResponse` carries
 * Discord's body in `data`, and an `HttpClientError` carries a `reason`.
 *
 * @internal
 */
export const reasonForRestError = (error: unknown, options: { readonly write: boolean }): ChatErrorReason => {
  const tagged = isObject(error) ? error : {}
  const tag = tagged._tag
  const response = isObject(tagged.response) ? tagged.response : undefined
  const status = typeof response?.status === "number" ? response.status : undefined
  if (tag === "ErrorResponse" || tag === "RatelimitedResponse") {
    return reasonForResponse(status ?? (tag === "RatelimitedResponse" ? 429 : 400), tagged.data, {
      write: options.write,
      cause: error
    })
  }
  if (tag === "HttpClientError" && isObject(tagged.reason)) {
    const reason = tagged.reason
    const reasonResponse = isObject(reason.response) ? reason.response : undefined
    const reasonStatus = typeof reasonResponse?.status === "number" ? reasonResponse.status : undefined
    // An error status whose body is not JSON, such as a 413 from the edge, is still Discord's answer.
    if (reasonStatus !== undefined && reasonStatus >= 400 && reasonStatus < 500) {
      return reasonForResponse(reasonStatus, undefined, { write: options.write, cause: error })
    }
    switch (reason._tag) {
      case "StatusCodeError":
        return reasonForResponse(reasonStatus ?? 500, undefined, { write: options.write, cause: error })
      case "TransportError":
        return transport(options.write, "transport", error)
      case "EncodeError":
      case "InvalidUrlError":
        return new InvalidRequest({ detail: String(reason._tag), cause: error })
      default:
        return invalidResponse(options.write, String(reason._tag), error)
    }
  }
  return new Unknown({ detail: "unknown", cause: error })
}

/** @internal */
export const chatError = (op: string, reason: ChatErrorReason): ChatError => new ChatError({ platform, op, reason })

/** @internal */
export const invalidRequest = (detail: string): ChatErrorReason => new InvalidRequest({ detail })

/** @internal */
export const notFound = (detail: string): ChatErrorReason => new NotFound({ detail })

/**
 * Whether a failure carries Discord's JSON error code `code`.
 *
 * @internal
 */
export const hasCode = (code: number) => (error: ChatError): boolean => error.reason.detail === String(code)

/**
 * A `denied` reason from a post that carries files, as a refused file: the
 * same reason with detail `file_refused`, and the reason it replaces, with
 * Discord's code, as its `cause`. Any other reason is returned as it is.
 *
 * @internal
 */
export const fileRefused = (reason: ChatErrorReason): ChatErrorReason => {
  if (reason.retry !== "denied" || reason.detail === fileRefusedDetail) return reason
  const fields = { detail: fileRefusedDetail, cause: reason }
  switch (reason._tag) {
    case "Unsupported":
      return new Unsupported({ capability: reason.capability, ...fields })
    case "Transport":
      return new Transport({ retry: reason.retry, ...fields })
    case "PlatformUnavailable":
      return new PlatformUnavailable({ retry: reason.retry, ...fields })
    case "NoAdapter":
      return new NoAdapter(fields)
    case "Unauthenticated":
      return new Unauthenticated(fields)
    case "Forbidden":
      return new Forbidden(fields)
    case "NotFound":
      return new NotFound(fields)
    case "TooLarge":
      return new TooLarge({ ...(reason.subject === undefined ? {} : { subject: reason.subject }), ...fields })
    case "InvalidRequest":
      return new InvalidRequest(fields)
    case "InvalidResponse":
      return new InvalidResponse(fields)
    case "RateLimited":
    case "Unknown":
      return reason
  }
}
