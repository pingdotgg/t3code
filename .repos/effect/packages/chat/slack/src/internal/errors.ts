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
import { platform } from "./address.ts"

const unauthenticated = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "org_login_required"
])

const forbidden = new Set([
  "access_denied",
  "accesslimited",
  "missing_scope",
  "not_in_channel",
  "is_archived",
  "channel_is_archived",
  "no_permission",
  "not_allowed_token_type",
  "not_authorized",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "cant_update_message",
  "cant_delete_message",
  "cant_delete_file",
  "edit_window_closed",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "team_access_not_granted",
  "posting_to_general_channel_denied",
  "message_not_owned_by_app",
  "messages_tab_disabled",
  "message_limit_exceeded",
  "thread_locked",
  "user_is_restricted",
  "feature_disabled",
  "channel_type_not_supported"
])

const notFoundCodes = new Set([
  "channel_not_found",
  "message_not_found",
  "thread_not_found",
  "user_not_found",
  "users_not_found",
  "file_not_found",
  "file_deleted",
  "bot_not_found",
  "team_not_found"
])

const tooLarge = new Set(["msg_too_long", "msg_blocks_too_long"])

const serverErrors = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout"])

/**
 * Maps the `error` of an `ok: false` answer to a reason. `detail` is always
 * Slack's error code, which holds no message text or ids.
 *
 * @internal
 */
export const reasonForCode = (
  code: string,
  options: { readonly write: boolean; readonly retryAfter?: Duration.Duration | undefined }
): ChatErrorReason => {
  if (code === "ratelimited" || code === "rate_limited") {
    return new RateLimited({
      detail: code,
      ...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter })
    })
  }
  if (unauthenticated.has(code)) return new Unauthenticated({ detail: code })
  if (forbidden.has(code)) return new Forbidden({ detail: code })
  if (notFoundCodes.has(code)) return new NotFound({ detail: code })
  if (tooLarge.has(code)) return new TooLarge({ subject: "text", detail: code })
  if (code === "file_too_large" || code === "too_many_files") return new TooLarge({ subject: "files", detail: code })
  if (serverErrors.has(code)) {
    return new PlatformUnavailable({ retry: options.write ? "uncertain" : "retry", detail: code })
  }
  return new InvalidRequest({ detail: code })
}

/** @internal */
export const reasonForStatus = (
  status: number,
  options: { readonly write: boolean; readonly retryAfter?: Duration.Duration | undefined; readonly cause?: unknown }
): ChatErrorReason => {
  const detail = `http_${status}`
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

/**
 * A `denied` reason from an upload call, or from the attach of a post whose
 * rollback left nothing behind, as a refused file: the same reason with
 * detail `file_refused`, and the reason it replaces, with Slack's code, as
 * its `cause`. Any other reason is returned as it is.
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
