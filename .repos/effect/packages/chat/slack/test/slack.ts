import * as SlackChat from "@effect/chat-slack/SlackChat"
import { type Interactions, NoSuchElement } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import { appId, authTest, botUserId, commandFields, makeFake, team } from "./utils.ts"

const tim = "U080YLYB277"

/**
 * A Slack that keeps the messages the adapter posts, with their blocks, and
 * records every view it opens. `interactions` is the conformance hook: it
 * builds Slack's `block_actions` and `view_submission` payloads from what
 * was posted and opened, and a slash command's form fields, and sends them
 * through `SlackChat.interaction`. A command's
 * `response_url` answers `ok`. `refuseFiles` makes the next file upload
 * fail.
 */
export const makeSlack = () => {
  const messages = new Map<string, any>()
  const views: Array<any> = []
  let next = 1794600000
  let viewCount = 0
  let refuse = false

  const fake = makeFake({
    "auth.test": authTest,
    "chat.postMessage": (params) => {
      const ts = `${next++}.000100`
      messages.set(ts, {
        type: "message",
        ts,
        channel: params.channel,
        ...(params.thread_ts === undefined ? {} : { thread_ts: params.thread_ts }),
        user: botUserId,
        bot_id: "B0CCQH77VA5",
        app_id: appId,
        team,
        text: params.text,
        blocks: JSON.parse(params.blocks)
      })
      return { ok: true, channel: params.channel, ts }
    },
    "chat.update": (params) => {
      const message = messages.get(params.ts)
      if (message === undefined) return { ok: false, error: "message_not_found" }
      message.text = params.text
      message.blocks = JSON.parse(params.blocks)
      return { ok: true, channel: params.channel, ts: params.ts }
    },
    "chat.delete": (params) => messages.delete(params.ts) ? { ok: true } : { ok: false, error: "message_not_found" },
    "conversations.replies": (params) => {
      const message = messages.get(params.ts)
      return message === undefined ? { ok: false, error: "thread_not_found" } : { ok: true, messages: [message] }
    },
    "views.open": (params) => {
      const view = { ...JSON.parse(params.view), id: "V" + ++viewCount }
      views.push(view)
      return { ok: true, view }
    },
    "conversations.history": (params) => ({
      ok: true,
      messages: [...messages.values()].filter((message) => message.channel === params.channel).reverse()
    }),
    "files.getUploadURLExternal": { ok: true, upload_url: "https://files.slack.test/upload/F1", file_id: "F1" },
    "files.completeUploadExternal": () =>
      refuse ? { ok: false, error: "invalid_arguments" } : { ok: true, files: [{ id: "F1" }] },
    "response_url": { status: 200, body: "ok" }
  })

  /** The view the last click opened, until a submit closes it. */
  let opened: any

  /** The service the hook delivers through, set by `bind`. */
  let service: SlackChat.SlackChat["Service"] | undefined

  const deliver = (payload: Record<string, unknown>) =>
    service!.interaction({ ...payload, token: "verification", api_app_id: appId })

  const user = { id: tim, username: "tim", name: "tim", team_id: team }

  const interactions: Interactions = {
    command: Effect.fnUntraced(function*(thread, id, options) {
      const parts = SlackChat.parts(thread)
      if (parts._tag === "None") return
      const before = views.length
      const { token: _, ...fields } = commandFields("/" + id, options?.text ?? "", { channel_id: parts.value.channel })
      yield* deliver(fields)
      opened = views.length > before ? views[views.length - 1] : undefined
    }),
    click: Effect.fnUntraced(function*(messageId, id, options) {
      const message = messages.get(messageId)
      const block = message?.blocks.find((block: any) => block.type === "actions")
      const element = block?.elements.find((element: any) => element.action_id === id)
      if (element === undefined) return yield* Effect.fail(new NoSuchElement({ messageId, id }))
      const before = views.length
      const value = element.type === "static_select" ? options?.option ?? element.options[0].value : undefined
      yield* deliver({
        type: "block_actions",
        user,
        team: { id: team, domain: "effectfulworkspace" },
        container: { type: "message", message_ts: messageId, channel_id: message.channel, is_ephemeral: false },
        trigger_id: "trigger-" + messageId,
        channel: { id: message.channel, name: "scratch" },
        message,
        state: { values: {} },
        response_url: "https://hooks.slack.test/actions",
        actions: [{
          ...element,
          block_id: block.block_id,
          ...(value === undefined ? {} : {
            selected_option: element.options.find((option: any) => option.value === value)
          }),
          action_ts: "1794600000.000001"
        }]
      })
      opened = views.length > before ? views[views.length - 1] : undefined
    }),
    submit: Effect.fnUntraced(function*(values) {
      if (opened === undefined) return
      const state: Record<string, unknown> = {}
      for (const block of opened.blocks) {
        if (block.type !== "input") continue
        const input = block.element
        const value = values[block.block_id]
        state[block.block_id] = {
          [input.action_id]: input.type === "plain_text_input"
            ? { type: input.type, value: value ?? null }
            : {
              type: input.type,
              selected_option: value === undefined
                ? null
                : input.options.find((option: any) => option.value === value) ?? null
            }
        }
      }
      const answer: any = yield* deliver({
        type: "view_submission",
        team: { id: team, domain: "effectfulworkspace" },
        user,
        trigger_id: "trigger-submit",
        view: { ...opened, team_id: team, state: { values: state }, hash: "1794600000.abc", app_id: appId },
        response_urls: []
      })
      // An `errors` answer, or none in time, keeps the view open.
      if (answer?.response_action !== "errors" && answer?._tag !== "Late") opened = undefined
    })
  }

  return {
    fake,
    bind: Effect.tap(SlackChat.SlackChat, (slack) =>
      Effect.sync(() => {
        service = slack
      })),
    interactions,
    refuseFiles: () =>
      Effect.sync(() => {
        refuse = true
      })
  }
}
