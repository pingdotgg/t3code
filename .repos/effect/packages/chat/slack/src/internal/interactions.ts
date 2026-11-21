/**
 * Slack's side of buttons, selects, modals and slash commands: the checks on
 * a message's elements, the view a modal opens as, and the interactivity
 * payloads and command forms.
 */
import {
  type ChatError,
  type ChatErrorReason,
  interactionExpired,
  InvalidRequest,
  NotFound,
  TooLarge
} from "effect/chat/ChatError"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type * as ChatUi from "effect/chat/ChatUi"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SlackWebApi } from "../SlackWebApi.ts"
import * as Actions from "./actions.ts"
import * as Address from "./address.ts"
import * as Errors from "./errors.ts"
import { isObject, type JsonObject, object, setOwn, string } from "./json.ts"
import { codePoints } from "./length.ts"

type Json = Schema.Json

/** @internal */
export const limits = {
  actionsPerMessage: 25,
  actionDataLength: 2_000,
  modalMetadataLength: 2_800,
  modalFields: 100
} as const

/** Slack's limit on an `action_id` and a `callback_id`, in code points. */
const idLength = 255
/** Slack's limit on a modal's title. */
const titleLength = 24
/** Slack's limit on an input's label. */
const labelLength = 2_000

/** The submit label when the modal has none: Slack needs one on a view with inputs. */
const defaultSubmitLabel = "Submit"

/** The handler's share of Slack's 3 seconds. @internal */
export const defaultDeadline = Duration.millis(2_500)

/**
 * Why a message's elements can't go, if they can't: more than 25, an id
 * holding the join or longer than 255, or an id plus a value longer than
 * 2,000. All count code points.
 *
 * @internal
 */
export const checkActions = (actions: ReadonlyArray<ChatUi.Action>): ChatErrorReason | undefined => {
  if (actions.length > limits.actionsPerMessage) return new TooLarge({ detail: "too_many_actions" })
  for (const action of actions) {
    if (action._tag === "LinkButton") continue
    if (action.id.includes(Actions.join)) return new InvalidRequest({ detail: "invalid_action_id" })
    const id = codePoints(action.id)
    if (id > idLength) return new TooLarge({ detail: "action_id_too_long" })
    const values = action._tag === "Button" ? [action.value ?? ""] : action.options.map((option) => option.value)
    if (values.some((value) => id + codePoints(value) > limits.actionDataLength)) {
      return new TooLarge({ detail: "action_data_too_long" })
    }
  }
  return undefined
}

// Modals

/** Marks a `private_metadata` the adapter packed. */
const metadataTag = "chat1"

/** Where a click or a command happened, which a submit gives back. A command has no message. */
interface Origin {
  readonly channel: string
  readonly threadTs?: string | undefined
  readonly messageId?: string | undefined
}

/**
 * Consumer metadata is last so it may contain the join delimiter.
 */
const packMetadata = (origin: Origin, metadata: string | undefined): string =>
  [
    metadataTag,
    origin.channel,
    origin.threadTs ?? "",
    origin.messageId ?? "",
    ...(metadata === undefined ? [] : [metadata])
  ].join(Actions.join)

const unpackMetadata = (
  packed: string
): { readonly origin: Origin; readonly metadata: string | undefined } | undefined => {
  const parts = packed.split(Actions.join)
  if (parts.length < 4 || parts[0] !== metadataTag || parts[1] === "") return undefined
  return {
    origin: {
      channel: parts[1],
      threadTs: parts[2] === "" ? undefined : parts[2],
      messageId: parts[3] === "" ? undefined : parts[3]
    },
    metadata: parts.length === 4 ? undefined : parts.slice(4).join(Actions.join)
  }
}

