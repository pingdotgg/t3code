import {
  type ChatAdapter,
  type Descriptor,
  type File,
  type Posted,
  retrySafe,
  type ThreadInfo
} from "effect/chat/ChatAdapter"
import {
  type ChatError,
  type ChatErrorReason,
  fileRefused,
  interactionExpired,
  NotFound,
  TooLarge,
  Unknown,
  Unsupported
} from "effect/chat/ChatError"
import type { Defer, Visibility } from "effect/chat/ChatInteraction"
import type { ChatMessage } from "effect/chat/ChatMessage"
import type { ChatThread } from "effect/chat/ChatThread"
import type { Action } from "effect/chat/ChatUi"
import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Str from "effect/String"
import type { SlackUser } from "../SlackChat.ts"
import type { SlackWebApi } from "../SlackWebApi.ts"
import * as Address from "./address.ts"
import * as Errors from "./errors.ts"
import * as Escape from "./escape.ts"
import * as Interactions from "./interactions.ts"
import { isObject, type JsonObject, object, parse, string } from "./json.ts"
import * as Length from "./length.ts"
import * as Normalize from "./normalize.ts"
import { CurrentPostOptions, type SessionStatus } from "./options.ts"
import * as Text from "./text.ts"

type Json = Schema.Json

/** @internal */
export const descriptor: Descriptor = {
  platform: Address.platform,
  capabilities: new Set([
    "edit",
    "delete",
    "fetchMessage",
    "history",
    "download",
    "files",
    "startThread",
    "getThread",
    "opener",
    "getUser",
    "nativeStream",
    "buttons",
    "selects",
    "modals",
    "modalErrors",
    "commands",
    "ephemeral"
  ]),
  measure: Length.measure,
  limits: {
    messageLength: Length.messageLength,
    filesPerMessage: 10,
    uploadBytes: 1024 * 1024 * 1024,
    minWriteInterval: Duration.seconds(1),
    streamLength: Length.messageLength,
    streamAge: Duration.minutes(10),
    followUpAge: Duration.minutes(30),
    ...Interactions.limits
  }
}

const pageSize = 200

/**
 * The hosts a command's `response_url` may point at. A deferral is data that
 * may have crossed a queue, so the adapter posts only to Slack.
 */
const isSlackHost = (host: string): boolean =>
  host === "slack.com" || host.endsWith(".slack.com") || host === "slack-gov.com" || host.endsWith(".slack-gov.com")

/**
 * What a spent `response_url` answers, as plain text with a 404: `used_url`
 * after five posts, `expired_url` after 30 minutes. Recorded in EFF-3802.
 * The same strings in a JSON `error`, and a 410, are from Slack's docs and
 * were never seen; they stay mapped.
 */
const spentResponseUrl = new Set(["expired_url", "used_url"])

/** The `response_type` of a command's answer. */
const responseType = (visibility: Visibility) => visibility === "ephemeral" ? "ephemeral" : "in_channel"

/** The bound on each call of a file post from `chat.postMessage` on: the post, each attach and the rollback. */
const fileCallTimeout = Duration.seconds(30)

/**
 * The bound on the whole attach: every attempt, the waits between them and
 * the pacing after a 429. Past it the post is rolled back, however long a
 * `Retry-After` asked for.
 */
const attachDeadline = Duration.minutes(1)

/** Codes on `chat.startStream` that mean the feature is off for this thread. */
const streamUnsupported = new Set(["channel_type_not_supported", "feature_disabled", "not_allowed_token_type"])

/** Floor between two edits to one message: the spec's starting number, provisional until measured. */
const editIntervalMillis = 3_000

/** How long a reply's backoff is kept after its last write. */
const paceIdleMillis = 15 * 60 * 1000

/** A reply's pace after a 429, shared by every message the reply writes. */
interface Backoff {
  intervalMillis: number
  nextAt: number
  lastWrite: number
}

interface StreamState {
  readonly escape: Escape.State
  /** The Markdown the stream took, held tails left out. */
  readonly markdown: string
  /** What its start and appends sent. */
  readonly sent: string
  readonly stopped: boolean
  /**
   * False while an append is in flight, and after one failed in a way the
   * layer repairs: an append cut off or failed `uncertain` may have landed,
   * and the repair edit rewrites the message itself.
   */
  readonly settled: boolean
  /** Whether the cleanup edit has run or been skipped. */
  readonly cleaned: boolean
  /** Whether the session status at the end has been set, for a stream stopped by the user. */
  readonly ended: boolean
}

/** The state of an open, unstopped stream that has sent `sent` for `markdown`. */
const openStream = (escape: Escape.State, markdown: string, sent: string): StreamState => ({
  escape,
  markdown,
  sent,
  stopped: false,
  settled: true,
  cleaned: false,
  ended: false
})

const hasDetail = (code: string) => (error: ChatError): boolean => error.reason.detail === code

