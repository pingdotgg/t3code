/**
 * Typed buttons, selects, modals and slash commands, and the service that
 * receives their clicks, submits and commands.
 *
 * A definition carries an element's id and the schemas of its values. It
 * builds the element to post (`of`, `open`) and gives the typed slot of its
 * handler, the way `Rpc` and `RpcGroup` do. A `group` of definitions becomes a
 * layer of handlers, and `layer` provides the `Handler` service that adapters
 * call.
 *
 * **Example** (A button that opens a modal)
 *
 * ```ts
 * import { Effect, Layer, Schema } from "effect"
 * import { ChatInteraction } from "effect/chat"
 *
 * const Deploy = Schema.Struct({ version: Schema.String })
 *
 * const Reject = ChatInteraction.button("reject", { label: "Reject", style: "danger", value: Deploy })
 * const RejectReason = ChatInteraction.modal("reject-reason", {
 *   title: "Reject deploy",
 *   metadata: Deploy,
 *   fields: {
 *     reason: ChatInteraction.textInput({ label: "Reason", multiline: true })
 *   }
 * })
 *
 * const Interactions = ChatInteraction.group(Reject, RejectReason).toLayer({
 *   reject: (click) => Effect.succeed(RejectReason.open({ metadata: click.value })),
 *   "reject-reason": (submit) =>
 *     submit.values.reason.length < 10
 *       ? Effect.succeed(ChatInteraction.errors({ reason: "Say a bit more." }))
 *       : Effect.succeed(ChatInteraction.close)
 * }).pipe(Layer.provideMerge(ChatInteraction.layer()))
 * ```
 *
 * **Details**
 *
 * - Clicks, submits and commands are not `ChatEvent`s. They need an answer
 *   inside the platform's 3 seconds, so they go to `Handler`, which answers
 *   by return value and has no error channel.
 * - Slack and Discord don't redeliver a click, a submit or a command, so
 *   interactions carry no dedupe key. An adapter whose platform does
 *   redeliver them documents a delivery key of its own.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Context from "../Context.ts"
import type * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Exit from "../Exit.ts"
import * as Fiber from "../Fiber.ts"
import * as Layer from "../Layer.ts"
import * as Option from "../Option.ts"
import * as Schema from "../Schema.ts"
import * as SchemaAST from "../SchemaAST.ts"
import type { Scope } from "../Scope.ts"
import { ChatError, interactionExpired, NotFound } from "./ChatError.ts"
import { ChatThread } from "./ChatThread.ts"
import * as ChatUi from "./ChatUi.ts"

// -----------------------------------------------------------------------------
// events
// -----------------------------------------------------------------------------

const origin = {
  thread: ChatThread,
  messageId: Schema.String,
  userId: Schema.String,
  raw: Schema.Json
}

/**
 * Schema for a click on a button.
 *
 * **Details**
 *
 * - `value` is still encoded, and absent for a button with no value.
 * - `thread` and `messageId` are where the message carrying the button
 *   lives. `raw` is the platform's interaction payload.
 *
 * **Gotchas**
 *
 * On a command's private answer, `messageId` still tells which answer was
 * clicked, but no message op works with it: `edit`, `delete` and
 * `fetchMessage` can't reach a private answer. On Slack `chat.update` on it
 * answered `message_not_found` live, and `edit` fails `NotFound`. On
 * Discord only the interaction's token reaches it, which is from Discord's
 * docs and was not run. Only `raw` tells the two apart: Slack's
 * `container.is_ephemeral`, Discord's `message.flags` with 64.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export const ButtonClicked = Schema.TaggedStruct("ButtonClicked", {
  id: Schema.String,
  value: Schema.optionalKey(Schema.String),
  ...origin
})

/**
 * A click on a button.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export type ButtonClicked = typeof ButtonClicked.Type

/**
 * Schema for a choice in a select on a message. `value` is the chosen
 * option's value, still encoded. `messageId` is as on `ButtonClicked`: on a
 * command's private answer it tells which answer it was, and no message op
 * works with it.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export const SelectChanged = Schema.TaggedStruct("SelectChanged", {
  id: Schema.String,
  value: Schema.String,
  ...origin
})

/**
 * A choice in a select on a message.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export type SelectChanged = typeof SelectChanged.Type

/**
 * Schema for a modal submit.
 *
 * **Details**
 *
 * - `thread` and `messageId` are those of the click that opened the modal.
 *   A modal a command opened carries the command's `thread` and no
 *   `messageId`. A modal opened from a command's private answer carries
 *   that answer's id, which no message op works with, as on
 *   `ButtonClicked`.
 * - `metadata` is still encoded.
 * - `values` are by field id, still encoded. An optional field left empty
 *   has no key.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export const ModalSubmitted = Schema.TaggedStruct("ModalSubmitted", {
  id: Schema.String,
  metadata: Schema.optionalKey(Schema.String),
  values: Schema.Record(Schema.String, Schema.String),
  thread: ChatThread,
  messageId: Schema.optionalKey(Schema.String),
  userId: Schema.String,
  raw: Schema.Json
})

/**
 * A modal submit.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export type ModalSubmitted = typeof ModalSubmitted.Type

/**
 * Schema for a slash command.
 *
 * **Details**
 *
 * - `id` is the command's name, without the slash.
 * - `text` is what was typed after the name, as the platform sent it, and
 *   empty when nothing was. It is not normalised.
 * - `thread` is where the command was typed. On Slack that is always a
 *   channel or a direct: Slack does not deliver an app's command typed in a
 *   thread. There is no `messageId`, since a command comes from no message.
 * - `raw` is the platform's payload. It holds what `Chat.followUp` needs,
 *   so it is a credential for as long as `limits.followUpAge`.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export const CommandInvoked = Schema.TaggedStruct("CommandInvoked", {
  id: Schema.String,
  text: Schema.String,
  thread: ChatThread,
  userId: Schema.String,
  raw: Schema.Json
})

/**
 * A slash command.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export type CommandInvoked = typeof CommandInvoked.Type

/**
 * Schema for what an adapter hands to `Handler`.
 *
 * **Details**
 *
 * Not part of `ChatEvent`: these need an answer inside the platform's 3
 * seconds.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export const Interaction = Schema.Union([ButtonClicked, SelectChanged, ModalSubmitted, CommandInvoked])

/**
 * A click, a select choice, a modal submit or a slash command.
 *
 * @stability unstable
 * @category events
 * @since 4.1.5
 */