const inputBlock = (element: ChatUi.TextInput | ChatUi.SelectInput) => ({
  type: "input",
  block_id: element.id,
  label: Actions.plainText(element.label),
  optional: element.optional === true,
  element: element._tag === "TextInput"
    ? {
      type: "plain_text_input",
      action_id: element.id,
      multiline: element.multiline === true,
      ...(element.placeholder === undefined ? {} : { placeholder: Actions.plainText(element.placeholder) }),
      ...(element.initial === undefined ? {} : { initial_value: element.initial }),
      ...(element.minLength === undefined ? {} : { min_length: element.minLength }),
      ...(element.maxLength === undefined ? {} : { max_length: element.maxLength })
    }
    : Actions.elements([{
      _tag: "Select",
      id: element.id,
      options: element.options,
      ...(element.placeholder === undefined ? {} : { placeholder: element.placeholder }),
      ...(element.initial === undefined ? {} : { selected: element.initial })
    }])[0]
})

/**
 * The view that opens `modal` from `from`, or why it can't open.
 *
 * - Inputs are `input` blocks whose `block_id` is the field id, and a
 *   `Text` is a `section` of plain text.
 * - The modal's id is the `callback_id`. `private_metadata` holds the
 *   click's channel, thread and message beside the consumer's metadata. For
 *   a command the message slot is empty.
 * - The modal's id plus its metadata is held to 2,800 code points, the id to
 *   255, the title to 24 and each label to 2,000.
 *
 * @internal
 */
export const view = (
  modal: ChatUi.Modal,
  from: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged | ChatInteraction.CommandInvoked
): { readonly view: Readonly<Record<string, unknown>> } | { readonly refusal: ChatErrorReason } => {
  const refuse = (refusal: ChatErrorReason) => ({ refusal })
  const id = codePoints(modal.id)
  if (id + codePoints(modal.metadata ?? "") > limits.modalMetadataLength) {
    return refuse(new TooLarge({ detail: "modal_metadata_too_long" }))
  }
  if (id > idLength) return refuse(new TooLarge({ detail: "modal_id_too_long" }))
  if (modal.elements.length > limits.modalFields) return refuse(new TooLarge({ detail: "too_many_fields" }))
  if (codePoints(modal.title) > titleLength) return refuse(new TooLarge({ detail: "title_too_long" }))
  const parts = Address.parts(from.thread)
  if (Option.isNone(parts)) return refuse(new InvalidRequest({ detail: "invalid_thread" }))
  const blocks: Array<unknown> = []
  for (const element of modal.elements) {
    if (element._tag === "Text") {
      blocks.push({ type: "section", text: Actions.plainText(element.text) })
      continue
    }
    if (codePoints(element.label) > labelLength) return refuse(new TooLarge({ detail: "label_too_long" }))
    blocks.push(inputBlock(element))
  }
  return {
    view: {
      type: "modal",
      callback_id: modal.id,
      title: Actions.plainText(modal.title),
      submit: Actions.plainText(modal.submitLabel ?? defaultSubmitLabel),
      private_metadata: packMetadata(
        { ...parts.value, messageId: from._tag === "CommandInvoked" ? undefined : from.messageId },
        modal.metadata
      ),
      blocks
    }
  }
}

// Inbound

const isJson = Schema.is(Schema.Json)

/** The payload without its verification `token`. */
const raw = (payload: JsonObject): Json => {
  const { token: _, ...rest } = payload
  return rest
}

const threadOf = (teamId: string, origin: Origin) =>
  Address.thread({
    team: teamId,
    channel: origin.channel,
    threadTs: origin.threadTs === origin.messageId ? undefined : origin.threadTs
  })

