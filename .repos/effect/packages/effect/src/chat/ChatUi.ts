/**
 * The plain elements of buttons, selects and modals.
 *
 * These are what goes on the wire, into `ChatTest` and into storage. Every
 * element is a Schema tagged struct and every value in one is already a
 * string. `ChatInteraction` holds the typed definitions that build them and
 * receive their clicks. A consumer that routes clicks itself builds them with
 * each schema's own `make`.
 *
 * **Details**
 *
 * - `post` and `edit` take a flat list of `Action`s beside the Markdown,
 *   and the adapter lays out the rows.
 * - Text in a modal is plain, not Markdown, because a Slack modal cannot hold
 *   a `markdown` block.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Schema from "../Schema.ts"

/**
 * Schema for the style of a button.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ButtonStyle = Schema.Literals(["default", "primary", "danger"])

/**
 * The style of a button.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ButtonStyle = typeof ButtonStyle.Type

/**
 * Schema for a button on a message.
 *
 * **Details**
 *
 * `value` is the encoded value, absent when the definition has no value
 * schema.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Button = Schema.TaggedStruct("Button", {
  id: Schema.String,
  label: Schema.String,
  style: Schema.optionalKey(ButtonStyle),
  value: Schema.optionalKey(Schema.String)
})

/**
 * A button on a message.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Button = typeof Button.Type

/**
 * Schema for a button that opens a URL.
 *
 * **Details**
 *
 * It produces no click, so it has no id and no handler.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const LinkButton = Schema.TaggedStruct("LinkButton", {
  label: Schema.String,
  url: Schema.String
})

/**
 * A button that opens a URL.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type LinkButton = typeof LinkButton.Type

/**
 * Schema for one option of a select. `value` is the encoded value.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String
})

/**
 * One option of a select.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type SelectOption = typeof SelectOption.Type

/**
 * Schema for a single-choice select on a message.
 *
 * **Details**
 *
 * `selected` is the `value` of the option shown as chosen.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Select = Schema.TaggedStruct("Select", {
  id: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
  options: Schema.Array(SelectOption),
  selected: Schema.optionalKey(Schema.String)
})

/**
 * A single-choice select on a message.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Select = typeof Select.Type

/**
 * Schema for what `post` and `edit` take in `actions`.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Action = Schema.Union([Button, LinkButton, Select])

/**
 * What `post` and `edit` take in `actions`: a button, a link button or a
 * select.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Action = typeof Action.Type

/**
 * Schema for a text input in a modal, one line or several.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const TextInput = Schema.TaggedStruct("TextInput", {
  id: Schema.String,
  label: Schema.String,
  multiline: Schema.optionalKey(Schema.Boolean),
  placeholder: Schema.optionalKey(Schema.String),
  initial: Schema.optionalKey(Schema.String),
  optional: Schema.optionalKey(Schema.Boolean),
  minLength: Schema.optionalKey(Schema.Int),
  maxLength: Schema.optionalKey(Schema.Int)
})

/**
 * A text input in a modal.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type TextInput = typeof TextInput.Type

/**
 * Schema for a single-choice select in a modal.
 *
 * **Details**
 *
 * Both `ChatInteraction.choice` and `ChatInteraction.selectInput` fields
 * become this. `initial` is the `value` of the option chosen when the modal
 * opens.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const SelectInput = Schema.TaggedStruct("SelectInput", {
  id: Schema.String,
  label: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
  options: Schema.Array(SelectOption),
  initial: Schema.optionalKey(Schema.String),
  optional: Schema.optionalKey(Schema.Boolean)
})

/**
 * A single-choice select in a modal.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type SelectInput = typeof SelectInput.Type

/**
 * Schema for plain text in a modal.
 *
 * **Details**
 *
 * Not Markdown: a Slack modal cannot hold a `markdown` block.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Text = Schema.TaggedStruct("Text", {
  text: Schema.String
})

/**
 * Plain text in a modal.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Text = typeof Text.Type

/**
 * Schema for one element of a modal.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ModalElement = Schema.Union([TextInput, SelectInput, Text])

/**
 * One element of a modal: a text input, a select or plain text.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ModalElement = typeof ModalElement.Type

/**
 * Schema for a modal.
 *
 * **Details**
 *
 * - `metadata` is the consumer's encoded metadata. The adapter adds the
 *   thread and message of the click that opened the modal beside it.
 * - The elements are shown in order.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Modal = Schema.TaggedStruct("Modal", {
  id: Schema.String,
  title: Schema.String,
  submitLabel: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.String),
  elements: Schema.Array(ModalElement)
})

/**
 * A modal.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Modal = typeof Modal.Type

/**
 * Creates a button that opens a URL.
 *
 * **When to use**
 *
 * Use to put a link beside the buttons of a message. It is the one element
 * with no definition in `ChatInteraction`, since it produces no click.
 *
 * **Example** (Posting a link button)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { Chat, ChatThread, ChatUi } from "effect/chat"
 *
 * const program = Effect.gen(function*() {
 *   const chat = yield* Chat.Chat
 *   yield* chat.post(ChatThread.make("slack", "T1/C1"), {
 *     markdown: "The diff is ready.",
 *     actions: [ChatUi.linkButton({ label: "Diff", url: "https://example.com/diff" })]
 *   })
 * })
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const linkButton = (options: {
  readonly label: string
  readonly url: string
}): LinkButton => LinkButton.make({ label: options.label, url: options.url })
