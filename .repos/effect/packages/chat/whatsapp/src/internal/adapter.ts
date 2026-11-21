import { type ChatAdapter, checkMessageLength, type Descriptor, type File, type Posted } from "effect/chat/ChatAdapter"
import {
  type ChatError,
  type ChatErrorReason,
  fileRefused,
  InvalidRequest,
  TooLarge,
  Unsupported
} from "effect/chat/ChatError"
import type { ChatThread } from "effect/chat/ChatThread"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Template } from "../WhatsAppChat.ts"
import type { WhatsAppGraphApi } from "../WhatsAppGraphApi.ts"
import * as Actions from "./actions.ts"
import * as Address from "./address.ts"
import * as Errors from "./errors.ts"
import { isObject, type JsonObject, string } from "./normalize.ts"
import { CurrentPostOptions } from "./options.ts"
import * as Text from "./text.ts"

/** @internal */
export const descriptor: Descriptor = {
  platform: Address.platform,
  capabilities: new Set(["replyTo", "files", "download", "getThread", "opener", "buttons", "selects"]),
  measure: (markdown, actions) => Text.measure(markdown) + Actions.measure(actions ?? []),
  limits: {
    messageLength: Text.messageLength,
    filesPerMessage: 1,
    uploadBytes: 100 * 1024 * 1024,
    minWriteInterval: Duration.seconds(6),
    ...Actions.limits
  }
}

type MediaType = "image" | "video" | "audio" | "document"

const megabytes = (n: number) => n * 1024 * 1024

const image = { type: "image", maxBytes: megabytes(5) } as const
const video = { type: "video", maxBytes: megabytes(16) } as const
const audio = { type: "audio", maxBytes: megabytes(16) } as const
const doc = { type: "document", maxBytes: megabytes(100) } as const

/** Meta's supported media, by MIME type, with the largest upload of each. */
const mediaTypes: Record<string, { readonly type: MediaType; readonly maxBytes: number }> = {
  "image/jpeg": image,
  "image/png": image,
  "video/mp4": video,
  "video/3gpp": video,
  "audio/aac": audio,
  "audio/amr": audio,
  "audio/mpeg": audio,
  "audio/mp4": audio,
  "audio/ogg": audio,
  "text/plain": doc,
  "application/pdf": doc,
  "application/msword": doc,
  "application/vnd.ms-excel": doc,
  "application/vnd.ms-powerpoint": doc,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": doc,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": doc,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": doc
}

/** The MIME type a file is uploaded as: without parameters, and `text/markdown` as `text/plain`. @internal */
export const uploadType = (contentType: string): string => {
  const base = contentType.split(";")[0].trim().toLowerCase()
  return base === "text/markdown" ? "text/plain" : base
}

const refused = new TooLarge({ subject: "files", detail: fileRefused })

