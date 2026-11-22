/**
 * Posting long and streamed Markdown through `Chat`.
 *
 * `post` splits Markdown that outgrows one message into parts at block
 * boundaries. `stream` writes a stream of Markdown deltas as it arrives, by
 * the adapter's native stream when it has one, otherwise by posting and then
 * editing, and on an adapter without `edit` by posting each part once. Both
 * sit above the adapter ops and use one splitter.
 *
 * **Example** (Streaming a reply)
 *
 * ```ts
 * import { Effect, Stream } from "effect"
 * import { ChatMarkdown, ChatThread } from "effect/chat"
 *
 * const reply = (deltas: Stream.Stream<string>) =>
 *   Effect.gen(function*() {
 *     const result = yield* ChatMarkdown.stream(ChatThread.make("slack", "T1/C1"), deltas)
 *     return result.parts.map((part) => part.messageId)
 *   })
 * ```
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Cause from "../Cause.ts"
import * as Clock from "../Clock.ts"
import * as Data from "../Data.ts"
import type * as DateTime from "../DateTime.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Exit from "../Exit.ts"
import * as Fiber from "../Fiber.ts"
import * as Latch from "../Latch.ts"
import * as Option from "../Option.ts"
import * as Scope from "../Scope.ts"
import * as Stream from "../Stream.ts"
import * as Chat from "./Chat.ts"
import type { Descriptor, File, NativeStream, Posted } from "./ChatAdapter.ts"
import { Registry } from "./ChatAdapter.ts"
import { ChatError, fileRefused, TooLarge } from "./ChatError.ts"
import type { ReplyTo } from "./ChatMessage.ts"
import type { ChatThread } from "./ChatThread.ts"
import type { Action } from "./ChatUi.ts"

/**
 * One message a call created.
 *
 * **Details**
 *
 * - `markdown` is the Markdown as it went out, with a reopened or closed code
 *   fence and a consumer's unattached note included. It is empty for the
 *   overflow file.
 * - `text` is the slice of the input the part carries, without anything the
 *   layer added. The `text` of every part, in order, is the input.
 * - `transport` is `post` for a part from `post` and for a streamed part
 *   posted once to an adapter without `edit`, `edit` for a streamed part
 *   written by post-then-edit and `native` for one written by the adapter's
 *   native stream, even if it was finished by an edit.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Part {
  readonly messageId: string
  readonly timestamp: DateTime.Utc
  readonly markdown: string
  readonly text: string
  readonly kind: "text" | "overflowFile"
  readonly transport: "post" | "edit" | "native"
}

/**
 * What a call posted.
 *
 * **Details**
 *
 * - `parts` is empty when the input was empty: nothing is posted.
 * - `stopped` means a user clicked stop on this reply (Slack's stop button).
 *   It can be true with the whole text delivered, when the consumer ignored
 *   the click. It is always false from `post`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Result {
  readonly parts: ReadonlyArray<Part>
  readonly stopped: boolean
}

/**
 * Error for a call that did not deliver its whole input.
 *
 * **Details**
 *
 * - `posted` is text the platform confirmed, `uncertain` is text sent in a
 *   write that failed `uncertain` and was never confirmed since, and
 *   `remaining` was never sent. The `text` of `posted`, then `uncertain`,
 *   then `remaining` is the input, with nothing in two of them.
 * - `remainingFence` is set when `remaining` starts inside a code fence:
 *   the line that opened it, with its info string. Text sent later starts
 *   with that line and a newline, then `remaining`.
 * - `cause` is a `ChatError` from a write, the upstream's error `E`, or
 *   `Overflow` when the input outgrew `maxParts` and the overflow file.
 *
 * **Gotchas**
 *
 * It is not a `Schema.TaggedError`: it is generic in `E` and carries
 * message text. `message` and `toJSON` leave the text out.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class ChatMarkdownError<E = never> extends Data.TaggedError("ChatMarkdownError")<{
  readonly posted: ReadonlyArray<Part>
  readonly remaining: string
  readonly remainingFence?: string | undefined
  readonly uncertain?: string | undefined
  readonly cause:
    | { readonly _tag: "Chat"; readonly error: ChatError }
    | { readonly _tag: "Upstream"; readonly error: E }
    | { readonly _tag: "Overflow" }
}> {
  override get message(): string {
    const cause = this.cause._tag === "Chat" ? "Chat(" + this.cause.error.reason._tag + ")" : this.cause._tag
    return "ChatMarkdown failed after " + this.posted.length + " part(s): " + cause
  }

  /**
   * The error without its message text.
   */
  override toJSON(): unknown {
    return {
      _tag: this._tag,
      posted: this.posted.map((part) => ({ messageId: part.messageId, kind: part.kind, transport: part.transport })),
      cause: this.cause._tag === "Chat" ? { _tag: "Chat", error: this.cause.error.toJSON() } : { _tag: this.cause._tag }
    }
  }
}

/**
 * The options `post` and `stream` share.
 *
 * **Details**
 *
 * - `replyTo` applies to the first part.
 * - `maxParts` defaults to 5, a provisional number. Past it, `overflow`
 *   decides: `fail`, the default, or `{ file }`, which sends the rest as one
 *   trailing file message that does not count against `maxParts`.
 * - `minWriteInterval` is the floor between two writes. It defaults to the
 *   adapter's `limits.minWriteInterval`.
 * - `onPart` runs for every message the call creates, the overflow file
 *   included, uninterruptibly once its post returns, so an interrupt can
 *   neither lose an id nor post the message twice. It has to be quick.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Options<R> {
  readonly replyTo?: ReplyTo | undefined
  readonly maxParts?: number | undefined
  readonly overflow?: "fail" | { readonly file: { readonly name: string } } | undefined
  readonly minWriteInterval?: Duration.Duration | undefined
  readonly onPart?: ((part: Part) => Effect.Effect<void, never, R>) | undefined
}

// -----------------------------------------------------------------------------
// Markdown scanning
// -----------------------------------------------------------------------------

interface Fence {
  readonly marker: string
  readonly line: string
}

interface Line {
  /** The index after the line's newline. */
  readonly end: number
  /** The fence open after the line. */
  readonly fence: Fence | undefined
  /** The line closes a fence. */
  readonly closed: boolean
  /** A part can end after this line: it is outside a fence, and blank or closing a fence. */
  readonly boundary: boolean
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/

const fenceAfter = (
  fence: Fence | undefined,
  line: string
): { readonly fence: Fence | undefined; readonly closed: boolean } => {
  const match = fencePattern.exec(line)
  if (match === null) return { fence, closed: false }
  const marker = match[1]
  if (fence === undefined) {
    return marker[0] === "`" && match[2].includes("`")
      ? { fence, closed: false }
      : { fence: { marker, line: line.trimStart() }, closed: false }
  }
  return marker[0] === fence.marker[0] && marker.length >= fence.marker.length && match[2].trim() === ""
    ? { fence: undefined, closed: true }
    : { fence, closed: false }
}