export type Interaction = typeof Interaction.Type

// -----------------------------------------------------------------------------
// replies
// -----------------------------------------------------------------------------

/**
 * Schema for the reply that acknowledges a click. It is also what the handler
 * service answers a command with no definition, which the adapter sends
 * nothing for.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Ack = Schema.TaggedStruct("Ack", {})

/**
 * The reply that acknowledges a click.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Ack = typeof Ack.Type

/**
 * Schema for the reply that opens a modal. A click or a command can return
 * it.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const OpenModal = Schema.TaggedStruct("OpenModal", { modal: ChatUi.Modal })

/**
 * The reply that opens a modal.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type OpenModal = typeof OpenModal.Type

/**
 * Schema for the reply that closes a submitted modal.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Close = Schema.TaggedStruct("Close", {})

/**
 * The reply that closes a submitted modal.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Close = typeof Close.Type

/**
 * Schema for the reply that puts a message under each named field of a
 * submitted modal. `errors` is by field id.
 *
 * **Details**
 *
 * With `modalErrors` the modal stays open with the messages under its
 * fields. Without it the adapter answers some other way: on Discord a private
 * reply lists them and the modal closes.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Errors = Schema.TaggedStruct("Errors", {
  errors: Schema.Record(Schema.String, Schema.String)
})

/**
 * The reply that puts a message under each named field.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Errors = typeof Errors.Type

/**
 * What a click's handler may answer.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type ClickReply = Ack | OpenModal

/**
 * What a submit's handler may answer.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type SubmitReply = Close | Errors

/**
 * Schema for who sees the answer to a command: `"ephemeral"` for the person
 * who ran it, `"public"` for the channel.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Visibility = Schema.Literals(["ephemeral", "public"])

/**
 * Who sees the answer to a command.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Visibility = typeof Visibility.Type

/**
 * Schema for the reply that answers a command with a message, at once.
 *
 * **Details**
 *
 * `markdown` and `actions` are rendered and checked the way `post` renders
 * and checks them, with the default post options. `withPostOptions` does
 * not reach it, so it never mentions anyone: on Slack a mention token is
 * escaped and shows as text, and on Discord it renders and notifies nobody.
 * The message gets no id: it cannot be edited, deleted or fetched
 * afterwards. A click on its elements carries a `messageId`, which for a
 * private answer tells which answer it was and works with no message op.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Respond = Schema.TaggedStruct("Respond", {
  markdown: Schema.String,
  actions: Schema.optionalKey(Schema.Array(ChatUi.Action)),
  visibility: Visibility
})

/**
 * The reply that answers a command with a message.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Respond = typeof Respond.Type

/**
 * Schema for the reply that says a command's answer comes later, and the
 * value `Chat.followUp` takes to send it.
 *
 * **Details**
 *
 * - It is plain data, so it can go on a queue to another process.
 * - `visibility` is fixed here. `followUp` has none of its own.
 * - The first `followUp` for it is the answer. A second one is
 *   platform-specific: Slack posts another message, up to five, and Discord
 *   overwrites the first. Neither adapter stops it.
 *
 * **Gotchas**
 *
 * It holds the command's `raw`, which is a credential for as long as
 * `limits.followUpAge`.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Defer = Schema.TaggedStruct("Defer", {
  command: CommandInvoked,
  visibility: Visibility
})

/**
 * The reply that says a command's answer comes later.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Defer = typeof Defer.Type

/**
 * What the handler service may answer a command with.
 *
 * **Details**
 *
 * `Ack` is what a command with no definition gets, and the adapter sends
 * nothing for it. A typed command handler cannot return it.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type CommandReply = Ack | Respond | OpenModal | Defer

/**
 * Schema for what `handle` gives when the handler ran past the deadline.
 *
 * **Gotchas**
 *
 * `Late` is never sent to a platform. It is a tagged struct, so it is itself
 * a JSON value: test for it with `Schema.is(ChatInteraction.Late)`.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const Late = Schema.TaggedStruct("Late", {})

/**
 * What `handle` gives when the handler ran past the deadline.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export type Late = typeof Late.Type

/**
 * `Errors`, with the field ids it names kept in the type, so a typed submit
 * handler can refuse a field the modal does not have. The extra property
 * exists only in the type.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export interface FieldErrors<out Field extends string> extends Errors {
  readonly "~fields"?: Field | undefined
}

/**
 * Acknowledges a click.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const ack: Ack = Ack.make({})

/**
 * Closes a submitted modal.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const close: Close = Close.make({})

/**
 * Puts a message under each named field of a submitted modal.
 *
 * **Details**
 *
 * In a typed submit handler, only the modal's input ids are accepted.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const errors = <const E extends { readonly [field: string]: string }>(
  errors: E
): FieldErrors<keyof E & string> => Errors.make({ errors })

/**
 * Answers a command with a message, at once.
 *
 * **Details**
 *
 * `visibility` defaults to `"ephemeral"`: only the person who ran the
 * command sees it. A platform without `ephemeral` refuses a private answer
 * and sends nothing. It never sends it publicly instead.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const respond = (options: {
  readonly markdown: string
  readonly actions?: ReadonlyArray<ChatUi.Action> | undefined
  readonly visibility?: Visibility | undefined
}): Respond =>
  Respond.make({
    markdown: options.markdown,
    ...optional("actions", options.actions),
    visibility: options.visibility ?? "ephemeral"
  })

/**
 * Answers a command with a promise of a later answer, sent with
 * `Chat.followUp`.
 *
 * **When to use**
 *
 * Use when the work does not fit in the deadline. The handler returns the
 * deferral and hands it to whatever does the work.
 *
 * **Details**
 *
 * - `visibility` defaults to `"ephemeral"`, and holds for the follow-up.
 * - One `Chat.followUp` per deferral is the portable contract. The first
 *   call is the answer. A second is platform-specific: a new message on
 *   Slack, up to five, and an overwrite of the first on Discord.
 *
 * @stability unstable
 * @category replies
 * @since 4.1.5
 */
