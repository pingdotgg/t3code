import type { ChatError } from "effect/chat/ChatError"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { TelegramBotApi } from "../TelegramBotApi.ts"
import * as Errors from "./errors.ts"
import { integer } from "./normalize.ts"
import { allowedUpdates, type Outcome } from "./receive.ts"

/** @internal */
export interface Options {
  readonly api: TelegramBotApi["Service"]
  readonly timeout: Duration.Duration
  readonly maxAttempts: number
  readonly receive: (update: unknown) => Effect.Effect<Outcome>
}

const isConflict = (error: ChatError) => error.reason._tag === "InvalidRequest" && error.reason.detail === "conflict"

/** One `getUpdates`, from `offset`. @internal */
export const getUpdates = (api: TelegramBotApi["Service"], offset: number | undefined, timeout: Duration.Duration) =>
  api.call("getUpdates", {
    ...(offset === undefined ? {} : { offset }),
    timeout: Math.floor(Duration.toSeconds(timeout)),
    allowed_updates: allowedUpdates
  }).pipe(Effect.map((result) => Array.isArray(result) ? result : []))

/**
 * Runs one update, retrying `notAccepted` and `invalid` up to
 * `maxAttempts` times with a backoff from one second. Then it is logged
 * and skipped: `getUpdates` is one ordered queue, and retrying forever
 * would stall every chat.
 *
 * @internal
 */
export const runUpdate = (update: unknown, options: Options): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let attempt = 1;; attempt++) {
      const outcome = yield* options.receive(update)
      if (outcome === "accepted" || outcome === "unhandled") return
      if (attempt >= options.maxAttempts) {
        return yield* Effect.logError("telegram polling: an update was not accepted, skipped").pipe(
          Effect.annotateLogs({ "telegram.update_id": integer(update, "update_id") })
        )
      }
      yield* Effect.sleep(Duration.seconds(2 ** (attempt - 1)))
    }
  })

/**
 * The polling loop. `first` is the answer of the call the layer made
 * itself. Each update's offset is confirmed by the next call only once the
 * update was run, so a process that dies part way sees it again.
 *
 * @internal
 */
export const loop = (first: ReadonlyArray<unknown>, options: Options): Effect.Effect<void> =>
  Effect.gen(function*() {
    let batch = first
    let offset: number | undefined
    for (;;) {
      for (const update of batch) {
        yield* runUpdate(update, options)
        const id = integer(update, "update_id")
        if (id !== undefined) offset = id + 1
      }
      const next = yield* Effect.result(getUpdates(options.api, offset, options.timeout))
      if (next._tag === "Success") {
        batch = next.success
        continue
      }
      batch = []
      if (isConflict(next.failure)) {
        return yield* Effect.logError(
          "telegram polling: getUpdates answered 409, another poller or a webhook is active; polling stopped"
        )
      }
      yield* Effect.logWarning("telegram polling: getUpdates failed, retrying").pipe(
        Effect.annotateLogs({ "chat.error.reason": next.failure.reason._tag })
      )
      yield* Effect.sleep(Duration.seconds(5))
    }
  })

/** The error the layer fails with on a 409 at start. @internal */
export const conflict = (error: ChatError): ChatError =>
  isConflict(error) ? Errors.chatError("layerPolling", Errors.invalidRequest("conflict")) : error
