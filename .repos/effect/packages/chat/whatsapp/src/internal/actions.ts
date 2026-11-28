import { type ChatErrorReason, InvalidRequest, TooLarge } from "effect/chat/ChatError"
import type { Action, Button, LinkButton, Select } from "effect/chat/ChatUi"
import type { WhatsAppPostOptions } from "../WhatsAppChat.ts"
import { defaultButtonsSection, defaultListButton } from "./options.ts"
import { shortBodyLength, utf8Bytes } from "./text.ts"

/** Between an element's id and its value in a wire id. @internal */
export const join = "\u241F"

/** @internal */
export const limits = { actionsPerMessage: 10, actionDataLength: 198 } as const

/** Meta counts a reply button's id in UTF-8 bytes, unlike every other limit. */
const replyIdBytes = 256
const replyLabelLength = 20
const rowTitleLength = 24
const listButtonLength = 20
const sectionTitleLength = 24
const maxRows = 10

/** What the measure adds for a layout whose body is held to 1,024 rather than 4,096. @internal */
export const shortBodyOffset = 4096 - shortBodyLength

/** @internal */
export type Kind = "none" | "reply" | "cta" | "list"

/** @internal */
export interface Shape {
  readonly kind: Kind
  /** The link buttons that go as `Label: url` lines after the body. */
  readonly appended: ReadonlyArray<LinkButton>
}

/** The layout of a message's actions, which depends on the actions alone. @internal */
export const shape = (actions: ReadonlyArray<Action>): Shape => {
  const buttons = actions.filter((action): action is Button => action._tag === "Button")
  const links = actions.filter((action): action is LinkButton => action._tag === "LinkButton")
  const selects = actions.filter((action) => action._tag === "Select")
  if (buttons.length === 0 && selects.length === 0) {
    return links.length === 1 && links[0].label.length <= replyLabelLength
      ? { kind: "cta", appended: [] }
      : { kind: "none", appended: links }
  }
  const reply = selects.length === 0 && buttons.length <= 3 &&
    buttons.every((button) => button.label.length <= replyLabelLength)
  return { kind: reply ? "reply" : "list", appended: links }
}

/** The body of a post with actions and no Markdown: the labels joined by ", ". @internal */
export const generatedBody = (actions: ReadonlyArray<Action>): string =>
  actions.map((action) =>
    action._tag === "Select"
      ? action.placeholder ?? action.options.map((option) => option.label).join(", ")
      : action.label
  ).join(", ")

/** @internal */
export const linkLines = (links: ReadonlyArray<LinkButton>): string =>
  links.map((link) => link.label + ": " + link.url).join("\n")

/**
 * What a message's actions add to the measure of its Markdown: the offset of
 * a 1,024 body, the appended link lines with their separator, and the
 * generated body, which is always counted.
 *
 * @internal
 */
export const measure = (actions: ReadonlyArray<Action>): number => {
  if (actions.length === 0) return 0
  const { appended, kind } = shape(actions)
  return (kind === "reply" || kind === "cta" ? shortBodyOffset : 0) + generatedBody(actions).length +
    (appended.length === 0 ? 0 : 2 + linkLines(appended).length)
}

/** The body as sent: the rendered Markdown, or the generated body, then the link lines. @internal */
export const body = (rendered: string, actions: ReadonlyArray<Action>): string => {
  const { appended, kind } = shape(actions)
  const base = rendered.trim() !== "" ? rendered : kind === "none" ? "" : generatedBody(actions)
  const lines = linkLines(appended)
  return base === "" ? lines : lines === "" ? base : base + "\n\n" + lines
}

/** @internal */
export const buttonWireId = (button: Button): string =>
  "b" + button.id + (button.value === undefined ? "" : join + button.value)

/** @internal */
export const optionWireId = (select: Select, value: string): string => "s" + select.id + join + value

/** A wire id read back: the tag, then the id and value split at the first U+241F. @internal */
export const parseWireId = (
  wire: string
): { readonly kind: "button"; readonly id: string; readonly value?: string } | {
  readonly kind: "select"
  readonly id: string
  readonly value: string
} | undefined => {
  const rest = wire.slice(1)
  const at = rest.indexOf(join)
  if (wire[0] === "b") {
    return at < 0
      ? { kind: "button", id: rest }
      : { kind: "button", id: rest.slice(0, at), value: rest.slice(at + 1) }
  }
  if (wire[0] === "s" && at >= 0) return { kind: "select", id: rest.slice(0, at), value: rest.slice(at + 1) }
  return undefined
}