export const defer = (command: CommandInvoked, options?: {
  readonly visibility?: Visibility | undefined
}): Defer => Defer.make({ command, visibility: options?.visibility ?? "ephemeral" })

// -----------------------------------------------------------------------------
// typed events
// -----------------------------------------------------------------------------

/**
 * A click as a button's handler receives it.
 *
 * **Details**
 *
 * `value` is decoded with the button's value schema, and `undefined` when it
 * has none.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Click<out Value> {
  readonly id: string
  readonly value: Value
  readonly thread: ChatThread
  readonly messageId: string
  readonly userId: string
  readonly raw: Schema.Json
}

/**
 * A choice as a select's handler receives it. `value` is the chosen option,
 * decoded.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Selected<out Value> {
  readonly id: string
  readonly value: Value
  readonly thread: ChatThread
  readonly messageId: string
  readonly userId: string
  readonly raw: Schema.Json
}

/**
 * A submit as a modal's handler receives it, with the metadata and values
 * decoded.
 *
 * **Details**
 *
 * - `values` has one key per input and none for `text`. An optional input
 *   left empty is `undefined`.
 * - `messageId` is the message whose element opened the modal, and
 *   `undefined` when a command opened it.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export interface Submit<out Metadata, out Values> {
  readonly id: string
  readonly metadata: Metadata
  readonly values: Values
  readonly thread: ChatThread
  readonly messageId: string | undefined
  readonly userId: string
  readonly raw: Schema.Json
}

// -----------------------------------------------------------------------------
// values
// -----------------------------------------------------------------------------

/**
 * The type id of definitions and groups.
 *
 * @stability unstable
 * @category type ids
 * @since 4.1.5
 */
export const TypeId = "~effect/chat/ChatInteraction"

/**
 * A value's schema.
 *
 * **Details**
 *
 * It may not need services, because it is encoded inside `of` and `open`,
 * which are plain functions.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ValueSchema = Schema.Codec<any, any, never, never>

type TypeOf<S, Fallback> = S extends ValueSchema ? S["Type"] : Fallback

interface Wire {
  readonly raw: boolean
  readonly encode: (value: unknown) => unknown
  readonly decode: (encoded: unknown) => Option.Option<unknown>
}

const wires = new WeakMap<object, Wire>()

const stringOnly = (ast: SchemaAST.AST): boolean => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return true
    case "Literal":
      return typeof ast.literal === "string"
    case "Union":
      return ast.types.length > 0 && ast.types.every(stringOnly)
    default:
      return false
  }
}

const wireOf = (schema: ValueSchema): Wire => {
  let wire = wires.get(schema)
  if (wire === undefined) {
    const codec = Schema.toCodecJson(schema)
    const decode = Schema.decodeUnknownOption(codec)
    wire = {
      raw: stringOnly(SchemaAST.toEncoded(codec.ast)),
      encode: Schema.encodeUnknownSync(codec),
      decode: (encoded) => {
        try {
          return decode(encoded)
        } catch {
          return Option.none()
        }
      }
    }
    wires.set(schema, wire)
  }
  return wire
}

/**
 * Encodes a value into the string an element carries.
 *
 * **When to use**
 *
 * Use when routing clicks yourself. `of` and `open` already run it.
 *
 * **Details**
 *
 * The value goes through `Schema.toCodecJson`. The form on the wire is decided
 * once per schema, from the codec's encoded side, never per value:
 *
 * - when the encoded side can only be a string (`String`, a brand of it,
 *   string literals, a template literal, or a union of those), the string is
 *   sent as it is
 * - otherwise the encoded value goes through `JSON.stringify`, and back
 *   through `JSON.parse`
 *
 * **Gotchas**
 *
 * Throws when the value has no JSON form, as `Schema.encodeSync` does.
 *
 * @stability unstable
 * @category values
 * @since 4.1.5
 */
export const encodeValue = <S extends ValueSchema>(schema: S, value: S["Type"]): string => {
  const wire = wireOf(schema)
  const encoded = wire.encode(value)
  if (wire.raw) return encoded as string
  const json = JSON.stringify(encoded)
  if (json === undefined) throw new Error("ChatInteraction.encodeValue: the value has no JSON form")
  return json
}

/**
 * Decodes the string an element carried, as `encodeValue` wrote it.
 *
 * **Details**
 *
 * Gives none for a string that no longer decodes, which is what a value
 * posted under an older schema can do.
 *
 * @stability unstable
 * @category values
 * @since 4.1.5
 */
export const decodeValue = <S extends ValueSchema>(schema: S, encoded: string): Option.Option<S["Type"]> => {
  const wire = wireOf(schema)
  if (wire.raw) return wire.decode(encoded)
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return Option.none()
  }
  return wire.decode(parsed)
}

const optional = <K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V }

// -----------------------------------------------------------------------------
// definitions
// -----------------------------------------------------------------------------

/**
 * A button definition.
 *
 * **Details**
 *
 * `of` gives the element to post. It takes the value when the definition has
 * a schema for one, and `overrides` change the label or style of this one
 * element.
 *
 * **Gotchas**
 *
 * `of` throws when the value cannot be encoded (a schema with no JSON form),
 * as `Schema.encodeSync` does.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export interface Button<out Id extends string, out Value extends ValueSchema | undefined = undefined> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "button"
  readonly id: Id
  readonly label: string
  readonly style: ChatUi.ButtonStyle | undefined
  readonly value: Value
  readonly of: (
    ...args: Value extends ValueSchema ? [value: Value["Type"], overrides?: Button.Overrides]
      : [overrides?: Button.Overrides]
  ) => ChatUi.Button
}

/**
 * Types that go with a button definition.
 *
 * @stability unstable
 * @since 4.1.5
 */
export declare namespace Button {
  /**
   * What one element may change from its definition.
   *
   * @stability unstable
   * @category models
   * @since 4.1.5
   */
  export interface Overrides {
    readonly label?: string | undefined
    readonly style?: ChatUi.ButtonStyle | undefined
  }
}

