import type { ChatErrorReason } from "effect/chat/ChatError"
import type * as ChatUi from "effect/chat/ChatUi"
import * as Predicate from "effect/Predicate"
import * as Errors from "./errors.ts"
import { string } from "./normalize.ts"

/** The adapter's own cap, as Telegram publishes no button count. @internal */
export const actionsPerMessage = 100

/** `callback_data` is 1 to 64 bytes, less the separator. @internal */
export const actionDataLength = 63

/** Between a button's id and its value in `callback_data`. @internal */
export const separator = "\u001f"

const encoder = new TextEncoder()

const bytes = (s: string) => encoder.encode(s).length

/** A button's `callback_data`: its id, and its value after the separator when it has one. @internal */
export const callbackData = (button: { readonly id: string; readonly value?: string | undefined }): string =>
  button.value === undefined ? button.id : button.id + separator + button.value

/** The id and value of `callback_data`. @internal */
export const parseData = (data: string): { readonly id: string; readonly value?: string | undefined } => {
  const at = data.indexOf(separator)
  return at === -1 ? { id: data } : { id: data.slice(0, at), value: data.slice(at + 1) }
}

/** A label short enough to share a row with two others. */
const shortLabel = 12

const perRow = 3

type KeyboardButton =
  | { readonly text: string; readonly callback_data: string; readonly style?: string }
  | { readonly text: string; readonly url: string }

/**
 * The inline keyboard of a message's actions, or the reason it can't be
 * sent: a select (`Unsupported`), too many elements, data past 63 bytes,
 * an id holding the separator, or a link that is not http or https.
 *
 * @internal
 */
export const keyboard = (
  actions: ReadonlyArray<ChatUi.Action>
): { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<KeyboardButton>> } | ChatErrorReason => {
  if (actions.some((action) => action._tag === "Select")) return Errors.unsupported("selects")
  if (actions.length > actionsPerMessage) return Errors.tooLarge(undefined, "too_many_actions")
  const buttons: Array<KeyboardButton> = []
  for (const action of actions) {
    if (action._tag === "Button") {
      if (action.id.includes(separator)) return Errors.invalidRequest("invalid_action_id")
      if (bytes(action.id) + bytes(action.value ?? "") > actionDataLength) {
        return Errors.tooLarge(undefined, "action_data_too_long")
      }
      buttons.push({
        text: action.label,
        callback_data: callbackData(action),
        ...(action.style === "primary" || action.style === "danger" ? { style: action.style } : {})
      })
    } else if (action._tag === "LinkButton") {
      if (!/^https?:\/\//i.test(action.url)) return Errors.invalidRequest("untrusted_url")
      buttons.push({ text: action.label, url: action.url })
    }
  }
  const rows: Array<Array<KeyboardButton>> = []
  let row: Array<KeyboardButton> = []
  for (const button of buttons) {
    const short = button.text.length <= shortLabel
    if (!short || row.length === perRow || row.some((b) => b.text.length > shortLabel)) {
      if (row.length > 0) rows.push(row)
      row = []
    }
    row.push(button)
  }
  if (row.length > 0) rows.push(row)
  return { inline_keyboard: rows }
}

/** Every `callback_data` in a message's `reply_markup`. @internal */
export const keyboardData = (replyMarkup: unknown): ReadonlySet<string> => {
  const data = new Set<string>()
  const rows = Predicate.isObject(replyMarkup) ? replyMarkup.inline_keyboard : undefined
  if (!Array.isArray(rows)) return data
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const button of row) {
      const value = string(button, "callback_data")
      if (value !== undefined) data.add(value)
    }
  }
  return data
}