/** The `interactive` object of a message, less its body and header. @internal */
export type Interactive =
  | { readonly type: "button"; readonly action: unknown }
  | { readonly type: "cta_url"; readonly action: unknown }
  | { readonly type: "list"; readonly action: unknown }

/** @internal */
export interface Plan {
  readonly kind: Kind
  readonly interactive?: Interactive | undefined
}

const tooLarge = (detail: string) => new TooLarge({ detail })
const invalid = (detail: string) => new InvalidRequest({ detail })

/**
 * Checks a message's actions and builds their `interactive` object. Every
 * refusal is found here, before any call.
 *
 * @internal
 */
export const plan = (actions: ReadonlyArray<Action>, options: WhatsAppPostOptions): Plan | ChatErrorReason => {
  if (actions.length === 0) return { kind: "none" }
  if (actions.length > limits.actionsPerMessage) return tooLarge("too_many_actions")
  for (const action of actions) {
    if (action._tag === "LinkButton") {
      if (action.label.length > rowTitleLength) return tooLarge("label_too_long")
      continue
    }
    if (action.id.includes(join)) return invalid("invalid_action_id")
    if (action._tag === "Button") {
      if (action.id.length + (action.value?.length ?? 0) > limits.actionDataLength) {
        return tooLarge("action_data_too_long")
      }
    } else {
      if (action.options.length === 0) return invalid("empty_select")
      for (const option of action.options) {
        if (action.id.length + option.value.length > limits.actionDataLength) return tooLarge("action_data_too_long")
      }
    }
  }
  const { kind } = shape(actions)
  const buttons = actions.filter((action): action is Button => action._tag === "Button")
  const selects = actions.filter((action): action is Select => action._tag === "Select")
  const unique = (ids: ReadonlyArray<string>) => new Set(ids).size === ids.length
  switch (kind) {
    case "none":
      return { kind }
    case "cta": {
      const link = actions.find((action): action is LinkButton => action._tag === "LinkButton")!
      return {
        kind,
        interactive: {
          type: "cta_url",
          action: { name: "cta_url", parameters: { display_text: link.label, url: link.url } }
        }
      }
    }
    case "reply": {
      const ids = buttons.map(buttonWireId)
      if (!unique(buttons.map((button) => button.label))) return invalid("duplicate_label")
      if (!unique(ids)) return invalid("duplicate_id")
      if (ids.some((id) => utf8Bytes(id) > replyIdBytes)) return tooLarge("action_data_too_long")
      return {
        kind,
        interactive: {
          type: "button",
          action: {
            buttons: buttons.map((button, i) => ({ type: "reply", reply: { id: ids[i], title: button.label } }))
          }
        }
      }
    }
    case "list": {
      const sections: Array<
        { readonly title: string; readonly rows: Array<{ readonly id: string; readonly title: string }> }
      > = []
      const listButton = options.listButton ?? defaultListButton
      if (buttons.length > 0) {
        sections.push({
          title: options.buttonsSection ?? defaultButtonsSection,
          rows: buttons.map((button) => ({ id: buttonWireId(button), title: button.label }))
        })
      }
      for (const select of selects) {
        sections.push({
          title: select.placeholder ?? listButton,
          rows: select.options.map((option) => ({ id: optionWireId(select, option.value), title: option.label }))
        })
      }
      const rows = sections.flatMap((section) => section.rows)
      if (rows.length > maxRows) return tooLarge("list_rows")
      if (rows.some((row) => row.title.length > rowTitleLength)) return tooLarge("label_too_long")
      if (!unique(rows.map((row) => row.id))) return invalid("duplicate_id")
      const opener = selects.find((select) => select.placeholder !== undefined)?.placeholder ?? listButton
      if (opener.length > listButtonLength) return tooLarge("label_too_long")
      if (sections.length > 1 && sections.some((section) => section.title.length > sectionTitleLength)) {
        return tooLarge("label_too_long")
      }
      return {
        kind,
        interactive: {
          type: "list",
          action: {
            button: opener,
            sections: sections.map((section) => sections.length > 1 ? section : { rows: section.rows })
          }
        }
      }
    }
  }
}
