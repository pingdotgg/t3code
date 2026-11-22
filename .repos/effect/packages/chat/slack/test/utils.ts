import * as SlackChat from "@effect/chat-slack/SlackChat"
import * as Chat from "effect/chat/Chat"
import type { ChatAdapter } from "effect/chat/ChatAdapter"
import { Registry } from "effect/chat/ChatAdapter"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as fs from "node:fs"

export const team = "T05479Z6JBW"
export const botUserId = "U0CCLMD4S1L"
export const appId = "A0CCHBHDK7X"
export const channel = "C0CH1LGJ4F3"

export const checkOptions = { platform: "slack", parseMention: SlackChat.parseMention }

interface RecordedCall {
  readonly method: string
  readonly label?: string
  readonly request: Record<string, unknown>
  readonly response: any
}

export const fixture = (name: string): { readonly calls: ReadonlyArray<RecordedCall>; readonly [key: string]: any } =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/recorded/${name}.json`, import.meta.url), "utf8"))

/**
 * An `event_callback` envelope built around a message as a Web API read
 * returned it. Reconstructed, not delivered by Slack: the captured
 * deliveries are in `fixtures/events`.
 */
export const messageEnvelope = (
  message: Record<string, unknown>,
  options?: {
    readonly type?: "message" | "app_mention" | undefined
    readonly channel?: string | undefined
    readonly channelType?: string | undefined
    readonly teamId?: string | undefined
  }
) => ({
  token: "verification-token",
  team_id: options?.teamId ?? team,
  api_app_id: appId,
  type: "event_callback",
  event_id: "Ev01",
  event_time: 1794509000,
  authorizations: [{ team_id: options?.teamId ?? team, user_id: botUserId, is_bot: true }],
  event: {
    ...message,
    type: options?.type ?? "message",
    channel: options?.channel ?? channel,
    ...(options?.type === "app_mention" ? {} : { channel_type: options?.channelType ?? "channel" }),
    event_ts: message.ts
  }
})

export interface FakeCall {
  readonly method: string
  /** The form fields of a Web API call, or the JSON body of a `response_url` post with its `url`. */
  readonly params: Record<string, any>
}

type Answer =
  | Record<string, unknown>
  | { readonly status: number; readonly headers?: Record<string, string>; readonly body?: unknown }
  | typeof hang

/** An answer that never comes. */
export const hang = { hang: true } as const

/**
 * A scripted Slack. Each method answers from a queue of answers, the last
 * one repeating, or `{ ok: true }` when it has none.
 */
export const makeFake = (
  script: Record<string, Answer | ReadonlyArray<Answer> | ((params: Record<string, string>) => Answer)>
) => {
  const calls: Array<FakeCall> = []
  const queues = new Map<string, Array<Answer>>()
  for (const [method, answer] of Object.entries(script)) {
    if (Array.isArray(answer)) queues.set(method, [...answer])
  }
  const respond = (request: HttpClientRequest.HttpClientRequest, url: URL): Response | typeof hang => {
    // A command's `response_url` takes JSON, and is recorded as one method.
    const responseUrl = url.pathname.startsWith("/commands/")
    const method = responseUrl ? "response_url" : url.pathname.replace(/^\/api\//, "")
    const body = request.body
    const text = body._tag === "Uint8Array" ? body.text ?? new TextDecoder().decode(body.body) : ""
    const params = responseUrl ? { url: url.href, ...JSON.parse(text) } : Object.fromEntries(new URLSearchParams(text))
    calls.push({ method, params })
    const entry = script[method]
    let answer: Answer
    if (typeof entry === "function") answer = entry(params)
    else if (Array.isArray(entry)) {
      const queue = queues.get(method)!
      answer = queue.length > 1 ? queue.shift()! : queue[0]
    } else answer = (entry as Answer | undefined) ?? { ok: true }
    if (answer === hang) return hang
    if ("status" in answer && typeof answer.status === "number") {
      const { body, headers, status } = answer as Extract<Answer, { readonly status: number }>
      // A string goes as it is: a `response_url` answers in plain text.
      const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)
      return new Response(text, { status, headers: headers ?? {} })
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })
  }
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const response = respond(request, url)
      return response instanceof Response
        ? Effect.succeed(HttpClientResponse.fromWeb(request, response))
        : Effect.never
    })
  )
  return {
    calls,
    called: (method: string) => calls.filter((call) => call.method === method),
    layer: Layer.succeed(HttpClient.HttpClient, client)
  }
}

export const authTest = { ok: true, user_id: botUserId, team_id: team }

/** A command's `response_url`, on Slack's host as the adapter requires. */
export const responseUrl = `https://hooks.slack.com/commands/${team}/1794600000/abcdef`

/**
 * A slash command's form fields: the form recorded in
 * `fixtures/recorded/commands.json`, with the command, its text, the
 * channel, and a `response_url` and `trigger_id` the tests can use.
 */
export const commandFields = (
  command: string,
  text: string,
  overrides?: Record<string, string>
): Record<string, string> => ({
  ...fixture("commands").commands.private,
  token: "verification",
  channel_id: channel,
  channel_name: "scratch",
  command,
  text,
  response_url: responseUrl,
  trigger_id: "trigger-command",
  ...overrides
})

/** `Chat`, `Registry` and the Slack adapter on a fake. */
export const slackLayer = (fake: ReturnType<typeof makeFake>) =>
  SlackChat.layer({ botToken: Redacted.make("xoxb-test"), teamId: team }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(fake.layer)
  )

export const adapter: Effect.Effect<ChatAdapter, unknown, Registry> = Effect.gen(function*() {
  const registry = yield* Registry
  return yield* registry.get("slack")
})
