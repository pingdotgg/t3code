import type { Capability, ChatError } from "effect/chat/ChatError"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type * as ChatUi from "effect/chat/ChatUi"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import * as Str from "effect/String"
import type { Made } from "./adapter.ts"
import { modalFields, modalMetadataLength } from "./adapter.ts"
import * as Envelope from "./envelope.ts"
import * as Errors from "./errors.ts"
import { locate, threadOf, userId } from "./normalize.ts"
import { isObject, type JsonObject, object, string } from "./parse.ts"
import * as Render from "./render.ts"

/** The default share of Teams' invoke timeout the handler gets. @internal */
export const defaultDeadline = Duration.seconds(4)

/** An answer to an invoke: the HTTP status and the JSON body, if any. @internal */
export interface InvokeResponse {
  readonly status: number
  readonly body?: Schema.Json | undefined
}

const ok: InvokeResponse = { status: 200 }

/** What an invoke that fails a check gets. It names no reason. */
const safeFailure = (name: string): InvokeResponse =>
  name === "adaptiveCard/action"
    ? {
      status: 200,
      body: {
        statusCode: 400,
        type: "application/vnd.microsoft.error",
        value: { code: "BadRequest", message: "This action could not be completed." }
      }
    }
    : { status: 200, body: { task: { type: "message", value: "This action could not be completed." } } }

const executeAck: InvokeResponse = {
  status: 200,
  body: { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: "" }
}

/** @internal */
export interface Options {
  readonly capabilities: ReadonlySet<Capability>
  readonly envelope: Envelope.Envelope | undefined
  /** The ids of the buttons that open a dialog. */
  readonly modalButtons: ReadonlySet<string>
  readonly answer: Made["answer"]
  readonly deadline: Duration.Duration
}

const refused = (event: ChatInteraction.ButtonClicked | ChatInteraction.CommandInvoked, error: ChatError) =>
  Effect.flatMap(ChatInteraction.Handler, (handler) => handler.refused(event, error))

/** The adaptive card of a dialog, built only from the signed definition. */
const dialogCard = (
  modal: ChatUi.Modal,
  token: string,
  submitted?: {
    readonly values: Readonly<Record<string, string>>
    readonly errors: Readonly<Record<string, string>>
  }
) => {
  // A dialog sent again with errors keeps what the user entered, not the
  // definition's `initial`. Lookups are own properties only, so a field id
  // such as `constructor` reads nothing inherited.
  const own = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
    Object.hasOwn(record, key) && typeof record[key] === "string" ? record[key] : undefined
  const valueOf = (element: ChatUi.TextInput | ChatUi.SelectInput) =>
    submitted === undefined ? element.initial : own(submitted.values, element.id)
  const body: Array<unknown> = []
  for (const element of modal.elements) {
    if (element._tag === "Text") {
      body.push(Render.textBlock(Render.escapeText(Str.toWellFormed(element.text))))
      continue
    }
    if (element._tag === "TextInput") {
      body.push({
        type: "Input.Text",
        id: element.id,
        label: element.label,
        isMultiline: element.multiline === true,
        isRequired: element.optional !== true,
        maxLength: element.maxLength ?? Envelope.defaultMaxLength,
        ...(element.placeholder === undefined ? {} : { placeholder: element.placeholder }),
        ...(valueOf(element) === undefined ? {} : { value: valueOf(element) })
      })
    } else {
      body.push({
        type: "Input.ChoiceSet",
        id: element.id,
        label: element.label,
        style: "compact",
        isRequired: element.optional !== true,
        choices: element.options.map((option) => ({ title: option.label, value: option.value })),
        ...(element.placeholder === undefined ? {} : { placeholder: element.placeholder }),
        ...(valueOf(element) === undefined ? {} : { value: valueOf(element) })
      })
    }
    const error = submitted === undefined ? undefined : own(submitted.errors, element.id)
    if (error !== undefined) {
      body.push({ ...Render.textBlock(Render.escapeText(Str.toWellFormed(error))), color: "attention" })
    }
  }
  return {
    task: {
      type: "continue",
      value: {
        title: modal.title,
        card: {
          contentType: Render.cardContentType,
          content: {
            ...Render.card(body),
            actions: [{
              type: "Action.Submit",
              title: modal.submitLabel ?? "Submit",
              data: { [Envelope.reservedKey]: token }
            }]
          }
        }
      }
    }
  }
}

const modalRefusal = (modal: ChatUi.Modal) =>
  modal.elements.length > modalFields
    ? Errors.tooLarge(undefined, "too_many_modal_fields")
    : Envelope.checkModal(modal)

/**
 * One verified invoke, or a card's `Action.Submit` fallback, which comes as
 * a `message` with a `value`.
 *
 * - `adaptiveCard/action` and the fallback are clicks. A click can't open
 *   a dialog there: an `OpenModal` goes to `Handler.refused` as
 *   `Unsupported`.
 * - `task/fetch` is a click on a button named in `modalButtons`, whose
 *   `OpenModal` opens the dialog, signed for the clicking user.
 * - `task/submit` is a dialog submit, checked against its signed
 *   definition.
 * - A token that does not verify, or values that do not match the
 *   definition, get the safe failure and dispatch nothing.
 *
 * @internal
 */
