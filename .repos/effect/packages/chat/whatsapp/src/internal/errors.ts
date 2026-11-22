import {
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
  Unknown
} from "effect/chat/ChatError"
import { isObject } from "effect/Predicate"
import { platform } from "./address.ts"

/** The detail of a send refused outside the 24 hour window, Graph error 131047. @internal */
export const outsideWindow = "graph_131047"

const unauthenticated = new Set([0, 102, 190])

const forbidden = new Set([
  3,
  10,
  368,
  131030,
  131031,
  131042,
  131045,
  131047,
  131049,
  131050,
  133010
])

const rateLimited = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056])

const unavailable = new Set([1, 2, 131000, 131016])

/** An error a Graph answer carries, in an `error` field or in a status's `errors`. @internal */
export interface GraphError {
  readonly code: number
  readonly subcode?: number | undefined
}

/** The Graph error in an answer's body, if it has one. @internal */
export const graphError = (body: unknown): GraphError | undefined => {
  const error = isObject(body) && isObject(body.error) ? body.error : body
  if (!isObject(error) || typeof error.code !== "number") return undefined
  return { code: error.code, ...(typeof error.error_subcode === "number" ? { subcode: error.error_subcode } : {}) }
}

/**
 * Maps a Graph error code to a reason. `detail` is `graph_{code}`, which
 * holds no message text or ids. The Graph error itself is the `cause`.
 *
 * @internal
 */
export const reasonForGraphError = (
  error: GraphError,
  options: { readonly write: boolean; readonly cause?: unknown }
): ChatErrorReason => {
  const fields = { detail: `graph_${error.code}`, ...(options.cause === undefined ? {} : { cause: options.cause }) }
  if (rateLimited.has(error.code)) return new RateLimited(fields)
  if (unauthenticated.has(error.code)) return new Unauthenticated(fields)
  if (forbidden.has(error.code) || (error.code >= 200 && error.code < 300)) return new Forbidden(fields)
  if (unavailable.has(error.code)) {
    return new PlatformUnavailable({ retry: options.write ? "uncertain" : "retry", ...fields })
  }
  if (error.code === 100 && error.subcode === 33) return new NotFound(fields)
  if (error.code === 131053) return new TooLarge({ subject: "files", ...fields })
  return new InvalidRequest(fields)
}

/** @internal */
export const reasonForStatus = (
  status: number,
  options: { readonly write: boolean; readonly cause?: unknown }
): ChatErrorReason => {
  const fields = { detail: `http_${status}`, ...(options.cause === undefined ? {} : { cause: options.cause }) }
  if (status === 429) return new RateLimited(fields)
  if (status >= 500) return new PlatformUnavailable({ retry: options.write ? "uncertain" : "retry", ...fields })
  if (status === 401) return new Unauthenticated(fields)
  if (status === 403) return new Forbidden(fields)
  if (status === 404) return new NotFound(fields)
  if (status === 413) return new TooLarge(fields)
  return new InvalidRequest(fields)
}

/** A request that failed before an answer came. A write may have landed. @internal */
export const transport = (write: boolean, detail: string, cause?: unknown): ChatErrorReason =>
  new Transport({ retry: write ? "uncertain" : "retry", detail, ...(cause === undefined ? {} : { cause }) })

/** An answer the adapter cannot read. A write may have landed. @internal */
export const invalidResponse = (write: boolean, detail: string, cause?: unknown): ChatErrorReason => {
  const fields = { detail, ...(cause === undefined ? {} : { cause }) }
  return write ? new Unknown(fields) : new InvalidResponse(fields)
}

/** @internal */
export const chatError = (op: string, reason: ChatErrorReason): ChatError => new ChatError({ platform, op, reason })