/**
 * Defines a button.
 *
 * **Details**
 *
 * - The id names the handler in a `group`. It is sent to the platform as is,
 *   and counts toward `limits.actionDataLength` with the encoded value.
 * - With no `value` schema the button carries no value, and its click's
 *   `value` is `undefined`.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export const button = <const Id extends string, Value extends ValueSchema | undefined = undefined>(
  id: Id,
  options: {
    readonly label: string
    readonly style?: ChatUi.ButtonStyle | undefined
    readonly value?: Value
  }
): Button<Id, Value> => {
  const value = options.value as Value
  return {
    [TypeId]: TypeId,
    kind: "button",
    id,
    label: options.label,
    style: options.style,
    value,
    of: ((...args: ReadonlyArray<any>): ChatUi.Button => {
      const overrides: Button.Overrides | undefined = value === undefined ? args[0] : args[1]
      return {
        _tag: "Button",
        id,
        label: overrides?.label ?? options.label,
        ...optional("style", overrides?.style ?? options.style),
        ...optional("value", value === undefined ? undefined : encodeValue(value, args[0]))
      }
    }) as Button<Id, Value>["of"]
  }
}

/**
 * A select definition, for a message. Its options are given at the post, to
 * `of`.
 *
 * **Gotchas**
 *
 * `of` throws when an option's value cannot be encoded.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export interface Select<out Id extends string, out Value extends ValueSchema | undefined = undefined> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "select"
  readonly id: Id
  readonly placeholder: string | undefined
  readonly value: Value
  readonly of: (options: {
    readonly options: ReadonlyArray<{ readonly label: string; readonly value: TypeOf<Value, string> }>
    readonly selected?: TypeOf<Value, string> | undefined
  }) => ChatUi.Select
}

/**
 * Defines a single-choice select for a message.
 *
 * **Details**
 *
 * With no `value` schema the options' values are plain strings.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export const select = <const Id extends string, Value extends ValueSchema | undefined = undefined>(
  id: Id,
  options: {
    readonly placeholder?: string | undefined
    readonly value?: Value
  }
): Select<Id, Value> => {
  const value = options.value as Value
  const encode = (option: unknown): string => value === undefined ? option as string : encodeValue(value, option)
  return {
    [TypeId]: TypeId,
    kind: "select",
    id,
    placeholder: options.placeholder,
    value,
    of: (args) => ({
      _tag: "Select",
      id,
      ...optional("placeholder", options.placeholder),
      options: args.options.map((option) => ({ label: option.label, value: encode(option.value) })),
      ...optional("selected", args.selected === undefined ? undefined : encode(args.selected))
    })
  }
}

/**
 * A text input in a modal, one line or several.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export interface TextInput<out Optional extends boolean = false> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "textInput"
  readonly label: string
  readonly multiline: boolean
  readonly placeholder: string | undefined
  readonly optional: Optional
  readonly minLength: number | undefined
  readonly maxLength: number | undefined
}

/**
 * Defines a text input for a modal. Its id is its key in `fields`.
 *
 * **Details**
 *
 * Its value is a `string`, or `string | undefined` when `optional` is true.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export const textInput = <const Optional extends boolean = false>(options: {
  readonly label: string
  readonly multiline?: boolean | undefined
  readonly placeholder?: string | undefined
  readonly optional?: Optional | undefined
  readonly minLength?: number | undefined
  readonly maxLength?: number | undefined
}): TextInput<NoInfer<Optional>> => ({
  [TypeId]: TypeId,
  kind: "textInput",
  label: options.label,
  multiline: options.multiline ?? false,
  placeholder: options.placeholder,
  optional: (options.optional ?? false) as Optional,
  minLength: options.minLength,
  maxLength: options.maxLength
})

/**
 * A select in a modal whose options are fixed in the definition.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export interface Choice<out Value extends string, out Optional extends boolean = false> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "choice"
  readonly label: string
  readonly placeholder: string | undefined
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: Value }>
  readonly optional: Optional
}

/**
 * Defines a select for a modal whose options are fixed here. Its value is the
 * union of the option values.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export const choice = <const Value extends string, const Optional extends boolean = false>(options: {
  readonly label: string
  readonly placeholder?: string | undefined
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: Value }>
  readonly optional?: Optional | undefined
}): Choice<Value, NoInfer<Optional>> => ({
  [TypeId]: TypeId,
  kind: "choice",
  label: options.label,
  placeholder: options.placeholder,
  options: options.options,
  optional: (options.optional ?? false) as Optional
})

/**
 * A select in a modal whose options are given when the modal opens.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export interface SelectInput<
  out Value extends ValueSchema | undefined = undefined,
  out Optional extends boolean = false
> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "selectInput"
  readonly label: string
  readonly placeholder: string | undefined
  readonly value: Value
  readonly optional: Optional
}

/**
 * Defines a select for a modal. Its id is its key in `fields`, and its
 * options are given to the modal's `open`.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export const selectInput = <
  Value extends ValueSchema | undefined = undefined,
  const Optional extends boolean = false
>(options: {
  readonly label: string
  readonly placeholder?: string | undefined
  readonly value?: Value
  readonly optional?: Optional | undefined
}): SelectInput<Value, NoInfer<Optional>> => ({
  [TypeId]: TypeId,
  kind: "selectInput",
  label: options.label,
  placeholder: options.placeholder,
  value: options.value as Value,
  optional: (options.optional ?? false) as Optional
})

/**
 * Plain text between a modal's inputs.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export interface Text {
  readonly [TypeId]: typeof TypeId
  readonly kind: "text"
  readonly text: string
}

/**
 * Defines plain text for a modal. It has no value, so its key is not in
 * `submit.values`.
 *
 * **Gotchas**
 *
 * The text is plain, not Markdown.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export const text = (text: string): Text => ({ [TypeId]: TypeId, kind: "text", text })

/**
 * Any field of a modal.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export type Field = TextInput<boolean> | Choice<string, boolean> | SelectInput<any, boolean> | Text

/**
 * A modal's fields by id, shown in key order.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export interface Fields {
  readonly [id: string]: Field
}

type Maybe<A, Optional extends boolean> = Optional extends true ? A | undefined : A

/**
 * The decoded value of one field.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export type FieldValue<F> = F extends TextInput<infer Optional> ? Maybe<string, Optional>
  : F extends Choice<infer Value, infer Optional> ? Maybe<Value, Optional>
  : F extends SelectInput<infer Value, infer Optional> ? Maybe<TypeOf<Value, string>, Optional>
  : never

/**
 * `submit.values`: one key per input, none for `text`.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export type Values<Fs extends Fields> = {
  readonly [K in keyof Fs as Fs[K] extends Text ? never : K]: FieldValue<Fs[K]>
}

/**
 * The options `open` must be given: one list per `selectInput` field.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export type SelectOptions<Fs extends Fields> = {
  readonly [K in keyof Fs as Fs[K] extends SelectInput<any, any> ? K : never]: Fs[K] extends
    SelectInput<infer Value, any> ? ReadonlyArray<{ readonly label: string; readonly value: TypeOf<Value, string> }>
    : never
}

/**
 * What a modal's `open` takes: the metadata when the modal has a schema for
 * it, the options of each `selectInput`, and initial values.
 *
 * @stability unstable
 * @category fields
 * @since 4.1.5
 */
