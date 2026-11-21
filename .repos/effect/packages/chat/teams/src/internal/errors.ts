import {
  type Capability,
  ChatError,
  type ChatErrorReason,
  Forbidden,
  InvalidRequest,
  InvalidResponse,
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
import { platform } from "./address.ts"

/**
 * The reason for an HTTP status from the Connector. `detail` is
 * `http_{status}`, or the Connector's error `code` when it sent one, which
 * holds no message text or ids.
 *
 * @internal
 */
export const reasonForStatus = (
  status: number,
  options: {
    readonly write: boolean
    readonly code?: string | undefined
    readonly retryAfter?: Duration.Duration | undefined
    readonly cause?: unknown
  }
): ChatErrorReason => {
  const detail = options.code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(options.code)
    ? options.code
    : `http_${status}`
  const cause = options.cause === undefined ? {} : { cause: options.cause }
  if (status === 429) {
    return new RateLimited({
      detail,
      ...cause,
      ...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter })
    })
  }
  if (status >= 500) return new PlatformUnavailable({ retry: options.write ? "uncertain" : "retry", detail, ...cause })
  if (status === 401) return new Unauthenticated({ detail, ...cause })
  if (status === 403) return new Forbidden({ detail, ...cause })
  if (status === 404) return new NotFound({ detail, ...cause })
  if (status === 413) return new TooLarge({ detail, ...cause })
  return new InvalidRequest({ detail, ...cause })
}

/** A request that failed before an answer came. @internal */
export const transport = (write: boolean, detail: string, cause?: unknown): ChatErrorReason =>
  new Transport({ retry: write ? "uncertain" : "retry", detail, ...(cause === undefined ? {} : { cause }) })

/** An answer the adapter cannot read. A write may have landed. @internal */
export const invalidResponse = (write: boolean, detail: string, cause?: unknown): ChatErrorReason => {
  const fields = { detail, ...(cause === undefined ? {} : { cause }) }
  return write ? new Unknown(fields) : new InvalidResponse(fields)
}

/** @internal */
export const parseRetryAfter = (value: string | undefined): Duration.Duration | undefined => {
  if (value === undefined) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Duration.seconds(seconds) : undefined
}

/** @internal */
export const chatError = (op: string, reason: ChatErrorReason): ChatError => new ChatError({ platform, op, reason })

/** @internal */
export const withOp = (op: string) => (error: ChatError): ChatError =>
  error.op === op ? error : new ChatError({ platform: error.platform, op, reason: error.reason })

/** @internal */
export const invalidRequest = (detail: string): ChatErrorReason => new InvalidRequest({ detail })

/** @internal */
export const notFound = (detail: string): ChatErrorReason => new NotFound({ detail })

/** @internal */
export const unsupported = (capability: Capability, detail?: string): ChatErrorReason =>
  new Unsupported({ capability, ...(detail === undefined ? {} : { detail }) })

/** @internal */
export const tooLarge = (subject: "text" | "files" | undefined, detail: string): ChatErrorReason =>
  new TooLarge({ ...(subject === undefined ? {} : { subject }), detail })

/** A URL outside the adapter's allowlists. Its host is the only part kept. @internal */
export const untrustedUrl = (): ChatErrorReason => new Forbidden({ detail: "untrusted_url" })
