/**
 * A message's elements as Slack's `actions` block, and what that block
 * costs against the 13,200 cap.
 */
import type { Action } from "effect/chat/ChatUi"
import * as Emoji from "./emoji.ts"

/**
 * The `block_id` of the `actions` block the adapter builds, and so the
 * mark of a click on one of its own elements. Five ASCII characters, the
 * length of the id Slack generates, which `cost` charges.
 *
 * @internal
 */
export const blockId = "chat1"

/**
 * The one character the adapter reserves: a button or select id may not hold
 * it, a link button's `action_id` starts with it, and it separates the
 * parts of a modal's `private_metadata`.
 *
 * @internal
 */
export const join = "\u241F"

interface PlainText {
  readonly type: "plain_text"
  readonly text: string
}

interface SelectOption {
  readonly text: PlainText
  readonly value: string
}

/** @internal */
export type Element =
  | {
    readonly type: "button"
    readonly action_id: string
    readonly text: PlainText
    readonly value?: string
    readonly url?: string
    readonly style?: "primary" | "danger"
  }
  | {
    readonly type: "static_select"
    readonly action_id: string
    readonly placeholder?: PlainText
    readonly options: ReadonlyArray<SelectOption>
    readonly initial_option?: SelectOption
  }

/** @internal */
export const plainText = (text: string): PlainText => ({ type: "plain_text", text })

/** @internal */
export const option = (label: string, value: string): SelectOption => ({ text: plainText(label), value })

/**
 * The elements for `actions`, in order. A button's id is its `action_id`
 * and its value its `value`. A link button is a button with a `url`, and an
 * `action_id` of the join and its index, which no id of the consumer's can
 * be. A select's options carry their values, and `selected` is its
 * `initial_option`.
 *
 * @internal
 */
export const elements = (actions: ReadonlyArray<Action>): Array<Element> =>
  actions.map((action, index): Element => {
    switch (action._tag) {
      case "Button":
        return {
          type: "button",
          action_id: action.id,
          text: plainText(action.label),
          ...(action.value === undefined ? {} : { value: action.value }),
          ...(action.style === "primary" || action.style === "danger" ? { style: action.style } : {})
        }
      case "LinkButton":
        return { type: "button", action_id: join + index, text: plainText(action.label), url: action.url }
      case "Select": {
        const selected = action.options.find((option) => option.value === action.selected)
        return {
          type: "static_select",
          action_id: action.id,
          ...(action.placeholder === undefined ? {} : { placeholder: plainText(action.placeholder) }),
          options: action.options.map((entry) => option(entry.label, entry.value)),
          ...(selected === undefined ? {} : { initial_option: option(selected.label, selected.value) })
        }
      }
    }
  })

/**
 * The `actions` block for a message's elements.
 *
 * @internal
 */
export const block = (actions: ReadonlyArray<Action>) => ({
  type: "actions" as const,
  block_id: blockId,
  elements: elements(actions)
})

/**
 * The `text` of a message with elements and no Markdown, before escaping:
 * the button labels and the select placeholders, joined by a space.
 *
 * @internal
 */
export const labels = (actions: ReadonlyArray<Action>): string =>
  actions.flatMap((action) =>
    action._tag === "Select" ? action.placeholder === undefined ? [] : [action.placeholder] : [action.label]
  ).join(" ")

// Cost

/** The fixed costs of "What `actionsCost` charges". */
const costs = {
  block: 56,
  select: 52,
  placeholder: 59,
  option: 64,
  initialOption: 18,
  button: 95,
  url: 9,
  noValue: 11,
  style: 18,
  separator: 1
} as const

/** One UTF-16 unit as Slack's server writes it in JSON. */
const unitCost = (code: number): number =>
  code < 0x20 || code > 0x7e ? 6 : code === 0x2f || code === 0x22 || code === 0x5c ? 2 : 1

/**
 * A string as Slack's server writes it in JSON: 6 for any unit that is not
 * printable ASCII, 2 for `/`, `"` and `\\`, 1 otherwise. An id, a value,
 * a url and an option label cost this.
 *
 * @internal
 */
export const stringCost = (text: string): number => {
  let cost = 0
  for (let i = 0; i < text.length; i++) cost += unitCost(text.charCodeAt(i))
  return cost
}

/**
 * A button label or a placeholder: `<`, `>` and `&` are stored as
 * entities, and an emoji costs the greater of its `:name:` and its escaped
 * form.
 *
 * @internal
 */
export const labelCost = (text: string): number => {
  let cost = 0
  for (let i = 0; i < text.length;) {
    const emoji = Emoji.longestAt(text, i)
    if (emoji !== undefined) {
      cost += Math.max(emoji.name.length + 2, 6 * emoji.length)
      i += emoji.length
      continue
    }
    const code = text.charCodeAt(i++)
    cost += code === 0x3c || code === 0x3e ? 4 : code === 0x26 ? 5 : unitCost(code)
  }
  return cost
}

const optionCost = (option: SelectOption): number =>
  costs.option + stringCost(option.text.text) + stringCost(option.value)

const elementCost = (element: Element): number => {
  if (element.type === "button") {
    let cost = costs.button + labelCost(element.text.text) + stringCost(element.action_id) +
      stringCost(element.value ?? "")
    if (element.url !== undefined) {
      cost += costs.url + stringCost(element.url) - (element.value === undefined ? costs.noValue : 0)
    }
    return element.style === undefined ? cost : cost + costs.style
  }
  let cost = costs.select + stringCost(element.action_id)
  if (element.placeholder !== undefined) cost += costs.placeholder + labelCost(element.placeholder.text)
  for (const option of element.options) cost += optionCost(option)
  cost += Math.max(0, element.options.length - 1) * costs.separator
  if (element.initial_option !== undefined) cost += costs.initialOption + optionCost(element.initial_option)
  return cost
}

/**
 * An upper bound on the `actions` block's JSON as Slack's server writes it,
 * which the 13,200 cap charges. 0 for no elements.
 *
 * @internal
 */
export const cost = (elements: ReadonlyArray<Element>): number => {
  if (elements.length === 0) return 0
  let total = costs.block + (elements.length - 1) * costs.separator
  for (const element of elements) total += elementCost(element)
  return total
}