export type OpenOptions<Metadata extends ValueSchema | undefined, Fs extends Fields> =
  & (Metadata extends ValueSchema ? { readonly metadata: Metadata["Type"] } : {})
  & ({} extends SelectOptions<Fs> ? {} : { readonly options: SelectOptions<Fs> })
  & { readonly initial?: { readonly [K in keyof Values<Fs>]?: Values<Fs>[K] | undefined } | undefined }

/**
 * A modal definition.
 *
 * **Details**
 *
 * `open` gives the reply that opens the modal. A click's or a command's
 * handler can return it.
 *
 * **Gotchas**
 *
 * `open` throws when the metadata or an option's value cannot be encoded.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export interface Modal<
  out Id extends string,
  in out Metadata extends ValueSchema | undefined = undefined,
  in out Fs extends Fields = {}
> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "modal"
  readonly id: Id
  readonly title: string
  readonly submitLabel: string | undefined
  readonly metadata: Metadata
  readonly fields: Fs
  readonly open: (
    ...args: {} extends OpenOptions<Metadata, Fs> ? [options?: OpenOptions<Metadata, Fs>]
      : [options: OpenOptions<Metadata, Fs>]
  ) => OpenModal
}

/**
 * Defines a modal.
 *
 * **Details**
 *
 * - The id names the submit's handler in a `group`. With the encoded
 *   metadata it counts toward `limits.modalMetadataLength`.
 * - Inputs and texts together count toward `limits.modalFields`.
 *
 * **Gotchas**
 *
 * A modal the platform will not take can only fail after the click's or
 * command's handler returned it: the adapter opens nothing and calls
 * `Handler.refused`. A portable modal has a title of 24 or less, labels of 45
 * or less, at most 5 fields, and an id plus metadata under 100 characters.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export const modal = <
  const Id extends string,
  const Fs extends Fields,
  Metadata extends ValueSchema | undefined = undefined
>(
  id: Id,
  options: {
    readonly title: string
    readonly submitLabel?: string | undefined
    readonly metadata?: Metadata
    readonly fields: Fs
  }
): Modal<Id, Metadata, Fs> => {
  const metadata = options.metadata as Metadata
  const open = (args?: {
    readonly metadata?: unknown
    readonly options?: { readonly [id: string]: ReadonlyArray<{ readonly label: string; readonly value: unknown }> }
    readonly initial?: { readonly [id: string]: unknown }
  }): OpenModal => {
    const elements: Array<ChatUi.ModalElement> = []
    for (const [field, definition] of Object.entries(options.fields)) {
      const initial = args?.initial?.[field]
      switch (definition.kind) {
        case "text": {
          elements.push({ _tag: "Text", text: definition.text })
          break
        }
        case "textInput": {
          elements.push({
            _tag: "TextInput",
            id: field,
            label: definition.label,
            ...optional("multiline", definition.multiline ? true : undefined),
            ...optional("placeholder", definition.placeholder),
            ...optional("initial", initial as string | undefined),
            ...optional("optional", definition.optional ? true : undefined),
            ...optional("minLength", definition.minLength),
            ...optional("maxLength", definition.maxLength)
          })
          break
        }
        case "choice":
        case "selectInput": {
          const schema: ValueSchema | undefined = definition.kind === "selectInput" ? definition.value : undefined
          const encode = (value: unknown): string => schema === undefined ? value as string : encodeValue(schema, value)
          const choices = definition.kind === "choice" ? definition.options : args?.options?.[field] ?? []
          elements.push({
            _tag: "SelectInput",
            id: field,
            label: definition.label,
            ...optional("placeholder", definition.placeholder),
            options: choices.map((option) => ({ label: option.label, value: encode(option.value) })),
            ...optional("initial", initial === undefined ? undefined : encode(initial)),
            ...optional("optional", definition.optional ? true : undefined)
          })
          break
        }
      }
    }
    return OpenModal.make({
      modal: {
        _tag: "Modal",
        id,
        title: options.title,
        ...optional("submitLabel", options.submitLabel),
        ...optional("metadata", metadata === undefined ? undefined : encodeValue(metadata, args?.metadata)),
        elements
      }
    })
  }
  return {
    [TypeId]: TypeId,
    kind: "modal",
    id,
    title: options.title,
    submitLabel: options.submitLabel,
    metadata,
    fields: options.fields,
    open: open as Modal<Id, Metadata, Fs>["open"]
  }
}

/**
 * A slash command definition: a name and at most one text argument.
 *
 * **Details**
 *
 * `description` and `argument` are what registration needs. Slack reads its
 * own from the app manifest, so there they are documentation.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export interface Command<out Id extends string> {
  readonly [TypeId]: typeof TypeId
  readonly kind: "command"
  readonly id: Id
  readonly description: string
  readonly argument: {
    readonly name: string
    readonly description: string
    readonly required: boolean
  } | undefined
}

/**
 * Defines a slash command.
 *
 * **Details**
 *
 * - The id is the command's name without the slash. It shares the registry's
 *   id space with buttons, selects and modals.
 * - Slack sends everything typed after the name as one string. Discord gets
 *   one `STRING` option named `argument.name`, and a command with no
 *   `argument` has no options.
 * - `argument.required` defaults to false. Discord's client enforces it.
 *   Slack cannot, so a portable handler still checks for an empty `text`.
 *
 * **Gotchas**
 *
 * A portable name matches `^[a-z0-9_-]{1,31}$` and a portable description is
 * 100 characters or less. Neither is checked here.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export const command = <const Id extends string>(id: Id, options: {
  readonly description: string
  readonly argument?: {
    readonly name: string
    readonly description: string
    readonly required?: boolean | undefined
  } | undefined
}): Command<Id> => ({
  [TypeId]: TypeId,
  kind: "command",
  id,
  description: options.description,
  argument: options.argument === undefined ? undefined : {
    name: options.argument.name,
    description: options.argument.description,
    required: options.argument.required ?? false
  }
})

/**
 * Any definition that has a handler.
 *
 * @stability unstable
 * @category definitions
 * @since 4.1.5
 */