const userName = (user: JsonObject): string => {
  const profile = object(user, "profile")
  return string(profile, "display_name") ?? string(profile, "real_name") ?? string(user, "real_name") ??
    string(user, "name") ?? string(user, "id") ?? ""
}

/** @internal */
export const make = (options: {
  readonly api: SlackWebApi["Service"]
  readonly http: HttpClient.HttpClient
  readonly botToken: Redacted.Redacted
  readonly teamId: string
  readonly botUserId: Effect.Effect<string, ChatError>
  /** Builds the `SlackAttachFailed` cause, which lives in the public module. */
  readonly attachFailed: (fields: {
    readonly thread: ChatThread
    readonly messageId: string
    readonly fileIds: ReadonlyArray<string>
    readonly reason: ChatErrorReason
  }) => unknown
}) => {
  const { api, teamId } = options
  const streams = new Map<string, StreamState>()
  let declaredAgent = true

  const fail = (op: string, reason: ChatErrorReason) => Effect.fail(Errors.chatError(op, reason))

  /** Refuses elements Slack would refuse, or that the adapter could not tell from a consumer's. */
  const checkActions = (op: string, actions: ReadonlyArray<Action>) => {
    const refusal = Interactions.checkActions(actions)
    return refusal === undefined ? Effect.void : fail(op, refusal)
  }

  /**
   * The pace of the writes that grow one reply: stream appends, the starts
   * of its later parts, and edits.
   *
   * - Edits to one message are at least `editIntervalMillis` apart.
   * - After a 429, the next write waits for the retry-after, and each later
   *   write waits twice the interval it waited before, for the rest of the
   *   reply. The backoff is keyed by message and shared: a stream started
   *   with `continues` takes the backoff of the message it continues, and a
   *   stop with `end: "done"` drops it.
   * - Each attempt reads the pace afresh, so a write retried after a 429
   *   waits for it.
   */
  const backoffs = new Map<string, Backoff>()
  const nextEdit = new Map<string, number>()

  const evict = (now: number) => {
    if (nextEdit.size >= 64) { for (const [key, at] of nextEdit) if (at <= now) nextEdit.delete(key) }
    if (backoffs.size >= 64) {
      for (const [key, backoff] of backoffs) if (backoff.lastWrite < now - paceIdleMillis) backoffs.delete(key)
    }
  }

  const paced = <A>(
    messageId: string,
    write: Effect.Effect<A, ChatError>,
    kind: "edit" | "stream"
  ): Effect.Effect<A, ChatError> =>
    Effect.gen(function*() {
      const at = Math.max(backoffs.get(messageId)?.nextAt ?? 0, kind === "edit" ? nextEdit.get(messageId) ?? 0 : 0)
      const wait = at - (yield* Clock.currentTimeMillis)
      if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
      return yield* write.pipe(
        Effect.tap(() =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            evict(now)
            const backoff = backoffs.get(messageId)
            if (backoff !== undefined) {
              backoff.nextAt = now + backoff.intervalMillis
              backoff.lastWrite = now
            }
            if (kind === "edit") nextEdit.set(messageId, now + editIntervalMillis)
          })
        ),
        Effect.tapError((error) =>
          error.reason._tag !== "RateLimited" ? Effect.void : Effect.map(Clock.currentTimeMillis, (now) => {
            evict(now)
            const base = kind === "edit" ? editIntervalMillis : Duration.toMillis(descriptor.limits.minWriteInterval)
            const backoff = backoffs.get(messageId) ?? { intervalMillis: base, nextAt: now, lastWrite: now }
            backoff.intervalMillis *= 2
            const retryAfter = error.retryAfter
            backoff.nextAt = now + (retryAfter === undefined ? backoff.intervalMillis : Duration.toMillis(retryAfter))
            backoff.lastWrite = now
            backoffs.set(messageId, backoff)
          })
        )
      )
    })

  const call = (
    op: string,
    method: string,
    body: Readonly<Record<string, unknown>>,
    callOptions?: { readonly write?: boolean | undefined; readonly retry?: boolean | undefined }
  ) => api.call(method, body, callOptions).pipe(Effect.mapError(Errors.withOp(op)))

  const resolve = (op: string, thread: ChatThread): Effect.Effect<Address.Parts, ChatError> => {
    const parts = Address.parts(thread)
    return Option.isSome(parts) && parts.value.team === teamId
      ? Effect.succeed(parts.value)
      : fail(op, Errors.invalidRequest("invalid_thread"))
  }

  const tsOf = (op: string, write: boolean) => (answer: Json): Effect.Effect<string, ChatError> => {
    const ts = string(answer, "ts")
    return ts === undefined ? fail(op, Errors.invalidResponse(write, "missing_ts")) : Effect.succeed(ts)
  }

  /**
   * Refuses text past 12,000 code points as sent, which Slack would refuse
   * with `msg_too_long`. Slack's second count, with emoji as shortcodes, is
   * left to Slack: `measure` only bounds it from above, because entities,
   * code and Markdown markers render shorter than they are sent. Its refusal
   * maps to `TooLarge` and leaves nothing behind.
   */
  const checkSent = (op: string, sent: string): Effect.Effect<void, ChatError> =>
    Length.codePoints(sent) > Length.messageLength
      ? fail(op, new TooLarge({ subject: "text", detail: "msg_too_long" }))
      : Effect.void

  /**
   * The body of a post or an update: the Markdown as one `markdown` block,
   * and a `text` the adapter builds, cut to the call's budget. Slack decides
   * mentions from `text`, and builds one with every token intact when none
   * is sent, so `markdown_text` is never used on these two calls.
   */
  const messageContent = Effect.fnUntraced(
    function*(op: string, body: Text.Body) {
      yield* checkSent(op, body.sent)
      if (body.text === "" && !Text.hasActions(body)) return yield* fail(op, Errors.invalidRequest("no_text"))
      if (body.dropped > 0) yield* Effect.annotateCurrentSpan("slack.text.dropped_tokens", body.dropped)
      return { blocks: body.blocks, text: body.text }
    }
  )

  const messages = (answer: Json): ReadonlyArray<Json> =>
    isObject(answer) && Array.isArray(answer.messages) ? answer.messages : []

  const nextCursor = (answer: Json): Option.Option<string> =>
    Option.fromUndefinedOr(string(object(answer, "response_metadata"), "next_cursor"))

  /** One message by ts, in or out of a thread, as Slack stores it. */
  const fetchRaw = (op: string, channel: string, ts: string): Effect.Effect<Json, ChatError> =>
    call(op, "conversations.replies", { channel, ts, latest: ts, oldest: ts, inclusive: true, limit: 2 }).pipe(
      Effect.flatMap((answer) => {
        const found = messages(answer).find((message) => isObject(message) && message.ts === ts)
        return found === undefined ? fail(op, Errors.notFound("message_not_found")) : Effect.succeed(found)
      })
    )

  const fetchMessage = Effect.fnUntraced(function*(op: string, thread: ChatThread, messageId: string) {
    const parts = yield* resolve(op, thread)
    const botUserId = yield* options.botUserId
    const raw = yield* fetchRaw(op, parts.channel, messageId)
    const message = Normalize.message(raw, { team: teamId, channel: parts.channel, botUserId })
    return message === undefined ? yield* fail(op, Errors.notFound("not_a_message")) : message
  })

  const sessionStatus = (channel: string, threadTs: string, status: SessionStatus): Effect.Effect<void> =>
    declaredAgent
      ? call("nativeStream.stop", "agents.sessions.setStatus", { channel_id: channel, thread_ts: threadTs, status }, {
        write: true,
        retry: false
      }).pipe(
        Effect.asVoid,
        Effect.catch((error) => {
          if (hasDetail("not_authorized")(error)) declaredAgent = false
          return Effect.logDebug("agents.sessions.setStatus failed", error)
        })
      )
      : Effect.void

  // Files

  /** A `denied` failure of an upload call refused a file. */
  const refused = (error: ChatError): ChatError =>
    error.reason.retry === "denied" ? Errors.chatError(error.op, Errors.fileRefused(error.reason)) : error

  const stage = (file: File): Effect.Effect<{ readonly id: string; readonly title: string }, ChatError> =>
    Effect.gen(function*() {
      const answer = yield* call("post", "files.getUploadURLExternal", {
        filename: file.name,
        length: file.content.length
      })
      const uploadUrl = string(answer, "upload_url")
      const fileId = string(answer, "file_id")
      if (uploadUrl === undefined || fileId === undefined) {
        return yield* fail("post", Errors.invalidResponse(false, "missing_upload_url"))
      }
      // Staging posts nothing, so every failure here is safe to retry.
      const response = yield* options.http.execute(
        HttpClientRequest.post(uploadUrl).pipe(HttpClientRequest.bodyUint8Array(file.content, file.contentType))
      ).pipe(Effect.mapError((error) => Errors.chatError("post", Errors.transport(false, "upload_failed", error))))
      if (response.status < 200 || response.status >= 300) {
        return yield* fail("post", Errors.reasonForStatus(response.status, { write: false }))
      }
      return { id: fileId, title: file.name }
    }).pipe(Effect.mapError(refused))

  /** One call of the post, the attach or the rollback, cut off after `fileCallTimeout`. */
  const bounded = <A>(effect: Effect.Effect<A, ChatError>, onTimeout: ChatErrorReason): Effect.Effect<A, ChatError> =>
    Effect.timeoutOrElse(effect, { duration: fileCallTimeout, orElse: () => fail("post", onTimeout) })

  /**
   * Upload, post, then attach. The files are completed with no channel, so
   * nothing is visible until `chat.postMessage`, and `chat.update` with
   * `file_ids` attaches them. Both calls send the same body, with `text` under
   * the update budget, so `text` never changes between them.
   *
   * From the post on, the route runs uninterruptible, with a timeout on each
   * call and `attachDeadline` on the attach as a whole, retries and waits
   * included. The attach replaces the file list, so it is retried. When it
   * still fails, the message is deleted and then the files, best effort. If
   * the delete fails or times out, the message may be left, with or without
   * its files, and the post fails `uncertain` with a `SlackAttachFailed` as
   * its cause. The files are kept so the ids it carries still mean something.
   */
  const postFiles = Effect.fnUntraced(function*(
    thread: ChatThread,
    parts: Address.Parts,
    markdown: string,
    files: ReadonlyArray<File>,
    actions: ReadonlyArray<Action>,
    notify: Escape.Notify,
    unfurl: boolean
  ) {
    if (
      files.length > descriptor.limits.filesPerMessage ||
      files.some((file) => file.content.length > descriptor.limits.uploadBytes)
    ) {
      return yield* fail("post", new TooLarge({ subject: "files", detail: fileRefused }))
    }
    const content = Text.body(markdown, notify, Text.updateBudget)
    const body = yield* messageContent(
      "post",
      Text.withActions(
        content.text === "" ? Text.placeholder(files.map((file) => file.name), Text.updateBudget) : content,
        actions
      )
    )
    const staged = yield* Effect.forEach(files, stage)
    yield* call("post", "files.completeUploadExternal", { files: staged }).pipe(Effect.mapError(refused))
    const fileIds = staged.map((file) => file.id)
    const channel = parts.channel

    return yield* Effect.uninterruptible(Effect.gen(function*() {
      const removeFiles = bounded(
        Effect.forEach(fileIds, (file) => call("post", "files.delete", { file }, { write: true }).pipe(Effect.ignore), {
          concurrency: "unbounded",
          discard: true
        }),
        Errors.transport(true, "timeout")
      ).pipe(Effect.ignore)
      const ts = yield* bounded(
        call("post", "chat.postMessage", {
          channel,
          thread_ts: parts.threadTs,
          ...body,
          unfurl_links: unfurl,
          unfurl_media: unfurl
        }, { write: true }).pipe(Effect.flatMap(tsOf("post", true))),
        Errors.transport(true, "timeout")
      ).pipe(Effect.tapError(() => removeFiles))
      const posted: Posted = { id: ts, thread, timestamp: Normalize.timestamp(ts) }

      const attached = yield* retrySafe(paced(
        ts,
        bounded(
          call("post", "chat.update", { channel, ts, ...body, file_ids: fileIds }, { write: false, retry: false }),
          Errors.transport(false, "timeout")
        ),
        "edit"
      )).pipe(
        Effect.timeoutOrElse({
          duration: attachDeadline,
          orElse: () => fail("post", Errors.transport(false, "attach_deadline"))
        }),
        Effect.result
      )
      if (Result.isSuccess(attached)) return posted

      const error = attached.failure
      yield* Effect.annotateCurrentSpan("slack.attach.failed", error.reason._tag)
      const deleted = yield* bounded(
        call("post", "chat.delete", { channel, ts }, { write: true }),
        Errors.transport(true, "timeout")
      ).pipe(Effect.result)
      if (Result.isSuccess(deleted)) {
        yield* removeFiles
        return yield* Effect.fail(refused(error))
      }
      return yield* fail(
        "post",
        new Unknown({
          detail: "attach_failed_message_left",
          cause: options.attachFailed({ thread, messageId: ts, fileIds, reason: error.reason })
        })
      )
    }))
  })

  // History

  const page = (op: string, method: string, body: Record<string, unknown>) => (cursor: string | undefined) =>
    call(op, method, { ...body, cursor }).pipe(
      Effect.map((answer) => [messages(answer), nextCursor(answer)] as const)
    )

  const history: ChatAdapter["history"] = (thread, { direction, from }) =>
    Stream.unwrap(Effect.gen(function*() {
      const parts = yield* resolve("history", thread)
      const botUserId = yield* options.botUserId
      const context = { team: teamId, channel: parts.channel, botUserId }
      const after = (message: ChatMessage) =>
        from === undefined ||
        (direction === "forward"
          ? Address.compareTs(message.id, from) > 0
          : Address.compareTs(message.id, from) < 0)
      const normalized = (raw: Stream.Stream<Json, ChatError>) =>
        raw.pipe(
          Stream.map((message) => Normalize.message(message, context)),
          Stream.filter((message): message is ChatMessage => message !== undefined && after(message))
        )
      const reversed = (stream: Stream.Stream<ChatMessage, ChatError>) =>
        Stream.unwrap(Effect.map(Stream.runCollect(stream), (all) => Stream.fromIterable(Array.from(all).reverse())))
      const bound = from === undefined ? {} : direction === "forward" ? { oldest: from } : { latest: from }
      if (parts.threadTs !== undefined) {
        // Oldest first, from the thread's start. Slack puts the opener on every page.
        const threadTs = parts.threadTs
        const replies = page("history", "conversations.replies", {
          channel: parts.channel,
          ts: threadTs,
          limit: pageSize,
          ...bound
        })
        const stream = normalized(
          Stream.paginate(undefined as string | undefined, (cursor) =>
            Effect.map(replies(cursor), ([found, next]) =>
              [
                cursor === undefined
                  ? found
                  : found.filter((message) => !(isObject(message) && message.ts === threadTs)),
                next
              ] as const))
        )
        return direction === "forward" ? stream : reversed(stream)
      }
      // Newest first. A reply broadcast to the channel is the thread's.
      const stream = normalized(
        Stream.paginate(
          undefined as string | undefined,
          page("history", "conversations.history", { channel: parts.channel, limit: pageSize, ...bound })
        )
      ).pipe(Stream.filter((message) => message.thread.id === thread.id))
      return direction === "backward" ? stream : reversed(stream)
    }))

  // Native stream

  /**
   * The cleanup edit: once a stream is closed, a message whose appends
   * differ from what the block path would send is rewritten once as blocks
   * plus `text`, which takes out the zero-width spaces. It carries no
   * `actions`, since the stop never does.
   *
   * It is skipped when the block would pass 12,000 and when the edit fails,
   * leaving the characters, failing nothing and saying so on the span. A
   * message whose last append is unsettled is left to the layer's repair,
   * which rewrites it, so it gets no second edit. An allowed token in the
   * message does not skip it: an edit that keeps a real mention sends no
   * second push (EFF-3740).
   *
   * An interrupted cleanup leaves the message marked not cleaned, so the
   * stop the layer's finaliser sends again runs it again.
   */
  const cleanupEdit = Effect.fnUntraced(function*(
    op: string,
    channel: string,
    messageId: string,
    state: StreamState,
    notify: Escape.Notify
  ) {
    const block = Escape.escape(state.markdown, notify, { flush: true }).sent
    if (block === state.sent) return
    const skip = (reason: string) => Effect.annotateCurrentSpan("slack.stream.cleanup", reason)
    if (!state.settled) return yield* skip("unsettled")
    const body = Text.body(state.markdown, notify, Text.updateBudget)
    if (Length.codePoints(body.sent) > Length.messageLength) return yield* skip("too_long")
    if (body.dropped > 0) yield* Effect.annotateCurrentSpan("slack.text.dropped_tokens", body.dropped)
    const edited = yield* paced(
      messageId,
      call(op, "chat.update", { channel, ts: messageId, blocks: body.blocks, text: body.text }, {
        write: true,
        retry: false
      }),
      "edit"
    ).pipe(Effect.result)
    yield* Effect.annotateCurrentSpan("slack.stream.cleanup", Result.isSuccess(edited) ? "edited" : "failed")
  })

  /**
   * Moves the agent session of a stopped stream off `processing`, once. It is
   * marked only after the call, so an interrupted one runs again on the stop
   * the layer's finaliser sends.
   */
  const endSession = (
    channel: string,
    threadTs: string | undefined,
    messageId: string,
    status: SessionStatus
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (threadTs === undefined || streams.get(messageId)?.ended === true) return Effect.void
      return Effect.andThen(
        sessionStatus(channel, threadTs, status),
        Effect.sync(() => {
          const state = streams.get(messageId)
          if (state !== undefined) streams.set(messageId, { ...state, ended: true })
        })
      )
    })

  const cleanup = (op: string, channel: string, messageId: string, notify: Escape.Notify): Effect.Effect<void> =>
    Effect.suspend(() => {
      const state = streams.get(messageId)
      if (state === undefined || state.cleaned) return Effect.void
      return Effect.andThen(
        cleanupEdit(op, channel, messageId, state, notify),
        Effect.sync(() => void streams.set(messageId, { ...state, cleaned: true }))
      )
    })

  const nativeStream: NonNullable<ChatAdapter["nativeStream"]> = {
    start: Effect.fnUntraced(function*(thread, start) {
      const op = "nativeStream.start"
      const postOptions = yield* CurrentPostOptions
      if (postOptions.nativeStream === false) {
        return yield* fail(op, new Unsupported({ capability: "nativeStream", detail: "disabled" }))
      }
      const parts = yield* resolve(op, thread)
      if (parts.threadTs === undefined || start.recipient === undefined || start.replyTo !== undefined) {
        return yield* fail(op, new Unsupported({ capability: "nativeStream" }))
      }
      const escaped = Escape.escapeStream(start.markdown, postOptions.notify ?? {}, { flush: true })
      // Slack blanks a message whose surrogate pair is split across two appends.
      const sent = Str.toWellFormed(escaped.sent)
      yield* checkSent(op, sent)
      const startCall = call(op, "chat.startStream", {
        channel: parts.channel,
        thread_ts: parts.threadTs,
        recipient_user_id: start.recipient,
        recipient_team_id: postOptions.recipientTeamId ?? parts.team,
        markdown_text: sent === "" ? undefined : sent
      }, { write: true, retry: false }).pipe(
        Effect.catchIf(
          (error) => error.reason.detail !== undefined && streamUnsupported.has(error.reason.detail),
          (error) =>
            fail(
              op,
              new Unsupported({
                capability: "nativeStream",
                ...(error.reason.detail === undefined ? {} : { detail: error.reason.detail }),
                cause: error
              })
            )
        )
      )
      // A later part of a reply goes at the reply's pace, and keeps it.
      const continues = start.continues
      const answer = yield* (continues === undefined ? startCall : paced(continues, startCall, "stream"))
      const ts = yield* tsOf(op, true)(answer)
      const backoff = continues === undefined ? undefined : backoffs.get(continues)
      if (backoff !== undefined) backoffs.set(ts, backoff)
      streams.set(ts, openStream(escaped.state, start.markdown, sent))
      return { id: ts, thread, timestamp: Normalize.timestamp(ts) }
    }),
    append: Effect.fnUntraced(function*(thread, messageId, markdown, appendOptions) {
      const op = "nativeStream.append"
      const parts = yield* resolve(op, thread)
      const postOptions = yield* CurrentPostOptions
      const state = streams.get(messageId) ?? openStream(Escape.initialState, "", "")
      const flush = appendOptions?.flush === true
      // A trailing high surrogate waits for its other half.
      const input = !flush && /[\ud800-\udbff]$/.test(markdown) ? markdown.slice(0, -1) : markdown
      const escaped = Escape.escapeStream(input, postOptions.notify ?? {}, { state: state.escape, flush })
      const held = markdown.length - escaped.consumed
      if (escaped.sent === "") return { state: "open" as const, held }
      const sent = Str.toWellFormed(escaped.sent)
      yield* checkSent(op, state.sent + sent)
      const unsettle = Effect.sync(() => streams.set(messageId, { ...state, settled: false }))
      return yield* paced(
        messageId,
        Effect.andThen(
          unsettle,
          call(op, "chat.appendStream", { channel: parts.channel, ts: messageId, markdown_text: sent }, {
            write: true,
            retry: false
          })
        ),
        "stream"
      ).pipe(
        Effect.map(() => {
          streams.set(
            messageId,
            openStream(escaped.state, state.markdown + input.slice(0, escaped.consumed), state.sent + sent)
          )
          return { state: "open" as const, held }
        }),
        Effect.catchIf(
          hasDetail("message_not_in_streaming_state"),
          () =>
            Effect.sync(() => {
              // The layer carries on by editing the message, and sends no stop.
              streams.delete(messageId)
              return { state: "closed" as const, held: 0 }
            })
        ),
        // Slack closed the stream and the reply ends stopped. The layer sends no stop after this, so the
        // cleanup and the session status go here.
        Effect.catchIf(
          hasDetail("stopped_by_user"),
          () =>
            Effect.sync(() => streams.set(messageId, { ...state, stopped: true })).pipe(
              Effect.andThen(cleanup(op, parts.channel, messageId, postOptions.notify ?? {})),
              Effect.andThen(
                endSession(parts.channel, parts.threadTs, messageId, postOptions.sessionStatusAtEnd ?? "active")
              ),
              Effect.as({ state: "stopped" as const, held: 0 })
            )
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (error.retry === "denied") streams.set(messageId, state)
          })
        )
      )
    }),
    stop: Effect.fnUntraced(function*(thread, messageId, stopOptions) {
      const op = "nativeStream.stop"
      const parts = yield* resolve(op, thread)
      const postOptions = yield* CurrentPostOptions
      const state = streams.get(messageId)
      // A rotating stop keeps the reply's backoff for its next part.
      const backoff = backoffs.get(messageId)
      if (backoff !== undefined && stopOptions.end === "done") {
        for (const [key, value] of backoffs) if (value === backoff) backoffs.delete(key)
      }
      const status = stopOptions.end === "rotating" ? "processing" : postOptions.sessionStatusAtEnd
      const body = { channel: parts.channel, ts: messageId }
      const stop = status === undefined || !declaredAgent
        ? call(op, "chat.stopStream", body, { write: true, retry: false })
        : call(op, "chat.stopStream", { ...body, session_status: status }, { write: true, retry: false }).pipe(
          Effect.catchIf(hasDetail("not_authorized"), () => {
            declaredAgent = false
            return call(op, "chat.stopStream", body, { write: true, retry: false })
          })
        )
      const answer = yield* stop.pipe(
        Effect.catchIf(hasDetail("message_not_in_streaming_state"), () => Effect.succeed(undefined))
      )
      const stopped = state?.stopped === true || string(answer, "result_status") === "stopped_by_user" ||
        string(object(object(answer, "message"), "ai_context"), "result_status") === "stopped_by_user"
      // Remember stopped_by_user across interruptions, even if a retry finds no open stream.
      const current = streams.get(messageId)
      if (stopped && current !== undefined) streams.set(messageId, { ...current, stopped: true })
      yield* cleanup(op, parts.channel, messageId, postOptions.notify ?? {})
      if (stopped && stopOptions.end === "done") {
        yield* endSession(parts.channel, parts.threadTs, messageId, postOptions.sessionStatusAtEnd ?? "active")
      }
      // Retain stream state until cleanup and session completion finish.
      streams.delete(messageId)
      return { stopped }
    })
  }

  // Users

  const user = (id: string): Effect.Effect<SlackUser, ChatError> =>
    call("user", "users.info", { user: id }).pipe(
      Effect.flatMap((answer) => {
        const raw = object(answer, "user")
        const userId = string(raw, "id")
        if (raw === undefined || userId === undefined) {
          return fail("user", Errors.invalidResponse(false, "missing_user"))
        }
        const userTeam = string(raw, "team_id") ?? teamId
        return Effect.succeed<SlackUser>({
          id: userId,
          teamId: userTeam,
          name: userName(raw),
          isBot: raw.is_bot === true,
          isRestricted: raw.is_restricted === true,
          isUltraRestricted: raw.is_ultra_restricted === true,
          isStranger: raw.is_stranger === true || (userTeam !== teamId && raw.enterprise_user === undefined),
          deleted: raw.deleted === true,
          raw
        })
      })
    )

  /** A `bot_message` author is a bot id, which `users.info` answers with `NotFound`. */
  const getUser: ChatAdapter["getUser"] = Effect.fnUntraced(function*(id) {
    const botUserId = yield* options.botUserId
    const found = yield* user(id).pipe(Effect.mapError(Errors.withOp("getUser")))
    return { id: found.id, name: found.name, isBot: found.isBot, isSelf: found.id === botUserId, raw: found.raw }
  })

  /**
   * The body of a command's answer, `Respond` or `followUp`: what a `post`
   * of the same content sends with the default post options, after the same
   * checks, with its `response_type`. `withPostOptions` does not reach it,
   * so it notifies nobody and unfurls nothing.
   */
  const answer = Effect.fnUntraced(function*(
    op: string,
    content: { readonly markdown: string; readonly actions?: ReadonlyArray<Action> | undefined },
    visibility: Visibility
  ) {
    const actions = content.actions ?? []
    yield* checkActions(op, actions)
    const body = yield* messageContent(op, Text.body(content.markdown, {}, Text.postBudget, actions))
    return { response_type: responseType(visibility), ...body, unfurl_links: false, unfurl_media: false }
  })

  const responseUrl = (op: string, deferred: Defer): Effect.Effect<URL, ChatError> => {
    const raw = deferred.command.raw
    const value = string(raw, "response_url")
    const url = value === undefined || !URL.canParse(value) ? undefined : new URL(value)
    return url !== undefined && url.protocol === "https:" && isSlackHost(url.hostname)
      ? Effect.succeed(url)
      : fail(op, Errors.invalidRequest("invalid_response_url"))
  }

  /**
   * One POST to the command's `response_url`, never retried. A spent URL is
   * `NotFound` with detail `interaction_expired`.
   */
  const followUp: ChatAdapter["followUp"] = Effect.fnUntraced(function*(deferred, content) {
    const op = "followUp"
    const url = yield* responseUrl(op, deferred)
    const body = yield* answer(op, content, deferred.visibility)
    const response = yield* options.http.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))
    ).pipe(Effect.mapError((error) => Errors.chatError(op, Errors.transport(true, error.reason._tag, error))))
    if (response.status >= 200 && response.status < 300) return
    const text = yield* Effect.orElseSucceed(response.text, () => "")
    const parsed = parse(text)
    const code = parsed === undefined
      ? text.trim() === "" ? undefined : text.trim()
      : string(parsed, "error")
    if (response.status === 404 || response.status === 410 || (code !== undefined && spentResponseUrl.has(code))) {
      return yield* fail(
        op,
        new NotFound({ detail: interactionExpired, ...(code === undefined ? {} : { cause: code }) })
      )
    }
    return yield* fail(op, Errors.reasonForStatus(response.status, { write: true, cause: code }))
  })

  const adapter: ChatAdapter = {
    descriptor,
    nativeStream,
    followUp,
    post: Effect.fnUntraced(function*(thread, content) {
      const parts = yield* resolve("post", thread)
      if (content.replyTo !== undefined) return yield* fail("post", new Unsupported({ capability: "replyTo" }))
      const actions = content.actions ?? []
      yield* checkActions("post", actions)
      const postOptions = yield* CurrentPostOptions
      const notify = postOptions.notify ?? {}
      const unfurl = postOptions.unfurl === true
      if (content.files !== undefined && content.files.length > 0) {
        return yield* postFiles(thread, parts, content.markdown, content.files, actions, notify, unfurl)
      }
      const body = yield* messageContent("post", Text.body(content.markdown, notify, Text.postBudget, actions))
      const ts = yield* call("post", "chat.postMessage", {
        channel: parts.channel,
        thread_ts: parts.threadTs,
        ...body,
        unfurl_links: unfurl,
        unfurl_media: unfurl
      }, { write: true }).pipe(Effect.flatMap(tsOf("post", true)))
      return { id: ts, thread, timestamp: Normalize.timestamp(ts) }
    }),
    edit: Effect.fnUntraced(function*(thread, messageId, content) {
      const parts = yield* resolve("edit", thread)
      const actions = content.actions ?? []
      yield* checkActions("edit", actions)
      const postOptions = yield* CurrentPostOptions
      const body = yield* messageContent(
        "edit",
        Text.body(content.markdown, postOptions.notify ?? {}, Text.updateBudget, actions)
      )
      yield* retrySafe(paced(
        messageId,
        call("edit", "chat.update", { channel: parts.channel, ts: messageId, ...body }, {
          write: true,
          retry: false
        }),
        "edit"
      ))
    }),
    delete: Effect.fnUntraced(function*(thread, messageId) {
      const parts = yield* resolve("delete", thread)
      const body = { channel: parts.channel, ts: messageId }
      yield* call("delete", "chat.delete", body, { write: true }).pipe(
        // Slack refuses to delete an open stream: stop it, then delete.
        Effect.catchIf(
          hasDetail("cant_delete_message"),
          (error) =>
            call("delete", "chat.stopStream", body, { write: true, retry: false }).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.fail(error),
                onSuccess: () => {
                  streams.delete(messageId)
                  return call("delete", "chat.delete", body, { write: true })
                }
              })
            )
        )
      )
    }),
    fetchMessage: (thread, messageId) => fetchMessage("fetchMessage", thread, messageId),
    history,
    download: (thread, attachment, { maxBytes }) =>
      Stream.unwrap(Effect.gen(function*() {
        const op = "download"
        yield* resolve(op, thread)
        const tooLarge = Errors.chatError(op, new TooLarge({ subject: "files", detail: "max_bytes" }))
        if (attachment.size !== undefined && attachment.size > maxBytes) return yield* Effect.fail(tooLarge)
        const answer = yield* call(op, "files.info", { file: attachment.id })
        const file = object(answer, "file")
        const url = string(file, "url_private_download") ?? string(file, "url_private")
        if (url === undefined) return yield* fail(op, Errors.invalidResponse(false, "missing_url"))
        const response = yield* options.http.execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(options.botToken)))
        ).pipe(Effect.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag, error))))
        if (response.status < 200 || response.status >= 300) {
          return yield* fail(op, Errors.reasonForStatus(response.status, { write: false }))
        }
        let received = 0
        return response.stream.pipe(
          Stream.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag, error))),
          Stream.mapEffect((chunk) => {
            received += chunk.length
            return received > maxBytes ? Effect.fail(tooLarge) : Effect.succeed(chunk)
          })
        )
      })),
    startThread: (thread, messageId) =>
      resolve("startThread", thread).pipe(
        Effect.map((parts) =>
          parts.threadTs === undefined
            ? Address.thread({ team: parts.team, channel: parts.channel, threadTs: messageId })
            : thread
        )
      ),
    getThread: Effect.fnUntraced(function*(thread) {
      const parts = yield* resolve("getThread", thread)
      const answer = yield* call("getThread", "conversations.info", { channel: parts.channel })
      const channel = object(answer, "channel")
      if (channel === undefined) return yield* fail("getThread", Errors.invalidResponse(false, "missing_channel"))
      const direct = channel.is_im === true || channel.is_mpim === true
      const topicValue = string(object(channel, "topic"), "value")
      const name = direct ? undefined : string(channel, "name")
      const created = channel.created
      const createdAt = parts.threadTs !== undefined
        ? Normalize.timestamp(parts.threadTs)
        : typeof created === "number" && Number.isFinite(created)
        ? DateTime.makeUnsafe(created * 1000)
        : undefined
      return {
        thread,
        kind: parts.threadTs !== undefined ? "thread" : direct ? "direct" : "channel",
        ...(parts.threadTs === undefined && name !== undefined ? { name } : {}),
        ...(parts.threadTs === undefined && topicValue !== undefined ? { topic: topicValue } : {}),
        ...(parts.threadTs === undefined
          ? {}
          : { parent: Address.thread({ team: parts.team, channel: parts.channel }) }),
        ...(createdAt === undefined ? {} : { createdAt }),
        raw: channel
      } satisfies ThreadInfo
    }),
    opener: Effect.fnUntraced(function*(thread) {
      const parts = yield* resolve("opener", thread)
      if (parts.threadTs === undefined) return Option.none()
      const channelAddress = Address.thread({ team: parts.team, channel: parts.channel })
      return yield* fetchMessage("opener", channelAddress, parts.threadTs).pipe(
        Effect.map(Option.some),
        Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed(Option.none()))
      )
    }),
    getUser
  }

  return { adapter, user, answer }
}