/**
 * The lines of `text`, read from a state of `fence`. Only complete lines
 * count, unless `complete` says the text is finished.
 */
const scanLines = (text: string, fence: Fence | undefined, complete: boolean): Array<Line> => {
  const lines: Array<Line> = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf("\n", start)
    if (newline === -1 && !complete) break
    const end = newline === -1 ? text.length : newline + 1
    const line = text.slice(start, newline === -1 ? text.length : newline).replace(/\r$/, "")
    const step = fenceAfter(fence, line)
    fence = step.fence
    lines.push({
      end,
      fence,
      closed: step.closed,
      boundary: fence === undefined && (step.closed || line.trim() === "")
    })
    start = end
  }
  return lines
}

const fenceAt = (lines: ReadonlyArray<Line>, initial: Fence | undefined, index: number): Fence | undefined => {
  let fence = initial
  for (const line of lines) {
    if (line.end > index) break
    fence = line.fence
  }
  return fence
}

const closing = (fence: Fence | undefined, markdown: string): string =>
  fence === undefined ? "" : (markdown === "" || markdown.endsWith("\n") ? "" : "\n") + fence.marker

const reopening = (fence: Fence | undefined): string => fence === undefined ? "" : fence.line + "\n"

const isBlank = (text: string) => text.trim() === ""

/** Markdown for `text` written as a whole message: an open fence is closed. */
const render = (prefix: string, text: string, fence: Fence | undefined): string => {
  const markdown = prefix + text
  return markdown + closing(fenceAt(scanLines(text, fence, true), fence, text.length), markdown)
}

/**
 * Where to cut `text` so that `prefix`, the cut text and a closing fence
 * measure at most `room`: prefer a fitting block boundary, else cut after
 * the last line, else after the last whitespace, else at the last character.
 * Never inside a grapheme cluster, and never at 0.
 */
const fitCut = (
  measure: (markdown: string) => number,
  text: string,
  fence: Fence | undefined,
  prefix: string,
  room: number
): number => {
  const lines = scanLines(text, fence, false)
  const size = (cut: number) => {
    const markdown = prefix + text.slice(0, cut)
    return measure(markdown + closing(fenceAt(lines, fence, cut), markdown))
  }
  const fits = (cut: number) => size(cut) <= room
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  const most = low
  // Closing a fence removes the synthetic suffix. Look ahead two real closes
  // beyond the estimate, farthest first, to bound the extra measurements.
  const closes = lines.filter((line) => line.closed && line.end > most).slice(0, 2)
  const candidates = closes.map((line) => line.end).reverse()
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].boundary && lines[i].end <= most) candidates.push(lines[i].end)
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].end <= most) candidates.push(lines[i].end)
  }
  for (let i = most - 1; i > 0; i--) {
    if (/\s/.test(text[i])) {
      candidates.push(i + 1)
      break
    }
  }
  candidates.push(most)
  const clusters = graphemes(text)
  for (const candidate of candidates) {
    const cut = clusterStart(clusters, text, candidate)
    if (cut > 0 && fits(cut)) return cut
  }
  // Not even one cluster fits: the cut goes after the first one, and the write fails `TooLarge`.
  return clusterStart(clusters, text, most) || clusterEnd(clusters, 0)
}

let segmenter: Intl.Segmenter | undefined

/** The grapheme clusters of `text`. `Intl.Segmenter` is created on first use. */
const graphemes = (text: string): Intl.Segments =>
  (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })).segment(text)

/** The grapheme cluster boundary at or before `cut`. */
const clusterStart = (clusters: Intl.Segments, text: string, cut: number): number =>
  cut <= 0 || cut >= text.length ? cut : clusters.containing(cut)!.index

/** The end of the grapheme cluster that contains `index`. */
const clusterEnd = (clusters: Intl.Segments, index: number): number => {
  const cluster = clusters.containing(index)!
  return cluster.index + cluster.segment.length
}

/** Where the last grapheme cluster of `text` that is not whitespace starts, or -1 for blank text. */
const lastContentStart = (text: string): number => {
  const end = text.trimEnd().length
  return end === 0 ? -1 : graphemes(text).containing(end - 1)!.index
}

/** Past this many held characters, a held line is released up to its last whitespace. */
const holdLimit = 300

/**
 * What an append may send of `pending` before the input is finished: up to
 * the last complete line, unless inside a code fence.
 */
const releasable = (pending: string, fence: Fence | undefined): string => {
  const lines = scanLines(pending, fence, false)
  const complete = lines.length === 0 ? 0 : lines[lines.length - 1].end
  if (complete === pending.length) return pending
  if (fenceAt(lines, fence, complete) === undefined) {
    const tail = pending.slice(complete)
    if (tail.length <= holdLimit) return pending.slice(0, complete)
    const space = tail.search(/\s\S*$/)
    if (space !== -1) return pending.slice(0, complete + space + 1)
  }
  // The next delta may still extend the trailing cluster, even inside a fence.
  // A split surrogate may complete a code point that extends the preceding cluster.
  const text = /[\ud800-\udbff]$/.test(pending) ? pending.slice(0, -1) : pending
  let last = 0
  for (const cluster of graphemes(text)) last = cluster.index
  return pending.slice(0, last)
}

const utf8Length = (text: string): number => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3
  }
  return bytes
}

// -----------------------------------------------------------------------------
// the reply
// -----------------------------------------------------------------------------

const defaultMaxParts = 5
/** Consecutive `retry` failures of appends on one stream before the repair. Provisional. */
const appendRetryLimit = 3
/** A native stream rolls over at the next block boundary past this share of `streamLength`. */
const softShare = 0.85
/** A native stream rotates once it is this share of `streamAge` old. */
const ageShare = 0.8
/** How long finishing a failed or interrupted reply may take. */
const finishTimeout = Duration.seconds(5)

type FailureCause<E> = ChatMarkdownError<E>["cause"]

interface Current {
  readonly start: number
  readonly fence: Fence | undefined
  readonly prefix: string
  readonly transport: Part["transport"]
  /** Appending to an open native stream. */
  native: boolean
  posted: Posted | undefined
  /** The input index the platform confirmed up to. */
  confirmed: number
  /** The input index a write that failed `uncertain` reached. */
  uncertain: number
  /** Native: the input index appended up to. */
  sent: number
  /** The input length when this part was last written. */
  attempted: number
  /** The Markdown the platform last confirmed. */
  markdown: string
  startedAt: number
  retries: number
  /** A stop to send, and what follows it. Kept until the platform answers, so a stop cut off is sent again. */
  closing: Closing | undefined
  /** A user clicked stop during a repair: the part is written up to here, then the reply ends. */
  stoppedAt: number | undefined
}