export type Definition = Button<string, any> | Select<string, any> | Modal<string, any, any> | Command<string>

// -----------------------------------------------------------------------------
// decoding
// -----------------------------------------------------------------------------

const matches = (definition: Definition, event: Interaction): boolean => {
  switch (event._tag) {
    case "ButtonClicked":
      return definition.kind === "button"
    case "SelectChanged":
      return definition.kind === "select"
    case "ModalSubmitted":
      return definition.kind === "modal"
    case "CommandInvoked":
      return definition.kind === "command"
  }
}

const decodeSubmit = (definition: Modal<string, any, any>, event: ModalSubmitted): Option.Option<unknown> => {
  let metadata: unknown = undefined
  if (definition.metadata !== undefined) {
    if (event.metadata === undefined) return Option.none()
    const decoded = decodeValue(definition.metadata, event.metadata)
    if (Option.isNone(decoded)) return decoded
    metadata = decoded.value
  }
  const values: Record<string, unknown> = {}
  for (const [id, field] of Object.entries(definition.fields as Fields)) {
    if (field.kind === "text") continue
    const encoded = Object.hasOwn(event.values, id) ? event.values[id] : undefined
    if (encoded === undefined) {
      if (!field.optional) return Option.none()
      values[id] = undefined
      continue
    }
    switch (field.kind) {
      case "textInput": {
        values[id] = encoded
        break
      }
      case "choice": {
        if (!field.options.some((option) => option.value === encoded)) return Option.none()
        values[id] = encoded
        break
      }
      case "selectInput": {
        if (field.value === undefined) {
          values[id] = encoded
          break
        }
        const decoded = decodeValue(field.value, encoded)
        if (Option.isNone(decoded)) return decoded
        values[id] = decoded.value
        break
      }
    }
  }
  return Option.some({ ...base(event), metadata, values })
}

const base = (event: ButtonClicked | SelectChanged | ModalSubmitted) => ({
  id: event.id,
  thread: event.thread,
  messageId: event.messageId,
  userId: event.userId,
  raw: event.raw
})

/** The event as the definition's handler takes it, or none when its value no longer decodes. */
const decodeEvent = (definition: Definition, event: Interaction): Option.Option<unknown> => {
  switch (event._tag) {
    case "ButtonClicked": {
      if (definition.kind !== "button") return Option.none()
      if (definition.value === undefined) return Option.some({ ...base(event), value: undefined })
      if (event.value === undefined) return Option.none()
      return Option.map(decodeValue(definition.value, event.value), (value) => ({ ...base(event), value }))
    }
    case "SelectChanged": {
      if (definition.kind !== "select") return Option.none()
      if (definition.value === undefined) return Option.some({ ...base(event), value: event.value })
      return Option.map(decodeValue(definition.value, event.value), (value) => ({ ...base(event), value }))
    }
    case "ModalSubmitted": {
      return definition.kind === "modal" ? decodeSubmit(definition, event) : Option.none()
    }
    case "CommandInvoked": {
      return definition.kind === "command" ? Option.some(event) : Option.none()
    }
  }
}

const fallback = (event: Interaction): Ack | Close => event._tag === "ModalSubmitted" ? close : ack

// -----------------------------------------------------------------------------
// groups
// -----------------------------------------------------------------------------

/**
 * The handler a definition asks for. None has an error channel.
 *
 * **Details**
 *
 * A button or a select answers `ack` or a modal to open. A modal answers
 * `close` or `errors` naming its own inputs. A command answers `respond`,
 * a modal to open or `defer`, and never `ack`: Discord has no silent answer
 * to a command.
 *
 * @stability unstable
 * @category groups
 * @since 4.1.5
 */
export type HandlerFor<D extends Definition> = D extends Button<any, infer Value>
  ? (click: Click<TypeOf<Value, undefined>>) => Effect.Effect<ClickReply, never, any>
  : D extends Select<any, infer Value> ?
    (selected: Selected<TypeOf<Value, string>>) => Effect.Effect<ClickReply, never, any>
  : D extends Modal<any, infer Metadata, infer Fs> ? (
      submit: Submit<TypeOf<Metadata, undefined>, Values<Fs>>
    ) => Effect.Effect<Close | FieldErrors<keyof Values<Fs> & string>, never, any>
  : D extends Command<any> ? (command: CommandInvoked) => Effect.Effect<Respond | OpenModal | Defer, never, any>
  : never

/**
 * One handler per id in the group.
 *
 * @stability unstable
 * @category groups
 * @since 4.1.5
 */
export type HandlersFrom<D extends Definition> = {
  readonly [Current in D as Current["id"]]: HandlerFor<Current>
}

/**
 * The services a set of handlers needs.
 *
 * @stability unstable
 * @category groups
 * @since 4.1.5
 */
export type HandlersServices<Handlers> = {
  readonly [K in keyof Handlers]: Handlers[K] extends (...args: any) => Effect.Effect<any, any, infer R> ? R : never
}[keyof Handlers]

/**
 * A set of definitions whose handlers are registered together.
 *
 * **Details**
 *
 * - `toLayer` registers the handlers, with their services provided. It needs
 *   the `Registry` that `ChatInteraction.layer` provides.
 * - `of` is the identity, for handlers written away from `toLayer`.
 *
 * **Gotchas**
 *
 * Two definitions with one id, in one group or across groups, are a defect
 * when the layer is built.
 *
 * @stability unstable
 * @category groups
 * @since 4.1.5
 */
