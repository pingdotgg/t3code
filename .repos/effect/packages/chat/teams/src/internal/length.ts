/**
 * What a message costs against the Connector's limit, counted in UTF-16
 * units of `JSON.stringify(activity)`, the serialised activity body.
 *
 * Every fixed size here comes from serialising the templates in
 * `render.ts`, so the numbers follow the renderer.
 */
import type { Action } from "effect/chat/ChatUi"
import { maxIdLength } from "./address.ts"
import * as Render from "./render.ts"

const size = (value: unknown): number => JSON.stringify(value).length

/** An element in an array, with the comma before or after it. */
const element = (value: unknown): number => size(value) + 1

/**
 * The size of a serialised activity body the Connector takes, in UTF-16
 * units.
 *
 * Provisional: Microsoft documents no exact number, and this is not verified
 * against the Connector yet.
 *
 * @internal
 */
export const Edge = 50_000

/** The text form with empty `text`. @internal */
export const S = size(Render.textActivity(""))

/** The card form with an empty card body. @internal */
export const T = size(Render.cardActivityOf([]))

/** One table cell and its column definition. @internal */
export const K = element(Render.tableCell("")) + element(Render.column)

/**
 * The largest element group a source line can add: a `TextBlock`, a
 * `CodeBlock` (with `PlainText` as its language), or a `Table` with one
 * row of one cell, which is also more than a new row of one cell.
 *
 * @internal
 */
export const E = Math.max(
  element(Render.textBlock("")),
  element(Render.codeBlock("", "PlainText")),
  element(Render.table([[""]]))
)

const id = "x".repeat(maxIdLength)

/**
 * The members the adapter may add to an activity besides what the renderer
 * gives, each id at `maxIdLength`: `replyToId`, `recipient`, and
 * `entities` holding a `streaminfo` entity, the AI-generated label and a
 * `targetedMessageInfo` entity. Ids are sent without JSON escapes.
 *
 * @internal
 */
export const A = size({
  replyToId: id,
  recipient: { id },
  entities: [
    { type: "streaminfo", streamId: id, streamType: "informative", streamSequence: Number.MAX_SAFE_INTEGER },
    {
      type: "https://schema.org/Message",
      "@type": "Message",
      "@context": "https://schema.org",
      "@id": "",
      additionalType: ["AIGeneratedContent"]
    },
    { type: "targetedMessageInfo", messageId: id }
  ]
}) - 1

/**
 * Units set aside for mention entities.
 *
 * Provisional: the adapter does not send mentions in v1.
 *
 * @internal
 */
export const M_units = 4_000

/** Units set aside for file attachments: none, files are not sent in v1. @internal */
export const F_units = 0

/**
 * The fixed part of a message: the larger of the two forms with the first
 * element of the card. The first source line has no line break before it to
 * pay for its element, so `E` is reserved once for it.
 *
 * @internal
 */
export const skeleton = Math.max(S, T + E)

/** @internal */
export const R = skeleton + A + M_units + F_units

/** @internal */
export const messageLength = Edge - R

/**
 * What one UTF-16 unit of the source can cost once rendered and serialised.
 * A line break pays for the element its line may start, and a pipe for the
 * table cell and column it may add.
 */
const unit = (code: number): number => {
  switch (code) {
    case 0x0a:
    case 0x0d:
      return 2 + E
    case 0x7c:
      return 1 + K
    case 0x22:
    case 0x5c:
      return 2
    case 0x09: // A partially stripped tab in fenced code can leave three spaces.
    case 0x24:
      return 3
    case 0x3c:
      return 4
    case 0x26:
      return 5
    default:
      return code < 0x20 ? 6 : 1
  }
}

/** @internal */
export const weight = (text: string): number => {
  let total = 0
  for (let i = 0; i < text.length; i++) total += unit(text.charCodeAt(i))
  return total
}

const row = element(Render.actionSet([]))

/** @internal */
export type TokenLength = (button: { readonly id: string; readonly value?: string | undefined }) => number

const actionCost = (action: Action, tokenLength: TokenLength): number => {
  switch (action._tag) {
    case "Button":
      return element(Render.buttonAction({ ...action, label: "" }, "")) + 2 * weight(action.label) +
        2 * tokenLength(action) + row
    case "LinkButton":
      return element(Render.linkAction({ ...action, label: "", url: "" })) + weight(action.label) +
        weight(action.url) + row
    case "Select":
      // The adapter refuses a select before it renders anything.
      return 0
  }
}

/**
 * The descriptor's `measure`: the weight of each unit of the Markdown plus
 * the cost of each action, where a button's cost holds its token twice (the
 * action and its fallback) at `tokenLength`, and each action pays for a
 * whole `ActionSet` row. With `R` added it is never less than the size of
 * either form of the activity.
 *
 * @internal
 */
export const makeMeasure =
  (tokenLength: TokenLength) => (markdown: string, actions?: ReadonlyArray<Action>): number => {
    let total = weight(markdown)
    for (const action of actions ?? []) total += actionCost(action, tokenLength)
    return total
  }