/** @internal */
export const make = (options: {
  readonly graph: WhatsAppGraphApi["Service"]
  readonly http: HttpClient.HttpClient
  readonly accessToken: Redacted.Redacted
  readonly phoneNumberId: string
  readonly messagingAccountId?: string | undefined
}) => {
  const { graph, phoneNumberId } = options
  const account = options.messagingAccountId === undefined ? {} : { messaging_account_id: options.messagingAccountId }

  const fail = (op: string, reason: ChatErrorReason) => Effect.fail(Errors.chatError(op, reason))

  const withOp = (op: string) => (error: ChatError) => Errors.chatError(op, error.reason)

  const unsupported = (op: string, capability: Unsupported["capability"]) => fail(op, new Unsupported({ capability }))

  /** The user of a thread this adapter can write to. */
  const resolve = (op: string, thread: ChatThread): Effect.Effect<string, ChatError> => {
    const parts = Address.parts(thread)
    if (Option.isNone(parts)) return fail(op, new InvalidRequest({ detail: "invalid_thread" }))
    if (parts.value.kind === "group") return fail(op, new InvalidRequest({ detail: "group_unsupported" }))
    if (parts.value.phoneNumberId !== phoneNumberId) {
      return fail(op, new InvalidRequest({ detail: "other_phone_number" }))
    }
    return Effect.succeed(parts.value.id)
  }

  const recipient = (user: string) => Address.isBsuid(user) ? { recipient: user } : { to: user }

  const send = Effect.fnUntraced(function*(op: string, thread: ChatThread, user: string, message: JsonObject) {
    const answer = yield* graph.call(`${phoneNumberId}/messages`, {
      body: { messaging_product: "whatsapp", recipient_type: "individual", ...account, ...recipient(user), ...message },
      write: true
    }).pipe(Effect.mapError(withOp(op)))
    const messages = isObject(answer) && Array.isArray(answer.messages) ? answer.messages : []
    const id = string(messages[0], "id")
    if (id === undefined) return yield* fail(op, Errors.invalidResponse(true, "missing_message_id"))
    const timestamp = yield* DateTime.now
    return { id, thread, timestamp } satisfies Posted
  })

  /** The checks on a file, before anything is sent: its media type, or the refusal. */
  const checkFile = (
    files: ReadonlyArray<File>,
    caption: string,
    plan: Actions.Plan
  ): ChatErrorReason | { readonly file: File; readonly mime: string; readonly type: MediaType } => {
    if (files.length > 1) return refused
    const file = files[0]
    const mime = uploadType(file.contentType)
    const media = Object.hasOwn(mediaTypes, mime) ? mediaTypes[mime] : undefined
    if (media === undefined || file.content.length > media.maxBytes) return refused
    if (plan.kind === "list") return refused
    if (media.type === "audio" && (caption.trim() !== "" || plan.kind !== "none")) return refused
    if (caption.length > Text.shortBodyLength) return refused
    return { file, mime, type: media.type }
  }

  const upload = (op: string, file: File, mime: string): Effect.Effect<string, ChatError> => {
    const form = new FormData()
    form.append("messaging_product", "whatsapp")
    form.append("type", mime)
    form.append("file", new Blob([file.content as Uint8Array<ArrayBuffer>], { type: mime }), file.name)
    return graph.call(`${phoneNumberId}/media`, { form }).pipe(
      // Meta refusing the file itself is a file refusal: nothing was sent, so the text can go without it.
      Effect.mapError((error) =>
        Errors.chatError(
          op,
          error.reason._tag === "TooLarge" || error.reason._tag === "InvalidRequest"
            ? new TooLarge({ subject: "files", detail: fileRefused, cause: error.reason })
            : error.reason
        )
      ),
      Effect.flatMap((answer) => {
        const id = string(answer, "id")
        return id === undefined ? fail(op, Errors.invalidResponse(false, "missing_media_id")) : Effect.succeed(id)
      })
    )
  }

  const post: ChatAdapter["post"] = Effect.fnUntraced(function*(thread, content) {
    const op = "post"
    const user = yield* resolve(op, thread)
    const actions = content.actions ?? []
    const postOptions = yield* CurrentPostOptions
    const plan = Actions.plan(actions, postOptions)
    if (!("kind" in plan)) return yield* fail(op, plan)
    yield* checkMessageLength(descriptor, op, content.markdown, actions)
    const text = Actions.body(Text.render(content.markdown), actions)
    const files = content.files ?? []
    const context = content.replyTo === undefined ? {} : { context: { message_id: content.replyTo.messageId } }
    let header: JsonObject | undefined
    if (files.length > 0) {
      const checked = checkFile(files, text, plan)
      if (!("file" in checked)) return yield* fail(op, checked)
      const { file, mime, type } = checked
      const id = yield* upload(op, file, mime)
      const media: JsonObject = type === "document" ? { id, filename: file.name } : { id }
      if (plan.interactive === undefined) {
        const caption = type === "audio" || text.trim() === "" ? {} : { caption: text }
        return yield* send(op, thread, user, { ...context, type, [type]: { ...media, ...caption } })
      }
      header = { type, [type]: media }
    }
    if (plan.interactive !== undefined) {
      return yield* send(op, thread, user, {
        ...context,
        type: "interactive",
        interactive: {
          type: plan.interactive.type,
          ...(header === undefined ? {} : { header }),
          body: { text },
          action: plan.interactive.action as Schema.Json
        }
      })
    }
    if (text.trim() === "") return yield* fail(op, new InvalidRequest({ detail: "empty_message" }))
    return yield* send(op, thread, user, {
      ...context,
      type: "text",
      text: { body: text, preview_url: postOptions.linkPreview === true }
    })
  })

  const download: ChatAdapter["download"] = (thread, attachment, { maxBytes }) =>
    Stream.unwrap(Effect.gen(function*() {
      const op = "download"
      yield* resolve(op, thread)
      const tooLarge = Errors.chatError(op, new TooLarge({ subject: "files", detail: "max_bytes" }))
      if (attachment.size !== undefined && attachment.size > maxBytes) return yield* Effect.fail(tooLarge)
      const answer = yield* graph.call(encodeURIComponent(attachment.id), {
        params: { phone_number_id: phoneNumberId }
      }).pipe(Effect.mapError(withOp(op)))
      const info = isObject(answer) ? answer : undefined
      const url = string(info, "url")
      if (url === undefined) return yield* fail(op, Errors.invalidResponse(false, "missing_url"))
      const size = info?.file_size
      if (typeof size === "number" && size > maxBytes) return yield* Effect.fail(tooLarge)
      const response = yield* options.http.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(options.accessToken)))
      ).pipe(Effect.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag, error))))
      if (response.status < 200 || response.status >= 300) {
        return yield* fail(op, Errors.reasonForStatus(response.status, { write: false }))
      }
      let received = 0
      return response.stream.pipe(
        Stream.mapError((error) => Errors.chatError(op, Errors.transport(false, error.reason._tag, error))),
        Stream.mapEffect((chunk) => {
          received += chunk.length
          return received > maxBytes ? Effect.fail(tooLarge) : Effect.succeed(chunk)
        })
      )
    }))

  const adapter: ChatAdapter = {
    descriptor,
    post,
    edit: () => unsupported("edit", "edit"),
    delete: () => unsupported("delete", "delete"),
    fetchMessage: () => unsupported("fetchMessage", "fetchMessage"),
    history: () => Stream.fail(Errors.chatError("history", new Unsupported({ capability: "history" }))),
    download,
    startThread: () => unsupported("startThread", "startThread"),
    getThread: (thread) =>
      Effect.map(resolve("getThread", thread), (user) => ({
        thread,
        kind: "direct" as const,
        raw: { phoneNumberId, user }
      })),
    opener: (thread) => Effect.as(resolve("opener", thread), Option.none()),
    getUser: () => unsupported("getUser", "getUser"),
    followUp: () => unsupported("followUp", "commands")
  }

  const sendTemplate = (thread: ChatThread, template: Template): Effect.Effect<Posted, ChatError> =>
    Effect.flatMap(resolve("sendTemplate", thread), (user) =>
      send("sendTemplate", thread, user, {
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          ...(template.components === undefined ? {} : { components: template.components })
        }
      }))

  const markRead = (
    thread: ChatThread,
    messageId: string,
    markOptions?: { readonly typing?: boolean | undefined }
  ): Effect.Effect<void, ChatError> =>
    Effect.flatMap(resolve("markRead", thread), () =>
      graph.call(`${phoneNumberId}/messages`, {
        body: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          ...(markOptions?.typing === true ? { typing_indicator: { type: "text" } } : {})
        },
        write: true
      }).pipe(Effect.mapError(withOp("markRead")), Effect.asVoid))

  return { adapter, sendTemplate, markRead }
}