export interface Group<in out D extends Definition> {
  readonly [TypeId]: typeof TypeId
  readonly definitions: ReadonlyMap<string, D>
  readonly add: <const More extends ReadonlyArray<Definition>>(...definitions: More) => Group<D | More[number]>
  readonly merge: <const Groups extends ReadonlyArray<Group<any>>>(
    ...groups: Groups
  ) => Group<D | Group.Definitions<Groups[number]>>
  readonly toLayer: <Handlers extends HandlersFrom<D>, EX = never, RX = never>(
    build: Handlers | Effect.Effect<Handlers, EX, RX>
  ) => Layer.Layer<never, EX, Exclude<RX, Scope> | HandlersServices<Handlers> | Registry>
  readonly of: <const Handlers extends HandlersFrom<D>>(handlers: Handlers) => Handlers
}

/**
 * Types that go with a group.
 *
 * @stability unstable
 * @since 4.1.5
 */
export declare namespace Group {
  /**
   * The definitions of a group.
   *
   * @stability unstable
   * @category groups
   * @since 4.1.5
   */
  export type Definitions<G> = G extends Group<infer D> ? D : never
}

const groupLists = new WeakMap<Group<any>, ReadonlyArray<Definition>>()

const makeGroup = <D extends Definition>(list: ReadonlyArray<D>): Group<D> => {
  const self: Group<D> = {
    [TypeId]: TypeId,
    definitions: new Map(list.map((definition) => [definition.id, definition])),
    add: (...definitions) => makeGroup([...list, ...definitions]),
    merge: (...groups) => makeGroup([...list, ...groups.flatMap((group) => groupLists.get(group) ?? [])]) as any,
    toLayer: (build) =>
      Layer.effectDiscard(Effect.gen(function*() {
        const handlers: Record<string, (event: any) => Effect.Effect<ClickReply | SubmitReply | CommandReply>> =
          Effect.isEffect(build)
            ? yield* build
            : build as any
        const context = yield* Effect.context<never>()
        const registry = yield* Registry
        yield* registry.register(list.map((definition): Registered => ({
          definition,
          handle: (event) => {
            const typed = decodeEvent(definition, event)
            return Option.isNone(typed)
              ? Effect.succeed(fallback(event))
              : Effect.provideContext(handlers[definition.id](typed.value), context)
          }
        })))
      })) as any,
    of: (handlers) => handlers
  }
  groupLists.set(self, list)
  return self
}

/**
 * Groups definitions so their handlers can be registered together.
 *
 * @stability unstable
 * @category groups
 * @since 4.1.5
 */
export const group = <const Definitions extends ReadonlyArray<Definition>>(
  ...definitions: Definitions
): Group<Definitions[number]> => makeGroup(definitions)

// -----------------------------------------------------------------------------
// handler service and registry
// -----------------------------------------------------------------------------

/**
 * What an adapter calls with an interaction. Public, for a consumer that
 * routes clicks itself.
 *
 * **Details**
 *
 * - The contract is to answer inside the platform's 3 seconds. There is no
 *   error channel: a handler that cannot do its work still has to answer.
 * - `refused` is called when a click's handler returned `OpenModal` and no
 *   modal opened, after the click was acked: by the adapter (the platform
 *   has no `modals`, the modal's id plus metadata is over
 *   `limits.modalMetadataLength`, it has more than `limits.modalFields`
 *   fields, a title or label is too long, or the platform refused the call)
 *   or by `handle` (the reply came after the deadline).
 * - A command's reply can be refused too: a private answer without
 *   `ephemeral`, an element the platform lacks, an answer over
 *   `limits.messageLength` or an element limit, a modal that cannot open,
 *   or a refusal by the platform. A submit's replies always have an answer
 *   the adapter can give.
 * - `command` answers `Ack` for a command it has no definition for, and the
 *   adapter sends nothing for that. On Discord another library in the same
 *   process can still answer it.
 *
 * **Gotchas**
 *
 * Neither platform redelivers a click or a submit, so there is no dedupe key.
 * A submit can still arrive twice for one modal: a handler that runs past
 * the deadline is interrupted, the platform shows its own error, the modal
 * stays open and the user can submit again. Nothing marks the second one as
 * a repeat, and the first run may have been cut off part way.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class Handler extends Context.Service<Handler, {
  readonly click: (event: ButtonClicked | SelectChanged) => Effect.Effect<ClickReply>
  readonly submit: (event: ModalSubmitted) => Effect.Effect<SubmitReply>
  readonly command: (event: CommandInvoked) => Effect.Effect<CommandReply>
  readonly refused: (
    event: ButtonClicked | SelectChanged | CommandInvoked,
    error: ChatError
  ) => Effect.Effect<void>
}>()("effect/chat/ChatInteraction/Handler") {}

const lateClick = (event: ButtonClicked | SelectChanged) =>
  new ChatError({
    platform: event.thread.platform,
    op: "openModal",
    reason: new NotFound({ detail: interactionExpired })
  })

/**
 * Calls `Handler.click`, `Handler.submit` or `Handler.command` and gives
 * the reply, or `Late` when `deadline` passes first.
 *
 * **When to use**
 *
 * Use to deliver an interaction from an adapter. This is the one place the
 * deadline rule lives. Both adapters and
 * `ChatTest` call it, and a third-party adapter should.
 *
 * **Details**
 *
 * - A late click leaves its handler running, detached from the caller. When
 *   it later returns `OpenModal`, the modal is dropped and `Handler.refused`
 *   is called with a `ChatError` whose reason is `NotFound`, op `openModal`,
 *   detail `interaction_expired`, platform `event.thread.platform`.
 * - A late submit or command interrupts its handler. `Late` is given at the
 *   deadline, without waiting for the handler's finalizers to finish. A
 *   command handler that cannot answer in time returns `defer` first.
 * - `deadline` is the handler's share of the platform's 3 seconds, not the 3
 *   seconds. The adapter subtracts what its own answer costs. This function
 *   knows no platform.
 *
 * **Gotchas**
 *
 * A late click's handler keeps running only if the runtime lets it. One that
 * stops work once the response is sent (Cloudflare Workers without
 * `waitUntil`) kills it.
 *
 * @stability unstable
 * @category handling
 * @since 4.1.5
 */