interface Closing {
  readonly end: "done" | "rotating"
  readonly onStop: (stopped: boolean) => void
}

interface ReplyOptions<E, R, R2> extends Options<R2> {
  readonly thread: ChatThread
  readonly initial: string
  readonly deltas?: Stream.Stream<string, E, R> | undefined
  readonly descriptor: Descriptor
  readonly chat: Chat.Chat["Service"]
  readonly native?: NativeStream | undefined
  readonly recipient?: string | undefined
  readonly files?: ReadonlyArray<File> | undefined
  readonly actions?: ReadonlyArray<Action> | undefined
  readonly unattachedNote?: ((files: ReadonlyArray<File>) => string) | undefined
}

const firstError = <A>(exit: Exit.Exit<A, ChatError>): ChatError | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit))

/** Whether a write was cut off before the platform answered. */
const unanswered = <A>(exit: Exit.Exit<A, ChatError>): boolean =>
  Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)

/** Whether the adapter guarantees the files were refused and nothing remains posted. */
const isFileRefusal = <A>(exit: Exit.Exit<A, ChatError>): boolean => {
  const reason = firstError(exit)?.reason
  return reason?.retry === "denied" && reason.detail === fileRefused
}

const reply = <E, R, R2>(options: ReplyOptions<E, R, R2>): Effect.Effect<Result, ChatMarkdownError<E>, R | R2> =>
  Effect.suspend(() => {
    const { chat, descriptor, thread } = options
    const measure = descriptor.measure
    const limits = descriptor.limits
    const interval = Duration.toMillis(options.minWriteInterval ?? limits.minWriteInterval)
    let maxParts = Math.max(1, options.maxParts ?? defaultMaxParts)
    const overflow = options.overflow ?? "fail"
    const streamLength = Math.min(limits.streamLength ?? limits.messageLength, limits.messageLength)
    const streamAge = limits.streamAge === undefined ? undefined : Duration.toMillis(limits.streamAge)
    const onPart = options.onPart ?? (() => Effect.void)
    const native = options.native
    const latch = Latch.makeUnsafe(false)
    /** Opens when the upstream fails, which ends the loop even while a write is in flight. */
    const upstreamFailed = Latch.makeUnsafe(false)
    /** Holds the write fibers, so they outlive the loop and the finalizer can wait for them. */
    const writes = Scope.makeUnsafe()

    let input = options.initial
    let upstream: Exit.Exit<void, E> | undefined = options.deltas === undefined ? Exit.void : undefined
    let state: { readonly _tag: "Running" } | { readonly _tag: "Done"; readonly stopped: boolean } | {
      readonly _tag: "Failed"
      readonly cause: FailureCause<E>
    } = { _tag: "Running" }
    let finishing = false
    let nativeAllowed = native !== undefined && options.recipient !== undefined
    /** Without `edit`, a streamed part is posted once, when it is final. */
    const buffered = options.deltas !== undefined && !descriptor.capabilities.has("edit")
    let renderedNatively = false
    let lastWrite = Number.NEGATIVE_INFINITY
    let retryAt: number | undefined
    let overflowStart: number | undefined
    let overflowBytes = 0
    let overflowUncertain = false
    let overflowFilesRefused = false
    let note: string | undefined
    const parts: Array<Part> = []

    const isRunning = () => state._tag === "Running"
    const fail = (cause: FailureCause<E>) => {
      if (isRunning()) state = { _tag: "Failed", cause }
    }
    const failChat = (error: ChatError) => fail({ _tag: "Chat", error })
    const done = (stopped: boolean) => {
      if (isRunning()) state = { _tag: "Done", stopped }
    }

    const newPart = (start: number, fence: Fence | undefined): Current => ({
      start,
      fence,
      prefix: reopening(fence),
      transport: options.deltas === undefined ? "post" : nativeAllowed ? "native" : buffered ? "post" : "edit",
      native: nativeAllowed,
      posted: undefined,
      confirmed: start,
      uncertain: start,
      sent: start,
      attempted: -1,
      markdown: "",
      startedAt: 0,
      retries: 0,
      closing: undefined,
      stoppedAt: undefined
    })

    let current = newPart(0, undefined)

    const partOf = (
      posted: Posted,
      markdown: string,
      text: string,
      kind: Part["kind"],
      transport: Part["transport"]
    ): Part => ({ messageId: posted.id, timestamp: posted.timestamp, markdown, text, kind, transport })

    const toPart = (part: Current, posted: Posted, markdown: string, end: number): Part =>
      partOf(posted, markdown, input.slice(part.start, end), "text", part.transport)

    /** Only the reply's first message replies to `replyTo`. */
    const firstReplyTo = () => parts.length === 0 && options.replyTo !== undefined ? { replyTo: options.replyTo } : {}

    /** The open fence at `index` of the input, read from the current part's complete lines. */
    const fenceAtInput = (part: Current, index: number): Fence | undefined => {
      const text = input.slice(part.start, index)
      return fenceAt(scanLines(text, part.fence, false), part.fence, text.length)
    }

    const now = Clock.currentTimeMillis

    /** Waits for the floor since the previous write returned. */
    const pace: Effect.Effect<void> = Effect.flatMap(now, (time) => {
      const wait = lastWrite + interval - time
      return wait > 0 ? Effect.sleep(Duration.millis(wait)) : Effect.void
    })
    const wrote = Effect.flatMap(now, (time) => Effect.sync(() => void (lastWrite = time)))

    /**
     * Sends an edit or a stop after the floor. Both are safe to send again, so
     * they stay interruptible. `commit` records the answer, or that there was
     * none, before an interrupt can land.
     */
    const write = <A>(
      effect: Effect.Effect<A, ChatError>,
      commit: (exit: Exit.Exit<A, ChatError>) => void
    ): Effect.Effect<void> =>
      Effect.andThen(
        pace,
        Effect.uninterruptibleMask((restore) =>
          Effect.exit(restore(effect)).pipe(
            Effect.ensuring(wrote),
            Effect.flatMap((exit) => Effect.sync(() => commit(exit)))
          )
        )
      )

    /** The post, start or append in flight. */
    let inflight: Fiber.Fiber<unknown> | undefined

    /**
     * Sends a post, a start or an append after the floor. Sending one again
     * could repeat text, so neither an interrupt of the reply nor a failure of
     * the upstream cuts it off: it runs in a fiber of its own, outside the
     * loop, which commits the answer, and the finalizer waits for it. Only the
     * finish timeout cuts it off, and `commit` then records that there was no
     * answer.
     */
    const send = <A>(
      effect: Effect.Effect<A, ChatError>,
      commit: (exit: Exit.Exit<A, ChatError>, time: number) => Effect.Effect<void, never, R2>
    ): Effect.Effect<Exit.Exit<A, ChatError>, never, R2> =>
      Effect.andThen(
        pace,
        Effect.uninterruptibleMask((restore) =>
          Effect.forkIn(
            Effect.uninterruptibleMask((restoreRequest) =>
              Effect.exit(restoreRequest(effect)).pipe(
                Effect.ensuring(wrote),
                Effect.tap((exit) => Effect.flatMap(now, (time) => commit(exit, time))),
                Effect.ensuring(Effect.sync(() => void (inflight = undefined)))
              )
            ),
            writes
          ).pipe(Effect.flatMap((fiber) => {
            inflight = fiber
            return restore(Fiber.join(fiber))
          }))
        )
      )

    /**
     * Creates a message, records it and runs `onPart` for it, in one commit,
     * so an interrupt can neither lose an id nor make the finalizer create the
     * message again.
     */
    const create = (
      effect: Effect.Effect<Posted, ChatError>,
      part: (posted: Posted) => Part,
      commit: (exit: Exit.Exit<Posted, ChatError>, time: number) => void
    ): Effect.Effect<Exit.Exit<Posted, ChatError>, never, R2> =>
      send(effect, (exit, time) => {
        commit(exit, time)
        return Exit.isSuccess(exit) ? onPart(part(exit.value)) : Effect.void
      })

    const finishPart = (end: number) => {
      const part = current
      parts.push(toPart(part, part.posted!, part.markdown, end))
      current = newPart(end, fenceAtInput(part, end))
      if (parts.length >= maxParts) {
        overflowStart = end
        overflowBytes = utf8Length(input.slice(end))
      }
    }

    /** Ends the reply. Blank text left over is given to the last part, since it can't be posted alone. */
    const finishReply = (from: number) => {
      const rest = input.slice(from)
      const last = parts.length - 1
      if (rest !== "" && last >= 0) parts[last] = { ...parts[last], text: parts[last].text + rest }
      done(false)
    }

    const hasFiles = (options.files?.length ?? 0) > 0
    const actions = options.actions ?? []
    const hasActions = actions.length > 0
    /** What the reply's last part costs, measured with the actions it carries. */
    const measureLast = hasActions ? (markdown: string) => measure(markdown, actions) : measure
    /** The last part takes the files and the actions. */
    const hasExtras = hasFiles || hasActions
    /**
     * Set when not even the text's last grapheme cluster fits beside the
     * actions: the text is posted without them, and the files and the
     * actions follow in a message of their own.
     */
    let extrasAlone = false
    /** Whether the note posted on its own takes the actions. */
    let noteActions = false
    /** Set when the actions fit beside neither the text nor the note: they follow in a message of their own. */
    let actionsAfter = false

    // --- post-then-edit --------------------------------------------------------

    /**
     * Writes the current part as `input[start, end)`. `last` marks the part's
     * final write, and `withFiles` the reply's last part, which takes the files.
     */
    const writeEdit = (end: number, last: boolean, withFiles: boolean): Effect.Effect<void, never, R2> =>
      Effect.suspend(() => {
        const part = current
        const markdown = render(part.prefix, input.slice(part.start, end), part.fence)
        part.attempted = input.length
        if (part.posted === undefined) return postPart(part, end, markdown, withFiles && hasExtras)
        if (part.confirmed === end && part.markdown === markdown) return Effect.void
        const edit = chat.edit(thread, part.posted.id, { markdown })
        return write(last ? edit : Chat.withoutRetries(edit), (exit) => {
          if (Exit.isSuccess(exit)) {
            part.confirmed = part.uncertain = end
            part.markdown = markdown
            return
          }
          // Cut off, so it may have landed. The finalizer edits again.
          if (unanswered(exit)) part.uncertain = Math.max(part.uncertain, end)
          const error = firstError(exit)
          if (error === undefined) return
          if (error.retry === "uncertain") part.uncertain = Math.max(part.uncertain, end)
          if (last || error.retry === "denied") failChat(error)
        })
      })

    const postPart = (
      part: Current,
      end: number,
      markdown: string,
      withFiles: boolean
    ): Effect.Effect<void, never, R2> => {
      const files = withFiles && hasFiles ? options.files! : undefined
      const unattachedNote = files === undefined ? undefined : options.unattachedNote
      const withActions = withFiles && hasActions
      const settle = (exit: Exit.Exit<Posted, ChatError>, markdown: string) => {
        if (Exit.isSuccess(exit)) {
          part.posted = exit.value
          part.markdown = markdown
          part.confirmed = part.uncertain = end
          return
        }
        if (unanswered(exit)) part.uncertain = end
        const error = firstError(exit)
        if (error === undefined) return
        if (error.retry === "uncertain") part.uncertain = end
        failChat(error)
      }
      const attempt = (
        markdown: string,
        files: ReadonlyArray<File> | undefined,
        fallback: boolean,
        withActions: boolean
      ) =>
        create(
          chat.post(thread, {
            markdown,
            ...firstReplyTo(),
            ...(files === undefined ? {} : { files }),
            ...(withActions ? { actions } : {})
          }),
          (posted) => toPart(part, posted, markdown, end),
          (exit) => {
            // Left unsettled: the post goes out again without the files.
            if (fallback && isFileRefusal(exit)) return
            settle(exit, markdown)
          }
        )
      const withoutFiles = () => {
        // Replace refused files with the unattached note.
        const text = unattachedNote!(files!)
        if (measureLast(markdown + text) <= limits.messageLength) {
          return Effect.asVoid(attempt(markdown + text, undefined, false, withActions))
        }
        // The note is the last message now, so it takes the actions, or they follow it on their own.
        noteActions = withActions && measure(text, actions) <= limits.messageLength
        actionsAfter = withActions && !noteActions
        // With no text to post, this part is the note.
        if (isBlank(markdown)) return Effect.asVoid(attempt(text, undefined, false, noteActions))
        note = text
        return Effect.asVoid(attempt(markdown, undefined, false, false))
      }
      if (overflowFilesRefused && files !== undefined) return withoutFiles()
      return Effect.flatMap(
        attempt(markdown, files, unattachedNote !== undefined, withActions),
        (exit) => unattachedNote !== undefined && isFileRefusal(exit) ? withoutFiles() : Effect.void
      )
    }

    /** Posts a message after the text that is not part of it: the unattached note, or the actions alone. */
    const postAfter = (text: string, withActions: boolean): Effect.Effect<void, never, R2> => {
      const part = (posted: Posted) => partOf(posted, text, "", "text", "post")
      const post = chat.post(thread, { markdown: text, ...(withActions ? { actions } : {}) })
      return Effect.flatMap(
        create(post, part, (exit) => {
          if (Exit.isSuccess(exit)) return void parts.push(part(exit.value))
          const error = firstError(exit)
          if (error !== undefined) failChat(error)
        }),
        () => isRunning() ? finishAfter : Effect.void
      )
    }

    /**
     * Ends the reply once the text is posted: the unattached note that did
     * not fit the last part follows, then the actions when they fit beside
     * neither. The actions' message counts against `maxParts`, and with no
     * part left the reply fails `Overflow`.
     */
    const finishAfter: Effect.Effect<void, never, R2> = Effect.suspend(() => {
      if (note !== undefined) {
        const text = note
        note = undefined
        return postAfter(text, noteActions)
      }
      if (actionsAfter) {
        actionsAfter = false
        if (parts.length >= maxParts) {
          fail({ _tag: "Overflow" })
          return Effect.void
        }
        return postAfter("", true)
      }
      done(false)
      return Effect.void
    })

    /**
     * Posts the files and the actions in a message of their own, after the
     * text. It counts against `maxParts`, and there is no text left to put in
     * an overflow file, so with no part left the reply fails `Overflow`.
     */
    const postExtras: Effect.Effect<void, never, R2> = Effect.suspend(() => {
      extrasAlone = false
      if (parts.length >= maxParts) {
        fail({ _tag: "Overflow" })
        return Effect.void
      }
      const part = newPart(input.length, undefined)
      current = part
      return Effect.flatMap(postPart(part, input.length, "", true), () => {
        if (!isRunning()) return Effect.void
        finishPart(input.length)
        return finishAfter
      })
    })

    const stepEdit = (final: boolean): Effect.Effect<void, never, R2> =>
      Effect.suspend(() => {
        const part = current
        if (part.stoppedAt !== undefined) {
          // A user clicked stop during a repair: settle what was sent, then end the reply.
          return Effect.map(writeEdit(part.stoppedAt, false, false), () => {
            if (!isRunning()) return
            finishPart(part.confirmed)
            done(true)
          })
        }
        const body = input.slice(part.start)
        if (part.posted === undefined && isBlank(body) && !(final && hasExtras && parts.length === 0)) {
          if (final) finishReply(part.start)
          return Effect.void
        }
        const end = (last: boolean): Effect.Effect<void, never, R2> => {
          if (!last || !isRunning()) return Effect.void
          return extrasAlone ? postExtras : finishAfter
        }
        const cutAt = (cut: number): Effect.Effect<void, never, R2> => {
          // Only blank text follows the cut: this is the last part, so it takes the files, the actions and that text.
          const last = final && isBlank(input.slice(cut))
          return Effect.flatMap(writeEdit(cut, true, last && !extrasAlone), () => {
            if (!isRunning()) return Effect.void
            finishPart(last ? input.length : cut)
            return end(last)
          })
        }
        /** A cut that would end the reply has to leave room for the actions. */
        const lastFits = (cut: number) =>
          !final || !hasActions || extrasAlone || !isBlank(input.slice(cut)) ||
          measureLast(render(part.prefix, input.slice(part.start, cut), part.fence)) <= limits.messageLength
        const cut = measure(render(part.prefix, body, part.fence)) > limits.messageLength
          ? part.start + fitCut(measure, body, part.fence, part.prefix, limits.messageLength)
          : input.length
        if (!lastFits(cut)) {
          // Reserve the last grapheme for a part with actions. If they cannot
          // fit together, send the actions in their own message.
          const keep = lastContentStart(body)
          const tailStart = part.start + keep
          const tailFence = fenceAtInput(part, tailStart)
          const tail = render(reopening(tailFence), input.slice(tailStart), tailFence)
          if (keep > 0 && measureLast(tail) <= limits.messageLength) {
            return cutAt(
              part.start + fitCut(measure, body.slice(0, keep), part.fence, part.prefix, limits.messageLength)
            )
          }
          extrasAlone = true
        }
        if (cut < input.length) return cutAt(cut)
        if (buffered && !final) {
          // Nothing to post until the part is final: it rolls over or the reply ends.
          part.attempted = input.length
          return Effect.void
        }
        return Effect.flatMap(writeEdit(input.length, final, final && !extrasAlone), () => {
          if (final && isRunning()) finishPart(input.length)
          return end(final)
        })
      })

    // --- native ----------------------------------------------------------------

    /** Sends the stop the current part is closing with. A stop carries no text, so its failures are ignored. */
    const sendStop = (part: Current, closing: Closing): Effect.Effect<void> =>
      write(native!.stop(thread, part.posted!.id, { end: closing.end }), (exit) => {
        // Cut off, so the stream may still be open. The finalizer sends the stop again.
        if (unanswered(exit)) return
        part.closing = undefined
        part.native = false
        closing.onStop(Exit.isSuccess(exit) && exit.value.stopped)
      })

    /** Ends a native part at `end` once its stop is answered. The reply ends when `last`, or when a user had clicked stop. */
    const rollNative = (part: Current, end: number, last: boolean) => {
      part.closing = {
        end: last ? "done" : "rotating",
        onStop: (stopped) => {
          finishPart(end)
          if (stopped) done(true)
          else if (last) finishReply(end)
        }
      }
    }

    /**
     * Stops the stream and carries on by post-then-edit: the next edit writes
     * the part's whole known text, the chunk that failed included.
     */
    const repair = (part: Current) => {
      part.closing = {
        end: "rotating",
        onStop: (stopped) => {
          part.attempted = -1
          if (stopped) part.stoppedAt = Math.max(part.uncertain, part.sent)
        }
      }
    }

    const startNative = (final: boolean): Effect.Effect<void, never, R2> =>
      Effect.suspend(() => {
        const part = current
        const pending = input.slice(part.start)
        const text = final ? pending : releasable(pending, part.fence)
        if (isBlank(text)) {
          if (final) finishReply(part.start)
          return Effect.void
        }
        part.attempted = input.length
        // Measured with the closing fence, so a start leaves room to close it.
        const whole = render(part.prefix, text, part.fence)
        const cut = measure(whole) > streamLength
          ? fitCut(measure, text, part.fence, part.prefix, streamLength)
          : text.length
        const end = part.start + cut
        const roll = cut < text.length
        const markdown = roll || final ? render(part.prefix, text.slice(0, cut), part.fence) : part.prefix + text
        return Effect.asVoid(
          create(
            native!.start(thread, {
              markdown,
              ...firstReplyTo(),
              ...(parts.length === 0 ? {} : { continues: parts[parts.length - 1].messageId }),
              recipient: options.recipient
            }),
            (posted) => toPart(part, posted, markdown, end),
            (exit, time) => {
              if (Exit.isSuccess(exit)) {
                renderedNatively = true
                part.posted = exit.value
                part.markdown = markdown
                part.confirmed = part.uncertain = part.sent = end
                part.startedAt = time
                if (roll || final) rollNative(part, end, !roll)
                return
              }
              if (unanswered(exit)) part.uncertain = end
              const error = firstError(exit)
              if (error === undefined) return
              if (error.reason._tag === "Unsupported" && !renderedNatively) {
                nativeAllowed = false
                current = newPart(part.start, part.fence)
                return
              }
              if (error.retry === "uncertain") part.uncertain = end
              failChat(error)
            }
          )
        )
      })

    /**
     * What the next append sends, and whether the part ends after it. Every
     * append leaves room to close the code fence it ends in, so a part that
     * rolls over on length always ends with its fence closed. `rotate` sends
     * just that closing fence, for a stream about to rotate on age.
     */
    const nextAppend = (part: Current, final: boolean, rotate: boolean) => {
      const pending = input.slice(part.sent)
      const fence = fenceAtInput(part, part.sent)
      const lines = scanLines(pending, fence, false)
      const size = (text: string) => measure(part.markdown + text)
      const closeAt = (piece: string) => closing(fenceAt(lines, fence, piece.length), part.markdown + piece)
      const closeOnly = { piece: "", extra: closeAt(""), roll: true }
      if (rotate) return closeOnly
      const soft = softShare * streamLength
      const piece = final ? pending : releasable(pending, fence)
      const reserve = final
        ? closing(fenceAt(scanLines(pending, fence, true), fence, pending.length), part.markdown + pending)
        : closeAt(piece)
      const extra = final ? reserve : ""
      if (size(piece + reserve) <= soft) return { piece, extra, roll: false }
      for (const line of lines) {
        if (!line.boundary || line.end > piece.length) continue
        const measured = size(pending.slice(0, line.end))
        if (measured > streamLength) break
        if (measured >= soft) return { piece: pending.slice(0, line.end), extra: "", roll: true }
      }
      if (size(piece + reserve) <= streamLength) return { piece, extra, roll: false }
      const cut = pending.slice(0, fitCut(measure, pending, fence, part.markdown, streamLength))
      // Not even the smallest cut fits with its closing fence: send just the closing fence.
      return size(cut + closeAt(cut)) <= streamLength ? { piece: cut, extra: closeAt(cut), roll: true } : closeOnly
    }

    /**
     * Appends the next piece. What follows, a rollover, a repair or a retry,
     * is recorded in the commit, so an interrupt can't lose it.
     */
    const appendNative = (final: boolean, rotate: boolean): Effect.Effect<void, never, R2> =>
      Effect.suspend(() => {
        const part = current
        const { extra, piece, roll } = nextAppend(part, final, rotate)
        if (piece === "" && extra === "") {
          if (roll || final) rollNative(part, part.sent, !roll)
          return Effect.void
        }
        part.attempted = input.length
        const markdown = piece + extra
        const commit = (
          exit: Exit.Exit<{ readonly state: string; readonly held: number }, ChatError>,
          time: number
        ) => {
          if (Exit.isSuccess(exit)) {
            const { held, state } = exit.value
            if (state === "stopped") {
              part.native = false
              finishPart(part.sent)
              done(true)
            } else if (state === "closed") {
              part.native = false
              part.attempted = -1
            } else {
              const added = Math.max(0, markdown.length - held)
              part.retries = 0
              part.sent += Math.min(piece.length, added)
              part.confirmed = part.uncertain = part.sent
              part.markdown += markdown.slice(0, added)
              if (roll || (final && part.sent === input.length)) rollNative(part, part.sent, !roll)
            }
            return
          }
          // Cut off by the finish timeout, so it may have landed.
          if (unanswered(exit)) {
            part.uncertain = part.sent + piece.length
            return
          }
          const error = firstError(exit)
          if (error === undefined) return
          if (error.reason._tag === "TooLarge") {
            // Retry the chunk in the next part.
            rollNative(part, part.sent, false)
          } else if (error.retry === "retry") {
            part.retries++
            if (part.retries >= appendRetryLimit) repair(part)
            else retryAt = time + (error.retryAfter === undefined ? interval : Duration.toMillis(error.retryAfter))
          } else if (error.retry === "uncertain") {
            part.uncertain = part.sent + piece.length
            repair(part)
          } else {
            failChat(error)
            part.closing = { end: "done", onStop: () => {} }
          }
        }
        return Effect.asVoid(
          send(
            native!.append(thread, part.posted!.id, markdown, { flush: final || roll }),
            (exit, time) => Effect.sync(() => commit(exit, time))
          )
        )
      })

    const stepNative = (final: boolean): Effect.Effect<void, never, R2> =>
      Effect.suspend(() => {
        const part = current
        if (part.posted === undefined) return startNative(final)
        if (final || streamAge === undefined) return appendNative(final, false)
        return Effect.flatMap(now, (time) => appendNative(final, time - part.startedAt >= ageShare * streamAge))
      })

    // --- overflow --------------------------------------------------------------

    const stepOverflow = (final: boolean): Effect.Effect<void, never, R2> =>
      Effect.suspend(() => {
        const start = overflowStart!
        const rest = input.slice(start)
        if (isBlank(rest)) {
          if (final) finishReply(start)
          return Effect.void
        }
        if (overflow === "fail" || overflowBytes > limits.uploadBytes) {
          fail({ _tag: "Overflow" })
          return Effect.void
        }
        // The upload is skipped when the reply failed or was interrupted.
        if (!final || finishing) {
          if (finishing) done(false)
          return Effect.void
        }
        const file: File = {
          name: overflow.file.name,
          contentType: "text/markdown",
          content: new TextEncoder().encode(rest)
        }
        const part = (markdown: string) => (posted: Posted) => partOf(posted, markdown, rest, "overflowFile", "post")
        // Attach consumer files to the final message.
        const attempt = (markdown: string, files: ReadonlyArray<File>, fallback: boolean) =>
          create(
            chat.post(thread, { markdown, files: [file, ...files], ...(hasActions ? { actions } : {}) }),
            part(markdown),
            (exit) => {
              if (Exit.isSuccess(exit)) {
                parts.push(part(markdown)(exit.value))
                overflowStart = input.length
                return done(false)
              }
              if (fallback && isFileRefusal(exit)) return
              if (unanswered(exit)) overflowUncertain = true
              const error = firstError(exit)
              if (error === undefined) return
              overflowUncertain = error.retry === "uncertain"
              failChat(error)
            }
          )
        const files = options.files ?? []
        const unattachedNote = files.length === 0 ? undefined : options.unattachedNote
        return Effect.asVoid(Effect.map(attempt("", files, unattachedNote !== undefined), (exit) => {
          if (unattachedNote === undefined || !isFileRefusal(exit)) return
          // The overflow file was refused too. Drain the remaining text through
          // the normal splitter, without files or another maxParts overflow.
          overflowFilesRefused = true
          overflowStart = undefined
          maxParts = Infinity
          nativeAllowed = false
          current.native = false
        }))
      })

    // --- the loop --------------------------------------------------------------

    /** Whether there is a write to make. A stop is sent even after the reply failed. */
    const active = () => isRunning() || current.closing !== undefined

    const hasWork = (): boolean => {
      if (!isRunning() || upstream !== undefined || current.closing !== undefined) return true
      if (overflowStart !== undefined) {
        return !isBlank(input.slice(overflowStart)) && (overflow === "fail" || overflowBytes > limits.uploadBytes)
      }
      const part = current
      if (input.length <= part.attempted) return false
      if (!part.native) return !isBlank(input.slice(part.start))
      return part.posted === undefined
        ? !isBlank(releasable(input.slice(part.start), part.fence))
        : releasable(input.slice(part.sent), fenceAtInput(part, part.sent)) !== ""
    }

    /** Waits until there is something to write, or a retry is due. */
    const awaitWork: Effect.Effect<void> = Effect.suspend(() => {
      if (retryAt !== undefined) {
        const at = retryAt
        retryAt = undefined
        return Effect.flatMap(now, (time) => time < at ? Effect.sleep(Duration.millis(at - time)) : Effect.void)
      }
      if (hasWork()) return Effect.void
      latch.closeUnsafe()
      return Effect.andThen(latch.await, awaitWork)
    })

    const step = (final: boolean): Effect.Effect<void, never, R2> => {
      const closing = current.closing
      if (closing !== undefined) return sendStop(current, closing)
      if (overflowStart !== undefined) return stepOverflow(final)
      return current.native ? stepNative(final) : stepEdit(final)
    }

    const loop: Effect.Effect<void, never, R2> = Effect.suspend(() =>
      active() ?
        Effect.flatMap(awaitWork, () => {
          if (!active()) return Effect.void
          if (current.closing === undefined && upstream !== undefined && Exit.isFailure(upstream)) return Effect.void
          // The write takes whatever arrived while it waited for the floor.
          return Effect.andThen(pace, Effect.suspend(() => step(upstream !== undefined))).pipe(Effect.andThen(loop))
        }) :
        Effect.void
    )

    /** Writes what was received as the end of the reply, closing an open fence, within a short timeout. */
    const finish: Effect.Effect<void, never, R2> = Effect.suspend(() => {
      finishing = true
      const drain: Effect.Effect<void, never, R2> = Effect.suspend(() =>
        active() ? Effect.andThen(step(true), drain) : Effect.void
      )
      // A write in flight commits first. Interruptible, so the timeout can cut it short in the interrupt finalizer.
      const awaitInflight = Effect.suspend(() => inflight === undefined ? Effect.void : Fiber.await(inflight))
      return Effect.timeoutOption(Effect.interruptible(Effect.andThen(awaitInflight, drain)), finishTimeout).pipe(
        Effect.andThen(Effect.suspend(() => inflight === undefined ? Effect.void : Fiber.interrupt(inflight))),
        Effect.asVoid
      )
    })

    const toError = (cause: FailureCause<E>): ChatMarkdownError<E> => {
      const posted = parts.slice()
      let uncertain = ""
      let from: number
      if (overflowStart !== undefined) {
        from = overflowStart
        if (overflowUncertain) {
          uncertain = input.slice(from)
          from = input.length
        }
      } else {
        const part = current
        if (part.posted !== undefined) posted.push(toPart(part, part.posted, part.markdown, part.confirmed))
        from = Math.max(part.confirmed, part.uncertain)
        uncertain = input.slice(part.confirmed, from)
      }
      // Read from the start of the input, so it holds whichever part the cut fell in.
      const fence = from === input.length
        ? undefined
        : fenceAt(scanLines(input.slice(0, from), undefined, false), undefined, from)
      return new ChatMarkdownError<E>({
        posted,
        remaining: input.slice(from),
        ...(fence === undefined ? {} : { remainingFence: fence.line }),
        ...(uncertain === "" ? {} : { uncertain }),
        cause
      })
    }

    const consume: Effect.Effect<void, never, R> = options.deltas === undefined
      ? Effect.void
      : Effect.flatMap(
        Effect.exit(Stream.runForEach(options.deltas, (chunk) =>
          Effect.sync(() => {
            input += chunk
            if (overflowStart !== undefined) overflowBytes += utf8Length(chunk)
            latch.openUnsafe()
          }))),
        (exit) =>
          Effect.sync(() => {
            upstream = exit
            latch.openUnsafe()
            if (Exit.isFailure(exit)) upstreamFailed.openUnsafe()
          })
      )

    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(consume)
      // A failed upstream ends the loop at once, so the finish timeout starts even while a write is in flight.
      yield* Effect.onInterrupt(
        Effect.raceFirst(loop, upstreamFailed.await),
        () => Effect.andThen(Fiber.interrupt(fiber), finish)
      )
      yield* Fiber.interrupt(fiber)
      if (upstream !== undefined && Exit.isFailure(upstream) && (isRunning() || state._tag === "Done")) {
        const cause = upstream.cause
        state = { _tag: "Running" }
        yield* finish
        const error = Cause.findErrorOption(cause)
        if (Option.isNone(error)) return yield* Effect.failCause(cause as Cause.Cause<never>)
        state = { _tag: "Failed", cause: { _tag: "Upstream", error: error.value } }
      } else if (current.closing !== undefined || inflight !== undefined) {
        // The reply failed already, and the race cut off its stop or write. The finish sends only that stop,
        // within the timeout, since a failed reply writes no more text, and keeps the error it failed with.
        yield* finish
      }
      yield* Effect.annotateCurrentSpan("chat.markdown.transport", renderedNatively ? "native" : current.transport)
      if (state._tag === "Failed") return yield* Effect.fail(toError(state.cause))
      return { parts, stopped: state._tag === "Done" && state.stopped }
    }).pipe(Effect.ensuring(Scope.close(writes, Exit.void)))
  })