const clicked = (payload: JsonObject, teamId: string): Option.Option<ChatInteraction.Interaction> => {
  const actions = payload.actions
  const action = Array.isArray(actions) && actions.length === 1 && isObject(actions[0]) ? actions[0] : undefined
  const id = string(action, "action_id")
  // Only an element in the adapter's own block, and not a link button, whose click carries nothing.
  if (action === undefined || id === undefined || action.block_id !== Actions.blockId || id.startsWith(Actions.join)) {
    return Option.none()
  }
  const container = object(payload, "container")
  const message = object(payload, "message")
  const channel = string(container, "channel_id") ?? string(object(payload, "channel"), "id")
  const messageId = string(container, "message_ts") ?? string(message, "ts")
  const userId = string(object(payload, "user"), "id")
  if (channel === undefined || messageId === undefined || userId === undefined) return Option.none()
  const threadTs = string(message, "thread_ts") ?? string(container, "thread_ts")
  const origin = { thread: threadOf(teamId, { channel, threadTs, messageId }), messageId, userId, raw: raw(payload) }
  if (action.type === "button") {
    const value = typeof action.value === "string" ? action.value : undefined
    return Option.some(ChatInteraction.ButtonClicked.make({ id, ...(value === undefined ? {} : { value }), ...origin }))
  }
  const value = object(action, "selected_option")?.value
  return action.type === "static_select" && typeof value === "string"
    ? Option.some(ChatInteraction.SelectChanged.make({ id, value, ...origin }))
    : Option.none()
}

/** The value of one input in `view.state.values`, or nothing for an empty one. */
const inputValue = (input: Json): string | undefined => {
  if (!isObject(input)) return undefined
  const value = input.type === "static_select" ? object(input, "selected_option")?.value : input.value
  return typeof value === "string" && value !== "" ? value : undefined
}

const submitted = (payload: JsonObject, teamId: string): Option.Option<ChatInteraction.Interaction> => {
  const view = object(payload, "view")
  const id = string(view, "callback_id")
  const packed = string(view, "private_metadata")
  const unpacked = packed === undefined ? undefined : unpackMetadata(packed)
  const userId = string(object(payload, "user"), "id")
  if (id === undefined || unpacked === undefined || userId === undefined) return Option.none()
  const values: Record<string, string> = {}
  const state = object(object(view, "state"), "values") ?? {}
  for (const blockId of Object.keys(state)) {
    const inputs = object(state, blockId)
    if (inputs === undefined) continue
    for (const input of Object.values(inputs)) {
      const value = inputValue(input)
      if (value !== undefined) setOwn(values, blockId, value)
    }
  }
  const { metadata, origin } = unpacked
  return Option.some(ChatInteraction.ModalSubmitted.make({
    id,
    ...(metadata === undefined ? {} : { metadata }),
    values,
    thread: threadOf(teamId, origin),
    ...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
    userId,
    raw: raw(payload)
  }))
}

/** Whether `payload` is a slash command's fields: a `command` and no `type`. @internal */
export const isCommand = (payload: unknown): boolean =>
  isObject(payload) && payload.type === undefined && typeof payload.command === "string"

const invoked = (payload: JsonObject, teamId: string): Option.Option<ChatInteraction.Interaction> => {
  const command = string(payload, "command")
  const channel = string(payload, "channel_id")
  const userId = string(payload, "user_id")
  const id = command?.startsWith("/") === true ? command.slice(1) : command
  if (id === undefined || id === "" || channel === undefined || userId === undefined) return Option.none()
  const text = typeof payload.text === "string" ? payload.text : ""
  return Option.some(ChatInteraction.CommandInvoked.make({
    id,
    text,
    // A command can't be typed in a thread, so its address is the channel's.
    thread: Address.thread({ team: teamId, channel }),
    userId,
    raw: raw(payload)
  }))
}

/**
 * The interaction a decoded `payload` is: a click on a button or select in
 * an `actions` block the adapter built, a submit of a view it opened, or a
 * slash command's fields. Anything else, a link button's click and a value
 * that is not JSON included, is none.
 *
 * @internal
 */