export const handle: {
  (event: ButtonClicked | SelectChanged, deadline: Duration.Duration): Effect.Effect<ClickReply | Late, never, Handler>
  (event: ModalSubmitted, deadline: Duration.Duration): Effect.Effect<SubmitReply | Late, never, Handler>
  (event: CommandInvoked, deadline: Duration.Duration): Effect.Effect<CommandReply | Late, never, Handler>
  (
    event: Interaction,
    deadline: Duration.Duration
  ): Effect.Effect<ClickReply | SubmitReply | CommandReply | Late, never, Handler>
} = (event: Interaction, deadline: Duration.Duration): Effect.Effect<any, never, Handler> =>
  // Keep startup and the deadline handoff atomic with respect to caller interruption.
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const handler = yield* Handler
      // Detached, so the reply at the deadline waits for neither a late click nor a late submit's cleanup.
      const fiber: Fiber.Fiber<ClickReply | SubmitReply | CommandReply> = yield* Effect.forkDetach(
        event._tag === "ModalSubmitted"
          ? handler.submit(event)
          : event._tag === "CommandInvoked"
          ? handler.command(event)
          : handler.click(event)
      )
      const exit = yield* Effect.onInterrupt(
        restore(Effect.timeoutOption(Fiber.await(fiber), deadline)),
        () => Fiber.interrupt(fiber)
      )
      if (Option.isSome(exit)) return yield* exit.value
      if (event._tag === "ModalSubmitted" || event._tag === "CommandInvoked") {
        // Interrupt without delaying the deadline reply.
        yield* Effect.forkDetach(Fiber.interrupt(fiber))
        return late
      }
      yield* Effect.forkDetach(Effect.flatMap(
        Fiber.await(fiber),
        (exit) =>
          Exit.isSuccess(exit) && exit.value._tag === "OpenModal"
            ? handler.refused(event, lateClick(event))
            : Effect.void
      ))
      return late
    })
  )

const late: Late = Late.make({})

/**
 * One registered definition with its handler, services already provided.
 *
 * **Details**
 *
 * `handle` answers `ack` or `close` without calling the handler when the
 * event does not match the definition or its value no longer decodes. A
 * command that does not match is answered `ack`.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export interface Registered {
  readonly definition: Definition
  readonly handle: (event: Interaction) => Effect.Effect<ClickReply | SubmitReply | CommandReply>
}

/**
 * Where groups put their handlers. `ChatInteraction.layer` provides it.
 *
 * **Details**
 *
 * `register` dies when an id is already registered.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class Registry extends Context.Service<Registry, {
  readonly register: (entries: ReadonlyArray<Registered>) => Effect.Effect<void>
  readonly get: (id: string) => Effect.Effect<Registered | undefined>
}>()("effect/chat/ChatInteraction/Registry") {}

/**
 * Why an interaction reached no handler, or why its handler's reply was not
 * carried out.
 *
 * **Details**
 *
 * - `UnknownId`: no definition has the id, or it is a definition of another
 *   kind.
 * - `InvalidValue`: the value or metadata no longer decodes, or a required
 *   input is missing.
 * - `ReplyRefused`: `Handler.refused` was called, with the adapter's error.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Unhandled =
  | { readonly reason: "UnknownId" | "InvalidValue" }
  | { readonly reason: "ReplyRefused"; readonly error: ChatError }

/**
 * The `Handler` that routes by id to the registered definitions, and an
 * empty `Registry`. Group layers go on top with `Layer.provideMerge`.
 *
 * **Details**
 *
 * - An interaction with an unknown id, or with a value that no longer
 *   decodes, is logged and answered `ack` or `close`. `unhandled` sees it
 *   first. It cannot change the answer.
 * - A command with an unknown id is answered `ack`, which the adapter sends
 *   nothing for, and logged at debug level: on Discord it may belong to
 *   another library in the same process.
 * - `Handler.refused` is routed to `unhandled` too, as `ReplyRefused`, and
 *   logged.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.5
 */
export const layer = <R = never>(options?: {
  readonly unhandled?: ((event: Interaction, why: Unhandled) => Effect.Effect<void, never, R>) | undefined
}): Layer.Layer<Handler | Registry, never, R> =>
  Layer.effectContext(Effect.gen(function*() {
    const context = yield* Effect.context<R>()
    const entries = new Map<string, Registered>()
    const report = (event: Interaction, why: Unhandled, message: string): Effect.Effect<void> =>
      Effect.andThen(
        options?.unhandled === undefined ? Effect.void : Effect.provideContext(options.unhandled(event, why), context),
        (event._tag === "CommandInvoked" && why.reason === "UnknownId"
          ? Effect.logDebug(message)
          : Effect.logWarning(message)).pipe(Effect.annotateLogs({
            "chat.platform": event.thread.platform,
            "chat.interaction.id": event.id,
            "chat.interaction.reason": why.reason
          }))
      )
    const route = (event: Interaction): Effect.Effect<ClickReply | SubmitReply | CommandReply> =>
      Effect.suspend(() => {
        const entry = entries.get(event.id)
        if (entry === undefined || !matches(entry.definition, event)) {
          return Effect.as(
            report(event, { reason: "UnknownId" }, "ChatInteraction: no handler for this id"),
            fallback(event)
          )
        }
        if (Option.isNone(decodeEvent(entry.definition, event))) {
          return Effect.as(
            report(event, { reason: "InvalidValue" }, "ChatInteraction: the value no longer decodes"),
            fallback(event)
          )
        }
        return entry.handle(event)
      })
    const registry = Registry.of({
      register: (registered) =>
        Effect.suspend(() => {
          const ids = new Set<string>()
          for (const entry of registered) {
            const id = entry.definition.id
            if (entries.has(id) || ids.has(id)) {
              return Effect.die(new Error("ChatInteraction: the id \"" + id + "\" is already registered"))
            }
            ids.add(id)
          }
          for (const entry of registered) entries.set(entry.definition.id, entry)
          return Effect.void
        }),
      get: (id) => Effect.sync(() => entries.get(id))
    })
    const handler = Handler.of({
      click: (event) => route(event) as Effect.Effect<ClickReply>,
      submit: (event) => route(event) as Effect.Effect<SubmitReply>,
      command: (event) => route(event) as Effect.Effect<CommandReply>,
      refused: (event, error) =>
        report(event, { reason: "ReplyRefused", error }, "ChatInteraction: the reply was not carried out").pipe(
          Effect.annotateLogs("chat.error", error.message)
        )
    })
    return Context.make(Handler, handler).pipe(Context.add(Registry, registry))
  }))