// -----------------------------------------------------------------------------
// the calls
// -----------------------------------------------------------------------------

/**
 * Posts Markdown of any length, split into as many messages as it needs.
 *
 * **Details**
 *
 * - A part ends at a block boundary: after a blank line or a closed code
 *   fence. A block too long for one message is cut at a line, closing the code
 *   fence it is in and reopening it in the next part. Length is measured with
 *   the adapter's `measure`.
 * - Each part is posted once and never edited. Parts are paced by
 *   `minWriteInterval`.
 * - `files` go with the last part, or with the overflow file when there is
 *   one. Blank text after the last cut stays with the last part.
 * - With `unattachedNote`, a post with files that fails `denied` with
 *   detail `file_refused` is tried once more without them, ending in the note,
 *   or followed by the note when it does not fit. Any failure of that post
 *   fails the call. Without `unattachedNote` the first failure fails the
 *   call. If the overflow file is refused too, the remaining text is split
 *   into messages beyond `maxParts`, without files and ending in the note.
 *   An `uncertain` failure records the part in `uncertain` and posts no note.
 * - `actions` go with the last part too, which is cut so that
 *   `measure(part, actions) <= limits.messageLength`. The parts before it
 *   are filled without room for them. When not even the text's last grapheme
 *   cluster fits beside the actions, the files and the actions go in a
 *   message of their own after the text. Either can add a part, which counts
 *   against `maxParts`. When `measure("", actions)` is already over, the
 *   call fails `TooLarge` before anything is posted.
 * - An unattached note posted on its own takes the actions. When they don't
 *   fit beside it, they follow it in a message of their own, which counts
 *   against `maxParts`.
 * - A `TooLarge` without detail `file_refused` fails the call, even with
 *   `subject: "files"` or text that measured as fitting. Fallback requires
 *   `denied` plus `file_refused`; `subject` never controls it.
 * - An empty input posts nothing and succeeds with no parts, unless there are
 *   files or actions, which then go out in a message of their own.
 *
 * **Gotchas**
 *
 * A failure in the middle leaves the parts already posted in place. The error
 * says what was posted and what was not.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const post = <R = never>(
  thread: ChatThread,
  markdown: string,
  options?: Options<R> & {
    readonly files?: ReadonlyArray<File> | undefined
    readonly actions?: ReadonlyArray<Action> | undefined
    readonly unattachedNote?: ((files: ReadonlyArray<File>) => string) | undefined
  }
): Effect.Effect<Result, ChatMarkdownError, Chat.Chat | R> =>
  Effect.gen(function*() {
    const chat = yield* Chat.Chat
    const failed = (error: ChatError) =>
      new ChatMarkdownError<never>({ posted: [], remaining: markdown, cause: { _tag: "Chat", error } })
    const descriptor = yield* Effect.mapError(chat.descriptor(thread.platform), failed)
    const actions = options?.actions ?? []
    if (actions.length > 0 && descriptor.measure("", actions) > descriptor.limits.messageLength) {
      return yield* Effect.fail(failed(
        new ChatError({
          platform: thread.platform,
          op: "post",
          reason: new TooLarge({ detail: "actions_too_long" })
        })
      ))
    }
    return yield* reply<never, never, R>({ ...options, thread, initial: markdown, descriptor, chat })
  }).pipe(Effect.withSpan("ChatMarkdown.post", { attributes: { "chat.platform": thread.platform } }))

/**
 * Writes a stream of Markdown deltas as one reply, as the text arrives.
 *
 * **Details**
 *
 * - With a `recipient` and an adapter that has a native stream, the reply is
 *   written by native appends. Otherwise, or when the first native start fails
 *   with `Unsupported`, it posts and then edits. The result and the span say
 *   which ran.
 * - On an adapter without `edit` the reply is buffered instead: each part is
 *   posted once, when it rolls over or the reply ends, with transport
 *   `post`. Nothing shows until then. An upstream failure or an interrupt
 *   posts what was received, as above.
 * - Text that outgrows a message rolls over into a new one at a block
 *   boundary, and each new message counts against `maxParts`. A native stream
 *   rolls over at the next block boundary past 85% of `limits.streamLength`,
 *   and rotates once it is 80% of `limits.streamAge` old. Every append leaves
 *   room to close the code fence it ends in, and a rollover or rotation closes
 *   it.
 * - Writes are paced by `minWriteInterval`, on `Clock`. The next write is
 *   scheduled only after the previous one returns, and takes all the text that
 *   arrived meanwhile.
 * - An append holds back the unfinished last line, unless inside a code fence.
 *   An edit closes an open code fence.
 * - An intermediate edit that fails `retry` or `uncertain` is dropped, since
 *   the next edit carries the whole text. A `denied` failure, and any failure
 *   of a post or of a part's last edit, fails the reply.
 * - A native append that fails `retry` is tried again after its
 *   `retryAfter`, or the write interval, whether or not new text arrived.
 *   Three in a row, or one `uncertain` failure, stop the stream, edit the part
 *   to its whole known text, the failed chunk included, and carry on by
 *   post-then-edit. `TooLarge` starts the next part with the chunk.
 * - `Result.stopped` is true when a user clicked stop on the reply. The
 *   upstream is then interrupted.
 * - When the upstream fails or the call is interrupted, what was received is
 *   written out, with an open code fence closed, within a short timeout, and
 *   left posted. The timeout starts at once, even while a write is in
 *   flight. A post, start or append in flight is not cut off by the failure
 *   or the interrupt, since sending it again could repeat text: the finalizer
 *   waits for it, then sends what follows, a stop cut off by the interrupt
 *   included. Only the timeout cuts a write off, and its text is then
 *   reported as `uncertain`.
 *
 * **Gotchas**
 *
 * - There are no files: post them after the result, when it is known whether
 *   the reply stopped.
 * - There are no actions either. Add them after the result with
 *   `chat.edit(thread, last.messageId, { markdown: last.markdown, actions })`,
 *   where `last` is the final entry of `Result.parts`. Without `edit` they
 *   can't be added to the reply: post them in a message of their own with
 *   `chat.post(thread, { markdown, actions })`.
 * - To stop a reply, end `deltas` with `Stream.interruptWhen` or
 *   `Stream.haltWhen`, so a `Result` still comes back. Interrupting the call
 *   leaves only the ids collected through `onPart`.
 * - Native writes go to the adapter through the `Registry`, so a layer that
 *   wraps `Chat` does not see them.
 * - A native part that is rolled over on `TooLarge` can end inside an open
 *   code fence, since it can no longer be appended to. The next part reopens
 *   the fence.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const stream = <E, R, R2 = never>(
  thread: ChatThread,
  deltas: Stream.Stream<string, E, R>,
  options?: Options<R2> & {
    readonly recipient?: string | undefined
  }
): Effect.Effect<Result, ChatMarkdownError<E>, Chat.Chat | Registry | R | R2> =>
  Effect.gen(function*() {
    const chat = yield* Chat.Chat
    const registry = yield* Registry
    const adapter = yield* Effect.mapError(
      registry.get(thread.platform),
      (error) => new ChatMarkdownError<E>({ posted: [], remaining: "", cause: { _tag: "Chat", error } })
    )
    const native = adapter.descriptor.capabilities.has("nativeStream") ? adapter.nativeStream : undefined
    return yield* reply<E, R, R2>({
      ...options,
      thread,
      initial: "",
      deltas,
      descriptor: adapter.descriptor,
      chat,
      native
    })
  }).pipe(Effect.withSpan("ChatMarkdown.stream", { attributes: { "chat.platform": thread.platform } }))