export const invoke = (
  activity: JsonObject,
  options: Options
): Effect.Effect<InvokeResponse, never, ChatInteraction.Handler> =>
  Effect.gen(function*() {
    const name = activity.type === "message" ? "message" : string(activity, "name") ?? ""
    const failure = safeFailure(name)
    const envelope = options.envelope
    if (envelope === undefined || !options.capabilities.has("buttons")) return failure
    const conversationId = string(object(activity, "conversation"), "id")
    const user = userId(object(activity, "from"))
    if (conversationId === undefined || user === undefined) return failure
    const value = object(activity, "value")
    const data = name === "adaptiveCard/action"
      ? object(object(value, "action"), "data")
      : name === "message"
      ? value
      : object(value, "data")
    const token = data?.[Envelope.reservedKey]

    if (name === "task/submit") {
      if (!options.capabilities.has("modals")) return failure
      const dialog = yield* envelope.verifyDialog(token, { conversationId, userId: user })
      if (Option.isNone(dialog)) return failure
      const values = Envelope.validateSubmission(dialog.value.modal, data)
      // The thread of the click that opened it, from the signed conversation
      // id and message, never from the submit.
      const origin = locate(dialog.value.conversationId, dialog.value.messageId)?.thread
      if (Option.isNone(values) || origin === undefined) return failure
      const modal = dialog.value.modal
      const event = ChatInteraction.ModalSubmitted.make({
        id: modal.id,
        ...(modal.metadata === undefined ? {} : { metadata: modal.metadata }),
        values: values.value,
        thread: origin,
        ...(dialog.value.messageId === undefined ? {} : { messageId: dialog.value.messageId }),
        userId: user,
        raw: activity
      })
      const reply = yield* ChatInteraction.handle(event, options.deadline)
      if (reply._tag === "Late") return failure
      if (reply._tag === "Errors") {
        return {
          status: 200,
          body: dialogCard(modal, token as string, { values: values.value, errors: reply.errors }) as Schema.Json
        }
      }
      return ok
    }

    if (name !== "adaptiveCard/action" && name !== "message" && name !== "task/fetch") return failure
    const button = yield* envelope.verifyButton(token, { conversationId })
    const messageId = string(activity, "replyToId")
    // A card posted as a channel post has the channel as its address, as `normalize` gives it.
    const thread = locate(conversationId, messageId)?.thread
    if (Option.isNone(button) || thread === undefined || messageId === undefined) return failure
    const opensDialog = name === "task/fetch"
    if (opensDialog !== options.modalButtons.has(button.value.id)) return failure
    const event = ChatInteraction.ButtonClicked.make({
      id: button.value.id,
      ...(button.value.value === undefined ? {} : { value: button.value.value }),
      thread,
      messageId,
      userId: user,
      raw: activity
    })
    const reply = yield* ChatInteraction.handle(event, options.deadline)
    const acked = name === "adaptiveCard/action" ? executeAck : name === "message" ? ok : failure
    if (reply._tag === "Late" || reply._tag === "Ack") return acked
    if (!opensDialog || !options.capabilities.has("modals")) {
      yield* refused(event, Errors.chatError("openModal", Errors.unsupported("modals")))
      return acked
    }
    const refusal = modalRefusal(reply.modal)
    if (refusal !== undefined) {
      yield* refused(event, Errors.chatError("openModal", refusal))
      return failure
    }
    const signed = yield* Effect.result(
      envelope.signDialog({ conversationId, userId: user, messageId, modal: reply.modal })
    )
    // `modalMetadataLength` holds the whole signed token: the definition,
    // the metadata and every claim. Signing is local, so the check is exact
    // and nothing has opened yet.
    const tooLong = signed._tag === "Success" && signed.success.length > modalMetadataLength
    if (signed._tag === "Failure" || tooLong) {
      const reason = signed._tag === "Failure" ? signed.failure : Errors.tooLarge(undefined, "modal_too_large")
      yield* refused(event, Errors.chatError("openModal", reason))
      return failure
    }
    return { status: 200, body: dialogCard(reply.modal, signed.success) as Schema.Json }
  })

/** Leading `<at>…</at>` tokens, spaces and one slash, before a command's name. */
const commandPrefix = /^(?:\s|<at>[^<]*<\/at>)*\/?/

/**
 * A verified targeted message. Its first word names the command, and the
 * rest is the command's `text`. A message whose first word names no
 * registered command is acked and nothing is sent. Nothing here ever
 * reaches `ChatHandler` or posts in public unless the handler asks.
 *
 * @internal
 */
export const command = (
  activity: JsonObject,
  options: Options & { readonly isRegistered: (id: string) => Effect.Effect<boolean> }
): Effect.Effect<void, never, ChatInteraction.Handler> =>
  Effect.gen(function*() {
    if (!options.capabilities.has("commands")) return
    const text = typeof activity.text === "string" ? activity.text : ""
    const rest = text.replace(commandPrefix, "")
    const match = /^(\S+)\s*([\s\S]*)$/.exec(rest)
    const user = userId(object(activity, "from"))
    const at = threadOf(activity)
    if (match === null || user === undefined || at === undefined) return
    const id = match[1]
    if (!(yield* options.isRegistered(id))) return
    const event = ChatInteraction.CommandInvoked.make({
      id,
      text: match[2],
      thread: at.thread,
      userId: user,
      raw: activity
    })
    const reply = yield* ChatInteraction.handle(event, options.deadline)
    switch (reply._tag) {
      case "Late":
      case "Ack":
      case "Defer":
        return
      case "OpenModal":
        return yield* refused(event, Errors.chatError("openModal", Errors.unsupported("modals")))
      case "Respond":
        return yield* options.answer("respond", activity, {
          markdown: reply.markdown,
          ...(reply.actions === undefined ? {} : { actions: reply.actions })
        }, reply.visibility).pipe(Effect.catch((error) => refused(event, error)))
    }
  })

/** Whether a `message` is a card's `Action.Submit` fallback. @internal */
export const isSubmitFallback = (activity: JsonObject): boolean =>
  activity.type === "message" && isObject(activity.value) && Envelope.reservedKey in activity.value