export const normalize = (
  payload: unknown,
  context: { readonly teamId: string }
): Option.Option<ChatInteraction.Interaction> => {
  if (!isObject(payload) || !isJson(payload)) return Option.none()
  if (payload.type === "block_actions") return clicked(payload, context.teamId)
  if (payload.type === "view_submission") return submitted(payload, context.teamId)
  if (isCommand(payload)) return invoked(payload, context.teamId)
  return Option.none()
}

/** A trigger past its 3 seconds is the same refusal `handle` gives a late click. */
const expired = (error: ChatError): ChatError =>
  error.reason.detail === "expired_trigger_id"
    ? Errors.chatError("openModal", new NotFound({ detail: interactionExpired, cause: error.reason }))
    : error

/**
 * `SlackChat.interaction`: normalises, calls the handler through
 * `ChatInteraction.handle` and gives the body to answer with.
 *
 * - An ack, a close, a late click, a deferral and a payload that is not the
 *   adapter's give `undefined`, an empty answer.
 * - `errors` gives `response_action: "errors"`, keyed by field id.
 * - A late submit or command gives `Late`.
 * - `OpenModal` calls `views.open` with the click's or command's
 *   `trigger_id` before answering. A modal that can't be built, or that
 *   Slack refuses, goes to `Handler.refused`, and the click is still acked.
 * - `Respond` gives the message as the body, with its `response_type`. One
 *   that fails the checks of a `post` goes to `Handler.refused` and gives
 *   an empty answer.
 *
 * @internal
 */
export const make = (options: {
  readonly api: SlackWebApi["Service"]
  readonly teamId: string
  readonly answer: (
    op: string,
    content: { readonly markdown: string; readonly actions?: ReadonlyArray<ChatUi.Action> | undefined },
    visibility: ChatInteraction.Visibility
  ) => Effect.Effect<Readonly<Record<string, unknown>>, ChatError>
}) =>
(
  payload: unknown,
  interactionOptions?: { readonly deadline?: Duration.Duration | undefined }
): Effect.Effect<Json | undefined | ChatInteraction.Late, never, ChatInteraction.Handler> =>
  Effect.gen(function*() {
    const event = normalize(payload, { teamId: options.teamId })
    if (Option.isNone(event)) return undefined
    const reply = yield* ChatInteraction.handle(event.value, interactionOptions?.deadline ?? defaultDeadline)
    switch (reply._tag) {
      case "Late":
        // A late click is acked: its handler runs on and `handle` refuses a modal it opens.
        return event.value._tag === "ButtonClicked" || event.value._tag === "SelectChanged" ? undefined : reply
      case "Ack":
      case "Close":
      case "Defer":
        return undefined
      case "Errors":
        return { response_action: "errors", errors: reply.errors }
      case "Respond": {
        const command = event.value as ChatInteraction.CommandInvoked
        const handler = yield* ChatInteraction.Handler
        return yield* options.answer("respond", reply, reply.visibility).pipe(
          // The body is a post's, which is JSON.
          Effect.map((body): Json | undefined => body as Json),
          Effect.catch((error) => Effect.as(handler.refused(command, error), undefined))
        )
      }
      case "OpenModal": {
        const click = event.value as
          | ChatInteraction.ButtonClicked
          | ChatInteraction.SelectChanged
          | ChatInteraction.CommandInvoked
        const handler = yield* ChatInteraction.Handler
        const built = view(reply.modal, click)
        if ("refusal" in built) {
          yield* handler.refused(click, Errors.chatError("openModal", built.refusal))
          return undefined
        }
        const triggerId = string(payload, "trigger_id")
        if (triggerId === undefined) {
          yield* handler.refused(click, Errors.chatError("openModal", new InvalidRequest({ detail: "no_trigger_id" })))
          return undefined
        }
        yield* options.api.call("views.open", { trigger_id: triggerId, view: built.view }, {
          write: true,
          retry: false
        })
          .pipe(
            Effect.mapError(Errors.withOp("openModal")),
            Effect.catch((error) => handler.refused(click, expired(error)))
          )
        return undefined
      }
    }
  })
